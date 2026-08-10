/**
 * localStorage ⇄ Rust 磁盘镜像（设置对 origin 变更免疫）。
 *
 * 背景：v1.1.2 起主窗口改用自定义协议（origin 变更），WebView2 localStorage
 * 按 origin 隔离，升级会丢全部本地设置。本模块把 localStorage 镜像到
 * `~/.tokenicode/localstorage.json`，启动时从磁盘灌回，任何 origin 变更都不丢。
 *
 * 三个动作（由 main.tsx 的 bootstrap 顺序调用）：
 *   1. ensureMigrated  —— 一次性把旧 origin 的 localStorage 迁到磁盘（Rust 侧）。
 *   2. seedFromDisk    —— 读磁盘快照，用原始 setItem 灌回当前 origin（不回写）。
 *   3. installMirror   —— patch localStorage.setItem/removeItem，运行时改动异步回写磁盘。
 *
 * 非 Tauri 环境（纯浏览器 / vite preview）全部 no-op，退回原生 localStorage。
 */
import { invoke } from '@tauri-apps/api/core';

/** Tauri IPC 桥是否可用（注入于所有 Tauri webview）。 */
const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// 原始 Storage 方法 —— 灌盘时使用，避免"刚从磁盘读出的值又回写磁盘"。
const origSetItem = Storage.prototype.setItem;
const origGetItem = Storage.prototype.getItem;
const origRemoveItem = Storage.prototype.removeItem;

/** 回写防抖（毫秒）。设置改动频繁，合并后落盘。 */
const WRITE_DEBOUNCE_MS = 400;

async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.warn(`[persistent-storage] ${cmd} failed:`, e);
    return null;
  }
}

/** 每个 key 一个防抖定时器；落盘时读取当前值（可能已被后续改动覆盖）。 */
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushKeyNow(key: string): void {
  const timer = writeTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    writeTimers.delete(key);
  }
  const value = origGetItem.call(localStorage, key);
  if (value === null) {
    void invokeSafe('remove_ls_entry', { key });
  } else {
    void invokeSafe('save_ls_entry', { key, value });
  }
}

function scheduleDiskWrite(key: string): void {
  const existing = writeTimers.get(key);
  if (existing) clearTimeout(existing);
  writeTimers.set(
    key,
    setTimeout(() => {
      writeTimers.delete(key);
      flushKeyNow(key);
    }, WRITE_DEBOUNCE_MS),
  );
}

/**
 * 一次性迁移旧 origin 的 localStorage 到磁盘（Rust 侧实现）。
 * dev / 已迁移 / 失败 都快速返回，不阻塞启动。
 */
export async function ensureMigrated(): Promise<void> {
  await invokeSafe<number>('ensure_migrated');
}

/**
 * 从磁盘快照灌回当前 origin 的 localStorage。
 * 磁盘数据优先：快照中的 key 无条件覆盖同名 key，快照没有的 key 保留。
 * 不再要求 localStorage 为空——首次升级时新 origin 已被 persist 写入
 * 新手默认值（如 fontSize 14），empty-only 会让磁盘里迁移恢复的真实
 * 设置（18）永远灌不回去。快照 = 运行时镜像（400ms 防抖 + 页面隐藏冲刷），
 * 过期窗口极小，覆盖可接受。用原始 setItem 避免触发镜像回写。
 */
export async function seedFromDisk(): Promise<void> {
  const json = await invokeSafe<string>('load_ls_snapshot');
  if (!json) return; // 非 Tauri 或无快照
  let snapshot: Record<string, string>;
  try {
    snapshot = JSON.parse(json);
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'string') {
      origSetItem.call(localStorage, key, value);
    }
  }
}

let mirrorInstalled = false;

/**
 * patch localStorage.setItem/removeItem，运行时改动异步镜像到磁盘。
 * 只处理 localStorage（跳过 sessionStorage）；幂等（重复调用只装一次）。
 */
export function installMirror(): void {
  if (!isTauri || mirrorInstalled) return;
  mirrorInstalled = true;

  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    origSetItem.call(this, key, value);
    if (this === window.localStorage) scheduleDiskWrite(key);
  };

  Storage.prototype.removeItem = function (this: Storage, key: string) {
    origRemoveItem.call(this, key);
    if (this === window.localStorage) {
      // 删除立即落盘（不防抖）：ErrorBoundary"清除数据并重启"依赖它先于 reload 生效。
      const timer = writeTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        writeTimers.delete(key);
      }
      void invokeSafe('remove_ls_entry', { key });
    }
  };

  // 退出/切后台时冲刷未落盘的防抖写入，尽量不丢最后一次改动。
  const flushAllPending = () => {
    for (const key of Array.from(writeTimers.keys())) flushKeyNow(key);
  };
  window.addEventListener('pagehide', flushAllPending);
  window.addEventListener('beforeunload', flushAllPending);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllPending();
  });
}

/**
 * 彻底清空磁盘快照中指定 key（供 ErrorBoundary"清除数据"使用）。
 * 返回 Promise，调用方应 await 后再 reload，避免 reload 抢在落盘前把旧值灌回。
 */
export async function clearKeysFromDisk(keys: string[]): Promise<void> {
  for (const key of keys) {
    const timer = writeTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      writeTimers.delete(key);
    }
    await invokeSafe('remove_ls_entry', { key });
  }
}
