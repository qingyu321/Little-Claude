use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use futures_util::StreamExt;

use crate::{
    build_enriched_path, build_smart_http_client, cli_download_dir, find_claude_binary, strip_ansi,
    app_data_dir, extract_node_archive, find_claude_binary_ordered, CLI_GCS_BASE, CLI_MIRROR_BASE,
};
#[cfg(target_os = "windows")]
use crate::{claude_needs_cmd_wrapper, find_git_bash, git_download_dir};
use crate::backends;
use crate::commands::cli_resolver;
use crate::commands::download_cancel::{self, CancelScope};
use crate::commands::session::{encode_project_name, load_tracked_sessions, tracked_sessions_path};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::shell_single_quote;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// UUID-like validation: at least 32 chars, hex digits and hyphens only.
/// Values passing this check are safe to embed in file names and in
/// tracked_sessions.txt (no path separators, dots, or newlines possible).
/// Mirrors the local helper used in session.rs / rewind.rs.
fn is_uuid_like(s: &str) -> bool {
    s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// ── Setup: CLI Detection, Installation & Login ──────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CliStatus {
    pub(crate) installed: bool,
    pub(crate) path: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) git_bash_missing: bool,
    /// DSH service mode: whether a `dsh web` service answers on the default
    /// port (only populated by `check_dsh_cli`; None for claude/codex).
    #[serde(default)]
    pub(crate) service_running: Option<bool>,
}

/// Run a safe `claude plugin ...` command and return stdout/stderr.
///
/// Arguments are passed as process args, not through a shell string, and the
/// first plugin subcommand is allowlisted.
#[tauri::command]
pub async fn run_claude_plugin_command(
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    if args.is_empty() {
        return Err("Claude plugin command requires arguments".to_string());
    }
    let allowed = [
        "list",
        "details",
        "install",
        "i",
        "enable",
        "disable",
        "update",
        "uninstall",
        "remove",
        "prune",
        "autoremove",
        "marketplace",
    ];
    if !allowed.contains(&args[0].as_str()) {
        return Err(format!(
            "Claude plugin subcommand '{}' not allowed",
            args[0]
        ));
    }
    for arg in &args {
        if arg.len() > 512 || arg.contains('\0') || arg.contains('\r') || arg.contains('\n') {
            return Err("Invalid Claude plugin argument".to_string());
        }
    }

    let binary = find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;
    // H2 (security): on Windows a .cmd CLI runs through `cmd /C`, which
    // re-parses the whole command line — plugin names / marketplace URLs
    // containing `& | ^ < > " %` (shareable, attacker-influenceable strings)
    // would inject extra commands. Reject anything not cmd-safe; legit
    // registry/repo identifiers never need those characters.
    #[cfg(target_os = "windows")]
    if claude_needs_cmd_wrapper(&binary) {
        for arg in &args {
            if !crate::commands::session::cmd_arg_safe(arg) {
                return Err(format!(
                    "Plugin argument contains shell metacharacters and is rejected: {}",
                    arg
                ));
            }
        }
    }
    let enriched_path = build_enriched_path();
    #[cfg(target_os = "windows")]
    let mut cmd = if claude_needs_cmd_wrapper(&binary) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&binary).arg("plugin");
        c.kill_on_drop(true);
        c
    } else {
        let mut c = Command::new(&binary);
        c.arg("plugin");
        c.kill_on_drop(true);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&binary);
        c.arg("plugin");
        c.kill_on_drop(true);
        c
    };
    cmd.args(&args);
    cmd.env("PATH", &enriched_path);
    cmd.env_remove("CLAUDECODE");
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
        cmd.env("MSYS_NO_PATHCONV", "1")
            .env("MSYS2_ARG_CONV_EXCL", "*");
    }
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(180), cmd.output())
        .await
        .map_err(|_| "claude plugin command timed out after 180s".to_string())?
        .map_err(|e| format!("Failed to run claude plugin: {}", e))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        if stdout.trim().is_empty() {
            Ok(stderr.trim().to_string())
        } else {
            Ok(stdout.trim().to_string())
        }
    } else {
        let combined = if stderr.is_empty() {
            stdout
        } else {
            format!("{}\n{}", stdout, stderr)
        };
        Err(combined.trim().to_string())
    }
}

/// Check whether the Claude CLI is installed and return its path and version.
#[tauri::command]
pub async fn check_claude_cli() -> Result<CliStatus, String> {
    // 用户主动「检测」语义 = 实时：手动安装 Git/Node（错误信息引导的外部
    // 安装）没有安装事件可触发缓存失效，检测入口必须绕过缓存直接扫盘。
    crate::invalidate_resolver_caches();
    eprintln!("[check_claude_cli] START");
    let binary = find_claude_binary();
    eprintln!("[check_claude_cli] find_claude_binary => {:?}", binary);
    match binary {
        Some(path) => {
            // Try to get the version
            let enriched_path = build_enriched_path();
            eprintln!("[check_claude_cli] running '{} --version'...", path);

            // On Windows, .cmd files need cmd /C wrapper
            #[cfg(target_os = "windows")]
            let output_result = {
                let needs_cmd = path.ends_with(".cmd") || path.ends_with(".bat");
                let fut = if needs_cmd {
                    Command::new("cmd")
                        .args(["/C", &path, "--version"])
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .kill_on_drop(true)
                        .output()
                } else {
                    Command::new(&path)
                        .arg("--version")
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .kill_on_drop(true)
                        .output()
                };
                match tokio::time::timeout(std::time::Duration::from_secs(2), fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        eprintln!(
                            "[check_claude_cli] --version timed out for '{}', trying fallback...",
                            path
                        );
                        let fallback = find_claude_binary_ordered()
                            .into_iter()
                            .find(|p| p != &path);
                        let git_bash_missing = find_git_bash().is_none();
                        return match fallback {
                            Some(alt_path) => {
                                eprintln!("[check_claude_cli] fallback found: {}", alt_path);
                                Ok(CliStatus {
                                    installed: true,
                                    path: Some(alt_path),
                                    version: None,
                                    git_bash_missing,
                                    service_running: None,
                                })
                            }
                            None => Ok(CliStatus {
                                installed: false,
                                path: None,
                                version: None,
                                git_bash_missing: false,
                                service_running: None,
                            }),
                        };
                    }
                }
            };
            #[cfg(not(target_os = "windows"))]
            let output_result = match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                Command::new(&path)
                    .arg("--version")
                    .env("PATH", &enriched_path)
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => {
                    eprintln!(
                        "[check_claude_cli] --version timed out for '{}', trying fallback...",
                        path
                    );
                    // The app-local binary is hanging; try to find an alternative via system PATH
                    let fallback = find_claude_binary_ordered()
                        .into_iter()
                        .find(|p| p != &path);
                    let git_bash_missing = false;
                    return match fallback {
                        Some(alt_path) => {
                            eprintln!("[check_claude_cli] fallback found: {}", alt_path);
                            Ok(CliStatus {
                                installed: true,
                                path: Some(alt_path),
                                version: None,
                                git_bash_missing,
                                service_running: None,
                            })
                        }
                        None => Ok(CliStatus {
                            installed: false,
                            path: None,
                            version: None,
                            git_bash_missing: false,
                            service_running: None,
                        }),
                    };
                }
            };

            let version = match output_result {
                Ok(output) if output.status.success() => {
                    let raw = strip_ansi(&String::from_utf8_lossy(&output.stdout))
                        .trim()
                        .to_string();
                    if raw.is_empty() {
                        None
                    } else {
                        // `claude --version` outputs "2.1.92 (Claude Code)"  --?extract just the semver
                        let ver = raw.split_whitespace().next().unwrap_or(&raw).to_string();
                        Some(ver)
                    }
                }
                Ok(_) => None,
                Err(ref e) => {
                    eprintln!("check_claude_cli: failed to execute '{}': {}", path, e);
                    // On Windows, error 193 means the binary is corrupt/incompatible.
                    // Delete it and try to find a working alternative.
                    #[cfg(target_os = "windows")]
                    {
                        if e.raw_os_error() == Some(193) {
                            eprintln!("error 193: removing corrupt binary and re-searching...");
                            if let Some(cli_dir) = cli_download_dir() {
                                let suspect = cli_dir.join("claude.exe");
                                // Only delete when the file is demonstrably NOT a
                                // valid PE (no MZ magic): error 193 can also fire
                                // for a healthy native binary that fails to load
                                // (missing DLL / bad CPU feature), and deleting
                                // that would lose a working install.
                                let is_valid_pe = std::fs::read(&suspect)
                                    .ok()
                                    .map(|bytes| bytes.len() >= 2 && bytes[0] == 0x4D && bytes[1] == 0x5A)
                                    .unwrap_or(false);
                                if suspect.exists() && !is_valid_pe {
                                    let _ = std::fs::remove_file(&suspect);
                                } else if suspect.exists() {
                                    eprintln!(
                                        "error 193 but {} looks like a valid PE — keeping it",
                                        suspect.display()
                                    );
                                }
                            }
                            let alt = find_claude_binary();
                            let git_bash_missing = find_git_bash().is_none();
                            return match alt {
                                Some(alt_path) => Ok(CliStatus {
                                    installed: true,
                                    path: Some(alt_path),
                                    version: None,
                                    git_bash_missing,
                                    service_running: None,
                                }),
                                None => Ok(CliStatus {
                                    installed: false,
                                    path: None,
                                    version: None,
                                    git_bash_missing: false,
                                    service_running: None,
                                }),
                            };
                        }
                    }
                    // TK-319: Binary found but can't be executed  --?report as not installed
                    #[cfg(target_os = "windows")]
                    let git_bash_missing = find_git_bash().is_none();
                    #[cfg(not(target_os = "windows"))]
                    let git_bash_missing = false;
                    return Ok(CliStatus {
                        installed: false,
                        path: Some(path),
                        version: None,
                        git_bash_missing,
                        service_running: None,
                    });
                }
            };
            // On Windows, check if git-bash is available (hard requirement for Claude Code)
            #[cfg(target_os = "windows")]
            let git_bash_missing = find_git_bash().is_none();
            #[cfg(not(target_os = "windows"))]
            let git_bash_missing = false;

            Ok(CliStatus {
                installed: true,
                path: Some(path),
                version,
                git_bash_missing,
                service_running: None,
            })
        }
        None => Ok(CliStatus {
            installed: false,
            path: None,
            version: None,
            git_bash_missing: false,
            service_running: None,
        }),
    }
}

// ─── Codex CLI Detection ───────────────────────────────────────

/// Check if Codex CLI is installed and get its version.
#[tauri::command]
pub async fn check_codex_cli() -> Result<CliStatus, String> {
    let backend = backends::resolve_backend(Some("codex"));
    let binary = backend.find_binary();
    match binary {
        Some(path) => {
            let enriched_path = build_enriched_path();
            eprintln!("[check_codex_cli] found: {}", path);

            #[cfg(target_os = "windows")]
            let output_result = {
                let needs_cmd = path.ends_with(".cmd") || path.ends_with(".bat");
                let fut = if needs_cmd {
                    Command::new("cmd")
                        .args(["/C", &path, "--version"])
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .kill_on_drop(true)
                        .output()
                } else {
                    Command::new(&path)
                        .arg("--version")
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .kill_on_drop(true)
                        .output()
                };
                match tokio::time::timeout(std::time::Duration::from_secs(5), fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        eprintln!("[check_codex_cli] --version timed out");
                        return Ok(CliStatus {
                            installed: true,
                            path: Some(path),
                            version: None,
                            git_bash_missing: false,
                            service_running: None,
                        });
                    }
                }
            };
            #[cfg(not(target_os = "windows"))]
            let output_result = {
                let fut = Command::new(&path)
                    .arg("--version")
                    .env("PATH", &enriched_path)
                    .kill_on_drop(true)
                    .output();
                match tokio::time::timeout(std::time::Duration::from_secs(5), fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        eprintln!("[check_codex_cli] --version timed out");
                        return Ok(CliStatus {
                            installed: true,
                            path: Some(path),
                            version: None,
                            git_bash_missing: false,
                            service_running: None,
                        });
                    }
                }
            };

            let version = match output_result {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let trimmed = stdout.trim().to_string();
                    if !trimmed.is_empty() {
                        Some(trimmed)
                    } else {
                        None
                    }
                }
                Err(e) => {
                    eprintln!("[check_codex_cli] --version error: {}", e);
                    None
                }
            };

            Ok(CliStatus {
                installed: true,
                path: Some(path),
                version,
                // Codex doesn't require git-bash on Windows
                git_bash_missing: false,
                service_running: None,
            })
        }
        None => Ok(CliStatus {
            installed: false,
            path: None,
            version: None,
            git_bash_missing: false,
            service_running: None,
        }),
    }
}

// ─── Codex CLI Install / Update ────────────────────────────

/// Install Codex CLI via npm (same pattern as `install_cli_via_npm` but for `@openai/codex`).
async fn install_codex_via_npm(app: &AppHandle, china: bool) -> Result<(), String> {
    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 0, "phase": "npm_fallback"
        }),
    );

    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        #[cfg(target_os = "windows")]
        let npm = local_bin.join("npm.cmd");
        #[cfg(not(target_os = "windows"))]
        let npm = local_bin.join("npm");
        npm.to_string_lossy().to_string()
    } else {
        #[cfg(target_os = "windows")]
        let npm = "npm.cmd".to_string();
        #[cfg(not(target_os = "windows"))]
        let npm = "npm".to_string();
        npm
    };

    let enriched_path = build_enriched_path();

    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm-global dir: {}", e))?;

    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create npm-cache dir: {}", e))?;

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://mirrors.huaweicloud.com/repository/npm",
            "https://mirrors.cloud.tencent.com/npm",
            "https://registry.npmjs.org",
        ]
    } else {
        vec![
            "https://registry.npmjs.org",
            "https://registry.npmmirror.com",
        ]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!(
            "[install_codex] Trying npm registry: {} (prefix: {}, cache: {})",
            registry,
            prefix_dir.display(),
            cache_dir.display()
        );

        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 50, "phase": "npm_fallback"
            }),
        );

        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            "@openai/codex".to_string(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];

        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        #[cfg(target_os = "windows")]
        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            cmd.kill_on_drop(true);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
            cmd.kill_on_drop(true);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                eprintln!("[install_codex] npm install succeeded via {}", registry);
                let _ = app.emit(
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "installing"
                    }),
                );
                return Ok(());
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!("npm install failed ({}): {}", registry, stderr);
                eprintln!("[install_codex] {}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("npm not found or failed to run: {}", e);
                eprintln!("[install_codex] {}", last_err);
                return Err(last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("[install_codex] {}", last_err);
            }
        }
    }

    Err(last_err)
}

/// Install Codex CLI.
///
/// Simpler than `install_claude_cli`: no git-bash dependency, npm-only install.
#[tauri::command]
pub async fn install_codex_cli(app: AppHandle) -> Result<(), String> {
    // Skip if already installed
    let backend = backends::resolve_backend(Some("codex"));
    if backend.find_binary().is_some() {
        eprintln!("[install_codex_cli] Codex already installed, skipping");
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
            }),
        );
        return Ok(());
    }

    let china = is_china_network().await;

    // Ensure npm is available
    let has_npm = is_system_npm_available().await || get_local_node_bin().is_some();
    if !has_npm {
        eprintln!("[install_codex_cli] npm not available, deploying Node.js locally...");
        // Codex 安装暂不支持取消（scope_id 不传入），传空作用域
        let no_scope = CancelScope::new(None);
        install_node_env_inner(&app, china, &no_scope).await.map_err(|e| {
            format!(
                "Failed to install Node.js runtime: {}. Please install Node.js manually.",
                e
            )
        })?;
    }

    // Install via npm
    install_codex_via_npm(&app, china)
        .await
        .map_err(|npm_err| format!("Codex CLI installation failed via npm: {}", npm_err))?;

    eprintln!("[install_codex_cli] Codex installed via npm");
    finalize_cli_install_paths(&app);
    Ok(())
}

/// Update Codex CLI to latest version via npm.
#[tauri::command]
pub async fn update_codex_cli(app: AppHandle) -> Result<String, String> {
    let china = is_china_network().await;

    // Codex is npm-only  --?no native binary path
    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        #[cfg(target_os = "windows")]
        let npm = local_bin.join("npm.cmd");
        #[cfg(not(target_os = "windows"))]
        let npm = local_bin.join("npm");
        npm.to_string_lossy().to_string()
    } else {
        #[cfg(target_os = "windows")]
        let npm = "npm.cmd".to_string();
        #[cfg(not(target_os = "windows"))]
        let npm = "npm".to_string();
        npm
    };

    let enriched_path = build_enriched_path();
    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm prefix dir: {e}"))?;
    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).ok();

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://registry.npmjs.org",
        ]
    } else {
        vec!["https://registry.npmjs.org"]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!("[update_codex_cli] trying npm registry: {}", registry);
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 30, "phase": "npm_fallback"
            }),
        );

        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            "@openai/codex@latest".to_string(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];
        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        #[cfg(target_os = "windows")]
        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            cmd.kill_on_drop(true);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
            cmd.kill_on_drop(true);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                let check = check_codex_cli().await.unwrap_or(CliStatus {
                    installed: false,
                    version: None,
                    path: None,
                    git_bash_missing: false,
                    service_running: None,
                });
                let version = check.version.unwrap_or_else(|| "unknown".to_string());
                eprintln!(
                    "[update_codex_cli] npm installed v{} from {}",
                    version, registry
                );
                let _ = app.emit(
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
                    }),
                );
                return Ok(version);
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!(
                    "npm install failed ({}): {}",
                    registry,
                    stderr.chars().take(500).collect::<String>()
                );
                eprintln!("[update_codex_cli] {}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("Failed to run npm: {e}");
                eprintln!("[update_codex_cli] {}", last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("[update_codex_cli] {}", last_err);
            }
        }
    }

    Err(last_err)
}

// ─── DeepSeek Harness (dsh) Detection & Install ──────────────────────
// DSH is the npm-distributed `@deepseek-ai/dsh` CLI; service mode (the
// D-N1-B integration) runs `dsh --profile web` and talks HTTP/WS on 3080.

/// Check the DeepSeek Harness CLI: binary presence + version + whether a
/// `dsh web` service already answers on the default port (service mode).
#[tauri::command]
pub async fn check_dsh_cli() -> Result<CliStatus, String> {
    let backend = backends::resolve_backend(Some("deepseek"));
    let binary = backend.find_binary();
    let service_running = crate::commands::dsh_service::probe_default_service().await;
    match binary {
        Some(path) => {
            let enriched_path = build_enriched_path();
            eprintln!("[check_dsh_cli] found: {}", path);

            #[cfg(target_os = "windows")]
            let output_result = {
                let needs_cmd = path.ends_with(".cmd") || path.ends_with(".bat");
                let fut = if needs_cmd {
                    Command::new("cmd")
                        .args(["/C", &path, "--version"])
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .kill_on_drop(true)
                        .output()
                } else {
                    Command::new(&path)
                        .arg("--version")
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
                        .kill_on_drop(true)
                        .output()
                };
                match tokio::time::timeout(std::time::Duration::from_secs(5), fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        eprintln!("[check_dsh_cli] --version timed out");
                        return Ok(CliStatus {
                            installed: true,
                            path: Some(path),
                            version: None,
                            git_bash_missing: false,
                            service_running: Some(service_running),
                        });
                    }
                }
            };
            #[cfg(not(target_os = "windows"))]
            let output_result = {
                let fut = Command::new(&path)
                    .arg("--version")
                    .env("PATH", &enriched_path)
                    .kill_on_drop(true)
                    .output();
                match tokio::time::timeout(std::time::Duration::from_secs(5), fut).await {
                    Ok(r) => r,
                    Err(_) => {
                        eprintln!("[check_dsh_cli] --version timed out");
                        return Ok(CliStatus {
                            installed: true,
                            path: Some(path),
                            version: None,
                            git_bash_missing: false,
                            service_running: Some(service_running),
                        });
                    }
                }
            };

            let version = match output_result {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let trimmed = stdout.trim().to_string();
                    if !trimmed.is_empty() {
                        Some(trimmed)
                    } else {
                        None
                    }
                }
                Err(e) => {
                    eprintln!("[check_dsh_cli] --version error: {}", e);
                    None
                }
            };

            Ok(CliStatus {
                installed: true,
                path: Some(path),
                version,
                git_bash_missing: false,
                service_running: Some(service_running),
            })
        }
        None => Ok(CliStatus {
            installed: false,
            path: None,
            version: None,
            git_bash_missing: false,
            service_running: Some(service_running),
        }),
    }
}

/// Install the DeepSeek Harness CLI via npm (same pattern as Codex: npm-only,
/// no git-bash dependency).
#[tauri::command]
pub async fn install_dsh_cli(app: AppHandle) -> Result<(), String> {
    let backend = backends::resolve_backend(Some("deepseek"));
    if backend.find_binary().is_some() {
        eprintln!("[install_dsh_cli] dsh already installed, skipping");
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
            }),
        );
        return Ok(());
    }

    let china = is_china_network().await;

    // Ensure npm is available
    let has_npm = is_system_npm_available().await || get_local_node_bin().is_some();
    if !has_npm {
        eprintln!("[install_dsh_cli] npm not available, deploying Node.js locally...");
        let no_scope = CancelScope::new(None);
        install_node_env_inner(&app, china, &no_scope).await.map_err(|e| {
            format!(
                "Failed to install Node.js runtime: {}. Please install Node.js manually.",
                e
            )
        })?;
    }

    install_dsh_via_npm(&app, china)
        .await
        .map_err(|npm_err| format!("DeepSeek Harness CLI installation failed via npm: {}", npm_err))?;

    eprintln!("[install_dsh_cli] dsh installed via npm");
    finalize_cli_install_paths(&app);
    Ok(())
}

/// npm-install `@deepseek-ai/dsh` with registry fallbacks (mirrors
/// `install_codex_via_npm`; China-first registries when in China).
async fn install_dsh_via_npm(app: &AppHandle, china: bool) -> Result<(), String> {
    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 0, "phase": "npm_fallback"
        }),
    );

    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        #[cfg(target_os = "windows")]
        let npm = local_bin.join("npm.cmd");
        #[cfg(not(target_os = "windows"))]
        let npm = local_bin.join("npm");
        npm.to_string_lossy().to_string()
    } else {
        #[cfg(target_os = "windows")]
        let npm = "npm.cmd".to_string();
        #[cfg(not(target_os = "windows"))]
        let npm = "npm".to_string();
        npm
    };

    let enriched_path = build_enriched_path();

    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm-global dir: {}", e))?;

    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create npm-cache dir: {}", e))?;

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://mirrors.huaweicloud.com/repository/npm",
            "https://mirrors.cloud.tencent.com/npm",
            "https://registry.npmjs.org",
        ]
    } else {
        vec![
            "https://registry.npmjs.org",
            "https://registry.npmmirror.com",
        ]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!(
            "[install_dsh] Trying npm registry: {} (prefix: {}, cache: {})",
            registry,
            prefix_dir.display(),
            cache_dir.display()
        );

        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            "@deepseek-ai/dsh".to_string(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];
        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        #[cfg(target_os = "windows")]
        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            cmd.kill_on_drop(true);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
            cmd.kill_on_drop(true);
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                eprintln!("[install_dsh] npm install succeeded via {}", registry);
                let _ = app.emit(
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "installing"
                    }),
                );
                return Ok(());
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!("npm install failed ({}): {}", registry, stderr);
                eprintln!("[install_dsh] {}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("npm not found or failed to run: {}", e);
                eprintln!("[install_dsh] {}", last_err);
                return Err(last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("[install_dsh] {}", last_err);
            }
        }
    }

    Err(last_err)
}

/// Check if a newer Codex CLI version is available via npm registry.
#[tauri::command]
pub async fn check_codex_update() -> Result<CliUpdateCheck, String> {
    let cli = check_codex_cli().await.ok();
    let current = cli.as_ref().and_then(|c| c.version.clone());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    let china = is_china_network().await;

    // Query npm registry for latest version
    let registry_urls: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com/@openai/codex/latest",
            "https://registry.npmjs.org/@openai/codex/latest",
        ]
    } else {
        vec![
            "https://registry.npmjs.org/@openai/codex/latest",
            "https://registry.npmmirror.com/@openai/codex/latest",
        ]
    };

    let mut latest: Option<String> = None;
    for url in &registry_urls {
        if let Ok(resp) = client
            .get(*url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            if resp.status().is_success() {
                let json: serde_json::Value = resp.json().await.unwrap_or_default();
                latest = json
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                if latest.is_some() {
                    break;
                }
            }
        }
    }

    let update_available = match (&current, &latest) {
        (Some(cur), Some(lat)) => version_gt(lat.trim(), cur.trim()),
        _ => false,
    };

    Ok(CliUpdateCheck {
        current,
        latest,
        update_available,
    })
}

// ─── Cross-backend session conversion ────────────────────

/// Export a Codex session (from chatStore) as a Claude-compatible JSONL file.
/// Takes pre-built JSONL content from the frontend. Returns the Claude session UUID.
///
/// Extracts the `sessionId` from the JSONL content so the filename matches the
/// internal session ID  --?Claude CLI validates this match when resuming.
#[tauri::command]
pub async fn export_codex_to_claude(
    jsonl_content: String,
    cwd: String,
) -> Result<String, String> {
    // Extract sessionId from the first JSONL line that has one.
    // The reconstructJsonl() frontend function embeds the same UUID in every line.
    // H2: only UUID-like ids are accepted — anything else (path separators,
    // newlines, dots) is skipped with a warning and never used in a file path.
    let session_uuid = jsonl_content
        .lines()
        .find_map(|line| {
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            let id = v
                .get("sessionId")
                .or_else(|| v.get("session_id"))
                .and_then(|v| v.as_str())?;
            if is_uuid_like(id) {
                Some(id.to_string())
            } else {
                eprintln!(
                    "[LITTLECLAUDE:export] 跳过无效的 sessionId: {:?}",
                    id
                );
                None
            }
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // Defense in depth: the extracted (or freshly generated) id must be
    // UUID-like before it is used as a file name or registered in
    // tracked_sessions.txt.
    if !is_uuid_like(&session_uuid) {
        return Err(format!("无效的会话 ID 格式: {}", session_uuid));
    }

    let encoded_cwd = encode_project_name(&cwd);
    eprintln!(
        "[LITTLECLAUDE:export] export_codex_to_claude: cwd={}, encoded={}, jsonl_len={}, uuid={}",
        cwd, encoded_cwd, jsonl_content.len(), session_uuid
    );
    let home = dirs::home_dir().ok_or("无法获取用户目录")?;
    let projects_root = home.join(".claude").join("projects");
    let dir = projects_root.join(&encoded_cwd);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;

    // H2: canonicalize the target dir and the projects root — the final
    // path must stay inside ~/.claude/projects/ (the cwd itself is already
    // encode_project_name'd, this check is the final backstop).
    let dir_canonical =
        dir.canonicalize().map_err(|e| format!("导出目录校验失败: {}", e))?;
    let root_canonical = projects_root
        .canonicalize()
        .map_err(|e| format!("导出目录校验失败: {}", e))?;
    if !dir_canonical.starts_with(&root_canonical) {
        return Err("导出目录不在 ~/.claude/projects/ 目录内".to_string());
    }

    let file_path = dir_canonical.join(format!("{}.jsonl", session_uuid));
    std::fs::write(&file_path, &jsonl_content).map_err(|e| format!("写入文件失败: {}", e))?;

    // Write origin marker for UI hint
    let origin_path = dir_canonical.join(format!("{}.codex-origin", session_uuid));
    std::fs::write(&origin_path, "codex").ok();

    // Register in tracked_sessions.txt.
    // R9 (bug): atomic tmp+rename — the old direct overwrite raced with
    // concurrent track_session appends (a stale snapshot could erase fresh
    // entries) and a crash mid-write truncated the file.
    let track_path = tracked_sessions_path();
    let mut sessions = load_tracked_sessions();
    sessions.insert(session_uuid.clone());
    let content: Vec<String> = sessions.into_iter().collect();
    let tmp_path = track_path.with_extension("txt.tmp");
    std::fs::write(&tmp_path, content.join("\n"))
        .map_err(|e| format!("注册会话失败: {}", e))?;
    std::fs::rename(&tmp_path, &track_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("注册会话失败(替换): {}", e)
    })?;

    Ok(session_uuid)
}

/// Export a Claude session (JSONL file) as formatted text for Codex injection.
/// Returns the formatted conversation text ready for `turn/start`.
#[tauri::command]
pub async fn export_claude_to_codex(
    session_id: String,
    project_dir: String,
) -> Result<String, String> {
    // Use projectDir directly  --?it IS the directory name on disk
    // (created by Claude CLI). Re-encoding the cwd would mismatch
    // because Claude CLI encodes spaces/dots differently.
    // H3: project_dir must be a bare directory-name fragment (the encoded
    // form never contains separators or dots, so ".." traversal and absolute
    // paths are impossible), and the session id must be UUID-like.
    if project_dir.contains('/') || project_dir.contains('\\') || project_dir.contains('.') {
        return Err(format!("无效的项目目录名: {}", project_dir));
    }
    if !is_uuid_like(&session_id) {
        return Err(format!("无效的会话 ID 格式: {}", session_id));
    }

    let home = dirs::home_dir().ok_or("无法获取用户目录")?;
    let projects_root = home.join(".claude").join("projects");
    let dir = projects_root.join(&project_dir);
    // H3: canonicalize the target dir and ensure it stays inside the
    // ~/.claude/projects/ root (also catches symlinks escaping it).
    let dir_canonical = dir
        .canonicalize()
        .map_err(|e| format!("读取会话文件失败: {}", e))?;
    let root_canonical = projects_root
        .canonicalize()
        .map_err(|e| format!("读取会话文件失败: {}", e))?;
    if !dir_canonical.starts_with(&root_canonical) {
        return Err("会话文件不在 ~/.claude/projects/ 目录内".to_string());
    }
    let file_path = dir_canonical.join(format!("{}.jsonl", session_id));

    eprintln!(
        "[LITTLECLAUDE:export] export_claude_to_codex: session={}, project_dir={}, path={}",
        session_id, project_dir, file_path.display()
    );

    std::fs::read_to_string(&file_path)
        .map_err(|e| format!("读取会话文件失败: {}", e))
}

// ─── CLI Diagnostics ───────────────────────────────────────

/// Scan all CLI installations and return candidates with version info.
#[tauri::command]
pub async fn diagnose_cli() -> Result<Vec<cli_resolver::CliCandidate>, String> {
    let mut candidates = cli_resolver::scan_all();
    let enriched_path = build_enriched_path();

    for candidate in &mut candidates {
        if !candidate.issues.is_empty() && candidate.version.is_none() {
            continue;
        }
        #[cfg(target_os = "windows")]
        let version_result = {
            let needs_cmd = candidate.path.ends_with(".cmd") || candidate.path.ends_with(".bat");
            let fut = if needs_cmd {
                Command::new("cmd")
                    .args(["/C", &candidate.path, "--version"])
                    .env("PATH", &enriched_path)
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(0x08000000)
                    .kill_on_drop(true)
                    .output()
            } else {
                Command::new(&candidate.path)
                    .arg("--version")
                    .env("PATH", &enriched_path)
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(0x08000000)
                    .kill_on_drop(true)
                    .output()
            };
            tokio::time::timeout(std::time::Duration::from_secs(3), fut).await
        };
        #[cfg(not(target_os = "windows"))]
        let version_result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            Command::new(&candidate.path)
                .arg("--version")
                .env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await;

        match version_result {
            Ok(Ok(output)) if output.status.success() => {
                let raw = strip_ansi(&String::from_utf8_lossy(&output.stdout))
                    .trim()
                    .to_string();
                let ver = raw.split_whitespace().next().unwrap_or(&raw).to_string();
                if !ver.is_empty() {
                    candidate.version = Some(ver);
                }
            }
            Ok(Ok(_)) => {
                candidate
                    .issues
                    .push("--version returned non-zero exit".to_string());
            }
            Ok(Err(e)) => {
                candidate.issues.push(format!("failed to execute: {}", e));
            }
            Err(_) => {
                candidate
                    .issues
                    .push("--version timed out (3s)".to_string());
            }
        }
    }

    Ok(candidates)
}

/// Clean up selected CLI installations.
#[tauri::command]
pub async fn cleanup_old_cli(
    targets: Vec<String>,
) -> Result<cli_resolver::CleanupResult, String> {
    Ok(cli_resolver::cleanup(&targets))
}

#[tauri::command]
pub async fn pin_cli(path: String) -> Result<(), String> {
    cli_resolver::pin_cli(&path)
}

#[tauri::command]
pub async fn unpin_cli() -> Result<(), String> {
    cli_resolver::unpin_cli()
}

#[tauri::command]
pub async fn get_pinned_cli() -> Result<Option<String>, String> {
    Ok(cli_resolver::get_pinned_cli())
}

#[tauri::command]
pub async fn inject_cli_path(path: String) -> Result<String, String> {
    cli_resolver::inject_path(&path)
}

#[tauri::command]
pub async fn delete_cli(path: String) -> Result<String, String> {
    cli_resolver::delete_cli(&path)
}

/// Detect whether the user is behind the GFW (China network).
/// Tries to connect to Google  --?if unreachable within 3 seconds, assume China network.
/// Result is cached for the lifetime of the process via OnceLock.
static CHINA_NETWORK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Path for persisting the network environment detection result.
fn network_env_cache_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Home directory not found")?;
    Ok(home.join(crate::safe_data_dir_name()).join("network_env"))
}

async fn detect_china_network() -> bool {
    // Use a very short timeout so this doesn't become a startup bottleneck.
    // In China, GFW typically drops packets (connect timeout) or sends RST (instant).
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    let is_china = client
        .head("https://www.google.com/generate_204")
        .send()
        .await
        .is_err();

    eprintln!(
        "Network detection: {}",
        if is_china {
            "China (Google unreachable)"
        } else {
            "Global (Google reachable)"
        }
    );
    is_china
}

pub(crate) async fn is_china_network() -> bool {
    // 1) In-memory cache (survives for the process lifetime).
    if let Some(&cached) = CHINA_NETWORK.get() {
        return cached;
    }

    // 2) File-based cache  --?survives across app restarts so we skip the
    //    3-second Google timeout on every launch after the first one.
    if let Ok(cache_path) = network_env_cache_path() {
        if let Ok(raw) = std::fs::read_to_string(&cache_path) {
            let trimmed = raw.trim();
            if trimmed == "china" {
                let _ = CHINA_NETWORK.set(true);
                return true;
            }
            if trimmed == "global" {
                let _ = CHINA_NETWORK.set(false);
                return false;
            }
        }
    }

    // 3) Run detection (network I/O  --?keep it as short as possible).
    let result = detect_china_network().await;
    let _ = CHINA_NETWORK.set(result);

    // Persist for next launch (best-effort).
    if let Ok(cache_path) = network_env_cache_path() {
        let _ = std::fs::write(&cache_path, if result { "china" } else { "global" });
    }

    result
}

/// Fetch the latest published CLI version from version sources.
/// Sources: herear.cn mirror (China-first) → GCS → npm registry (non-China only).
async fn fetch_latest_cli_version(client: &reqwest::Client, china: bool) -> Option<String> {
    let version_urls: Vec<String> = if china {
        vec![
            format!("{}/latest", CLI_MIRROR_BASE),
            format!("{}/latest", CLI_GCS_BASE),
        ]
    } else {
        vec![
            format!("{}/latest", CLI_GCS_BASE),
            format!("{}/latest", CLI_MIRROR_BASE),
        ]
    };

    for url in &version_urls {
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        return Some(v);
                    }
                }
            }
        }
    }

    // Final fallback: npm registry (skip in China — npm is typically blocked)
    if !china {
        if let Ok(resp) = client
            .get("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")
            .header("Accept", "application/json")
            .send()
            .await
        {
            let json: serde_json::Value = resp.json().await.unwrap_or_default();
            if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Read the installed version directly from npm-global's package.json.
/// Faster and more reliable than spawning `claude --version` (which has a 2s
/// timeout and may resolve to a pinned/system CLI instead of ours).
fn npm_global_installed_version() -> Option<String> {
    let pkg = npm_global_dir().ok()?.join("node_modules").join("@anthropic-ai").join("claude-code").join("package.json");
    let text = std::fs::read_to_string(pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// npm package spec for installation: pinned to `target` when known so mirror
/// `@latest` cache staleness (npmmirror served 2.1.216 as "latest" on 2026-08-06)
/// can never install a stale version; falls back to @latest when unknown.
fn cli_pkg_spec(target: &Option<String>) -> String {
    match target {
        Some(v) => {
            // L10: /latest 端点返回的原始文本直接拼进 npm 参数——白名单校验
            // （`^[0-9][0-9.]*[-a-z0-9.]*$`：数字开头、仅含数字/点/字母/连字符）。
            // 预发布版本（如 2.1.220-rc.1）含字母与连字符，须放行；换行/空格/
            // 分号等可注入 npm 参数的字符一律拒绝，退回 @latest。
            let trimmed = v.trim();
            let valid = !trimmed.is_empty()
                && trimmed.starts_with(|c: char| c.is_ascii_digit())
                && trimmed
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
            if !valid {
                eprintln!(
                    "[cli_pkg_spec] rejecting malformed version string {:?}, falling back to @latest",
                    v
                );
                return "@anthropic-ai/claude-code@latest".to_string();
            }
            format!("@anthropic-ai/claude-code@{}", trimmed)
        }
        None => "@anthropic-ai/claude-code@latest".to_string(),
    }
}

/// 带取消检查的子进程等待：npm/pip 等长命令执行期间周期轮询取消令牌。
/// 用户取消时返回 Err(download_cancel::CANCELLED_ERROR)，调用方应清理
/// 已创建的文件并向上传播该错误（前端据此识别"用户取消"）。
///
/// 用 spawn + wait 而非 output()：取消时能拿到子进程 pid，在 Windows 上
/// 以 taskkill /T 连杀整个进程树——`cmd /C npm.cmd` 派生的 node 等孙进程
/// 不受 kill_on_drop 控制，只杀直接子进程会让 npm 在后台继续装完。
/// stdout/stderr 置空：所有调用方只检查 exit status，不读输出内容。
async fn await_command_with_cancel(
    cmd: &mut Command,
    timeout_secs: u64,
    scope: &CancelScope,
) -> Result<std::process::Output, String> {
    // #21 (bug): stdout/stderr used to be null, so callers building user-
    // visible errors from output.stderr always got "" — npm install failures
    // showed up as "npm install failed (registry): " with no reason. Capture
    // stderr with a bounded drain task (child must never block on a full pipe).
    let mut child = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run command: {}", e))?;
    let pid = child.id();
    const STDERR_CAPTURE_CAP: usize = 64 * 1024;
    let stderr_task = child.stderr.take().map(|mut s| {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match s.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if buf.len() < STDERR_CAPTURE_CAP {
                            let take = n.min(STDERR_CAPTURE_CAP - buf.len());
                            buf.extend_from_slice(&chunk[..take]);
                        }
                    }
                    Err(_) => break,
                }
            }
            buf
        })
    });

    let wait = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), child.wait());
    tokio::pin!(wait);

    let mut interval = tokio::time::interval(std::time::Duration::from_millis(300));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                if scope.is_cancelled() {
                    kill_process_tree(pid);
                    // 等进程树退出，调用方的 cleanup_created_dir 才能删掉目录
                    // （Windows 上文件句柄未释放时 remove_dir_all 会失败）
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    return Err(download_cancel::CANCELLED_ERROR.to_string());
                }
            }
            res = &mut wait => {
                return match res {
                    Ok(Ok(status)) => {
                        // Child exited — pipe hits EOF; bounded wait for the
                        // drain task so stderr lands in the returned Output.
                        let stderr = match stderr_task {
                            Some(h) => tokio::time::timeout(
                                std::time::Duration::from_secs(2),
                                h,
                            )
                            .await
                            .ok()
                            .and_then(|r| r.ok())
                            .unwrap_or_default(),
                            None => Vec::new(),
                        };
                        Ok(std::process::Output {
                            status,
                            stdout: Vec::new(),
                            stderr,
                        })
                    }
                    Ok(Err(e)) => Err(format!("Failed to wait for command: {}", e)),
                    Err(_) => {
                        // L3: 超时路径同样连杀进程树（与取消路径一致）——
                        // cmd /C npm 派生的 node 孙进程不受 kill_on_drop 控制，
                        // 只杀直接子进程会让 npm 在后台继续装完。
                        kill_process_tree(pid);
                        // 等进程树退出，调用方的 cleanup_created_dir 才能删目录
                        // （Windows 上文件句柄未释放时 remove_dir_all 会失败）。
                        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                        Err(format!("Command timed out after {}s", timeout_secs))
                    }
                };
            }
        }
    }
}

/// 终止子进程树。Windows：taskkill /T /F 连杀孙进程（cmd /C 包装的 node 等）；
/// 其他平台 kill_on_drop 已覆盖直接子进程，无需额外处理。
#[cfg(target_os = "windows")]
fn kill_process_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status();
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_process_tree(_pid: Option<u32>) {}

/// Install Claude CLI via npm. Supports system npm or local Node.js npm.
/// Uses --prefix to install into app-local directory when using local Node.js.
/// 用户取消时清理本次安装创建的目录（只删本次新建的，避免误删既有安装）。
fn cleanup_created_dir(existed_before: bool, dir: &std::path::Path) {
    if !existed_before {
        let _ = std::fs::remove_dir_all(dir);
    }
}

async fn install_cli_via_npm(app: &AppHandle, china: bool, scope: &CancelScope) -> Result<(), String> {
    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 0, "phase": "npm_fallback"
        }),
    );

    // Determine npm path: local Node.js takes priority, then system npm
    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        #[cfg(target_os = "windows")]
        let npm = local_bin.join("npm.cmd");
        #[cfg(not(target_os = "windows"))]
        let npm = local_bin.join("npm");
        npm.to_string_lossy().to_string()
    } else {
        #[cfg(target_os = "windows")]
        let npm = "npm.cmd".to_string();
        #[cfg(not(target_os = "windows"))]
        let npm = "npm".to_string();
        npm
    };

    // Build PATH that includes local Node.js bin
    let enriched_path = build_enriched_path();

    // Always use --prefix to install into our controlled directory.
    // This avoids polluting system npm globals and ensures finalize_cli_install_paths
    // can reliably add the bin directory to PATH (fixes PowerShell not finding `claude`).
    let prefix_dir = npm_global_dir()?;
    // 取消时只清理本次安装新建的目录（避免误删既有安装）
    let prefix_existed = prefix_dir.exists();
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm-global dir: {}", e))?;

    // Use app-local npm cache to avoid EPERM when system cache dir is locked
    // (common on Windows with antivirus or concurrent npm processes).
    let cache_dir = npm_cache_dir()?;
    let cache_existed = cache_dir.exists();
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create npm-cache dir: {}", e))?;

    // Resolve the target version once so we can pin the npm package spec.
    // Pinning defeats mirror `@latest` cache staleness (npmmirror once served
    // an old version as "latest"); post-install we verify the installed version.
    let target_version = {
        let c = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        fetch_latest_cli_version(&c, china).await
    };
    let pkg_spec = cli_pkg_spec(&target_version);
    eprintln!(
        "[install_cli_via_npm] target version {:?}, installing '{}'",
        target_version, pkg_spec
    );

    if scope.is_cancelled() {
        cleanup_created_dir(prefix_existed, &prefix_dir);
        cleanup_created_dir(cache_existed, &cache_dir);
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://mirrors.huaweicloud.com/repository/npm",
            "https://mirrors.cloud.tencent.com/npm",
            "https://registry.npmjs.org",
        ]
    } else {
        vec![
            "https://registry.npmjs.org",
            "https://registry.npmmirror.com",
        ]
    };

    let mut last_err = String::new();
    for registry in &registries {
        // 每次尝试前检查取消（npm 运行期间由 await_command_with_cancel 轮询）
        if scope.is_cancelled() {
            cleanup_created_dir(prefix_existed, &prefix_dir);
            cleanup_created_dir(cache_existed, &cache_dir);
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }

        eprintln!(
            "Trying npm install with registry: {} (prefix: {}, cache: {})",
            registry,
            prefix_dir.display(),
            cache_dir.display()
        );

        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 50, "phase": "npm_fallback"
            }),
        );

        // Build args  --?always use --prefix and --cache for isolation
        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            pkg_spec.clone(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];

        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        #[cfg(target_os = "windows")]
        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            cmd.kill_on_drop(true);
            await_command_with_cancel(&mut cmd, 300, scope).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
            cmd.kill_on_drop(true);
            await_command_with_cancel(&mut cmd, 300, scope).await
        };

        match result {
            Ok(output) if output.status.success() => {
                let mut installed = npm_global_installed_version();
                if installed.is_none() {
                    installed = check_claude_cli().await.ok().and_then(|c| c.version);
                }
                eprintln!(
                    "npm install succeeded via {} (installed: {:?})",
                    registry, installed
                );
                // Post-install verification. If the version sources were all
                // down at install time (target unknown), retry the fetch once
                // now — a stale mirror install must not pass silently. An
                // unreadable installed version is a loud failure, never Ok.
                let target = match target_version.as_ref() {
                    Some(t) => Some(t.clone()),
                    None => {
                        let c = reqwest::Client::builder()
                            .timeout(std::time::Duration::from_secs(10))
                            .build()
                            .unwrap_or_default();
                        fetch_latest_cli_version(&c, china).await
                    }
                };
                match (target.as_ref(), installed.as_ref()) {
                    (Some(t), Some(got)) => {
                        if got != t && version_gt(t, got) {
                            last_err = format!(
                                "Mirror {} installed v{} but latest is v{}",
                                registry, got, t
                            );
                            eprintln!("[install_cli_via_npm] {}", last_err);
                            continue;
                        }
                    }
                    (Some(t), None) => {
                        last_err = format!(
                            "npm install succeeded via {} but installed version could not be read (target v{})",
                            registry, t
                        );
                        eprintln!("[install_cli_via_npm] {}", last_err);
                        return Err(last_err);
                    }
                    (None, Some(_)) => {
                        eprintln!(
                            "[install_cli_via_npm] version sources unavailable; installed via {} without verification",
                            registry
                        );
                    }
                    (None, None) => {
                        last_err = format!(
                            "npm install succeeded via {} but installed version could not be read",
                            registry
                        );
                        eprintln!("[install_cli_via_npm] {}", last_err);
                        return Err(last_err);
                    }
                }
                let _ = app.emit(
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "installing"
                    }),
                );
                return Ok(());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!("npm install failed ({}): {}", registry, stderr);
                eprintln!("{}", last_err);
            }
            Err(e) => {
                // 用户取消：清理本次新建的目录后原样传播（前端据此识别）
                if e == download_cancel::CANCELLED_ERROR {
                    cleanup_created_dir(prefix_existed, &prefix_dir);
                    cleanup_created_dir(cache_existed, &cache_dir);
                    return Err(download_cancel::CANCELLED_ERROR.to_string());
                }
                if e.starts_with("Command timed out") {
                    last_err = format!("npm install timed out ({})", registry);
                    eprintln!("{}", last_err);
                } else {
                    last_err = format!("npm not found or failed to run: {}", e);
                    eprintln!("{}", last_err);
                    return Err(last_err);
                }
            }
        }
    }

    Err(last_err)
}

/// Compare two semver-style version strings (e.g. "2.1.92" > "2.1.81").
/// Handles "v" prefix, "(Claude Code)" suffix, and non-numeric noise.
fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        // Take only the first whitespace-delimited token ("2.1.92 (Claude Code)"  --?"2.1.92")
        let ver = s
            .trim()
            .trim_start_matches('v')
            .split_whitespace()
            .next()
            .unwrap_or("");
        ver.split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let va = parse(a);
    let vb = parse(b);
    // A version that fails to parse entirely (empty/garbage) is never
    // "greater" — don't let dirty data drive an upgrade or a downgrade.
    if va.is_empty() || vb.is_empty() {
        return false;
    }
    // Compare segment-wise, treating missing trailing segments as 0
    // ("2.10.0" == "2.10", "2.10.1" > "2.10").
    for i in 0..va.len().max(vb.len()) {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Return the platform key matching the server manifest (e.g. "win32-x64").
fn native_platform_key() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win32-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "win32-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
}

/// Try to update the CLI by downloading a native binary from GCS.
/// Only used for non-China users (GCS is fast globally; herear.cn bandwidth is too small
/// for ~230MB binaries). China users go straight to npm fallback with version verification.
async fn try_native_cli_update(china: bool, scope: &CancelScope) -> Result<String, String> {
    // Skip native binary download for China  --?GCS may be blocked, herear.cn bandwidth too small
    if china {
        return Err("Native binary download skipped for China network".to_string());
    }
    if scope.is_cancelled() {
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let sources: Vec<&str> = vec![CLI_GCS_BASE];

    // 1. Fetch latest version
    let mut version: Option<String> = None;
    for base in &sources {
        let url = format!("{}/latest", base);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        eprintln!("[native_update] latest version: {} (from {})", v, base);
                        version = Some(v);
                        break;
                    }
                }
            }
        }
    }
    let version = version.ok_or("Cannot fetch latest version from any source")?;

    // 2. Fetch manifest for checksum
    let platform = native_platform_key();
    let mut expected_checksum = String::new();
    let mut binary_name = if cfg!(target_os = "windows") {
        "claude.exe"
    } else {
        "claude"
    }
    .to_string();

    for base in &sources {
        let url = format!("{}/{}/manifest.json", base, version);
        if let Ok(resp) = client.get(&url).send().await {
            if let Ok(manifest) = resp.json::<serde_json::Value>().await {
                if let Some(info) = manifest.get("platforms").and_then(|p| p.get(platform)) {
                    if let Some(cs) = info.get("checksum").and_then(|v| v.as_str()) {
                        expected_checksum = cs.to_string();
                    }
                    if let Some(bn) = info.get("binary").and_then(|v| v.as_str()) {
                        // #8/L4 (security): the remote manifest is not trusted
                        // input — a filename carrying `..` or separators would
                        // let PathBuf::join write OUTSIDE ~/.claude/local.
                        // Accept only a flat, boring filename.
                        let bn = bn.trim();
                        let safe = !bn.is_empty()
                            && bn.len() <= 64
                            && !bn.contains('/')
                            && !bn.contains('\\')
                            && !bn.contains("..")
                            && bn
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
                        if safe {
                            binary_name = bn.to_string();
                        } else {
                            eprintln!(
                                "[native_update] manifest binary name rejected as unsafe: {}",
                                bn
                            );
                        }
                    }
                    break;
                }
            }
        }
    }

    // 3. Determine install path: ~/.claude/local/ (same as official install.sh)
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let install_dir = home.join(".claude").join("local");
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Cannot create ~/.claude/local/: {e}"))?;
    let dest_path = install_dir.join(&binary_name);
    let tmp_path = install_dir.join(format!("{}.tmp", binary_name));

    // 4. Download binary (stream to disk, ~200MB)
    let dl_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let mut downloaded = false;
    for base in &sources {
        if scope.is_cancelled() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }

        let url = format!("{}/{}/{}/{}", base, version, platform, binary_name);
        eprintln!("[native_update] downloading from {}", url);

        let resp = match dl_client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                eprintln!("[native_update] HTTP {} from {}", r.status(), base);
                continue;
            }
            Err(e) => {
                eprintln!("[native_update] request failed: {} ({})", e, base);
                continue;
            }
        };

        let mut stream = resp.bytes_stream();
        // 写盘期间周期检查取消令牌（块结束时 file 关闭，之后才能删临时文件）
        let mut download_err: Option<String> = None;
        // #10 (security): cumulative size cap — a hostile/broken mirror on a
        // fast line could otherwise fill the disk within the 600s timeout
        // (every other download path already has MAX_DOWNLOAD_BYTES).
        const MAX_NATIVE_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
        let mut total_bytes: u64 = 0;
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp_path)
                .map_err(|e| format!("Cannot create tmp file: {e}"))?;
            while let Some(chunk) = stream.next().await {
                if scope.is_cancelled() {
                    download_err = Some(download_cancel::CANCELLED_ERROR.to_string());
                    break;
                }
                let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
                total_bytes += chunk.len() as u64;
                if total_bytes > MAX_NATIVE_DOWNLOAD_BYTES {
                    download_err = Some(
                        "Download exceeds the 512MiB size limit — aborting".to_string(),
                    );
                    break;
                }
                if let Err(e) = file.write_all(&chunk) {
                    download_err = Some(format!("Write error: {e}"));
                    break;
                }
            }
        }
        if let Some(e) = download_err {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }

        // 5. Verify SHA-256 checksum
        // M3: checksum 缺失与不匹配同等处理——manifest 未含 checksum 时直接
        // 接受安装等于无条件信任镜像，改为拒绝并重试下一源。校验改用
        // BufReader 流式喂 Sha256，不再 std::fs::read 一次性读入 ~230MB。
        {
            use sha2::{Digest, Sha256};
            use std::io::Read;
            let mut hasher = Sha256::new();
            {
                let file = std::fs::File::open(&tmp_path)
                    .map_err(|e| format!("Cannot open tmp file for checksum: {e}"))?;
                let mut reader = std::io::BufReader::with_capacity(256 * 1024, file);
                let mut buf = [0u8; 64 * 1024];
                loop {
                    let n = reader
                        .read(&mut buf)
                        .map_err(|e| format!("Checksum read error: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                }
            }
            let actual = format!("{:x}", hasher.finalize());
            if expected_checksum.is_empty() {
                eprintln!(
                    "[native_update] checksum unavailable in manifest for {} -- refusing source",
                    base
                );
                let _ = std::fs::remove_file(&tmp_path);
                continue;
            }
            if actual != expected_checksum {
                eprintln!(
                    "[native_update] checksum mismatch: expected {} -- got {} --",
                    &expected_checksum[..12.min(expected_checksum.len())],
                    &actual[..12.min(actual.len())]
                );
                let _ = std::fs::remove_file(&tmp_path);
                continue;
            }
            eprintln!("[native_update] checksum verified");
        }

        downloaded = true;
        break;
    }

    if !downloaded {
        let _ = std::fs::remove_file(&tmp_path);
        return Err("All download sources failed".to_string());
    }

    // 6. Set executable permission and move to final location
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755));
    }

    // On Windows the running binary may be locked; try rename, then copy+delete
    if let Err(_) = std::fs::rename(&tmp_path, &dest_path) {
        std::fs::copy(&tmp_path, &dest_path).map_err(|e| format!("Cannot install binary: {e}"))?;
        let _ = std::fs::remove_file(&tmp_path);
    }

    eprintln!(
        "[native_update] installed {} -> {}",
        binary_name,
        dest_path.display()
    );
    Ok(version)
}

/// Update the Claude CLI to the latest version.
/// Strategy:
///   Non-China: native binary from GCS  --?npm fallback
///   China: npm with multi-registry + version verification (npmmirror  --?npm official)
#[tauri::command]
pub async fn update_claude_cli(app: AppHandle, scope_id: Option<String>) -> Result<String, String> {
    let scope = CancelScope::new(scope_id.as_deref());
    let china = is_china_network().await;

    // Phase 1: Try native binary download (non-China only, GCS CDN)
    match try_native_cli_update(china, &scope).await {
        Ok(version) => {
            eprintln!(
                "[update_claude_cli] native binary update success: v{}",
                version
            );
            return Ok(version);
        }
        Err(e) => {
            // 用户取消：不降级到 npm 流程，直接传播
            if e == download_cancel::CANCELLED_ERROR {
                return Err(e);
            }
            eprintln!(
                "[update_claude_cli] native binary skipped/failed: {}, using npm",
                e
            );
        }
    }

    // Phase 2: npm with multi-registry + version verification
    // For China: npmmirror first (fast), verify version matches target,
    // if stale  --?auto-retry with npm official
    let npm_path = if let Some(local_bin) = get_local_node_bin() {
        #[cfg(target_os = "windows")]
        let npm = local_bin.join("npm.cmd");
        #[cfg(not(target_os = "windows"))]
        let npm = local_bin.join("npm");
        npm.to_string_lossy().to_string()
    } else {
        #[cfg(target_os = "windows")]
        let npm = "npm.cmd".to_string();
        #[cfg(not(target_os = "windows"))]
        let npm = "npm".to_string();
        npm
    };

    let enriched_path = build_enriched_path();
    let prefix_dir = npm_global_dir()?;
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm prefix dir: {e}"))?;
    let cache_dir = npm_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).ok();

    // Fetch target version for post-install verification (herear.cn for China, GCS for others).
    // Record the pre-update version too so a mirror can never downgrade the CLI.
    let target_version = {
        let c = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        fetch_latest_cli_version(&c, china).await
    };
    let before_version = npm_global_installed_version();
    let pkg_spec = cli_pkg_spec(&target_version);
    eprintln!(
        "[update_claude_cli] target {:?}, before {:?}, installing '{}'",
        target_version, before_version, pkg_spec
    );

    let registries: Vec<&str> = if china {
        vec![
            "https://registry.npmmirror.com",
            "https://registry.npmjs.org",
        ]
    } else {
        vec!["https://registry.npmjs.org"]
    };

    let mut last_err = String::new();
    for registry in &registries {
        eprintln!("[update_claude_cli] trying npm registry: {}", registry);
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 30, "phase": "npm_fallback"
            }),
        );

        let args: Vec<String> = vec![
            "install".to_string(),
            "-g".to_string(),
            pkg_spec.clone(),
            format!("--registry={}", registry),
            format!("--prefix={}", prefix_dir.display()),
            format!("--cache={}", cache_dir.display()),
        ];
        let args_str: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        #[cfg(target_os = "windows")]
        let result = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path)
                .stdin(Stdio::null())
                .creation_flags(0x08000000);
            cmd.kill_on_drop(true);
            await_command_with_cancel(&mut cmd, 300, &scope).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path).stdin(Stdio::null());
            cmd.kill_on_drop(true);
            await_command_with_cancel(&mut cmd, 300, &scope).await
        };

        match result {
            Ok(output) if output.status.success() => {
                // Read the version straight from npm-global's package.json —
                // spawning `claude --version` here is slow (2s timeout in
                // check_claude_cli) and may resolve to a pinned/system CLI.
                let mut installed = npm_global_installed_version();
                if installed.is_none() {
                    installed = check_claude_cli().await.ok().and_then(|c| c.version);
                }
                // The installed version must be readable — returning Ok with an
                // "unknown" version would look like a successful update while the
                // verification guard chain was silently skipped.
                let Some(version) = installed.clone() else {
                    let msg = format!(
                        "npm install succeeded via {} but the installed version could not be read",
                        registry
                    );
                    eprintln!("[update_claude_cli] {}", msg);
                    return Err(msg);
                };
                eprintln!(
                    "[update_claude_cli] npm installed v{} from {}",
                    version, registry
                );
                let _ = app.emit(
                    "setup:download:progress",
                    serde_json::json!({
                        "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
                    }),
                );

                // Version verification: if target is known and installed version is stale,
                // try next registry (npmmirror may be behind)
                if let Some(ref target) = target_version {
                    if version != *target && version_gt(target, &version) {
                        eprintln!(
                            "[update_claude_cli] v{} < target v{}, trying next registry",
                            version, target
                        );
                        last_err = format!(
                            "Mirror {} has v{} but latest is v{}",
                            registry, version, target
                        );
                        continue;
                    }
                }

                // No known target: never let a mirror downgrade the CLI.
                if target_version.is_none() {
                    if let (Some(ref before), Some(ref after)) = (before_version.as_ref(), installed.as_ref()) {
                        if version_gt(before, after) {
                            eprintln!(
                                "[update_claude_cli] v{} < previous v{}, trying next registry",
                                after, before
                            );
                            last_err = format!(
                                "Mirror {} installed v{} which is older than the previous v{}",
                                registry, after, before
                            );
                            continue;
                        }
                    }
                }

                return Ok(version);
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!(
                    "npm install failed ({}): {}",
                    registry,
                    stderr.chars().take(500).collect::<String>()
                );
                eprintln!("[update_claude_cli] {}", last_err);
            }
            Err(e) => {
                // 用户取消：不清理 npm-global（CLI 可能已装在里面），直接传播
                if e == download_cancel::CANCELLED_ERROR {
                    return Err(download_cancel::CANCELLED_ERROR.to_string());
                }
                if e.starts_with("Command timed out") {
                    last_err = format!("npm install timed out ({})", registry);
                    eprintln!("[update_claude_cli] {}", last_err);
                } else {
                    last_err = format!("Failed to run npm: {e}");
                    eprintln!("[update_claude_cli] {}", last_err);
                }
            }
        }
    }

    Err(last_err)
}

/// Check if a newer CLI version is available.
/// Sources: herear.cn mirror (China-first)  --?GCS  --?npm registry.
#[derive(serde::Serialize)]
pub(crate) struct CliUpdateCheck {
    current: Option<String>,
    latest: Option<String>,
    update_available: bool,
}

#[tauri::command]
pub async fn check_cli_update() -> Result<CliUpdateCheck, String> {
    let t0 = std::time::Instant::now();
    let cli = check_claude_cli().await.ok();
    let current = cli.as_ref().and_then(|c| c.version.clone());
    eprintln!("[check_cli_update] check_claude_cli took {:?}", t0.elapsed());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    let china = is_china_network().await;
    eprintln!("[check_cli_update] after is_china_network, elapsed {:?}", t0.elapsed());

    // Version check sources: China users try herear.cn first (GCS may be slow/blocked)
    let latest = fetch_latest_cli_version(&client, china).await;
    eprintln!("[check_cli_update] version fetch done, elapsed {:?}, latest={:?}", t0.elapsed(), latest);

    let update_available = match (&current, &latest) {
        (Some(cur), Some(lat)) => version_gt(lat.trim(), cur.trim()),
        _ => false,
    };

    Ok(CliUpdateCheck {
        current,
        latest,
        update_available,
    })
}

/// Install the Claude CLI via npm with network-aware mirror selection:
/// 0. Detect network environment (China vs Global)
/// 1. (Windows) Ensure git-bash is available  --?auto-install PortableGit if missing
/// 2. Ensure npm is available  --?download Node.js locally if needed
/// 3. Install CLI via npm with region-appropriate registry mirrors
#[tauri::command]
pub async fn install_claude_cli(app: AppHandle, scope_id: Option<String>) -> Result<(), String> {
    let scope = CancelScope::new(scope_id.as_deref());

    // Skip installation if CLI already exists on system.
    // On Windows, still continue when git-bash is missing because reinstall is the repair path.
    let existing_cli = find_claude_binary();
    #[cfg(target_os = "windows")]
    let can_skip_install = existing_cli.is_some() && find_git_bash().is_some();
    #[cfg(not(target_os = "windows"))]
    let can_skip_install = existing_cli.is_some();
    if can_skip_install {
        eprintln!("CLI already found on system, skipping installation");
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
            }),
        );
        return Ok(());
    }

    // Phase 0: Detect network environment (used by all subsequent phases)
    let china = is_china_network().await;
    if scope.is_cancelled() {
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    // Phase 1 (Windows only): Ensure git-bash is available
    #[cfg(target_os = "windows")]
    {
        if find_git_bash().is_none() {
            eprintln!("git-bash not found, auto-installing PortableGit...");
            install_git_bash_inner(&app, china, &scope).await.map_err(|e| {
                if download_cancel::is_cancelled_err(&e) {
                    e
                } else {
                    format!(
                        "Failed to install Git for Windows: {}. \
                         Please install Git for Windows manually: https://git-scm.com/downloads/win",
                        e
                    )
                }
            })?;
            // Newly installed PortableGit must be visible to the cached
            // git-bash discovery and enriched PATH immediately.
            crate::invalidate_resolver_caches();
        }

        // If CLI is already installed (only git-bash was missing), skip download phases
        if find_claude_binary().is_some() {
            eprintln!("CLI already installed, git-bash was the only missing dependency");
            finalize_cli_install_paths(&app);
            return Ok(());
        }
    }

    if scope.is_cancelled() {
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    // Phase 2: Ensure npm is available
    let has_npm = is_system_npm_available().await || get_local_node_bin().is_some();

    if !has_npm {
        eprintln!("npm not available, deploying Node.js locally...");
        install_node_env_inner(&app, china, &scope).await.map_err(|e| {
            if download_cancel::is_cancelled_err(&e) {
                e
            } else {
                format!(
                    "Failed to install Node.js runtime: {}. Please install Node.js manually.",
                    e
                )
            }
        })?;
    }

    if scope.is_cancelled() {
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    // Phase 3: Install CLI via npm
    install_cli_via_npm(&app, china, &scope)
        .await
        .map_err(|npm_err| {
            if download_cancel::is_cancelled_err(&npm_err) {
                npm_err
            } else {
                format!("CLI installation failed via npm: {}", npm_err)
            }
        })?;

    eprintln!("CLI installed via npm");
    finalize_cli_install_paths(&app);
    Ok(())
}

/// Inject a directory into the user's Unix shell profile PATH.
/// Appends an export line to the first existing profile file (.zshrc, .bashrc, etc.).
#[cfg(not(target_os = "windows"))]
fn inject_unix_shell_path(dir: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let export_line = format!("export PATH=\"{}:$PATH\"", dir);
    let marker = "# Added by Little Claude";
    let block = format!("\n{}\n{}\n", marker, export_line);

    let profiles = [
        home.join(".zshrc"),
        home.join(".bashrc"),
        home.join(".bash_profile"),
        home.join(".profile"),
    ];

    // Check if already injected
    for p in &profiles {
        if let Ok(c) = std::fs::read_to_string(p) {
            if c.contains(&export_line) {
                return;
            }
        }
    }

    // Append to the first existing profile
    for p in &profiles {
        if p.exists() {
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(p) {
                use std::io::Write;
                let _ = f.write_all(block.as_bytes());
                eprintln!("Injected PATH into {}", p.display());
                return;
            }
        }
    }

    // None exist  --?create ~/.profile
    let _ = std::fs::write(home.join(".profile"), block);
    eprintln!("Created ~/.profile with PATH injection");
}

/// Post-install: add relevant directories to Windows user PATH and emit completion.
fn finalize_cli_install_paths(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        // Collect all directories that should be on PATH
        let mut dirs_to_add: Vec<String> = vec![];

        if let Some(cli_dir) = cli_download_dir() {
            dirs_to_add.push(cli_dir.to_string_lossy().to_string());
        }
        if let Some(node_bin) = get_local_node_bin() {
            dirs_to_add.push(node_bin.to_string_lossy().to_string());
        }
        if let Some(npm_bin) = get_npm_global_bin() {
            dirs_to_add.push(npm_bin.to_string_lossy().to_string());
        }
        // Include local PortableGit bin and cmd directories
        if let Ok(git_dir) = git_download_dir() {
            let git_bin = git_dir.join("bin");
            if git_bin.exists() {
                dirs_to_add.push(git_bin.to_string_lossy().to_string());
            }
            let git_cmd = git_dir.join("cmd");
            if git_cmd.exists() {
                dirs_to_add.push(git_cmd.to_string_lossy().to_string());
            }
        }

        for dir in &dirs_to_add {
            let ps_script = format!(
                "$old = [Environment]::GetEnvironmentVariable('Path','User'); \
                 if ($old -and -not $old.Contains('{}')) {{ \
                   [Environment]::SetEnvironmentVariable('Path', $old + ';{}', 'User') \
                 }} elseif (-not $old) {{ \
                   [Environment]::SetEnvironmentVariable('Path', '{}', 'User') \
                 }}",
                dir.replace('\'', "''"),
                dir.replace('\'', "''"),
                dir.replace('\'', "''"),
            );
            let path_result = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .creation_flags(0x08000000)
                .output();
            match path_result {
                Ok(output) if output.status.success() => {
                    eprintln!("Added to user PATH: {}", dir);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("Failed to add to PATH: {}", stderr);
                }
                Err(e) => eprintln!("Failed to run PowerShell for PATH: {}", e),
            }
        }

        // Set CLAUDE_CODE_GIT_BASH_PATH user env var so `claude` works from any terminal
        if let Some(bash_path) = find_git_bash() {
            let ps_script = format!(
                "[Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', '{}', 'User')",
                bash_path.replace('\'', "''"),
            );
            let result = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .creation_flags(0x08000000)
                .output();
            match result {
                Ok(output) if output.status.success() => {
                    eprintln!("Set CLAUDE_CODE_GIT_BASH_PATH={}", bash_path);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("Failed to set CLAUDE_CODE_GIT_BASH_PATH: {}", stderr);
                }
                Err(e) => eprintln!("Failed to run PowerShell for env var: {}", e),
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(node_bin) = get_local_node_bin() {
            inject_unix_shell_path(&node_bin.to_string_lossy());
        }
        if let Some(npm_bin) = get_npm_global_bin() {
            inject_unix_shell_path(&npm_bin.to_string_lossy());
        }
        let _ = app;
    }

    // The tier scan / git bash / enriched PATH caches were built from the
    // pre-install filesystem state — drop them so the next resolve sees the
    // freshly installed binaries.
    crate::invalidate_resolver_caches();

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "complete"
        }),
    );
}

// ─── Node.js local deployment ──────────────────────────────────────────

/// Hardcoded Node.js LTS version for local deployment.
const NODE_LTS_VERSION: &str = "v22.22.0";

/// Primary Node.js download base URL (official).
const NODE_DIST_OFFICIAL: &str = "https://nodejs.org/dist";

/// China mirror: npmmirror CDN for Node.js binaries.
const NODE_DIST_NPMMIRROR: &str = "https://cdn.npmmirror.com/binaries/node";

/// China mirror: Huawei Cloud for Node.js binaries.
const NODE_DIST_HUAWEI: &str = "https://mirrors.huaweicloud.com/nodejs";

/// Directory for app-local Node.js installation.
fn node_download_dir() -> Result<std::path::PathBuf, String> {
    app_data_dir().map(|d| d.join("node"))
}

/// R7 (security): these paths become `--prefix=`/`--cache=` arguments on a
/// `cmd /C` command line (npm install/update chains). The data dir embeds the
/// Windows username — cmd metacharacters in it (& | < > ^ % " or newlines)
/// would truncate or inject the command line. Spaces/backslashes stay
/// allowed (Rust quotes args; cmd only re-splits on metacharacters).
fn cmd_path_arg_safe(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| "&|<>^%\"\n\r\0".contains(c))
}

/// Directory for npm global installs (--prefix target).
pub(crate) fn npm_global_dir() -> Result<std::path::PathBuf, String> {
    let d = app_data_dir()?.join("npm-global");
    if !cmd_path_arg_safe(&d.to_string_lossy()) {
        return Err(format!(
            "npm prefix path contains shell metacharacters and cannot be used safely: {}",
            d.display()
        ));
    }
    Ok(d)
}

/// Directory for npm cache (avoids system cache EPERM on Windows).
fn npm_cache_dir() -> Result<std::path::PathBuf, String> {
    let d = app_data_dir()?.join("npm-cache");
    if !cmd_path_arg_safe(&d.to_string_lossy()) {
        return Err(format!(
            "npm cache path contains shell metacharacters and cannot be used safely: {}",
            d.display()
        ));
    }
    Ok(d)
}

/// Get the bin directory of the local Node.js installation, if it exists.
pub(crate) fn get_local_node_bin() -> Option<std::path::PathBuf> {
    let node_dir = node_download_dir().ok()?;
    #[cfg(target_os = "windows")]
    {
        // Windows: node.exe is at the root of the extracted directory
        let node_exe = node_dir.join("node.exe");
        if node_exe.exists() {
            return Some(node_dir);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let bin = node_dir.join("bin");
        if bin.join("node").exists() {
            return Some(bin);
        }
    }
    None
}

/// Get the bin directory of npm-global, if it exists.
pub(crate) fn get_npm_global_bin() -> Option<std::path::PathBuf> {
    let dir = npm_global_dir().ok()?;
    #[cfg(target_os = "windows")]
    let bin = dir.clone();
    #[cfg(not(target_os = "windows"))]
    let bin = dir.join("bin");
    if bin.exists() {
        Some(bin)
    } else {
        None
    }
}

/// Determine Node.js archive filename and format for the current platform.
pub(crate) fn get_node_archive_info() -> Result<(String, &'static str), String> {
    // Returns (filename, extension)
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok((format!("node-{}-darwin-arm64", NODE_LTS_VERSION), "tar.gz")),
        ("macos", "x86_64") => Ok((format!("node-{}-darwin-x64", NODE_LTS_VERSION), "tar.gz")),
        ("windows", "x86_64") => Ok((format!("node-{}-win-x64", NODE_LTS_VERSION), "zip")),
        ("windows", "aarch64") => Ok((format!("node-{}-win-arm64", NODE_LTS_VERSION), "zip")),
        ("linux", "x86_64") => Ok((format!("node-{}-linux-x64", NODE_LTS_VERSION), "tar.gz")),
        ("linux", "aarch64") => Ok((format!("node-{}-linux-arm64", NODE_LTS_VERSION), "tar.gz")),
        (os, arch) => Err(format!("Unsupported platform for Node.js: {}-{}", os, arch)),
    }
}

/// Check if npm is available on the system (not counting local Node.js).
pub(crate) async fn is_system_npm_available() -> bool {
    let enriched_path = build_enriched_path();

    // 1. Direct PATH check
    #[cfg(target_os = "windows")]
    let result = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npm.cmd", "--version"])
            .env("PATH", &enriched_path)
            .stdin(Stdio::null())
            .creation_flags(0x08000000);
        cmd.kill_on_drop(true);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let result = {
        let mut cmd = Command::new("npm");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
        cmd.kill_on_drop(true);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };

    if matches!(&result, Ok(Ok(output)) if output.status.success()) {
        return true;
    }

    // 2. Fallback: login shell (macOS/Linux GUI apps don't inherit shell PATH)
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let shell_result = {
            let mut cmd = Command::new(&shell);
            cmd.args(["-l", "-c", "npm --version"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            cmd.kill_on_drop(true);
            tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
        };
        if matches!(shell_result, Ok(Ok(output)) if output.status.success()) {
            eprintln!(
                "npm found via login shell ({}) but not via enriched PATH",
                shell
            );
            return true;
        }
    }

    false
}

#[derive(Serialize)]
pub(crate) struct NodeEnvStatus {
    pub(crate) node_available: bool,
    pub(crate) node_version: Option<String>,
    pub(crate) node_source: Option<String>, // "system" | "local"
    pub(crate) npm_available: bool,
}

#[tauri::command]
pub async fn check_node_env() -> Result<NodeEnvStatus, String> {
    let enriched_path = build_enriched_path();

    // 1. Check local Node.js first
    if let Some(local_bin) = get_local_node_bin() {
        let node_path = local_bin.join(if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        });
        let mut node_cmd = Command::new(&node_path);
        node_cmd.arg("--version").stdin(Stdio::null());
        node_cmd.kill_on_drop(true);
        #[cfg(target_os = "windows")]
        node_cmd.creation_flags(0x08000000);
        if let Ok(Ok(output)) =
            tokio::time::timeout(std::time::Duration::from_secs(10), node_cmd.output()).await
        {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return Ok(NodeEnvStatus {
                    node_available: true,
                    node_version: Some(version),
                    node_source: Some("local".to_string()),
                    npm_available: true, // local Node.js always comes with npm
                });
            }
        }
    }

    // 2. Check system Node.js
    #[cfg(target_os = "windows")]
    let node_result = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "node", "--version"])
            .env("PATH", &enriched_path)
            .stdin(Stdio::null())
            .creation_flags(0x08000000);
        cmd.kill_on_drop(true);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let node_result = {
        let mut cmd = Command::new("node");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
        cmd.kill_on_drop(true);
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };

    match node_result {
        Ok(Ok(output)) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let npm_available = is_system_npm_available().await;
            Ok(NodeEnvStatus {
                node_available: true,
                node_version: Some(version),
                node_source: Some("system".to_string()),
                npm_available,
            })
        }
        _ => Ok(NodeEnvStatus {
            node_available: false,
            node_version: None,
            node_source: None,
            npm_available: is_system_npm_available().await,
        }),
    }
}

/// Download and extract Node.js LTS to the local app directory.
#[tauri::command]
pub async fn install_node_env(app: AppHandle, scope_id: Option<String>) -> Result<(), String> {
    let scope = CancelScope::new(scope_id.as_deref());
    let china = is_china_network().await;
    if scope.is_cancelled() {
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }
    install_node_env_inner(&app, china, &scope).await
}

async fn install_node_env_inner(
    app: &AppHandle,
    china: bool,
    scope: &CancelScope,
) -> Result<(), String> {
    // 入口统一失效 resolver 缓存（同 install_git_bash_inner）：独立入口
    // install_node_env 装完 node 后 PATH 注入必须立即看到新 bin。
    crate::invalidate_resolver_caches();
    let (archive_name, ext) = get_node_archive_info()?;
    let filename = format!("{}.{}", archive_name, ext);

    let install_dir = node_download_dir()?;
    // 取消时只清理本次安装新建的目录（避免误删既有安装）
    let node_dir_existed = install_dir.exists();
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create node dir: {}", e))?;

    let client = build_smart_http_client(
        std::time::Duration::from_secs(10),
        std::time::Duration::from_secs(120),
    )
    .await;

    // Network-aware source ordering
    let sources: Vec<String> = if china {
        vec![
            format!("{}/{}/{}", NODE_DIST_NPMMIRROR, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_HUAWEI, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_OFFICIAL, NODE_LTS_VERSION, filename),
        ]
    } else {
        vec![
            format!("{}/{}/{}", NODE_DIST_OFFICIAL, NODE_LTS_VERSION, filename),
            format!("{}/{}/{}", NODE_DIST_NPMMIRROR, NODE_LTS_VERSION, filename),
        ]
    };

    let mut last_err = String::new();
    let mut archive_bytes: Option<Vec<u8>> = None;

    for (i, url) in sources.iter().enumerate() {
        if scope.is_cancelled() {
            cleanup_created_dir(node_dir_existed, &install_dir);
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }

        eprintln!("Trying Node.js download: {}", url);
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 0, "phase": "node_downloading"
            }),
        );

        // Fetch the official checksum for this source first. A source without
        // a usable checksum is untrusted (mirror tampering) and gets skipped
        // before any bytes are downloaded.
        let dir = url.trim_end_matches(&format!("/{}", filename));
        let checksum_url = format!("{}/SHASUMS256.txt", dir);
        let Some(expected) = fetch_checksum_for(&client, &checksum_url, &filename).await else {
            last_err = format!("Source {}: checksum unavailable ({})", url, checksum_url);
            eprintln!("{}", last_err);
            continue;
        };

        match download_with_progress(app, &client, url, "node_downloading", scope).await {
            Ok(bytes) => {
                if sha256_hex(&bytes) != expected {
                    last_err = format!("Source {}: checksum mismatch", url);
                    eprintln!("{}", last_err);
                    continue;
                }
                eprintln!("Node.js download verified (SHA-256) from source {}", i);
                archive_bytes = Some(bytes);
                break;
            }
            Err(e) => {
                // 用户取消：清理本次新建的目录后立即返回（不继续尝试下一源）
                if download_cancel::is_cancelled_err(&e) {
                    cleanup_created_dir(node_dir_existed, &install_dir);
                    return Err(download_cancel::CANCELLED_ERROR.to_string());
                }
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes = archive_bytes
        .ok_or_else(|| format!("All Node.js download sources failed: {}", strip_urls(&last_err)))?;

    // 下载完成后、解压前再查一次取消（下载与解压之间是长 await 边界）
    if scope.is_cancelled() {
        cleanup_created_dir(node_dir_existed, &install_dir);
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    // Extract
    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 85, "phase": "node_extracting"
        }),
    );

    extract_node_archive(&bytes, ext, &archive_name, &install_dir)?;

    // Set executable permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin_dir = install_dir.join("bin");
        if bin_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&bin_dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::set_permissions(
                        entry.path(),
                        std::fs::Permissions::from_mode(0o755),
                    );
                }
            }
        }
    }

    if scope.is_cancelled() {
        cleanup_created_dir(node_dir_existed, &install_dir);
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "node_complete"
        }),
    );

    eprintln!(
        "Node.js {} installed to {:?}",
        NODE_LTS_VERSION, install_dir
    );
    // 成功路径再次失效：入口失效只覆盖「下载前」，下载窗口（30s+）内并发
    // resolver（会话启动/标题生成/检测）会用安装前的旧 PATH 重新填充缓存，
    // 没有这次失效的话装完仍读旧值（独立入口无 finalize 兜底）。
    crate::invalidate_resolver_caches();
    Ok(())
}

// ─── Git for Windows (PortableGit) local deployment ─────────────────────────

/// PortableGit version for auto-deployment on Windows (when git-bash is missing).
#[cfg(target_os = "windows")]
const GIT_PORTABLE_VERSION: &str = "2.47.1.2";

/// Git for Windows release tag (used in download URLs).
#[cfg(target_os = "windows")]
const GIT_RELEASE_TAG: &str = "v2.47.1.windows.2";

/// GitHub releases URL for Git for Windows.
#[cfg(target_os = "windows")]
const GIT_DIST_GITHUB: &str = "https://github.com/git-for-windows/git/releases/download";

/// China mirror: npmmirror binary mirror.
#[cfg(target_os = "windows")]
const GIT_DIST_NPMMIRROR: &str = "https://registry.npmmirror.com/-/binary/git-for-windows";

/// China mirror: Huawei Cloud.
#[cfg(target_os = "windows")]
const GIT_DIST_HUAWEI: &str = "https://mirrors.huaweicloud.com/git-for-windows";

/// Download and install PortableGit to provide bash.exe on Windows.
/// The .7z.exe self-extracting archive is downloaded and executed silently.
#[cfg(target_os = "windows")]
pub(crate) async fn install_git_bash_inner(
    app: &AppHandle,
    china: bool,
    scope: &CancelScope,
) -> Result<(), String> {
    // 入口统一失效 resolver 缓存：本函数被 prereq 独立入口直接调用
    // （无 finalize_cli_install_paths 兜底），漏掉时「装完 PortableGit 仍
    // 检测不到」直到重启。幂等无害——主流程调用点的 1984 行失效冗余保留。
    crate::invalidate_resolver_caches();
    let install_dir = git_download_dir()?;

    // If an incomplete installation exists (no bash.exe), clean it up
    if install_dir.exists() {
        let bash = install_dir.join("bin").join("bash.exe");
        if !bash.exists() {
            eprintln!("Incomplete Git installation found, cleaning up...");
            let _ = std::fs::remove_dir_all(&install_dir);
        }
    }

    // Already installed?
    if install_dir.join("bin").join("bash.exe").exists() {
        eprintln!("PortableGit already installed at {:?}", install_dir);
        return Ok(());
    }

    // 取消时只清理本次安装新建的目录
    let git_dir_existed = install_dir.exists();
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Failed to create git dir: {}", e))?;

    // Determine architecture: x64 or arm64 (64-bit only)
    let arch_suffix = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "64", // x86_64 and fallback
    };
    let filename = format!(
        "PortableGit-{}-{}-bit.7z.exe",
        GIT_PORTABLE_VERSION, arch_suffix
    );

    let sources: Vec<String> = if china {
        vec![
            // China: Huawei fastest, then npmmirror, GitHub last
            format!("{}/{}/{}", GIT_DIST_HUAWEI, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_NPMMIRROR, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_GITHUB, GIT_RELEASE_TAG, filename),
        ]
    } else {
        vec![
            format!("{}/{}/{}", GIT_DIST_GITHUB, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_HUAWEI, GIT_RELEASE_TAG, filename),
            format!("{}/{}/{}", GIT_DIST_NPMMIRROR, GIT_RELEASE_TAG, filename),
        ]
    };

    let client = build_smart_http_client(
        std::time::Duration::from_secs(15), // Fast failover between mirrors
        std::time::Duration::from_secs(300), // 5 min for large download
    )
    .await;

    let mut last_err = String::new();
    let mut archive_bytes: Option<Vec<u8>> = None;

    for url in &sources {
        if scope.is_cancelled() {
            cleanup_created_dir(git_dir_existed, &install_dir);
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }

        eprintln!("Trying PortableGit download: {}", url);
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": 0, "total": 0, "percent": 0, "phase": "git_downloading"
            }),
        );

        // GitHub publishes "<file>.sha256" next to every release asset and the
        // mirrors sync it. A source without a usable checksum is untrusted.
        let checksum_url = format!("{}.sha256", url);
        let Some(expected) = fetch_checksum_for(&client, &checksum_url, &filename).await else {
            last_err = format!("Source {}: checksum unavailable ({})", url, checksum_url);
            eprintln!("{}", last_err);
            continue;
        };

        match download_with_progress(app, &client, url, "git_downloading", scope).await {
            Ok(bytes) => {
                if sha256_hex(&bytes) != expected {
                    last_err = format!("Source {}: checksum mismatch", url);
                    eprintln!("{}", last_err);
                    continue;
                }
                eprintln!("PortableGit download verified ({} bytes)", bytes.len());
                archive_bytes = Some(bytes);
                break;
            }
            Err(e) => {
                // 用户取消：清理本次新建的目录后立即返回
                if download_cancel::is_cancelled_err(&e) {
                    cleanup_created_dir(git_dir_existed, &install_dir);
                    return Err(download_cancel::CANCELLED_ERROR.to_string());
                }
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes =
        archive_bytes.ok_or_else(|| format!("All Git download sources failed: {}", strip_urls(&last_err)))?;

    if scope.is_cancelled() {
        cleanup_created_dir(git_dir_existed, &install_dir);
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    // Write the .7z.exe to a temp file
    let temp_path = install_dir.join(&filename);
    std::fs::write(&temp_path, &bytes)
        .map_err(|e| format!("Failed to write PortableGit archive: {}", e))?;

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 85, "phase": "git_extracting"
        }),
    );

    // Run the self-extracting archive silently: -o<dir> -y
    eprintln!("Extracting PortableGit to {:?}...", install_dir);
    let mut extract_cmd = Command::new(&temp_path);
    extract_cmd
        .args([&format!("-o{}", install_dir.display()), "-y"])
        .stdin(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .kill_on_drop(true);
    let extract_result = await_command_with_cancel(&mut extract_cmd, 120, scope).await;

    // Clean up the downloaded archive regardless of result
    let _ = std::fs::remove_file(&temp_path);

    match extract_result {
        Ok(output) if output.status.success() => {
            eprintln!("PortableGit extraction succeeded");
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "PortableGit extraction failed (exit {}): {}",
                output.status, stderr
            ));
        }
        Err(e) => {
            if e == download_cancel::CANCELLED_ERROR {
                cleanup_created_dir(git_dir_existed, &install_dir);
                return Err(download_cancel::CANCELLED_ERROR.to_string());
            }
            if e.starts_with("Command timed out") {
                return Err("PortableGit extraction timed out after 120s".to_string());
            }
            return Err(format!("Failed to run PortableGit extractor: {}", e));
        }
    }

    // Verify bash.exe exists
    let bash = install_dir.join("bin").join("bash.exe");
    if !bash.exists() {
        return Err("bash.exe not found after PortableGit extraction".to_string());
    }

    if scope.is_cancelled() {
        cleanup_created_dir(git_dir_existed, &install_dir);
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "git_complete"
        }),
    );

    eprintln!("PortableGit installed to {:?}", install_dir);
    // 成功路径再次失效：同 install_node_env_inner——下载窗口内并发 resolver
    // 会把「无 bash」的旧状态写回缓存，装完必须再失效一次才可见。
    crate::invalidate_resolver_caches();
    Ok(())
}

/// Download a URL with streaming progress events.
///
/// 完整性：Node.js/PortableGit 下载已有官方 SHA-256 数据源（SHASUMS256.txt /
/// `*.sha256`），由调用方比对；此处再以 Content-Length 大小校验兜底
/// （截断/中途失败时 downloaded != total 直接报错）。
async fn download_with_progress(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    phase: &str,
    scope: &CancelScope,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    // M4: Content-Length 来自不可信下载源——巨值会让 with_capacity 预分配
    // 数 GB 内存直接 abort（Node/Git 归档远小于 1 GiB，超限必是恶意/损坏源）。
    const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
    if total > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "Download too large: {} bytes (limit {} bytes) from {}",
            total, MAX_DOWNLOAD_BYTES, url
        ));
    }
    let mut downloaded: u64 = 0;
    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if scope.is_cancelled() {
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        bytes.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;
        // 低 13: 无 Content-Length 的响应此前不受限、无界累积——按累计字节
        // 同样限流（超过 1 GiB 报错），防恶意源无限灌入内存。
        if downloaded > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "Download too large: {} bytes (limit {} bytes) from {}",
                downloaded, MAX_DOWNLOAD_BYTES, url
            ));
        }

        let percent = if total > 0 {
            (downloaded * 80 / total) as u8
        } else {
            0
        };
        let _ = app.emit(
            "setup:download:progress",
            serde_json::json!({
                "downloaded": downloaded, "total": total, "percent": percent, "phase": phase
            }),
        );
    }

    // 大小校验兜底：Content-Length 可得时实际字节数必须一致（防截断/镜像损坏）
    if total > 0 && downloaded != total {
        return Err(format!(
            "Download incomplete: expected {} bytes, got {} bytes ({})",
            total, downloaded, url
        ));
    }

    Ok(bytes)
}

// ─── Download checksum verification (S9) ────────────────────────────────────

/// Extract the SHA-256 digest for `filename` from a checksum file body.
/// Supports two-field lines:
/// - node SHASUMS256.txt:   "<hex>  <filename>"
/// - GitHub release .sha256: "<hex> *<filename>"
/// When `single_value_ok`, a single-field line (bare 64-hex digest) is also
/// accepted — mirrors like Huawei Cloud publish "{file}.sha256" files that
/// contain only the digest, and the caller enables this only for adjacent-
/// checksum URLs where ownership is unambiguous.
/// Malformed lines are skipped instead of aborting the whole file: a stray
/// line must not kill a valid entry on a later line.
fn extract_checksum(text: &str, filename: &str, single_value_ok: bool) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(hex) = parts.next() else { continue };
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        match parts.next() {
            // 单段行：仅限 "{file}.sha256" 紧邻校验文件（华为云等镜像的裸 hash 格式）
            None if single_value_ok => return Some(hex.to_ascii_lowercase()),
            Some(name) if name.trim_start_matches('*') == filename => {
                return Some(hex.to_ascii_lowercase());
            }
            _ => continue,
        }
    }
    None
}

/// Fetch the checksum file next to a download URL and extract the digest for
/// `filename`. Returns None when the checksum file is unavailable or has no
/// matching entry — callers must treat that source as untrusted.
async fn fetch_checksum_for(
    client: &reqwest::Client,
    checksum_url: &str,
    filename: &str,
) -> Option<String> {
    let resp = client.get(checksum_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    // "{file}.sha256" 是紧邻校验约定：文件里的裸 hash 即目标文件的摘要。
    // SHASUMS256.txt（多文件清单）保持严格——无文件名的行不算匹配。
    let single_value_ok = checksum_url.ends_with(&format!("{}.sha256", filename));
    extract_checksum(&text, filename, single_value_ok)
}

/// SHA-256 hex digest of a byte slice (lowercase).
fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(data))
}

/// Remove URLs from an error message for user-facing display.
/// Full details (including per-source URLs) remain in the stderr log; the
/// UI shows only the cause category so users aren't confronted with a wall
/// of mirror links when every download source fails.
fn strip_urls(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut rest = msg;
    while let Some(start) = rest.find("http") {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        // URL 终止于空白、右括号，或"冒号+空白"（"https://...exe: msg" 中冒号是
        // URL 与消息的分隔符；端口冒号后必跟数字/斜杠，不受影响）
        let end = tail
            .char_indices()
            .find(|(i, c)| {
                if *c == ':' {
                    (i + 1 >= tail.len())
                        || matches!(
                            tail[i + 1..].chars().next(),
                            Some(n) if n.is_whitespace() || n == ')'
                        )
                } else {
                    c.is_whitespace() || *c == ')'
                }
            })
            .map(|(i, _)| i)
            .unwrap_or(tail.len());
        out.push_str("[url]");
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod checksum_tests {
    use super::*;

    #[test]
    fn parses_shasums_format() {
        let text = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  node-v22.22.0-win-x64.zip\n\
                    deadbeef00000000000000000000000000000000000000000000000000000000  node-v22.22.0-darwin-arm64.tar.gz\n";
        assert_eq!(
            extract_checksum(text, "node-v22.22.0-win-x64.zip", false).as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert!(extract_checksum(text, "node-v22.22.0-linux-x64.tar.gz", false).is_none());
    }

    #[test]
    fn parses_github_star_format() {
        let text = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *PortableGit-2.47.1.2-64-bit.7z.exe\n";
        assert_eq!(
            extract_checksum(text, "PortableGit-2.47.1.2-64-bit.7z.exe", false).as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
    }

    #[test]
    fn parses_single_field_checksum_when_allowed() {
        // 华为云等镜像的 "{file}.sha256" 是裸 hash 单段格式（实测
        // d73f0c1a42... 即此形态）——这是 git-bash 自动安装此前三源全灭的根因
        let bare = "d73f0c1a42afbabe43862bd5abf5a646798125bc33cc02b7da7bbaeddae948f0\n";
        assert_eq!(
            extract_checksum(bare, "PortableGit-2.47.1.2-64-bit.7z.exe", true).as_deref(),
            Some("d73f0c1a42afbabe43862bd5abf5a646798125bc33cc02b7da7bbaeddae948f0")
        );
        // 严格模式（SHASUMS256.txt 等）下单段行不算匹配
        assert!(extract_checksum(bare, "PortableGit-2.47.1.2-64-bit.7z.exe", false).is_none());
    }

    #[test]
    fn skips_bad_lines_instead_of_aborting() {
        // 坏行/空行不能杀死后面的有效条目（原实现 `?` 遇到单段行即整体返回 None）
        let text = "not-a-checksum  file.zip\n\
                    \n\
                    e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  file.zip\n";
        assert_eq!(
            extract_checksum(text, "file.zip", false).as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
    }

    #[test]
    fn normalizes_uppercase_hex() {
        let text = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  file.zip\n";
        assert_eq!(
            extract_checksum(text, "file.zip", false).as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
    }

    #[test]
    fn rejects_malformed_lines() {
        assert!(extract_checksum("not-a-checksum  file.zip\n", "file.zip", false).is_none());
        assert!(extract_checksum("abc  file.zip\n", "file.zip", false).is_none());
        assert!(extract_checksum("", "file.zip", false).is_none());
        // 单段但非 64 位 hex：即使允许单段也不能接受
        assert!(extract_checksum("abc\n", "file.zip", true).is_none());
    }

    #[test]
    fn strips_urls_for_user_facing_messages() {
        assert_eq!(
            strip_urls("Source https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/PortableGit-2.47.1.2-64-bit.7z.exe: checksum unavailable (https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/PortableGit-2.47.1.2-64-bit.7z.exe.sha256)"),
            "Source [url]: checksum unavailable ([url])"
        );
        assert_eq!(strip_urls("no url here"), "no url here");
        assert_eq!(strip_urls(""), "");
    }

    #[test]
    fn sha256_hex_is_lowercase() {
        // SHA-256 of empty input — known value.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}