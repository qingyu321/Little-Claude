
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use tokio::process::Command;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::anthropic_proxy::WebSearchFallbackConfig;
use crate::commands::claude_process::{ManagedProcess, ProcessManager, SessionInfo, StartSessionParams, StdinManager};
use crate::commands::provider::ApiProvider;
use crate::commands::metadata::session_names_path;
#[cfg(feature = "video-analysis")]
use crate::commands::video_analysis::inject_video_analysis_multimodal_env;
use crate::{cli_download_dir, inject_proxy_env_vars, resolve_proxy_url, truncate_large_content};
use crate::backends;
use tokio::io::{AsyncBufReadExt, BufReader};
#[cfg(not(target_os = "windows"))]
use crate::login_shell_proxy_env;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::shell_single_quote;
#[cfg(target_os = "windows")]
use crate::resolve_git_bash;

// ── M4 (security): pending permission request registry ──────────────────────
// respond_permission validates that the request_id it answers was actually
// emitted to the frontend (see register_pending_permission_request in the
// stdout reader below). This prevents injecting an arbitrary control_response
// into a session's stdin. Entries expire after 5 minutes to avoid unbounded
// growth. Note: codex sessions register their requests in start_codex_session
// (lib.rs, out of scope) — the codex branch of respond_permission therefore
// validates format only.
const PERMISSION_REQUEST_TTL_SECS: u64 = 5 * 60;

static PENDING_PERMISSION_REQUESTS: OnceLock<Mutex<HashMap<String, std::time::Instant>>> =
    OnceLock::new();

fn pending_permission_requests() -> &'static Mutex<HashMap<String, std::time::Instant>> {
    PENDING_PERMISSION_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn permission_key(session_id: &str, request_id: &str) -> String {
    format!("{}:{}", session_id, request_id)
}

/// Sweep expired entries and return whether `request_id` for `session_id` is a
/// known pending permission request.
fn pending_permission_request_exists(session_id: &str, request_id: &str) -> bool {
    let mut map = pending_permission_requests()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    map.retain(|_, t| now.saturating_duration_since(*t).as_secs() < PERMISSION_REQUEST_TTL_SECS);
    map.contains_key(&permission_key(session_id, request_id))
}

/// Record a permission request that was forwarded to the frontend.
fn register_pending_permission_request(session_id: &str, request_id: &str) {
    let mut map = pending_permission_requests()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    map.retain(|_, t| now.saturating_duration_since(*t).as_secs() < PERMISSION_REQUEST_TTL_SECS);
    map.insert(permission_key(session_id, request_id), now);
}

/// Forget the request once its response has been written to the CLI.
fn consume_pending_permission_request(session_id: &str, request_id: &str) {
    let mut map = pending_permission_requests()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.remove(&permission_key(session_id, request_id));
}

/// 从 provider 配置解析联网搜索兜底端点（密钥转明文）：
/// apiKey 非空优先，否则读环境变量 `env_var`（在 Little Claude 进程环境中）。
/// 停用（enabled=false）、base_url 为空、密钥为空或环境变量未设置 → None（请求继续走主端点）。
fn build_fallback_config(provider: &ApiProvider) -> Option<WebSearchFallbackConfig> {
    let fb = provider.web_search_fallback.as_ref()?;
    if !fb.enabled || fb.base_url.trim().is_empty() {
        eprintln!(
            "[LITTLECLAUDE:provider] web-search fallback skipped: enabled={}, base_url='{}'",
            fb.enabled,
            fb.base_url.trim()
        );
        return None;
    }
    let key = fb
        .api_key
        .as_deref()
        .filter(|k| !k.trim().is_empty() && !k.starts_with("TENC1:"))
        .map(|k| k.trim().to_string())
        .or_else(|| {
            let var = fb.env_var.as_deref()?.trim();
            if var.is_empty() {
                return None;
            }
            match std::env::var(var) {
                Ok(v) if !v.trim().is_empty() => Some(v),
                _ => {
                    eprintln!(
                        "[LITTLECLAUDE:provider] web-search fallback env var '{}' 未设置，跳过兜底",
                        var
                    );
                    None
                }
            }
        });
    let key = match key {
        Some(k) => k,
        None => {
            eprintln!(
                "[LITTLECLAUDE:provider] web-search fallback key missing (api_key={:?} TENC1-filtered or env_var empty), 跳过兜底",
                fb.api_key.as_deref().map(|k| k.starts_with("TENC1:"))
            );
            return None;
        }
    };
    Some(WebSearchFallbackConfig {
        base_url: fb.base_url.clone(),
        api_key: key,
        model: fb.model.clone().unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn start_claude_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    proxy_mgr: State<'_, crate::commands::anthropic_proxy::ProxyManager>,
    params: StartSessionParams,
) -> Result<SessionInfo, String> {
    eprintln!(
        "[LITTLECLAUDE:session] start params: session_id={:?}, resume_session_id={:?}, cli_backend={:?}, provider_id={:?}, model={:?}",
        params.session_id, params.resume_session_id, params.cli_backend, params.provider_id, params.model
    );
    let session_id = params
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // Clean up any existing process with the same session_id
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;

    // ─── CLI Backend routing ────────────────────────────────────────────
    let mut cli_backend = params.cli_backend.as_deref().unwrap_or("claude").to_string();

    // Only route to Codex if the provider explicitly declares cli_backend="codex".
    // api_format alone does NOT force Codex — some OpenAI-format endpoints also
    // accept Anthropic-format requests, and users should be able to choose Claude CLI.
    if cli_backend != "codex" {
        if let Some(ref provider_id) = params.provider_id {
            if let Ok(providers_file) = crate::commands::provider::load_providers() {
                if let Some(provider) = providers_file.providers.iter().find(|p| p.id == *provider_id) {
                    if provider.cli_backend.as_deref() == Some("codex") {
                        eprintln!(
                            "[LITTLECLAUDE:session] Routing to codex backend (provider '{}' declares cli_backend='codex')",
                            provider.name
                        );
                        cli_backend = "codex".to_string();
                    }
                }
            }
        }
    }

    if cli_backend == "codex" {
        return crate::start_codex_session(app, state, stdin_mgr, params, session_id).await;
    }
    // ─── Claude path (existing logic) ───────────────────────────────────

    // Use persistent stream-json input mode instead of per-message -p mode.
    // This keeps the CLI process alive so slash commands (/rewind, /compact, /cost, etc.) work.
    let mut args = vec![
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--replay-user-messages".to_string(),
        // Skip global MCP servers from ~/.claude.json to avoid slow cold start.
        // MCP servers (chrome-devtools, codex, gemini, pencil etc.) add 20-30s startup
        // overhead as each must initialize before the CLI accepts input.
        "--strict-mcp-config".to_string(),
    ];

    // A2: --include-partial-messages is opt-out (default true for backward compat).
    // Disabling it reduces stream event volume 10-50×, dramatically improving
    // performance on low-CPU / integrated-GPU machines.
    if params.include_partial_messages.unwrap_or(true) {
        args.push("--include-partial-messages".to_string());
    }

    // Resume an existing CLI session if requested
    eprintln!("[LITTLECLAUDE] resume_session_id={:?}", params.resume_session_id);
    if let Some(ref resume_id) = params.resume_session_id {
        args.push("--resume".to_string());
        args.push(resume_id.clone());
    }

    // --model is added later after provider resolution (see below)

    if let Some(ref tools) = params.allowed_tools {
        for tool in tools {
            args.push("--allowedTools".to_string());
            args.push(tool.clone());
        }
    }

    // Permission mode: all modes use --permission-prompt-tool stdio so the CLI
    // routes user interactions (AskUserQuestion, ExitPlanMode) via control_request.
    // In bypassPermissions mode the CLI auto-approves tool permissions internally
    // (zero overhead) but still sends control_requests for user interactions.
    let permission_mode = params.permission_mode.as_deref().unwrap_or("default");
    args.push("--permission-mode".to_string());
    args.push(permission_mode.to_string());
    args.push("--permission-prompt-tool".to_string());
    args.push("stdio".to_string());

    // Extended thinking + effort level
    let thinking_level = params.thinking_level.as_deref().unwrap_or("high");

    // Resolve claude binary  --?it may not be on the default PATH
    let claude_bin = crate::find_claude_binary().unwrap_or_else(|| {
        #[cfg(target_os = "windows")]
        {
            "claude.cmd".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            "claude".to_string()
        }
    });

    // Build an enriched PATH for the child process
    let enriched_path = crate::build_enriched_path();

    // Resolve provider environment variables from provider_id
    let (mut resolved_env, inherited_keys_to_remove, provider_extra_args, _provider_used) =
        crate::resolve_provider_env(params.provider_id.as_deref())?;

    // ─── Force direct connections (Clash/Mihomo hijack fix) ────────────
    // Clash 类工具（Clash Verge Mihomo 等）会在系统/注册表残留代理配置，
    // Claude Code（Node/undici）检测到 HTTP(S)_PROXY 后把公网 API 请求发给
    // 本地代理；全局模式下节点到部分端点不通 → 超时/502（实测 zen 端点经
    // 7897 端口 25s 超时、直连 2.7s）。Little Claude 自带的转换/兜底代理
    // 走 127.0.0.1 直连端点（upstream 带 .no_proxy()），不需要系统代理。
    // 因此 spawn CLI 时显式清空代理变量并 NO_PROXY=*，双保险注入到进程
    // env 与 --settings env（后者覆盖 ~/.claude/settings.json 里的残留）。
    // 注意大小写都要清：undici 同时读取 HTTP_PROXY 与 http_proxy 两套。
    const PROXY_CLEAR_VARS: [&str; 6] = [
        "HTTP_PROXY", "http_proxy",
        "HTTPS_PROXY", "https_proxy",
        "ALL_PROXY", "all_proxy",
    ];

    // ─── Local proxy (conversion & web-search fallback) ────────────────
    // Claude CLI only speaks the Anthropic Messages API. When the provider
    // exposes ONLY an OpenAI-compatible endpoint (api_format = "openai"),
    // start a local proxy that converts Anthropic requests to OpenAI format
    // and forwards them to the real endpoint, then converts the responses
    // back. When a web-search fallback endpoint is configured, the proxy is
    // started regardless of format: requests carrying the web_search server
    // tool are forwarded to the fallback endpoint (Anthropic format),
    // everything else passes through to the main endpoint untouched.
    // Point ANTHROPIC_BASE_URL at the proxy.
    if cli_backend == "claude" {
        if let Some(ref provider_id) = params.provider_id {
            if let Ok(providers_file) = crate::commands::provider::load_providers() {
                if let Some(provider) = providers_file
                    .providers
                    .iter()
                    .find(|p| p.id == *provider_id)
                {
                    let fallback = build_fallback_config(provider);
                    let need_proxy = provider.api_format == "openai" || fallback.is_some();
                    if need_proxy {
                        let has_key = provider
                            .api_key
                            .as_ref()
                            .map_or(false, |k| !k.is_empty());
                        if has_key && !provider.base_url.is_empty() {
                            let proxy_url = proxy_mgr
                                .start(
                                    &session_id,
                                    provider.base_url.clone(),
                                    provider.api_key.clone().unwrap_or_default(),
                                    provider.api_format.clone(),
                                    fallback.clone(),
                                )
                                .await?;
                            eprintln!(
                                "[LITTLECLAUDE:proxy] Routing session {} through proxy → {}",
                                session_id, proxy_url
                            );
                            resolved_env
                                .insert("ANTHROPIC_BASE_URL".to_string(), proxy_url);
                            // 凭据交换：兜底启用时把 CLI 侧的 ANTHROPIC_API_KEY 换成兜底
                            // key，保证服务端工具结果的加密内容（encrypted_content）解密
                            // 密钥与兜底端点收到的凭据一致。代理用自己持有的 key 做上游
                            // 认证，完全忽略 CLI 发来的 header。
                            if let Some(fb) = &fallback {
                                resolved_env.insert(
                                    "ANTHROPIC_API_KEY".to_string(),
                                    fb.api_key.clone(),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // Always pass --model when a model is specified. The resolved model name
    // comes from the provider's model_mappings and should be passed to the
    // CLI regardless of api_format — the endpoint handles model routing.
    if let Some(ref model) = params.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    // DEBUG: print resolved provider env to console for troubleshooting
    eprintln!(
        "[LITTLECLAUDE:provider] provider_id={:?}, ANTHROPIC_BASE_URL={:?}, ANTHROPIC_API_KEY={}, keys_removed={:?}",
        params.provider_id,
        resolved_env.get("ANTHROPIC_BASE_URL"),
        if resolved_env.contains_key("ANTHROPIC_API_KEY") { "(set)" } else { "(not set)" },
        inherited_keys_to_remove,
    );

    // Inject default multimodal model for video-analysis skill (if user configured it).
    #[cfg(feature = "video-analysis")]
    inject_video_analysis_multimodal_env(&mut resolved_env);

    // Process-level proxy cleanup (see PROXY_CLEAR_VARS above)
    for var in PROXY_CLEAR_VARS {
        resolved_env.insert(var.to_string(), String::new());
    }
    resolved_env.insert("NO_PROXY".to_string(), "*".to_string());
    resolved_env.insert("no_proxy".to_string(), "*".to_string());

    // Build --settings JSON.
    // CRITICAL: The Claude CLI reads ~/.claude/settings.json at startup, and its
    // `env` block takes precedence over actual environment variables. When a
    // provider is active, we MUST pass the API configuration through --settings
    // so it overrides whatever external tools (CCSwitch) wrote to settings.json.
    let always_thinking = thinking_level != "off";
    let mut settings_val = serde_json::json!({
        "alwaysThinkingEnabled": always_thinking,
        "skipWebFetchPreflight": true,
    });
    // When a provider is active, inject ANTHROPIC_* env vars into --settings so
    // they override ~/.claude/settings.json.
    //
    // CRITICAL: Claude CLI reads ~/.claude/settings.json at startup, and its `env`
    // block takes precedence over process environment variables. External tools
    // (CCSwitch, etc.) may have written ANTHROPIC_AUTH_TOKEN into settings.json.
    //
    // ANTHROPIC_AUTH_TOKEN triggers OAuth/Bearer auth in the CLI — third-party
    // providers don't support this and will return 401. We must explicitly set it
    // to "" in --settings to clear any leaked value from settings.json.
    //
    // ANTHROPIC_API_KEY uses x-api-key header auth, which is what third-party
    // Anthropic-compatible endpoints expect.
    if params.provider_id.is_some() {
        let mut settings_env = serde_json::Map::new();
        if let Some(base_url) = resolved_env.get("ANTHROPIC_BASE_URL") {
            settings_env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                serde_json::Value::String(base_url.clone()),
            );
        }
        if let Some(api_key) = resolved_env.get("ANTHROPIC_API_KEY") {
            settings_env.insert(
                "ANTHROPIC_API_KEY".to_string(),
                serde_json::Value::String(api_key.clone()),
            );
        }

        // Override ANTHROPIC_MODEL + ANTHROPIC_DEFAULT_*_MODEL from the provider's
        // resolved model name. External tools (CCSwitch, manual edits) may have
        // written capitalized names into ~/.claude/settings.json; the CLI uses
        // these DEFAULT_* vars for internal requests (title generation, etc.),
        // NOT --model. Case-sensitive gateways (e.g. opencode's /v1/messages:
        // "DeepSeek-V4-Flash" → 401 ModelError "not supported") fail on the
        // capitalized name even though the main conversation (via --model) works.
        if let Some(ref model) = params.model {
            for var in [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
            ] {
                settings_env.insert(
                    var.to_string(),
                    serde_json::Value::String(model.clone()),
                );
            }
        }

        // Only clear the OAuth token for third-party providers or when using
        // explicit API key auth. For native Anthropic (api.anthropic.com) with
        // OAuth (no API key set), we must preserve the token from the user's
        // ~/.claude/credentials.json so `claude login` auth continues to work.
        let base_lower = resolved_env
            .get("ANTHROPIC_BASE_URL")
            .map(|u| u.to_lowercase())
            .unwrap_or_default();
        let is_native_anthropic =
            base_lower.is_empty() || base_lower.contains("api.anthropic.com");
        let has_api_key = resolved_env.contains_key("ANTHROPIC_API_KEY");

        if !is_native_anthropic || has_api_key {
            // Third-party providers don't support OAuth/Bearer auth — clear the
            // token so any leaked value from ~/.claude/settings.json (e.g. from
            // CCSwitch) doesn't cause 401 errors.
            settings_env.insert(
                "ANTHROPIC_AUTH_TOKEN".to_string(),
                serde_json::Value::String(String::new()),
            );
        }
        settings_val["env"] = serde_json::Value::Object(settings_env);
    }

    // Proxy cleanup inside --settings env (see PROXY_CLEAR_VARS above).
    // settings.json env 块优先级高于进程环境变量，必须在这里也清一遍，
    // 才能压掉 ~/.claude/settings.json 或其他工具写入的代理残留。
    // 无条件执行——原生 Anthropic 直连同样可能被系统残留代理劫持。
    if !settings_val["env"].is_object() {
        settings_val["env"] = serde_json::Value::Object(serde_json::Map::new());
    }
    let settings_env_clear = settings_val["env"].as_object_mut().expect("env is object");
    for var in PROXY_CLEAR_VARS {
        settings_env_clear.insert(
            var.to_string(),
            serde_json::Value::String(String::new()),
        );
    }
    settings_env_clear.insert("NO_PROXY".to_string(), serde_json::Value::String("*".to_string()));
    settings_env_clear.insert("no_proxy".to_string(), serde_json::Value::String("*".to_string()));

    args.push("--settings".to_string());
    args.push(settings_val.to_string());

    // Append provider-specific CLI args (e.g. --setting-sources project,local)
    args.extend(provider_extra_args);

    // Inject effort level env var for non-off thinking levels
    if thinking_level != "off" {
        resolved_env.insert(
            "CLAUDE_CODE_EFFORT_LEVEL".to_string(),
            thinking_level.to_string(),
        );
    }

    // Raise the per-turn output token cap from the CLI default (32K) to 64K.
    // This prevents "response exceeded the 32000 output token maximum" errors
    // when generating large files (e.g. HTML presentations).
    resolved_env
        .entry("CLAUDE_CODE_MAX_OUTPUT_TOKENS".to_string())
        .or_insert_with(|| "64000".to_string());

    // Enable CLI-managed file checkpoints for rewind functionality.
    // With --replay-user-messages, user messages in stream output carry a uuid
    // that identifies the checkpoint. The rewind_files command uses these UUIDs.
    resolved_env.insert(
        "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING".to_string(),
        "1".to_string(),
    );

    // For long-context third-party routes, override Claude Code's internal compact window.
    // Some provider model names do not expose a 1M marker, so the frontend can declare it.
    let declared_context_window = params.context_window.unwrap_or_else(|| {
        params
            .model
            .as_deref()
            .map(|model_name| {
                let m = model_name.to_lowercase();
                if m.contains("mimo") || m.contains("[1m]") {
                    1_000_000
                } else {
                    200_000
                }
            })
            .unwrap_or(200_000)
    });
    if declared_context_window >= 1_000_000 {
        resolved_env.insert(
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
            declared_context_window.to_string(),
        );
        eprintln!(
            "[LITTLECLAUDE] Set CLAUDE_CODE_AUTO_COMPACT_WINDOW={} for model {:?}",
            declared_context_window, params.model
        );
    }

    // On Windows, disable MSYS2/Git Bash automatic path conversion.
    // Without this, MSYS2 converts Windows paths (e.g. F:\秀\input\file.xlsx)
    // to Unix-style paths (/f/秀/input/file.xlsx), which breaks file operations
    // especially with non-ASCII (Chinese) characters in paths.
    #[cfg(target_os = "windows")]
    {
        resolved_env
            .entry("MSYS_NO_PATHCONV".to_string())
            .or_insert_with(|| "1".to_string());
        resolved_env
            .entry("MSYS2_ARG_CONV_EXCL".to_string())
            .or_insert_with(|| "*".to_string());
    }

    // On Windows, auto-detect git-bash and inject CLAUDE_CODE_GIT_BASH_PATH
    // so Claude Code CLI can find bash.exe without user manual configuration.
    // resolve_git_bash prefers the user/provider-configured CLAUDE_CODE_GIT_BASH_PATH,
    // then system Git-for-Windows, then falls back to app-local PortableGit.
    #[cfg(target_os = "windows")]
    {
        if !resolved_env.contains_key("CLAUDE_CODE_GIT_BASH_PATH") {
            if let Some((bash_path, source)) = resolve_git_bash() {
                resolved_env.insert("CLAUDE_CODE_GIT_BASH_PATH".to_string(), bash_path.clone());
                eprintln!(
                    "[tokenicode] Git Bash resolved: path={} source={}",
                    bash_path, source
                );
            } else {
                // git-bash is a hard requirement for Claude Code on Windows.
                // Fail fast with a clear error instead of spawning and getting a silent exit.
                return Err("Claude Code requires Git Bash on Windows.\n\
                     Please reinstall Claude Code via Settings to auto-install Git,\n\
                     or install Git for Windows manually: https://git-scm.com/downloads/win"
                    .to_string());
            }
        }
    }

    // Auto-detect and inject proxy env vars into CLI subprocess.
    // GUI apps launched from Finder/Dock don't inherit shell proxy settings.
    // Detection order: login shell > macOS system proxy > local port probing.
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = crate::login_shell_proxy_env();
        for (k, v) in proxy_env {
            if !resolved_env.contains_key(k) && std::env::var(k).is_err() {
                resolved_env.insert(k.clone(), v.clone());
            }
        }
    }

    // If still no proxy env vars, try system proxy + port probing
    {
        let has_proxy = resolved_env.keys().any(|k| {
            let kl = k.to_lowercase();
            kl == "https_proxy" || kl == "http_proxy" || kl == "all_proxy"
        });
        if !has_proxy {
            // resolve_proxy_url checks: process env > system proxy > login shell > port probing
            if let Some(url) = resolve_proxy_url() {
                inject_proxy_env_vars(&mut resolved_env, &url);
            }
        }
    }

    // On Windows, .cmd/.bat files must be launched via cmd /C
    #[cfg(target_os = "windows")]
    let mut child = {
        // Helper: build and spawn a Command for the given binary
        let spawn_win = |bin: &str| {
            let needs_cmd = bin.ends_with(".cmd")
                || bin.ends_with(".bat")
                || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'));
            let mut cmd = if needs_cmd {
                let mut c = Command::new("cmd");
                c.arg("/C").arg(bin);
                c
            } else {
                Command::new(bin)
            };
            cmd.args(&args)
                .current_dir(&params.cwd)
                .env("PATH", &enriched_path)
                .env_remove("CLAUDECODE");
            for key in &inherited_keys_to_remove {
                cmd.env_remove(key);
            }
            for (key, value) in &resolved_env {
                cmd.env(key, value);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(0x08000000)
                .kill_on_drop(true) // future 被 drop（窗口关闭等）时不留孤儿进程
                .spawn()
        };

        match spawn_win(&claude_bin) {
            Ok(c) => c,
            Err(e) if e.raw_os_error() == Some(193) => {
                // Error 193: not a valid Win32 application  --?binary is corrupt.
                // Clean up the bad binary and try to find an alternative.
                eprintln!("error 193 on '{}', cleaning up and retrying...", claude_bin);
                if let Some(cli_dir) = cli_download_dir() {
                    let suspect = cli_dir.join("claude.exe");
                    if suspect.exists() {
                        let _ = std::fs::remove_file(&suspect);
                    }
                }
                let alt_bin = crate::find_claude_binary().unwrap_or_else(|| "claude.cmd".to_string());
                if alt_bin == claude_bin {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}'): {}",
                        claude_bin, e
                    ));
                }
                eprintln!("Retrying with alternative: {}", alt_bin);
                spawn_win(&alt_bin).map_err(|e2| {
                    format!(
                        "Failed to spawn claude (tried '{}' then '{}'): {}",
                        claude_bin, alt_bin, e2
                    )
                })?
            }
            Err(e) => {
                return Err(format!(
                    "Failed to spawn claude (tried '{}'): {}",
                    claude_bin, e
                ));
            }
        }
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let spawn_unix = |bin: &str| -> std::io::Result<tokio::process::Child> {
            let mut cmd = Command::new(bin);
            cmd.args(&args)
                .current_dir(&params.cwd)
                .env("PATH", &enriched_path)
                // Clear CLAUDECODE env var so the CLI doesn't refuse to start
                // when Little Claude itself is launched from within a Claude Code session.
                .env_remove("CLAUDECODE");
            // Clear inherited ANTHROPIC_* env vars that conflict with our overrides
            for key in &inherited_keys_to_remove {
                cmd.env_remove(key);
            }
            // Inject custom API provider env vars
            for (key, value) in &resolved_env {
                cmd.env(key, value);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true) // future 被 drop 时不留孤儿进程
                .spawn()
        };

        match spawn_unix(&claude_bin) {
            Ok(c) => c,
            Err(e) if e.raw_os_error() == Some(13) => {
                // EACCES
                // Permission denied  --?attempt to fix execute permission and retry.
                eprintln!(
                    "EACCES on '{}', attempting chmod +x and retrying...",
                    claude_bin
                );
                let path = std::path::Path::new(&claude_bin);
                let fixed = (|| -> Result<(), std::io::Error> {
                    use std::os::unix::fs::PermissionsExt;
                    let metadata = std::fs::metadata(path)?;
                    let mut perms = metadata.permissions();
                    perms.set_mode(perms.mode() | 0o755);
                    std::fs::set_permissions(path, perms)?;
                    Ok(())
                })();
                if let Err(chmod_err) = fixed {
                    eprintln!("chmod +x failed: {}", chmod_err);
                    return Err(format!(
                        "Failed to spawn claude (tried '{}', permission denied, chmod fix also failed: {}): {}",
                        claude_bin, chmod_err, e
                    ));
                }
                eprintln!("chmod +x succeeded, retrying spawn...");
                spawn_unix(&claude_bin).map_err(|e2| {
                    format!(
                        "Failed to spawn claude (tried '{}', retried after chmod +x): {}",
                        claude_bin, e2
                    )
                })?
            }
            Err(e) if e.raw_os_error() == Some(88) || e.raw_os_error() == Some(8) => {
                // ENOEXEC (88 on macOS, 8 on Linux)  --?Malformed binary.
                // Delete the corrupt binary and try to find an alternative.
                eprintln!(
                    "ENOEXEC on '{}' (malformed binary), cleaning up and retrying...",
                    claude_bin
                );
                if let Some(cli_dir) = cli_download_dir() {
                    let suspect = cli_dir.join("claude");
                    if suspect.exists() {
                        let _ = std::fs::remove_file(&suspect);
                        eprintln!("Removed corrupt binary: {:?}", suspect);
                    }
                }
                let alt_bin = crate::find_claude_binary().unwrap_or_else(|| "claude".to_string());
                if alt_bin == claude_bin {
                    return Err(format!(
                        "Failed to spawn claude (tried '{}', binary is malformed/corrupt  --?\
                         please reinstall CLI from Settings): {}",
                        claude_bin, e
                    ));
                }
                eprintln!("Retrying with alternative: {}", alt_bin);
                spawn_unix(&alt_bin).map_err(|e2| {
                    format!(
                        "Failed to spawn claude (tried '{}' then '{}'): {}",
                        claude_bin, alt_bin, e2
                    )
                })?
            }
            Err(e) => {
                return Err(format!(
                    "Failed to spawn claude (tried '{}'): {}",
                    claude_bin, e
                ));
            }
        }
    };

    let pid = child.id().unwrap_or(0);
    eprintln!(
        "[LITTLECLAUDE] CLI spawned: pid={}, bin={}, permission_mode={}",
        pid, claude_bin, permission_mode
    );
    eprintln!("[LITTLECLAUDE] args: {:?}", redact_args_for_log(&args));
    eprintln!("[LITTLECLAUDE] PATH: {}", &enriched_path);
    eprintln!("[LITTLECLAUDE] resolved_env ({} keys):", resolved_env.len());
    for (k, v) in &resolved_env {
        let is_sensitive = k.contains("API_KEY") || k.contains("TOKEN") || k.contains("SECRET");
        let display_val: &str = if is_sensitive { "***" } else { v.as_str() };
        eprintln!("  {k}={display_val}");
    }
    eprintln!("[LITTLECLAUDE] cwd: {}", &params.cwd);

    // Capture stdin and store in StdinManager for sending follow-up messages
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    stdin_mgr.insert(session_id.clone(), stdin).await;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let sid = session_id.clone();

    state
        .insert(
            sid.clone(),
            ManagedProcess {
                child,
                backend: "claude".to_string(),
            },
        )
        .await;

    // Helper: emit to the main webview using emit_to for reliable delivery
    fn emit_to_frontend(app: &AppHandle, event: &str, payload: Value) -> Result<(), String> {
        if let Err(e1) = app.emit_to("main", event, payload.clone()) {
            // Fallback: use global emit
            if let Err(e2) = app.emit(event, payload) {
                return Err(format!("emit_to failed: {}, emit failed: {}", e1, e2));
            }
        }
        Ok(())
    }

    // Spawn stdout reader  --?streams NDJSON to frontend, intercepts control_request
    let app_clone = app.clone();
    let sid_clone = sid.clone();
    let pm_clone: ProcessManager = (*state).clone(); // 浅克隆（内部全是 Arc）—— 供 EOF 后取退出码
    let stdin_clone = stdin_mgr.inner().clone();
    let is_bypass = permission_mode == "bypassPermissions";
    tokio::spawn(async move {
        let stream_event = format!("claude:stream:{}", sid_clone);
        // Use a large buffer (1MB) to efficiently read large NDJSON lines from Claude CLI.
        // Default 8KB buffer causes thousands of syscalls for large outputs (e.g. 24.8MB PDF),
        // which stalls on Windows pipes. 1MB buffer reduces syscalls by ~125x.
        let reader = BufReader::with_capacity(1024 * 1024, stdout);
        let mut lines = reader.lines();
        let mut line_count: u64 = 0;
        let mut read_err_count: u32 = 0;
        let spawn_time = std::time::Instant::now();
        let mut clean_eof = false;
        loop {
            let line = match lines.next_line().await {
                Ok(Some(line)) => {
                    read_err_count = 0;
                    line
                }
                Ok(None) => {
                    clean_eof = true;
                    break; // normal EOF
                }
                Err(e) => {
                    // F1: a single line with invalid UTF-8 (e.g. GBK bytes from a
                    // Windows tool, or a half-written line from a crashed CLI) makes
                    // tokio's `lines()` return Err(InvalidData) — but it has already
                    // consumed that line's bytes, so the stream is still usable.
                    // Skip the poisoned line instead of abandoning the whole session:
                    // the old `break` orphaned a live CLI process, leaving the
                    // frontend with zero feedback while the agent kept running.
                    read_err_count += 1;
                    eprintln!(
                        "[LITTLECLAUDE:WARN] stdout read error after {} lines (consecutive #{}), skipping line: {}",
                        line_count, read_err_count, e
                    );
                    if read_err_count >= 100 {
                        // A permanently broken pipe would otherwise spin here — give up
                        // after 100 consecutive failures (post-loop cleanup kills the CLI).
                        eprintln!(
                            "[LITTLECLAUDE:CRITICAL] 100 consecutive stdout read errors, stopping stream"
                        );
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    continue;
                }
            };
            line_count += 1;
            // Log first 10 lines with timing to diagnose startup delay
            if line_count <= 10 {
                let elapsed = spawn_time.elapsed().as_millis();
                let preview = crate::utf8_prefix(&line, 150);
                eprintln!(
                    "[LITTLECLAUDE:stdout] #{} @{}ms type={} preview={}",
                    line_count,
                    elapsed,
                    serde_json::from_str::<Value>(&line)
                        .ok()
                        .and_then(|v| v.get("type").and_then(|t| t.as_str().map(String::from)))
                        .unwrap_or_else(|| "?".into()),
                    preview
                );
            }
            // Parse every line as a JSON Value first (avoids serde enum pitfalls)
            let json = match serde_json::from_str::<Value>(&line) {
                Ok(v) => v,
                Err(_) => continue, // skip non-JSON lines
            };

            // Intercept control_request messages for SDK control protocol routing.
            // All modes use --permission-prompt-tool stdio. In bypass mode, we
            // auto-approve tool permissions here (zero frontend overhead) but route
            // user interactions (AskUserQuestion) to the frontend.
            if let Some("control_request") = json.get("type").and_then(|v| v.as_str()) {
                let request_id = json
                    .get("request_id")
                    .or_else(|| json.get("requestId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if let Some(request) = json.get("request") {
                    let subtype = request
                        .get("subtype")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();

                    // Bypass mode: auto-approve everything except user interactions.
                    if is_bypass {
                        let tool_name = request
                            .get("tool_name")
                            .or_else(|| request.get("toolName"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        if tool_name != "AskUserQuestion" {
                            let mut allow = serde_json::json!({ "behavior": "allow" });
                            if subtype == "can_use_tool" {
                                allow["updatedInput"] = request
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(Value::Object(serde_json::Map::new()));
                                if let Some(id) = request
                                    .get("tool_use_id")
                                    .or_else(|| request.get("toolUseId"))
                                    .and_then(|v| v.as_str())
                                {
                                    allow["toolUseID"] = Value::String(id.to_string());
                                }
                            }
                            let resp = serde_json::json!({
                                "type": "control_response",
                                "response": { "subtype": "success", "request_id": request_id, "response": allow }
                            });
                            let _ = stdin_clone.send(&sid_clone, &resp.to_string()).await;
                            continue;
                        }
                        // AskUserQuestion: fall through to frontend routing
                    }

                    match subtype {
                        "can_use_tool" => {
                            let tool_name = request
                                .get("tool_name")
                                .or_else(|| request.get("toolName"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let input = request.get("input").cloned().unwrap_or(Value::Null);
                            let description = request
                                .get("description")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let tool_use_id = request
                                .get("tool_use_id")
                                .or_else(|| request.get("toolUseId"))
                                .and_then(|v| v.as_str())
                                .map(String::from);

                            eprintln!(
                                "[LITTLECLAUDE] permission request: tool={} request_id={}",
                                tool_name, request_id
                            );

                            // M4: record the request so respond_permission can
                            // validate that it was really routed to the frontend.
                            register_pending_permission_request(&sid_clone, &request_id);

                            // Emit as a special stream message (reuses the working stream channel)
                            // NOTE: type MUST match what the frontend expects in
                            // useStreamProcessor (KNOWN_STREAM_TYPES / switch cases).
                            // It was left as "tokenicode_permission_request" when the
                            // frontend was renamed to "little_claude_permission_request",
                            // silently dropping every permission request (PermissionCard
                            // / QuestionCard / plan auto-approve never appeared).
                            let perm_payload = serde_json::json!({
                                "type": "little_claude_permission_request",
                                "request_id": request_id,
                                "tool_name": tool_name,
                                "input": input,
                                "description": description,
                                "tool_use_id": tool_use_id,
                            });
                            let _ = emit_to_frontend(&app_clone, &stream_event, perm_payload);
                            continue; // Don't forward to stream as normal msg
                        }
                        "hook_callback" => {
                            // Auto-allow hook callbacks (Little Claude doesn't manage hooks)
                            let auto_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "allow" }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                            continue;
                        }
                        other => {
                            // Unknown control request subtype  --?deny by default (P0-4 fix)
                            eprintln!("[LITTLECLAUDE] control_request/{}: denying unknown subtype (request_id={})", other, request_id);
                            let deny_resp = serde_json::json!({
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": { "behavior": "deny", "message": format!("Unknown permission type '{}' denied by Little Claude", other) }
                                }
                            });
                            let _ = stdin_clone.send(&sid_clone, &deny_resp.to_string()).await;
                            continue;
                        }
                    }
                } else {
                    eprintln!(
                        "[LITTLECLAUDE] control_request missing 'request' field: {}",
                        crate::utf8_prefix(&line, 200)
                    );
                    // Auto-allow to avoid blocking CLI
                    let auto_resp = serde_json::json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "success",
                            "request_id": request_id,
                            "response": { "behavior": "allow" }
                        }
                    });
                    let _ = stdin_clone.send(&sid_clone, &auto_resp.to_string()).await;
                    continue;
                }
            }

            // Normal message  --?forward to frontend stream.
            // For very large messages (e.g. PDF content, large file reads), truncate the
            // content before sending through Tauri IPC to avoid freezing the WebView.
            // Claude CLI already has the full content internally; the frontend only needs
            // a preview for display purposes.
            let json_to_emit = {
                let serialized_len = line.len();
                const MAX_IPC_BYTES: usize = 2 * 1024 * 1024; // 2MB threshold
                if serialized_len > MAX_IPC_BYTES {
                    let mut truncated = json.clone();
                    // Truncate content in tool_result blocks and message content
                    if let Some(content) = truncated.get_mut("content") {
                        truncate_large_content(content, MAX_IPC_BYTES / 2);
                    }
                    if let Some(msg) = truncated.get_mut("message") {
                        if let Some(content) = msg.get_mut("content") {
                            truncate_large_content(content, MAX_IPC_BYTES / 2);
                        }
                    }
                    truncated
                } else {
                    json
                }
            };
            // F2: emit failure is usually transient (WebView2 reload / renderer
            // restart). Retry with exponential backoff (~14s total) so a brief
            // frontend hiccup doesn't kill a live session — the old code broke
            // the loop after 10 failures and orphaned the CLI process.
            let mut emit_ok = false;
            const MAX_EMIT_ATTEMPTS: u32 = 12;
            for attempt in 1..=MAX_EMIT_ATTEMPTS {
                match emit_to_frontend(&app_clone, &stream_event, json_to_emit.clone()) {
                    Ok(()) => {
                        emit_ok = true;
                        break;
                    }
                    Err(e) => {
                        eprintln!(
                            "[LITTLECLAUDE] emit_to_frontend failed (attempt {attempt}/{MAX_EMIT_ATTEMPTS}): {e}"
                        );
                        if attempt < MAX_EMIT_ATTEMPTS {
                            let backoff_ms = (100u64 * (1u64 << attempt.min(4))).min(2000);
                            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                        }
                    }
                }
            }
            if !emit_ok {
                eprintln!(
                    "[LITTLECLAUDE:CRITICAL] {MAX_EMIT_ATTEMPTS} consecutive emit failures -- frontend unreachable, stopping stream"
                );
                break;
            }
        }
        // stdout EOF —— 进程随即退出，等待真实退出码（超时视为无码）
        let exit_code = pm_clone
            .wait_status(&sid_clone, std::time::Duration::from_secs(2))
            .await;
        if exit_code.is_none() && !clean_eof {
            // F3: the read loop broke on an error (poisoned pipe / unreachable
            // frontend), but the CLI is still alive. Previously this orphaned the
            // process: the frontend was told the session exited while the agent
            // kept running and writing its JSONL — the content only reappeared
            // after reopening the session. Kill it (and drop the stdin handle)
            // so UI state and reality agree.
            eprintln!(
                "[LITTLECLAUDE:CRITICAL] stream ended abnormally but process still alive -- killing orphaned session {sid_clone}"
            );
        }
        // 报告 B1: 正常退出也清理 process/stdin 条目。此前仅异常分支移除，
        // 每会话泄漏一个句柄条目；且已 reap 的 PID 残留会让 delete_session
        // 再 kill 一个可能已被 OS 复用的 PID（Unix PID 复用误杀）。
        // 进程已退出，remove() 里的 kill() 是无害 no-op（返回错误仅记日志）。
        stdin_clone.remove(&sid_clone).await;
        pm_clone.remove(&sid_clone).await;
        // Emit process_exit on the stream channel (primary detection)
        let _ = emit_to_frontend(
            &app_clone,
            &stream_event,
            serde_json::json!({"type": "process_exit", "code": exit_code}),
        );
        // Also emit on the dedicated exit channel (backup detection via onSessionExit)
        let _ = emit_to_frontend(
            &app_clone,
            &format!("claude:exit:{}", sid_clone),
            serde_json::json!({ "code": exit_code }),
        );

        // Notify frontend that session list may have changed
        let _ = emit_to_frontend(&app_clone, "sessions:changed", serde_json::json!(null));
    });

    // Spawn stderr reader
    let app_clone2 = app.clone();
    let sid_clone2 = sid.clone();
    tokio::spawn(async move {
        let reader = BufReader::with_capacity(256 * 1024, stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = emit_to_frontend(
                &app_clone2,
                &format!("claude:stderr:{}", sid_clone2),
                serde_json::json!(line),
            );
        }
    });

    // Send the first message via stdin as NDJSON (skip if prompt is empty  --?pre-warm mode)
    if !params.prompt.is_empty() {
        let first_msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": params.prompt
            }
        });
        stdin_mgr.send(&sid, &first_msg.to_string()).await?;
    }

    Ok(SessionInfo {
        session_id: sid,
        pid,
        cli_path: claude_bin.clone(),
    })
}

#[tauri::command]
pub async fn send_stdin(
    process_mgr: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    // Check which backend this session uses
    let backend_name = process_mgr.get_backend(&session_id).await;
    let is_codex = backend_name.as_deref() == Some("codex");

    if is_codex {
        // Codex: use turn/start JSON-RPC format with thread_id
        let backend = crate::backends::resolve_backend(Some("codex"));
        let thread_id = process_mgr.get_codex_thread_id(&session_id).await;
        let msg = backend.build_user_message(&message, thread_id.as_deref());
        stdin_mgr.send(&session_id, &msg).await
    } else {
        // Claude: wrap user text in stream-json NDJSON format
        let json_msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": message
            }
        });
        stdin_mgr.send(&session_id, &json_msg.to_string()).await
    }
}

#[tauri::command]
pub async fn send_raw_stdin(
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    // M3 (security): this raw stdin channel is only used by the legacy
    // interactive-approval fallback — PermissionCard sends exactly 'y'/'n'
    // when a permission request has no structured request_id (see
    // src/components/chat/PermissionCard.tsx). Arbitrary NDJSON / control
    // payload injection through this command is rejected: structured traffic
    // must go through send_stdin / send_control_request / respond_permission.
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("Invalid session_id".to_string());
    }
    let trimmed = message.trim();
    if trimmed != "y" && trimmed != "n" {
        return Err(
            "send_raw_stdin only accepts 'y' or 'n' (legacy interactive approval); \
             use send_stdin / respond_permission for structured input"
                .to_string(),
        );
    }
    stdin_mgr.send(&session_id, &message).await
}

/// Respond to a structured permission request from the SDK control protocol.
/// Called by the frontend when the user approves or denies a tool use.
///
/// IMPORTANT: The SDK always sends `updatedInput` with the original tool input when allowing.
/// CLI internally relies on this field. For deny, only `message` is included.
/// Format mirrors exactly what the SDK constructs (from reverse-engineered source).
#[tauri::command]
pub async fn respond_permission(
    process_mgr: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    request_id: String,
    allow: bool,
    message: Option<String>,
    tool_use_id: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    // Check which backend this session uses
    let backend_name = process_mgr.get_backend(&session_id).await;

    if backend_name.as_deref() == Some("codex") {
        // M4: codex permission requests are registered in start_codex_session
        // (lib.rs, out of scope for this module's registry). Their request_ids
        // are JSON-RPC integer ids (backends/codex.rs translate_approval_request)
        // — enforce that format as the codex-side guard.
        if request_id.is_empty()
            || request_id.len() > 64
            || !request_id.chars().all(|c| c.is_ascii_digit())
        {
            return Err(format!("Invalid codex permission request id: {}", request_id));
        }
        // Codex: use JSON-RPC response format
        let backend = crate::backends::resolve_backend(Some("codex"));
        let behavior = if allow {
            backends::PermissionBehavior::Allow
        } else {
            backends::PermissionBehavior::Deny
        };
        let msg = backend.build_permission_response(
            &request_id,
            behavior,
            updated_input,
            tool_use_id.as_deref(),
        );
        stdin_mgr.send(&session_id, &msg).await
    } else {
        // M4: only answer permission requests that were actually routed to the
        // frontend (registered in the stdout reader when the can_use_tool
        // event was emitted). Unknown or expired request_ids are rejected —
        // an arbitrary control_response can no longer be injected. The entry
        // is consumed only after the write succeeds so a transient send
        // failure does not break the frontend retry flow.
        if !pending_permission_request_exists(&session_id, &request_id) {
            return Err(format!(
                "Unknown or expired permission request: {}",
                request_id
            ));
        }
        // Claude: use SDK control protocol format
        let mut inner = serde_json::Map::new();
        if allow {
            inner.insert("behavior".into(), Value::String("allow".into()));
            inner.insert(
                "updatedInput".into(),
                updated_input.unwrap_or(Value::Object(serde_json::Map::new())),
            );
        } else {
            inner.insert("behavior".into(), Value::String("deny".into()));
            inner.insert(
                "message".into(),
                Value::String(message.unwrap_or_else(|| "User denied this operation".into())),
            );
        }
        if let Some(ref tuid) = tool_use_id {
            inner.insert("toolUseID".into(), Value::String(tuid.clone()));
        }

        let resp = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": inner,
            }
        });
        let json_str = resp.to_string();
        let result = stdin_mgr.send(&session_id, &json_str).await;
        if result.is_ok() {
            consume_pending_permission_request(&session_id, &request_id);
        }
        result
    }
}

/// Send a runtime control request to the CLI (set_permission_mode, set_model, interrupt).
#[tauri::command]
pub async fn send_control_request(
    process_mgr: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    subtype: String,
    payload: Value,
) -> Result<(), String> {
    // Check which backend this session uses
    let backend_name = process_mgr.get_backend(&session_id).await;
    let is_codex = backend_name.as_deref() == Some("codex");

    if is_codex {
        let backend = crate::backends::resolve_backend(Some("codex"));
        let msg = match subtype.as_str() {
            "interrupt" => backend.build_interrupt_message(),
            "set_permission_mode" => {
                let mode = payload
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                backend.build_set_permission_mode_message(mode)
            }
            "set_model" => {
                let model = payload
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                backend.build_set_model_message(model)
            }
            "rewind_files" => {
                let user_message_id = payload
                    .get("user_message_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                backend.build_rewind_message(user_message_id)
            }
            other => return Err(format!("Unknown control request subtype: {}", other)),
        };
        if msg.is_empty() {
            return Ok(()); // Operation not supported, silently succeed
        }
        stdin_mgr.send(&session_id, &msg).await
    } else {
        // Claude: use SDK control protocol
        use crate::protocol::ControlRequest;
        let req = match subtype.as_str() {
            "interrupt" => ControlRequest::interrupt(),
            "set_permission_mode" => {
                let mode = payload
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing 'mode' in payload")?
                    .to_string();
                ControlRequest::set_permission_mode(mode)
            }
            "set_model" => {
                let model = payload
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                ControlRequest::set_model(model)
            }
            "rewind_files" => {
                let user_message_id = payload
                    .get("user_message_id")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing 'user_message_id' in payload")?
                    .to_string();
                ControlRequest::rewind_files(user_message_id)
            }
            other => return Err(format!("Unknown control request subtype: {}", other)),
        };
        let json_str = serde_json::to_string(&req)
            .map_err(|e| format!("Failed to serialize control request: {}", e))?;
        stdin_mgr.send(&session_id, &json_str).await
    }
}

#[tauri::command]
pub async fn kill_session(
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    proxy_mgr: State<'_, crate::commands::anthropic_proxy::ProxyManager>,
    session_id: String,
) -> Result<(), String> {
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;
    proxy_mgr.stop(&session_id).await;
    Ok(())
}

/// TK-329: List all active stdinIds from ProcessManager.
/// Frontend uses this after refresh to detect and clean up orphaned backend processes.
#[tauri::command]
pub async fn list_active_processes(state: State<'_, ProcessManager>) -> Result<Vec<String>, String> {
    Ok(state.active_ids().await)
}

/// Path to the file tracking Little Claude-managed session IDs
pub(crate) fn tracked_sessions_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(crate::safe_data_dir_name()).join("tracked_sessions.txt")
}

/// Load the set of tracked session IDs.
/// If the tracking file is missing or empty, rebuild from ~/.claude/projects/
/// to recover from index loss (e.g., after update, disk issue, new machine).
pub(crate) fn load_tracked_sessions() -> std::collections::HashSet<String> {
    use std::io::BufRead;
    let path = tracked_sessions_path();
    let mut set = std::collections::HashSet::new();
    if let Ok(file) = std::fs::File::open(&path) {
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let trimmed = line.trim().to_string();
            if !trimmed.is_empty() {
                set.insert(trimmed);
            }
        }
    }

    // Fallback: if tracking file is missing/empty, rebuild from disk.
    // Use session_names.json (tokenicode_session_names.json) as a filter to avoid
    // importing Claude Code CLI or Her sessions. Only if session_names is also
    // missing do we fall back to importing all sessions (better than losing data).
    if set.is_empty() {
        if let Some(home) = dirs::home_dir() {
            let claude_projects = home.join(".claude").join("projects");
            if !claude_projects.exists() {
                return set;
            }

            // Load session_names as ownership filter (only sessions this app touched)
            let names_filter: Option<std::collections::HashSet<String>> =
                session_names_path().ok().and_then(|p| {
                    std::fs::read_to_string(&p).ok().and_then(|content| {
                        serde_json::from_str::<serde_json::Value>(&content)
                            .ok()
                            .map(|v| {
                                v.as_object()
                                    .map(|obj| obj.keys().cloned().collect())
                                    .unwrap_or_default()
                            })
                    })
                });

            if let Ok(entries) = std::fs::read_dir(&claude_projects) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        if let Ok(files) = std::fs::read_dir(entry.path()) {
                            for file in files.flatten() {
                                let p = file.path();
                                if p.extension().map_or(false, |e| e == "jsonl") {
                                    if let Some(stem) = p.file_stem() {
                                        let id = stem.to_string_lossy().to_string();
                                        if id.starts_with("desk_") {
                                            continue;
                                        }
                                        if let Some(ref filter) = names_filter {
                                            if filter.contains(&id) {
                                                set.insert(id);
                                            }
                                        } else {
                                            set.insert(id);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if !set.is_empty() {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                use std::io::Write;
                if let Ok(mut f) = std::fs::File::create(&path) {
                    for id in &set {
                        let _ = writeln!(f, "{}", id);
                    }
                }
                let mode = if names_filter.is_some() {
                    "filtered by session_names"
                } else {
                    "all (no filter)"
                };
                eprintln!(
                    "[LITTLECLAUDE] Rebuilt tracked_sessions.txt: {} sessions ({})",
                    set.len(),
                    mode
                );
            }
        }
    }

    set
}

/// Register a CLI session ID as managed by Little Claude
#[tauri::command]
pub async fn track_session(session_id: String) -> Result<(), String> {
    // Defense-in-depth: never persist desk-generated temporary IDs
    if session_id.starts_with("desk_") {
        return Ok(());
    }
    let path = tracked_sessions_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create safe data dir: {}", e))?;
    }
    // File is append-only; dedupe here (instead of only at startup cleanup)
    // to prevent duplicate lines accumulating over long-running sessions.
    use std::io::BufRead;
    if let Ok(file) = std::fs::File::open(&path) {
        let already_tracked = std::io::BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .any(|l| l.trim() == session_id);
        if already_tracked {
            return Ok(());
        }
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open tracked sessions: {}", e))?;
    writeln!(file, "{}", session_id).map_err(|e| format!("Failed to write session ID: {}", e))?;
    Ok(())
}

/// One-time cleanup: remove desk_* entries and duplicates from tracked_sessions.txt.
/// Uses atomic write (write to temp file, then rename) to prevent truncation on crash.
pub(crate) fn cleanup_tracked_sessions() {
    let path = tracked_sessions_path();
    if !path.exists() {
        return;
    }
    use std::io::{BufRead, Write};
    let lines: Vec<String> = match std::fs::File::open(&path) {
        Ok(f) => std::io::BufReader::new(f).lines().map_while(Result::ok).collect(),
        Err(_) => return,
    };
    let mut seen = std::collections::HashSet::new();
    let clean: Vec<&String> = lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with("desk_") && seen.insert(t.to_string())
        })
        .collect();
    if clean.len() < lines.len() {
        // Atomic write: temp file + rename to prevent truncation
        let tmp = path.with_extension("txt.tmp");
        if let Ok(mut f) = std::fs::File::create(&tmp) {
            for line in &clean {
                let _ = writeln!(f, "{}", line.trim());
            }
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Delete a session: remove from tracking file and delete the .jsonl file
#[tauri::command]
pub async fn delete_session(session_id: String, session_path: String) -> Result<(), String> {
    // Remove from tracking file
    let track_path = tracked_sessions_path();
    if track_path.exists() {
        use std::io::BufRead;
        let contents: Vec<String> = {
            let file = std::fs::File::open(&track_path)
                .map_err(|e| format!("Failed to read tracked sessions: {}", e))?;
            std::io::BufReader::new(file)
                .lines()
                .map_while(Result::ok)
                .filter(|line| line.trim() != session_id)
                .collect()
        };
        // Atomic write: temp file + rename to prevent truncation on crash
        let tmp = track_path.with_extension("txt.tmp");
        std::fs::write(&tmp, contents.join("\n") + "\n")
            .map_err(|e| format!("Failed to write tracked sessions: {}", e))?;
        std::fs::rename(&tmp, &track_path)
            .map_err(|e| format!("Failed to rename tracked sessions: {}", e))?;
    }
    // Delete the .jsonl file  --?validate path is under ~/.claude/projects/ (P0-1 fix)
    if !session_path.is_empty() {
        let target = std::path::Path::new(&session_path);
        if target.exists() {
            let canonical = target
                .canonicalize()
                .map_err(|e| format!("Failed to canonicalize path: {}", e))?;
            let home = dirs::home_dir().ok_or("Cannot find home dir")?;
            // Canonicalize the allowed dir too: on Windows canonicalize()
            // returns a \\?\ verbatim path, which never starts_with() a bare
            // path -- the comparison would reject every legitimate delete.
            let allowed_dir = std::fs::canonicalize(home.join(".claude").join("projects"))
                .map_err(|e| format!("Failed to canonicalize allowed dir: {}", e))?;
            if !canonical.starts_with(&allowed_dir) {
                return Err(format!(
                    "Refusing to delete file outside ~/.claude/projects/: {:?}",
                    canonical
                ));
            }
            std::fs::remove_file(&canonical)
                .map_err(|e| format!("Failed to delete session file: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<Value>, String> {
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let claude_dir = home.join(".claude").join("projects");

    if !claude_dir.exists() {
        return Ok(vec![]);
    }

    // Only show sessions tracked by Little Claude
    let tracked = load_tracked_sessions();

    let mut sessions = vec![];
    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().map_or(false, |e| e == "jsonl") {
                            if let Some(name) = path.file_stem() {
                                let id = name.to_string_lossy().to_string();

                                // Skip sessions not created by Little Claude
                                if !tracked.contains(&id) {
                                    continue;
                                }

                                // Get file metadata for timestamp
                                let modified = std::fs::metadata(&path)
                                    .and_then(|m| m.modified())
                                    .ok()
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);

                                // Read first few lines to extract preview, cwd, and origin
                                // (报告B4: cache-aware — unchanged files skip the re-read)
                                let (preview, cwd, origin) = extract_session_info_cached(&path);

                                // Use cwd from JSONL if available (authoritative),
                                // otherwise fall back to decoding the directory name.
                                let project_dir = entry.file_name().to_string_lossy().to_string();
                                let project_name = if cwd.is_empty() {
                                    decode_project_name(&project_dir)
                                } else {
                                    cwd
                                };

                                sessions.push(serde_json::json!({
                                    "id": id,
                                    "path": path.to_string_lossy(),
                                    "project": project_name,
                                    "projectDir": project_dir,
                                    "modifiedAt": modified,
                                    "preview": preview,
                                    "origin": if origin.is_empty() { "claude".to_string() } else { origin },
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by modified time, newest first
    sessions.sort_by(|a, b| {
        let ta = a["modifiedAt"].as_u64().unwrap_or(0);
        let tb = b["modifiedAt"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    Ok(sessions)
}


// 报告B4: session-info cache keyed by (mtime, size) — list_sessions/search
// used to re-open and re-parse every tracked .jsonl (up to 100 lines each) on
// every refresh, i.e. hundreds of file opens + JSON parses per call. With the
// cache, an unchanged file costs one metadata() call. Entries are invalidated
// by any mtime or size change (append-only JSONL growth changes the size).
#[derive(Clone)]
struct SessionInfoCacheEntry {
    mtime_ns: u64,
    size: u64,
    preview: String,
    cwd: String,
    origin: String,
}

static SESSION_INFO_CACHE: OnceLock<Mutex<HashMap<String, SessionInfoCacheEntry>>> = OnceLock::new();

fn session_info_cache() -> &'static Mutex<HashMap<String, SessionInfoCacheEntry>> {
    SESSION_INFO_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cache-aware wrapper around [`extract_session_info`]. Returns cached
/// (preview, cwd, origin) when the file's mtime+size are unchanged.
pub(crate) fn extract_session_info_cached(path: &std::path::Path) -> (String, String, String) {
    let key = path.to_string_lossy().to_string();
    let (mtime_ns, size) = match std::fs::metadata(path) {
        Ok(m) => (
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0),
            m.len(),
        ),
        Err(_) => (0, 0),
    };
    {
        let cache = session_info_cache().lock().unwrap();
        if let Some(entry) = cache.get(&key) {
            if entry.mtime_ns == mtime_ns && entry.size == size {
                return (entry.preview.clone(), entry.cwd.clone(), entry.origin.clone());
            }
        }
    }
    let (preview, cwd, origin) = extract_session_info(path);
    // Bound the cache so deleted sessions can't leak entries forever.
    {
        let mut cache = session_info_cache().lock().unwrap();
        if cache.len() > 2000 {
            cache.clear();
        }
        cache.insert(
            key,
            SessionInfoCacheEntry {
                mtime_ns,
                size,
                preview: preview.clone(),
                cwd: cwd.clone(),
                origin: origin.clone(),
            },
        );
    }
    (preview, cwd, origin)
}

/// Extract preview (first user message) and cwd from a session .jsonl file.
/// Returns (preview, cwd)  --?cwd may be empty if not found.
pub(crate) fn extract_session_info(path: &std::path::Path) -> (String, String, String) {
    use std::io::BufRead;
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (String::new(), String::new(), String::new()),
    };
    let reader = std::io::BufReader::new(file);
    let mut cwd = String::new();
    let mut preview = String::new();
    let mut origin = String::new();

    // Scan up to 100 lines to find cwd and first real user message.
    for line in reader.lines().take(100) {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let json = match serde_json::from_str::<Value>(&line) {
            Ok(j) => j,
            Err(_) => continue,
        };

        // Extract cwd from the first line that has it
        if cwd.is_empty() {
            if let Some(c) = json["cwd"].as_str() {
                if !c.is_empty() {
                    cwd = c.to_string();
                }
            }
        }

        // Extract _origin from system/init line (which CLI backend created this session)
        if origin.is_empty() {
            if let Some(o) = json["_origin"].as_str() {
                if !o.is_empty() {
                    origin = o.to_string();
                }
            }
        }

        // Extract preview from first user message
        if preview.is_empty() {
            let is_user = json["type"].as_str() == Some("human")
                || json["type"].as_str() == Some("user")
                || json["role"].as_str() == Some("user")
                || json["message"]["role"].as_str() == Some("user");

            if !is_user {
                continue;
            }

            // Try to extract text from message.content array
            if let Some(content) = json["message"]["content"].as_array() {
                // First pass: look for direct text blocks
                for block in content {
                    if let Some(text) = block["text"].as_str() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            preview = trimmed.chars().take(120).collect();
                            break;
                        }
                    }
                }
                // Second pass: look for text inside nested content
                if preview.is_empty() {
                    for block in content {
                        if let Some(inner) = block["content"].as_array() {
                            for inner_block in inner {
                                if let Some(text) = inner_block["text"].as_str() {
                                    let trimmed = text.trim();
                                    if !trimmed.is_empty() {
                                        preview = trimmed.chars().take(120).collect();
                                        break;
                                    }
                                }
                            }
                            if !preview.is_empty() {
                                break;
                            }
                        }
                        if let Some(text) = block["content"].as_str() {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                preview = trimmed.chars().take(120).collect();
                                break;
                            }
                        }
                    }
                }
            }
            // Try direct content string
            if preview.is_empty() {
                if let Some(text) = json["message"]["content"].as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        preview = trimmed.chars().take(120).collect();
                    }
                }
            }
        }

        // Stop early if we have both
        if !cwd.is_empty() && !preview.is_empty() {
            break;
        }
    }
    (preview, cwd, origin)
}

/// Decode project directory name back to readable path.
///
/// Claude CLI encodes paths by replacing `/` with `-`, e.g.:
///   /Users/tinyzhuang/Desktop/ppt-maker  --?-Users-tinyzhuang-Desktop-ppt-maker
///
/// Simple `.replace('-', '/')` fails when directory names contain hyphens
/// (e.g. "ppt-maker" becomes "ppt/maker").
///
/// Claude CLI encodes project paths by replacing `/`, `.`, and ` ` (space)
/// with `-`. This is lossy: "a-b" could mean "a/b", "a.b", "a b", or literal
/// "a-b". We resolve ambiguity via greedy filesystem probing.
///
/// Strategy: greedily match real filesystem segments from left to right.
/// At each position, try the longest possible segment first.  For each
/// candidate span of dash-separated parts, try joining them with the
/// original `-`, then ` ` (space), then `.`  --?whichever produces a path
/// that actually exists on disk wins.
/// Encode a filesystem path to Claude project directory name.
/// Reverse of `decode_project_name`.
///
/// Claude CLI encodes by replacing `\`, `:`, `/`, `.`, and ` ` (space)
/// with `-`. No normalization to forward slashes first  --?each char is
/// independently replaced.
///
/// Unix:     /Users/a/my-app  --?-Users-a-my-app
/// Windows:  C:\Users\a\my-app  --?C--Users-a-my-app
/// Windows:  D:\agent self\agent\tokenicode-src  --?D--agent-self-agent-tokenicode-src
pub(crate) fn encode_project_name(path: &str) -> String {
    let mut result = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '\\' | ':' | '/' | '.' | ' ' => result.push('-'),
            _ => result.push(ch),
        }
    }
    result
}

pub(crate) fn decode_project_name(encoded: &str) -> String {
    // Detect Windows-style encoded paths: "C-Users-..." (drive letter prefix without leading dash)
    // vs Unix-style: "-Users-..." (leading dash = root /)
    let is_windows_path = encoded.len() >= 2
        && encoded.as_bytes()[0].is_ascii_alphabetic()
        && encoded.as_bytes()[1] == b'-';

    let (trimmed, root, sep) = if is_windows_path {
        // Windows: "C--Users-foo"  -> root = "C:\", rest = "Users-foo"
        // `:` and `\` both encode to '-', so "C:\Users" becomes "C--Users":
        // skipping "C-" leaves a leading '-' (from ":\") that must be
        // stripped too — otherwise the first split part is empty and greedy
        // matching latches onto the drive root, scrambling the whole path.
        let drive = &encoded[0..1];
        let rest = encoded[2..].strip_prefix('-').unwrap_or(&encoded[2..]);
        (rest, format!("{}:\\", drive), "\\")
    } else {
        // Unix: "-Users-foo"  --?root = "/", rest = "Users-foo"
        let rest = encoded.strip_prefix('-').unwrap_or(encoded);
        (rest, "/".to_string(), "/")
    };

    let parts: Vec<&str> = trimmed.split('-').collect();

    if parts.is_empty() {
        return encoded.to_string();
    }

    let mut decoded_segments: Vec<String> = Vec::new();
    let mut i = 0;

    while i < parts.len() {
        let mut best_len = 1;
        let mut best_segment = parts[i].to_string();

        // Build the parent path for existence checking
        let parent = if decoded_segments.is_empty() {
            root.clone()
        } else {
            format!("{}{}", root, decoded_segments.join(sep))
        };

        // Try combining parts[i..j], longest first.
        // For each candidate length, try multiple join separators.
        let max_j = parts.len().min(i + 10); // limit lookahead
        let mut found = false;
        'outer: for j in (i + 1..=max_j).rev() {
            let slice = &parts[i..j];
            // Separators to try: hyphen (original name), space, dot
            for join_sep in ["-", " ", "."] {
                let candidate = slice.join(join_sep);
                // An all-empty slice (single encoded empty part) joins to ""
                // — that resolves to the parent directory itself and would
                // ALWAYS "match", swallowing the empty part and skipping the
                // hidden-dir branch below (e.g. ".claude-worktrees" decoded
                // as "claude/worktrees"). Leave it for that branch instead.
                if candidate.is_empty() {
                    continue;
                }
                // On Windows, paths with trailing spaces/dots are normalized
                // away by the filesystem ("FocusZone " and "FocusZone."
                // resolve to "FocusZone") — such candidates fake-match the
                // parent directory itself. Real Windows dirs can't end in
                // space/dot (creation strips them), so skipping is safe.
                if candidate.ends_with(' ') || candidate.ends_with('.') {
                    #[cfg(windows)]
                    {
                        continue;
                    }
                }
                let full_path = format!(
                    "{}{}{}",
                    parent,
                    if parent.ends_with(sep) { "" } else { sep },
                    candidate
                );
                if std::path::Path::new(&full_path).exists() {
                    best_len = j - i;
                    best_segment = candidate;
                    found = true;
                    break 'outer;
                }
            }
        }

        // Handle empty parts from consecutive dashes (e.g. "/." encoded as "--").
        // If we're at an empty part and no filesystem match was found, try
        // prepending a "." to the next segment (hidden dirs like .claude).
        if !found && parts[i].is_empty() {
            // Collect consecutive empty parts (each represents one encoded char)
            let start = i;
            while i < parts.len() && parts[i].is_empty() {
                i += 1;
            }
            let dot_count = i - start; // number of dots/special chars

            if i < parts.len() {
                // Try interpreting as dot-prefixed segment:
                // e.g. empty + "claude-worktrees"  --?".claude-worktrees"
                let prefix = ".".repeat(dot_count);
                // Greedy match on the remaining parts after the dots
                let remaining_max = parts.len().min(i + 10);
                let mut dot_found = false;
                for j in (i + 1..=remaining_max).rev() {
                    for join_sep in ["-", " ", "."] {
                        let after = parts[i..j].join(join_sep);
                        let candidate = format!("{}{}", prefix, after);
                        let full_path = format!(
                            "{}{}{}",
                            parent,
                            if parent.ends_with(sep) { "" } else { sep },
                            candidate
                        );
                        if std::path::Path::new(&full_path).exists() {
                            decoded_segments.push(candidate);
                            i = j;
                            dot_found = true;
                            break;
                        }
                    }
                    if dot_found {
                        break;
                    }
                }
                if !dot_found {
                    // Fallback: just use dot + next part as segment
                    let candidate = format!("{}{}", prefix, parts[i]);
                    decoded_segments.push(candidate);
                    i += 1;
                }
            } else {
                // Trailing empty parts  --?append dots to last segment or ignore
                if let Some(prev) = decoded_segments.last_mut() {
                    prev.push_str(&".".repeat(dot_count));
                }
            }
            continue;
        }

        decoded_segments.push(best_segment);
        i += best_len;
    }

    format!("{}{}", root, decoded_segments.join(sep))
}

/// Redact sensitive values inside `--settings` args for stderr logging.
/// The real args contain the API key inside the settings JSON; the env dump
/// below already masks key-like vars, so this keeps the args line in parity.
fn redact_args_for_log(args: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--settings" {
            out.push(arg.clone());
            if let Some(next) = args.get(i + 1) {
                out.push(redact_settings_json(next));
                i += 1;
            }
        } else if let Some(rest) = arg.strip_prefix("--settings=") {
            out.push(format!("--settings={}", redact_settings_json(rest)));
        } else {
            out.push(arg.clone());
        }
        i += 1;
    }
    out
}

/// Mask values of key/token/secret-ish fields in a settings JSON string.
fn redact_settings_json(json_str: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(json_str) {
        Ok(mut v) => {
            if let Some(env) = v
                .as_object_mut()
                .and_then(|obj| obj.get_mut("env"))
                .and_then(|e| e.as_object_mut())
            {
                for (k, val) in env.iter_mut() {
                    let up = k.to_ascii_uppercase();
                    if up.contains("API_KEY")
                        || up.contains("TOKEN")
                        || up.contains("SECRET")
                        || up.contains("PASSWORD")
                    {
                        *val = serde_json::Value::String("***".to_string());
                    }
                }
            }
            v.to_string()
        }
        Err(_) => "***".to_string(),
    }
}

#[tauri::command]
pub async fn load_session(path: String) -> Result<Vec<Value>, String> {
    use std::io::BufRead;

    // Only allow loading sessions inside the canonical ~/.claude/projects tree
    // (the same tree list_sessions scans). This blocks arbitrary-path reads.
    let p = std::path::Path::new(&path);
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let projects_root = home.join(".claude").join("projects");
    let root_c = projects_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve projects dir: {}", e))?;
    let parent_c = p
        .parent()
        .and_then(|par| par.canonicalize().ok())
        .ok_or_else(|| format!("Invalid session path: {}", path))?;
    if !parent_c.starts_with(&root_c) {
        return Err(format!(
            "Refusing to load session outside ~/.claude/projects: {}",
            path
        ));
    }

    // Cap file size so a huge/foreign file can't OOM the parser (50 MiB).
    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to stat session: {}", e))?;
    if meta.len() > 50 * 1024 * 1024 {
        return Err(format!(
            "Session file too large to load ({} bytes, max 50 MiB)",
            meta.len()
        ));
    }

    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut messages = vec![];
    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                messages.push(json);
            }
        }
    }
    Ok(messages)
}

/// System-injected user lines the frontend's session-loader filters out
/// (mirror of `isSystemText` in session-loader.ts): continuation summaries,
/// `<task-notification>` payloads, tool-definition dumps, raw "Human:" leaks.
/// These must NOT count as user turns, or rewind truncation would land one
/// turn off whenever a compaction happened mid-session.
fn is_system_text(t: &str) -> bool {
    let t = t.trim_start();
    t.starts_with('<')
        || t.starts_with("This session is being continued")
        || t.starts_with("Analysis:")
        || t.starts_with("Summary:")
        || t.starts_with("In this environment you have access to")
        || t.starts_with("Human:")
        || t.contains("<system-reminder>")
        || t.contains("</system-reminder>")
}

/// Does this user line represent a REAL user turn (as the frontend counts
/// them)? True only for lines whose message content is plain text (string or
/// `text` blocks) that is non-empty and not system-injected. Tool-result
/// lines are `"type":"user"` with `"userType":"external"` in CLI 2.1.220's
/// SDK mode, but their content is `tool_result` blocks — not a turn.
fn is_real_user_turn(v: &Value) -> bool {
    let Some(content) = v.pointer("/message/content") else {
        return false;
    };
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for b in arr {
            let Some(bt) = b.get("type").and_then(|x| x.as_str()) else {
                continue;
            };
            if bt == "tool_result" {
                return false;
            }
            if bt == "text" {
                if let Some(tx) = b.get("text").and_then(|x| x.as_str()) {
                    buf.push_str(tx);
                }
            }
        }
        buf
    } else {
        return false;
    };
    !text.trim().is_empty() && !is_system_text(&text)
}

/// Pure truncation logic for a CLI session JSONL string, separated from the
/// command's IO so it can be unit-tested.
///
/// Drops every line from the `truncate_before_turn`-th user turn (1-based)
/// onward. "User turn" uses the same definition as the frontend's
/// session-loader (plain-text, non-system-injected `type:"user"` +
/// `userType:"external"` lines), so the turn index aligns with the
/// RewindPanel's turn list.
///
/// Returns `Some(kept)` with the truncated content, or `None` when the
/// history is completely empty (rewound before turn 1 → the caller should
/// delete the file rather than write an empty one).
///
/// Rejects when the requested turn doesn't exist in the file.
pub(crate) fn truncate_jsonl_content(
    content: &str,
    truncate_before_turn: usize,
) -> Result<Option<String>, String> {
    if truncate_before_turn == 0 {
        return Err("truncate_before_turn must be >= 1".to_string());
    }

    // Split keeping original line endings (\r\n on Windows) so the written
    // file stays byte-compatible with the CLI's own parser.
    let raw_lines: Vec<&str> = content.split_inclusive('\n').collect();
    if raw_lines.is_empty() {
        return Err("Session file is empty".to_string());
    }

    // Walk lines counting real user turns.
    let mut user_turns = 0usize;
    let mut cut_at: Option<usize> = None; // index into raw_lines of the first line to drop
    for (idx, raw) in raw_lines.iter().enumerate() {
        // Trailing \r from Windows line endings is legal JSON whitespace.
        let trimmed = raw.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            let is_turn = v.get("type").and_then(|t| t.as_str()) == Some("user")
                && v.get("userType").and_then(|t| t.as_str()) == Some("external")
                && is_real_user_turn(&v);
            if is_turn {
                user_turns += 1;
                if user_turns == truncate_before_turn {
                    cut_at = Some(idx);
                    break;
                }
            }
        }
    }

    let cut_at = cut_at.ok_or_else(|| format!(
        "Session has only {} user turns; cannot truncate before turn {}",
        user_turns, truncate_before_turn
    ))?;

    if cut_at == 0 {
        // Rewound to the very first turn: the whole history is dropped.
        return Ok(None);
    }

    Ok(Some(raw_lines[..cut_at].concat()))
}

/// Truncate a Claude CLI session's JSONL file to just before the given user
/// turn, so `claude --resume <session_id>` afterwards rebuilds only the
/// pre-rewind history (the rewind feature's file restore rewinds checkpoints
/// but NOT the conversation — the CLI session file still holds every turn).
///
/// Returns:
/// - `Ok(Some(kept_lines))` — file truncated in place
/// - `Ok(None)` — history fully cleared (rewound to turn 1); file deleted,
///   the frontend must clear sessionId so nothing tries to resume it
#[tauri::command]
pub async fn truncate_session_history(
    session_id: String,
    project_dir: String,
    truncate_before_turn: usize,
) -> Result<Option<usize>, String> {
    // UUID-like validation (mirrors rewind_files) — also keeps the path
    // join below inside ~/.claude/projects/ (no traversal possible).
    fn is_uuid_like(s: &str) -> bool {
        s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    }
    if !is_uuid_like(&session_id) {
        return Err(format!("Invalid session_id format: {}", session_id));
    }

    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let projects_root = home.join(".claude").join("projects");
    let encoded = encode_project_name(&project_dir);
    let path = projects_root
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));

    // Cap size (mirrors load_session) so a huge file can't OOM the read.
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to stat session file: {}", e))?;
    if meta.len() > 50 * 1024 * 1024 {
        return Err(format!(
            "Session file too large to truncate ({} bytes, max 50 MiB)",
            meta.len()
        ));
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read session file: {}", e))?;

    match truncate_jsonl_content(&content, truncate_before_turn)? {
        None => {
            // Whole history gone — delete the file instead of writing an
            // empty one; the CLI would fail to resume a missing/empty session.
            std::fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete session file: {}", e))?;
            Ok(None)
        }
        Some(kept) => {
            let kept_lines = kept.split_inclusive('\n').count();
            std::fs::write(&path, kept)
                .map_err(|e| format!("Failed to write truncated session: {}", e))?;
            Ok(Some(kept_lines))
        }
    }
}
