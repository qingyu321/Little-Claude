/**
 * S7: skill translation API key encryption.
 *
 * The translation config (baseUrl / apiKey / model) is persisted in
 * localStorage. The apiKey field is encrypted via Rust (AES-256-GCM,
 * "TENC1:" prefix) before being written, and decrypted on read. Legacy
 * plaintext keys (no "TENC1:" prefix) are returned as-is and get
 * encrypted on the next save, so existing data migrates transparently.
 */

import { bridge, type SkillTranslationConfig } from './tauri-bridge';
import { encryptApiKey } from './encrypted-storage';

const TRANSLATION_CONFIG_KEY = 'tokenicode-skill-translation-config-v1';

const DEFAULT_TRANSLATION_CONFIG: SkillTranslationConfig = {
  baseUrl: '',
  apiFormat: 'anthropic',
  apiKey: '',
  model: 'deepseek-v4-flash',
  proxyUrl: '',
};

const ENC_PREFIX = 'TENC1:';

export function isEncryptedApiKey(apiKey: string): boolean {
  return apiKey.startsWith(ENC_PREFIX);
}

/**
 * Synchronously load the raw config. The apiKey may still be an encrypted
 * "TENC1:" blob — useState initializers and other sync call sites need this
 * variant; use `loadSkillTranslationConfigAsync` where awaiting is possible.
 */
export function loadSkillTranslationConfig(): SkillTranslationConfig {
  try {
    const raw = localStorage.getItem(TRANSLATION_CONFIG_KEY);
    if (!raw) return DEFAULT_TRANSLATION_CONFIG;
    return { ...DEFAULT_TRANSLATION_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_TRANSLATION_CONFIG;
  }
}

/**
 * Load the config and decrypt the apiKey. Legacy plaintext keys are returned
 * as-is; encrypted keys are decrypted via the Rust backend. A failed
 * decryption clears the key so the user can re-enter it.
 */
export async function loadSkillTranslationConfigAsync(): Promise<SkillTranslationConfig> {
  const config = loadSkillTranslationConfig();
  if (!isEncryptedApiKey(config.apiKey)) return config;
  try {
    const plain = await bridge.decryptValue(config.apiKey);
    return { ...config, apiKey: plain };
  } catch (e) {
    console.warn('[skill-translation-storage] Failed to decrypt apiKey, clearing:', e);
    return { ...config, apiKey: '' };
  }
}

/**
 * Persist the config with the apiKey encrypted. Already-encrypted keys are
 * stored as-is (re-encrypting would corrupt the value); empty keys stay empty.
 */
export async function saveSkillTranslationConfig(config: SkillTranslationConfig): Promise<void> {
  const apiKey = isEncryptedApiKey(config.apiKey)
    ? config.apiKey
    : await encryptApiKey(config.apiKey);
  const toStore = { ...config, apiKey };
  try {
    localStorage.setItem(TRANSLATION_CONFIG_KEY, JSON.stringify(toStore));
  } catch {
    // Config persistence is best-effort.
  }
}
