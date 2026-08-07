use std::collections::HashMap;

use serde_json::Value;
use crate::{
    build_enriched_path, find_claude_binary, load_providers, normalize_deepseek_model_name,
    resolve_provider_env,
};
#[cfg(not(target_os = "windows"))]
use crate::login_shell_proxy_env;

// Custom previews, pinned sessions, and archived sessions are now
// stored exclusively in localStorage (portable EXE: no disk writes).
// The Rust commands load_custom_previews / save_custom_previews /
// load_pinned_sessions / save_pinned_sessions / load_archived_sessions /
// save_archived_sessions have been removed.

/// Path to the session-names metadata file (~/.claude/tokenicode_session_names.json).
/// Kept for backward-compat: session.rs uses this for name<->id lookup in the
/// legacy session list. Does NOT create directories or files — read-only.
pub(crate) fn session_names_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    Ok(home.join(".claude").join("tokenicode_session_names.json"))
}

/// Generate a short AI title for a session by spawning a separate Claude CLI process.
/// Uses the provider's haiku-tier mapping or falls back to claude-haiku-4-5-20251001.
/// Completely isolated from the main conversation channel — spawns a new process
/// that exits after one response.
#[tauri::command]
pub async fn generate_session_title(
    user_message: String,
    assistant_message: String,
    provider_id: Option<String>,
) -> Result<String, String> {
    // Safe UTF-8 truncation (don't slice mid-character)
    fn safe_truncate(s: &str, max_bytes: usize) -> &str {
        if s.len() <= max_bytes {
            return s;
        }
        let mut end = max_bytes;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }

    let user_msg = safe_truncate(&user_message, 500);
    let asst_msg = safe_truncate(&assistant_message, 500);

    let prompt = format!(
        "Generate a very short title (5-10 words, in the same language as the conversation) for this conversation. Reply with ONLY the title text, no quotes, no extra text, no explanation.\n\nUser: {}\n\nAssistant: {}",
        user_msg, asst_msg
    );

    // Resolve model and env vars for provider
    let (provider_env, provider_keys_to_remove, model_name) = if let Some(ref pid) = provider_id {
        let (env, keys, _args, provider_used) = resolve_provider_env(Some(pid))?;
        // If the provider was skipped (OpenAI-format for Claude), fall back to
        // the cheapest Claude model for title generation.
        if !provider_used {
            (HashMap::new(), vec![], "claude-haiku-4-5-20251001".to_string())
        } else {
            // Find haiku tier mapping from provider
            let providers_file = load_providers()?;
            let provider = providers_file.providers.iter().find(|p| p.id == *pid);
            let haiku_model = provider.and_then(|p| {
                p.model_mappings
                    .iter()
                    .find(|m| m.tier == "haiku" && !m.provider_model.is_empty())
                    .map(|m| m.provider_model.clone())
            });
            match haiku_model {
                Some(m) => (env, keys, normalize_deepseek_model_name(&m)),
                None => return Err("SKIP: no haiku mapping for provider".to_string()),
            }
        }
    } else {
        // No provider configured: use default Claude API with cheapest model
        (HashMap::new(), vec![], "claude-haiku-4-5-20251001".to_string())
    };

    // Resolve claude binary
    let claude_bin = find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;

    let enriched_path = build_enriched_path();

    // M2 (security): run the one-shot CLI in an isolated temp directory instead
    // of the app's working directory. Claude Code auto-loads {cwd}/CLAUDE.md
    // and the `--dangerously-skip-permissions` flag (kept so a would-be tool
    // call cannot block the unattended title generation on an unanswerable
    // permission prompt) would otherwise let it act on project files. Title
    // generation needs no project context — an empty temp cwd leaves nothing
    // sensitive for a tool call to touch, and `--max-turns 1` plus the prompt
    // ("only the title text") keep it to a single response.
    let mut title_cwd = std::env::temp_dir();
    title_cwd.push(format!("little-claude-title-gen-{}", std::process::id()));
    std::fs::create_dir_all(&title_cwd)
        .map_err(|e| format!("Failed to create temp dir for title gen: {}", e))?;

    // Spawn a one-shot CLI process: -p for single prompt, --output-format json for structured output
    let mut args = vec![
        "-p".to_string(),
        prompt,
        "--model".to_string(),
        model_name,
        "--output-format".to_string(),
        "json".to_string(),
        "--max-turns".to_string(),
        "1".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    // When a provider is active, pass API config via --settings so it overrides
    // whatever is in ~/.claude/settings.json (which may have external tool env,
    // e.g. CCSwitch writing ANTHROPIC_AUTH_TOKEN). Always emit the block to
    // clear the OAuth token — even providers without base_url/api_key need
    // this protection.
    if provider_id.is_some() {
        let base_url = provider_env
            .get("ANTHROPIC_BASE_URL")
            .map(|v| v.as_str())
            .unwrap_or("");
        let api_key = provider_env
            .get("ANTHROPIC_API_KEY")
            .map(|v| v.as_str())
            .unwrap_or("");

        // Same guard as session.rs: only clear AUTH_TOKEN for third-party
        // providers or when using API key auth. Native Anthropic OAuth users
        // (api.anthropic.com + no API key) must keep the token intact.
        let base_lower = base_url.to_lowercase();
        let is_native_anthropic =
            base_lower.is_empty() || base_lower.contains("api.anthropic.com");
        let has_api_key = !api_key.is_empty();

        let mut settings_env = serde_json::json!({
            "ANTHROPIC_BASE_URL": base_url,
            "ANTHROPIC_API_KEY": api_key,
        });
        // Only clear AUTH_TOKEN for third-party providers or when API key is used.
        // Native Anthropic OAuth users rely on credentials.json — clearing the
        // token would break auth for this one-shot title generation request.
        if !is_native_anthropic || has_api_key {
            settings_env["ANTHROPIC_AUTH_TOKEN"] = serde_json::Value::String(String::new());
        }
        let settings_val = serde_json::json!({
            "alwaysThinkingEnabled": false,
            "skipWebFetchPreflight": true,
            "env": settings_env,
        });
        args.push("--settings".to_string());
        args.push(settings_val.to_string());
    }

    let mut cmd = tokio::process::Command::new(&claude_bin);
    cmd.args(&args)
        .current_dir(&title_cwd)
        .env("PATH", &enriched_path)
        .env_remove("CLAUDECODE") // Allow nested CLI launch
        .env_remove("CLAUDE_CODE_ENTRY") // Remove any other nesting guards
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Kill the child if the timeout future is dropped (spawned process is
        // not otherwise cleaned up on timeout).
        .kill_on_drop(true);

    // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
    #[cfg(target_os = "windows")]
    cmd.env("MSYS_NO_PATHCONV", "1")
        .env("MSYS2_ARG_CONV_EXCL", "*");

    // Inject provider env vars
    for (k, v) in &provider_env {
        cmd.env(k, v);
    }
    for k in &provider_keys_to_remove {
        cmd.env_remove(k);
    }

    // Inject proxy env vars from login shell for GUI apps
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = login_shell_proxy_env();
        for (k, v) in proxy_env {
            if std::env::var(k).is_err() && !provider_env.contains_key(k) {
                cmd.env(k, v);
            }
        }
    }

    // Suppress console window on Windows
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude for title gen: {}", e))?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "Title generation timed out after 45s".to_string())?
    .map_err(|e| format!("Failed to wait for title gen process: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Title gen process failed: {}",
            stderr.chars().take(200).collect::<String>()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse JSON output  --?Claude CLI --output-format json returns:
    // { "type": "result", "result": "the title text", ... }
    if let Ok(json) = serde_json::from_str::<Value>(stdout.trim()) {
        let title = json
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .to_string();
        if title.is_empty() {
            return Err("Empty title generated".to_string());
        }
        return Ok(title);
    }

    // Fallback: if not valid JSON, try to use raw stdout as title
    let raw = stdout.trim().trim_matches('"').to_string();
    if raw.is_empty() || raw.len() > 200 {
        return Err("Could not parse title from CLI output".to_string());
    }
    Ok(raw)
}
