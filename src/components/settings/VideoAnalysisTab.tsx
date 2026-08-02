import { useCallback, useEffect, useState } from 'react';
import {
  useSettingsStore,
  hasVideoAnalysisMultimodalDefaults,
} from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { VideoAnalysisRuntimeSection } from './VideoAnalysisRuntimeSection';

/**
 * Settings tab for video-analysis skill:
 * - Default multimodal (vision) model config (Mode B).
 * - Acceleration toggle (scene-detect, pHash dedup, grid-stitch, VAD, etc.).
 * - Runtime environment status + one-click install.
 */
export function VideoAnalysisTab() {
  const t = useT();
  const setVideoAnalysisBaseUrl = useSettingsStore((s) => s.setVideoAnalysisBaseUrl);
  const setVideoAnalysisApiKey = useSettingsStore((s) => s.setVideoAnalysisApiKey);
  const setVideoAnalysisApiKeyEnv = useSettingsStore((s) => s.setVideoAnalysisApiKeyEnv);
  const setVideoAnalysisModel = useSettingsStore((s) => s.setVideoAnalysisModel);
  const setVideoAnalysisMultimodal = useSettingsStore((s) => s.setVideoAnalysisMultimodal);
  const setVideoAnalysisAsrModel = useSettingsStore((s) => s.setVideoAnalysisAsrModel);

  const [vaDraftBaseUrl, setVaDraftBaseUrl] = useState(
    () => useSettingsStore.getState().videoAnalysisBaseUrl,
  );
  const [vaDraftApiKey, setVaDraftApiKey] = useState(
    () => useSettingsStore.getState().videoAnalysisApiKey,
  );
  const [vaDraftApiKeyEnv, setVaDraftApiKeyEnv] = useState(
    () => useSettingsStore.getState().videoAnalysisApiKeyEnv,
  );
  const [vaDraftModel, setVaDraftModel] = useState(
    () => useSettingsStore.getState().videoAnalysisModel,
  );
  const [vaShowKey, setVaShowKey] = useState(false);
  const [vaSaving, setVaSaving] = useState(false);
  const [vaSavedMsg, setVaSavedMsg] = useState<string | null>(null);
  const [vaError, setVaError] = useState<string | null>(null);

  // Acceleration toggle — read from authoritative backend config.
  const [accelEnabled, setAccelEnabled] = useState(
    () => useSettingsStore.getState().videoAnalysisAccelEnabled,
  );
  const [accelSwitching, setAccelSwitching] = useState(false);

  // ASR model size — read from authoritative backend config.
  const [asrModel, setAsrModel] = useState(
    () => useSettingsStore.getState().videoAnalysisAsrModel || 'small',
  );
  const [asrModelSwitching, setAsrModelSwitching] = useState(false);

  // Load multimodal defaults + acceleration from disk (authoritative backend store) on mount.
  useEffect(() => {
    let cancelled = false;
    bridge
      .getVideoAnalysisMultimodalConfig()
      .then((cfg) => {
        if (cancelled) return;
        setVideoAnalysisMultimodal({
          baseUrl: cfg.baseUrl || '',
          apiKey: cfg.apiKey || '',
          apiKeyEnv: cfg.apiKeyEnv || '',
          model: cfg.model || '',
        });
        setVaDraftBaseUrl(cfg.baseUrl || '');
        setVaDraftApiKey(cfg.apiKey || '');
        setVaDraftApiKeyEnv(cfg.apiKeyEnv || '');
        setVaDraftModel(cfg.model || '');
        setAccelEnabled(cfg.accelerationEnabled ?? false);
        setAsrModel(cfg.asrModelSize || 'small');
        setVideoAnalysisAsrModel(cfg.asrModelSize || 'small');
      })
      .catch(() => {
        // Fall back to local persisted values already in the store.
        const s = useSettingsStore.getState();
        setVaDraftBaseUrl(s.videoAnalysisBaseUrl);
        setVaDraftApiKey(s.videoAnalysisApiKey);
        setVaDraftApiKeyEnv(s.videoAnalysisApiKeyEnv);
        setVaDraftModel(s.videoAnalysisModel);
        setAccelEnabled(s.videoAnalysisAccelEnabled);
        setAsrModel(s.videoAnalysisAsrModel || 'small');
      });
    return () => {
      cancelled = true;
    };
  }, [setVideoAnalysisMultimodal]);

  const vaComplete = hasVideoAnalysisMultimodalDefaults({
    videoAnalysisBaseUrl: vaDraftBaseUrl,
    videoAnalysisApiKey: vaDraftApiKey,
    videoAnalysisApiKeyEnv: vaDraftApiKeyEnv,
    videoAnalysisModel: vaDraftModel,
  });

  const handleSaveVideoAnalysis = useCallback(async () => {
    setVaSaving(true);
    setVaError(null);
    setVaSavedMsg(null);
    const next = {
      baseUrl: vaDraftBaseUrl.trim(),
      apiKey: vaDraftApiKey.trim(),
      apiKeyEnv: vaDraftApiKeyEnv.trim(),
      model: vaDraftModel.trim(),
    };
    try {
      const saved = await bridge.saveVideoAnalysisMultimodalConfig({
        ...next,
        accelerationEnabled: accelEnabled,
        asrModelSize: asrModel,
      });
      setVideoAnalysisMultimodal({
        baseUrl: saved.baseUrl,
        apiKey: saved.apiKey,
        apiKeyEnv: saved.apiKeyEnv || '',
        model: saved.model,
      });
      setVaDraftBaseUrl(saved.baseUrl);
      setVaDraftApiKey(saved.apiKey);
      setVaDraftApiKeyEnv(saved.apiKeyEnv || '');
      setVaDraftModel(saved.model);
      setAccelEnabled(saved.accelerationEnabled ?? false);
      setVaSavedMsg(t('settings.videoAnalysisSaved'));
      window.setTimeout(() => setVaSavedMsg(null), 2500);
    } catch (e) {
      setVideoAnalysisBaseUrl(next.baseUrl);
      setVideoAnalysisApiKey(next.apiKey);
      setVideoAnalysisApiKeyEnv(next.apiKeyEnv);
      setVideoAnalysisModel(next.model);
      setVaError(e instanceof Error ? e.message : String(e));
    } finally {
      setVaSaving(false);
    }
  }, [
    vaDraftBaseUrl,
    vaDraftApiKey,
    vaDraftApiKeyEnv,
    vaDraftModel,
    setVideoAnalysisMultimodal,
    setVideoAnalysisBaseUrl,
    setVideoAnalysisApiKey,
    setVideoAnalysisApiKeyEnv,
    setVideoAnalysisModel,
    t,
  ]);

  const handleClearVideoAnalysis = useCallback(async () => {
    setVaDraftBaseUrl('');
    setVaDraftApiKey('');
    setVaDraftApiKeyEnv('');
    setVaDraftModel('');
    setVaError(null);
    setVaSavedMsg(null);
    setVideoAnalysisMultimodal({
      baseUrl: '',
      apiKey: '',
      apiKeyEnv: '',
      model: '',
    });
    try {
      await bridge.saveVideoAnalysisMultimodalConfig({
        baseUrl: '',
        apiKey: '',
        apiKeyEnv: '',
        model: '',
        accelerationEnabled: accelEnabled,
        asrModelSize: asrModel,
      });
    } catch (e) {
      setVaError(e instanceof Error ? e.message : String(e));
    }
  }, [setVideoAnalysisMultimodal]);

  // Toggle acceleration — write to backend, keep API fields untouched.
  const handleToggleAccel = useCallback(async (enabled: boolean) => {
    setAccelSwitching(true);
    setAccelEnabled(enabled);
    try {
      const cfg = await bridge.setVideoAnalysisAcceleration(enabled);
      setAccelEnabled(cfg.accelerationEnabled ?? false);
    } catch (e) {
      setAccelEnabled(!enabled); // revert
      setVaError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccelSwitching(false);
    }
  }, []);

  // Switch ASR model size — write to backend, keep API fields untouched.
  const handleSwitchAsrModel = useCallback(async (modelSize: string) => {
    setAsrModelSwitching(true);
    setAsrModel(modelSize);
    setVideoAnalysisAsrModel(modelSize);
    try {
      const cfg = await bridge.setVideoAnalysisAsrModel(modelSize);
      setAsrModel(cfg.asrModelSize || 'small');
      setVideoAnalysisAsrModel(cfg.asrModelSize || 'small');
    } catch (e) {
      setVaError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsrModelSwitching(false);
    }
  }, [setVideoAnalysisAsrModel]);

  return (
    <div className="space-y-6">
      {/* ===== Acceleration Toggle ===== */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.videoAnalysisAccel.title')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('settings.videoAnalysisAccel.hint')}
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-[13px] font-medium text-text-primary">
              {t('settings.videoAnalysisAccel.enable')}
            </span>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              {t('settings.videoAnalysisAccel.enableHint')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={accelEnabled}
            disabled={accelSwitching}
            onClick={() => handleToggleAccel(!accelEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full
              transition-smooth flex-shrink-0 ml-3 ${
                accelEnabled ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
                transition-smooth ${accelEnabled ? 'translate-x-4.5' : 'translate-x-0.5'}`}
            />
          </button>
        </label>
        {accelSwitching && (
          <span className="mt-2 inline-block text-[11px] text-text-muted">
            ...
          </span>
        )}
        <p className="mt-2 text-[10px] text-text-tertiary">
          {t('settings.videoAnalysisAccel.newSessionHint')}
        </p>
      </div>

      {/* ===== ASR Model Size ===== */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.videoAnalysisAsrModel')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('settings.videoAnalysisAsrModelHint')}
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center gap-3">
          <span className="text-[12px] text-text-secondary whitespace-nowrap">
            {t('settings.videoAnalysisAsrModelLabel')}
          </span>
          <select
            value={asrModel}
            disabled={asrModelSwitching}
            onChange={(e) => handleSwitchAsrModel(e.target.value)}
            className="flex-1 px-2.5 py-1.5 rounded-lg text-[12px] bg-bg-input
              border border-border-subtle text-text-primary
              outline-none focus:border-border-focus disabled:opacity-60"
          >
            {[
              { v: 'tiny', label: 'tiny', vram: '~1 GB', size: '~75 MB', desc: t('settings.videoAnalysisAsrModelTiny') },
              { v: 'base', label: 'base', vram: '~1 GB', size: '~145 MB', desc: t('settings.videoAnalysisAsrModelBase') },
              { v: 'small', label: 'small', vram: '~2 GB', size: '~488 MB', desc: t('settings.videoAnalysisAsrModelSmall') },
              { v: 'medium', label: 'medium', vram: '~5 GB', size: '~1.5 GB', desc: t('settings.videoAnalysisAsrModelMedium') },
              { v: 'large-v2', label: 'large-v2', vram: '~10 GB', size: '~3 GB', desc: t('settings.videoAnalysisAsrModelLargeV2') },
              { v: 'large-v3', label: 'large-v3', vram: '~10 GB', size: '~3 GB', desc: t('settings.videoAnalysisAsrModelLargeV3') },
              { v: 'large-v3-turbo', label: 'large-v3-turbo', vram: '~6 GB', size: '~1.6 GB', desc: t('settings.videoAnalysisAsrModelLargeV3Turbo') },
            ].map((m) => (
              <option key={m.v} value={m.v}>
                faster-whisper-{m.label} — VRAM {m.vram}，下载 {m.size}，{m.desc}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-2 text-[10px] text-text-tertiary">
          {t('settings.videoAnalysisAsrModelSwitchHint')}
        </p>
      </div>

      {/* ===== Runtime Environment ===== */}
      <VideoAnalysisRuntimeSection showConfirm />

      {/* ===== Multimodal Model Config ===== */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.videoAnalysisMultimodal')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('settings.videoAnalysisMultimodalHint')}
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 space-y-3 max-w-xl">
        <div className="grid grid-cols-1 gap-3">
          <label className="block">
            <span className="text-[11px] text-text-muted">{t('settings.videoAnalysisBaseUrl')}</span>
            <input
              type="text"
              value={vaDraftBaseUrl}
              onChange={(e) => setVaDraftBaseUrl(e.target.value)}
              placeholder={t('settings.videoAnalysisBaseUrlPlaceholder')}
              className="mt-1 w-full px-2.5 py-1.5 rounded-lg text-[12px] bg-bg-input
                border border-border-subtle text-text-primary placeholder:text-text-tertiary
                outline-none focus:border-border-focus"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-text-muted">{t('settings.videoAnalysisApiKey')}</span>
            <div className="mt-1 flex gap-1.5">
              <input
                type={vaShowKey ? 'text' : 'password'}
                value={vaDraftApiKey}
                onChange={(e) => setVaDraftApiKey(e.target.value)}
                placeholder={t('settings.videoAnalysisApiKeyPlaceholder')}
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg text-[12px] bg-bg-input
                  border border-border-subtle text-text-primary placeholder:text-text-tertiary
                  outline-none focus:border-border-focus font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setVaShowKey((v) => !v)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] text-text-muted
                  border border-border-subtle hover:bg-bg-secondary transition-smooth"
              >
                {vaShowKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <div className="flex items-center gap-2 py-0.5">
            <div className="flex-1 h-px bg-border-subtle" />
            <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
              {t('settings.videoAnalysisOr')}
            </span>
            <div className="flex-1 h-px bg-border-subtle" />
          </div>

          <label className="block">
            <span className="text-[11px] text-text-muted">{t('settings.videoAnalysisApiKeyEnv')}</span>
            <input
              type="text"
              value={vaDraftApiKeyEnv}
              onChange={(e) => setVaDraftApiKeyEnv(e.target.value)}
              placeholder={t('settings.videoAnalysisApiKeyEnvPlaceholder')}
              className="mt-1 w-full px-2.5 py-1.5 rounded-lg text-[12px] bg-bg-input
                border border-border-subtle text-text-primary placeholder:text-text-tertiary
                outline-none focus:border-border-focus font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1 text-[10px] text-text-tertiary leading-relaxed">
              {t('settings.videoAnalysisApiKeyEnvHint')}
            </p>
          </label>

          <label className="block">
            <span className="text-[11px] text-text-muted">{t('settings.videoAnalysisModel')}</span>
            <input
              type="text"
              value={vaDraftModel}
              onChange={(e) => setVaDraftModel(e.target.value)}
              placeholder={t('settings.videoAnalysisModelPlaceholder')}
              className="mt-1 w-full px-2.5 py-1.5 rounded-lg text-[12px] bg-bg-input
                border border-border-subtle text-text-primary placeholder:text-text-tertiary
                outline-none focus:border-border-focus font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSaveVideoAnalysis}
            disabled={vaSaving}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium
              bg-accent text-white hover:opacity-90 transition-smooth disabled:opacity-60"
          >
            {vaSaving ? '...' : t('settings.videoAnalysisSave')}
          </button>
          <button
            type="button"
            onClick={handleClearVideoAnalysis}
            disabled={vaSaving}
            className="px-3 py-1.5 rounded-lg text-[12px]
              text-text-muted border border-border-subtle
              hover:bg-bg-secondary transition-smooth disabled:opacity-60"
          >
            {t('settings.videoAnalysisClear')}
          </button>
          <span
            className={`text-[11px] ${
              vaComplete ? 'text-emerald-500' : 'text-text-tertiary'
            }`}
          >
            {vaComplete
              ? t('settings.videoAnalysisReady')
              : t('settings.videoAnalysisIncomplete')}
          </span>
        </div>
        {vaSavedMsg && (
          <p className="text-[11px] text-emerald-500">{vaSavedMsg}</p>
        )}
        {vaError && (
          <p className="text-[11px] text-error whitespace-pre-wrap break-all">{vaError}</p>
        )}
      </div>
    </div>
  );
}
