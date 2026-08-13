//! Model context-window cache — the "declare 1M automatically" data source.
//!
//! The Claude CLI cannot tell us a third-party model's real window (its
//! capability table is gated to first-party Anthropic base URLs — see the
//! session.rs comment), so Little Claude maintains its own table, sourced
//! from LiteLLM's `model_prices_and_context_window.json` (GitHub raw — the
//! models.dev endpoint is unreachable from some networks, GitHub raw is
//! reachable everywhere the CLI itself is used).
//!
//! Cache flow:
//!  1. `.setup()` pre-warms by fetching the table in the background (silent
//!     failure — a fetch error must never break startup or a session spawn).
//!  2. First lookup with a missing/stale (>7d) cache fetches synchronously
//!     inside the async command (the caller already awaits spawn/display).
//!  3. Every lookup reads the local file `~/.tokenicode{,.dev}/model_windows_cache.json`
//!     — a flattened { model-key → max_input_tokens } map (the raw table has
//!     3000+ entries with per-provider pricing we don't need; flattening keeps
//!     the file a few hundred KB and the IPC payload small).
//!
//! Matching semantics (see `lookup_window`): exact match first (the last
//! `/`-segment of a provider-prefixed key equals the model name, or the bare
//! key equals it) — this keeps `deepseek-chat` from picking up the window of
//! `deepseek-chat-v3.1`; substring fallback then takes the MAXIMUM window of
//! all hits (the model's own window is a property of the model; provider
//! overrides like Fireworks' 512K MiniMax-M3 are deployment details we cannot
//! know from a bare model name).

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// LiteLLM's model table — updated continuously, no auth, GitHub raw (see
/// module comment for why not models.dev).
const LITELLM_URL: &str = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/// Refresh the local cache at most weekly.
const CACHE_TTL_SECS: u64 = 7 * 24 * 3600;

fn cache_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(crate::safe_data_dir_name()).join("model_windows_cache.json")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read the flattened cache file. Returns (fetched_at, { model-key → window }).
fn read_cache() -> Option<(u64, HashMap<String, u64>)> {
    let raw = std::fs::read_to_string(cache_path()).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let fetched_at = v.get("fetched_at")?.as_u64()?;
    let mut windows = HashMap::new();
    let Some(map) = v.get("windows").and_then(|w| w.as_object()) else {
        return None;
    };
    for (k, val) in map {
        if let Some(n) = val.as_u64() {
            windows.insert(k.clone(), n);
        }
    }
    Some((fetched_at, windows))
}

fn write_cache(windows: &HashMap<String, u64>) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({ "fetched_at": now_secs(), "windows": windows });
    if let Ok(text) = serde_json::to_string(&payload) {
        let _ = std::fs::write(&path, text);
    }
}

/// Fetch and flatten the LiteLLM table. Silent failure (returns false).
async fn fetch_and_store() -> bool {
    let client = crate::build_smart_http_client(
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(60),
    )
    .await;
    let resp = match client.get(LITELLM_URL).send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[model_windows] fetch failed: {}", e);
            return false;
        }
    };
    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[model_windows] read body failed: {}", e);
            return false;
        }
    };
    let Ok(table) = serde_json::from_slice::<Value>(&body) else {
        eprintln!("[model_windows] parse failed");
        return false;
    };
    let Some(map) = table.as_object() else {
        return false;
    };
    let mut windows = HashMap::new();
    for (_provider, pv) in map {
        let Some(models) = pv.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        for (mid, mv) in models {
            let Some(limit) = mv.get("limit") else { continue };
            if let Some(ctx) = limit.get("context").and_then(|c| c.as_u64()) {
                // Keys are case-mixed in the source table ("MiniMax-M3") —
                // normalize once here so lookups are case-insensitive.
                windows.insert(mid.to_lowercase(), ctx);
            }
        }
    }
    eprintln!("[model_windows] fetched {} model windows", windows.len());
    write_cache(&windows);
    true
}

/// Exact-match helper: does the LiteLLM key represent `model`?
fn key_matches_exact(key: &str, model: &str) -> bool {
    if key == model {
        return true;
    }
    // Provider-prefixed keys: last /-segment is the bare model id.
    key.rsplit('/').next() == Some(model)
}

/// Look up a model's context window from the local cache.
/// Exact match first (bare id or last /-segment); substring fallback takes
/// the maximum window across hits. Stale/missing cache triggers a fetch.
pub(crate) async fn lookup_window(model: &str) -> Option<u64> {
    let m = model.trim().to_lowercase();
    if m.is_empty() {
        return None;
    }
    let (fetched_at, windows) = match read_cache() {
        Some(c) => c,
        None => {
            if !fetch_and_store().await {
                return None;
            }
            read_cache()?
        }
    };
    if now_secs().saturating_sub(fetched_at) > CACHE_TTL_SECS {
        // Stale — refresh opportunistically; keep serving the old table on
        // failure rather than blocking the caller.
        if fetch_and_store().await {
            if let Some((_, fresh)) = read_cache() {
                return resolve_in(&fresh, &m);
            }
        }
    }
    resolve_in(&windows, &m)
}

fn resolve_in(windows: &HashMap<String, u64>, model: &str) -> Option<u64> {
    let m = model.trim().to_lowercase();
    if m.is_empty() {
        return None;
    }
    if let Some(v) = windows.get(&m) {
        return Some(*v);
    }
    let mut best: Option<u64> = None;
    for (key, val) in windows {
        if key_matches_exact(key, &m) {
            return Some(*val);
        }
    }
    for (key, val) in windows {
        if key.contains(&m) {
            best = Some(best.map_or(*val, |b| b.max(*val)));
        }
    }
    best
}

/// Background pre-warm for `.setup()` — never blocks startup, never panics.
///
/// MUST use tauri's async_runtime: `.setup()` runs on the event-loop thread
/// (RuntimeRunEvent::Ready), which has no Tokio thread-local context — a bare
/// `tokio::spawn` panics there ("there is no reactor running") and crashes the
/// app at startup. tauri::async_runtime::spawn enters the runtime first.
pub(crate) fn prewarm() {
    tauri::async_runtime::spawn(async move {
        if let Some((fetched_at, _)) = read_cache() {
            if now_secs().saturating_sub(fetched_at) <= CACHE_TTL_SECS {
                return; // fresh enough — skip the network round trip
            }
        }
        let _ = fetch_and_store().await;
    });
}

/// Tauri command — frontend asks for one model's window (Ctx bar, spawn).
#[tauri::command]
pub async fn get_model_context_window(model: String) -> Option<u64> {
    lookup_window(&model).await
}

/// Tauri command — frontend loads the flattened map once at startup so
/// getContextWindowForModel can resolve synchronously during renders.
#[tauri::command]
pub async fn load_model_windows() -> HashMap<String, u64> {
    match read_cache() {
        Some((_, windows)) => windows,
        None => {
            let _ = fetch_and_store().await;
            read_cache().map(|(_, w)| w).unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> HashMap<String, u64> {
        let mut h = HashMap::new();
        h.insert("deepseek-chat".to_string(), 131_072);
        h.insert("azure_ai/deepseek-v4-flash".to_string(), 1_000_000);
        h.insert("dashscope/qwen3.5-plus".to_string(), 991_808);
        h.insert("openrouter/deepseek/deepseek-chat-v3.1".to_string(), 163_840);
        h.insert("openrouter/qwen/qwen3.5-397b-a17b".to_string(), 262_144);
        h.insert("cloudflare/@cf/zai-org/glm-5.2".to_string(), 262_144);
        h.insert("openrouter/xiaomi/mimo-v2.5-pro".to_string(), 1_048_576);
        h
    }

    #[test]
    fn exact_bare_id_wins_over_substring() {
        // "deepseek-chat" must NOT inherit v3.1's window via substring.
        assert_eq!(resolve_in(&table(), "deepseek-chat"), Some(131_072));
    }

    #[test]
    fn exact_last_segment() {
        assert_eq!(resolve_in(&table(), "deepseek-v4-flash"), Some(1_000_000));
        assert_eq!(resolve_in(&table(), "qwen3.5-plus"), Some(991_808));
        assert_eq!(resolve_in(&table(), "glm-5.2"), Some(262_144));
        assert_eq!(resolve_in(&table(), "mimo-v2.5-pro"), Some(1_048_576));
    }

    #[test]
    fn substring_fallback_takes_max() {
        // "qwen3.5" hits plus (991808) and 397b (262144) → max wins.
        assert_eq!(resolve_in(&table(), "qwen3.5"), Some(991_808));
        // "deepseek-v4" hits the flash row only in this fixture.
        assert_eq!(resolve_in(&table(), "deepseek-v4"), Some(1_000_000));
    }

    #[test]
    fn case_insensitive_and_missing() {
        assert_eq!(resolve_in(&table(), "DeepSeek-V4-Flash"), Some(1_000_000));
        assert_eq!(resolve_in(&table(), "kimi-k3"), None);
        assert_eq!(resolve_in(&table(), ""), None);
    }
}
