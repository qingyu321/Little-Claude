pub mod backends;
mod commands;
mod embedded_resources;
pub mod interview;
mod protocol;

use commands::{ApiProvider, ManagedProcess, ProcessManager, SessionInfo, StartSessionParams, StdinManager, WatcherManager};
use commands::session::cleanup_tracked_sessions;
use commands::video_analysis::install_bundled_video_analysis_skill;
use commands::{append_usage_record, check_claude_auth, check_claude_cli, check_cli_update, check_codex_cli, check_codex_update, check_file_access, check_local_model_service, check_node_env, check_prerequisites, cleanup_old_cli, compress_wallpaper, copy_file, create_directory, decrypt_value, delete_cli, delete_file, delete_session, delete_skill, delete_wallpaper, diagnose_cli, dismiss_video_analysis_runtime_prompt, download_speech_runtime, download_video_analysis_runtime, encrypt_value, export_claude_to_codex, export_codex_to_claude, export_session_json, export_session_markdown, generate_session_title, get_file_size, get_local_node_bin, get_npm_global_bin, get_pinned_cli, get_profile_stats, get_speech_runtime_status, get_video_analysis_multimodal_config, get_video_analysis_runtime_status, get_wallpaper_path, inject_cli_path, install_claude_cli, install_codex_cli, install_node_env, install_prerequisite, kill_session, list_active_processes, list_all_commands, list_local_models, list_provider_models, list_recent_projects, list_sessions, list_skills, list_slash_commands, list_wallpapers, load_providers, load_session, open_in_vscode, open_speech_skill_dir, open_terminal_login, open_video_analysis_skill_dir, open_with_default_app, pin_cli, preview_back, preview_forward, preview_open_url, preview_refresh, pull_local_model, read_file_base64, read_file_content, read_file_tree, read_skill, rename_file, respond_permission, reveal_in_finder, rewind_files, run_claude_command, run_claude_plugin_command, run_git_command, save_temp_file, save_video_analysis_multimodal_config, search_sessions, send_control_request, send_raw_stdin, send_stdin, set_dock_icon, set_video_analysis_acceleration, set_video_analysis_asr_model, share_file, share_to_wechat, start_claude_login, start_claude_session, start_wallpaper_server, sync_providers, test_provider_connection, toggle_skill_enabled, track_session, translate_skill_markdown, translate_skill_metadata, unpin_cli, unwatch_directory, update_claude_cli, update_codex_cli, watch_directory, write_file_content, write_skill};
use crate::embedded_resources::resolve_frontend_asset;
use interview::commands::{interview_mimo_answer, interview_prewarm_connection, interview_start_system_audio_raw, interview_stop_system_audio_raw, interview_test_mimo};
use interview::local_asr::{check_local_asr_model, check_local_asr_runtime, delete_local_asr_model, download_local_asr_model, test_local_asr, start_local_asr_session, push_local_asr_audio, stop_local_asr_session, transcribe_and_reset_local_asr};
// protocol module kept for ControlRequest (send_control_request) and tests
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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

/// GCS bucket for Claude Code releases.
pub(crate) const CLI_GCS_BASE: &str = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

/// Self-hosted mirror for China users.
pub(crate) const CLI_MIRROR_BASE: &str = "https://herear.cn:8443/releases/claude-code";

/// Path to the CLI download directory under the app's local data dir.
pub(crate) fn cli_download_dir() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join(APP_DATA_DIR_NAME).join("cli"))
}

/// Path to the local Git installation directory (Windows only).
#[cfg(target_os = "windows")]
pub(crate) fn git_download_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(APP_DATA_DIR_NAME).join("git"))
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
#[cfg(target_os = "windows")]
pub(crate) fn resolve_git_bash() -> Option<(String, &'static str)> {
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
#[cfg(not(target_os = "windows"))]
pub(crate) fn login_shell_proxy_env() -> &'static HashMap<String, String> {
    static CACHE: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
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
/// Re-reads every call so proxy changes are picked up immediately.
#[cfg(target_os = "macos")]
fn system_proxy_url() -> Option<String> {
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
fn probe_local_proxy() -> Option<String> {
    let ports: &[(u16, &str)] = &[
        (7890, "http"),   // Clash default
        (7897, "http"),   // Clash Verge default
        (6152, "http"),   // Surge HTTP
        (1080, "socks5"), // Common SOCKS
    ];
    for &(port, scheme) in ports {
        let addr: std::net::SocketAddr = ([127, 0, 0, 1], port).into();
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(80)).is_ok()
        {
            let url = format!("{}://127.0.0.1:{}", scheme, port);
            eprintln!("auto-detected local proxy: {}", url);
            return Some(url);
        }
    }
    None
}

/// Resolve the best proxy URL from environment variables, system proxy, and login shell.
/// Returns Some(url) if a proxy is configured, None otherwise.
fn resolve_proxy_url() -> Option<String> {
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
    if let Some(url) = probe_local_proxy() {
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
    let proxy_key = resolve_proxy_url().unwrap_or_default();
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

    if let Some(proxy_url) = resolve_proxy_url() {
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
pub(crate) fn build_enriched_path() -> String {
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

/// Directory for Little Claude app data (may be wiped by NSIS installer on Windows)
pub(crate) fn app_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::data_local_dir()
        .map(|d| d.join(APP_DATA_DIR_NAME))
        .ok_or_else(|| "Cannot determine app data directory".to_string())
}

/// Safe directory in user's home  --?survives Windows NSIS updates.
/// Uses ~/.tokenicode/ which already stores tracked_sessions.txt.
pub(crate) fn safe_data_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|d| d.join(".tokenicode"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
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
        env.insert("ANTHROPIC_BASE_URL".to_string(), provider.base_url.clone());
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
    match ext {
        "tar.gz" => {
            let decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(data));
            let mut archive = tar::Archive::new(decoder);

            // Node.js tar.gz extracts to a subdirectory like "node-v22.22.0-darwin-arm64/"
            // We want the contents directly in install_dir
            for entry in archive.entries().map_err(|e| format!("tar error: {}", e))? {
                let mut entry = entry.map_err(|e| format!("tar entry error: {}", e))?;
                let path = entry.path().map_err(|e| format!("path error: {}", e))?;

                // Strip the top-level directory (e.g., "node-v22.22.0-darwin-arm64/bin/node" -> "bin/node")
                let stripped: std::path::PathBuf = path
                    .components()
                    .skip(1) // skip "node-v22.22.0-platform/"
                    .collect();

                if stripped.as_os_str().is_empty() {
                    continue; // skip the top-level dir itself
                }

                let target = install_dir.join(&stripped);
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
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

            for i in 0..archive.len() {
                let mut file = archive
                    .by_index(i)
                    .map_err(|e| format!("zip entry error: {}", e))?;

                let name = file.name().to_string();
                // Strip top-level directory (e.g., "node-v22.22.0-win-x64/node.exe" -> "node.exe")
                let stripped: String = name.splitn(2, '/').nth(1).unwrap_or("").to_string();
                if stripped.is_empty() {
                    continue;
                }

                let target = install_dir.join(&stripped);
                if file.is_dir() {
                    let _ = std::fs::create_dir_all(&target);
                } else {
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let mut outfile = std::fs::File::create(&target)
                        .map_err(|e| format!("create file error: {}", e))?;
                    std::io::copy(&mut file, &mut outfile)
                        .map_err(|e| format!("write error: {}", e))?;
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


async fn start_codex_session(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    stdin_mgr: State<'_, StdinManager>,
    params: StartSessionParams,
    stdin_id: String,
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
        stdin_mgr.send(&stdin_id, &init_msg).await?;
    }

    // Extract fields needed in the reader task (before moving params)
    let initial_prompt = params.prompt.clone();
    let resume_id = params.resume_session_id.clone();

    // Spawn stdout reader with handshake state machine
    let app_clone = app.clone();
    let sid_clone = stdin_id.clone();
    let stdin_handles = stdin_mgr.clone_handles();
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

        // ─── Handshake state machine ───────────────────────────────────
        // Phase 0: waiting for initialize response (id=1)
        // Phase 1: waiting for thread/resume response (id=2)
        // Phase 2: streaming (handshake complete)
        let mut phase: u8 = 0;

        // Helper: check if a JSON line is a response (success or error)
        // matching the given request id.
        fn is_response(line: &str, expected_id: u64) -> bool {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                v.get("id").and_then(|i| i.as_u64()) == Some(expected_id)
                    && (v.get("result").is_some() || v.get("error").is_some())
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
                        {
                            let mut map = stdin_handles.lock().await;
                            if let Some(stdin) = map.get_mut(&sid_clone) {
                                let payload = format!("{}\n", initialized_msg);
                                let _ = stdin.write_all(payload.as_bytes()).await;
                                let _ = stdin.flush().await;
                            }
                        }

                        // Send thread/resume (unified thread lifecycle)
                        let thread_msg =
                            crate::backends::codex::CodexBackend::build_thread_start_message(
                                resume_id.as_deref(),
                            );
                        {
                            let mut map = stdin_handles.lock().await;
                            if let Some(stdin) = map.get_mut(&sid_clone) {
                                let payload = format!("{}\n", thread_msg);
                                let _ = stdin.write_all(payload.as_bytes()).await;
                                let _ = stdin.flush().await;
                            }
                        }

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
                        {
                            let mut map = stdin_handles.lock().await;
                            if let Some(stdin) = map.get_mut(&sid_clone) {
                                let payload = format!("{}\n", fallback_msg);
                                let _ = stdin.write_all(payload.as_bytes()).await;
                                let _ = stdin.flush().await;
                            }
                        }
                        eprintln!(
                            "[LITTLECLAUDE:codex] Handshake: sent thread/start (fallback after resume failure)"
                        );
                        // Stay in phase 1 — wait for the new id=2 response
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
                            {
                                let mut map = stdin_handles.lock().await;
                                if let Some(stdin) = map.get_mut(&sid_clone) {
                                    let payload = format!("{}\n", turn_msg);
                                    let _ = stdin.write_all(payload.as_bytes()).await;
                                    let _ = stdin.flush().await;
                                }
                            }
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
                                eprintln!(
                                    "[LITTLECLAUDE:codex] EMITTED event type={}",
                                    payload.get("type").and_then(|v| v.as_str()).unwrap_or("?")
                                );
                                let _ = app_clone.emit(&stream_event, payload);
                            }
                            Err(e) => {
                                eprintln!(
                                    "[LITTLECLAUDE:codex] Failed to serialize event: {}",
                                    e
                                );
                            }
                        }
                    } else {
                        // Debug: log dropped notifications
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                                eprintln!("[LITTLECLAUDE:codex] DROPPED method={}", method);
                            }
                        }
                    }
                }
            }
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
        let _ = stdin_handles.lock().await.remove(&sid_clone);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .plugin(tauri_plugin_process::init())
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
            eprintln!("[little-claude] setup start, {:?} since run()", t_run.elapsed());
            // titleBarStyle: "Overlay" in tauri.conf.json handles macOS traffic lights
            // and native titlebar drag/double-click-to-maximize automatically.

            // One-time cleanup: purge desk_* entries from tracked_sessions.txt
            cleanup_tracked_sessions();

            // Release mode: frontend is bundled into the binary by Tauri's
            // native asset system (bundle.active=true, targets=[]).
            // No custom protocol navigation needed — Tauri serves the
            // embedded frontend automatically via its internal protocol.

            // Install bundled skill bodies (no heavy runtime deps).
            if let Err(e) = install_bundled_video_analysis_skill(app.handle()) {
                eprintln!(
                    "[little-claude] Failed to install bundled video-analysis skill: {}",
                    e
                );
            }

            // Propagate proxy env vars from login shell to the process environment
            // so that ALL HTTP clients can reach external services through the proxy.
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

            eprintln!("[little-claude] setup done, {:?} since run()", t_run.elapsed());
            Ok(())
        }})
        .invoke_handler(tauri::generate_handler![
            start_claude_session,
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
            append_usage_record,
            search_sessions,
            load_session,
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
            list_slash_commands,
            list_skills,
            read_skill,
            write_skill,
            delete_skill,
            toggle_skill_enabled,
            get_video_analysis_runtime_status,
            dismiss_video_analysis_runtime_prompt,
            download_video_analysis_runtime,
            open_video_analysis_skill_dir,
            get_speech_runtime_status,
            download_speech_runtime,
            open_speech_skill_dir,
            get_video_analysis_multimodal_config,
            save_video_analysis_multimodal_config,
            set_video_analysis_acceleration,
            set_video_analysis_asr_model,
            list_all_commands,
            translate_skill_metadata,
            translate_skill_markdown,
            run_git_command,
            rewind_files,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Check the WebView2 runtime BEFORE the window/webview is created —
    // without it the app renders nothing (blank window), so fail loudly
    // with a native prompt instead. Never runs in dev on macOS/Linux.
    #[cfg(target_os = "windows")]
    ensure_webview2_runtime();

    app.run(|_app_handle, _event| {});
}

#[cfg(test)]
mod decode_tests {
    use crate::commands::provider::provider_messages_endpoint;
    use crate::commands::session::{decode_project_name, encode_project_name};

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
}
