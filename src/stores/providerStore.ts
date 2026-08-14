import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';
import { normalizeProviderModelName } from '../lib/model-utils';
import { debugLog } from '../lib/debug-log';

const PROVIDERS_STORAGE_KEY = 'tokenicode_providers';

export interface ModelMapping {
  /** Standard tier ('opus'|'sonnet'|'haiku') or a specific model ID for direct mapping */
  tier: string;
  providerModel: string;
}


export interface ApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: 'anthropic' | 'openai';
  apiKey?: string;
  modelMappings: ModelMapping[];
  extra_env?: Record<string, string>;
  proxyUrl?: string;
  preset?: string;
  createdAt: number;
  updatedAt: number;
  /** Which CLI backend this provider uses: "claude" (default) or "codex". */
  cliBackend?: 'claude' | 'codex';
  /** Model IDs returned by the last successful "fetch models" call (UI cache). */
  availableModels?: string[];
  /** When availableModels was last fetched (shown as a tooltip in the model selector). */
  modelsFetchedAt?: number;
}

interface ProviderState {
  providers: ApiProvider[];
  /** @deprecated Use activeProviderPerBackend + getActiveIdForBackend(). Kept for backward-compat selectors. */
  activeProviderId: string | null;
  /** Per-backend active provider IDs. {"claude": "id1", "codex": "id2"} */
  activeProviderPerBackend: Record<string, string | null>;
  loaded: boolean;
  /** Providers whose TENC1: ciphertext failed to decrypt on load — maps
   *  provider id → preserved ciphertext. The key is kept (never blanked) so
   *  a later save can't destroy the only copy; the user must re-enter it. */
  decryptFailures: Record<string, string>;

  load: () => Promise<void>;
  save: () => Promise<void>;
  addProvider: (p: Omit<ApiProvider, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateProvider: (id: string, patch: Partial<ApiProvider>) => void;
  deleteProvider: (id: string) => void;
  /** Set active provider for a specific backend (defaults to "claude"). */
  setActive: (id: string | null, backend?: string) => void;
  /** Get the active provider ID for a specific backend. */
  getActiveIdForBackend: (backend: string) => string | null;
  /** Get the active provider object for a specific backend. */
  getActiveProviderForBackend: (backend: string) => ApiProvider | null;
  /** @deprecated Use getActiveProviderForBackend("claude"). Returns the Claude backend's active provider. */
  getActive: () => ApiProvider | null;
  /** Cache a fetched model list. Deliberately does NOT bump updatedAt so the
   *  env fingerprint (and CLI prewarm) is not invalidated by a UI-only refresh. */
  setAvailableModels: (id: string, models: string[]) => void;
  /** Fetch models from this provider's endpoint and cache them via setAvailableModels. */
  fetchModels: (id: string) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

let _saveTimer: ReturnType<typeof setTimeout> | undefined;

function debouncedSave(state: ProviderState) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    state.save().catch((e) => console.error('[providerStore] save failed:', e));
  }, 500);
}

function loadFromLocalStorage(): ProviderState | null {
  try {
    const raw = localStorage.getItem(PROVIDERS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** S3: Decrypt TENC1:-prefixed API keys in the loaded state. */
async function decryptProviderKeys(state: ProviderState): Promise<ProviderState> {
  state.decryptFailures = {};
  for (const p of state.providers) {
    if (p.apiKey && p.apiKey.startsWith('TENC1:')) {
      try {
        p.apiKey = await bridge.decryptValue(p.apiKey);
      } catch (e) {
        // Keep the ciphertext (never blank it — a later save would persist the
        // empty value and destroy the only copy). Record the failure so the UI
        // can tell the user to re-enter the key.
        console.error(
          `[providerStore] Failed to decrypt apiKey for ${p.id} — ciphertext preserved, user must re-enter the key:`,
          e,
        );
        state.decryptFailures[p.id] = p.apiKey;
      }
    }
  }
  return state;
}

async function saveToLocalStorage(state: ProviderState) {
  try {
    // S3: Clone providers and encrypt API keys before storage
    // 报告B8: strip the bulky model cache first — it lives under its own key.
    const providers = await Promise.all(
      state.providers.map(stripModelCache).map(async (p) => {
        const cloned = { ...p };
        if (cloned.apiKey && cloned.apiKey.length > 0 && !cloned.apiKey.startsWith('TENC1:')) {
          try {
            cloned.apiKey = await bridge.encryptValue(cloned.apiKey);
          } catch (e) {
            // Never persist a plaintext API key. Drop the key from the stored
            // copy only (the in-memory provider keeps it); the user re-enters
            // it on next launch. Much safer than plaintext at rest.
            console.error(
              `[providerStore] Failed to encrypt apiKey for ${p.id} — key NOT persisted to localStorage:`,
              e,
            );
            cloned.apiKey = '';
          }
        }
        return cloned;
      }),
    );
    localStorage.setItem(
      PROVIDERS_STORAGE_KEY,
      JSON.stringify({
        providers,
        activeProviderId: state.activeProviderId,
        activeProviderPerBackend: state.activeProviderPerBackend,
      }),
    );
  } catch (e) {
    console.error('[providerStore] localStorage save failed:', e);
  }
}

/** Push current provider config to Rust backend so it can resolve env vars
 *  when spawning Claude CLI without reading providers.json from disk. */
async function syncToRust(state: ProviderState) {
  try {
    await bridge.syncProviders({
      version: 2,
      activeProviderId: state.activeProviderId,
      activeProviderPerBackend: state.activeProviderPerBackend,
      providers: state.providers.map(stripModelCache).map(normalizeProvider),
    });
  } catch (e) {
    console.error('[providerStore] syncToRust failed:', e);
  }
}

function normalizeProvider(p: ApiProvider): ApiProvider {
  return {
    ...p,
    modelMappings: p.modelMappings.map((m) => ({
      ...m,
      providerModel: normalizeProviderModelName(m.providerModel),
    })),
  };
}

// 报告B8: availableModels/modelsFetchedAt are bulky, rebuildable cache data
// (up to ~500 model IDs ≈ 50-200KB). They used to be serialized on EVERY save
// — the provider form triggers saveToLocalStorage + syncToRust on every
// keystroke, blocking the main thread on JSON.stringify and pushing the whole
// list over IPC to Rust (whose ApiProvider has no such field — the list was
// silently dropped there). The model list now lives under its own storage key,
// written only when fetchModels completes, and merged back on load.
const MODELS_CACHE_KEY = 'tokenicode_provider_models_v1';

type ModelCacheEntry = { models: string[]; fetchedAt: number };

function stripModelCache(p: ApiProvider): Omit<ApiProvider, 'availableModels' | 'modelsFetchedAt'> {
  const { availableModels, modelsFetchedAt, ...rest } = p;
  return rest;
}

function loadModelCache(): Record<string, ModelCacheEntry> | null {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveModelCache(cache: Record<string, ModelCacheEntry>) {
  try {
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.error('[providerStore] model cache save failed:', e);
  }
}

function restoreModelCache(providers: ApiProvider[]): ApiProvider[] {
  const cache = loadModelCache() ?? {};
  let dirty = false;
  const restored = providers.map((p) => {
    if (cache[p.id]) {
      return { ...p, availableModels: cache[p.id].models, modelsFetchedAt: cache[p.id].fetchedAt };
    }
    if (p.availableModels?.length && p.modelsFetchedAt) {
      // 报告B8 复查: inline models from a pre-B8 blob would otherwise be
      // merged into memory only — restore is read-only, the next save strips
      // them, and the models are lost on restart. Write them to the
      // standalone key once so the upgrade migration is durable.
      cache[p.id] = { models: p.availableModels, fetchedAt: p.modelsFetchedAt };
      dirty = true;
    }
    return p;
  });
  if (dirty) saveModelCache(cache);
  return restored;
}

export const useProviderStore = create<ProviderState>()((set, get) => ({
  providers: [],
  activeProviderId: null,
  activeProviderPerBackend: {},
  loaded: false,
  decryptFailures: {},

  load: async () => {
    try {
      // 1) Load from localStorage (portable EXE, no disk writes).
      // An explicit empty `[]` is the authoritative empty state — skipping it
      // would fall through to the disk migration and resurrect deleted
      // providers. Only a missing key (null) should trigger migration.
      const cached = loadFromLocalStorage();
      if (cached && Array.isArray(cached.providers)) {
        await decryptProviderKeys(cached);
        set({
          providers: restoreModelCache(cached.providers.map(normalizeProvider)),
          activeProviderId: cached.activeProviderId ?? null,
          activeProviderPerBackend: cached.activeProviderPerBackend ?? {},
          decryptFailures: cached.decryptFailures ?? {},
          loaded: true,
        });
        syncToRust(get());
        return;
      }

      // 2) First launch / empty cache: try one-time disk migration
      try {
        const data = await bridge.loadProviders();
        let perBackend: Record<string, string | null> = { ...data.activeProviderPerBackend };
        if (Object.keys(perBackend).length === 0 && data.activeProviderId) {
          perBackend = { claude: data.activeProviderId };
        }
        if (!perBackend.claude && data.activeProviderId) {
          perBackend.claude = data.activeProviderId;
        }
        if (data.providers.length === 0) {
          const migrated = migrateFromSettingsStore();
          if (migrated) {
            data.providers = [normalizeProvider(migrated)];
            perBackend.claude = migrated.id;
            debugLog('provider', 'Migrated old API settings to provider:', migrated.name);
          }
        }
        const providers = restoreModelCache((data.providers as ApiProvider[]).map((p) => {
          if (!p.cliBackend) return normalizeProvider({ ...p, cliBackend: 'claude' });
          return normalizeProvider(p);
        }));
        set({
          providers,
          activeProviderId: perBackend.claude ?? null,
          activeProviderPerBackend: perBackend,
          loaded: true,
        });
        // Save migrated data to localStorage + sync to Rust
        await saveToLocalStorage(get());
        syncToRust(get());
        return;
      } catch {
        // Disk migration failed — try settingsStore migration directly
      }

      // 3) Fallback: migrate from legacy settingsStore
      const migrated = migrateFromSettingsStore();
      if (migrated) {
        const p = normalizeProvider(migrated);
        set({
          providers: [p],
          activeProviderId: p.id,
          activeProviderPerBackend: { claude: p.id },
          loaded: true,
        });
        await saveToLocalStorage(get());
        syncToRust(get());
        debugLog('provider', 'Migrated from settingsStore:', p.name);
        return;
      }

      set({ loaded: true });
    } catch (e) {
      console.error('[providerStore] load failed:', e);
      set({ loaded: true });
    }
  },

  save: async () => {
    await saveToLocalStorage(get());
    syncToRust(get());
  },

  addProvider: (p) => {
    const now = Date.now();
    const newProvider: ApiProvider = {
      ...p,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ providers: [...s.providers, normalizeProvider(newProvider)] }));
    debouncedSave(get());
  },

  updateProvider: (id, patch) => {
    set((s) => {
      const next = {
        providers: s.providers.map((p) =>
          p.id === id ? normalizeProvider({ ...p, ...patch, updatedAt: Date.now() }) : p,
        ),
      };
      // A user-typed key replaces the undecryptable ciphertext — clear the flag.
      if (patch.apiKey) {
        const failures = { ...s.decryptFailures };
        delete failures[id];
        (next as { decryptFailures?: Record<string, string> }).decryptFailures = failures;
      }
      return next;
    });
    debouncedSave(get());
  },

  setAvailableModels: (id, models) => {
    set((s) => ({
      providers: s.providers.map((p) =>
        p.id === id ? { ...p, availableModels: models, modelsFetchedAt: Date.now() } : p,
      ),
    }));
    // 报告B8: persist the (large, rarely-changing) model list under its own
    // key — not through the hot save path that runs on every keystroke.
    const cache = loadModelCache() ?? {};
    cache[id] = { models, fetchedAt: Date.now() };
    saveModelCache(cache);
    debouncedSave(get());
  },

  fetchModels: async (id) => {
    const provider = get().providers.find((p) => p.id === id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    if (!provider.baseUrl || !provider.apiKey) {
      return { ok: false, error: 'Base URL and API key are required' };
    }
    try {
      const models = await bridge.listProviderModels(
        provider.baseUrl,
        provider.apiFormat,
        provider.apiKey,
        provider.proxyUrl || undefined,
      );
      get().setAvailableModels(id, models);
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  deleteProvider: (id) => {
    set((s) => {
      // Clean up this provider from all backend entries
      const newPerBackend = { ...s.activeProviderPerBackend };
      let changed = false;
      for (const [backend, backendId] of Object.entries(newPerBackend)) {
        if (backendId === id) {
          newPerBackend[backend] = null;
          changed = true;
        }
      }

      return {
        providers: s.providers.filter((p) => p.id !== id),
        activeProviderId: s.activeProviderId === id ? null : s.activeProviderId,
        activeProviderPerBackend: changed ? newPerBackend : s.activeProviderPerBackend,
      };
    });
    // 报告B8: drop the deleted provider's model cache entry too.
    const cache = loadModelCache();
    if (cache && cache[id]) {
      delete cache[id];
      saveModelCache(cache);
    }
    debouncedSave(get());
  },

  setActive: (id, backend = 'claude') => {
    set((s) => ({
      activeProviderPerBackend: {
        ...s.activeProviderPerBackend,
        [backend]: id,
      },
      // Keep backward-compat activeProviderId synced to claude backend
      ...(backend === 'claude'
        ? { activeProviderId: id }
        : {}),
    }));
    debouncedSave(get());
  },

  getActiveIdForBackend: (backend) => {
    const { activeProviderPerBackend } = get();
    return activeProviderPerBackend[backend] ?? null;
  },

  getActiveProviderForBackend: (backend) => {
    const { providers, activeProviderPerBackend } = get();
    const id = activeProviderPerBackend[backend] ?? null;
    if (!id) return null;
    return providers.find((p) => p.id === id) ?? null;
  },

  getActive: () => {
    const { providers, activeProviderId } = get();
    if (!activeProviderId) return null;
    return providers.find((p) => p.id === activeProviderId) ?? null;
  },
}));

/**
 * Migrate from old settingsStore API fields to a new ApiProvider.
 * Returns null if no old config exists or mode is 'inherit'.
 */
function migrateFromSettingsStore(): ApiProvider | null {
  try {
    // Read old settings from localStorage (settingsStore persists there)
    const raw = localStorage.getItem('tokenicode-settings');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const state = parsed?.state;
    if (!state) return null;

    const mode = state.apiProviderMode;
    if (!mode || mode === 'inherit') return null;

    const now = Date.now();
    const provider: ApiProvider = {
      id: generateId(),
      name: state.customProviderName || (mode === 'official' ? 'Anthropic (官方)' : 'Custom'),
      baseUrl: mode === 'official' ? 'https://api.anthropic.com' : (state.customProviderBaseUrl || ''),
      apiFormat: (state.customProviderApiFormat || 'anthropic') as 'anthropic' | 'openai',
      modelMappings: Array.isArray(state.customProviderModelMappings)
        ? state.customProviderModelMappings.map((m: { tier: string; providerModel: string }) => ({
            tier: m.tier as 'opus' | 'sonnet' | 'haiku',
            providerModel: m.providerModel,
          }))
        : [],
      createdAt: now,
      updatedAt: now,
    };

    return provider;
  } catch {
    return null;
  }
}
