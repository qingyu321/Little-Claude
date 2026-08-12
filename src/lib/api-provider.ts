import { useProviderStore } from '../stores/providerStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
  normalizeProviderModelName,
} from './model-utils';

const TIER_MAP: Record<string, 'opus' | 'sonnet' | 'haiku'> = {
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
};

/**
 * Result of model resolution — either a mapped model name or an error.
 */
export type ModelResolution =
  | { ok: true; model: string }
  | { ok: false; reason: 'no_mapping'; tier: string; providerName: string };

/**
 * Resolve the UI-selected model ID to the provider's actual model name,
 * returning an error if the provider has no mapping for the selected tier.
 */
export function resolveModelOrError(selectedModel: string): ModelResolution {
  const cliBackend = useSettingsStore.getState().cliBackend || 'claude';
  const provider = useProviderStore.getState().getActiveProviderForBackend(cliBackend);
  if (!provider) {
    // No provider configured (inherit mode): pass the Claude model ID directly.
    // The CLI knows how to map Claude model IDs to the actual API model names.
    return { ok: true, model: selectedModel };
  }

  // 1. Check direct model ID mapping first (e.g. 'claude-opus-4-6-1m' → 'glm-5-1m')
  const directMapping = provider.modelMappings.find(
    (m) => m.tier === selectedModel && m.providerModel,
  );
  if (directMapping?.providerModel) {
    const resolved = normalizeProviderModelName(directMapping.providerModel);
    console.debug('[LITTLECLAUDE:api-provider] direct mapping:', selectedModel, '→', resolved);
    return { ok: true, model: resolved };
  }

  // 2. Fall back to tier mapping
  const tier = TIER_MAP[selectedModel];
  if (!tier) {
    const fallback = provider.modelMappings.find(
      (m) => m.tier === 'sonnet' && m.providerModel,
    ) || provider.modelMappings.find(
      (m) => m.tier === 'haiku' && m.providerModel,
    ) || provider.modelMappings.find(
      (m) => m.tier === 'opus' && m.providerModel,
    ) || provider.modelMappings.find((m) => m.providerModel);

    if (fallback?.providerModel) {
      const resolved = normalizeProviderModelName(fallback.providerModel);
      console.debug('[LITTLECLAUDE:api-provider] fallback mapping (no tier match):', selectedModel, '→', resolved, '(via', fallback.tier, ')');
      return { ok: true, model: resolved };
    }

    console.debug('[LITTLECLAUDE:api-provider] no mapping for:', selectedModel, '| provider:', provider.name);
    return { ok: false, reason: 'no_mapping', tier: selectedModel, providerName: provider.name };
  }

  const mapping = provider.modelMappings.find(
    (m) => m.tier === tier && m.providerModel,
  );
  if (!mapping?.providerModel) {
    return { ok: false, reason: 'no_mapping', tier, providerName: provider.name };
  }
  return { ok: true, model: normalizeProviderModelName(mapping.providerModel) };
}

/**
 * Resolve the UI-selected model ID to the provider's actual model name.
 * When a provider is active, looks up the model mapping for the selected tier.
 * Returns the original model ID if no mapping is configured (silent fallback).
 * (The CLI_MODEL_MAP that appended '[1m]' to 'claude-opus-4-6-1m' was removed
 * with that dead model ID — the [1m] suffix is now supplied directly through
 * provider modelMappings.)
 */
export function resolveModelForProvider(selectedModel: string): string {
  const r = resolveModelOrError(selectedModel);
  return r.ok ? r.model : selectedModel;
}

export function supportsDeepSeekThinking(model: string): boolean {
  // Deliberately tolerant (substring on the compacted ID): dated snapshots
  // like deepseek-v4-flash-0125 inherit the family's thinking support, even
  // though normalize* now keeps them distinct from the base model IDs.
  const compact = model.toLowerCase().replace(/[\s_.()[\]-]/g, '');
  return compact.includes('deepseekv4pro') || compact.includes('deepseekv4flash');
}

export function resolveThinkingLevelForProvider(selectedModel: string, requestedLevel: string): string {
  if (requestedLevel === 'off') return 'off';
  const resolvedModel = resolveModelForProvider(selectedModel);
  return supportsDeepSeekThinking(resolvedModel) ? requestedLevel : 'off';
}

/**
 * Stable fingerprint of the current API provider config.
 * Any provider config change invalidates the pre-warmed session.
 */
export function envFingerprint(): string {
  const { activeProviderPerBackend, providers } = useProviderStore.getState();
  const settingsCliBackend = useSettingsStore.getState().cliBackend || 'claude';

  // Collect updatedAt from all per-backend providers to detect changes across backends
  const backendTimestamps: Record<string, number> = {};
  for (const [backend, providerId] of Object.entries(activeProviderPerBackend)) {
    if (providerId) {
      const p = providers.find((pr) => pr.id === providerId);
      backendTimestamps[backend] = p?.updatedAt ?? 0;
    }
  }

  return JSON.stringify({
    activeProviderPerBackend,
    backendTimestamps,
    cliBackend: settingsCliBackend,
  });
}
