import { useState, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { SpeechRuntimeSection } from './SpeechRuntimeSection';

/**
 * Settings tab for speech-to-text input:
 * - Enable/disable toggle
 * - Recognition language
 * - Offline whisper model preference
 * - Runtime environment status + one-click download
 */
export function SpeechTab() {
  const t = useT();
  const speechEnabled = useSettingsStore((s) => s.speechEnabled);
  const setSpeechEnabled = useSettingsStore((s) => s.setSpeechEnabled);
  const speechLanguage = useSettingsStore((s) => s.speechLanguage);
  const setSpeechLanguage = useSettingsStore((s) => s.setSpeechLanguage);
  const speechUseOfflineModel = useSettingsStore((s) => s.speechUseOfflineModel);
  const setSpeechUseOfflineModel = useSettingsStore((s) => s.setSpeechUseOfflineModel);

  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const handleToggleEnabled = useCallback((enabled: boolean) => {
    setSpeechEnabled(enabled);
  }, [setSpeechEnabled]);

  const handleToggleOffline = useCallback((useOffline: boolean) => {
    setSaving(true);
    setSpeechUseOfflineModel(useOffline);
    setSavedMsg(t('settings.videoAnalysisSaved'));
    window.setTimeout(() => { setSavedMsg(null); setSaving(false); }, 2000);
  }, [setSpeechUseOfflineModel, t]);

  return (
    <div className="space-y-6">
      {/* ===== Title ===== */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.speech.title')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('settings.speech.hint')}
        </p>
      </div>

      {/* ===== Enable toggle ===== */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-[13px] font-medium text-text-primary">
              {t('settings.speech.enable')}
            </span>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              {t('settings.speech.enableHint')}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={speechEnabled}
            onClick={() => handleToggleEnabled(!speechEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full
              transition-smooth flex-shrink-0 ml-3 ${
                speechEnabled ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
                transition-smooth ${speechEnabled ? 'translate-x-4.5' : 'translate-x-0.5'}`}
            />
          </button>
        </label>
      </div>

      {/* ===== Language ===== */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.speech.language')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          选择语音识别的目标语言。
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center gap-3">
          <span className="text-[12px] text-text-secondary whitespace-nowrap">
            {t('settings.speech.language')}：
          </span>
          <select
            value={speechLanguage}
            onChange={(e) => setSpeechLanguage(e.target.value)}
            className="flex-1 px-2.5 py-1.5 rounded-lg text-[12px] bg-bg-input
              border border-border-subtle text-text-primary
              outline-none focus:border-border-focus"
          >
            <option value="zh-CN">{t('settings.speech.languageZh')}</option>
            <option value="en-US">{t('settings.speech.languageEn')}</option>
          </select>
        </label>
      </div>

      {/* ===== Offline model preference ===== */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.speech.offlineModel')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('settings.speech.offlineModelHint')}
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-[13px] font-medium text-text-primary">
            {t('settings.speech.offlineModel')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={speechUseOfflineModel}
            disabled={saving}
            onClick={() => handleToggleOffline(!speechUseOfflineModel)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full
              transition-smooth flex-shrink-0 ml-3 ${
                speechUseOfflineModel ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
                transition-smooth ${speechUseOfflineModel ? 'translate-x-4.5' : 'translate-x-0.5'}`}
            />
          </button>
        </label>
        {savedMsg && (
          <p className="mt-2 text-[11px] text-emerald-500">{savedMsg}</p>
        )}
      </div>

      {/* ===== Runtime Environment ===== */}
      <SpeechRuntimeSection showConfirm />
    </div>
  );
}
