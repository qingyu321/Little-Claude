import { useEffect, useState, useCallback } from 'react';
import { bridge, cancelDownload, invokeWithCancellation, type PrerequisiteItem, onPrereqInstallProgress, onLocalAsrDownloadProgress } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { useSettingsStore } from '../../stores/settingsStore';
import { ConfirmDialog } from '../shared/ConfirmDialog';

type InstallPhase = 'idle' | 'installing' | 'done' | 'error';

interface ItemState {
  phase: InstallPhase;
  message: string;
}

// ── Icon components ──────────────────────────────────────────────────────

function IconOk() {
  return (
    <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function IconMissing() {
  return (
    <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function IconSpinner() {
  return (
    <svg className="w-5 h-5 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function IconInstall() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}

// ── PrerequisitesTab ─────────────────────────────────────────────────────

export function PrerequisitesTab() {
  const t = useT();
  const theme = useSettingsStore((s) => s.theme);

  const [items, setItems] = useState<PrerequisiteItem[]>([]);
  const [checking, setChecking] = useState(true);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [installTarget, setInstallTarget] = useState<string | null>(null);

  // Load prerequisites
  const load = useCallback(async () => {
    setChecking(true);
    try {
      const list = await bridge.checkPrerequisites();
      setItems(list);
    } catch {
      // silent
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Listen for install progress events
  useEffect(() => {
    const unlisten = onPrereqInstallProgress((event) => {
      setStates((prev) => ({
        ...prev,
        [event.key]: {
          phase: event.phase === 'complete' ? 'done' : event.phase === 'error' ? 'error' : 'installing',
          message: event.message || '',
        },
      }));
      // Refresh list after completion
      if (event.phase === 'complete') {
        load();
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [load]);

  const handleInstall = useCallback((key: string) => {
    setInstallTarget(key);
  }, []);

  const confirmInstall = useCallback(async () => {
    if (!installTarget) return;
    const key = installTarget;
    setInstallTarget(null);
    setStates((prev) => ({
      ...prev,
      [key]: { phase: 'installing', message: t('settings.prereq.installing') },
    }));
    try {
      await bridge.installPrerequisite(key);
    } catch {
      // Error handled by event listener
    }
  }, [installTarget, t]);

  // ── Local ASR model state ──────────────────────────────────
  const [asrRuntime, setAsrRuntime] = useState<{ available: boolean } | null>(null);
  const [asrModel, setAsrModel] = useState<{ installed: boolean; model_dir: string; files: string[] } | null>(null);
  const [asrDownloading, setAsrDownloading] = useState(false);
  const [asrDownloadProgress, setAsrDownloadProgress] = useState('');
  const [asrDownloadError, setAsrDownloadError] = useState('');
  // 当前 ASR 下载任务的取消 scope（下载中显示取消按钮，点击后删除 .part 停止下载）
  const [asrDownloadScopeId, setAsrDownloadScopeId] = useState<string | null>(null);

  const checkAsrStatus = useCallback(() => {
    bridge.checkLocalAsrRuntime().then(setAsrRuntime).catch(() => {});
    bridge.checkLocalAsrModel().then(setAsrModel).catch(() => {});
  }, []);

  useEffect(() => { checkAsrStatus(); }, [checkAsrStatus]);

  useEffect(() => {
    const unlisten = onLocalAsrDownloadProgress((p) => {
      setAsrDownloadProgress(`${p.current}/${p.total} ${p.file}`);
      if (p.status === 'done' && p.current >= p.total) {
        setAsrDownloading(false);
        setAsrDownloadProgress('');
        setAsrDownloadError('');
        checkAsrStatus();
      }
    });
    return () => { unlisten.then((fn: () => void) => fn()); };
  }, [checkAsrStatus]);

  const handleDownloadAsr = useCallback(async () => {
    setAsrDownloading(true);
    setAsrDownloadProgress('');
    setAsrDownloadError('');
    // 取消 scope：下载中展示取消按钮，点击后后端停止下载并删除 .part 临时文件
    const scopeId = `asr-download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setAsrDownloadScopeId(scopeId);
    try {
      await invokeWithCancellation('download_local_asr_model', { mirrorIndex: null }, scopeId); // 自动尝试所有镜像
    } catch (e: any) {
      setAsrDownloadError(typeof e === 'string' ? e : e?.message || String(e));
      setAsrDownloading(false);
    } finally {
      setAsrDownloadScopeId(null);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    setStates({});
    load();
  }, [load]);

  // Theme-aware colors
  const isDark = theme === 'dark';
  const cardBg = isDark ? 'bg-white/5' : 'bg-black/[0.03]';
  const borderColor = isDark ? 'border-white/10' : 'border-black/10';
  const textSecondary = isDark ? 'text-white/60' : 'text-black/60';
  const btnPrimary = 'bg-blue-600 hover:bg-blue-700 text-white';
  const btnOutline = isDark
    ? 'border border-white/20 hover:bg-white/10 text-white/80'
    : 'border border-black/20 hover:bg-black/5 text-black/80';

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto p-4 pt-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">{t('settings.prereq.title')}</h3>
          <p className={`text-xs ${textSecondary} mt-1`}>
            {t('settings.prereq.hint')}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={checking}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${btnOutline}`}
        >
          {checking ? t('settings.prereq.refreshing') : t('settings.prereq.refresh')}
        </button>
      </div>

      {/* Prerequisite list */}
      {checking && items.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <IconSpinner />
          <span className={`ml-3 text-sm ${textSecondary}`}>{t('settings.prereq.checking')}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const state = states[item.key];
            const isInstalling = state?.phase === 'installing';
            const hasError = state?.phase === 'error';

            return (
              <div
                key={item.key}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${borderColor} ${cardBg} transition-colors`}
              >
                {/* Status icon */}
                <div className="flex-shrink-0">
                  {isInstalling ? (
                    <IconSpinner />
                  ) : item.status === 'ok' ? (
                    <IconOk />
                  ) : (
                    <IconMissing />
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{item.name}</p>
                    {item.required && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/10 text-red-400 font-medium">
                        {t('settings.prereq.required')}
                      </span>
                    )}
                    {!item.required && item.installable && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-blue-500/10 text-blue-400 font-medium">
                        {t('settings.prereq.optional')}
                      </span>
                    )}
                  </div>
                  <p className={`text-xs ${textSecondary}`}>{item.description}</p>
                  {item.version && item.status === 'ok' && !hasError && !isInstalling && (
                    <p className="text-xs text-green-500/70 mt-0.5 truncate">{item.version}</p>
                  )}
                  {hasError && item.manualUrl && (
                    <p className="text-xs text-yellow-500/80 mt-0.5">{t('settings.prereq.errorHint')}</p>
                  )}
                  {hasError && (
                    <p className="text-xs text-red-400 mt-0.5 truncate">{state?.message}</p>
                  )}
                  {isInstalling && (
                    <p className="text-xs text-blue-400 mt-0.5">{state?.message || t('settings.prereq.installing')}</p>
                  )}
                </div>

                {/* Action button */}
                <div className="flex-shrink-0">
                  {item.status === 'ok' ? (
                    <span className="text-xs text-green-500 font-medium">{t('settings.prereq.installed')}</span>
                  ) : item.installable && !isInstalling ? (
                    <button
                      onClick={() => handleInstall(item.key)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${btnPrimary}`}
                    >
                      <IconInstall />
                      {t('settings.prereq.install')}
                    </button>
                  ) : item.manualUrl && (!item.installable || hasError) ? (
                    <button
                      onClick={() => item.manualUrl && window.open(item.manualUrl, '_blank')}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${btnOutline}`}
                    >
                      {t('settings.prereq.manualDownload')}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Local ASR model card ────────────────────────────────── */}
      {asrRuntime && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${borderColor} ${cardBg} transition-colors`}>
          <div className="flex-shrink-0">
            {asrDownloading ? <IconSpinner /> : asrModel?.installed ? <IconOk /> : <IconMissing />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">
                {t('settings.localAsr.title') || '本地语音识别引擎'}
              </p>
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-blue-500/10 text-blue-400 font-medium">
                {t('settings.prereq.optional')}
              </span>
              {!asrRuntime.available && (
                <span className="px-1.5 py-0.5 text-[10px] rounded bg-yellow-500/10 text-yellow-400 font-medium">
                  未编译
                </span>
              )}
            </div>
            <p className={`text-xs ${textSecondary}`}>
              {asrRuntime.available
                ? (t('settings.localAsr.description') || 'sherpa-onnx + SenseVoice 离线语音识别，~80MB')
                : (t('settings.localAsr.notCompiled') || '当前版本未包含本地 ASR 模块，请使用完整构建')}
            </p>
            {asrDownloading && asrDownloadProgress && (
              <p className="text-xs text-blue-400 mt-0.5">{asrDownloadProgress}</p>
            )}
            {asrDownloadError && (
              <p className="text-xs text-red-400 mt-0.5 truncate">下载失败: {asrDownloadError}</p>
            )}
            {asrModel?.installed && (
              <p className="text-xs text-green-500/70 mt-0.5 truncate">{asrModel.model_dir}</p>
            )}
          </div>
          <div className="flex-shrink-0 flex items-center gap-2">
            {!asrModel?.installed && !asrDownloading && (
              <button
                onClick={handleDownloadAsr}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${btnPrimary}`}
              >
                <IconInstall />
                {t('settings.localAsr.download') || '下载模型'}
              </button>
            )}
            {asrDownloading && asrDownloadScopeId && (
              <button
                onClick={() => cancelDownload(asrDownloadScopeId)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${btnOutline}`}
              >
                {t('common.cancel')}
              </button>
            )}
            {asrModel?.installed && (
              <span className="text-xs text-green-500 font-medium">
                {t('settings.prereq.installed')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Install confirmation dialog */}
      <ConfirmDialog
        open={installTarget !== null}
        title={t('settings.prereq.installConfirmTitle')}
        message={t('settings.prereq.installConfirmMsg')}
        confirmLabel={t('settings.prereq.install')}
        cancelLabel={t('common.cancel')}
        onConfirm={confirmInstall}
        onCancel={() => setInstallTarget(null)}
      />
    </div>
  );
}
