import { useEffect, useState, useCallback } from 'react';
import { bridge, cancelDownload, invokeWithCancellation, type CliCandidate, type CliStatus, type DshServiceStatus } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { APP_NAME } from '../../lib/edition';
import { stripAnsi } from '../../lib/strip-ansi';
import { isPermissionError, isNetworkError } from './settingsUtils';
import { useSettingsStore } from '../../stores/settingsStore';
import { friendlyError } from '../../lib/error-format';

type CliCheckStatus = 'idle' | 'checking' | 'found' | 'not_found' | 'installing' | 'installed' | 'install_failed' | 'updating' | 'updated' | 'update_failed';

type InstallPhase = 'idle' | 'downloading' | 'configuring' | 'npm_fallback' | 'node_downloading' | 'node_extracting' | 'git_downloading' | 'git_extracting' | 'native_version' | 'native_manifest' | 'native_download' | 'native_verify' | 'native_install';

const SOURCE_I18N_KEYS: Record<string, string> = {
  official: 'cli.source.official',
  system: 'cli.source.system',
  appLocal: 'cli.source.appLocal',
  versionManager: 'cli.source.versionManager',
  dynamic: 'cli.source.dynamic',
};

const SOURCE_COLORS: Record<string, string> = {
  official: 'text-green-500',
  system: 'text-blue-400',
  appLocal: 'text-amber-500',
  versionManager: 'text-purple-400',
  dynamic: 'text-text-tertiary',
};

// ─── CliSection: reusable per-CLI management ─────────────────

interface CliSectionProps {
  cliType: 'claude' | 'codex';
  title: string;
  bridgeCheck: () => Promise<CliStatus>;
  /** 传入 scopeId 时走可取消路径（后端轮询 CancellationToken）；不传则保持原行为 */
  bridgeInstall: (scopeId?: string) => Promise<void>;
  bridgeUpdate: (scopeId?: string) => Promise<string>;
  showGitBashWarning?: boolean;
  hasNativePhases?: boolean;
}

function CliSection({ cliType, title, bridgeCheck, bridgeInstall, bridgeUpdate, showGitBashWarning, hasNativePhases }: CliSectionProps) {
  const t = useT();
  const [status, setStatus] = useState<CliCheckStatus>('idle');
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [cliPath, setCliPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [gitBashMissing, setGitBashMissing] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [phase, setPhase] = useState<InstallPhase>('idle');
  // 当前安装/更新任务的取消 scope（非空且 claude 时显示取消按钮）
  const [actionScopeId, setActionScopeId] = useState<string | null>(null);

  // Update-available state: claude → cliUpdateAvailable, codex → codexUpdateAvailable
  const updateKey = cliType === 'codex' ? 'codexUpdateAvailable' as const : 'cliUpdateAvailable' as const;
  const versionKey = cliType === 'codex' ? 'codexLatestVersion' as const : 'cliLatestVersion' as const;
  const updateAvailable = useSettingsStore((s) => s[updateKey]);
  const latestVersion = useSettingsStore((s) => s[versionKey]);

  // Auto-check on mount
  useEffect(() => {
    bridgeCheck().then((result) => {
      if (result.installed) {
        setCliVersion(result.version ?? null);
        setCliPath(result.path ?? null);
        setGitBashMissing(result.git_bash_missing ?? false);
        setStatus('found');
      } else {
        setStatus('not_found');
      }
    }).catch(() => setStatus('not_found'));
  }, [bridgeCheck]);

  const handleCheck = useCallback(async () => {
    setStatus('checking');
    setErrorMsg('');
    try {
      const result = await bridgeCheck();
      if (result.installed) {
        setCliVersion(result.version ?? null);
        setCliPath(result.path ?? null);
        setGitBashMissing(result.git_bash_missing ?? false);
        setStatus('found');
      } else {
        setStatus('not_found');
      }
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setErrorMsg(friendlyError(stripAnsi(String(e))));
      setStatus('not_found');
    }
  }, [bridgeCheck]);

  const handleInstall = useCallback(async () => {
    setStatus('installing');
    setErrorMsg('');
    setDownloadPercent(0);
    setPhase('downloading');

    // 取消 scope：安装期间展示取消按钮，点击后后端轮询令牌提前退出并清理临时文件
    const scopeId = `cli-${cliType}-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setActionScopeId(scopeId);

    const { onDownloadProgress } = await import('../../lib/tauri-bridge');
    const unlisten = await onDownloadProgress((event) => {
      setDownloadPercent(event.percent);
      const p = event.phase;
      if (hasNativePhases && (p === 'native_version' || p === 'native_manifest' || p === 'native_download'
        || p === 'native_verify' || p === 'native_install')) {
        setPhase(p);
      } else if (hasNativePhases && p === 'git_downloading') {
        setPhase('git_downloading');
      } else if (hasNativePhases && p === 'git_extracting') {
        setPhase('git_extracting');
      } else if (hasNativePhases && p === 'node_downloading') {
        setPhase('node_downloading');
      } else if (hasNativePhases && p === 'node_extracting') {
        setPhase('node_extracting');
      } else if (p === 'npm_fallback') {
        setPhase('npm_fallback');
      } else if (p === 'complete' || event.percent >= 100) {
        setPhase('configuring');
      }
    });

    try {
      await bridgeInstall(scopeId);
      const result = await bridgeCheck();
      if (result.installed) {
        setCliVersion(result.version ?? null);
        setCliPath(result.path ?? null);
        setStatus('installed');
      } else {
        // A7: 硬编码英文提示走 i18n
        setErrorMsg(t('cli.notFoundAfterInstall'));
        setStatus('install_failed');
      }
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setErrorMsg(friendlyError(stripAnsi(String(e))));
      setStatus('install_failed');
    } finally {
      unlisten();
      setActionScopeId(null);
    }
  }, [bridgeCheck, bridgeInstall, cliType, hasNativePhases]);

  const handleUpdate = useCallback(async () => {
    setStatus('updating');
    setErrorMsg('');
    setDownloadPercent(0);
    setPhase('idle');

    const scopeId = `cli-${cliType}-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setActionScopeId(scopeId);

    const { onDownloadProgress } = await import('../../lib/tauri-bridge');
    const unlisten = await onDownloadProgress((event) => {
      setDownloadPercent(event.percent);
      const p = event.phase;
      if (p === 'npm_fallback') {
        setPhase('npm_fallback');
      } else if (hasNativePhases && p === 'native_download') {
        setPhase('native_download');
      } else if (p === 'complete' || event.percent >= 100) {
        setPhase('configuring');
      }
    });

    try {
      const newVersion = await bridgeUpdate(scopeId);
      setCliVersion(newVersion);
      setStatus('updated');
      useSettingsStore.setState({ [updateKey]: false, [versionKey]: '' } as any);
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setErrorMsg(friendlyError(stripAnsi(String(e))));
      setStatus('update_failed');
    } finally {
      unlisten();
      setActionScopeId(null);
    }
  }, [bridgeUpdate, cliType, updateKey, versionKey, hasNativePhases]);

  const handleRestart = useCallback(async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  }, []);

  // Phase label for installing state
  const getInstallPhaseLabel = () => {
    if (hasNativePhases) {
      if (phase === 'native_version') return t('setup.nativeVersion');
      if (phase === 'native_manifest') return t('setup.nativeManifest');
      if (phase === 'native_download') return t('setup.nativeDownload');
      if (phase === 'native_verify') return t('setup.nativeVerify');
      if (phase === 'native_install') return t('setup.nativeInstall');
      if (phase === 'node_downloading') return t('setup.downloadingNode');
      if (phase === 'node_extracting') return t('setup.extractingNode');
      if (phase === 'git_downloading') return t('setup.downloadingGit');
      if (phase === 'git_extracting') return t('setup.extractingGit');
    }
    if (phase === 'configuring') return t('cli.configuring');
    if (phase === 'npm_fallback') return t('setup.npmFallback');
    return t('cli.installing');
  };

  const getUpdatePhaseLabel = () => {
    if (hasNativePhases && phase === 'native_download') return t('setup.nativeDownload');
    if (phase === 'npm_fallback') return t('setup.npmFallback');
    if (phase === 'configuring') return t('cli.configuring');
    return t('cli.updating');
  };

  const showPercentInInstall = hasNativePhases
    ? (phase === 'native_download' || phase === 'downloading' || phase === 'node_downloading' || phase === 'git_downloading')
    : (phase === 'downloading');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-text-primary">{title}</span>
        {cliVersion && status !== 'not_found' && status !== 'install_failed' && (
          <span className="text-xs text-text-tertiary">v{cliVersion}</span>
        )}
      </div>

      {/* Status + path display */}
      {(status === 'found' || status === 'idle') && cliPath && (
        <div className="py-1 space-y-1">
          <span className={`text-[13px] font-medium ${gitBashMissing ? 'text-amber-500' : 'text-green-500'}`}>
            {gitBashMissing ? '⚠' : '✓'} {t('cli.installed')}
          </span>
          <p className="text-xs text-text-tertiary truncate" title={cliPath}>
            {cliPath}
          </p>
        </div>
      )}

      {/* CLI update available */}
      {updateAvailable && (status === 'found' || status === 'idle') && (
        <div className="py-2 px-3 rounded-lg bg-accent/10">
          <p className="text-[13px] text-accent font-medium">
            {t('cli.update')} — v{latestVersion} {t('update.available') || 'available'}
          </p>
        </div>
      )}

      {/* Git Bash missing warning (Claude-only on Windows) */}
      {showGitBashWarning && gitBashMissing && (status === 'found' || status === 'idle') && (
        <div className="py-2 px-3 rounded-lg bg-amber-500/10">
          <p className="text-[13px] text-amber-500 font-medium">
            {t('setup.gitBashMissing')} — {t('cli.reinstallHint') || 'Click reinstall to fix'}
          </p>
        </div>
      )}

      {status === 'not_found' && (
        <p className="text-[13px] text-amber-500">{t('cli.notFound')}</p>
      )}

      {/* Action buttons */}
      {(status === 'idle' || status === 'found' || status === 'not_found' || status === 'update_failed') && (
        <div className="flex gap-3">
          {status !== 'not_found' && (
            <button
              onClick={handleUpdate}
              className="flex-1 py-2 text-[13px] font-medium rounded-lg
                border border-border-subtle text-text-muted
                hover:bg-bg-secondary hover:text-text-primary transition-smooth"
            >
              {t('cli.update')}
            </button>
          )}
          <button
            onClick={handleCheck}
            className="flex-1 py-2 text-[13px] font-medium rounded-lg
              border border-border-subtle text-text-muted
              hover:bg-bg-secondary hover:text-text-primary transition-smooth"
          >
            {t('cli.check')}
          </button>
          <button
            onClick={async () => {
              if (status !== 'not_found') {
                const { ask } = await import('@tauri-apps/plugin-dialog');
                const confirmed = await ask(t('cli.confirmReinstall'), { title: APP_NAME, kind: 'warning' });
                if (!confirmed) return;
              }
              handleInstall();
            }}
            className={`flex-1 py-2 text-[13px] font-medium rounded-lg transition-smooth
              ${(status === 'not_found' || (showGitBashWarning && gitBashMissing))
                ? 'bg-accent text-text-inverse hover:bg-accent-hover'
                : 'border border-border-subtle text-text-muted hover:bg-bg-secondary hover:text-text-primary'
              }`}
          >
            {status === 'not_found' ? t('cli.install') : t('cli.reinstall')}
          </button>
        </div>
      )}

      {status === 'updating' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-text-muted">{getUpdatePhaseLabel()}</span>
            {downloadPercent > 0 && downloadPercent < 100 && (
              <span className="text-[13px] text-text-tertiary">{downloadPercent}%</span>
            )}
          </div>
          <div className="w-full h-2 rounded-full bg-bg-tertiary overflow-hidden">
            {downloadPercent > 0 ? (
              <div
                className="h-full bg-accent rounded-full transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            ) : (
              <div className="h-full bg-accent/60 rounded-full animate-pulse w-full" />
            )}
          </div>
          {/* 取消更新（仅 claude 支持 CancellationToken） */}
          {actionScopeId && cliType === 'claude' && (
            <button
              onClick={() => cancelDownload(actionScopeId)}
              className="w-full py-1.5 text-[13px] font-medium rounded-lg
                border border-border-subtle text-text-muted
                hover:bg-bg-secondary hover:text-text-primary transition-smooth"
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {status === 'updated' && (
        <div className="py-2 text-center space-y-3">
          <span className="text-[13px] text-green-500 font-medium">
            ✓ {t('cli.updateDone')} {cliVersion && `v${cliVersion}`}
          </span>
          <button
            onClick={handleRestart}
            className="w-full py-2 text-[13px] font-medium rounded-lg
              bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
          >
            {t('cli.restart')}
          </button>
        </div>
      )}

      {status === 'update_failed' && errorMsg && (
        <div className="py-2 px-3 rounded-lg bg-red-500/10">
          <p className="text-[13px] text-red-500 truncate" title={errorMsg}>{errorMsg}</p>
        </div>
      )}

      {status === 'checking' && (
        <div className="flex items-center justify-center gap-2 py-2">
          <div className="w-4 h-4 border-2 border-text-tertiary/30
            border-t-text-tertiary rounded-full animate-spin" />
          <span className="text-[13px] text-text-muted">{t('cli.checking')}</span>
        </div>
      )}

      {status === 'installing' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-text-muted">{getInstallPhaseLabel()}</span>
            {showPercentInInstall && downloadPercent > 0 && (
              <span className="text-[13px] text-text-tertiary">{downloadPercent}%</span>
            )}
          </div>
          <div className="w-full h-2 rounded-full bg-bg-tertiary overflow-hidden">
            {showPercentInInstall && downloadPercent > 0 ? (
              <div
                className="h-full bg-text-secondary rounded-full transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            ) : (
              <div className="h-full bg-text-secondary/60 rounded-full animate-pulse w-full" />
            )}
          </div>
          {/* 取消安装（仅 claude 支持 CancellationToken） */}
          {actionScopeId && cliType === 'claude' && (
            <button
              onClick={() => cancelDownload(actionScopeId)}
              className="w-full py-1.5 text-[13px] font-medium rounded-lg
                border border-border-subtle text-text-muted
                hover:bg-bg-secondary hover:text-text-primary transition-smooth"
            >
              {t('common.cancel')}
            </button>
          )}
        </div>
      )}

      {status === 'installed' && (
        <div className="py-2 text-center space-y-3">
          <span className="text-[13px] text-green-500 font-medium">
            ✓ {t('cli.installDone')}
          </span>
          {cliPath && (
            <p className="text-xs text-text-tertiary truncate" title={cliPath}>
              {cliPath}
            </p>
          )}
          <button
            onClick={handleRestart}
            className="w-full py-2 text-[13px] font-medium rounded-lg
              bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
          >
            {t('cli.restart')}
          </button>
        </div>
      )}

      {status === 'install_failed' && (
        <div className="space-y-2">
          <p className="text-[13px] text-red-500 text-center">{t('cli.installFail')}</p>
          {errorMsg && (
            <p className="text-xs text-text-tertiary text-center truncate" title={errorMsg}>
              {errorMsg}
            </p>
          )}
          {isPermissionError(errorMsg) && (
            <p className="text-xs text-amber-500 text-center">
              {t('error.permissionHint')}
            </p>
          )}
          {isNetworkError(errorMsg) && (
            <p className="text-xs text-amber-500 text-center">
              {t('network.firewallHint')}
            </p>
          )}
          <button
            onClick={handleInstall}
            className="w-full py-2 text-[13px] font-medium rounded-lg
              border border-border-subtle text-text-muted
              hover:bg-bg-secondary transition-smooth"
          >
            {t('cli.retry')}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── CliTab Container ────────────────────────────────────────

export function CliTab() {
  return (
    <div className="space-y-6">
      {/* Claude CLI Section */}
      <CliSection
        cliType="claude"
        title="Claude Code CLI"
        bridgeCheck={() => bridge.checkClaudeCli()}
        bridgeInstall={(scopeId) => scopeId
          ? invokeWithCancellation('install_claude_cli', {}, scopeId)
          : bridge.installClaudeCli()}
        bridgeUpdate={(scopeId) => scopeId
          ? invokeWithCancellation('update_claude_cli', {}, scopeId)
          : bridge.updateClaudeCli()}
        showGitBashWarning
        hasNativePhases
      />

      <div className="border-t border-border-subtle" />

      {/* Codex CLI Section */}
      <CliSection
        cliType="codex"
        title="Codex CLI"
        bridgeCheck={() => bridge.checkCodexCli()}
        bridgeInstall={() => bridge.installCodexCli()}
        bridgeUpdate={() => bridge.updateCodexCli()}
      />

      <div className="border-t border-border-subtle" />

      {/* DeepSeek Harness (dsh) Section — the preferred backend */}
      <DshSection />

      <div className="border-t border-border-subtle" />

      {/* CLI Environment Diagnostics (scans both Claude + Codex) */}
      <CliDiagnostics />
    </div>
  );
}

// ─── DeepSeek Harness (dsh) Section ───────────────────────────────
// Service-mode backend (D-N1-B): npm-distributed CLI, web service on 3080.
// Simpler than CliSection: no update channel, no git-bash, but surfaces the
// service probe (whether `dsh web` answers on the default port).

// G5: 新增 updating / updated / update_failed，与 CliSection（Codex 段）状态机对齐
type DshStatus = 'idle' | 'checking' | 'found' | 'not_found' | 'installing' | 'installed' | 'install_failed' | 'updating' | 'updated' | 'update_failed';

function DshSection() {
  const t = useT();
  const [status, setStatus] = useState<DshStatus>('idle');
  const [version, setVersion] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [serviceRunning, setServiceRunning] = useState<boolean | undefined>(undefined);
  // D3: authoritative service status (managed service first, then external 3080).
  // Replaces the old external-only probe so an LC-spawned random-port service
  // is no longer shown as "Stopped".
  const [serviceStatus, setServiceStatus] = useState<DshServiceStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [phase, setPhase] = useState<InstallPhase>('idle');

  const doCheck = useCallback(async () => {
    setStatus('checking');
    setErrorMsg('');
    try {
      // D3: fire the CLI check and the service-status probe in parallel; the
      // service probe never spawns (read-only manager + short-timeout probe).
      const [result, svc] = await Promise.all([
        bridge.checkDshCli(),
        bridge.dshServiceStatus().catch(() => null),
      ]);
      setServiceStatus(svc);
      // Prefer the authoritative dsh_service_status; fall back to the CLI's
      // external-only probe when the new command is unavailable.
      setServiceRunning(svc ? svc.running : result.service_running);
      if (result.installed) {
        setVersion(result.version ?? null);
        setPath(result.path ?? null);
        setStatus('found');
      } else {
        setStatus('not_found');
      }
    } catch (e) {
      setErrorMsg(friendlyError(stripAnsi(String(e))));
      setStatus('not_found');
    }
  }, []);

  useEffect(() => { doCheck(); }, [doCheck]);

  const handleInstall = useCallback(async () => {
    setStatus('installing');
    setErrorMsg('');
    setDownloadPercent(0);
    setPhase('idle');

    const { onDownloadProgress } = await import('../../lib/tauri-bridge');
    const unlisten = await onDownloadProgress((event) => {
      setDownloadPercent(event.percent);
      if (event.phase === 'npm_fallback') setPhase('npm_fallback');
      if (event.phase === 'complete' || event.percent >= 100) setPhase('configuring');
    });

    try {
      await bridge.installDshCli();
      setStatus('installed');
      await doCheck();
    } catch (e) {
      setErrorMsg(friendlyError(stripAnsi(String(e))));
      setStatus('install_failed');
    } finally {
      unlisten();
    }
  }, [bridge, doCheck]);

  // G5: "更新"按钮 —— 写法参照 CliSection（Codex 段）的 handleUpdate；
  // update_dsh_cli 不接受 CancellationToken，故无取消 scope。成功后沿用本段
  // install 的约定：doCheck() 刷新版本与服务状态。
  const handleUpdate = useCallback(async () => {
    setStatus('updating');
    setErrorMsg('');
    setDownloadPercent(0);
    setPhase('idle');

    const { onDownloadProgress } = await import('../../lib/tauri-bridge');
    const unlisten = await onDownloadProgress((event) => {
      setDownloadPercent(event.percent);
      if (event.phase === 'npm_fallback') setPhase('npm_fallback');
      if (event.phase === 'complete' || event.percent >= 100) setPhase('configuring');
    });

    try {
      const newVersion = await bridge.updateDshCli();
      if (newVersion) setVersion(newVersion);
      setStatus('updated');
      await doCheck();
    } catch (e) {
      setErrorMsg(friendlyError(stripAnsi(String(e))));
      setStatus('update_failed');
    } finally {
      unlisten();
    }
  }, [doCheck]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-text-primary">
          {/* G5: 硬编码中文"首选"徽章改走 i18n */}
          DeepSeek Harness CLI <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{t('cli.recommended')}</span>
        </span>
        {version && status !== 'not_found' && status !== 'install_failed' && (
          <span className="text-xs text-text-tertiary">v{version}</span>
        )}
      </div>

      {(status === 'found' || status === 'idle') && path && (
        <div className="py-1 space-y-1">
          <span className="text-[13px] font-medium text-green-500">
            ✓ {t('cli.installed')}
          </span>
          <p className="text-xs text-text-tertiary truncate" title={path}>{path}</p>
          {/* D3: service status light — prefers the LC-managed service (random
              port) over the external default-port probe, so a self-spawned
              service is no longer mis-shown as "Stopped". */}
          {(() => {
            const running = serviceStatus ? serviceStatus.running : serviceRunning;
            // Managed (spawned) → "self-managed"; external (3080/adopted) → "external".
            const managed = serviceStatus?.running && serviceStatus.spawned;
            let label: string;
            if (running) {
              label = managed ? t('cli.dshServiceManaged') : t('cli.dshServiceExternal');
            } else {
              label = t('cli.dshServiceStopped');
            }
            const baseUrl = serviceStatus?.running ? serviceStatus.baseUrl : null;
            return (
              <p className={`text-xs flex items-center gap-1 ${
                running ? 'text-green-500' : 'text-text-tertiary'
              }`} title={baseUrl || undefined}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  running ? 'bg-green-500' : 'bg-text-tertiary/40'
                }`} />
                {label}
                {baseUrl && (
                  <span className="text-text-tertiary truncate">· {baseUrl.replace(/^https?:\/\//, '')}</span>
                )}
              </p>
            );
          })()}
        </div>
      )}

      {status === 'not_found' && (
        <p className="text-[13px] text-amber-500">{t('cli.notFound')}</p>
      )}

      {/* G5: update_failed 也显示按钮行以便重试（同 CliSection） */}
      {(status === 'idle' || status === 'found' || status === 'not_found' || status === 'update_failed') && (
        <div className="flex gap-3">
          {/* G5: 更新按钮 —— 仅已安装时显示（参照 Codex 段写法） */}
          {status !== 'not_found' && (
            <button
              onClick={handleUpdate}
              className="flex-1 py-2 text-[13px] font-medium rounded-lg
                border border-border-subtle text-text-muted
                hover:bg-bg-secondary hover:text-text-primary transition-smooth"
            >
              {t('cli.update')}
            </button>
          )}
          <button
            onClick={doCheck}
            className="flex-1 py-2 text-[13px] font-medium rounded-lg
              border border-border-subtle text-text-muted
              hover:bg-bg-secondary hover:text-text-primary transition-smooth"
          >
            {t('cli.check')}
          </button>
          <button
            onClick={handleInstall}
            className={`flex-1 py-2 text-[13px] font-medium rounded-lg transition-smooth
              ${status === 'not_found'
                ? 'bg-accent text-text-inverse hover:bg-accent-hover'
                : 'border border-border-subtle text-text-muted hover:bg-bg-secondary hover:text-text-primary'
              }`}
          >
            {status === 'not_found' ? t('cli.install') : t('cli.reinstall')}
          </button>
        </div>
      )}

      {status === 'checking' && (
        <div className="flex items-center justify-center gap-2 py-2">
          <div className="w-4 h-4 border-2 border-text-tertiary/30
            border-t-text-tertiary rounded-full animate-spin" />
          <span className="text-[13px] text-text-muted">{t('cli.checking')}</span>
        </div>
      )}

      {status === 'installing' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-text-muted">
              {phase === 'npm_fallback' ? t('setup.npmFallback') : t('cli.installing')}
            </span>
            {downloadPercent > 0 && downloadPercent < 100 && (
              <span className="text-[13px] text-text-tertiary">{downloadPercent}%</span>
            )}
          </div>
          <div className="w-full h-2 rounded-full bg-bg-tertiary overflow-hidden">
            {downloadPercent > 0 ? (
              <div
                className="h-full bg-accent rounded-full transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            ) : (
              <div className="h-full bg-accent/60 rounded-full animate-pulse w-full" />
            )}
          </div>
        </div>
      )}

      {(status === 'installed') && (
        <div className="py-2 text-center">
          <span className="text-[13px] text-green-500 font-medium">
            ✓ {t('cli.installDone')} {version && `v${version}`}
          </span>
        </div>
      )}

      {/* G5: 更新进度块 —— 与安装进度块同构（npm_fallback / configuring 阶段提示） */}
      {status === 'updating' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-text-muted">
              {phase === 'npm_fallback' ? t('setup.npmFallback')
                : phase === 'configuring' ? t('cli.configuring')
                : t('cli.updating')}
            </span>
            {downloadPercent > 0 && downloadPercent < 100 && (
              <span className="text-[13px] text-text-tertiary">{downloadPercent}%</span>
            )}
          </div>
          <div className="w-full h-2 rounded-full bg-bg-tertiary overflow-hidden">
            {downloadPercent > 0 ? (
              <div
                className="h-full bg-accent rounded-full transition-all duration-300"
                style={{ width: `${downloadPercent}%` }}
              />
            ) : (
              <div className="h-full bg-accent/60 rounded-full animate-pulse w-full" />
            )}
          </div>
        </div>
      )}

      {/* G5: 更新成功确认（随后 doCheck() 刷新回 found 态） */}
      {status === 'updated' && (
        <div className="py-2 text-center">
          <span className="text-[13px] text-green-500 font-medium">
            ✓ {t('cli.updateDone')} {version && `v${version}`}
          </span>
        </div>
      )}

      {status === 'install_failed' && errorMsg && (
        <div className="py-2 px-3 rounded-lg bg-red-500/10">
          <p className="text-[13px] text-red-500 truncate" title={errorMsg}>{errorMsg}</p>
        </div>
      )}

      {/* G5: 更新失败错误提示（按钮行会重新出现，可重试） */}
      {status === 'update_failed' && errorMsg && (
        <div className="py-2 px-3 rounded-lg bg-red-500/10">
          <p className="text-[13px] text-red-500 truncate" title={errorMsg}>{errorMsg}</p>
        </div>
      )}
    </div>
  );
}

// ─── CLI Diagnostics Panel ─────────────────────────────────

function CliDiagnostics() {
  const t = useT();
  const [candidates, setCandidates] = useState<CliCandidate[]>([]);
  const [pinnedPath, setPinnedPath] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [actionMsg, setActionMsg] = useState('');

  // Auto-scan on mount
  const handleScan = useCallback(async () => {
    setScanning(true);
    setActionMsg('');
    try {
      const [result, pinned] = await Promise.all([
        bridge.diagnoseCli(),
        bridge.getPinnedCli(),
      ]);
      setCandidates(result);
      setPinnedPath(pinned);
    } catch (e) {
      console.error('diagnose_cli failed:', e);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => { handleScan(); }, [handleScan]);

  const handlePin = useCallback(async (path: string) => {
    try {
      await bridge.pinCli(path);
      setPinnedPath(path);
      setActionMsg(t('cli.pinned'));
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setActionMsg(friendlyError(String(e)));
    }
  }, [t]);

  const handleUnpin = useCallback(async () => {
    try {
      await bridge.unpinCli();
      setPinnedPath(null);
      setActionMsg(t('cli.unpinned'));
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setActionMsg(friendlyError(String(e)));
    }
  }, [t]);

  const handleInjectPath = useCallback(async (path: string) => {
    try {
      const result = await bridge.injectCliPath(path);
      setActionMsg(result);
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setActionMsg(friendlyError(String(e)));
    }
  }, []);

  const handleDelete = useCallback(async (path: string) => {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await ask(
      `${t('cli.confirmDelete')}\n${path}`,
      { title: 'CLI', kind: 'warning' }
    );
    if (!confirmed) return;
    try {
      const result = await bridge.deleteCli(path);
      setActionMsg(result);
      const updated = await bridge.diagnoseCli();
      setCandidates(updated);
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setActionMsg(friendlyError(String(e)));
    }
  }, [t]);

  // Distinguish Claude vs Codex by binary name
  const cliLabel = (path: string) => {
    const lower = path.toLowerCase();
    if (lower.includes('codex')) return 'Codex';
    if (lower.includes('claude')) return 'Claude';
    return '';
  };

  const isActive = (path: string) => pinnedPath ? path === pinnedPath : candidates[0]?.path === path;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-text-primary">{t('cli.environment')}</span>
        <button
          onClick={handleScan}
          disabled={scanning}
          className="text-xs text-text-tertiary hover:text-text-primary transition-smooth disabled:opacity-50"
        >
          {scanning ? t('cli.scanning') : t('cli.rescan')}
        </button>
      </div>

      {scanning && candidates.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-3">
          <div className="w-4 h-4 border-2 border-text-tertiary/30
            border-t-text-tertiary rounded-full animate-spin" />
          <span className="text-[13px] text-text-muted">{t('cli.scanning')}</span>
        </div>
      )}

      {!scanning && candidates.length === 0 && (
        <p className="text-[13px] text-text-tertiary py-2">{t('cli.noCliFound')}</p>
      )}

      <div className="space-y-2">
        {candidates.map((c) => {
          const active = isActive(c.path);
          const canDelete = c.source !== 'official';
          const label = cliLabel(c.path);
          return (
            <div
              key={c.path}
              className={`py-2.5 px-3 rounded-lg transition-smooth border
                ${active
                  ? 'border-accent/20 bg-accent/5'
                  : 'border-border-subtle'
                }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  {label && (
                    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-bg-tertiary/50 text-text-secondary">
                      {label}
                    </span>
                  )}
                  <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded
                    ${SOURCE_COLORS[c.source] || 'text-text-tertiary'}
                    ${active ? 'bg-accent/10' : 'bg-bg-tertiary/50'}`}
                  >
                    {t(SOURCE_I18N_KEYS[c.source] || '') || c.source}
                  </span>
                  {c.version && (
                    <span className="text-[13px] text-text-secondary font-medium">v{c.version}</span>
                  )}
                  {c.isNative && (
                    <span className="text-[11px] text-text-tertiary">native</span>
                  )}
                  {active && pinnedPath && (
                    <span className="text-[11px] text-accent font-medium">★</span>
                  )}
                </div>
                {active && (
                  <span className="text-[11px] text-accent font-medium shrink-0">{t('cli.inUse')}</span>
                )}
              </div>
              <p className="text-xs text-text-tertiary truncate mt-1" title={c.path}>
                {c.path}
              </p>
              {c.issues.length > 0 && (
                <p className="text-xs text-amber-500 mt-1">{c.issues.join(' · ')}</p>
              )}
              {/* Actions */}
              <div className="flex gap-2 mt-2">
                {!active && c.issues.length === 0 && (
                  <button
                    onClick={() => handlePin(c.path)}
                    className="py-1 px-2.5 text-xs font-medium rounded-md
                      border border-border-subtle text-text-muted
                      hover:bg-bg-secondary hover:text-text-primary transition-smooth"
                  >
                    {t('cli.use')}
                  </button>
                )}
                {active && pinnedPath && (
                  <button
                    onClick={handleUnpin}
                    className="py-1 px-2.5 text-xs font-medium rounded-md
                      border border-border-subtle text-text-muted
                      hover:bg-bg-tertiary transition-smooth"
                  >
                    {t('cli.unpin')}
                  </button>
                )}
                <button
                  onClick={() => handleInjectPath(c.path)}
                  className="py-1 px-2.5 text-xs font-medium rounded-md
                    border border-border-subtle text-text-muted
                    hover:bg-bg-tertiary transition-smooth"
                >
                  {t('cli.injectPath')}
                </button>
                {canDelete && (
                  <button
                    onClick={() => handleDelete(c.path)}
                    className="py-1 px-2.5 text-xs font-medium rounded-md
                      border border-red-500/20 text-red-400
                      hover:bg-red-500/10 transition-smooth"
                  >
                    {t('cli.delete')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {actionMsg && (
        <p className="text-xs text-text-tertiary">{actionMsg}</p>
      )}
    </div>
  );
}
