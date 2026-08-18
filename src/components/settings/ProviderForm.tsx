import { useEffect, useState, useCallback, useRef } from 'react';
import { useProviderStore, type ApiProvider, type ModelMapping } from '../../stores/providerStore';
import { bridge, type ConnectionTestResult } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { openUrl } from '@tauri-apps/plugin-opener';
import { PROVIDER_PRESETS } from '../../lib/provider-presets';
import { normalizeProviderModelName } from '../../lib/model-utils';
import { ConfirmDialog } from '../shared/ConfirmDialog';

const INPUT_CLASS = 'w-full px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent';

/* SVG eye icons */
function EyeOpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2 14L14 2" />
    </svg>
  );
}

export type TestStatus = 'idle' | 'testing' | 'success' | 'auth_error' | 'failed';

/** T05: human-readable backend label for the switch-confirm dialog. */
function backendDisplayName(b: 'claude' | 'codex' | 'deepseek'): string {
  return b === 'codex' ? 'Codex' : b === 'deepseek' ? 'DSH (DeepSeek)' : 'Claude';
}

interface ProviderFormProps {
  provider: ApiProvider;
  onClose: () => void;
  onDelete: () => void;
  autoTest?: boolean;
  onTestStatusChange?: (status: TestStatus) => void;
}

export function ProviderForm({ provider, onClose, onDelete, autoTest, onTestStatusChange }: ProviderFormProps) {
  const t = useT();
  const updateProvider = useProviderStore((s) => s.updateProvider);
  const decryptFailed = useProviderStore((s) => !!s.decryptFailures[provider.id]);

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiFormat, setApiFormat] = useState(provider.apiFormat);
  // On a decrypt failure the store keeps the TENC1: ciphertext — never show it
  // in the field; start empty so the user re-enters the key.
  const [apiKey, setApiKey] = useState(
    provider.apiKey && provider.apiKey.startsWith('TENC1:') ? '' : provider.apiKey || '',
  );
  const [showKey, setShowKey] = useState(false);
  const [proxyUrl, setProxyUrl] = useState(provider.proxyUrl || '');
  const [mappings, setMappings] = useState<ModelMapping[]>(provider.modelMappings);
  const [extraEnv, setExtraEnv] = useState<Record<string, string>>(provider.extra_env || {});
  const [cliBackend, setCliBackend] = useState(provider.cliBackend || 'claude');
  // T05: deepseek (DSH) joins claude/codex as a switchable backend target.
  const [confirmTarget, setConfirmTarget] = useState<'claude' | 'codex' | 'deepseek' | null>(null);
  const [testStatus, _setTestStatus] = useState<TestStatus>('idle');
  const [_testError, setTestError] = useState('');
  const [testTimeMs, setTestTimeMs] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [modelListOpen, setModelListOpen] = useState(false);
  /** Non-null only while the user is actively typing — gates the dropdown
   *  filter so a plain focus/chevron open shows the full list instead of
   *  filtering it down to the saved value itself. */
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const comboRef = useRef<HTMLDivElement>(null);

  const setTestStatus = useCallback((status: TestStatus) => {
    _setTestStatus(status);
    onTestStatusChange?.(status);
  }, [onTestStatusChange]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(saveTimerRef.current);
  }, []);

  // Close the model dropdown on outside click
  useEffect(() => {
    if (!modelListOpen) return;
    const handler = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) {
        setModelListOpen(false);
        setModelDraft(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelListOpen]);

  const autoSave = useCallback((patch: Partial<ApiProvider>) => {
    clearTimeout(saveTimerRef.current);
    // Reset test status on any field change
    setTestStatus('idle');
    setTestError('');
    setTestTimeMs(null);
    // The fetched model list was pulled with the old credentials/URL
    setFetchMsg(null);
    saveTimerRef.current = setTimeout(() => {
      updateProvider(provider.id, patch);
    }, 500);
  }, [provider.id, updateProvider]);

  const handleNameChange = (v: string) => { setName(v); autoSave({ name: v }); };
  const handleBaseUrlChange = (v: string) => { setBaseUrl(v); autoSave({ baseUrl: v }); };
  const handleApiKeyChange = (v: string) => { setApiKey(v); autoSave({ apiKey: v || undefined }); };
  const handleProxyUrlChange = (v: string) => { setProxyUrl(v); autoSave({ proxyUrl: v || undefined }); };
  // API format selector hidden from UI — kept for backward compat
  const handleApiFormatChange = (v: 'anthropic' | 'openai') => { setApiFormat(v); autoSave({ apiFormat: v }); };
  const handleCliBackendChange = (v: 'claude' | 'codex' | 'deepseek') => { setCliBackend(v); autoSave({ cliBackend: v }); };

  const FIXED_TIERS = new Set(['opus', 'sonnet', 'haiku']);

  /** Merged default model — display priority: sonnet → opus → haiku. Legacy
   *  providers with split tier mappings show the sonnet value until next edit. */
  const getDefaultModel = (): string => {
    for (const tier of ['sonnet', 'opus', 'haiku']) {
      const m = mappings.find((mm) => mm.tier === tier);
      if (m?.providerModel) return normalizeProviderModelName(m.providerModel);
    }
    return '';
  };

  /** The single model field writes all three tiers at once — for single-model
   *  providers the tier split is meaningless, so every resolution path
   *  (opus/sonnet/haiku) lands on the same model. Fixed tiers stay first so
   *  the connection test keeps using the default model. */
  const updateAllTiers = (value: string) => {
    const rest = mappings.filter((m) => !FIXED_TIERS.has(m.tier));
    const providerModel = normalizeProviderModelName(value);
    const updated = providerModel
      ? [
          { tier: 'opus', providerModel },
          { tier: 'sonnet', providerModel },
          { tier: 'haiku', providerModel },
          ...rest,
        ]
      : rest;
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  const extraMappings = mappings.filter((m) => !FIXED_TIERS.has(m.tier));

  const addExtraMapping = () => {
    const updated = [...mappings, { tier: '', providerModel: '' }];
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  /** Update extra model: tier and providerModel are always the same value */
  const updateExtraModel = (oldTier: string, modelName: string) => {
    const providerModel = normalizeProviderModelName(modelName);
    const updated = mappings.map((m) =>
      m.tier === oldTier && !FIXED_TIERS.has(m.tier) ? { tier: providerModel, providerModel } : m,
    );
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  const removeExtraMapping = (tier: string) => {
    const updated = mappings.filter((m) => m.tier !== tier || FIXED_TIERS.has(m.tier));
    setMappings(updated);
    autoSave({ modelMappings: updated });
  };

  const handleExtraEnvChange = (key: string, value: string) => {
    const updated = { ...extraEnv, [key]: value };
    setExtraEnv(updated);
    autoSave({ extra_env: updated });
  };

  const handleExtraEnvRemove = (key: string) => {
    const updated = { ...extraEnv };
    delete updated[key];
    setExtraEnv(updated);
    autoSave({ extra_env: updated });
  };

  const handleExtraEnvAdd = () => {
    const key = `NEW_VAR_${Object.keys(extraEnv).length}`;
    setExtraEnv({ ...extraEnv, [key]: '' });
  };

  const handleTestConnection = useCallback(async () => {
    setTestStatus('testing');
    setTestError('');
    setTestTimeMs(null);
    setTestResult(null);
    try {
      const testModel = normalizeProviderModelName(mappings.find((m) => m.providerModel)?.providerModel || '');
      if (!testModel) {
        setTestStatus('failed');
        setTestError(t('provider.testNoModel'));
        return;
      }
      if (!apiKey) {
        setTestStatus('failed');
        setTestError(t('provider.testNoKey'));
        return;
      }
      const start = Date.now();
      const result = await bridge.testProviderConnection(baseUrl, apiFormat, apiKey, testModel, proxyUrl || undefined);
      const elapsed = Date.now() - start;
      setTestResult(result);
      setTestTimeMs(elapsed);
      if (result.connectivity.ok && result.auth.ok && result.model.ok) {
        setTestStatus('success');
      } else if (!result.auth.ok && result.connectivity.ok) {
        setTestStatus('auth_error');
        setTestError(result.auth.message);
      } else {
        setTestStatus('failed');
        const failedStep = !result.connectivity.ok ? result.connectivity : result.model;
        setTestError(failedStep.message);
      }
    } catch (e) {
      setTestStatus('failed');
      setTestError(String(e));
    }
  }, [baseUrl, apiFormat, apiKey, mappings, t]);

  const handleFetchModels = useCallback(async () => {
    if (fetchingModels) return;
    if (!baseUrl || !apiKey) {
      setFetchMsg({ ok: false, text: t('provider.fetchNeedCreds') });
      return;
    }
    setFetchingModels(true);
    setFetchMsg(null);
    try {
      // Use LOCAL form state — autoSave's 500ms debounce means the store may
      // still hold the previous baseUrl/key while the user is editing.
      const models = await bridge.listProviderModels(baseUrl, apiFormat, apiKey, proxyUrl || undefined);
      useProviderStore.getState().setAvailableModels(provider.id, models);
      setFetchMsg({ ok: true, text: t('provider.fetchedModels', { count: String(models.length) }) });
    } catch (e) {
      setFetchMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setFetchingModels(false);
    }
  }, [baseUrl, apiFormat, apiKey, proxyUrl, fetchingModels, provider.id, t]);

  // Auto-trigger test when opened via card test button
  const autoTestDone = useRef(false);
  useEffect(() => {
    if (autoTest && !autoTestDone.current) {
      autoTestDone.current = true;
      handleTestConnection();
    }
  }, [autoTest, handleTestConnection]);

  return (
    <div className="p-4 rounded-lg border border-border-subtle bg-bg-secondary/50 space-y-3 ml-5">
      {/* Form header */}
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-medium text-text-primary">{t('provider.editProvider')}</h4>
        <div className="flex items-center gap-1">
          <button onClick={onDelete}
            className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 transition-smooth">
            {t('provider.deleteProvider')}
          </button>
          <button onClick={onClose}
            className="px-2 py-1 rounded text-xs text-text-tertiary hover:text-text-muted transition-smooth">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Test Connection — at the top */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <button
            onClick={handleTestConnection}
            disabled={!baseUrl || testStatus === 'testing'}
            className={`px-3 py-2 rounded-lg text-[13px] font-medium transition-smooth
              border border-border-subtle
              ${testStatus === 'success'
                ? 'bg-green-500/10 text-green-500 border-green-500/30'
                : testStatus === 'failed' || testStatus === 'auth_error'
                  ? 'bg-red-500/10 text-red-500 border-red-500/30'
                  : 'text-text-muted hover:bg-bg-secondary'
              }
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {testStatus === 'testing' ? (
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 border-[1.5px] border-accent/30
                  border-t-accent rounded-full animate-spin" />
                {t('provider.testing')}
              </span>
            ) : (
              t('provider.testConnection')
            )}
          </button>
          {testTimeMs != null && testStatus !== 'testing' && (
            <span className="text-xs text-text-tertiary">{testTimeMs}ms</span>
          )}
        </div>
        {testResult && (
          <div className="space-y-0.5 text-xs">
            {([
              { key: 'connectivity' as const, label: t('provider.testConnectivity') },
              { key: 'auth' as const, label: t('provider.testAuth') },
              { key: 'model' as const, label: t('provider.testModel') },
            ]).map(({ key, label }) => {
              const step = testResult[key];
              const isSkipped = step.message === 'Skipped';
              return (
                <div key={key} className="flex items-center gap-1.5">
                  {step.ok ? (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
                      stroke="rgb(34 197 94)" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 8l4 4 6-7" />
                    </svg>
                  ) : isSkipped ? (
                    <span className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
                      stroke="rgb(239 68 68)" strokeWidth="2" strokeLinecap="round">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  )}
                  <span className={step.ok ? 'text-green-500' : isSkipped ? 'text-text-tertiary' : 'text-red-400'}>
                    {label}
                  </span>
                  {!step.ok && !isSkipped && (
                    <span className="text-red-400/70 truncate flex-1" title={step.message}>
                      — {step.message}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Name */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.providerName')}</label>
        <input className={INPUT_CLASS} value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder={t('provider.providerNamePlaceholder')} />
      </div>

      {/* Base URL */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.baseUrl')}</label>
        <input className={INPUT_CLASS} value={baseUrl}
          onChange={(e) => handleBaseUrlChange(e.target.value)}
          placeholder={t('provider.baseUrlPlaceholder')} />
      </div>

      {/* API Format — hidden from UI, defaults to anthropic.
          Existing providers with 'openai' format still work via stored config. */}

      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.format')}</label>
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border-subtle bg-bg-chat p-1">
          {(['openai', 'anthropic'] as const).map((format) => (
            <button
              key={format}
              onClick={() => handleApiFormatChange(format)}
              className={`px-2 py-1.5 rounded-md text-xs font-medium transition-smooth
                ${apiFormat === format
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                }`}
            >
              {format === 'openai' ? t('provider.formatOpenaiShort') : t('provider.formatAnthropicShort')}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-tertiary mt-1">{t('provider.formatHint')}</p>
      </div>

      {/* CLI Backend */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.cliBackend')}</label>
        {/* T05: three first-class backends — claude / codex / deepseek (DSH). */}
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-border-subtle bg-bg-chat p-1">
          {(['claude', 'codex', 'deepseek'] as const).map((backend) => (
            <button
              key={backend}
              onClick={() => { if (cliBackend !== backend) setConfirmTarget(backend); }}
              className={`px-2 py-1.5 rounded-md text-xs font-medium transition-smooth
                ${cliBackend === backend
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                }`}
            >
              {backend === 'codex'
                ? t('provider.cliBackendCodex')
                : backend === 'deepseek'
                  ? t('provider.cliBackendDeepseek')
                  : t('provider.cliBackendClaude')}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-tertiary mt-1">{t('provider.cliBackendHint')}</p>
      </div>

      {/* CLI Backend switch confirm dialog */}
      <ConfirmDialog
        open={confirmTarget !== null}
        title={t('provider.cliBackendSwitchTitle')}
        message={t('provider.cliBackendSwitchMessage', {
          source: backendDisplayName(cliBackend),
          target: confirmTarget ? backendDisplayName(confirmTarget) : '',
        })}
        detail={t('provider.cliBackendSwitchDetail', {
          targetLabel: confirmTarget ? backendDisplayName(confirmTarget) : '',
        })}
        confirmLabel={t('provider.cliBackendSwitchBtn')}
        variant="default"
        onConfirm={() => {
          if (confirmTarget) handleCliBackendChange(confirmTarget);
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
      />

      {/* API Key */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-text-muted">{t('provider.apiKey')}</label>
          {provider.preset && (() => {
            const keyUrl = PROVIDER_PRESETS.find(p => p.id === provider.preset)?.keyUrl;
            return keyUrl ? (
              <button onClick={() => openUrl(keyUrl)}
                className="text-xs text-accent hover:underline">
                {t('provider.getApiKey')}
              </button>
            ) : null;
          })()}
        </div>
        <div className="flex gap-1.5">
          <input
            className={`${INPUT_CLASS} flex-1`}
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder={t('provider.apiKeyPlaceholder')}
          />
          <button onClick={() => setShowKey(!showKey)}
            className="px-2 py-1.5 rounded-lg border border-border-subtle
              text-text-muted hover:bg-bg-secondary transition-smooth flex items-center justify-center">
            {showKey ? <EyeClosedIcon /> : <EyeOpenIcon />}
          </button>
        </div>
        {decryptFailed && (
          <p className="text-xs text-red-400 mt-1">{t('provider.apiKeyDecryptFailed')}</p>
        )}
        {/* T05: DSH backend credentials guidance — the key is synced into
            dsh's own credential store, never injected into a CLI process. */}
        {cliBackend === 'deepseek' && (
          <p className="text-xs text-text-tertiary mt-1">{t('provider.deepseekKeyHint')}</p>
        )}
      </div>

      {/* Proxy URL */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.proxyUrl')}</label>
        <input className={INPUT_CLASS} value={proxyUrl}
          onChange={(e) => handleProxyUrlChange(e.target.value)}
          placeholder={t('provider.proxyUrlPlaceholder')} />
        <p className="text-xs text-text-tertiary mt-1">{t('provider.proxyUrlHint')}</p>
      </div>

      {/* Model Mappings */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-text-muted">{t('provider.modelMappings')}</label>
          <button
            onClick={handleFetchModels}
            disabled={!baseUrl || !apiKey || fetchingModels}
            className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80
              transition-smooth disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {fetchingModels && (
              <span className="w-2.5 h-2.5 border-[1.5px] border-accent/30 border-t-accent rounded-full animate-spin" />
            )}
            {fetchingModels ? t('provider.fetchingModels') : t('provider.fetchModels')}
          </button>
        </div>
        {fetchMsg && (
          <p className={`text-xs mb-1.5 truncate ${fetchMsg.ok ? 'text-green-500' : 'text-red-400'}`}
            title={fetchMsg.text}>
            {fetchMsg.text}
          </p>
        )}
        <p className="text-xs text-text-tertiary mb-1.5">{t('provider.modelMappingsHint')}</p>
        <div className="space-y-1.5">
          {/* Merged default model: editable input + dropdown of fetched models.
              Writes opus/sonnet/haiku tiers to the same value; manual entry
              always works when nothing is fetched or nothing matches. */}
          <div ref={comboRef} className="relative">
            <div className="flex gap-1.5">
              <input className={`${INPUT_CLASS} flex-1 font-mono`}
                value={modelDraft ?? getDefaultModel()}
                onChange={(e) => { setModelDraft(e.target.value); updateAllTiers(e.target.value); setModelListOpen(true); }}
                onFocus={() => setModelListOpen(true)}
                placeholder={t('provider.defaultModelPlaceholder')} />
              <button onClick={() => {
                  const next = !modelListOpen;
                  setModelListOpen(next);
                  if (!next) setModelDraft(null);
                }}
                title={t('provider.defaultModel')}
                className="px-2 py-1.5 rounded-lg border border-border-subtle text-text-muted
                  hover:bg-bg-secondary transition-smooth flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                  className={`transition-transform duration-150 ${modelListOpen ? 'rotate-180' : ''}`}>
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
            </div>
            {modelListOpen && (() => {
              const models = provider.availableModels || [];
              // Filter only on what the user typed; opening via focus/chevron
              // shows the full list (draft === null).
              const query = modelDraft === null ? '' : modelDraft.trim().toLowerCase();
              const filtered = query ? models.filter((m) => m.toLowerCase().includes(query)) : models;
              return (
                <div className="absolute left-0 right-0 top-full mt-1 z-50
                  bg-bg-card border border-border-subtle rounded-xl shadow-lg py-1
                  animate-in fade-in slide-in-from-top-1 duration-150">
                  {filtered.length > 0 ? (
                    <div className="max-h-48 overflow-y-auto">
                      {filtered.map((model) => (
                        <button key={model}
                          onClick={() => { updateAllTiers(model); setModelDraft(null); setModelListOpen(false); }}
                          className={`w-full text-left px-3 py-2 text-xs font-mono
                            transition-smooth flex items-center justify-between
                            ${model === getDefaultModel()
                              ? 'text-accent bg-accent/5'
                              : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                            }`}>
                          <span className="truncate">{model}</span>
                          {model === getDefaultModel() && (
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                              className="shrink-0 ml-2">
                              <path d="M3 8l3.5 3.5L13 5" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : models.length === 0 ? (
                    <button onClick={handleFetchModels}
                      disabled={!baseUrl || !apiKey || fetchingModels}
                      className="w-full text-left px-3 py-2 text-xs text-accent
                        hover:bg-bg-secondary transition-smooth
                        disabled:opacity-40 disabled:cursor-not-allowed">
                      {fetchingModels ? t('provider.fetchingModels') : t('provider.modelListEmpty')}
                    </button>
                  ) : (
                    <div className="px-3 py-2 text-xs text-text-tertiary">
                      {t('provider.modelListNoMatch')}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
          {extraMappings.map((m, i) => (
            <div key={`extra-${i}`} className="flex items-center gap-1.5">
              <input className="flex-1 min-w-0 px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
                value={m.providerModel}
                onChange={(e) => updateExtraModel(m.tier, e.target.value)}
                placeholder={t('provider.extraModelPlaceholder')} />
              <button onClick={() => removeExtraMapping(m.tier)}
                className="text-text-tertiary hover:text-text-primary transition-smooth shrink-0 p-0.5">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          ))}
          <button onClick={addExtraMapping}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-muted transition-smooth mt-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t('provider.addModelMapping')}
          </button>
        </div>
      </div>

      {/* Extra Env */}
      <div>
        <label className="text-xs text-text-muted mb-1 block">{t('provider.extraEnv')}</label>
        <p className="text-xs text-text-tertiary mb-1.5">{t('provider.extraEnvHint')}</p>
        <div className="space-y-1">
          {Object.entries(extraEnv).map(([key, value]) => (
            <div key={key} className="flex items-center gap-1">
              <input className={`${INPUT_CLASS} w-[140px] shrink-0`}
                value={key}
                onChange={(e) => {
                  const newEnv = { ...extraEnv };
                  delete newEnv[key];
                  newEnv[e.target.value] = value;
                  setExtraEnv(newEnv);
                  autoSave({ extra_env: newEnv });
                }}
                placeholder="KEY" />
              <span className="text-xs text-text-tertiary">=</span>
              <input className={`${INPUT_CLASS} flex-1`}
                value={value}
                onChange={(e) => handleExtraEnvChange(key, e.target.value)}
                placeholder={t('provider.extraEnvValuePlaceholder')} />
              <button onClick={() => handleExtraEnvRemove(key)}
                className="p-1 text-text-tertiary hover:text-red-400 transition-smooth">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M2 2l6 6M8 2l-6 6" />
                </svg>
              </button>
            </div>
          ))}
          <button onClick={handleExtraEnvAdd}
            className="text-xs text-accent hover:text-accent/80 transition-smooth">
            + {t('provider.addEnvVar')}
          </button>
        </div>
      </div>
    </div>
  );
}
