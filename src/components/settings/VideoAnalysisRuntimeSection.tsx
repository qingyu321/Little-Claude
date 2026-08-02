import { useCallback, useEffect, useRef } from 'react';
import { useVideoAnalysisRuntimeStore, type RuntimeDepCheck, type VideoAnalysisRuntimeState } from '../../stores/videoAnalysisRuntimeStore';
import { useT } from '../../lib/i18n';
import { bridge, onSkillRuntimeDownloadProgress, type SkillRuntimeDownloadProgress } from '../../lib/tauri-bridge';

export interface VideoAnalysisRuntimeSectionProps {
  /** Show the install confirmation button (vs "稍后再说" dismiss). */
  showConfirm?: boolean;
  /** Called after install completes successfully. */
  onInstalled?: () => void;
  /** Called when user clicks "稍后再说". */
  onDismiss?: () => void;
}

/**
 * Shared runtime diagnostics + install UI used by VideoAnalysisTab (full mode)
 * and SkillsPanel (compact with dismiss).
 */
export function VideoAnalysisRuntimeSection({
  showConfirm = true,
  onInstalled,
  onDismiss,
}: VideoAnalysisRuntimeSectionProps) {
  const t = useT();
  const status = useVideoAnalysisRuntimeStore((s) => s.status);
  const checks = useVideoAnalysisRuntimeStore((s) => s.checks);
  const installPhase = useVideoAnalysisRuntimeStore((s) => s.installPhase);
  const progress = useVideoAnalysisRuntimeStore((s) => s.progress);
  const error = useVideoAnalysisRuntimeStore((s) => s.error);
  const autoInstallSupported = useVideoAnalysisRuntimeStore((s) => s.autoInstallSupported);
  const installing = useVideoAnalysisRuntimeStore((s) => s.installing);
  const deviceBackend = useVideoAnalysisRuntimeStore((s) => s.deviceBackend);
  const deviceBackendLabel = useVideoAnalysisRuntimeStore((s) => s.deviceBackendLabel);
  const setStatus = useVideoAnalysisRuntimeStore((s) => s.setStatus);
  const setChecks = useVideoAnalysisRuntimeStore((s) => s.setChecks);
  const setInstallPhase = useVideoAnalysisRuntimeStore((s) => s.setInstallPhase);
  const setProgress = useVideoAnalysisRuntimeStore((s) => s.setProgress);
  const setError = useVideoAnalysisRuntimeStore((s) => s.setError);
  const setAutoInstallSupported = useVideoAnalysisRuntimeStore((s) => s.setAutoInstallSupported);
  const setInstalling = useVideoAnalysisRuntimeStore((s) => s.setInstalling);
  const setDeviceBackend = useVideoAnalysisRuntimeStore((s) => s.setDeviceBackend);

  const unlistenRef = useRef<(() => void) | null>(null);

  // Refresh status
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const s = await bridge.getVideoAnalysisRuntimeStatus();
      setStatus(s.status as VideoAnalysisRuntimeState['status']);
      setAutoInstallSupported(s.autoInstallSupported ?? false);
      setDeviceBackend(s.deviceBackend || 'cpu', s.deviceBackendLabel || 'CPU');
      if (Array.isArray(s.checks)) {
        setChecks(s.checks.map(c => ({ ...c, detail: c.detail ?? undefined })) as RuntimeDepCheck[]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [setStatus, setAutoInstallSupported, setChecks, setError]);

  // Initial load + 30s cooldown poll
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 30s while not installing
  useEffect(() => {
    if (installing) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh, installing]);

  // Listen for download progress
  useEffect(() => {
    let cancelled = false;
    onSkillRuntimeDownloadProgress((e: SkillRuntimeDownloadProgress) => {
      if (cancelled) return;
      if (e.skill !== 'video-analysis') return;
      setProgress({
        percent: e.percent,
        message: e.message,
        downloaded: e.downloaded,
        total: e.total,
      });
      if (!installing) setInstalling(true);
    }).then((unlisten: () => void) => {
      if (cancelled) unlisten();
      else unlistenRef.current = unlisten;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, [setProgress, setInstalling, installing]);

  // Start install
  const handleInstall = useCallback(async () => {
    if (installing) return;
    setInstallPhase('installing');
    setInstalling(true);
    setError(null);
    try {
      const s = await bridge.downloadVideoAnalysisRuntime();
      setStatus(s.status as VideoAnalysisRuntimeState['status']);
      if (Array.isArray(s.checks)) {
        setChecks(s.checks.map(c => ({ ...c, detail: c.detail ?? undefined })) as RuntimeDepCheck[]);
      }
      setInstallPhase('done');
      onInstalled?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setInstallPhase('error');
    } finally {
      setInstalling(false);
    }
  }, [
    installing, setInstallPhase, setInstalling, setError,
    setStatus, setChecks, onInstalled,
  ]);

  const handleDismiss = useCallback(() => {
    onDismiss?.();
  }, [onDismiss]);

  // --- Derived state ---
  const missing = checks.filter((c) => !c.ready);
  const allReady = status === 'ready' || (checks.length > 0 && missing.length === 0);
  const showInstallBtn = showConfirm && !allReady && installPhase !== 'installing' && !installing;
  const showProgress = installing || installPhase === 'installing';

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 space-y-3 max-w-xl">
      {/* Title + device backend badge */}
      <div className="flex items-center gap-2">
        <h4 className="text-[13px] font-medium text-text-primary">
          {t('settings.videoAnalysisRuntime')}
        </h4>
        {deviceBackend && (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
              deviceBackend === 'cuda'
                ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                : deviceBackend === 'apple-silicon'
                  ? 'bg-violet-500/10 text-violet-600 border border-violet-500/20'
                  : deviceBackend === 'amd-gpu'
                    ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
                    : 'bg-text-tertiary/10 text-text-tertiary border border-text-tertiary/10'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                deviceBackend === 'cuda'
                  ? 'bg-emerald-500'
                  : deviceBackend === 'apple-silicon'
                    ? 'bg-violet-500'
                    : deviceBackend === 'amd-gpu'
                      ? 'bg-amber-400'
                      : 'bg-text-tertiary'
              }`}
            />
            {deviceBackendLabel}
          </span>
        )}
      </div>

      {/* Dependency checks */}
      {checks.length > 0 && (
        <div className="space-y-1.5">
          {checks.map((c, i) => (
            <div key={i} className="flex items-center gap-2 text-[12px]">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  c.ready ? 'bg-emerald-500' : 'bg-amber-400'
                }`}
              />
              <span className="text-text-secondary">{c.label}</span>
              {c.detail && (
                <span className="text-text-tertiary text-[10px] ml-auto truncate max-w-[160px]">
                  {c.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Progress bar */}
      {showProgress && progress && (
        <div className="space-y-1">
          <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
              style={{ width: `${Math.max(progress.percent, 2)}%` }}
            />
          </div>
          <p className="text-[10px] text-text-tertiary">
            {progress.message} {progress.percent > 0 && `${progress.percent}%`}
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-[11px] text-error whitespace-pre-wrap break-all">{error}</p>
      )}

      {/* Buttons */}
      <div className="flex flex-wrap items-center gap-2">
        {showInstallBtn && autoInstallSupported && (
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium
              bg-accent text-white hover:opacity-90 transition-smooth disabled:opacity-60"
          >
            {missing.length > 0
              ? t('skills.runtimeDownload')
              : t('settings.videoAnalysisRecheck')}
          </button>
        )}
        {showInstallBtn && !autoInstallSupported && (
          <div className="space-y-2 w-full">
            <p className="text-[11px] text-text-tertiary">
              {t('settings.videoAnalysisManualHint')}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => bridge.openVideoAnalysisSkillDir()}
                className="px-3 py-1.5 rounded-lg text-[12px]
                  text-text-muted border border-border-subtle
                  hover:bg-bg-secondary transition-smooth"
              >
                {t('skills.runtimeOpenDir')}
              </button>
            </div>
          </div>
        )}
        {!allReady && !showConfirm && (
          <button
            type="button"
            onClick={handleDismiss}
            className="px-3 py-1.5 rounded-lg text-[12px]
              text-text-muted hover:text-text-primary transition-smooth"
          >
            {t('skills.runtimeLater')}
          </button>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={installing}
          className="px-2.5 py-1 rounded-lg text-[11px]
            text-text-muted hover:bg-bg-secondary transition-smooth disabled:opacity-60"
        >
          {t('skills.refresh')}
        </button>
      </div>

      {/* Mirror hint */}
      {showInstallBtn && autoInstallSupported && (
        <p className="text-[10px] text-text-tertiary leading-relaxed">
          {t('skills.runtimeMirrorHint')}
        </p>
      )}
    </div>
  );
}
