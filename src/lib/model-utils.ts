export const DEEPSEEK_V4_PRO = 'deepseek-v4-pro';
export const DEEPSEEK_V4_FLASH = 'deepseek-v4-flash';

export function normalizeDeepSeekModelName(model: string | undefined | null): string {
  if (!model) return '';

  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  const compact = lower.replace(/[\s_.()[\]-]/g, '');

  // Exact compacted match only — substring matching would collapse distinct
  // dated snapshots (e.g. deepseek-v4-flash-0125) into the base model ID.
  if (compact === 'deepseekv4pro') return DEEPSEEK_V4_PRO;
  if (compact === 'deepseekv4flash') return DEEPSEEK_V4_FLASH;

  return trimmed;
}

export function normalizeProviderModelName(model: string | undefined | null): string {
  if (!model) return '';

  const trimmed = model.trim();
  const compact = trimmed.toLowerCase().replace(/[\s_.()[\]-]/g, '');

  // Exact compacted match only — substring matching would collapse distinct
  // dated snapshots (e.g. deepseek-v4-flash-0125) into the base model ID.
  if (compact === 'deepseekv4pro') return DEEPSEEK_V4_PRO;
  if (compact === 'deepseekv4flash') return DEEPSEEK_V4_FLASH;

  return trimmed;
}

/**
 * Display name for a model ID. Used to render "DeepseekV4Pro"-style brand
 * labels, which read as meaningless jargon next to generic tier names — now
 * a pass-through that shows the canonical model ID (deepseek-v4-flash).
 * Kept as a function so callers stay stable if display logic returns.
 */
export function displayDeepSeekModelName(model: string | undefined | null): string {
  return normalizeDeepSeekModelName(model);
}

export function displayProviderModelName(model: string | undefined | null): string {
  return normalizeProviderModelName(model);
}
