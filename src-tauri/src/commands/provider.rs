use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Data types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelMapping {
    pub(crate) tier: String,
    pub(crate) provider_model: String,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiProvider {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) api_format: String,
    pub(crate) api_key: Option<String>,
    pub(crate) model_mappings: Vec<ModelMapping>,
    pub(crate) extra_env: Option<HashMap<String, String>>,
    pub(crate) proxy_url: Option<String>,
    pub(crate) preset: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    /// Which CLI backend this provider uses: "claude" (default) or "codex".
    #[serde(default)]
    pub(crate) cli_backend: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvidersFile {
    #[serde(default = "default_version")]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) active_provider_id: Option<String>, // deprecated -- kept for v1→v2 migration
    #[serde(default)]
    pub(crate) active_provider_per_backend: HashMap<String, Option<String>>, // {"claude": "id1", "codex": "id2"}
    pub(crate) providers: Vec<ApiProvider>,
}

fn default_version() -> u32 {
    2
}

impl Default for ProvidersFile {
    fn default() -> Self {
        Self {
            version: 2,
            active_provider_id: None,
            active_provider_per_backend: HashMap::new(),
            providers: vec![],
        }
    }
}

fn providers_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::safe_data_dir()?.join("providers.json"))
}

// ── Provider credential encryption (TK-303) ────────────────────────
// The master key lives in safe_data_dir()/providers.key -- the SAME user-home
// directory as providers.json. That directory SURVIVES app updates (the NSIS
// installer and the Tauri updater only replace the binary, never the home data
// dir), so the key is always present after an update and decryption can never
// fail due to an update. Cross-device sync is preserved: load/save encrypt and
// decrypt transparently, while export/import operate on the in-memory plaintext
// provider (so the exported JSON stays portable across machines).

pub(crate) const ENC_MAGIC: &str = "TENC1:";
const PROVIDER_KEY_FILE: &str = "providers.key";
const MASTER_KEY_LEN: usize = 32;

#[cfg(unix)]
fn harden_path_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn harden_path_permissions(_path: &std::path::Path) {}

fn provider_key_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::safe_data_dir()?.join(PROVIDER_KEY_FILE))
}

// ── Master key persistence (Windows: DPAPI-protected) ────────────────
// Windows layout of providers.key:
//   [legacy]          raw 32-byte plaintext key (pre-DPAPI versions)
//   [0x01][DPAPI]     version byte + DPAPI blob (CryptProtectData, current
//                     user scope, no entropy, CRYPTPROTECT_UI_FORBIDDEN)
// The version byte prevents a DPAPI ciphertext from ever being misread as a
// plaintext key (a random 32-byte key whose first byte happens to be 0x01
// could otherwise be misdetected -- the length+unprotect checks disambiguate).
// Legacy plaintext files are read as-is and immediately re-written in the
// DPAPI format (best-effort; a failed re-write only logs and retries on the
// next load, the in-memory key stays valid).
const KEY_FORMAT_DPAPI: u8 = 0x01;

#[cfg(windows)]
/// Protect `data` with DPAPI bound to the current user account.
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };
    use windows::core::PCWSTR;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        // No entropy → protection is tied to the current Windows user.
        // CRYPTPROTECT_UI_FORBIDDEN → never show a password prompt.
        CryptProtectData(
            &in_blob,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("DPAPI 加密失败: {}", e))?;
    }
    let out = unsafe {
        std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
    };
    // CryptProtectData allocates the output via LocalAlloc.
    unsafe {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        let _ = LocalFree(HLOCAL(out_blob.pbData as *mut std::ffi::c_void));
    }
    Ok(out)
}

#[cfg(windows)]
/// Reverse of `dpapi_protect`: decrypt a DPAPI blob for the current user.
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&in_blob, None, None, None, None, 0, &mut out_blob)
            .map_err(|e| format!("DPAPI 解密失败（密钥可能来自其他用户账户或已损坏）: {}", e))?;
    }
    let out = unsafe {
        std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
    };
    unsafe {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        let _ = LocalFree(HLOCAL(out_blob.pbData as *mut std::ffi::c_void));
    }
    Ok(out)
}

#[cfg(windows)]
fn write_master_key(path: &std::path::Path, key: &[u8; MASTER_KEY_LEN]) -> Result<(), String> {
    let blob = dpapi_protect(key)?;
    let mut data = Vec::with_capacity(1 + blob.len());
    data.push(KEY_FORMAT_DPAPI);
    data.extend_from_slice(&blob);
    std::fs::write(path, &data).map_err(|e| format!("写入密钥失败: {}", e))?;
    harden_path_permissions(path);
    Ok(())
}

/// Load the persistent master key, generating and persisting it on first use.
/// Windows: stored DPAPI-encrypted; legacy plaintext files are migrated in
/// place. Other platforms: plaintext file (unchanged behavior).
#[cfg(windows)]
pub(crate) fn load_or_create_master_key() -> Result<[u8; MASTER_KEY_LEN], String> {
    let path = provider_key_path()?;
    if path.exists() {
        let raw = std::fs::read(&path).map_err(|e| format!("读取密钥失败: {}", e))?;
        if raw.len() == MASTER_KEY_LEN {
            // Legacy plaintext key file (pre-DPAPI). Read it directly, then
            // re-write it in DPAPI-encrypted format. A failed re-write is
            // non-fatal: the key is already usable, and the migration retries
            // on the next load.
            let mut key = [0u8; MASTER_KEY_LEN];
            key.copy_from_slice(&raw);
            if let Err(e) = write_master_key(&path, &key) {
                eprintln!(
                    "[LITTLECLAUDE] providers.key migration to DPAPI failed (will retry): {}",
                    e
                );
            }
            return Ok(key);
        }
        if raw.len() > 1 && raw[0] == KEY_FORMAT_DPAPI {
            let key = dpapi_unprotect(&raw[1..])?;
            if key.len() != MASTER_KEY_LEN {
                return Err("主密钥文件损坏".to_string());
            }
            let mut out = [0u8; MASTER_KEY_LEN];
            out.copy_from_slice(&key);
            return Ok(out);
        }
        return Err("主密钥文件损坏".to_string());
    }
    let mut key = [0u8; MASTER_KEY_LEN];
    rand::thread_rng().fill_bytes(&mut key);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {}", e))?;
    }
    write_master_key(&path, &key)?;
    Ok(key)
}

/// Load the persistent master key, generating and persisting it on first use.
/// (Non-Windows: plaintext file, unchanged.)
#[cfg(not(windows))]
pub(crate) fn load_or_create_master_key() -> Result<[u8; MASTER_KEY_LEN], String> {
    let path = provider_key_path()?;
    if path.exists() {
        let raw = std::fs::read(&path).map_err(|e| format!("读取密钥失败: {}", e))?;
        if raw.len() != MASTER_KEY_LEN {
            return Err("主密钥文件损坏".to_string());
        }
        let mut key = [0u8; MASTER_KEY_LEN];
        key.copy_from_slice(&raw);
        return Ok(key);
    }
    let mut key = [0u8; MASTER_KEY_LEN];
    rand::thread_rng().fill_bytes(&mut key);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {}", e))?;
    }
    std::fs::write(&path, &key).map_err(|e| format!("写入密钥失败: {}", e))?;
    harden_path_permissions(&path);
    Ok(key)
}

#[allow(dead_code)]
pub(crate) fn encrypt_providers(plain: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    let key = load_or_create_master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|e| format!("加密失败: {}", e))?;
    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(format!(
        "{}{}",
        ENC_MAGIC,
        base64::engine::general_purpose::STANDARD.encode(&blob)
    ))
}

pub(crate) fn decrypt_providers(stored: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};
    let Some(b64) = stored.strip_prefix(ENC_MAGIC) else {
        // Legacy plaintext file -- will be re-encrypted on the next save.
        return Ok(stored.to_string());
    };
    let key = load_or_create_master_key()?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("密文解码失败: {}", e))?;
    if blob.len() < 12 {
        return Err("密文长度不足".to_string());
    }
    let (nonce, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|_| "decrypt failed: key mismatch or data tampered".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("无效 UTF-8: {}", e))
}

// ── General-purpose value encryption (S3: localStorage API key safety) ─

/// Encrypt a single value using the per-machine master key.
/// Returns the encrypted string (prefixed with ENC_MAGIC) or an empty string
/// for empty input.
#[tauri::command]
pub fn encrypt_value(value: String) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    // S3 (hardening): 输入上限 —— 该命令面向 API key/短密文，8KB 远超合法用途
    const MAX_VALUE_LEN: usize = 8 * 1024;
    if value.len() > MAX_VALUE_LEN {
        return Err(format!(
            "encrypt_value: payload too large ({} bytes, max {})",
            value.len(),
            MAX_VALUE_LEN
        ));
    }
    encrypt_providers(&value)
}

/// Decrypt a value previously encrypted with `encrypt_value`.
/// Returns the plaintext string.  Passing an empty string returns an empty
/// string.  Strings not prefixed with ENC_MAGIC are treated as legacy
/// plaintext and returned as-is.
#[tauri::command]
pub fn decrypt_value(encrypted: String) -> Result<String, String> {
    if encrypted.is_empty() {
        return Ok(String::new());
    }
    // S3 (hardening): 通用解密 oracle 无法一步移除（设置页回显依赖它），
    // 先做两道收敛：输入大小上限 + 每次调用审计日志，异常批量调用可追溯。
    const MAX_VALUE_LEN: usize = 8 * 1024;
    if encrypted.len() > MAX_VALUE_LEN {
        return Err(format!(
            "decrypt_value: payload too large ({} bytes, max {})",
            encrypted.len(),
            MAX_VALUE_LEN
        ));
    }
    eprintln!(
        "[LITTLECLAUDE:security] decrypt_value invoked ({} bytes{})",
        encrypted.len(),
        if encrypted.starts_with(ENC_MAGIC) { ", TENC1" } else { ", passthrough" }
    );
    decrypt_providers(&encrypted)
}

// ── In-memory provider cache (portable EXE: no disk writes) ─────────

use std::sync::Mutex;

static PROVIDER_CACHE: Mutex<Option<ProvidersFile>> = Mutex::new(None);

/// Push provider config from the frontend into an in-memory cache.
/// The frontend stores providers in localStorage and calls this on every
/// mutation so the Rust backend can resolve env vars without reading disk.
#[tauri::command]
pub fn sync_providers(data: ProvidersFile) -> Result<(), String> {
    if let Ok(mut cache) = PROVIDER_CACHE.lock() {
        *cache = Some(data);
    }
    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn load_providers() -> Result<ProvidersFile, String> {
    // Check in-memory cache first (populated by sync_providers from frontend)
    if let Ok(cache) = PROVIDER_CACHE.lock() {
        if let Some(ref data) = *cache {
            return Ok(data.clone());
        }
    }
    let path = providers_path()?;
    if !path.exists() {
        return Ok(ProvidersFile::default());
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read providers: {}", e))?;
    let json = decrypt_providers(&raw)?;
    let mut data: ProvidersFile =
        serde_json::from_str(&json).map_err(|e| format!("Cannot parse providers: {}", e))?;

    // Migrate v1 -- v2: move active_provider_id into active_provider_per_backend["claude"]
    if data.version < 2 {
        if let Some(pid) = data.active_provider_id.take() {
            data.active_provider_per_backend
                .entry("claude".to_string())
                .or_insert(Some(pid));
        }
        data.version = 2;
    }

    Ok(data)
}

// save_providers removed — providers are now stored in localStorage
// and synced to the Rust in-memory cache via sync_providers command.
// The encrypt_providers / decrypt_providers / load_or_create_master_key
// helpers are kept for backward-compat one-time disk migration on first load.

// ── Connection test ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub connectivity: StepResult,
    pub auth: StepResult,
    pub model: StepResult,
}

/// Normalize a base URL for injection as `ANTHROPIC_BASE_URL`.
///
/// The Claude CLI's Anthropic SDK appends `/v1/messages` to whatever base URL
/// it receives — it does NOT detect an existing `/v1` suffix. If the user
/// enters a base URL that already ends in `/v1` (e.g. `https://opencode.ai/zen/go/v1`),
/// the SDK would call `.../v1/v1/messages` → 404 → "model not found".
///
/// Strip a trailing `/v1/messages` or `/v1` so the SDK reconstructs the
/// canonical single-`/v1` endpoint. Only applies to anthropic-format providers
/// (the messages endpoint shape); openai-format base URLs are used as-is by
/// the conversion proxy.
pub(crate) fn normalize_anthropic_base_url(base_url: &str, api_format: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if !api_format.eq_ignore_ascii_case("anthropic") {
        return trimmed.to_string();
    }
    let lower = trimmed.to_lowercase();
    if let Some(stem) = strip_suffix_ci(trimmed, "/v1/messages") {
        return stem.to_string();
    }
    if lower.ends_with("/v1") {
        return trimmed[..trimmed.len() - 3].to_string();
    }
    trimmed.to_string()
}

pub(crate) fn provider_messages_endpoint(base_url: &str, api_format: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let lower = base.to_lowercase();
    if api_format.eq_ignore_ascii_case("openai") {
        if lower.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{}/chat/completions", base)
        }
    } else if lower.ends_with("/v1/messages") {
        base.to_string()
    } else if lower.ends_with("/v1") {
        format!("{}/messages", base)
    } else {
        format!("{}/v1/messages", base)
    }
}

/// Build an HTTP client for provider API calls, honoring the provider's
/// configured proxy when reachable and falling back to smart proxy detection.
async fn build_provider_http_client(proxy_url: Option<&str>) -> reqwest::Client {
    if let Some(purl) = proxy_url {
        if !purl.is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(purl) {
                if crate::is_proxy_reachable(purl).await {
                    eprintln!("provider http: using provider proxy {}", purl);
                    return reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .timeout(std::time::Duration::from_secs(30))
                        .no_proxy()
                        .proxy(proxy)
                        .build()
                        .unwrap_or_default();
                }
                eprintln!("provider http: provider proxy {} unreachable, direct", purl);
            }
        }
    }
    crate::build_smart_http_client(std::time::Duration::from_secs(10), std::time::Duration::from_secs(30))
        .await
}

#[tauri::command]
pub async fn test_provider_connection(
    base_url: String,
    api_format: String,
    api_key: String,
    model: String,
    proxy_url: Option<String>,
) -> Result<ConnectionTestResult, String> {
    // If provider has a proxy configured, build a client that uses it.
    // Otherwise fall back to the smart proxy detection.
    let client = build_provider_http_client(proxy_url.as_deref()).await;

    let skipped = StepResult {
        ok: false,
        message: "Skipped".to_string(),
    };

    // Step 1: Connectivity -- HEAD request to base URL without auth
    let connectivity_url = provider_messages_endpoint(&base_url, &api_format);
    let conn_result = client
        .head(&connectivity_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    let connectivity = match conn_result {
        Ok(_resp) => StepResult {
            ok: true,
            message: "Reachable".to_string(),
        },
        Err(e) => {
            return Ok(ConnectionTestResult {
                connectivity: StepResult {
                    ok: false,
                    message: format!("Unreachable: {}", e),
                },
                auth: skipped.clone(),
                model: skipped,
            });
        }
    };

    // Steps 2+3: Auth + Model -- single request with the REAL model name.
    // Previously used a dummy "test-auth-probe" model for auth, then the real model
    // for model validation. But some providers (e.g. MiMo) tie model access to API
    // key permissions and return 403 for unknown models, causing false auth failures.
    // Now we send one request and derive both auth and model status from it.
    let test_body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "hi"}]
    });
    let mut test_req = client
        .post(&connectivity_url)
        .header("Content-Type", "application/json")
        .json(&test_body)
        .timeout(std::time::Duration::from_secs(15));
    if api_format == "openai" {
        test_req = test_req.header("Authorization", format!("Bearer {}", api_key));
    } else {
        test_req = test_req
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01");
    }
    let test_resp = test_req.send().await;
    let (auth, model_step) = match test_resp {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == 401 {
                // Definitely auth failure
                let text = resp.text().await.unwrap_or_default();
            // M3: some upstreams echo the Authorization header/key back in
            // error bodies — strip key material before it reaches the UI.
            let text = crate::commands::anthropic_proxy::redact_secrets(&text);
                (
                    StepResult {
                        ok: false,
                        message: format!(
                            "HTTP {} -- {}",
                            status,
                            text.chars().take(200).collect::<String>()
                        ),
                    },
                    skipped,
                )
            } else if status == 403 {
                // 403 is ambiguous: could be auth failure OR model access restriction.
                // Read body to disambiguate.
                let text = resp.text().await.unwrap_or_default();
            // M3: some upstreams echo the Authorization header/key back in
            // error bodies — strip key material before it reaches the UI.
            let text = crate::commands::anthropic_proxy::redact_secrets(&text);
                let text_lower = text.to_lowercase();
                let is_auth_error = text_lower.contains("invalid")
                    && (text_lower.contains("api key")
                        || text_lower.contains("api_key")
                        || text_lower.contains("token")
                        || text_lower.contains("credentials"));
                if is_auth_error {
                    (
                        StepResult {
                            ok: false,
                            message: format!(
                                "HTTP 403 -- {}",
                                text.chars().take(200).collect::<String>()
                            ),
                        },
                        skipped,
                    )
                } else {
                    // 403 but not clearly auth -- treat as auth OK + model issue
                    (
                        StepResult {
                            ok: true,
                            message: "Authenticated (HTTP 403 -- access restricted)".to_string(),
                        },
                        StepResult {
                            ok: false,
                            message: format!(
                                "HTTP 403 -- {}",
                                text.chars().take(200).collect::<String>()
                            ),
                        },
                    )
                }
            } else if status >= 200 && status < 300 {
                (
                    StepResult {
                        ok: true,
                        message: format!("Authenticated (HTTP {})", status),
                    },
                    StepResult {
                        ok: true,
                        message: format!("Model OK (HTTP {})", status),
                    },
                )
            } else {
                // 400, 404, 429, 500, etc. -- auth is OK (server processed the request)
                let text = resp.text().await.unwrap_or_default();
            // M3: some upstreams echo the Authorization header/key back in
            // error bodies — strip key material before it reaches the UI.
            let text = crate::commands::anthropic_proxy::redact_secrets(&text);
                let text_lower = text.to_lowercase();
                let is_model_error = (status == 404)
                    || (text_lower.contains("model")
                        && (text_lower.contains("not found")
                            || text_lower.contains("not_found")
                            || text_lower.contains("does not exist")
                            || text_lower.contains("invalid model")
                            || text_lower.contains("invalid_model")));
                let model_result = if is_model_error {
                    StepResult {
                        ok: false,
                        message: format!(
                            "HTTP {} -- {}",
                            status,
                            text.chars().take(200).collect::<String>()
                        ),
                    }
                } else {
                    StepResult {
                        ok: true,
                        message: format!("Model accepted (HTTP {})", status),
                    }
                };
                (
                    StepResult {
                        ok: true,
                        message: format!("Authenticated (HTTP {})", status),
                    },
                    model_result,
                )
            }
        }
        Err(e) => (
            StepResult {
                ok: false,
                message: format!("Request failed: {}", e),
            },
            skipped,
        ),
    };

    Ok(ConnectionTestResult {
        connectivity,
        auth,
        model: model_step,
    })
}

// ── Model listing ───────────────────────────────────────────────────

/// Derive the models-listing endpoint from a provider base URL.
pub(crate) fn provider_models_endpoint(base_url: &str, api_format: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let lower = base.to_lowercase();
    if lower.ends_with("/models") {
        return base.to_string();
    }
    if api_format.eq_ignore_ascii_case("openai") {
        // .../v1 or .../v1/chat/completions → sibling /models
        if let Some(stem) = strip_suffix_ci(base, "/chat/completions") {
            return format!("{}/models", stem.trim_end_matches('/'));
        }
        return format!("{}/models", base);
    }
    // anthropic: .../v1/messages → .../v1/models; .../v1 → .../v1/models
    if let Some(stem) = strip_suffix_ci(base, "/messages") {
        return format!("{}/models", stem.trim_end_matches('/'));
    }
    if lower.ends_with("/v1") {
        return format!("{}/models", base);
    }
    format!("{}/v1/models", base)
}

fn strip_suffix_ci<'a>(s: &'a str, suffix: &str) -> Option<&'a str> {
    // ASCII-only case folding: suffixes are ASCII literals. The tail slice
    // must start on a char boundary — if it doesn't, the tail contains a
    // multi-byte char (so it can't be an ASCII suffix), and slicing would
    // panic on a mid-char index. `is_char_boundary` guards both cases.
    if s.len() >= suffix.len() {
        let start = s.len() - suffix.len();
        if s.is_char_boundary(start) && s[start..].eq_ignore_ascii_case(suffix) {
            return Some(&s[..start]);
        }
    }
    None
}

/// GET one models page and extract `data[].id` (a shape shared by the
/// OpenAI and Anthropic listing APIs). Dedupes preserving order, caps at 500.
async fn fetch_models_page(
    client: &reqwest::Client,
    url: &str,
    api_format: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let mut req = client.get(url).timeout(std::time::Duration::from_secs(15));
    if api_format.eq_ignore_ascii_case("openai") {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    } else {
        req = req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    }
    let resp = req.send().await.map_err(|e| format!("{} -- {}", url, e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!(
            "HTTP {} -- {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid JSON: {}", e))?;
    let mut seen = std::collections::HashSet::new();
    let mut models: Vec<String> = Vec::new();
    if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                let id = id.trim();
                if !id.is_empty() && seen.insert(id.to_string()) {
                    models.push(id.to_string());
                    if models.len() >= 500 {
                        break;
                    }
                }
            }
        }
    }
    if models.is_empty() {
        return Err("No models in response".to_string());
    }
    Ok(models)
}

/// Irregular gateways where the OpenAI-compatible sibling path cannot be
/// derived by stripping the trailing "/anthropic" segment. Aliyun Bailian
/// serves the Anthropic gate under /apps/anthropic but the model list under
/// /compatible-mode/v1 — different path prefixes, so it needs a host rule.
fn vendor_models_endpoint(base_url: &str) -> Option<String> {
    let lower = base_url.trim().trim_end_matches('/').to_lowercase();
    let (scheme, rest) = lower.split_once("://")?;
    let host = rest.split('/').next()?;
    if host == "dashscope.aliyuncs.com" || host == "dashscope-intl.aliyuncs.com" {
        return Some(format!("{scheme}://{host}/compatible-mode/v1/models"));
    }
    None
}

/// List models available at a provider endpoint. Tries the format-native
/// models endpoint first; on 404 falls back to OpenAI-compatible candidates:
/// the sibling path derived by stripping a trailing /anthropic segment
/// (DeepSeek-style gates), then host-specific rules for irregular gateways
/// (Aliyun Bailian). The UI keeps manual input as the fallback when all fail.
#[tauri::command]
pub async fn list_provider_models(
    base_url: String,
    api_format: String,
    api_key: String,
    proxy_url: Option<String>,
) -> Result<Vec<String>, String> {
    let client = build_provider_http_client(proxy_url.as_deref()).await;
    let primary_url = provider_models_endpoint(&base_url, &api_format);
    match fetch_models_page(&client, &primary_url, &api_format, &api_key).await {
        Ok(models) => Ok(models),
        Err(primary_err) => {
            // Only walk the fallback chain on a real 404 (the "endpoint shape
            // unknown" signature); network or auth failures would just
            // multiply the wait.
            if !primary_err.starts_with("HTTP 404") {
                return Err(primary_err);
            }
            let mut candidates: Vec<String> = Vec::new();
            if api_format.eq_ignore_ascii_case("anthropic") {
                let base = base_url.trim().trim_end_matches('/');
                if let Some(stem) = strip_suffix_ci(base, "/anthropic") {
                    candidates.push(format!("{}/v1/models", stem.trim_end_matches('/')));
                }
            }
            if let Some(vendor_url) = vendor_models_endpoint(&base_url) {
                candidates.push(vendor_url);
            }
            for url in candidates {
                if url == primary_url {
                    continue;
                }
                if let Ok(models) = fetch_models_page(&client, &url, "openai", &api_key).await {
                    return Ok(models);
                }
            }
            Err(primary_err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_endpoint_openai_shapes() {
        assert_eq!(
            provider_models_endpoint("https://api.openai.com/v1", "openai"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            provider_models_endpoint("https://api.openai.com/v1/chat/completions", "openai"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            provider_models_endpoint("https://x.com/v1/models", "openai"),
            "https://x.com/v1/models"
        );
    }

    #[test]
    fn models_endpoint_anthropic_shapes() {
        assert_eq!(
            provider_models_endpoint("https://api.anthropic.com", "anthropic"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            provider_models_endpoint("https://api.deepseek.com/anthropic", "anthropic"),
            "https://api.deepseek.com/anthropic/v1/models"
        );
        assert_eq!(
            provider_models_endpoint("https://x.com/v1/messages", "anthropic"),
            "https://x.com/v1/models"
        );
        assert_eq!(
            provider_models_endpoint("https://x.com/v1", "anthropic"),
            "https://x.com/v1/models"
        );
    }

    #[test]
    fn vendor_models_endpoint_known_hosts() {
        assert_eq!(
            vendor_models_endpoint("https://dashscope.aliyuncs.com/apps/anthropic"),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1/models".to_string())
        );
        assert_eq!(
            vendor_models_endpoint("https://dashscope-intl.aliyuncs.com/apps/anthropic/"),
            Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models".to_string())
        );
        assert_eq!(vendor_models_endpoint("https://api.deepseek.com/anthropic"), None);
    }

    #[test]
    fn strip_suffix_ci_cases() {
        assert_eq!(
            strip_suffix_ci("https://a.com/Anthropic", "/anthropic"),
            Some("https://a.com")
        );
        assert_eq!(strip_suffix_ci("https://a.com/v1", "/anthropic"), None);
        // Non-ASCII input whose tail slice would start on a mid-char boundary
        // used to panic ("byte index is not a char boundary") — must be None.
        assert_eq!(strip_suffix_ci("https://x/接口接口c", "/messages"), None);
        assert_eq!(strip_suffix_ci("https://x/接口/messages", "/messages"), Some("https://x/接口"));
        // Shorter-than-suffix input never panics.
        assert_eq!(strip_suffix_ci("接口", "/messages"), None);
    }

    #[test]
    fn normalize_anthropic_base_url_strips_v1_suffix() {
        // The CLI SDK appends /v1/messages itself; a trailing /v1 would produce
        // .../v1/v1/messages → 404 → "model not found".
        assert_eq!(
            normalize_anthropic_base_url("https://opencode.ai/zen/go/v1", "anthropic"),
            "https://opencode.ai/zen/go"
        );
        assert_eq!(
            normalize_anthropic_base_url("https://opencode.ai/zen/go/v1/messages", "anthropic"),
            "https://opencode.ai/zen/go"
        );
        assert_eq!(
            normalize_anthropic_base_url("https://opencode.ai/zen/go", "anthropic"),
            "https://opencode.ai/zen/go"
        );
        // DeepSeek-style gate (no /v1) is untouched.
        assert_eq!(
            normalize_anthropic_base_url("https://api.deepseek.com/anthropic", "anthropic"),
            "https://api.deepseek.com/anthropic"
        );
        // OpenAI-format base URLs are passed through untouched (proxy handles them).
        assert_eq!(
            normalize_anthropic_base_url("https://opencode.ai/zen/go/v1", "openai"),
            "https://opencode.ai/zen/go/v1"
        );
        // Trailing slash is trimmed before the check.
        assert_eq!(
            normalize_anthropic_base_url("https://opencode.ai/zen/go/v1/", "anthropic"),
            "https://opencode.ai/zen/go"
        );
    }
}
