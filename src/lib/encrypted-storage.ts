/**
 * S3: localStorage API key encryption helpers.
 *
 * API key fields are encrypted via Rust (AES-256-GCM) before being persisted
 * in localStorage through Zustand's persist middleware. The encryption key
 * lives in the Rust backend's safe_data_dir/providers.key and never enters
 * localStorage or JavaScript memory in plaintext.
 *
 * How it works:
 * - Each API key field has a companion `_enc_` field that holds the encrypted value.
 * - The setter methods encrypt asynchronously (side-effect after synchronous set).
 * - `partialize` persists the `_enc_` fields, not the plaintext ones.
 * - `onRehydrateStorage` decrypts `_enc_` back into plaintext on app startup.
 */

import { bridge } from './tauri-bridge';

const ENC_PREFIX = 'TENC1:';

function isEncrypted(val: unknown): val is string {
  return typeof val === 'string' && val.startsWith(ENC_PREFIX);
}

/**
 * Decrypt all encrypted API key fields in the given state object.
 * Returns a partial state with decrypted plaintext values.
 */
export async function decryptStoredApiKeys(
  state: Record<string, unknown>,
): Promise<Record<string, string>> {
  const updates: Record<string, string> = {};
  // Check each plaintext API key field — if its companion _enc_ field exists
  // with an encrypted value, decrypt it.
  const pairs: [string, string][] = [
    ['interviewMimoApiKey', '_enc_interviewMimoApiKey'],
  ];

  for (const [plainField, encField] of pairs) {
    const encVal = state[encField];
    if (isEncrypted(encVal)) {
      try {
        updates[plainField] = await bridge.decryptValue(encVal);
      } catch (e) {
        // Keep the ciphertext (never blank it — a later persist would destroy
        // the only copy). Leave the plaintext unset so the UI shows empty and
        // the user re-enters the key.
        console.error(
          `[encrypted-storage] Failed to decrypt ${encField} — ciphertext preserved, user must re-enter the key:`,
          e,
        );
      }
    }
  }
  return updates;
}

/**
 * Encrypt a value via Rust backend. Side-effect only — does not modify state.
 */
export async function encryptApiKey(key: string): Promise<string> {
  if (!key) return '';
  return await bridge.encryptValue(key);
}
