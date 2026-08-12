import { useState, useRef, useEffect, useMemo, useCallback, Fragment } from 'react';
import { useSettingsStore, MODEL_OPTIONS } from '../../stores/settingsStore';
import { useChatStore, generateMessageId } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useProviderStore } from '../../stores/providerStore';
import { displayProviderModelName, normalizeProviderModelName } from '../../lib/model-utils';
import { useT } from '../../lib/i18n';

/** Tier mapping from official ModelId to provider tier key */
const TIER_MAP: Record<string, 'opus' | 'sonnet' | 'haiku'> = {
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
};

const FIXED_TIERS = new Set(['opus', 'sonnet', 'haiku']);

interface DisplayOption {
  id: string;
  label: string;
  short: string;
  mapped: boolean;
  isExtra: boolean;
  /** True for raw fetched provider models (selecting writes a direct mapping). */
  isProvider?: boolean;
}

export function ModelSelector({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const cliBackend = useSettingsStore((s) => s.cliBackend) || 'claude';
  const activeProvider = useProviderStore((s) => {
    const id = s.activeProviderPerBackend[cliBackend] ?? null;
    if (!id) return null;
    return s.providers.find((p) => p.id === id) ?? null;
  });
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Build display options: official Claude models + extra models from provider.
  // Deduplicate: if multiple Claude models map to the same provider model, keep only the first.
  const displayOptions = useMemo((): DisplayOption[] => {
    if (!activeProvider || activeProvider.modelMappings.length === 0) {
      return MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label, short: m.short, mapped: false, isExtra: false }));
    }

    // Official models with tier mapping.
    // When multiple Claude models map to the same provider model (e.g. Opus and Opus 1M
    // both map to "mimo-v2-pro"), keep both entries with their original labels so the user
    // can still distinguish them — the 1M variant uses a higher context window (#139 port).
    const official = MODEL_OPTIONS.map((m) => {
      const tier = TIER_MAP[m.id];
      const mapping = activeProvider.modelMappings.find((mm) => mm.tier === tier);
      if (mapping?.providerModel) {
        const providerModel = normalizeProviderModelName(mapping.providerModel);
        const providerLabel = displayProviderModelName(providerModel);
        const label = providerLabel === m.short ? m.short : `${m.short} -> ${providerLabel}`;
        return { id: m.id, label, short: providerLabel, mapped: true, isExtra: false };
      }
      return { id: m.id, label: m.label, short: m.short, mapped: false, isExtra: false };
    });

    // Extra models (non-tier mappings added by user)
    const extras: DisplayOption[] = activeProvider.modelMappings
      .filter((m) => !FIXED_TIERS.has(m.tier) && m.tier && m.providerModel)
      .map((m) => {
        const providerModel = normalizeProviderModelName(m.providerModel);
        const providerLabel = displayProviderModelName(providerModel);
        const short = providerLabel.includes('/')
          ? providerLabel.split('/').pop()!
          : providerLabel;
        return { id: m.tier, label: providerLabel, short, mapped: true, isExtra: true };
      });

    return [...official, ...extras];
  }, [activeProvider]);

  // Fetched provider models not covered by any mapping yet — a direct-pick
  // group. Selecting one writes a direct mapping (tier === model ID).
  const providerOptions = useMemo((): DisplayOption[] => {
    if (!activeProvider?.availableModels?.length) return [];
    const covered = new Set(
      activeProvider.modelMappings
        .map((m) => normalizeProviderModelName(m.providerModel))
        .filter(Boolean),
    );
    const officialIds = new Set<string>(MODEL_OPTIONS.map((m) => m.id));
    return activeProvider.availableModels
      .map((id) => normalizeProviderModelName(id))
      // Skip IDs already covered by a mapping, and IDs that collide with
      // official Claude models — those are selectable via the official entries
      // (tier mapping); duplicating them here would render two rows with the
      // same React key.
      .filter((id) => id && !covered.has(id) && !officialIds.has(id))
      .map((id) => ({
        id,
        label: id,
        short: id.includes('/') ? id.split('/').pop()! : id,
        mapped: true,
        isExtra: true,
        isProvider: true,
      }));
  }, [activeProvider]);

  const handleRefreshModels = useCallback(async () => {
    if (!activeProvider || refreshing) return;
    setRefreshing(true);
    try {
      await useProviderStore.getState().fetchModels(activeProvider.id);
    } finally {
      setRefreshing(false);
    }
  }, [activeProvider, refreshing]);

  const fallbackOption = displayOptions.find((option) => option.mapped) || displayOptions[0];

  const providersLoaded = useProviderStore((s) => s.loaded);
  useEffect(() => {
    // Defer validation until provider config has loaded — load() is async IPC,
    // so the first render sees an empty provider and an official-only list,
    // which would otherwise reset a valid provider-model selection on every start.
    if (!providersLoaded) return;
    if (!fallbackOption) return;
    if (!displayOptions.some((option) => option.id === selectedModel)) {
      setSelectedModel(fallbackOption.id);
    }
  }, [providersLoaded, displayOptions, fallbackOption, selectedModel, setSelectedModel]);

  const current = displayOptions.find((m) => m.id === selectedModel) || fallbackOption;

  const renderOption = (option: DisplayOption) => (
    <button
      key={option.id}
      onClick={() => {
        if (option.id !== selectedModel) {
          const oldShort = current.short;
          const newShort = option.short;
          if (option.isProvider && activeProvider) {
            // Picking a raw fetched model writes a direct mapping (tier === model ID)
            // so resolveModelOrError keeps resolving it on the next spawn.
            const mappings = activeProvider.modelMappings.some((m) => m.tier === option.id)
              ? activeProvider.modelMappings.map((m) =>
                  m.tier === option.id ? { ...m, providerModel: option.id } : m)
              : [...activeProvider.modelMappings, { tier: option.id, providerModel: option.id }];
            useProviderStore.getState().updateProvider(activeProvider.id, { modelMappings: mappings });
          }
          setSelectedModel(option.id);
          // Insert model-switch tag into chat immediately
          const msTabId = useSessionStore.getState().selectedSessionId;
          if (msTabId) {
            useChatStore.getState().addMessage(msTabId, {
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: `${oldShort} → ${newShort}`,
              commandType: 'model-switch',
              timestamp: Date.now(),
            });
          }
        }
        setOpen(false);
      }}
      className={`w-full text-left px-3 py-2 text-xs
        transition-smooth flex items-center justify-between
        ${option.id === selectedModel
          ? 'text-accent bg-accent/5'
          : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
        }`}
    >
      <div className="min-w-0">
        <div className={`font-medium truncate ${option.mapped ? 'font-mono' : ''}`}>{option.label}</div>
      </div>
      {option.id === selectedModel && (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 ml-2">
          <path d="M3 8l3.5 3.5L13 5" />
        </svg>
      )}
    </button>
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg
          text-xs text-text-muted hover:text-text-primary
          hover:bg-bg-secondary transition-smooth
          disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3l2 1.5" strokeLinecap="round" />
        </svg>
        {current.short}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-56
          bg-bg-card border border-border-subtle rounded-xl shadow-lg
          py-1 z-50 animate-in fade-in slide-in-from-bottom-1 duration-150">
          {displayOptions.map((option, index) => (
            <Fragment key={option.id}>
              {option.isExtra && index > 0 && !displayOptions[index - 1].isExtra && (
                <div className="border-t border-border-subtle my-1" />
              )}
              {renderOption(option)}
            </Fragment>
          ))}
          {providerOptions.length > 0 && (
            <>
              <div className="border-t border-border-subtle my-1" />
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
                  {t('modelSelector.providerModels')}
                </span>
                <button
                  onClick={handleRefreshModels}
                  title={activeProvider?.modelsFetchedAt
                    ? new Date(activeProvider.modelsFetchedAt).toLocaleString()
                    : t('modelSelector.refreshModels')}
                  aria-label={t('modelSelector.refreshModels')}
                  className="p-0.5 rounded text-text-tertiary hover:text-text-primary transition-smooth"
                >
                  {refreshing ? (
                    <span className="block w-2.5 h-2.5 border-[1.5px] border-accent/30 border-t-accent rounded-full animate-spin" />
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
                      <path d="M13.5 1.5v3h-3" />
                    </svg>
                  )}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {providerOptions.map(renderOption)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
