
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use tokio::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::commands::claude_process::{ManagedProcess, ProcessManager, SessionInfo, StartSessionParams, StdinManager};
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
// User feedback: 5 minutes was too aggressive — a permission/question card
// left unanswered while the user reads/thinks/steps away expired, and the
// late click failed with "Unknown or expired permission request" (surfaced
// as the generic "出了点问题" fallback). The CLI itself waits indefinitely
// for the response, so a longer TTL matches reality; the registry still
// rejects ids that were never issued by the CLI.
const PERMISSION_REQUEST_TTL_SECS: u64 = 60 * 60;

/// cmd /C re-parses the command line: a model/tool/permission value
/// containing cmd metacharacters (& | < > ^ % " etc.) could inject
/// extra commands. Model names and tool names are enumerated values —
/// reject anything outside a safe charset instead of trying to escape.
/// Shared by session start (start_claude_session) and the one-shot title
/// generation process (metadata.rs) — both can end up in a cmd /C wrapper.
pub(crate) fn cmd_arg_safe(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:/@[]()".contains(c))
}

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

    // B1: register this session's project root so the file commands'
    // authorized-path gate accepts files under it. Rust-internal — there is
    // deliberately no IPC path that can add roots.
    crate::commands::files::register_project_root(std::path::Path::new(&params.cwd));

    // ─── CLI Backend routing ────────────────────────────────────────────
    let mut cli_backend = params.cli_backend.as_deref().unwrap_or("claude").to_string();

    // Only route to a non-default backend if the provider explicitly declares
    // it: cli_backend="codex" or (T05) cli_backend="deepseek". api_format alone
    // does NOT force a backend — some OpenAI-format endpoints also accept
    // Anthropic-format requests, and users should be able to choose Claude CLI.
    if cli_backend != "codex" && cli_backend != "deepseek" {
        if let Some(ref provider_id) = params.provider_id {
            if let Ok(providers_file) = crate::commands::provider::load_providers() {
                if let Some(provider) = providers_file.providers.iter().find(|p| p.id == *provider_id) {
                    if provider.cli_backend.as_deref() == Some("codex") {
                        eprintln!(
                            "[LITTLECLAUDE:session] Routing to codex backend (provider '{}' declares cli_backend='codex')",
                            provider.name
                        );
                        cli_backend = "codex".to_string();
                    } else if provider.cli_backend.as_deref() == Some("deepseek") {
                        // T05: same rule for the DSH backend — a provider that
                        // declares cli_backend="deepseek" rides the dsh service
                        // even when the header/backend param still says claude.
                        eprintln!(
                            "[LITTLECLAUDE:session] Routing to deepseek backend (provider '{}' declares cli_backend='deepseek')",
                            provider.name
                        );
                        cli_backend = "deepseek".to_string();
                    }
                }
            }
        }
    }

    if cli_backend == "codex" {
        // H2: 先递增代际再杀旧进程——旧 stdout reader 在 EOF 后据此识别自己已
        // 过期（不再清理新会话的句柄、不 emit 伪 process_exit）。若先杀后递增，
        // 旧 reader 可能在递增前抢先通过校验完成清理。
        // codex 分支无 %VAR% 检查，直接在此 bump+kill；claude 路径的 bump+kill
        // 推迟到 %VAR% 检查通过之后（低 7：检查拒绝时旧进程不被杀）。
        let generation = crate::bump_session_generation(&session_id);
        stdin_mgr.remove(&session_id).await;
        state.remove(&session_id).await;
        return crate::start_codex_session(app, state, stdin_mgr, params, session_id, generation)
            .await;
    }

    if cli_backend == "deepseek" {
        // D-N1-B service mode: no per-session process — the tab reuses its
        // DSH session for real context continuity, so no generation bump or
        // process teardown here (first message creates the session, later
        // ones go through send_stdin → session.prompt on the same session).
        return crate::start_deepseek_session(app, state, stdin_mgr, params, session_id, 0).await;
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

    // A2/P3: --include-partial-messages is now opt-IN (default false) —
    // the per-token delta events multiply IPC traffic 10-50×, and the
    // frontend's 150ms full-message flush already keeps streaming smooth.
    // Users who want maximum smoothness can re-enable it in Settings.
    if params.include_partial_messages.unwrap_or(false) {
        args.push("--include-partial-messages".to_string());
    }

    // cmd /C re-parses the command line: a model/tool/permission value
    // containing cmd metacharacters (& | < > ^ % " etc.) could inject
    // extra commands. Model names and tool names are enumerated values —
    // reject anything outside a safe charset instead of trying to escape.
    // (Implementation lives at module level so metadata.rs's one-shot title
    // process shares the same guard.)

    // Resume an existing CLI session if requested
    eprintln!("[LITTLECLAUDE] resume_session_id={:?}", params.resume_session_id);
    if let Some(ref resume_id) = params.resume_session_id {
        // H3: UUID 格式校验（与 truncate_session_history/rewind_files 一致）。
        // resume_session_id 直接拼进命令行，cmd /C 包装下会被重新解析——
        // 非 UUID 串（含空格/&/| 等）可注入额外参数。
        fn is_uuid_like(s: &str) -> bool {
            s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        }
        if !is_uuid_like(resume_id) {
            return Err(format!("Invalid resume_session_id format: {}", resume_id));
        }
        args.push("--resume".to_string());
        args.push(resume_id.clone());
    }

    // --model is added later after provider resolution (see below)

    if let Some(ref tools) = params.allowed_tools {
        for tool in tools {
            // cmd /C injection guard — see cmd_arg_safe above.
            if !cmd_arg_safe(tool) {
                return Err(format!("Invalid tool name: {}", tool));
            }
            args.push("--allowedTools".to_string());
            args.push(tool.clone());
        }
    }

    // Permission mode: all modes use --permission-prompt-tool stdio so the CLI
    // routes user interactions (AskUserQuestion, ExitPlanMode) via control_request.
    // In bypassPermissions mode the CLI auto-approves tool permissions internally
    // (zero overhead) but still sends control_requests for user interactions.
    let permission_mode = params.permission_mode.as_deref().unwrap_or("default");
    if !cmd_arg_safe(permission_mode) {
        return Err(format!("Invalid permission mode: {}", permission_mode));
    }
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

    // ─── Local proxy (OpenAI-format conversion only) ──────────────────
    // Claude CLI only speaks the Anthropic Messages API. When the provider
    // exposes ONLY an OpenAI-compatible endpoint (api_format = "openai"),
    // start a local proxy that converts Anthropic requests to OpenAI format
    // and forwards them to the real endpoint, then converts the responses
    // back. Anthropic-format providers connect directly — no proxy.
    // Point ANTHROPIC_BASE_URL at the proxy.
    if cli_backend == "claude" {
        if let Some(ref provider_id) = params.provider_id {
            if let Ok(providers_file) = crate::commands::provider::load_providers() {
                if let Some(provider) = providers_file
                    .providers
                    .iter()
                    .find(|p| p.id == *provider_id)
                {
                    if provider.api_format == "openai" {
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
                                )
                                .await?;
                            eprintln!(
                                "[LITTLECLAUDE:proxy] Routing session {} through proxy → {}",
                                session_id, proxy_url
                            );
                            resolved_env
                                .insert("ANTHROPIC_BASE_URL".to_string(), proxy_url);
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
        // cmd /C injection guard — see cmd_arg_safe above.
        if !cmd_arg_safe(model) {
            return Err(format!("Invalid model name: {}", model));
        }
        args.push("--model".to_string());
        args.push(model.clone());
    }

    // DEBUG: print resolved provider env to console for troubleshooting
    // M2: base_url 可能内嵌 userinfo 凭据（https://user:pass@host）——打印前脱敏。
    let base_url_display = resolved_env
        .get("ANTHROPIC_BASE_URL")
        .map(|u| mask_url_userinfo(u));
    eprintln!(
        "[LITTLECLAUDE:provider] provider_id={:?}, ANTHROPIC_BASE_URL={:?}, ANTHROPIC_API_KEY={}, keys_removed={:?}",
        params.provider_id,
        base_url_display,
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

    // Write the settings JSON to a temp file and pass the path: --settings
    // accepts file-or-json, but on Windows the cmd /C wrapper (required for
    // .cmd CLIs) mangles the JSON's double quotes — cmd's batch quoting
    // rules conflict with CreateProcess's \" escaping, so the CLI receives
    // corrupted JSON and dies with "Invalid JSON provided to --settings"
    // ("CLI error: For more information, try '--help'."). A plain file path
    // has no quoting issues on any platform.
    let settings_json = settings_val.to_string();
    let settings_path = std::env::temp_dir().join(format!(
        "little-claude-settings-{}.json",
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(e) = std::fs::write(&settings_path, &settings_json) {
        return Err(format!("Failed to write settings file: {}", e));
    }
    // M1 (security): the file holds ANTHROPIC_API_KEY/AUTH_TOKEN for ~60s —
    // on multi-user Unix the default 0644 would make it world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &settings_path,
            std::fs::Permissions::from_mode(0o600),
        );
    }
    // Best-effort cleanup: the CLI reads the file at startup, so deleting
    // it 60s later is safe even for long-running sessions.
    let cleanup_path = settings_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let _ = tokio::fs::remove_file(&cleanup_path).await;
    });
    args.push("--settings".to_string());
    args.push(settings_path.to_string_lossy().to_string());

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

    // Inject the CLI's compact window ONLY for declared-1M models. The
    // frontend declares 200K for every non-1M model (getContextWindowForModel
    // has just two tiers), but 200K is a guess for unknown windows — a
    // 128K/64K gateway model (qwen/glm/DeepSeek V3-era chat/reasoner etc.)
    // forced to a 200K declaration compacts at ~160K and hits the API's
    // context-length error with no compact opportunity (and the UI's 160K
    // hint never fires either). Non-1M models keep the CLI's own conservative
    // ~80K inference (~70K compact), which never breaks a session. The
    // DeepSeek V4 family (pro/flash) is 1M-context and IS declared (mirrors
    // the frontend isLargeContextMode — keep both in sync); V3-era
    // deepseek-chat/reasoner intentionally do NOT match.
    // Resolve the declared context window:
    //  1. The frontend's explicit value (already table/learned-aware).
    //  2. The LiteLLM model-window cache (exact windows incl. 512K/262K —
    //     see model_windows.rs) — third-party providers only; the official
    //     Anthropic API's window is decided by the CLI's own first-party
    //     capability table, and a stale community entry could over-declare
    //     and make the CLI wait for an API rejection instead of compacting.
    //  3. The hardcoded 1M-family list (offline fallback, mirrors the
    //     frontend isLargeContextMode — keep both in sync).
    //  4. 200K default.
    let table_window = if params.provider_id.as_deref().is_some() {
        match params.model.as_deref() {
            Some(m) => crate::commands::model_windows::lookup_window(m).await,
            None => None,
        }
    } else {
        None
    };
    let declared_context_window = params
        .context_window
        .map(|w| w as u64)
        .or(table_window)
        .unwrap_or_else(|| {
            params
                .model
                .as_deref()
                .map(|model_name| {
                    let m = model_name.to_lowercase();
                    // Mirrors the frontend isLargeContextMode (keep both in sync).
                    // 1M-context families verified as of 2026-08; every other model
                    // keeps the 200K fallback tier (see the frontend comment for
                    // which near-1M variants intentionally do NOT match).
                    if m.contains("mimo") || m.contains("[1m]")
                        || m.starts_with("deepseek-v4") || m.contains("deepseek-v4")
                        || m.contains("qwen3.5-plus") || m.contains("qwen3.6-plus")
                        || m.contains("qwen3-coder-plus") || m.contains("glm-5.2")
                        || m.contains("kimi-k3") || m.contains("minimax-m3")
                        || m.contains("longcat-2")
                    {
                        1_000_000
                    } else {
                        200_000
                    }
                })
                .unwrap_or(200_000)
        });
    // Inject the window into the CLI for any declared window >= 200K (the
    // frontend/table may carry exact values like 262K/512K — the CLI caps its
    // own AUTO_COMPACT_WINDOW at 200K for third-party models, so declaring
    // them saves the unused context instead of compacting at ~167K). Values
    // below 200K stay un-injected and keep the CLI's conservative inference.
    if declared_context_window >= 200_000 {
        resolved_env.insert(
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW".to_string(),
            declared_context_window.to_string(),
        );
        // CLAUDE_CODE_MAX_CONTEXT_TOKENS is the only window override that
        // bypasses the CLI's >200K cap on AUTO_COMPACT_WINDOW
        // (anthropics/claude-code#57964); without it, declared-1M third-party
        // models are still treated as ~80K and compact at ~70K.
        resolved_env.insert(
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS".to_string(),
            declared_context_window.to_string(),
        );
        eprintln!(
            "[LITTLECLAUDE] Set CLAUDE_CODE_AUTO_COMPACT_WINDOW={} and CLAUDE_CODE_MAX_CONTEXT_TOKENS={} for model {:?}",
            declared_context_window, declared_context_window, params.model
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
            if let Some(url) = resolve_proxy_url().await {
                inject_proxy_env_vars(&mut resolved_env, &url);
            }
        }
    }


    // H2: 先递增代际再杀旧进程——旧 stdout reader 在 EOF 后据此识别自己已
    // 过期（不再清理新会话的句柄、不 emit 伪 process_exit）。若先杀后递增，
    // 旧 reader 可能在递增前抢先通过校验完成清理。
    // 低 7: 此处位于 %VAR% 检查之后——检查拒绝时直接返回，旧进程不被杀、
    // 代际不递增，用户原来的会话继续正常运行。
    let generation = crate::bump_session_generation(&session_id);
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;

    // On Windows, .cmd/.bat files must be launched via cmd /C
    #[cfg(target_os = "windows")]
    let mut child = {
        // Helper: build and spawn a Command for the given binary
        let spawn_win = |bin: &str| {
            let needs_cmd = crate::claude_needs_cmd_wrapper(bin);
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
            #[cfg(unix)]
            {
                // H4: new process group so kill can reap the whole tree
                // (bash/git/… spawned by the CLI). Without this, killing
                // the direct child leaves grandchildren holding the stdout
                // pipe — the reader never sees EOF and the tab hangs in
                // "running" forever.
                cmd.process_group(0);
            }
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
        // M2: 大小写不敏感匹配（自定义 env 名如 MY_VISION_KEY、apiKey 此前
        // 明文打印）——统一 to_ascii_uppercase 后匹配，关键字集补齐
        // PASSWORD/KEY/PAT。
        let upper = k.to_ascii_uppercase();
        let is_sensitive = ["API_KEY", "TOKEN", "SECRET", "PASSWORD", "KEY", "PAT"]
            .iter()
            .any(|kw| upper.contains(kw));
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
    // H2: 本 reader 属于哪一代会话——EOF 后据此判断自己是否已被新会话替代。
    let my_generation = generation;
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
                // Perf #3: align with the frontend display cap (256KB in
                // useStreamProcessor) — previously a near-2MB tool_result was
                // parsed, cloned and shipped over IPC in full only for the
                // JS side to throw away all but 256KB. Cut it here instead.
                const MAX_IPC_BYTES: usize = 1024 * 1024; // 1MB threshold
                const BLOCK_CAP: usize = 300 * 1024; // just above the JS display cap
                if serialized_len > MAX_IPC_BYTES {
                    let mut truncated = json.clone();
                    // Truncate content in tool_result blocks and message content
                    if let Some(content) = truncated.get_mut("content") {
                        truncate_large_content(content, BLOCK_CAP);
                    }
                    if let Some(msg) = truncated.get_mut("message") {
                        if let Some(content) = msg.get_mut("content") {
                            truncate_large_content(content, BLOCK_CAP);
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
                // H2: kill-rebuild 后旧 reader 会在重试循环内（最长 ~14s）继续
                // 往同名通道发旧进程事件——每轮 emit 前校验代际，过期立即返回
                // （循环外的 EOF 门控挡不住循环内的 emit）。
                if !crate::is_session_generation_current(&sid_clone, my_generation) {
                    return;
                }
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
        // H2: 同一 session_id 被重新 start 后，旧进程被杀 → 本 reader 也会走到
        // 这里。代际已递增说明本 reader 属于旧代际：若继续 remove/emit，会清掉
        // 新会话的句柄并给新会话发伪 process_exit——直接返回，交给新 reader。
        if !crate::is_session_generation_current(&sid_clone, my_generation) {
            return;
        }

        // stdout EOF —— 进程随即退出，等待真实退出码（超时视为无码）
        let exit_code = pm_clone
            .wait_status(&sid_clone, std::time::Duration::from_secs(2))
            .await;
        // M1: re-check the generation AFTER the 2s await. A restart of the
        // same session_id inside this window would otherwise let this stale
        // reader remove the NEW session's stdin/process entries and emit a
        // bogus process_exit for it (first message then fails with
        // "No stdin handle").
        if !crate::is_session_generation_current(&sid_clone, my_generation) {
            return;
        }
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
        // #25 (bug): `while let Ok(Some(..))` exited the loop on the FIRST
        // error — one GBK/non-UTF-8 stderr line (common from Windows tools)
        // permanently silenced all later stderr, including codex error
        // translation. Mirror the F1 skip-and-continue strategy from stdout.
        let mut err_count = 0u32;
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    err_count = 0;
                    let _ = emit_to_frontend(
                        &app_clone2,
                        &format!("claude:stderr:{}", sid_clone2),
                        serde_json::json!(line),
                    );
                }
                Ok(None) => break,
                Err(e) => {
                    err_count += 1;
                    eprintln!(
                        "[LITTLECLAUDE:WARN] stderr read error (consecutive #{}), skipping line: {}",
                        err_count, e
                    );
                    if err_count >= 100 {
                        break; // permanently broken pipe — stop
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            }
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
        if let Err(e) = stdin_mgr.send(&sid, &first_msg.to_string()).await {
            // L8: 发送失败时进程/句柄已注册——清理（remove 会 kill 进程，
            // reader 随后 EOF 并 emit 真实退出事件），避免残留条目与幽灵进程。
            stdin_mgr.remove(&sid).await;
            state.remove(&sid).await;
            return Err(e);
        }
    }

    Ok(SessionInfo {
        session_id: sid,
        pid,
        cli_path: claude_bin.clone(),
    })
}

#[tauri::command]
pub async fn send_stdin(
    app: AppHandle,
    process_mgr: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    message: String,
    #[allow(unused_variables)]
    mode: Option<String>, // DSH service mode only: "queue" | "steer"

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
    } else if backend_name.as_deref() == Some("deepseek") {
        // D-N1-B service mode: follow-up on the tab's DSH session (real
        // context continuity). Steer mode interrupts at the step boundary;
        // queue mode waits for the current turn. Leading "/" is handled by
        // DSH itself as a slash command.
        let dsh_mgr = app.state::<crate::commands::dsh_service::DshServiceManager>();
        let service = dsh_mgr.ensure().await?;
        let dsh_sid = process_mgr
            .get_deepseek_session(&session_id)
            .await
            .ok_or_else(|| {
                "No DSH session for this tab — send the first message first".to_string()
            })?;
        let mode = match mode.as_deref() {
            Some("steer") => "steer",
            _ => "queue",
        };
        let result = crate::commands::dsh_service::unary(
            &service.base_url,
            "session.prompt",
            serde_json::json!({
                "sessionId": dsh_sid,
                "mode": mode,
                "content": [{ "type": "text", "text": message }],
            }),
        )
        .await;
        if result.is_err() {
            // R11 (bug): the service may have been restarted under us (H1
            // respawn), orphaning this tab's DSH session on the new service.
            // Old behavior just dropped the mapping and left the tab dead
            // ("No DSH session" on every later message, context silently
            // gone). Now: rebuild a session in the same cwd, re-register the
            // route, retry THIS prompt once, and tell the user the context
            // was reset.
            let old_cwd = process_mgr.get_deepseek_session_cwd(&session_id).await;
            let old_route = {
                let routes = service.session_routes.lock().await;
                routes.get(&dsh_sid).cloned()
            };
            process_mgr.remove_deepseek_session(&session_id).await;
            service.session_routes.lock().await.remove(&dsh_sid);
            if let Some(cwd) = old_cwd {
                if let Ok(created) = crate::commands::dsh_service::unary(
                    &service.base_url,
                    "session.create",
                    serde_json::json!({ "cwd": cwd }),
                )
                .await
                {
                    if let Some(new_sid) = created
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                    {
                        process_mgr
                            .insert_deepseek_session(
                                &session_id,
                                new_sid.clone(),
                                Some(cwd.clone()),
                            )
                            .await;
                        {
                            let mut routes = service.session_routes.lock().await;
                            routes.insert(
                                new_sid.clone(),
                                old_route.unwrap_or(crate::commands::dsh_service::DshRoute {
                                    stdin_id: session_id.clone(),
                                    auto_allow: false,
                                }),
                            );
                        }
                        let retried = crate::commands::dsh_service::unary(
                            &service.base_url,
                            "session.prompt",
                            serde_json::json!({
                                "sessionId": new_sid,
                                "mode": mode,
                                "content": [{ "type": "text", "text": message }],
                            }),
                        )
                        .await;
                        if retried.is_ok() {
                            let _ = crate::emit_stream_event(
                                &session_id,
                                serde_json::json!({
                                    "type": "system",
                                    "subtype": "info",
                                    "message": "DSH 服务已重启：会话已重建（上下文已重置），本条消息已重新发送",
                                }),
                            );
                            return Ok(());
                        }
                    }
                }
            }
            return result.map(|_| ());
        }
        Ok(())
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
    app: AppHandle,
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

    if backend_name.as_deref() == Some("deepseek") {
        // S2: DSH permission cards (approval/requested) are answered via the
        // unary `respond` RPC — the same envelope the auto-allow path uses
        // (dsh_service.rs), so non-bypass sessions can approve/deny tools.
        // The request_id surfaced to the frontend IS the approvalId.
        let dsh_mgr = app.state::<crate::commands::dsh_service::DshServiceManager>();
        let service = dsh_mgr.ensure().await?;
        let dsh_sid = process_mgr
            .get_deepseek_session(&session_id)
            .await
            .ok_or_else(|| format!("No DSH session for this tab: {}", session_id))?;
        let outcome = if allow { "allowed-once" } else { "denied" };
        let mut resp_value = serde_json::json!({
            "sessionId": dsh_sid,
            "approvalId": request_id,
            "outcome": outcome,
        });
        // AskUserQuestion: QuestionCard puts the selected answers into
        // updatedInput.answers — forward them (additive field; tool
        // approvals simply ignore it). Without this the DSH agent received
        // an allow-with-no-answer for question cards.
        if let Some(ans) = updated_input.as_ref().and_then(|u| u.get("answers")) {
            resp_value["answers"] = ans.clone();
        }
        let result = crate::commands::dsh_service::unary(
            &service.base_url,
            "respond",
            serde_json::json!({
                "type": "client-response",
                "rpcId": request_id,
                "result": { "ok": true, "value": resp_value },
            }),
        )
        .await;
        if result.is_err() {
            // Same orphaned-session recovery as send_stdin: the service may
            // have been respawned (H1), so this tab's DSH session no longer
            // exists on it. Drop the mapping to allow a fresh session.
            process_mgr.remove_deepseek_session(&session_id).await;
        }
        result.map(|_| ())
    } else if backend_name.as_deref() == Some("codex") {
        // M4: codex permission requests are registered in start_codex_session
        // (lib.rs, out of scope for this module's registry). JSON-RPC ids can
        // be numeric OR string ("req_…" — see codex.rs translate_approval_request);
        // #5 (bug): the old digits-only guard rejected every string id, so those
        // approvals could never be answered. Accept both, restricted to a safe
        // charset (the id travels as a JSON value, never a command line).
        if request_id.is_empty()
            || request_id.len() > 64
            || !request_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
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
    app: AppHandle,
    process_mgr: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    session_id: String,
    subtype: String,
    payload: Value,
) -> Result<(), String> {
    // Check which backend this session uses
    let backend_name = process_mgr.get_backend(&session_id).await;
    let is_codex = backend_name.as_deref() == Some("codex");

    if backend_name.as_deref() == Some("deepseek") {
        // S2: DSH has no stdin control channel — interrupt maps to
        // session.cancel; mode/model/rewind controls are not applicable
        // (approval behavior is fixed at session start via auto_allow), so
        // silently succeed like codex's no-op path.
        match subtype.as_str() {
            "interrupt" => {
                let dsh_mgr = app.state::<crate::commands::dsh_service::DshServiceManager>();
                let service = dsh_mgr.ensure().await?;
                let dsh_sid = process_mgr
                    .get_deepseek_session(&session_id)
                    .await
                    .ok_or_else(|| format!("No DSH session for this tab: {}", session_id))?;
                let result = crate::commands::dsh_service::unary(
                    &service.base_url,
                    "session.cancel",
                    serde_json::json!({ "sessionId": dsh_sid }),
                )
                .await;
                if result.is_err() {
                    // Same orphaned-session recovery as send_stdin.
                    process_mgr.remove_deepseek_session(&session_id).await;
                }
                result.map(|_| ())
            }
            _ => Ok(()),
        }
    } else if is_codex {
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
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    proxy_mgr: State<'_, crate::commands::anthropic_proxy::ProxyManager>,
    session_id: String,
) -> Result<(), String> {
    // D-N1-B service mode: no process to kill — cancel the running turn
    // (queue stays intact), then drop the tab's session mapping.
    if state.get_backend(&session_id).await.as_deref() == Some("deepseek") {
        if let Some(dsh_sid) = state.get_deepseek_session(&session_id).await {
            let dsh_mgr = app.state::<crate::commands::dsh_service::DshServiceManager>();
            // M1: use get() (no spawn) — teardown must not start a service
            // just to delete a route. Also drop the route map entry so no
            // further mux frames reach this dead tab.
            if let Some(service) = dsh_mgr.get().await {
                let _ = crate::commands::dsh_service::unary(
                    &service.base_url,
                    "session.cancel",
                    serde_json::json!({ "sessionId": dsh_sid }),
                )
                .await;
                // D10: drop ALL per-session bookkeeping so the maps don't
                // grow with every session ever created (translators and
                // last_seqs used to be append-only).
                service.session_routes.lock().await.remove(&dsh_sid);
                service.translators.lock().await.remove(&dsh_sid);
                service.last_seqs.lock().await.remove(&dsh_sid);
            }
        }
        state.remove_deepseek_session(&session_id).await;
    }
    stdin_mgr.remove(&session_id).await;
    state.remove(&session_id).await;
    proxy_mgr.stop(&session_id).await;
    Ok(())
}

/// T02: fork-style rewind for the DSH (deepseek) backend.
///
/// Claude's rewind trio (checkpoint + `rewind_files` + JSONL truncation) is
/// Claude-CLI private; DSH's only session-level rollback is `session.fork` —
/// copy events at a completed-turn boundary into a new child session while
/// the source session stays on the server. This command:
///   1. resolves the tab's current DSH session id (`get_deepseek_session`),
///   2. forks at `at_seq` (the seq of the turn's last event — captured by
///      `DshTranslator.last_seq`, surfaced on the result event as `dsh_seq`,
///      and handed back here by the frontend via `Turn.dshSeq`),
///   3. re-points the tab at the child: deepseek_sessions mapping plus the
///      service's mux route / translator / seq watermark entries are MOVED
///      from the old sid to the new sid,
/// and returns the child's DSH session id.
///
/// Seq watermark note: the child's event log is a PREFIX of the source's, so
/// the source's high-water mark sits AHEAD of the child's tail (a rewind
/// forks below the latest turn by definition). Copying the watermark verbatim
/// would make route_mux_frames drop the child's first fresh frames as
/// "stale". Seed it with `at_seq` instead (the fork boundary — the child's
/// copied tail is >= it): replayed copied frames dedupe, fresh child frames
/// (seq > boundary) pass.
#[tauri::command]
pub async fn dsh_fork_session(
    app: AppHandle,
    process_mgr: State<'_, ProcessManager>,
    session_id: String,
    at_seq: u64,
) -> Result<String, String> {
    use crate::commands::dsh_service::unary;

    // Only DSH service-mode sessions have a remote session to fork.
    if process_mgr.get_backend(&session_id).await.as_deref() != Some("deepseek") {
        return Err(format!(
            "dsh_fork_session: session {} is not a deepseek session",
            session_id
        ));
    }
    let dsh_sid = process_mgr
        .get_deepseek_session(&session_id)
        .await
        .ok_or_else(|| format!("No DSH session for this tab: {}", session_id))?;
    // The cwd rides along for R11 orphan-rebuild parity (the fork itself
    // inherits the source workspace server-side).
    let cwd = process_mgr.get_deepseek_session_cwd(&session_id).await;

    let dsh_mgr = app.state::<crate::commands::dsh_service::DshServiceManager>();
    let service = dsh_mgr.ensure().await?;

    // Fork RPC — atSeq anchors the cut at the first completed turn/end with
    // seq >= at_seq; DSH copies events up to the next turn/start into the
    // child. An at_seq inside an unfinished turn answers `fork-unavailable`.
    let forked = unary(
        &service.base_url,
        "session.fork",
        serde_json::json!({ "sessionId": dsh_sid, "atSeq": at_seq }),
    )
    .await
    .map_err(|e| format!("dsh session.fork failed: {}", e))?;
    let new_sid = forked
        .get("sessionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "dsh session.fork returned no sessionId".to_string())?
        .to_string();

    // Re-point the tab at the child. insert() overwrites the old mapping —
    // the source session stays alive server-side, this LC tab simply stops
    // addressing it.
    process_mgr
        .insert_deepseek_session(&session_id, new_sid.clone(), cwd)
        .await;
    {
        // MOVE the route: keeping the old sid routed would double-emit any
        // late source-session frames into the same tab.
        let mut routes = service.session_routes.lock().await;
        match routes.remove(&dsh_sid) {
            Some(route) => {
                routes.insert(new_sid.clone(), route);
            }
            None => {
                routes.insert(
                    new_sid.clone(),
                    crate::commands::dsh_service::DshRoute {
                        stdin_id: session_id.clone(),
                        auto_allow: false,
                    },
                );
            }
        }
    }
    {
        // Translator: per-turn fields clear on the child's first turn/start;
        // keeping the instance preserves model attribution across the fork.
        let mut ts = service.translators.lock().await;
        if let Some(t) = ts.remove(&dsh_sid) {
            ts.insert(new_sid.clone(), t);
        }
    }
    {
        // Seq watermark: seed at the fork boundary — see the fn-level note.
        let mut seqs = service.last_seqs.lock().await;
        seqs.remove(&dsh_sid);
        seqs.insert(new_sid.clone(), at_seq);
    }

    log::info!(
        "[dsh:fork] {} -> {} (at_seq={}, tab={})",
        dsh_sid,
        new_sid,
        at_seq,
        session_id
    );
    Ok(new_sid)
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
    // L6: session_id 含换行/回车时会向 tracked_sessions.txt 注入行——拒绝。
    // 同时排除其他空白字符，避免空白行污染跟踪文件。
    if session_id.chars().any(|c| c.is_whitespace()) {
        return Err("Invalid session_id: contains whitespace".to_string());
    }
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
                    // M2: 关键字集与 resolved_env 日志脱敏保持一致
                    // （API_KEY/TOKEN/SECRET/PASSWORD/KEY/PAT）。
                    let up = k.to_ascii_uppercase();
                    if ["API_KEY", "TOKEN", "SECRET", "PASSWORD", "KEY", "PAT"]
                        .iter()
                        .any(|kw| up.contains(kw))
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

/// M2: URL 可能内嵌 userinfo 凭据（https://user:pass@host）——日志打印前
/// 把 userinfo 部分脱敏为 ***@***。
fn mask_url_userinfo(url: &str) -> String {
    if let Some(scheme_end) = url.find("://") {
        if let Some(at) = url[scheme_end + 3..].find('@') {
            let at = scheme_end + 3 + at;
            return format!("{}***@***{}", &url[..scheme_end + 3], &url[at + 1..]);
        }
    }
    url.to_string()
}

#[tauri::command]
pub async fn load_session(path: String) -> Result<Vec<Value>, String> {
    // Only allow loading sessions inside the canonical ~/.claude/projects tree
    // (the same tree list_sessions scans). This blocks arbitrary-path reads.
    let p = std::path::Path::new(&path);
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let projects_root = home.join(".claude").join("projects");
    let root_c = projects_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve projects dir: {}", e))?;
    // L4: 只校验父目录会让符号链接把文件本体指到 projects 树之外——对文件
    // 本体 canonicalize 后校验（对齐 delete_session 的做法）。文件必须存在，
    // canonicalize 失败（不存在/无权限）直接报错。
    let file_c = p
        .canonicalize()
        .map_err(|e| format!("Cannot resolve session path: {}", e))?;
    if !file_c.starts_with(&root_c) {
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

    // H5: the synchronous read + parse (up to 50 MiB, and a single line can
    // carry a multi-MB embedded payload whose serde Value tree amplifies
    // memory 5-10x) used to run directly on the tokio worker, freezing the
    // UI for seconds. Move it to the blocking pool and cap per-line size.
    const MAX_LINE_BYTES: usize = 8 * 1024 * 1024; // 8 MiB per JSONL line
    tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
        use std::io::BufRead;
        let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
        let reader = std::io::BufReader::new(file);
        let mut messages = vec![];
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if line.len() > MAX_LINE_BYTES {
                eprintln!("[LITTLECLAUDE] load_session: skipping {}-byte line (> 8 MiB cap)", line.len());
                continue;
            }
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                messages.push(json);
            }
        }
        Ok(messages)
    })
    .await
    .map_err(|e| format!("load_session task panicked: {}", e))?
}

// ---------------------------------------------------------------------------
// T03: paginated session loading (tail-first) for huge histories.
//
// Opening a tens-of-MB JSONL used to be a triple hit: load_session parsed the
// WHOLE file into Vec<Value>, shipped it all over IPC, and the frontend parsed
// it again — freezing the UI. load_session_tail instead reads only the last
// `limit` valid lines, and load_session_more walks backwards page by page via
// a byte cursor (offset of the earliest loaded line), so a 50 MB session's
// first screen costs one ~300-line parse regardless of file size.
//
// No-dup / no-gap contract: every call only consumes bytes strictly below its
// `region_end`; the returned cursor is the start offset of the earliest line
// it loaded, and the next call scans `[0, cursor)` — pages never overlap and
// never skip valid lines (invalid/oversized lines are skipped exactly like
// load_session does, but the scan still walks across them).
// ---------------------------------------------------------------------------

/// T03: max file size the paginated loaders accept. Tail/more parse only the
/// requested page, so this is a runaway guard against multi-GB foreign files —
/// deliberately higher than load_session's 50 MiB cap, since opening those
/// bigger files is the whole point of pagination.
const MAX_PAGINATED_SESSION_BYTES: u64 = 512 * 1024 * 1024;

/// T03: clamp a page request (the frontend asks for 300).
fn clamp_page_limit(limit: usize) -> usize {
    limit.clamp(1, 2000)
}

/// T03: resolve `<session_id, project_dir>` to the canonical JSONL path inside
/// ~/.claude/projects. Same validation as truncate_session_history: UUID-like
/// id check + encode_project_name keep the join inside the projects tree (no
/// traversal); `project_dir` is the RAW path (the frontend passes the same
/// value it feeds truncateSessionHistory via workingDirectory).
fn resolve_claude_session_path(
    session_id: &str,
    project_dir: &str,
) -> Result<std::path::PathBuf, String> {
    fn is_uuid_like(s: &str) -> bool {
        s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    }
    if !is_uuid_like(session_id) {
        return Err(format!("Invalid session_id format: {}", session_id));
    }
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let encoded = encode_project_name(project_dir);
    Ok(home
        .join(".claude")
        .join("projects")
        .join(encoded)
        .join(format!("{}.jsonl", session_id)))
}

/// T03: response shape for load_session_tail / load_session_more.
/// `messages` are the parsed JSONL lines in FILE order (oldest → newest),
/// `total_lines` is the file's physical line count (byte scan incl. invalid
/// lines — a UI hint only), `cursor` is the byte offset of the earliest loaded
/// line (feed back into load_session_more), `has_more` is false once the scan
/// reached the file start (any remaining prefix was checked and holds no
/// loadable line).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub messages: Value,
    pub total_lines: u64,
    pub cursor: u64,
    pub has_more: bool,
}

/// T03: parse one JSONL line; empty / oversized / corrupt lines yield None
/// (same skip semantics as load_session). Trailing '\r' (Windows line endings)
/// is legal JSON whitespace and needs no stripping.
fn parse_jsonl_line(bytes: &[u8], max_bytes: usize) -> Option<Value> {
    if bytes.len() > max_bytes || bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return None;
    }
    serde_json::from_slice::<Value>(bytes).ok()
}

/// T03: prepend `chunk` to the partial-head-line carry, honouring the
/// per-line cap — once a line exceeds it we discard its bytes but keep
/// scanning for its start (the line is invalid, not lost-and-forgotten).
fn prepend_to_carry(chunk: &[u8], carry: &mut Vec<u8>, overlong: &mut bool, max_bytes: usize) {
    if *overlong {
        return;
    }
    if carry.len() + chunk.len() > max_bytes {
        *overlong = true;
        carry.clear();
        return;
    }
    let mut merged = Vec::with_capacity(chunk.len() + carry.len());
    merged.extend_from_slice(chunk);
    merged.extend_from_slice(carry);
    *carry = merged;
}

/// T03: count the file's physical lines (streaming byte scan, no JSON parse).
/// Includes empty/corrupt lines — drives the "N lines" UI hint, not pagination
/// correctness (that rides cursor/has_more).
fn count_jsonl_lines(path: &std::path::Path, file_len: u64) -> Result<u64, String> {
    use std::io::Read;
    if file_len == 0 {
        return Ok(0);
    }
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open session: {}", e))?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut count: u64 = 0;
    let mut last_byte: u8 = 0;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read session: {}", e))?;
        if n == 0 {
            break;
        }
        count += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
        last_byte = buf[n - 1];
    }
    if last_byte != b'\n' {
        count += 1; // trailing line without a final newline
    }
    Ok(count)
}

/// T03: shared backward page reader for load_session_tail / load_session_more.
/// Scans `[0, region_end)` backwards from `region_end`, collecting up to
/// `limit` valid lines newest-first, then returns them in file order plus the
/// byte offset of the earliest loaded line and whether the scan consumed the
/// whole region down to offset 0.
fn read_jsonl_page_backward(
    path: &std::path::Path,
    region_end: u64,
    limit: usize,
) -> Result<(Vec<Value>, u64, bool), String> {
    use std::io::{Read, Seek, SeekFrom};

    const MAX_LINE_BYTES: usize = 8 * 1024 * 1024; // same per-line cap as load_session
    const CHUNK: u64 = 512 * 1024; // backward read window per iteration
    const MAX_SCAN: u64 = 256 * 1024 * 1024; // per-call scan budget (corrupt-file guard)

    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open session: {}", e))?;

    // T03: empty region — nothing before the cursor (defensive: the frontend
    // gates on hasMore, and load_session_more clamps stale cursors).
    if region_end == 0 {
        return Ok((Vec::new(), 0, false));
    }

    // Known tail bytes of the line whose start hasn't been located yet (it
    // stretches from some offset < `end` to a terminator already identified).
    // Never contains '\n'; discarded once it exceeds MAX_LINE_BYTES.
    let mut carry: Vec<u8> = Vec::new();
    let mut carry_overlong = false;

    let mut end = region_end; // lower frontier of the still-unscanned region
    let mut scanned: u64 = 0;
    // True only once EVERY byte down to offset 0 was examined. A limit-hit
    // break leaves it false even when the breaking chunk touched offset 0 —
    // the not-yet-parsed head line may still hold history.
    let mut reached_start = false;
    // Collected lines, newest-first: (start_offset, json).
    let mut collected: Vec<(u64, Value)> = Vec::with_capacity(limit.min(2048));

    while collected.len() < limit && end > 0 && scanned < MAX_SCAN {
        let take = CHUNK.min(end).min(MAX_SCAN - scanned);
        let start = end - take;
        let mut buf = vec![0u8; take as usize];
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("Failed to seek session: {}", e))?;
        file.read_exact(&mut buf)
            .map_err(|e| format!("Failed to read session: {}", e))?;
        scanned += take;

        let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
            // No boundary in this chunk — it all extends the carry line.
            prepend_to_carry(&buf, &mut carry, &mut carry_overlong, MAX_LINE_BYTES);
            end = start;
            continue;
        };

        // Tail line: buf[last_nl+1..] ++ carry (its terminator was already known).
        if !carry_overlong {
            let mut content = Vec::with_capacity(buf.len() - last_nl - 1 + carry.len());
            content.extend_from_slice(&buf[last_nl + 1..]);
            content.extend_from_slice(&carry);
            if let Some(v) = parse_jsonl_line(&content, MAX_LINE_BYTES) {
                collected.push((start + last_nl as u64 + 1, v));
            }
        }
        carry.clear();
        carry_overlong = false;
        if collected.len() >= limit {
            end = start;
            break;
        }

        // Complete middle lines between newlines inside buf[..last_nl],
        // rightmost (newest) first.
        let nls: Vec<usize> = buf[..last_nl]
            .iter()
            .enumerate()
            .filter(|(_, &b)| b == b'\n')
            .map(|(i, _)| i)
            .collect();
        let mut prev_end = last_nl;
        let mut hit_limit = false;
        for &p in nls.iter().rev() {
            if collected.len() >= limit {
                hit_limit = true;
                break;
            }
            if let Some(v) = parse_jsonl_line(&buf[p + 1..prev_end], MAX_LINE_BYTES) {
                collected.push((start + p as u64 + 1, v));
            }
            prev_end = p;
        }
        if hit_limit {
            end = start;
            break;
        }

        // Head piece buf[..prev_end]: complete only when the chunk touched
        // offset 0 (then it IS the file's first line).
        if start == 0 {
            if collected.len() < limit {
                if let Some(v) = parse_jsonl_line(&buf[..prev_end], MAX_LINE_BYTES) {
                    collected.push((0, v));
                }
                reached_start = true; // head piece examined → region fully consumed
            }
            end = 0;
            break;
        }
        prepend_to_carry(&buf[..prev_end], &mut carry, &mut carry_overlong, MAX_LINE_BYTES);
        end = start;
    }

    // T03: the scan can reach offset 0 still carrying a partial head line when
    // the final chunk held no newline at all (e.g. a single-line file/region)
    // — that carry IS the first line; finalize it here.
    if end == 0 && collected.len() < limit && (carry_overlong || !carry.is_empty()) {
        if !carry_overlong {
            if let Some(v) = parse_jsonl_line(&carry, MAX_LINE_BYTES) {
                collected.push((0, v));
            }
        }
        reached_start = true; // every byte of the region was examined
    }

    // newest-first → file order; earliest loaded offset becomes the cursor.
    let earliest = collected.last().map(|(off, _)| *off);
    collected.reverse();
    let messages: Vec<Value> = collected.into_iter().map(|(_, v)| v).collect();
    let (cursor, has_more) = match earliest {
        // Scanned to offset 0 → the prefix was examined: no valid line left.
        Some(off) => (off, !reached_start && off > 0),
        // Nothing loaded: either the file/region is exhausted…
        None if reached_start => (0, false),
        // …or the scan budget ran out — leave a resumable cursor.
        None => (end, true),
    };
    Ok((messages, cursor, has_more))
}

/// T03: load only the TAIL of a session history — the first screen of a huge
/// JSONL without parsing/IPC-ing the whole file (that's load_session's job for
/// small histories). Returns the last `limit` valid lines plus a byte `cursor`
/// (offset of the earliest loaded line) for load_session_more.
#[tauri::command]
pub async fn load_session_tail(
    session_id: String,
    project_dir: String,
    limit: usize,
) -> Result<SessionPage, String> {
    let path = resolve_claude_session_path(&session_id, &project_dir)?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to stat session file: {}", e))?;
    if meta.len() > MAX_PAGINATED_SESSION_BYTES {
        return Err(format!(
            "Session file too large to paginate ({} bytes, max {} MiB)",
            meta.len(),
            MAX_PAGINATED_SESSION_BYTES / (1024 * 1024)
        ));
    }
    let limit = clamp_page_limit(limit);
    let file_len = meta.len();
    // H5 parity: heavy IO/parse runs on the blocking pool, never the worker.
    tokio::task::spawn_blocking(move || -> Result<SessionPage, String> {
        let (messages, cursor, has_more) = read_jsonl_page_backward(&path, file_len, limit)?;
        let total_lines = count_jsonl_lines(&path, file_len)?;
        Ok(SessionPage {
            messages: Value::Array(messages),
            total_lines,
            cursor,
            has_more,
        })
    })
    .await
    .map_err(|e| format!("load_session_tail task panicked: {}", e))?
}

/// T03: load the page BEFORE `cursor` (byte offset from a previous tail/more
/// call), walking backwards toward the file start. A stale cursor (e.g. the
/// file was truncated by a rewind between pages) is clamped to the current
/// size instead of erroring.
#[tauri::command]
pub async fn load_session_more(
    session_id: String,
    project_dir: String,
    cursor: u64,
    limit: usize,
) -> Result<SessionPage, String> {
    let path = resolve_claude_session_path(&session_id, &project_dir)?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to stat session file: {}", e))?;
    if meta.len() > MAX_PAGINATED_SESSION_BYTES {
        return Err(format!(
            "Session file too large to paginate ({} bytes, max {} MiB)",
            meta.len(),
            MAX_PAGINATED_SESSION_BYTES / (1024 * 1024)
        ));
    }
    let limit = clamp_page_limit(limit);
    let region_end = cursor.min(meta.len()); // T03: stale-cursor clamp (see doc)
    let file_len = meta.len();
    tokio::task::spawn_blocking(move || -> Result<SessionPage, String> {
        let (messages, cursor, has_more) = read_jsonl_page_backward(&path, region_end, limit)?;
        let total_lines = count_jsonl_lines(&path, file_len)?;
        Ok(SessionPage {
            messages: Value::Array(messages),
            total_lines,
            cursor,
            has_more,
        })
    })
    .await
    .map_err(|e| format!("load_session_more task panicked: {}", e))?
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
            // #15 (bug): atomic rewrite — fs::write truncates the destination
            // FIRST; a crash/power loss mid-write used to destroy the whole
            // session history. Write tmp + rename instead (same pattern the
            // other session writers already use).
            let tmp = path.with_extension("jsonl.trunc-tmp");
            std::fs::write(&tmp, kept)
                .map_err(|e| format!("Failed to write truncated session: {}", e))?;
            std::fs::rename(&tmp, &path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("Failed to replace session file: {}", e)
            })?;
            Ok(Some(kept_lines))
        }
    }
}

// ---------------------------------------------------------------------------
// T03: unit tests for the backward page reader's no-dup / no-gap contract.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod t03_pagination_tests {
    use super::read_jsonl_page_backward;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn write_tmp(lines: &[&str]) -> std::path::PathBuf {
        let n = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "t03_test_{}_{}.jsonl",
            std::process::id(),
            n
        ));
        let mut f = std::fs::File::create(&path).expect("create tmp");
        for l in lines {
            f.write_all(l.as_bytes()).unwrap();
            f.write_all(b"\n").unwrap();
        }
        path
    }

    fn collect_all(path: &std::path::Path, page: usize) -> Vec<serde_json::Value> {
        let file_len = std::fs::metadata(path).unwrap().len();
        let mut out: Vec<serde_json::Value> = Vec::new();
        // First page = tail of the whole file.
        let (mut msgs, mut cursor, mut has_more) =
            read_jsonl_page_backward(path, file_len, page).unwrap();
        out.append(&mut msgs);
        // Walk backwards until exhausted.
        let mut guard = 0;
        while has_more && guard < 1000 {
            guard += 1;
            let (mut m, c, hm) = read_jsonl_page_backward(path, cursor, page).unwrap();
            // Prepend older page in front of what we already have.
            m.append(&mut out);
            out = m;
            cursor = c;
            has_more = hm;
        }
        assert!(!has_more, "pagination never terminated");
        out
    }

    #[test]
    fn tail_returns_last_n_in_file_order() {
        let lines: Vec<String> = (0..10).map(|i| format!(r#"{{"i":{}}}"#, i)).collect();
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let path = write_tmp(&refs);
        let len = std::fs::metadata(&path).unwrap().len();

        let (msgs, cursor, has_more) = read_jsonl_page_backward(&path, len, 3).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["i"], 7);
        assert_eq!(msgs[1]["i"], 8);
        assert_eq!(msgs[2]["i"], 9);
        assert!(has_more);
        assert!(cursor > 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn walk_backward_is_complete_ordered_and_deduped() {
        // 25 valid lines, page size 4 → forces multiple pages + a remainder.
        let lines: Vec<String> = (0..25).map(|i| format!(r#"{{"i":{}}}"#, i)).collect();
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let path = write_tmp(&refs);

        let all = collect_all(&path, 4);
        assert_eq!(all.len(), 25, "must recover every line exactly once");
        for (idx, v) in all.iter().enumerate() {
            assert_eq!(v["i"], idx as i64, "file order preserved at index {}", idx);
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn skips_invalid_and_blank_lines() {
        // Mix valid, corrupt, and blank lines; only the 4 valid ones survive.
        let path = write_tmp(&[
            r#"{"i":0}"#,
            "not-json-at-all",
            "",
            r#"{"i":1}"#,
            r#"{"broken": "#,
            r#"{"i":2}"#,
            "   ",
            r#"{"i":3}"#,
        ]);
        let all = collect_all(&path, 2);
        let got: Vec<i64> = all.iter().map(|v| v["i"].as_i64().unwrap()).collect();
        assert_eq!(got, vec![0, 1, 2, 3]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn single_line_no_trailing_newline() {
        let n = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("t03_test_{}_{}.jsonl", std::process::id(), n));
        std::fs::write(&path, r#"{"only":1}"#).unwrap(); // no trailing \n
        let all = collect_all(&path, 4);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["only"], 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn empty_region_returns_nothing() {
        let path = write_tmp(&[r#"{"i":0}"#]);
        let (msgs, cursor, has_more) = read_jsonl_page_backward(&path, 0, 4).unwrap();
        assert!(msgs.is_empty());
        assert_eq!(cursor, 0);
        assert!(!has_more);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn small_file_fits_in_one_page_has_more_false() {
        let path = write_tmp(&[r#"{"i":0}"#, r#"{"i":1}"#]);
        let len = std::fs::metadata(&path).unwrap().len();
        let (msgs, _cursor, has_more) = read_jsonl_page_backward(&path, len, 10).unwrap();
        assert_eq!(msgs.len(), 2);
        assert!(!has_more, "whole file consumed → no older history");
        let _ = std::fs::remove_file(&path);
    }
}

// ── D1: DSH 会话进会话列表 ─────────────────────────────────────────────────
// list_sessions 只扫 ~/.claude/projects，DSH 后端会话（~/.dsh/sessions 下的
// 多帧 zstd 日志）在会话列表永远不可见。本命令按 mtime 取最近 limit 个
// DSH 会话，复用 handoff::decode_dsh_session_lines 的多帧解码（不复制粘贴
// 解码循环），提取预览/cwd/时间/turn 估计，输出与 list_sessions 同形的条目
// （origin: "deepseek"）。
//
// 成本控制：先纯元数据（mtime）排序选出 limit 个文件再解码；解码结果按
// (mtime, size) 缓存（同 B4 extract_session_info_cached 思路），未变化的
// 日志不再重复解码。
//
// 已知限制（T02）：从列表重载的 DSH 会话没有 fork 锚点（dshSeq 只属于
// 本进程内跑起来的活会话），因此重载会话不支持 rewind/fork。

#[derive(Clone)]
struct DshSessionInfoCacheEntry {
    mtime_ns: u64,
    size: u64,
    preview: String,
    cwd: String,
    created_at: u64,
    turns: u64,
    /// subagent 会话（delegationDepth>0 / origin=subagent）——不进列表
    skipped: bool,
}

static DSH_SESSION_INFO_CACHE: OnceLock<Mutex<HashMap<String, DshSessionInfoCacheEntry>>> =
    OnceLock::new();

fn dsh_session_info_cache() -> &'static Mutex<HashMap<String, DshSessionInfoCacheEntry>> {
    DSH_SESSION_INFO_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 解码单个 DSH 会话日志并提取列表元数据。
/// 解码走 handoff::decode_dsh_session_head（共享多帧 zstd 路径，只解开头
/// 若干帧——create 事件/首个 user 消息都在文件头部，列表无需全量解码）；
/// 预览文本走 handoff::blocks_text（共享块提取）。
fn extract_dsh_session_info(path: &std::path::Path) -> DshSessionInfoCacheEntry {
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
    // D1: 只解头部 ~512KB（压缩）——列表元数据全在文件前端，避免为列出而
    // 全量解码大会话（实测 11MB 日志全解一次需数秒）。
    const HEAD_BYTES: u64 = 512 * 1024;
    let rows = crate::commands::handoff::decode_dsh_session_head(path, HEAD_BYTES)
        .unwrap_or_default();

    let mut preview = String::new();
    let mut cwd = String::new();
    let mut created_at: u64 = 0;
    let mut turns: u64 = 0;
    let mut user_msgs: u64 = 0;
    let mut skipped = false;

    for row in &rows {
        let etype = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match etype {
            "session" => {
                // create 事件（首帧）：cwd + createdAt + 是否 subagent
                if cwd.is_empty() {
                    if let Some(c) = row.get("cwd").and_then(|v| v.as_str()) {
                        if !c.is_empty() {
                            cwd = c.to_string();
                        }
                    }
                }
                if created_at == 0 {
                    created_at = row.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
                }
                if row.get("delegationDepth").and_then(|v| v.as_u64()).unwrap_or(0) > 0
                    || row.get("origin").and_then(|v| v.as_str()) == Some("subagent")
                {
                    skipped = true;
                }
            }
            "user/message" => {
                user_msgs += 1;
                if preview.is_empty() {
                    let text = row
                        .pointer("/data/content")
                        .map(crate::commands::handoff::blocks_text)
                        .unwrap_or_default();
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        preview = trimmed.chars().take(120).collect();
                    }
                }
            }
            "turn/start" => turns += 1,
            _ => {}
        }
    }
    // D1: turn 数估计——优先数窗口内的 turn/start 事件；没有则退回用户消息数。
    // 头部窗口解码意味着长会话的计数是下界估计（任务口径即"turn 数估计"）。
    if turns == 0 {
        turns = user_msgs;
    }

    DshSessionInfoCacheEntry {
        mtime_ns,
        size,
        preview,
        cwd,
        created_at,
        turns,
        skipped,
    }
}

/// (mtime, size) 缓存包装——未变化的日志跳过重复解码（同 B4 思路）。
fn extract_dsh_session_info_cached(path: &std::path::Path) -> DshSessionInfoCacheEntry {
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
        let cache = dsh_session_info_cache().lock().unwrap();
        if let Some(entry) = cache.get(&key) {
            if entry.mtime_ns == mtime_ns && entry.size == size {
                return entry.clone();
            }
        }
    }
    let info = extract_dsh_session_info(path);
    {
        let mut cache = dsh_session_info_cache().lock().unwrap();
        if cache.len() > 2000 {
            cache.clear();
        }
        cache.insert(key, info.clone());
    }
    info
}

/// D1: 列出最近的 DSH 会话（~/.dsh/sessions/**/session.jsonl.zstd）。
/// 条目形状与 list_sessions 一致，另附 turnCount/createdAt；origin 固定
/// "deepseek"。limit 缺省 100，上限 500。
#[tauri::command]
pub async fn list_dsh_sessions(limit: Option<usize>) -> Result<Vec<Value>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let root = home.join(".dsh").join("sessions");
    if !root.is_dir() {
        return Ok(vec![]);
    }

    // 1. 纯元数据收集（不解码）：(mtime_ms, path)
    let mut files: Vec<(u64, std::path::PathBuf)> = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.file_name().and_then(|n| n.to_str()) != Some("session.jsonl.zstd") {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&p) else {
                continue;
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            files.push((mtime, p));
        }
    }

    // 2. mtime 取最近 limit 个，只解码这些
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(limit);

    tokio::task::spawn_blocking(move || {
        let mut sessions: Vec<Value> = Vec::new();
        for (mtime, path) in files {
            let info = extract_dsh_session_info_cached(&path);
            if info.skipped {
                continue;
            }
            // session id = 日志所在目录名（session-<uuid> 或裸 uuid）
            let id = path
                .parent()
                .and_then(|d| d.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            // projectDir = sessions/ 下第一层目录名（DSH 的 cwd 编码形式）
            let project_dir = path
                .parent()
                .and_then(|d| d.parent())
                .and_then(|d| d.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let project = if info.cwd.is_empty() {
                project_dir.clone()
            } else {
                info.cwd.clone()
            };
            sessions.push(serde_json::json!({
                "id": id,
                "path": path.to_string_lossy(),
                "project": project,
                "projectDir": project_dir,
                "modifiedAt": mtime,
                "preview": info.preview,
                "origin": "deepseek",
                "turnCount": info.turns,
                "createdAt": info.created_at,
            }));
        }
        // 解码后仍按 mtime 降序（truncate 前后顺序一致，这里兜底）
        sessions.sort_by(|a, b| {
            let ta = a["modifiedAt"].as_u64().unwrap_or(0);
            let tb = b["modifiedAt"].as_u64().unwrap_or(0);
            tb.cmp(&ta)
        });
        Ok(sessions)
    })
    .await
    .map_err(|e| format!("DSH 会话列表任务失败: {}", e))?
}

/// Delete (archive) a DSH session. DSH exposes no session.delete RPC —
/// `workspace.archiveSession` removes it from the workspace views, which is
/// DSH's own delete semantics (the log file stays under ~/.dsh/sessions).
#[tauri::command]
pub async fn delete_dsh_session(
    app: AppHandle,
    session_id: String,
) -> Result<(), String> {
    let dsh_mgr = app.state::<crate::commands::dsh_service::DshServiceManager>();
    let service = dsh_mgr.ensure().await?;
    crate::commands::dsh_service::unary(
        &service.base_url,
        "workspace.archiveSession",
        serde_json::json!({ "sessionId": session_id }),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod d1_dsh_list_tests {
    use super::extract_dsh_session_info;

    /// Local-machine verification (ignored on CI — needs ~/.dsh/sessions):
    /// decode REAL multi-frame DSH logs through the same helper
    /// list_dsh_sessions uses, and assert the listing metadata comes out.
    #[test]
    #[ignore]
    fn extract_info_from_real_dsh_sessions() {
        let Some(home) = dirs::home_dir() else { return };
        let root = home.join(".dsh").join("sessions");
        if !root.is_dir() {
            return;
        }
        let mut stack = vec![root];
        let mut checked = 0usize;
        let mut with_preview = 0usize;
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if p.file_name().and_then(|n| n.to_str()) != Some("session.jsonl.zstd") {
                    continue;
                }
                let info = extract_dsh_session_info(&p);
                eprintln!(
                    "dsh {}: cwd={:?} preview={:?} turns={} skipped={}",
                    p.display(),
                    info.cwd,
                    info.preview,
                    info.turns,
                    info.skipped
                );
                checked += 1;
                if !info.preview.is_empty() {
                    with_preview += 1;
                }
            }
        }
        assert!(checked > 0, "no DSH session files found");
        assert!(with_preview > 0, "no DSH session yielded a preview");
    }
}
