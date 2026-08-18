import { useProviderStore, type ApiProvider } from '../stores/providerStore';
import { normalizeProviderModelName } from './model-utils';

/**
 * Canonical JSON format for API provider config import/export (v2).
 * Supports both new multi-provider format and legacy v1 single-provider format.
 */
export interface ApiConfigFileV2 {
  version: 2;
  provider: {
    name: string;
    baseUrl: string;
    apiFormat: string;
    apiKey?: string;
    modelMappings: { tier: string; model: string }[];
    extra_env?: Record<string, string>;
    /** Which CLI backend this provider uses: "claude" (default), "codex", or
     *  "deepseek" (T05: DSH service mode). */
    cliBackend?: 'claude' | 'codex' | 'deepseek';
  };
  /** S8: warning marker on exports that embed a plaintext API key. */
  _warning?: string;
}

// Legacy v1 format (version: 1) is also accepted by parseAndValidate for backward compatibility.
// V1 has the same shape as V2 minus extra_env.


/**
 * Build an exportable JSON string from a provider.
 */
export function exportProvider(provider: ApiProvider): string {
  const config: ApiConfigFileV2 = {
    version: 2,
    provider: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      modelMappings: provider.modelMappings
        .filter((m) => m.providerModel)
        .map((m) => ({ tier: m.tier, model: normalizeProviderModelName(m.providerModel) })),
      ...(provider.extra_env && Object.keys(provider.extra_env).length > 0
        ? { extra_env: provider.extra_env }
        : {}),
      ...(provider.proxyUrl ? { proxyUrl: provider.proxyUrl } : {}),
      ...(provider.cliBackend && provider.cliBackend !== 'claude'
        ? { cliBackend: provider.cliBackend }
        : {}),
    },
    // S8: explicit warning marker — the export may contain a plaintext API
    // key; parsers ignore unknown fields, so this is metadata only, but it
    // makes "this file has a secret in it" visible to anyone handling it.
    ...(provider.apiKey
      ? { _warning: 'This file contains a plaintext API key. Do not share it.' }
      : {}),
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Parse and validate a raw JSON string as an API config file.
 * Supports both v1 and v2 formats.
 * Returns a normalized ApiProvider-compatible object.
 */
export function parseAndValidate(
  raw: string,
): { ok: true; provider: Omit<ApiProvider, 'id' | 'createdAt' | 'updatedAt'> } | { ok: false; error: string } {
  // Strip UTF-8 BOM (Windows Notepad)
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  text = text.trim();

  if (!text) {
    return { ok: false, error: '文件内容为空' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '文件不是有效的 JSON 格式' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '配置文件格式不正确，应为 JSON 对象' };
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj.version;

  if (version !== 1 && version !== 2) {
    return { ok: false, error: `不支持的配置版本：${version ?? '缺失'}` };
  }

  if (typeof obj.provider !== 'object' || obj.provider === null) {
    return { ok: false, error: '缺少 provider 配置' };
  }
  const p = obj.provider as Record<string, unknown>;

  // baseUrl — allow empty for cloud providers (Bedrock/Vertex)
  let baseUrl = '';
  if (typeof p.baseUrl === 'string' && p.baseUrl.trim()) {
    baseUrl = p.baseUrl.trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      baseUrl = 'https://' + baseUrl;
    }
    baseUrl = baseUrl.replace(/\/+$/, '');
  }

  // apiFormat
  const validFormats = ['anthropic', 'openai'];
  const apiFormat = typeof p.apiFormat === 'string' ? p.apiFormat : 'anthropic';
  if (!validFormats.includes(apiFormat)) {
    return { ok: false, error: `API 格式无效：${apiFormat}，仅支持 anthropic 或 openai` };
  }

  // apiKey — S8: redaction placeholders from exported-but-shared files must
  // never be imported as a real key.
  if (p.apiKey !== undefined && p.apiKey !== null && typeof p.apiKey !== 'string') {
    return { ok: false, error: 'API Key 格式不正确，应为字符串' };
  }
  const apiKey = (() => {
    if (typeof p.apiKey !== 'string') return undefined;
    const trimmed = p.apiKey.trim();
    if (!trimmed) return undefined;
    // Placeholders used by redacted exports (e.g. "***", "REDACTED", "sk-***").
    if (/^[*xX-]+$/.test(trimmed) || trimmed === 'REDACTED' || trimmed.startsWith('***')) {
      return undefined;
    }
    return trimmed;
  })();

  // modelMappings
  let rawMappings: unknown[] = [];
  if (p.modelMappings !== undefined) {
    if (!Array.isArray(p.modelMappings)) {
      return { ok: false, error: 'modelMappings 应为数组' };
    }
    rawMappings = p.modelMappings;
  }

  const validTiers = ['opus', 'sonnet', 'haiku'];
  const mappings: { tier: 'opus' | 'sonnet' | 'haiku'; providerModel: string }[] = [];
  for (const item of rawMappings) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: '模型映射条目格式不正确' };
    }
    const m = item as Record<string, unknown>;
    const tier = String(m.tier ?? '');
    if (!validTiers.includes(tier)) {
      return { ok: false, error: `无效的模型层级：${tier}，仅支持 opus / sonnet / haiku` };
    }
    const model = normalizeProviderModelName(String(m.model ?? m.providerModel ?? ''));
    mappings.push({ tier: tier as 'opus' | 'sonnet' | 'haiku', providerModel: model });
  }

  // extra_env (v2 only)
  let extra_env: Record<string, string> | undefined;
  if (version === 2 && p.extra_env && typeof p.extra_env === 'object') {
    extra_env = p.extra_env as Record<string, string>;
  }

  // proxyUrl (v2 only)
  const proxyUrl = typeof p.proxyUrl === 'string' ? p.proxyUrl.trim() : undefined;

  // cliBackend (v2 export includes it) — T05: accept "deepseek" too so a
  // DSH-backend provider survives an export/import round-trip.
  const cliBackend = (p.cliBackend === 'codex' || p.cliBackend === 'claude' || p.cliBackend === 'deepseek')
    ? p.cliBackend
    : undefined;

  return {
    ok: true,
    provider: {
      name: typeof p.name === 'string' ? p.name : '',
      baseUrl,
      apiFormat: apiFormat as 'anthropic' | 'openai',
      ...(apiKey ? { apiKey } : {}),
      modelMappings: mappings,
      ...(extra_env ? { extra_env } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(cliBackend ? { cliBackend } : {}),
    },
  };
}

/**
 * Import a validated config as a new provider (does NOT auto-activate).
 */
export function importAsProvider(provider: Omit<ApiProvider, 'id' | 'createdAt' | 'updatedAt'>): void {
  const store = useProviderStore.getState();
  store.addProvider(provider);
}
