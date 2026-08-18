pub mod backends;
mod commands;
mod embedded_resources;
pub mod interview;
mod protocol;

use commands::{ApiProvider, ManagedProcess, ProcessManager, SessionInfo, StartSessionParams, StdinManager, WatcherManager};
use commands::model_windows::prewarm as prewarm_model_windows;
use commands::session::cleanup_tracked_sessions;
#[cfg(feature = "video-analysis")]
use commands::video_analysis::install_bundled_video_analysis_skill;
// video-analysis tauri commands (feature-gated; module not compiled by default)
#[cfg(feature = "video-analysis")]
use commands::{
    dismiss_video_analysis_runtime_prompt, download_video_analysis_runtime,
    get_video_analysis_multimodal_config, get_video_analysis_runtime_status,
    open_video_analysis_skill_dir, save_video_analysis_multimodal_config,
    set_video_analysis_acceleration, set_video_analysis_asr_model,
};
use commands::{append_usage_record, check_claude_auth, check_claude_cli, check_cli_update, check_codex_cli, check_codex_update, check_dsh_cli, check_dsh_update, check_file_access, check_local_model_service, check_node_env, check_prerequisites, cleanup_old_cli, compress_wallpaper, copy_file, create_directory, decrypt_value, delete_cli, delete_file, delete_session, delete_skill, delete_wallpaper, diagnose_cli, download_speech_runtime, dsh_fork_session, encrypt_value, export_claude_to_codex, export_codex_to_claude, export_session_json, export_session_markdown, generate_session_title, get_file_size, get_local_node_bin, get_npm_global_bin, get_pinned_cli, get_profile_stats, get_speech_runtime_status, get_wallpaper_path, handoff::{read_dsh_session_turns, write_handoff_file}, inject_cli_path, install_claude_cli, install_codex_cli, install_dsh_cli, install_node_env, install_prerequisite, kill_session, list_active_processes, list_all_commands, list_imported_pets, list_local_models, list_provider_models, list_recent_projects, list_sessions, list_skills, list_slash_commands, list_wallpapers, load_providers, load_session, load_session_more, load_session_tail, open_in_vscode, open_speech_skill_dir, open_terminal_login, open_with_default_app, pin_cli, preview_back, preview_forward, preview_open_url, preview_refresh, pull_local_model, read_file_base64, read_file_content, read_file_tree, read_imported_pet, read_skill, rename_file, respond_permission, reveal_in_finder, rewind_files, run_claude_command, run_claude_plugin_command, run_git_command, save_imported_pet, save_temp_file, search_sessions, send_control_request, send_raw_stdin, send_stdin, set_dock_icon, share_file, share_to_wechat, start_claude_login, start_claude_session, start_wallpaper_server, sync_providers, test_provider_connection, toggle_skill_enabled, track_session, translate_skill_markdown, translate_skill_metadata, truncate_session_history, unpin_cli, unwatch_directory, update_claude_cli, update_codex_cli, update_dsh_cli, watch_directory, write_file_content, write_skill};
use crate::embedded_resources::resolve_frontend_asset;
use interview::commands::{interview_mimo_answer, interview_prewarm_connection, interview_start_system_audio_raw, interview_stop_system_audio_raw, interview_test_mimo};
use interview::local_asr::{check_local_asr_model, check_local_asr_runtime, delete_local_asr_model, download_local_asr_model, test_local_asr, start_local_asr_session, push_local_asr_audio, stop_local_asr_session, transcribe_and_reset_local_asr};
// protocol module kept for ControlRequest (send_control_request) and tests
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
pub(crate) fn claude_needs_cmd_wrapper(bin: &str) -> bool {
    bin.ends_with(".cmd")
        || bin.ends_with(".bat")
        || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r#"'\''"#))
}

/// Strip ANSI escape sequences from a string (terminal color/cursor codes).
pub(crate) fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ('\x40'..='\x7e').contains(&ch) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')') => {
                    chars.next();
                    chars.next();
                }
                _ => {
                    chars.next();
                }
            }
        } else if c < '\x20' && c != '\n' && c != '\r' && c != '\t' {
            // skip control chars
        } else {
            out.push(c);
        }
    }
    out
}



/// Shared app data directory name  --?all editions (Little Claude / TCAlpha) use the same
/// directory so they share a single CLI installation and settings.
pub(crate) const APP_DATA_DIR_NAME: &str = "com.tinyzhuang.tokenicode";

/// Suffix appended to app data directories in dev builds (cfg!(debug_assertions)).
/// Dev builds (`cargo tauri dev`) must never touch the released app's CLI install,
/// providers, settings, or session data — previously both shared
/// `com.tinyzhuang.tokenicode`, so a CLI update in dev silently replaced the
/// production CLI (and vice versa). Release builds keep the plain name.
pub(crate) fn dev_data_dir_suffix() -> &'static str {
    if cfg!(debug_assertions) {
        ".dev"
    } else {
        ""
    }
}

/// App-local data directory name for the current build type
/// (e.g. "com.tinyzhuang.tokenicode" in release, "com.tinyzhuang.tokenicode.dev" in dev).
pub(crate) fn app_data_dir_name() -> String {
    format!("{}{}", APP_DATA_DIR_NAME, dev_data_dir_suffix())
}

/// Safe data directory name ("~/.tokenicode" or "~/.tokenicode.dev" in dev builds).
pub(crate) fn safe_data_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        ".tokenicode.dev"
    } else {
        ".tokenicode"
    }
}

/// GCS bucket for Claude Code releases.
pub(crate) const CLI_GCS_BASE: &str = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

/// Self-hosted mirror for China users.
pub(crate) const CLI_MIRROR_BASE: &str = "https://herear.cn:8443/releases/claude-code";

/// Path to the CLI download directory under the app's local data dir.
pub(crate) fn cli_download_dir() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join(app_data_dir_name()).join("cli"))
}

/// Path to the local Git installation directory (Windows only).
#[cfg(target_os = "windows")]
pub(crate) fn git_download_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(app_data_dir_name()).join("git"))
        .ok_or_else(|| "Cannot determine app data directory".to_string())
}

/// Check if app-local PortableGit bash.exe exists (Windows only).
/// Validates that the Git runtime is complete (usr/bin/cygpath.exe present)
/// so we don't return a broken bash that fails Claude CLI's path conversion.
#[cfg(target_os = "windows")]
fn get_local_git_bash() -> Option<String> {
    let git_dir = git_download_dir().ok()?;
    let bash = git_dir.join("bin").join("bash.exe");
    if bash.exists() && git_dir.join("usr").join("bin").join("cygpath.exe").exists() {
        Some(bash.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Derive the Git installation root from a bash.exe path, supporting both
/// common Git-for-Windows layouts:
///   <root>/bin/bash.exe         (e.g. PortableGit, some installs)
///   <root>/usr/bin/bash.exe     (e.g. D:\Git\usr\bin\bash.exe)
#[cfg(target_os = "windows")]
fn git_root_for_bash(bash: &Path) -> Option<PathBuf> {
    let bin = bash.parent()?;
    let bin_name = bin.file_name()?.to_string_lossy().to_lowercase();
    if bin_name == "bin" {
        // Could be <root>/bin or <root>/usr/bin
        let parent = bin.parent()?;
        if let Some(grand) = parent.file_name() {
            if grand.to_string_lossy().to_lowercase() == "usr" {
                return Some(parent.to_path_buf()); // <root>/usr -> root
            }
        }
        Some(parent.to_path_buf()) // <root>/bin -> root
    } else {
        None
    }
}

/// Check whether a bash.exe path is a usable Git-for-Windows runtime:
/// the Git root must contain usr/bin/cygpath.exe (required by Claude CLI
/// for Windows<->MSYS path conversion) in addition to bash.exe itself.
#[cfg(target_os = "windows")]
fn is_usable_git_bash(bash: &str) -> bool {
    if let Some(root) = git_root_for_bash(Path::new(bash)) {
        root.join("usr").join("bin").join("cygpath.exe").exists()
    } else {
        false
    }
}

/// Resolve Git Bash with diagnostics. Returns (bash_path, source_label).
/// Priority (highest  --?lowest):
///   1. CLAUDE_CODE_GIT_BASH_PATH env var (explicit user/provider config)
///   2. System Git-for-Windows installs (Program Files, common drives)
///   3. `where bash` resolution
///   4. App-local PortableGit (auto-installed by Little Claude)
///
/// Cached for the process lifetime: the fallback path spawns `cmd /C where
/// bash` and the candidates stat many locations — and this is called on every
/// session start (via build_enriched_path) plus build_enriched_path's own
/// callers. Git installs happen only through install_git_bash_inner, which
/// calls invalidate_resolver_caches().
#[cfg(target_os = "windows")]
static GIT_BASH_CACHE: std::sync::OnceLock<
    std::sync::Mutex<Option<Option<(String, &'static str)>>>,
> = std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
pub(crate) fn resolve_git_bash() -> Option<(String, &'static str)> {
    let cell = GIT_BASH_CACHE
        .get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(result) = &*guard {
        return result.clone();
    }
    let result = resolve_git_bash_uncached();
    *guard = Some(result.clone());
    result
}

#[cfg(target_os = "windows")]
fn resolve_git_bash_uncached() -> Option<(String, &'static str)> {
    // 1. Explicit env var  --?user/provider knows best
    if let Ok(path) = std::env::var("CLAUDE_CODE_GIT_BASH_PATH") {
        if is_usable_git_bash(&path) {
            return Some((path, "provider"));
        }
        eprintln!(
            "[little-claude] CLAUDE_CODE_GIT_BASH_PATH='{}' is not a usable Git Bash \
             (missing usr/bin/cygpath.exe), ignoring",
            path
        );
    }

    // 2. Standard Git-for-Windows installs (both bin/ and usr/bin/ layouts)
    let mut candidates = vec![
        r"C:\Program Files\Git\usr\bin\bash.exe".to_string(),
        r"C:\Program Files\Git\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
    ];
    for drive in b'D'..=b'F' {
        let d = drive as char;
        candidates.push(format!(r"{}:\Program Files\Git\usr\bin\bash.exe", d));
        candidates.push(format!(r"{}:\Program Files\Git\bin\bash.exe", d));
    }
    for c in &candidates {
        if is_usable_git_bash(c) {
            return Some((c.to_string(), "system"));
        }
    }

    // 3. `where bash`  --?catches scoop/choco/PATH installs
    if let Ok(output) = std::process::Command::new("cmd")
        .args(["/C", "where", "bash"])
        .creation_flags(0x08000000)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let path = line.trim().to_string();
                if !path.is_empty()
                    && commands::cli_resolver::is_valid_executable(Path::new(&path))
                    && is_usable_git_bash(&path)
                {
                    return Some((path, "where"));
                }
            }
        }
    }

    // 4. App-local PortableGit (last resort  --?auto-installed by Little Claude)
    if let Some(local) = get_local_git_bash() {
        return Some((local, "app-local"));
    }

    None
}

/// Legacy wrapper kept for callers that only need the path.
#[cfg(target_os = "windows")]
pub(crate) fn find_git_bash() -> Option<String> {
    resolve_git_bash().map(|(path, _)| path)
}

pub(crate) fn find_claude_binary() -> Option<String> {
    commands::cli_resolver::find_binary()
}

/// Locate the DeepSeek Harness CLI (`dsh`) — global npm install.
pub(crate) fn find_deepseek_binary() -> Option<String> {
    commands::cli_resolver::find_binary_named(&["dsh.exe", "dsh.cmd", "dsh"])
}

/// Global app handle — set in setup(); used by the DSH service routing task
/// to emit `claude:stream:{stdinId}` events without an AppHandle parameter.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Emit one translated stream event to a tab's stream channel (no-op before
/// setup, errors swallowed — the frontend tolerates missing events).
pub(crate) fn emit_stream_event(stdin_id: &str, value: Value) -> Result<(), String> {
    let Some(app) = APP_HANDLE.get() else {
        return Ok(());
    };
    app.emit(&format!("claude:stream:{}", stdin_id), value)
        .map_err(|e| e.to_string())
}

/// Return all valid CLI binaries in priority order, for fallback iteration.
pub(crate) fn find_claude_binary_ordered() -> Vec<String> {
    commands::cli_resolver::resolve_ordered()
        .into_iter()
        .map(|(path, _)| path)
        .collect()
}

/// On macOS/Linux, GUI apps inherit a minimal launchd PATH and miss version
/// managers (nvm, volta, fnm) that are set up in login-shell config files.
/// This function spawns a login shell once, captures its PATH, and caches it
/// for the lifetime of the process via OnceLock.
#[cfg(not(target_os = "windows"))]
pub(crate) fn login_shell_extra_path() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let output = std::process::Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !p.is_empty() {
                    eprintln!(
                        "login shell PATH captured ({} entries)",
                        p.split(':').count()
                    );
                }
                p
            }
            _ => {
                eprintln!("login shell PATH capture failed");
                String::new()
            }
        }
    })
}

/// Capture proxy-related environment variables from the user's login shell.
/// GUI apps launched from Finder/Dock don't inherit shell env vars (including
/// proxy settings), which causes API requests to fail in regions that require
/// a proxy to reach Anthropic's API.
///
/// Blocking analysis (audit item "sync shell spawn on async path"):
/// - The shell probe runs at most ONCE per process lifetime, guarded by
///   `OnceLock`. Proxy env vars do not change while the app is running, so
///   caching is safe and makes every later call a lock-free HashMap lookup.
/// - The one-time initialization is guaranteed to happen in Tauri's `.setup()`
///   callback (see `run()` below), which runs on the main thread BEFORE the
///   event loop starts and before any IPC command can be dispatched. All async
///   call sites (`build_smart_http_client`, `start_claude_session`, ...) only
///   ever see the warm cache — they never execute the blocking shell probe on
///   a tokio worker thread.
/// - CONTRACT: do not remove the warm-up call in `.setup()`. If it ever goes
///   away, the first probe would land inside an async command and block a
///   tokio worker (potentially for seconds if `.zshrc` is heavy); the fix
///   then is to make this `async` and wrap the probe in `spawn_blocking`.
#[cfg(not(target_os = "windows"))]
pub(crate) fn login_shell_proxy_env() -> &'static HashMap<String, String> {
    static CACHE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    // Runs exactly once (see blocking analysis above); synchronous shell
    // execution is fine here because the only caller that can trigger this
    // first run is the main-thread `.setup()` warm-up.
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        // Print proxy-related vars in key=value format, one per line.
        // Must use -ic (interactive) instead of -l (login) because proxy vars
        // are typically set in .zshrc/.bashrc which are only sourced for
        // interactive shells, not non-interactive login shells.
        let script = r#"for v in https_proxy http_proxy all_proxy no_proxy HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY; do eval "val=\$$v"; if [ -n "$val" ]; then echo "$v=$val"; fi; done"#;
        let output = std::process::Command::new(&shell)
            .args(["-ic", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output();
        let mut map = HashMap::new();
        if let Ok(o) = output {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout);
                for line in text.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        let k = k.trim();
                        let v = v.trim();
                        if !k.is_empty() && !v.is_empty() {
                            map.insert(k.to_string(), v.to_string());
                        }
                    }
                }
            }
        }
        if !map.is_empty() {
            eprintln!("login shell proxy env captured: {:?}", map.keys().collect::<Vec<_>>());
        }
        map
    })
}

/// Read macOS system proxy settings from `scutil --proxy`.
/// M8: scutil 是同步子进程调用，会阻塞 tokio worker——加 30s TTL 缓存。
/// 系统代理在会话启动间变更的概率极低，30s 内复用缓存可接受。
#[cfg(target_os = "macos")]
fn system_proxy_url() -> Option<String> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<Option<(std::time::Instant, Option<String>)>>,
    > = std::sync::OnceLock::new();
    let cell = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    {
        let guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, val)) = &*guard {
            if at.elapsed() < std::time::Duration::from_secs(30) {
                return val.clone();
            }
        }
    }
    let fresh = system_proxy_url_uncached();
    if let Ok(mut guard) = cell.lock() {
        *guard = Some((std::time::Instant::now(), fresh.clone()));
    }
    fresh
}

#[cfg(target_os = "macos")]
fn system_proxy_url_uncached() -> Option<String> {
    let output = std::process::Command::new("scutil")
        .arg("--proxy")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let get_val = |key: &str| -> Option<String> {
        text.lines()
            .find(|l| l.trim().starts_with(&format!("{} :", key)))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let is_enabled = |key: &str| get_val(key).map_or(false, |v| v == "1");

    // Prefer HTTPS > SOCKS > HTTP
    if is_enabled("HTTPSEnable") {
        if let (Some(host), Some(port)) = (get_val("HTTPSProxy"), get_val("HTTPSPort")) {
            let url = format!("http://{}:{}", host, port);
            eprintln!("system proxy detected (HTTPS): {}", url);
            return Some(url);
        }
    }
    if is_enabled("SOCKSEnable") {
        if let (Some(host), Some(port)) = (get_val("SOCKSProxy"), get_val("SOCKSPort")) {
            let url = format!("socks5://{}:{}", host, port);
            eprintln!("system proxy detected (SOCKS): {}", url);
            return Some(url);
        }
    }
    if is_enabled("HTTPEnable") {
        if let (Some(host), Some(port)) = (get_val("HTTPProxy"), get_val("HTTPPort")) {
            let url = format!("http://{}:{}", host, port);
            eprintln!("system proxy detected (HTTP): {}", url);
            return Some(url);
        }
    }
    None
}

/// Probe common local proxy ports and return the first reachable one.
/// Re-probes every call (fast: ~100ms worst case) so proxy tools started after
/// Little Claude is still detected. Covers Clash, Surge, common SOCKS.
/// M8: 原实现用同步 connect_timeout，在 tokio worker 上阻塞 80ms × 4 端口
/// （会话启动与 HTTP client 构建都会走到这里）——改为异步 connect + 超时。
async fn probe_local_proxy() -> Option<String> {
    let ports: &[(u16, &str)] = &[
        (7890, "http"),   // Clash default
        (7897, "http"),   // Clash Verge default
        (6152, "http"),   // Surge HTTP
        (1080, "socks5"), // Common SOCKS
    ];
    for &(port, scheme) in ports {
        let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
        let reachable = tokio::time::timeout(
            std::time::Duration::from_millis(80),
            tokio::net::TcpStream::connect(addr),
        )
        .await
        .map_or(false, |r| r.is_ok());
        if reachable {
            let url = format!("{}://127.0.0.1:{}", scheme, port);
            eprintln!("auto-detected local proxy: {}", url);
            return Some(url);
        }
    }
    None
}

/// Resolve the best proxy URL from environment variables, system proxy, and login shell.
/// Returns Some(url) if a proxy is configured, None otherwise.
async fn resolve_proxy_url() -> Option<String> {
    // 1. Check current process env vars (set by VPN/Clash when running)
    let from_env = std::env::var("https_proxy")
        .ok()
        .or_else(|| std::env::var("HTTPS_PROXY").ok())
        .or_else(|| std::env::var("all_proxy").ok())
        .or_else(|| std::env::var("ALL_PROXY").ok())
        .or_else(|| std::env::var("http_proxy").ok())
        .or_else(|| std::env::var("HTTP_PROXY").ok());
    if let Some(url) = from_env {
        if !url.is_empty() {
            return Some(url);
        }
    }
    // 2. macOS system proxy (System Settings > Network > Proxy)
    #[cfg(target_os = "macos")]
    {
        if let Some(url) = system_proxy_url() {
            return Some(url);
        }
    }
    // 3. macOS/Linux GUI apps don't inherit shell env; check login shell
    // Note: this may run on a tokio worker thread (build_smart_http_client /
    // start_claude_session are async), but the cache is always warm here — the
    // blocking probe ran exactly once in `.setup()` on the main thread before
    // the event loop started. This call is a lock-free HashMap lookup.
    #[cfg(not(target_os = "windows"))]
    {
        let proxy_env = login_shell_proxy_env();
        let url = proxy_env
            .get("https_proxy")
            .or_else(|| proxy_env.get("HTTPS_PROXY"))
            .or_else(|| proxy_env.get("all_proxy"))
            .or_else(|| proxy_env.get("ALL_PROXY"))
            .or_else(|| proxy_env.get("http_proxy"))
            .or_else(|| proxy_env.get("HTTP_PROXY"));
        if let Some(u) = url {
            if !u.is_empty() {
                return Some(u.clone());
            }
        }
    }
    // 4. Probe common local proxy ports (Clash 7890, Surge 6152, SOCKS 1080)
    if let Some(url) = probe_local_proxy().await {
        return Some(url);
    }
    None
}

/// Inject proxy URL into environment variables for CLI subprocess.
/// Sets both HTTP(S) proxy vars and, for SOCKS proxies, all_proxy/ALL_PROXY.
fn inject_proxy_env_vars(env: &mut std::collections::HashMap<String, String>, proxy_url: &str) {
    for key in &["https_proxy", "http_proxy", "HTTPS_PROXY", "HTTP_PROXY"] {
        env.insert(key.to_string(), proxy_url.to_string());
    }
    if proxy_url.starts_with("socks") {
        env.insert("all_proxy".to_string(), proxy_url.to_string());
        env.insert("ALL_PROXY".to_string(), proxy_url.to_string());
    }
}

/// Check if a proxy endpoint is actually reachable (TCP connect with 1s timeout).
pub(crate) async fn is_proxy_reachable(proxy_url: &str) -> bool {
    // Parse host:port from proxy URL like "http://127.0.0.1:7890"
    let addr = proxy_url
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("socks5://")
        .trim_start_matches("socks5h://")
        .trim_end_matches('/');
    match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

/// Build a reqwest Client with smart proxy handling.
///
/// Logic: if a proxy URL is found in env/login-shell, probe the proxy port first.
/// If reachable  --?use proxy; if not (VPN off)  --?bypass and connect directly.
/// This makes the app "just work" regardless of VPN state.
pub(crate) async fn build_smart_http_client(
    connect_timeout: std::time::Duration,
    request_timeout: std::time::Duration,
) -> reqwest::Client {
    // Reuse clients across calls  --?building a reqwest::Client (TLS + pool) on
    // every request is wasteful. Keyed by timeout + the resolved proxy so a
    // proxy change still yields a fresh client. Only the no-proxy client is
    // cached: when a proxy is configured we re-probe reachability each call to
    // honor VPN on/off (the "smart proxy" behavior).
    let proxy_key = resolve_proxy_url().await.unwrap_or_default();
    let cache_key = format!(
        "{}|{}|{}",
        connect_timeout.as_millis(),
        request_timeout.as_millis(),
        proxy_key
    );
    static CLIENTS: std::sync::OnceLock<
        tokio::sync::Mutex<std::collections::HashMap<String, reqwest::Client>>,
    > = std::sync::OnceLock::new();
    if proxy_key.is_empty() {
        if let Some(c) = CLIENTS
            .get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .await
            .get(&cache_key)
        {
            return c.clone();
        }
    }

    let mut builder = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .no_proxy(); // Disable automatic env proxy reading  --?we manage it ourselves

    if let Some(proxy_url) = resolve_proxy_url().await {
        if is_proxy_reachable(&proxy_url).await {
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                eprintln!("Smart proxy: using proxy {}", proxy_url);
                builder = builder.proxy(proxy);
            }
        } else {
            eprintln!(
                "Smart proxy: proxy {} unreachable, connecting directly",
                proxy_url
            );
        }
    }

    let client = builder.build().unwrap_or_else(|_| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap_or_default()
    });
    if proxy_key.is_empty() {
        CLIENTS
            .get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .await
            .insert(cache_key, client.clone());
    }
    client
}

/// Truncate excessively large string values inside a JSON structure.
/// Used to prevent Tauri IPC / WebView freezes when Claude CLI returns
/// huge tool results (e.g. 24MB PDF text content).
fn truncate_large_content(value: &mut Value, max_bytes: usize) {
    match value {
        Value::String(s) => {
            if s.len() > max_bytes {
                // Truncate at a safe UTF-8 boundary
                let mut end = max_bytes;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push_str(
                    "\n\n... [content truncated for display, full content available to Claude]",
                );
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                truncate_large_content(item, max_bytes);
            }
        }
        Value::Object(map) => {
            for (_k, v) in map.iter_mut() {
                truncate_large_content(v, max_bytes);
            }
        }
        _ => {}
    }
}

/// Build an enriched PATH that includes common binary locations
///
/// Cached for the process lifetime (see invalidate_resolver_caches): the
/// assembly stats dozens of candidate directories and calls resolve_git_bash,
/// and it runs on every session start / check_claude_cli / title generation.
static ENRICHED_PATH_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

pub(crate) fn build_enriched_path() -> String {
    let cell = ENRICHED_PATH_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = &*guard {
        return cached.clone();
    }
    let result = build_enriched_path_uncached();
    *guard = Some(result.clone());
    result
}

/// Invalidate the process-lifetime resolver caches (CLI tier scan, git bash
/// discovery, enriched PATH). Call after install/update/delete of CLI, Node,
/// or Git — the caches must reflect the new filesystem state.
pub(crate) fn invalidate_resolver_caches() {
    commands::cli_resolver::invalidate_cli_cache();
    #[cfg(target_os = "windows")]
    if let Some(m) = GIT_BASH_CACHE.get() {
        if let Ok(mut guard) = m.lock() {
            *guard = None;
        }
    }
    if let Some(m) = ENRICHED_PATH_CACHE.get() {
        if let Ok(mut guard) = m.lock() {
            *guard = None;
        }
    }
}

fn build_enriched_path_uncached() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut paths = vec![];

    #[cfg(target_os = "windows")]
    let separator = ";";
    #[cfg(not(target_os = "windows"))]
    let separator = ":";

    // Highest priority: local npm-global/bin (where CLI is installed via local npm)
    if let Some(npm_bin) = get_npm_global_bin() {
        paths.push(npm_bin.to_string_lossy().to_string());
    }

    // Local Node.js bin (for running npm-installed CLI)
    if let Some(node_bin) = get_local_node_bin() {
        paths.push(node_bin.to_string_lossy().to_string());
    }

    // App-local CLI download directory
    if let Some(cli_dir) = cli_download_dir() {
        paths.push(cli_dir.to_string_lossy().to_string());
    }

    // App-local Git (PortableGit) bin directory (Windows only)
    #[cfg(target_os = "windows")]
    {
        if let Ok(git_dir) = git_download_dir() {
            let git_bin = git_dir.join("bin");
            if git_bin.exists() {
                paths.push(git_bin.to_string_lossy().to_string());
            }
            // Also add cmd/ for git.exe
            let git_cmd = git_dir.join("cmd");
            if git_cmd.exists() {
                paths.push(git_cmd.to_string_lossy().to_string());
            }
            // Also add usr/bin/ for cygpath.exe (required by Claude CLI for path conversion)
            let git_usr_bin = git_dir.join("usr").join("bin");
            if git_usr_bin.exists() {
                paths.push(git_usr_bin.to_string_lossy().to_string());
            }
        }

        // Also check system-installed Git (not just app-local PortableGit)
        // to find usr/bin/cygpath.exe which Claude CLI needs for path conversion.
        if let Some((git_bash_path, _source)) = resolve_git_bash() {
            // git_bash_path is like "D:\Program Files\Git\bin\bash.exe"
            // We need the parent's parent to get the Git root, then add usr/bin
            let bash_path = std::path::Path::new(&git_bash_path);
            if let Some(git_root) = bash_path.parent().and_then(|p| p.parent()) {
                let usr_bin = git_root.join("usr").join("bin");
                if usr_bin.exists() {
                    let usr_bin_str = usr_bin.to_string_lossy().to_string();
                    if !paths.contains(&usr_bin_str) {
                        paths.push(usr_bin_str);
                    }
                }
                // Also ensure Git bin/ and cmd/ are in PATH
                for sub in &["bin", "cmd"] {
                    let dir = git_root.join(sub);
                    if dir.exists() {
                        let dir_str = dir.to_string_lossy().to_string();
                        if !paths.contains(&dir_str) {
                            paths.push(dir_str);
                        }
                    }
                }
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        {
            if let Some(app_data) = dirs::data_dir() {
                paths.push(app_data.join("npm").to_string_lossy().to_string());
            }
            if let Some(local_app) = dirs::data_local_dir() {
                paths.push(
                    local_app
                        .join("Programs")
                        .join("claude-code")
                        .to_string_lossy()
                        .to_string(),
                );
            }
            paths.push(
                home.join("scoop")
                    .join("shims")
                    .to_string_lossy()
                    .to_string(),
            );
            paths.push(
                home.join(".cargo")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );
            paths.push(
                home.join(".volta")
                    .join("bin")
                    .to_string_lossy()
                    .to_string(),
            );

            // nvm-windows: version dirs inside %NVM_HOME% (or %APPDATA%\nvm)
            let nvm_home = std::env::var("NVM_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|_| dirs::config_dir().map(|d| d.join("nvm")).ok_or(()))
                .ok();
            if let Some(ref nvm_dir) = nvm_home {
                if nvm_dir.is_dir() {
                    if let Ok(entries) = std::fs::read_dir(nvm_dir) {
                        let mut version_dirs: Vec<std::path::PathBuf> = entries
                            .flatten()
                            .filter(|e| {
                                e.path().is_dir()
                                    && e.file_name().to_string_lossy().starts_with('v')
                            })
                            .map(|e| e.path())
                            .collect();
                        version_dirs.sort();
                        if let Some(latest) = version_dirs.last() {
                            paths.push(latest.to_string_lossy().to_string());
                        }
                    }
                }
            }
            // nvm-windows symlink (typically C:\Program Files\nodejs)
            if let Ok(symlink) = std::env::var("NVM_SYMLINK") {
                paths.push(symlink);
            }

            // fnm on Windows
            paths.push(
                home.join(".fnm")
                    .join("aliases")
                    .join("default")
                    .to_string_lossy()
                    .to_string(),
            );

            // Standard Node.js install path
            if let Ok(pf) = std::env::var("ProgramFiles") {
                let node_path = format!("{}\\nodejs", pf);
                paths.push(node_path);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            paths.push(home.join(".cargo/bin").to_string_lossy().to_string());
            paths.push(home.join(".local/bin").to_string_lossy().to_string());
            paths.push(home.join(".npm-global/bin").to_string_lossy().to_string());

            // volta (version manager)  --?shims live here
            paths.push(home.join(".volta/bin").to_string_lossy().to_string());

            // fnm (version manager)  --?default alias symlink
            paths.push(
                home.join(".fnm/aliases/default/bin")
                    .to_string_lossy()
                    .to_string(),
            );

            // nvm: find the latest installed Node.js version
            let nvm_dir = std::env::var("NVM_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| home.join(".nvm"));
            let nvm_versions = nvm_dir.join("versions/node");
            if nvm_versions.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    let mut version_dirs: Vec<std::path::PathBuf> = entries
                        .flatten()
                        .filter(|e| e.path().is_dir())
                        .map(|e| e.path())
                        .collect();
                    version_dirs.sort_by(|a, b| {
                        let parse_ver = |p: &std::path::Path| -> (u32, u32, u32) {
                            let name = p.file_name().unwrap_or_default().to_string_lossy();
                            let s = name.strip_prefix('v').unwrap_or(&name);
                            let parts: Vec<u32> =
                                s.split('.').filter_map(|x| x.parse().ok()).collect();
                            (
                                parts.first().copied().unwrap_or(0),
                                parts.get(1).copied().unwrap_or(0),
                                parts.get(2).copied().unwrap_or(0),
                            )
                        };
                        parse_ver(a).cmp(&parse_ver(b))
                    });
                    if let Some(latest) = version_dirs.last() {
                        paths.push(latest.join("bin").to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        paths.push("/opt/homebrew/bin".to_string());
        paths.push("/usr/local/bin".to_string());
    }

    // Merge login shell PATH (macOS/Linux) to catch version managers we missed
    #[cfg(not(target_os = "windows"))]
    {
        let shell_path = login_shell_extra_path();
        if !shell_path.is_empty() {
            let existing: std::collections::HashSet<String> = paths.iter().cloned().collect();
            let extra: Vec<String> = shell_path
                .split(':')
                .filter(|p| !p.is_empty() && !existing.contains(*p))
                .map(|p| p.to_string())
                .collect();
            paths.extend(extra);
        }
    }

    let mut result = paths.join(separator);
    if !current.is_empty() {
        result.push_str(separator);
        result.push_str(&current);
    }
    result
}

// --- Credential storage (TK-303) ---

/// Directory for Little Claude app data (may be wiped by NSIS installer on Windows).
/// Dev builds use a ".dev"-suffixed directory so they never share the CLI install,
/// npm cache, or WebView data with the released app.
pub(crate) fn app_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(app_data_dir_name()))
        .ok_or_else(|| "Cannot determine app data directory".to_string())
}

/// Safe directory in user's home  --?survives Windows NSIS updates.
/// Uses ~/.tokenicode/ which already stores tracked_sessions.txt.
/// Dev builds use ~/.tokenicode.dev/ so providers/sessions stay isolated.
pub(crate) fn safe_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|d| d.join(safe_data_dir_name()))
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

/// Ensure the safe data dir exists with tightened permissions. On Unix the
/// directory is set to 0700: it holds providers.json + providers.key,
/// usage_log.jsonl and localStorage snapshots — other local users must not
/// even list its contents (C1: the master key file is 0600, but a 0755
/// directory would leak file names and, on some setups, enable traversal).
/// Idempotent; called once at setup and re-applied whenever a writer creates
/// the directory later.
pub(crate) fn ensure_safe_data_dir() -> Result<std::path::PathBuf, String> {
    let dir = safe_data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Truncate to at most `max_bytes` bytes, never splitting a UTF-8 character.
/// For log previews of CLI output (which contains Chinese text).
pub(crate) fn utf8_prefix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Keep at most the last `max_bytes` bytes, never splitting a UTF-8 character.
/// For stderr tails (ffmpeg etc.).
pub(crate) fn utf8_suffix(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

// ================================================================
// Provider system  --?multi-provider API config stored as plaintext JSON

/// Resolve provider env vars and CLI args from a provider_id.
/// Returns (extra_env, keys_to_remove, extra_args, provider_used).
/// `provider_used` is false when the provider was skipped (e.g. OpenAI-format for Claude).
fn resolve_provider_env(
    provider_id: Option<&str>,
) -> Result<(HashMap<String, String>, Vec<String>, Vec<String>, bool), String> {
    let Some(pid) = provider_id else {
        eprintln!("[LITTLECLAUDE:provider] No provider_id → using inherited environment only");
        return Ok((HashMap::new(), vec![], vec![], false));
    };

    eprintln!("[LITTLECLAUDE:provider] Resolving env for provider_id={}", pid);
    let providers_file = load_providers()?;
    let provider = providers_file
        .providers
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| format!("Provider '{}' not found", pid))?;

    // Always inject provider env vars regardless of api_format.
    // Some providers are labeled 'openai' but the actual endpoint accepts
    // Anthropic-format requests (especially universal proxies). Blocking env
    // injection here causes "Not logged in" errors that are hard to diagnose.
    // If the endpoint truly doesn't support Anthropic format, Claude CLI will
    // get a clear 400 error — the user can then switch to Codex backend.
    if provider.api_format == "openai" {
        eprintln!(
            "[LITTLECLAUDE:provider] Provider '{}' has api_format='openai' — injecting env vars anyway (endpoint may accept Anthropic format)",
            provider.name
        );
    }

    let mut env = HashMap::new();
    let mut keys_to_remove = Vec::new();

    // When a provider is active, isolate the child process from CCSwitch or
    // other external tools that may have set ANTHROPIC_* in the system/parent
    // environment. The CLI checks these env vars at startup; if CCSwitch set
    // ANTHROPIC_AUTH_TOKEN (OAuth), the CLI will try Bearer auth against
    // third-party endpoints and fail with a connection/auth error.
    // Explicitly clearing inherited values before setting our own ensures
    // Little Claude's provider config is the sole source of truth.
    keys_to_remove.push("ANTHROPIC_AUTH_TOKEN".to_string());
    keys_to_remove.push("ANTHROPIC_API_KEY".to_string());
    keys_to_remove.push("ANTHROPIC_BASE_URL".to_string());
    keys_to_remove.push("ANTHROPIC_MODEL".to_string());
    keys_to_remove.push("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string());
    keys_to_remove.push("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string());
    keys_to_remove.push("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string());

    // Set base URL.
    // NOTE: For api_format="openai" providers used with the Claude CLI backend,
    // the ANTHROPIC_BASE_URL is replaced by the local conversion proxy URL in
    // session.rs (start_claude_session). That proxy converts Anthropic Messages
    // requests to OpenAI chat/completions and forwards them here.
    if !provider.base_url.is_empty() {
        // Strip a trailing /v1 or /v1/messages so the CLI's Anthropic SDK
        // (which appends /v1/messages itself) does not call .../v1/v1/messages.
        // The user may enter either form; the SDK only reconstructs the
        // canonical single-/v1 endpoint from the bare host path.
        let normalized = crate::commands::provider::normalize_anthropic_base_url(
            &provider.base_url,
            &provider.api_format,
        );
        env.insert("ANTHROPIC_BASE_URL".to_string(), normalized);
    }

    // Set API key (plaintext, no encryption).
    // Only set ANTHROPIC_API_KEY  --?do NOT set ANTHROPIC_AUTH_TOKEN.
    // AUTH_TOKEN triggers OAuth/Bearer auth in the CLI, which third-party
    // providers don't support. API_KEY uses the correct x-api-key header.
    if let Some(ref key) = provider.api_key {
        if !key.is_empty() {
            env.insert("ANTHROPIC_API_KEY".to_string(), key.clone());
        }
    }

    // Merge extra_env (empty string = delete from child process env)
    // A malicious or careless provider config could inject library-hijacking
    // or path-redirecting variables (LD_PRELOAD, HOME, NODE_OPTIONS, ...) into
    // the CLI subprocess — filter those out unconditionally.
    if let Some(ref extra) = provider.extra_env {
        for (k, v) in extra {
            if is_blocked_child_env_var(k) {
                eprintln!(
                    "[LITTLECLAUDE:provider] Ignoring blocked extra_env variable '{}'",
                    k
                );
                continue;
            }
            if v.is_empty() {
                keys_to_remove.push(k.clone());
            } else {
                env.insert(k.clone(), v.clone());
            }
        }
    }

    // CRITICAL: ANTHROPIC_AUTH_TOKEN must NEVER leak into the child process when
    // a provider is active. It triggers OAuth/Bearer auth in the CLI, which breaks
    // all third-party API providers.
    //
    // We intentionally strip it AFTER merging extra_env — even if a provider preset
    // tried to set ANTHROPIC_AUTH_TOKEN via extra_env, it would be blocked here.
    // Presets should use ANTHROPIC_API_KEY (x-api-key header) for third-party
    // providers; ANTHROPIC_AUTH_TOKEN (OAuth/Bearer) only works with native Anthropic.
    env.remove("ANTHROPIC_AUTH_TOKEN");

    // Inject provider-level proxy URL into CLI subprocess env.
    // This takes highest priority  --?if set, it overrides all other proxy sources.
    if let Some(ref proxy_url) = provider.proxy_url {
        if !proxy_url.is_empty() {
            inject_proxy_env_vars(&mut env, proxy_url);
        }
    }

    // Auto-disable experimental betas for non-Anthropic providers (#69).
    // Beta flags (cache_control.scope, structured-outputs, eager_input_streaming)
    // are only supported by Anthropic's native API. Bedrock, Vertex, and all
    // third-party proxies (including those that route through Bedrock internally)
    // will return 400 errors if these flags are present.
    // Only keep betas enabled when the base URL is explicitly Anthropic's native API.
    let base_lower = provider.base_url.to_lowercase();
    let is_native_anthropic = base_lower.is_empty() || base_lower.contains("api.anthropic.com");
    if !is_native_anthropic {
        env.entry("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS".to_string())
            .or_insert_with(|| "1".to_string());
    }

    // No extra CLI args needed  --?env vars set on the process take precedence.
    // Previously we used --setting-sources project,local to skip user settings,
    // but that broke directories without .claude/ (e.g. empty/new folders) because
    // the CLI lost workspace trust and other user-level config.
    let extra_args: Vec<String> = vec![];

    Ok((env, keys_to_remove, extra_args, true)) // provider used
}

/// Environment variables that must never be settable via provider extra_env.
/// These can hijack the CLI subprocess (library preload), redirect its home/
/// temp paths, or load arbitrary code (NODE_OPTIONS). Matching is
/// case-insensitive to cover Windows env semantics.
fn is_blocked_child_env_var(name: &str) -> bool {
    const BLOCKED: &[&str] = &[
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_DEBUG",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "DYLD_FRAMEWORK_PATH",
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "PYTHONPATH",
        "PERL5LIB",
        "NODE_OPTIONS",
        "NODE_PATH",
        "CLASSPATH",
        // M1: 补齐高影响变量——PATH 防覆盖 enriched_path（CLI/git 解析劫持）、
        // BASH_ENV/ENV（bash 启动脚本劫持）、GIT_CONFIG_GLOBAL/GIT_EXEC_PATH
        // （git 配置/执行劫持）、SHELL（子 shell 劫持）、PYTHONHOME（python
        // 环境重定向）、SSL_CERT_FILE/NODE_EXTRA_CA_CERTS（TLS 证书劫持）。
        "PATH",
        "BASH_ENV",
        "ENV",
        "GIT_CONFIG_GLOBAL",
        "GIT_EXEC_PATH",
        "SHELL",
        "PYTHONHOME",
        "SSL_CERT_FILE",
        "NODE_EXTRA_CA_CERTS",
    ];
    let upper = name.to_ascii_uppercase();
    BLOCKED.contains(&upper.as_str())
}







// --- Git / Shell helpers for Rewind code restore ---

/// Resolve a usable git binary path on macOS without triggering the Xcode CLT install popup.
///
/// **Why this exists**: macOS ships `/usr/bin/git` as a shim. When Xcode Command Line Tools
/// (CLT) are not installed, running `/usr/bin/git` spawns a **GUI dialog** asking the user to
/// install CLT. Little Claude calls git for snapshot/rewind on every message, so this popup
/// would appear repeatedly.
///
/// Strategy:
///   1. `xcode-select -p`  --?checks if CLT is installed (silent, never triggers popup).
///   2. CLT installed  --?safe to use bare "git" (resolves to /usr/bin/git which works).



/// Extract a Node.js archive (tar.gz or zip) into the target directory.
pub(crate) fn extract_node_archive(
    data: &[u8],
    ext: &str,
    _archive_name: &str,
    install_dir: &std::path::Path,
) -> Result<(), String> {
    // M1: cap the TOTAL decompressed size so a crafted archive cannot
    // exhaust disk (zip-bomb defense on top of the per-entry path guards;
    // the data is SHA-256-verified today, keep the belt-and-braces anyway).
    const MAX_EXTRACT_TOTAL: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB
    match ext {
        "tar.gz" => {
            let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
            let mut archive = tar::Archive::new(decoder);
            let mut total_written: u64 = 0;

            // Node.js tar.gz extracts to a subdirectory like "node-v22.22.0-darwin-arm64/"
            // We want the contents directly in install_dir
            for entry in archive.entries().map_err(|e| format!("tar error: {}", e))? {
                let mut entry = entry.map_err(|e| format!("tar entry error: {}", e))?;
                let path = entry.path().map_err(|e| format!("path error: {}", e))?;

                // Strip the top-level directory (e.g., "node-v22.22.0-darwin-arm64/bin/node" -> "bin/node")
                // and drop traversal/root components — a crafted entry like
                // "node-v22.22.0-platform/../../evil.exe" must never escape
                // install_dir (zip-slip; data is SHA-256-verified today, but
                // keep this defense consistent with web_update.rs).
                let stripped: std::path::PathBuf = path
                    .components()
                    .skip(1) // skip "node-v22.22.0-platform/"
                    .filter(|c| {
                        !matches!(
                            c,
                            std::path::Component::ParentDir
                                | std::path::Component::CurDir
                                | std::path::Component::RootDir
                        )
                    })
                    .collect();

                if stripped.as_os_str().is_empty() {
                    continue; // skip the top-level dir itself
                }

                // Windows: a leading drive-letter segment ("C:/evil") makes
                // Path::join treat the target as absolute — reject any
                // colon-bearing segment (mirrors the zip branch).
                if stripped
                    .components()
                    .filter_map(|c| c.as_os_str().to_str())
                    .any(|seg| seg.contains(':'))
                {
                    return Err(format!("tar entry name not allowed: {}", stripped.display()));
                }

                let target = install_dir.join(&stripped);
                // Belt-and-braces: the joined target must stay inside
                // install_dir (mirrors the zip branch).
                if !target.starts_with(&install_dir) {
                    return Err(format!("tar entry escapes install dir: {}", stripped.display()));
                }
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }

                // Count the declared entry size toward the total cap before
                // unpacking (tar headers are attacker-controlled, but a lying
                // size only makes unpack fail — the cap is a disk guard).
                let size = entry
                    .header()
                    .size()
                    .map_err(|e| format!("tar size error: {}", e))?;
                total_written = total_written.saturating_add(size);
                if total_written > MAX_EXTRACT_TOTAL {
                    return Err(format!(
                        "解压总量超过 {} GiB 上限，已中止",
                        MAX_EXTRACT_TOTAL / (1024 * 1024 * 1024)
                    ));
                }

                entry
                    .unpack(&target)
                    .map_err(|e| format!("unpack error for {:?}: {}", stripped, e))?;
            }
            Ok(())
        }
        "zip" => {
            let reader = std::io::Cursor::new(data);
            let mut archive =
                zip::ZipArchive::new(reader).map_err(|e| format!("zip open error: {}", e))?;
            let mut total_written: u64 = 0;

            for i in 0..archive.len() {
                let mut file = archive
                    .by_index(i)
                    .map_err(|e| format!("zip entry error: {}", e))?;

                let name = file.name().to_string();
                // Strip top-level directory (e.g., "node-v22.22.0-win-x64/node.exe" -> "node.exe")
                // and drop ".", ".." and empty segments — a crafted entry like
                // "node-v22.22.0-win-x64/../../evil.exe" must never escape
                // install_dir (zip-slip; see the tar branch above).
                // Split on BOTH '/' and '\\': Windows zip entries may use
                // backslashes ("..\\evil.exe") which Path::join resolves as
                // separators even though they never appear in the filter.
                // The top-level split must use the same dual separator —
                // a backslash-separated top dir ("node-v22\\node.exe") would
                // otherwise yield an empty strip and silently extract nothing.
                let stripped: String = name
                    .splitn(2, |c| c == '/' || c == '\\')
                    .nth(1)
                    .unwrap_or("")
                    .split(|c| c == '/' || c == '\\')
                    .filter(|part| !part.is_empty() && *part != "." && *part != "..")
                    .collect::<Vec<_>>()
                    .join("/");
                if stripped.is_empty() {
                    continue;
                }
                // Windows: a leading drive-letter segment ("C:/evil.exe") makes
                // Path::join treat the target as absolute and write outside
                // install_dir — reject any colon-bearing segment outright.
                if stripped.split('/').any(|seg| seg.contains(':')) {
                    return Err(format!("zip entry name not allowed: {}", name));
                }

                let target = install_dir.join(&stripped);
                // Belt-and-braces: the joined target must stay inside install_dir.
                if !target.starts_with(&install_dir) {
                    return Err(format!("zip entry escapes install dir: {}", name));
                }
                if file.is_dir() {
                    let _ = std::fs::create_dir_all(&target);
                } else {
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let mut outfile = std::fs::File::create(&target)
                        .map_err(|e| format!("create file error: {}", e))?;
                    let n = std::io::copy(&mut file, &mut outfile)
                        .map_err(|e| format!("write error: {}", e))?;
                    total_written = total_written.saturating_add(n);
                    if total_written > MAX_EXTRACT_TOTAL {
                        return Err(format!(
                            "解压总量超过 {} GiB 上限，已中止",
                            MAX_EXTRACT_TOTAL / (1024 * 1024 * 1024)
                        ));
                    }
                }
            }
            Ok(())
        }
        _ => Err(format!("Unsupported archive format: {}", ext)),
    }
}


pub(crate) fn normalize_deepseek_model_name(model: &str) -> String {
    let trimmed = model.trim();
    let lower = trimmed.to_lowercase();
    let compact: String = lower
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '.' | '(' | ')' | '[' | ']' | '-'))
        .collect();

    // Only normalize actual DeepSeek model names.
    // Claude model IDs (opus/sonnet/haiku/fable) are handled by the CLI's
    // own model resolution and should NOT be mapped to DeepSeek.
    if compact.contains("deepseekv4pro") {
        return "deepseek-v4-pro".to_string();
    }
    if compact.contains("deepseekv4flash") {
        return "deepseek-v4-flash".to_string();
    }

    trimmed.to_string()
}


// ── H2: 会话代际（generation）──
// 同一 session_id 重新 start 时旧进程被杀，其 stdout reader 任务随后读到 EOF；
// 若此时 map 条目已被新会话替换，旧 reader 的清理（remove）会误杀新进程，
// 退出事件会被当成新会话的伪 process_exit 发给前端。为每个 session_id 维护
// 单调递增的代际号：reader 捕获自己的代际，在清理/emit 前校验仍是当前代际，
// 不是则直接返回（把生命周期完全交给新会话自己的 reader）。
// 条目不删除：删除后重新 start 会从 1 重新计数，可能与新 reader 的代际碰撞。
// 低 4: 条目数超限时（512 条，约 ~50KB）清理最旧插入的一半，防无界增长。
// 清理按「插入顺序最旧」而非任意条目，避免误删仍活跃会话的代际。
static SESSION_GENERATIONS: std::sync::OnceLock<std::sync::Mutex<GenerationRegistry>> =
    std::sync::OnceLock::new();

/// H2 代际注册表：map 供 O(1) 查询，order 记录插入顺序供超限清理。
struct GenerationRegistry {
    map: HashMap<String, u64>,
    order: std::collections::VecDeque<String>,
}

/// 代际条目上限；超过后清理最旧的一半（最久未插入的会话大概率已结束）。
const MAX_GENERATION_ENTRIES: usize = 512;

/// 全局单调递增的代际号源：即使条目被清理后重新 start，新代际号也永不
/// 与任何旧 reader 持有过的号碰撞（原始设计靠「条目不删除 + 每会话自增」
/// 防碰撞，清理会破坏该不变量——全局计数在清理下仍保持单调）。
static GLOBAL_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn session_generations() -> &'static std::sync::Mutex<GenerationRegistry> {
    SESSION_GENERATIONS.get_or_init(|| {
        std::sync::Mutex::new(GenerationRegistry {
            map: HashMap::new(),
            order: std::collections::VecDeque::new(),
        })
    })
}

/// 会话启动时递增代际号并返回新值；旧 reader 持有的代际号随之失效。
/// 必须在杀掉旧进程之前调用，避免旧 reader 在 EOF 后抢先通过校验。
pub(crate) fn bump_session_generation(session_id: &str) -> u64 {
    let mut reg = session_generations().lock().unwrap_or_else(|e| e.into_inner());
    // 低 4: 仅在插入新条目前超限时清理（已有条目不触发），从队头移除最旧的
    // 一半——被清理的会话若已结束，其 reader 早已退出，无副作用。
    if !reg.map.contains_key(session_id) && reg.map.len() >= MAX_GENERATION_ENTRIES {
        for _ in 0..(MAX_GENERATION_ENTRIES / 2) {
            if let Some(oldest) = reg.order.pop_front() {
                reg.map.remove(&oldest);
            } else {
                break;
            }
        }
    }
    // 全局唯一代际号：条目被清理后重新 start 也不会与旧 reader 的号碰撞
    let gen = GLOBAL_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    reg.map.insert(session_id.to_string(), gen);
    if !reg.order.iter().any(|s| s.as_str() == session_id) {
        reg.order.push_back(session_id.to_string());
    }
    gen
}

/// 校验 `generation` 是否仍是 `session_id` 的当前代际（false = 已过期，直接返回）。
pub(crate) fn is_session_generation_current(session_id: &str, generation: u64) -> bool {
    let reg = session_generations().lock().unwrap_or_else(|e| e.into_inner());
    reg.map.get(session_id).copied() == Some(generation)
}

async fn start_codex_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    params: StartSessionParams,
    stdin_id: String,
    generation: u64,
) -> Result<SessionInfo, String> {
    let backend = backends::resolve_backend(Some("codex"));

    // Resolve the codex binary
    let codex_bin = backend.find_binary().ok_or_else(|| {
        "Codex CLI not found. Install it with: npm install -g @openai/codex".to_string()
    })?;

    eprintln!(
        "[LITTLECLAUDE:codex] Starting Codex session {} with binary: {}",
        stdin_id, codex_bin
    );

    // ── Write Codex config.toml from active provider ──
    if let Some(ref provider_id) = params.provider_id {
        match load_providers() {
            Ok(providers_file) => {
                if let Some(provider) = providers_file
                    .providers
                    .iter()
                    .find(|p| p.id == *provider_id)
                {
                    let sandbox = match params.permission_mode.as_deref() {
                        Some("bypassPermissions") => "danger-full-access",
                        Some("acceptEdits") => "workspace-write",
                        _ => "read-only",
                    };
                    let effort = params.thinking_level.as_deref().map(|l| match l {
                        "off" => "low",
                        "low" => "low",
                        "medium" => "medium",
                        "high" => "high",
                        "xhigh" => "xhigh",
                        "max" => "max",
                        _ => "medium",
                    });
                    let toml_content =
                        backends::codex_config::generate_config_toml(
                            provider, sandbox, effort, params.context_window,
                            params.model.as_deref(),
                        );
                    if let Err(e) =
                        backends::codex_config::write_config(&toml_content)
                    {
                        eprintln!(
                            "[LITTLECLAUDE:codex] Failed to write config.toml: {}",
                            e
                        );
                    }
                } else {
                    eprintln!(
                        "[LITTLECLAUDE:codex] Provider '{}' not found in providers.json",
                        provider_id
                    );
                }
            }
            Err(e) => {
                eprintln!(
                    "[LITTLECLAUDE:codex] Failed to load providers for config: {}",
                    e
                );
            }
        }
    }

    // Build args and env
    let args = backend.build_args(&params);
    let mut env = backend.build_env(&params);

    // Inject Codex API key as env var (Codex uses env_key, not inline api_key)
    if let Some(ref provider_id) = params.provider_id {
        if let Ok(providers_file) = load_providers() {
            if let Some(provider) = providers_file.providers.iter().find(|p| p.id == *provider_id) {
                if let Some(ref key) = provider.api_key {
                    if !key.is_empty() {
                        env.insert("TOKENICODE_CODEX_API_KEY".to_string(), key.clone());
                    }
                }
            }
        }
    }

    // Build enriched PATH
    let enriched_path = build_enriched_path();

    // Spawn the Codex process
    #[cfg(target_os = "windows")]
    let mut child = {
        let needs_cmd = codex_bin.ends_with(".cmd")
            || codex_bin.ends_with(".bat")
            || (!codex_bin.contains('\\') && !codex_bin.contains('/') && !codex_bin.contains('.'));
        let mut cmd = if needs_cmd {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(&codex_bin);
            c
        } else {
            tokio::process::Command::new(&codex_bin)
        };
        cmd.args(&args)
            .current_dir(&params.cwd)
            .env("PATH", &enriched_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000);
        for (key, value) in &env {
            cmd.env(key, value);
        }
        cmd.spawn().map_err(|e| format!("Failed to spawn codex: {}", e))?
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let mut cmd = tokio::process::Command::new(&codex_bin);
        #[cfg(unix)]
        {
            // H4: own process group so ProcessManager::remove can reap the
            // whole tree with kill(-pid) — same rationale as the Claude path.
            cmd.process_group(0);
        }
        cmd.args(&args)
            .current_dir(&params.cwd)
            .env("PATH", &enriched_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &env {
            cmd.env(key, value);
        }
        cmd.spawn().map_err(|e| format!("Failed to spawn codex: {}", e))?
    };

    let pid = child.id().unwrap_or(0);
    eprintln!("[LITTLECLAUDE:codex] Spawned pid={}", pid);

    // Capture stdin/stdout/stderr
    let stdin = child.stdin.take().ok_or("Failed to capture codex stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture codex stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture codex stderr")?;

    // Store stdin handle
    stdin_mgr.insert(stdin_id.clone(), stdin).await;
    // Store process
    state.insert(
        stdin_id.clone(),
        ManagedProcess {
            child,
            backend: "codex".to_string(),
        },
    ).await;

    // Send initial message (initialize  --?id=1)
    if let Some(init_msg) = backend.build_initial_message(&params) {
        if let Err(e) = stdin_mgr.send(&stdin_id, &init_msg).await {
            // L8: 首条消息发送失败时进程/句柄已注册——清理（remove 会 kill 进程，
            // reader 随后 EOF 并 emit 真实退出事件），避免残留条目与幽灵进程。
            stdin_mgr.remove(&stdin_id).await;
            state.remove(&stdin_id).await;
            return Err(e);
        }
    }

    // Extract fields needed in the reader task (before moving params)
    let initial_prompt = params.prompt.clone();
    let resume_id = params.resume_session_id.clone();

    // Spawn stdout reader with handshake state machine
    let app_clone = app.clone();
    let sid_clone = stdin_id.clone();
    // M3: the reader task writes via StdinManager::send (per-session lock +
    // 10s timeout), not by holding the global handle map — a wedged codex
    // process must not stall every other session's sends.
    // Note: `State<T>` itself implements Clone, so `stdin_mgr.clone()` would
    // copy the borrow-lifetime State wrapper (E0521 in the 'static task) —
    // deref to the underlying Arc-backed StdinManager instead.
    let stdin_mgr_clone = (*stdin_mgr).clone();
    let backend_ref = backends::resolve_backend(Some("codex"));
    let process_mgr_clone = state.inner().codex_thread_ids.clone();
    let pm_clone = state.inner().clone(); // shallow clone (Arc) — F3 post-loop orphan kill

    tokio::spawn(async move {
        let stream_event = format!("claude:stream:{}", sid_clone);
        let reader = BufReader::with_capacity(1024 * 1024, stdout);
        let mut lines = reader.lines();
        let mut line_count: u64 = 0;
        let mut read_err_count: u32 = 0;
        let mut clean_eof = false;
        // H2: 本 reader 属于哪一代会话——EOF 后据此判断自己是否已被新会话替代。
        let my_generation = generation;

        // ─── Handshake state machine ───────────────────────────────────
        // Phase 0: waiting for initialize response (id=1)
        // Phase 1: waiting for thread/resume response (id=2)
        // Phase 2: streaming (handshake complete)
        let mut phase: u8 = 0;

        // Helper: check if a JSON line is a SUCCESS response matching the
        // given request id. #4 (bug): error responses must NOT match here —
        // they used to, letting error frames flow down the success path.
        fn is_response(line: &str, expected_id: u64) -> bool {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                v.get("id").and_then(|i| i.as_u64()) == Some(expected_id)
                    && v.get("result").is_some()
                    && v.get("error").is_none()
            } else {
                false
            }
        }

        // Helper: check if a JSON line is an ERROR response for the given id
        fn is_error_response(line: &str, expected_id: u64) -> Option<String> {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v.get("id").and_then(|i| i.as_u64()) == Some(expected_id) {
                    return v.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .map(String::from);
                }
            }
            None
        }

        loop {
            // H2: kill-rebuild 后旧 reader 的循环仍在读旧进程输出并 emit 到
            // 同名通道——每轮先校验代际，过期立即返回，通道完全交给新会话
            // （循环外的 1797 处 EOF 门控挡不住循环内的 emit）。
            if !is_session_generation_current(&sid_clone, my_generation) {
                return;
            }
            let line = match lines.next_line().await {
                Ok(Some(line)) => {
                    read_err_count = 0;
                    line
                }
                Ok(None) => {
                    clean_eof = true;
                    break;
                }
                Err(e) => {
                    // F1: a single invalid-UTF-8 line makes tokio's `lines()`
                    // return Err(InvalidData), but that line's bytes are already
                    // consumed — skip it instead of abandoning the session (the
                    // old `break` orphaned a live codex process; the handshake
                    // state machine simply keeps waiting for its response).
                    read_err_count += 1;
                    eprintln!(
                        "[LITTLECLAUDE:codex:WARN] stdout read error after {} lines (consecutive #{}), skipping line: {}",
                        line_count, read_err_count, e
                    );
                    if read_err_count >= 100 {
                        eprintln!(
                            "[LITTLECLAUDE:codex:CRITICAL] 100 consecutive stdout read errors, stopping stream"
                        );
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    continue;
                }
            };
            line_count += 1;

            // Log first 30 lines for debugging (increased from 10)
            if line_count <= 30 {
                let preview = utf8_prefix(&line, 300);
                eprintln!("[LITTLECLAUDE:codex:stdout] #{} {}", line_count, preview);
            }

            match phase {
                0 => {
                    // ── Waiting for initialize response (id=1) ──
                    if let Some(err_msg) = is_error_response(&line, 1) {
                        eprintln!(
                            "[LITTLECLAUDE:codex] Handshake: init ERROR (line {}): {}",
                            line_count, err_msg
                        );
                        // Emit error to frontend
                        let _ = app_clone.emit(&stream_event, serde_json::json!({
                            "type": "result",
                            "subtype": "error",
                            "result": format!("Codex init failed: {}", err_msg),
                            "usage": { "input_tokens": 0, "output_tokens": 0 },
                            "duration_ms": 0,
                            "num_turns": 0
                        }));
                        break; // exit read loop
                    }
                    if is_response(&line, 1) {
                        eprintln!(
                            "[LITTLECLAUDE:codex] Handshake: init response received (line {})",
                            line_count
                        );

                        // Emit system:init event to frontend
                        if let Some(event) =
                            backend_ref.translate_stdout_line(&line, &sid_clone)
                        {
                            if let Ok(payload) = serde_json::to_value(&event) {
                                let _ = app_clone.emit(&stream_event, payload);
                            }
                        }

                        // Send initialized notification (no id)
                        let initialized_msg =
                            crate::backends::codex::CodexBackend::build_initialized_message();
                        let _ = stdin_mgr_clone.send(&sid_clone, &initialized_msg).await;

                        // Send thread/resume (unified thread lifecycle)
                        let thread_msg =
                            crate::backends::codex::CodexBackend::build_thread_start_message(
                                resume_id.as_deref(),
                            );
                        let _ = stdin_mgr_clone.send(&sid_clone, &thread_msg).await;

                        let action = if resume_id.is_some() { "resume" } else { "new" };
                        let method_label = if resume_id.is_some() { "thread/resume" } else { "thread/start" };
                        eprintln!(
                            "[LITTLECLAUDE:codex] Handshake: sent initialized + {} ({})",
                            method_label, action
                        );
                        phase = 1;
                    } else {
                        // During phase 0, still emit any notifications to frontend
                        // (e.g. thread/status/changed may arrive early)
                        if let Some(event) =
                            backend_ref.translate_stdout_line(&line, &sid_clone)
                        {
                            if let Ok(payload) = serde_json::to_value(&event) {
                                let _ = app_clone.emit(&stream_event, payload);
                            }
                        }
                    }
                }
                1 => {
                    // ── Waiting for thread/resume response (id=2) ──
                    if let Some(err_msg) = is_error_response(&line, 2) {
                        eprintln!(
                            "[LITTLECLAUDE:codex] Handshake: thread/resume ERROR (line {}): {} — retrying with thread/start",
                            line_count, err_msg
                        );
                        // Resume failed (thread expired, wrong backend, etc.).
                        // Fall back to thread/start — create a new thread instead
                        // of killing the entire session.
                        let _ = app_clone.emit(&stream_event, serde_json::json!({
                            "type": "system",
                            "subtype": "info",
                            "message": format!("Resume failed ({}), starting new session.", err_msg)
                        }));

                        let fallback_msg =
                            crate::backends::codex::CodexBackend::build_thread_start_message(None);
                        let _ = stdin_mgr_clone.send(&sid_clone, &fallback_msg).await;
                        eprintln!(
                            "[LITTLECLAUDE:codex] Handshake: sent thread/start (fallback after resume failure)"
                        );
                        // Stay in phase 1 — wait for the new id=2 response.
                        // #4 (bug): MUST continue here. The error frame has no
                        // result.thread.id; falling through into the success
                        // branch used to store nothing yet still advance to
                        // phase 2, where the fallback thread/start response
                        // was then dropped — every later turn/start lacked
                        // the threadId (required by Codex ≥0.146) and the
                        // session hung permanently.
                        continue;
                    }
                    if is_response(&line, 2) {
                        eprintln!(
                            "[LITTLECLAUDE:codex] Handshake: thread/resume response received (line {})",
                            line_count
                        );

                        // Parse thread ID from response for turn/start
                        let thread_id: Option<String> = serde_json::from_str::<serde_json::Value>(&line)
                            .ok()
                            .and_then(|v| {
                                v.get("result")
                                    .and_then(|r| r.get("thread"))
                                    .and_then(|t| t.get("id"))
                                    .and_then(|id| id.as_str())
                                    .map(String::from)
                            });
                        if let Some(ref tid) = thread_id {
                            let mut map = process_mgr_clone.lock().await;
                            map.insert(sid_clone.clone(), tid.clone());
                            eprintln!("[LITTLECLAUDE:codex] Handshake: stored thread_id={}", tid);

                            // Emit thread ID to frontend so sessionMeta.sessionId
                            // is updated for cross-backend resume detection.
                            let _ = app_clone.emit(
                                &stream_event,
                                serde_json::json!({
                                    "type": "system",
                                    "subtype": "codex_thread_id",
                                    "session_id": tid,
                                }),
                            );
                        }

                        // If there's an initial prompt, send turn/start
                        if !initial_prompt.is_empty() {
                            let turn_msg = backend_ref.build_user_message(
                                &initial_prompt,
                                thread_id.as_deref(),
                            );
                            let _ = stdin_mgr_clone.send(&sid_clone, &turn_msg).await;
                            eprintln!(
                                "[LITTLECLAUDE:codex] Handshake: sent turn/start with prompt"
                            );
                        } else {
                            eprintln!(
                                "[LITTLECLAUDE:codex] Handshake: no initial prompt, pre-warm only"
                            );
                        }

                        phase = 2;
                    } else {
                        // Emit notifications during thread/resume wait
                        if let Some(event) =
                            backend_ref.translate_stdout_line(&line, &sid_clone)
                        {
                            if let Ok(payload) = serde_json::to_value(&event) {
                                let _ = app_clone.emit(&stream_event, payload);
                            }
                        }
                    }
                }
                _ => {
                    // ── Streaming: translate and emit ──
                    if let Some(event) = backend_ref.translate_stdout_line(&line, &sid_clone)
                    {
                        match serde_json::to_value(&event) {
                            Ok(payload) => {
                                // Perf #17: no per-event eprintln — at token
                                // rate this flooded stderr for every frame.
                                let _ = app_clone.emit(&stream_event, payload);
                            }
                            Err(e) => {
                                eprintln!(
                                    "[LITTLECLAUDE:codex] Failed to serialize event: {}",
                                    e
                                );
                            }
                        }
                    } else if line.contains("\"method\"") {
                        // Debug: log dropped notifications (cheap prefilter
                        // before re-parsing — perf #17).
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                                eprintln!("[LITTLECLAUDE:codex] DROPPED method={}", method);
                            }
                        }
                    }
                }
            }
        }

        // H2: 同一 session_id 被重新 start 后，旧进程被杀 → 本 reader 也会走到
        // 这里。代际已递增说明本 reader 属于旧代际：若继续 remove/emit，会清掉
        // 新会话的句柄并给新会话发伪 process_exit——直接返回，交给新 reader。
        if !is_session_generation_current(&sid_clone, my_generation) {
            return;
        }

        // F3 (codex): the old code emitted process_exit without ever checking
        // whether the process actually exited — a read error or handshake
        // failure left the codex process orphaned: frontend went idle while
        // the agent kept running. Wait briefly for a real exit code; if the
        // stream ended abnormally with the process still alive, kill it (and
        // drop its stdin handle + thread-id entry) so state matches reality.
        let exit_code = pm_clone
            .wait_status(&sid_clone, std::time::Duration::from_secs(2))
            .await;
        if exit_code.is_none() && !clean_eof {
            eprintln!(
                "[LITTLECLAUDE:codex:CRITICAL] stream ended abnormally but process still alive -- killing orphaned session {sid_clone}"
            );
        }
        // 报告 B1 复查: mirror the claude path's unconditional cleanup
        // (session.rs). The codex branch used to only clean on abnormal end,
        // leaking process/stdin/thread-id entries for every normal exit —
        // list_active_processes then reported dead sessions as orphans and
        // re-killed PIDs the OS may have reused (Unix PID-reuse kill).
        // remove() kills the child; a no-op for an already-exited process.
        stdin_mgr_clone.remove(&sid_clone).await;
        pm_clone.remove_codex_thread_id(&sid_clone).await;
        pm_clone.remove(&sid_clone).await;

        // Emit process exit
        let exit_event = format!("claude:exit:{}", sid_clone);
        let _ = app_clone.emit(&stream_event, serde_json::json!({"type": "process_exit", "code": exit_code}));
        let _ = app_clone.emit(exit_event.as_str(), serde_json::json!({ "code": exit_code }));
        eprintln!(
            "[LITTLECLAUDE:codex] stdout reader done, {} lines, phase={}",
            line_count, phase
        );
    });

    // Spawn stderr reader
    let app_clone2 = app.clone();
    let sid_clone2 = stdin_id.clone();
    let backend_ref2 = backends::resolve_backend(Some("codex"));
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let stderr_event = format!("claude:stderr:{}", sid_clone2);
        let stream_event = format!("claude:stream:{}", sid_clone2);
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[LITTLECLAUDE:codex:stderr] {}", line);
            // Emit raw stderr to the stderr channel (for frontend console logging)
            let _ = app_clone2.emit(
                stderr_event.as_str(),
                serde_json::json!({"line": line}),
            );
            // Also translate and emit to stream channel so API errors appear in chat
            if let Some(event) = backend_ref2.translate_stderr_line(&line) {
                if let Ok(payload) = serde_json::to_value(&event) {
                    let _ = app_clone2.emit(&stream_event, payload);
                }
            }
        }
    });

    Ok(SessionInfo {
        session_id: stdin_id,
        pid,
        cli_path: codex_bin,
    })
}

/// Start a DeepSeek Harness task via the D-N1-B service integration:
/// ensure the `dsh web` service (reuse external or spawn), create (or reuse)
/// the tab's DSH session for real context continuity, register the session
/// route, and prompt. All streaming output arrives on the service's mux
/// WebSocket and is translated/emitted by the routing task — there is no
/// process per session anymore.
async fn start_deepseek_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    params: StartSessionParams,
    stdin_id: String,
    _generation: u64,
) -> Result<SessionInfo, String> {
    use crate::commands::dsh_service::{unary, DshRoute};
    use serde_json::json;

    let dsh_mgr = app.state::<crate::commands::dsh_service::DshServiceManager>();
    let service = dsh_mgr.ensure().await?;

    // T05: resolve the Little-Claude provider backing this DSH session
    // (load_providers returns decrypted keys). The DSH service API accepts NO
    // model or credential field on session.create/session.prompt payloads
    // (dsh-host-apiproxy sessions.schema.js:68-73,225-230), so both travel via
    // dedicated RPCs further below:
    //   model       → session.models + session.selectModel (per-session pick)
    //   credentials → credentials.set (writes ~/.dsh/.credentials.yaml, the
    //                 same store dsh's own Models page uses; ref DEEPSEEK_API_KEY)
    let dsh_provider = params.provider_id.as_ref().and_then(|pid| {
        crate::commands::provider::load_providers()
            .ok()
            .and_then(|pf| pf.providers.into_iter().find(|p| p.id == *pid))
    });

    // Reuse the tab's DSH session (real context continuity), else create one.
    let dsh_session_id = match state.get_deepseek_session(&stdin_id).await {
        Some(sid) => sid,
        None => {
            let created = unary(&service.base_url, "session.create", json!({ "cwd": params.cwd }))
                .await
                .map_err(|e| format!("dsh session.create failed: {}", e))?;
            let sid = created
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "dsh session.create returned no sessionId".to_string())?
                .to_string();
            state
                .insert_deepseek_session(&stdin_id, sid.clone(), Some(params.cwd.clone()))
                .await;
            sid
        }
    };

    // Register the route: mux events for this session reach this tab.
    // Bypass mode auto-allows approvals (no PermissionCards) — mirrors
    // Claude's --dangerously-skip-permissions.
    let auto_allow = matches!(
        params.permission_mode.as_deref(),
        Some("bypassPermissions") | Some("bypass")
    );
    {
        let routes = service.session_routes.clone();
        let mut routes = routes.lock().await;
        routes.insert(
            dsh_session_id.clone(),
            DshRoute {
                stdin_id: stdin_id.clone(),
                auto_allow,
            },
        );
    }

    eprintln!(
        "[LITTLECLAUDE:deepseek] service mode: tab={} dsh_session={} auto_allow={}",
        stdin_id, dsh_session_id, auto_allow
    );

    // T05 credential sync: dsh's `deepseek-official` provider resolves
    // DEEPSEEK_API_KEY through its credentials service at request time
    // (dsh-llm-deepseek: DEFAULT_API_KEY_ENV / MISSING_CREDENTIAL). The
    // supported write path is the credentials.set RPC — exactly what dsh's
    // own web Models page does — landing in ~/.dsh/.credentials.yaml. An
    // explicit DEEPSEEK_API_KEY in the provider's extra_env wins over the
    // apiKey field (mirrors the claude-backend env layering). A rejection
    // (e.g. the launching environment shadows the ref read-only) only warns:
    // dsh keeps its own key and the session proceeds with it.
    if let Some(ref provider) = dsh_provider {
        let key = provider
            .extra_env
            .as_ref()
            .and_then(|env| env.get("DEEPSEEK_API_KEY"))
            .filter(|k| !k.trim().is_empty())
            .cloned()
            .or_else(|| provider.api_key.clone().filter(|k| !k.trim().is_empty()));
        if let Some(key) = key {
            match unary(
                &service.base_url,
                "credentials.set",
                json!({ "ref": "DEEPSEEK_API_KEY", "value": key }),
            )
            .await
            {
                Ok(_) => eprintln!(
                    "[LITTLECLAUDE:deepseek] T05: synced provider '{}' API key into dsh credentials (DEEPSEEK_API_KEY)",
                    provider.name
                ),
                Err(e) => eprintln!(
                    "[LITTLECLAUDE:deepseek] T05: credentials.set rejected ({}); dsh keeps its own DEEPSEEK_API_KEY (env / .credentials.yaml)",
                    e
                ),
            }
        } else {
            eprintln!(
                "[LITTLECLAUDE:deepseek] T05: provider '{}' has no API key — relying on dsh-side credentials (see settings guidance)",
                provider.name
            );
        }
    }

    // T05 model passthrough (see apply_deepseek_model below).
    if let Some(ref model) = params.model {
        apply_deepseek_model(&service.base_url, &dsh_session_id, model).await;
    }

    // Prompt (queue mode — steer/interrupts go through send_stdin/kill).
    if let Err(e) = unary(
        &service.base_url,
        "session.prompt",
        json!({
            "sessionId": dsh_session_id,
            "mode": "queue",
            "content": [{ "type": "text", "text": params.prompt }],
        }),
    )
    .await
    {
        // Prompt failed (service respawned, model misconfig, …) — the
        // created DSH session and its route are now useless. Drop both so
        // the next attempt starts clean instead of retrying a dead session.
        state.remove_deepseek_session(&stdin_id).await;
        service.session_routes.lock().await.remove(&dsh_session_id);
        service.translators.lock().await.remove(&dsh_session_id);
        service.last_seqs.lock().await.remove(&dsh_session_id);
        return Err(format!("dsh session.prompt failed: {}", e));
    }

    let dsh_bin = crate::find_deepseek_binary().unwrap_or_default();
    let _ = stdin_mgr; // service mode has no stdin pipe
    Ok(SessionInfo {
        session_id: stdin_id,
        pid: 0,
        cli_path: dsh_bin,
    })
}

/// T05: per-session model passthrough for the DSH backend.
///
/// Research conclusion: the DSH service API has NO model field on
/// `session.create` (workspaceId/cwd/sessionId/agentPreset only) or
/// `session.prompt` (sessionId/mode/content/clientTimeZone only) — see
/// dsh-host-apiproxy sessions.schema.js. The supported per-session path is
/// `session.models` (current selection + provider-group catalog) followed by
/// `session.selectModel` (sessionId + provider + model), which the host
/// validates against the adapter catalog (api-proxy.js selectModel).
///
/// Best-effort by design: any failure only logs and the session keeps dsh's
/// current/default model — a model mismatch must never sink the message.
async fn apply_deepseek_model(base_url: &str, dsh_session_id: &str, requested: &str) {
    use crate::commands::dsh_service::unary;
    use serde_json::json;

    let requested = requested.trim();
    if requested.is_empty() {
        return;
    }

    let catalog = match unary(
        base_url,
        "session.models",
        json!({ "sessionId": dsh_session_id }),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[LITTLECLAUDE:deepseek] T05: session.models failed ({}); model '{}' not passed through",
                e, requested
            );
            return;
        }
    };

    // Already the requested model — skip the selectModel churn (selectModel
    // also rewrites dsh's saved default, so no-op calls are worth avoiding).
    let current = catalog
        .get("current")
        .and_then(|c| c.get("model"))
        .and_then(|m| m.as_str())
        .unwrap_or_default();
    if current.eq_ignore_ascii_case(requested) {
        eprintln!(
            "[LITTLECLAUDE:deepseek] T05: model '{}' already selected in dsh session",
            requested
        );
        return;
    }

    // Find the provider group whose catalog lists the requested model id.
    let mut chosen: Option<(String, String)> = None;
    if let Some(groups) = catalog.get("groups").and_then(|g| g.as_array()) {
        for group in groups {
            let provider_id = group.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if provider_id.is_empty() {
                continue;
            }
            if let Some(models) = group.get("models").and_then(|m| m.as_array()) {
                for m in models {
                    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                    if id.eq_ignore_ascii_case(requested) {
                        chosen = Some((provider_id.to_string(), id.to_string()));
                        break;
                    }
                }
            }
            if chosen.is_some() {
                break;
            }
        }
    }

    match chosen {
        Some((provider_id, model_id)) => {
            match unary(
                base_url,
                "session.selectModel",
                json!({
                    "sessionId": dsh_session_id,
                    "provider": provider_id,
                    "model": model_id,
                }),
            )
            .await
            {
                Ok(selected) => eprintln!(
                    "[LITTLECLAUDE:deepseek] T05: model passthrough '{}' -> {}/{} (selected: {})",
                    requested, provider_id, model_id, selected
                ),
                Err(e) => eprintln!(
                    "[LITTLECLAUDE:deepseek] T05: session.selectModel rejected '{}' ({}/{}): {}; keeping the dsh default model",
                    requested, provider_id, model_id, e
                ),
            }
        }
        None => eprintln!(
            "[LITTLECLAUDE:deepseek] T05: model '{}' not in the dsh catalog and session.create/session.prompt accept no model field — keeping the dsh default model",
            requested
        ),
    }
}


/// WebView2 Evergreen runtime detection for Windows — the portable EXE does
/// NOT embed the runtime (Win10 20H2+ ships it), but stripped/LTSC systems
/// may lack it, and without it the webview window fails to create (blank/
/// instantly-crashing app).
///
/// The Evergreen runtime installs its files under
/// `Microsoft\EdgeWebView\Application` — per-user (LocalAppData) or
/// machine-wide (Program Files x86 / Program Files).
#[cfg(target_os = "windows")]
fn webview2_runtime_present() -> bool {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        candidates.push(local.join("Microsoft").join("EdgeWebView").join("Application"));
    }
    if let Some(px86) = std::env::var_os("PROGRAMFILES(X86)").map(std::path::PathBuf::from) {
        candidates.push(px86.join("Microsoft").join("EdgeWebView").join("Application"));
    }
    if let Some(pf) = std::env::var_os("PROGRAMFILES").map(std::path::PathBuf::from) {
        candidates.push(pf.join("Microsoft").join("EdgeWebView").join("Application"));
    }
    candidates.iter().any(|dir| {
        std::fs::read_dir(dir)
            .map(|mut it| it.next().is_some()) // dir exists and is non-empty
            .unwrap_or(false)
    })
}

/// Native message box (no webview available yet, so no Tauri dialog) telling
/// the user the WebView2 runtime is missing, offering to open the download
/// page, then exiting — the app cannot render without it.
#[cfg(target_os = "windows")]
fn ensure_webview2_runtime() {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_SYSTEMMODAL, MB_YESNO,
    };

    if webview2_runtime_present() {
        return;
    }
    eprintln!("[little-claude] WebView2 runtime not found — prompting user");
    let title = w!("Little Claude - Missing WebView2 runtime");
    let body = w!("This app needs the Microsoft Edge WebView2 runtime, which \
        Windows 10 (20H2+) usually includes.\n\n\
        It was not found on this system, so the app cannot start.\n\n\
        Open the official download page to install it (no admin rights needed)?");
    let result = unsafe {
        MessageBoxW(
            None,
            body,
            title,
            MB_YESNO | MB_ICONWARNING | MB_SYSTEMMODAL,
        )
    };
    if result == IDYES {
        // go.microsoft.com/fwlink/p/?LinkId=2124703 = WebView2 Evergreen Bootstrapper
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", "https://go.microsoft.com/fwlink/p/?LinkId=2124703"])
            .spawn();
    }
    std::process::exit(1);
}

/// 窗口 URL：dev 指向 vite dev server；release 走注册的 tokico 协议
/// （Windows 上 Tauri 将 tokico:// 映射为 http://tokico.localhost）。
fn app_window_url(path: &str) -> tauri::WebviewUrl {
    #[cfg(debug_assertions)]
    {
        tauri::WebviewUrl::External(
            format!("http://localhost:15200/{}", path)
                .parse()
                .expect("dev window url"),
        )
    }
    #[cfg(not(debug_assertions))]
    {
        #[cfg(target_os = "windows")]
        let url = format!("http://tokico.localhost/{}", path);
        #[cfg(not(target_os = "windows"))]
        let url = format!("tokico://localhost/{}", path);
        tauri::WebviewUrl::External(url.parse().expect("tokico window url"))
    }
}

/// 手动创建窗口（tauri.conf.json 的 windows 数组已移除）——
/// 需要 WebviewWindowBuilder 注入 WebView2 附加参数。
///
/// 背景：本机主显示器挂在 Intel UHD 核显上，WebView2 151 的 GPU
/// blocklist 把该 Intel 驱动列入软渲染名单（2026-08-08 自动更新后
/// 生效），动态壁纸视频因此软解码+软合成掉帧（GPU 进程 CPU 60%+、
/// renderer 软解 ~16%）。注入 `--ignore-gpu-blocklist` 让核显恢复
/// 硬件解码/合成。附加参数会覆盖 wry 默认值，须同时带上默认的
/// msWebOOUI 等 disable 参数。additional_browser_args 仅 Windows
/// 生效（其他平台 no-op），方法本身全平台可调用。
fn create_app_windows(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // M6 (security): msSmartScreenProtection removed from the disable list —
    // turning off SmartScreen for the whole app amplified any download/run
    // chain; the GPU-blocklist workaround stands on its own.
    let browser_args = "--disable-features=msWebOOUI,msPdfOOUI --ignore-gpu-blocklist";
    let _main = {
        let b = tauri::WebviewWindowBuilder::new(app, "main", app_window_url(""))
            .title("Little Claude")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0);
        #[cfg(target_os = "macos")]
        let b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
        b.additional_browser_args(browser_args).build()?
    };
    let _pet = tauri::WebviewWindowBuilder::new(app, "pet", app_window_url("pet.html"))
        .title("Little Claude Pet")
        .inner_size(240.0, 320.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .additional_browser_args(browser_args)
        .build()?;
    // Double-belt: transparent + always-on-top + skip-taskbar windows have a
    // history of ignoring the initial visible(false) on WebView2 (a brief
    // flash or, on some builds, staying visible). The pet must NOT appear
    // unless the user enables it — the frontend calls show() explicitly.
    if let Some(pet_win) = app.get_webview_window("pet") {
        let _ = pet_win.hide();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2 GPU 硬件加速兜底：机器带虚拟显示适配器（向日葵/GameViewer
    // IddDriver）或混合显卡时，Chromium 的 D3D11 初始化常被 GPU blocklist
    // 误伤而回退 WARP 软件渲染——全屏视频壁纸在软渲染下会拖垮整个 UI
    // （实测 GPU 进程加载 D3D10Warp.dll，CPU 达数百秒）。在 WebView2 环境
    // 创建前注入浏览器参数忽略 blocklist，强制走硬件加速；若强开仍失败，
    // 前端壁纸的掉帧自检降级机制（透明→静态）作为最终兜底。
    #[cfg(target_os = "windows")]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--ignore-gpu-blocklist");
    }
    let t_run = std::time::Instant::now();
    eprintln!("[little-claude] run() start");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch — focus the existing window instead of starting a
            // second process writing to the same user-data directories.
            let _ = app
                .get_webview_window("main")
                .map(|win| {
                    let _ = win.show();
                    let _ = win.set_focus();
                });
        }))
        .manage(ProcessManager::new())
        .manage(StdinManager::new())
        .manage(crate::commands::anthropic_proxy::ProxyManager::new())
        .manage(WatcherManager::default())
        .manage(crate::commands::dsh_service::DshServiceManager::new())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Custom protocol: serve frontend SPA from embedded binary (release mode).
        // In dev mode this is unused — Vite dev server handles all requests.
        .register_asynchronous_uri_scheme_protocol("tokico", |_ctx, request, responder| {
            // On macOS/Linux: tokico://localhost/path/to/file
            // On Windows:      http://tokico.localhost/path/to/file
            // Use uri.path() to extract path portably, skip leading '/'
            let path = request.uri().path().trim_start_matches('/');
            let (body, content_type) = resolve_frontend_asset(path)
                .unwrap_or_else(|| {
                    // Fallback to index.html for SPA routing
                    resolve_frontend_asset("index.html")
                        .unwrap_or_else(|| (b"Not Found".to_vec(), "text/plain; charset=utf-8"))
                });
            responder.respond(
                tauri::http::Response::builder()
                    .header("Content-Type", content_type)
                    .header("Cache-Control", "public, max-age=31536000, immutable")
                    .status(200)
                    .body(body)
                    .unwrap(),
            );
        })
        .setup({
            let t_run = t_run;
            move |app| {
            // `app` is only used by the feature-gated skill installer (video-analysis).
            #[cfg(not(feature = "video-analysis"))]
            let _ = &app;
            eprintln!("[little-claude] setup start, {:?} since run()", t_run.elapsed());
            // D-N1-B: global handle for the DSH service routing task to emit
            // stream events without threading AppHandle through every call.
            let _ = APP_HANDLE.set(app.handle().clone());
            // 手动创建主窗口与桌宠窗口（conf 的 windows 数组已移除，见
            // create_app_windows 注释：注入 --ignore-gpu-blocklist 修复
            // Intel 核显被 WebView2 151 blocklist 导致的壁纸软渲染卡顿）
            create_app_windows(app)?;
            // titleBarStyle: "Overlay" in tauri.conf.json handles macOS traffic lights
            // and native titlebar drag/double-click-to-maximize automatically.

            // One-time cleanup: purge desk_* entries from tracked_sessions.txt
            cleanup_tracked_sessions();

            // C1: create/tighten the safe data dir (Unix 0700) once at startup
            // so providers.json/providers.key/usage_log live in a private dir.
            let _ = ensure_safe_data_dir();

            // Release mode: frontend is bundled into the binary by Tauri's
            // native asset system (bundle.active=true, targets=[]).
            // No custom protocol navigation needed — Tauri serves the
            // embedded frontend automatically via its internal protocol.

            // Install bundled skill bodies (no heavy runtime deps).
            #[cfg(feature = "video-analysis")]
            if let Err(e) = install_bundled_video_analysis_skill(app.handle()) {
                eprintln!(
                    "[little-claude] Failed to install bundled video-analysis skill: {}",
                    e
                );
            }

            // Propagate proxy env vars from login shell to the process environment
            // so that ALL HTTP clients can reach external services through the proxy.
            // WARM-UP (keep this call): this is the one and only place where the
            // blocking shell probe in login_shell_proxy_env() may execute — main
            // thread, before the event loop starts, so it cannot stall any async
            // worker. It fills the OnceLock cache, guaranteeing that every later
            // call from async contexts (build_smart_http_client,
            // start_claude_session) is a cache hit. See the blocking analysis in
            // login_shell_proxy_env() docs.
            #[cfg(not(target_os = "windows"))]
            {
                let proxy_env = login_shell_proxy_env();
                for (k, v) in proxy_env {
                    if std::env::var(k).is_err() {
                        // SAFETY: called once during single-threaded setup
                        unsafe {
                            std::env::set_var(k, v);
                        }
                    }
                }
            }

            // Updater plugin removed — portable EXE uses GitHub Releases API
            // (checked from the frontend via fetch()). No auto-download, no
            // installer, no restart. User opens browser to download manually.
            #[cfg(not(desktop))]
            let _ = app;

            // Model-window table pre-warm: fetch LiteLLM's model list in the
            // background so the first session spawn / Ctx bar render resolves
            // the declared context window without a blocking network round
            // trip. Silent failure — the hardcoded fallback list still works.
            prewarm_model_windows();

            // M3: warm the CLI resolver caches on the main thread while
            // setup is still cheap. The first session start otherwise pays
            // the 0.5-3s synchronous probe (cmd /C where, login-shell PATH,
            // dozens of directory stats) on a tokio worker, stalling the
            // first message. All three are OnceLock caches: subsequent
            // callers get a lock-free cache hit.
            {
                let _ = find_claude_binary();
                let _ = build_enriched_path();
                #[cfg(target_os = "windows")]
                {
                    let _ = resolve_git_bash();
                }
            }

            eprintln!("[little-claude] setup done, {:?} since run()", t_run.elapsed());
            Ok(())
        }})
        .invoke_handler(tauri::generate_handler![
            start_claude_session,
            commands::model_windows::get_model_context_window,
            commands::model_windows::load_model_windows,
            preview_open_url,
            preview_refresh,
            preview_back,
            preview_forward,
            send_stdin,
            send_raw_stdin,
            kill_session,
            list_active_processes,
            track_session,
            delete_session,
            list_sessions,
            get_profile_stats,
            read_dsh_session_turns,
            write_handoff_file,
            append_usage_record,
            search_sessions,
            load_session,
            load_session_tail, // T03: 大会话分页——尾部首页
            load_session_more, // T03: 大会话分页——按游标向上取更早一页
            commands::files::authorize_external_path,
            commands::files::register_workspace_root,
            commands::profile::sync_dsh_usage,
            read_file_tree,
            read_file_content,
            write_file_content,
            copy_file,
            rename_file,
            delete_file,
            create_directory,
            open_in_vscode,
            reveal_in_finder,
            open_with_default_app,
            share_file,
            share_to_wechat,
            export_session_markdown,
            export_session_json,
            list_recent_projects,
            watch_directory,
            unwatch_directory,
            save_temp_file,
            get_file_size,
            check_file_access,
            read_file_base64,
            save_imported_pet,
            read_imported_pet,
            list_imported_pets,
            list_slash_commands,
            list_skills,
            read_skill,
            write_skill,
            delete_skill,
            toggle_skill_enabled,
            #[cfg(feature = "video-analysis")]
            get_video_analysis_runtime_status,
            #[cfg(feature = "video-analysis")]
            dismiss_video_analysis_runtime_prompt,
            #[cfg(feature = "video-analysis")]
            download_video_analysis_runtime,
            #[cfg(feature = "video-analysis")]
            open_video_analysis_skill_dir,
            get_speech_runtime_status,
            download_speech_runtime,
            open_speech_skill_dir,
            #[cfg(feature = "video-analysis")]
            get_video_analysis_multimodal_config,
            #[cfg(feature = "video-analysis")]
            save_video_analysis_multimodal_config,
            #[cfg(feature = "video-analysis")]
            set_video_analysis_acceleration,
            #[cfg(feature = "video-analysis")]
            set_video_analysis_asr_model,
            list_all_commands,
            translate_skill_metadata,
            translate_skill_markdown,
            run_git_command,
            rewind_files,
            dsh_fork_session,
            truncate_session_history,
            set_dock_icon,
            run_claude_command,
            run_claude_plugin_command,
            check_prerequisites,
            check_claude_cli,
            check_codex_cli,
            diagnose_cli,
            cleanup_old_cli,
            pin_cli,
            unpin_cli,
            get_pinned_cli,
            inject_cli_path,
            delete_cli,
            install_prerequisite,
            install_claude_cli,
            update_claude_cli,
            check_cli_update,
            install_codex_cli,
            update_codex_cli,
            check_codex_update,
            check_dsh_cli,
            install_dsh_cli,
            check_dsh_update,
            update_dsh_cli,
            export_codex_to_claude,
            export_claude_to_codex,
            check_node_env,
            install_node_env,
            check_local_model_service,
            list_local_models,
            pull_local_model,
            start_claude_login,
            check_claude_auth,
            open_terminal_login,
            generate_session_title,
            load_providers,
            sync_providers,
            test_provider_connection,
            list_provider_models,
            encrypt_value,
            decrypt_value,
            respond_permission,
            send_control_request,
            // Wallpaper
            list_wallpapers,
            delete_wallpaper,
            get_wallpaper_path,
            compress_wallpaper,
            start_wallpaper_server,
            // Interview module — mimo direct mode
            interview_start_system_audio_raw,
            interview_stop_system_audio_raw,
            interview_mimo_answer,
            interview_prewarm_connection,
            interview_test_mimo,
            // Local ASR — model management (always registered, feature-gated internally)
            check_local_asr_runtime,
            check_local_asr_model,
            download_local_asr_model,
            delete_local_asr_model,
            test_local_asr,
            start_local_asr_session,
            push_local_asr_audio,
            stop_local_asr_session,
            transcribe_and_reset_local_asr,
            // 通用下载取消（CancellationToken）
            commands::download_cancel::cancel_download,
            // 前端资源热更新（免重装升级）
            commands::web_update::download_web_update,
            commands::web_update::get_web_resource_version,
            // localStorage 磁盘持久化 + origin 迁移（设置免疫 origin 变更）
            commands::ls_persist::load_ls_snapshot,
            commands::ls_persist::save_ls_entry,
            commands::ls_persist::remove_ls_entry,
            commands::ls_persist::ensure_migrated,
            commands::ls_persist::receive_ls_migration_dump,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Check the WebView2 runtime BEFORE the window/webview is created —
    // without it the app renders nothing (blank window), so fail loudly
    // with a native prompt instead. Never runs in dev on macOS/Linux.
    #[cfg(target_os = "windows")]
    ensure_webview2_runtime();

    // D-N1-B: the spawned `dsh web` child has `kill_on_drop(true)`, but on
    // Windows the spawn goes through `cmd /C`, so dropping the Child only
    // kills cmd.exe — the node process would linger and keep the port busy.
    // Tear down explicitly on exit (taskkill /T kills the whole tree);
    // external services are never touched (spawned=false).
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(mgr) = app_handle
                .try_state::<crate::commands::dsh_service::DshServiceManager>()
            {
                mgr.teardown();
            }
        }
    });
}

#[cfg(test)]
mod decode_tests {
    use crate::commands::provider::provider_messages_endpoint;
    use crate::commands::session::{
        decode_project_name, encode_project_name, truncate_jsonl_content,
    };

    // ── encode_project_name tests ─────────────────────────────

    #[test]
    fn test_encode_unix() {
        assert_eq!(encode_project_name("/Users/a/my-app"), "-Users-a-my-app");
    }

    #[test]
    fn test_encode_windows() {
        // `\` `:`  --?`-`, so C:\  --?C--, each \  --?-
        assert_eq!(encode_project_name("C:\\Users\\a\\my-app"), "C--Users-a-my-app");
    }

    #[test]
    fn test_encode_windows_spaces() {
        // Spaces and dots also replaced with `-`
        assert_eq!(
            encode_project_name("D:\\agent self\\agent\\tokenicode-src"),
            "D--agent-self-agent-tokenicode-src"
        );
    }

    #[test]
    fn test_encode_decode_roundtrip_unix() {
        let original = "/Users/tinyzhuang/Documents/FocusZone";
        let encoded = encode_project_name(original);
        let decoded = decode_project_name(&encoded);
        // decode may produce different path if dirs exist, but format should be correct
        assert!(decoded.contains("Users") && decoded.contains("tinyzhuang"));
    }

    #[test]
    fn test_encode_decode_roundtrip_windows() {
        let original = "C:\\Users\\a\\Desktop";
        let encoded = encode_project_name(original);
        assert_eq!(encoded, "C--Users-a-Desktop");
    }

    // ── Existing tests ───────────────────────────────────────

    #[test]
    fn test_openai_endpoint_keeps_deepseek_bare_base_url() {
        assert_eq!(
            provider_messages_endpoint("https://api.deepseek.com", "openai"),
            "https://api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn test_openai_endpoint_keeps_v1_base_url() {
        assert_eq!(
            provider_messages_endpoint("https://api.deepseek.com/v1", "openai"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_openai_endpoint_keeps_full_chat_completions_url() {
        assert_eq!(
            provider_messages_endpoint("https://api.deepseek.com/v1/chat/completions", "openai"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_simple_path() {
        let result = decode_project_name("-Users-tinyzhuang-Documents-FocusZone");
        assert_eq!(result, "/Users/tinyzhuang/Documents/FocusZone");
    }

    /// 自包含临时根目录（按测试名区分，避免并行跑冲突）。
    /// decode_project_name 靠磁盘存在性消歧——这些测试之前硬编码了原作者
    /// 家目录下的真实路径（~/Desktop/jd 设计 等），任何其他机器上目录
    /// 不存在，解码退化成分段 fallback，断言必然失败（或假绿）。
    fn temp_root(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tok-decode-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// encode → decode 完整还原断言。目录刚创建必然存在，任意机器可复现。
    fn assert_roundtrip(dir: &std::path::Path) {
        let encoded = encode_project_name(&dir.to_string_lossy());
        let decoded = decode_project_name(&encoded);
        assert_eq!(decoded, dir.to_string_lossy());
    }

    #[test]
    fn test_hyphenated_dir() {
        // A dir with hyphens in its name
        let root = temp_root("hy");
        std::fs::create_dir_all(root.join("ppt-maker")).unwrap();
        assert_roundtrip(&root.join("ppt-maker"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn test_hidden_dir_double_dash() {
        // "FocusZone/.claude-worktrees/condescending-brown"
        // "/" -> "-", "." -> empty part making "--"
        // Join segment-by-segment so the path string uses one separator style
        // (a "/" inside a push argument is preserved on Windows).
        let root = temp_root("hidden");
        let target = root
            .join("FocusZone")
            .join(".claude-worktrees")
            .join("condescending-brown");
        std::fs::create_dir_all(&target).unwrap();
        assert_roundtrip(&target);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn test_nested_subdir() {
        let root = temp_root("nested");
        let target = root.join("test").join("NiCode");
        std::fs::create_dir_all(&target).unwrap();
        assert_roundtrip(&target);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn test_space_in_dir_name() {
        // "jd 设计" with a space in the dir name (space encodes to '-').
        let root = temp_root("space");
        let target = root.join("jd 设计");
        std::fs::create_dir_all(&target).unwrap();
        assert_roundtrip(&target);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // ── truncate_jsonl_content tests ─────────────────────────────

    const TURN1: &str = r#"{"type":"user","userType":"external","message":{"role":"user","content":[{"type":"text","text":"q1"}]}}"#;
    const ASST1: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a1"}]}}"#;
    // Real CLI 2.1.220 SDK-mode shape: tool_result lines are ALSO
    // userType:"external" — only their content (tool_result blocks) gives
    // them away. They must NOT count as user turns.
    const TOOLRES: &str = r#"{"type":"user","userType":"external","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1"}]}}"#;
    // System-injected continuation summary (compaction) — not a user turn.
    const SYSINJ: &str = r#"{"type":"user","userType":"external","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context."}}"#;
    const TURN2: &str = r#"{"type":"user","userType":"external","message":{"role":"user","content":[{"type":"text","text":"q2"}]}}"#;
    const ASST2: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a2"}]}}"#;
    const TURN3: &str = r#"{"type":"user","userType":"external","message":{"role":"user","content":[{"type":"text","text":"q3"}]}}"#;

    fn session_jsonl() -> String {
        format!("{}\n{}\n{}\n{}\n{}\n{}\n", TURN1, ASST1, TOOLRES, TURN2, ASST2, TURN3)
    }

    #[test]
    fn test_truncate_keeps_before_turn() {
        // 3 real turns → truncate before turn 3 keeps turns 1-2 complete
        // (including the tool_result line, which must NOT count as a turn).
        let content = session_jsonl();
        let kept = truncate_jsonl_content(&content, 3).unwrap().unwrap();
        let expected = format!("{}\n{}\n{}\n{}\n{}\n", TURN1, ASST1, TOOLRES, TURN2, ASST2);
        assert_eq!(kept, expected);
    }

    #[test]
    fn test_truncate_tool_result_not_a_turn() {
        // A session whose only "user" lines are tool_results has zero turns.
        let content = format!("{}\n{}\n", TOOLRES, TOOLRES);
        let err = truncate_jsonl_content(&content, 1).unwrap_err();
        assert!(err.contains("only 0 user turns"), "unexpected error: {}", err);
    }

    #[test]
    fn test_truncate_system_injection_not_a_turn() {
        // A continuation summary between real turns must not shift the count:
        // turns are TURN1, TURN2, TURN3 — the injected line is skipped.
        let content = format!("{}\n{}\n{}\n{}\n{}\n", TURN1, ASST1, SYSINJ, TURN2, TURN3);
        let kept = truncate_jsonl_content(&content, 3).unwrap().unwrap();
        // Truncate before turn 3 → drop TURN3, keep everything before it.
        let expected = format!("{}\n{}\n{}\n{}\n", TURN1, ASST1, SYSINJ, TURN2);
        assert_eq!(kept, expected);
    }

    #[test]
    fn test_truncate_keeps_crlf_line_endings() {
        // Windows CLI writes \r\n; the truncated file must keep them so the
        // CLI's own parser sees byte-identical lines.
        let content = format!("{}\r\n{}\r\n{}\r\n", TURN1, ASST1, TURN2);
        let kept = truncate_jsonl_content(&content, 2).unwrap().unwrap();
        assert_eq!(kept, format!("{}\r\n{}\r\n", TURN1, ASST1));
    }

    #[test]
    fn test_truncate_first_turn_deletes_all() {
        // Rewound before turn 1: entire history dropped → None (caller deletes file).
        let content = session_jsonl();
        assert_eq!(truncate_jsonl_content(&content, 1).unwrap(), None);
    }

    #[test]
    fn test_truncate_turn_out_of_range() {
        let content = session_jsonl(); // 3 turns
        let err = truncate_jsonl_content(&content, 5).unwrap_err();
        assert!(err.contains("only 3 user turns"), "unexpected error: {}", err);
    }

    #[test]
    fn test_truncate_zero_rejected() {
        let err = truncate_jsonl_content("x\n", 0).unwrap_err();
        assert!(err.contains("must be >= 1"), "unexpected error: {}", err);
    }
}
