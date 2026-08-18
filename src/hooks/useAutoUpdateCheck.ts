import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { APP_VERSION } from '../lib/version';
import { bridge } from '../lib/tauri-bridge';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** 本地"已应用资源版本"（热更新后写入；首启 = APP_VERSION，exe 内嵌版本）。 */
const WEB_VERSION_KEY = 'tokenicode_web_version';

/**
 * 更新清单（仓库根目录 latest.json，由发布脚本生成）：
 * { "version": "1.1.2", "zipUrl": "...web-dist-v1.1.2.zip", "sha256": "...",
 *   "rustChanged": false, "releaseUrl": "..." }
 * 放仓库根目录（非 release 资产）的好处：raw/jsdelivr CDN 都能读，
 * 检查源完全摆脱 GitHub API（无 rate limit）。
 */
const RAW_LATEST = 'https://raw.githubusercontent.com/qingyu321/Little-Claude/main/latest.json';
const JSDELIVR_LATEST = 'https://cdn.jsdelivr.net/gh/qingyu321/Little-Claude@main/latest.json';
// C3: mirror.ghproxy.com removed — a third-party proxy could serve a
// modified latest.json + zip with a matching (forged) sha256, defeating the
// integrity check. jsdelivr mirrors the same repo content over HTTPS and is
// the fallback where raw.githubusercontent is unstable.
// Gitee 镜像预留（与发布脚本同步启用时再打开）
// const GITEE_LATEST = 'https://gitee.com/qingyu321/Little-Claude/raw/main/latest.json';

const GITHUB_RELEASES_URL = 'https://github.com/qingyu321/Little-Claude/releases';

export interface UpdateInfo {
  version: string;
  /** 前端资源包直链（热更下载用）。 */
  zipUrl: string;
  /** 资源包 SHA256（防篡改）。 */
  sha256: string;
  /** true = 本次更新含 Rust 引擎变更，无法热更，需下载安装包。 */
  rustChanged: boolean;
  /** release 页面（手动下载路径）。 */
  url: string;
}

/** Cached latest update info from the most recent successful check. */
let _cachedLatest: UpdateInfo | null = null;

export function getLatestVersion(): UpdateInfo | null {
  return _cachedLatest;
}

/**
 * 完整 semver 比较（支持 v 前缀与预发布后缀）：
 * 1.2.0-alpha.1 < 1.2.0；本地预发布可更新到正式版；正式版不"更新"到预发布。
 */
function parseSemver(v: string): { m: number[]; pre: string } {
  const s = v.trim().replace(/^v/, '');
  const [core, pre] = s.split('-', 2);
  const m = core.split('.').map(Number);
  while (m.length < 3) m.push(0);
  return { m, pre: pre ?? '' };
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (l.m[i] !== c.m[i]) return l.m[i] > c.m[i];
  }
  // 核心版本相同 → 比较预发布段
  if (!c.pre && l.pre) return false; // 最新是预发布而本地已正式 → 不视为更新
  if (c.pre && !l.pre) return true; // 本地预发布 → 正式版可更新
  // Semver identifier comparison: numeric segments compare numerically
  // ('alpha.10' > 'alpha.9'), alphanumeric segments lexically, numeric <
  // alphanumeric, and more identifiers > fewer (equal prefix). The previous
  // `Number()` mapping turned letters into NaN — NaN !== NaN short-circuits
  // every comparison, so 'alpha.10' vs 'alpha.9' (and even 'alpha.2' vs
  // 'alpha.10') always judged "not newer".
  const pa = l.pre.split('.');
  const pb = c.pre.split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const a = pa[i] ?? '';
    const b = pb[i] ?? '';
    if (a === '') return false; // 少段 pre < 多段 pre（'alpha' < 'alpha.1'）
    if (b === '') return true;
    const na = Number(a);
    const nb = Number(b);
    const aNum = !Number.isNaN(na);
    const bNum = !Number.isNaN(nb);
    if (aNum && bNum) {
      if (na !== nb) return na > nb;
    } else if (aNum !== bNum) {
      return !aNum; // 数字段优先级低于字母段（semver）
    } else if (a !== b) {
      return a > b; // 字母段按字典序
    }
  }
  return false;
}

/** 从 Rust 同步真实生效的资源版本（权威：Rust 决定加载哪个目录）。 */
async function syncWebVersion(): Promise<void> {
  try {
    const v = await bridge.getWebResourceVersion();
    if (v) localStorage.setItem(WEB_VERSION_KEY, v);
  } catch {
    // 非 Tauri 环境（纯浏览器预览）忽略
  }
}

/** 本地当前版本：已应用资源版本 > 内嵌 APP_VERSION。 */
function localVersion(): string {
  return localStorage.getItem(WEB_VERSION_KEY) || APP_VERSION;
}

/** 写入本地资源版本（热更成功后调用）。 */
export function recordAppliedWebVersion(version: string): void {
  localStorage.setItem(WEB_VERSION_KEY, version.replace(/^v/, ''));
}

/** 当前生效资源版本（设置页显示用）。 */
export function currentWebVersion(): string {
  return localVersion();
}

async function fetchLatestInfo(url: string): Promise<UpdateInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const version = String(data?.version || '');
    if (!version) return null;
    return {
      version,
      zipUrl: typeof data.zipUrl === 'string' ? data.zipUrl : '',
      sha256: typeof data.sha256 === 'string' ? data.sha256 : '',
      rustChanged: !!data.rustChanged,
      url: typeof data.releaseUrl === 'string' && data.releaseUrl
        ? data.releaseUrl
        : `${GITHUB_RELEASES_URL}/tag/${version}`,
    };
  } catch {
    return null; // 超时 / 网络错误 → 下一个源
  } finally {
    // A8: clear the abort timer on EVERY path — the old code only cleared
    // it on success, leaking one 5s timer per failed check.
    clearTimeout(timer);
  }
}

type CheckOutcome = 'updated' | 'latest' | 'failed';

async function doCheck(): Promise<CheckOutcome> {
  await syncWebVersion();
  const local = localVersion();

  // 多源依次尝试：raw → jsdelivr CDN（Gitee 预留）。第一个成功的源即为
  // 权威结果——无论是否发现更新都停止尝试，避免"raw 说无更新、镜像说有
  // 更新"的抖动。
  const sources = [RAW_LATEST, JSDELIVR_LATEST];
  for (const src of sources) {
    const info = await fetchLatestInfo(src);
    if (!info) continue;
    if (isNewer(info.version, local)) {
      _cachedLatest = info;
      useSettingsStore.getState().setUpdateAvailable(true, info.version.replace(/^v/, ''));
      return 'updated';
    }
    _cachedLatest = null;
    useSettingsStore.getState().setUpdateAvailable(false);
    return 'latest';
  }
  // 全部源失败：保留上次成功结果（不打扰、不清除已有提示），等下次周期
  return 'failed';
}

/** URL to the latest release (for manual download). */
export function getLatestReleaseUrl(): string {
  return _cachedLatest?.url || GITHUB_RELEASES_URL + '/latest';
}

/**
 * 手动触发一次检查（设置页"检查更新"按钮）。
 * outcome: 'updated' 发现更新（info 为更新信息）| 'latest' 已是最新 | 'failed' 所有源均失败。
 */
export async function checkForUpdatesNow(): Promise<{
  info: UpdateInfo | null;
  outcome: CheckOutcome;
}> {
  const outcome = await doCheck();
  return { info: _cachedLatest, outcome };
}

/**
 * 检查更新（启动 5s 后 + 每 10 分钟）：多源读取仓库 latest.json
 * （GitHub raw → jsdelivr CDN → ghproxy 镜像，Gitee 预留），5s 超时；
 * 版本比较基于"已应用资源版本"（热更友好）；只有发现更新才置
 * updateAvailable，UpdateButton / 设置页据此展示。
 */
export function useAutoUpdateCheck(): void {
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;

    // Initial check after 5s
    const startupTimer = setTimeout(doCheck, 5000);

    // Periodic check every 10 minutes
    const intervalTimer = setInterval(doCheck, CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
    };
  }, []);
}
