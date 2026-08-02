use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use futures_util::StreamExt;

use crate::{
    build_enriched_path, build_smart_http_client, claude_needs_cmd_wrapper, cli_download_dir,
    find_claude_binary, strip_ansi, app_data_dir, git_download_dir, extract_node_archive,
    find_claude_binary_ordered, find_git_bash, CLI_GCS_BASE, CLI_MIRROR_BASE,
};
use crate::backends;
use crate::commands::cli_resolver;
use crate::commands::session::{encode_project_name, load_tracked_sessions, tracked_sessions_path};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::shell_single_quote;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ── Setup: CLI Detection, Installation & Login ──────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CliStatus {
    pub(crate) installed: bool,
    pub(crate) path: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) git_bash_missing: bool,
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
    let enriched_path = build_enriched_path();
    #[cfg(target_os = "windows")]
    let mut cmd = if claude_needs_cmd_wrapper(&binary) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&binary).arg("plugin");
        c
    } else {
        let mut c = Command::new(&binary);
        c.arg("plugin");
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&binary);
        c.arg("plugin");
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
                        .output()
                } else {
                    Command::new(&path)
                        .arg("--version")
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
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
                                })
                            }
                            None => Ok(CliStatus {
                                installed: false,
                                path: None,
                                version: None,
                                git_bash_missing: false,
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
                            })
                        }
                        None => Ok(CliStatus {
                            installed: false,
                            path: None,
                            version: None,
                            git_bash_missing: false,
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
                                if suspect.exists() {
                                    let _ = std::fs::remove_file(&suspect);
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
                                }),
                                None => Ok(CliStatus {
                                    installed: false,
                                    path: None,
                                    version: None,
                                    git_bash_missing: false,
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
            })
        }
        None => Ok(CliStatus {
            installed: false,
            path: None,
            version: None,
            git_bash_missing: false,
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
                        .output()
                } else {
                    Command::new(&path)
                        .arg("--version")
                        .env("PATH", &enriched_path)
                        .creation_flags(0x08000000)
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
                        });
                    }
                }
            };
            #[cfg(not(target_os = "windows"))]
            let output_result = {
                let fut = Command::new(&path)
                    .arg("--version")
                    .env("PATH", &enriched_path)
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
            })
        }
        None => Ok(CliStatus {
            installed: false,
            path: None,
            version: None,
            git_bash_missing: false,
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
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
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
        install_node_env_inner(&app, china).await.map_err(|e| {
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
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                let check = check_codex_cli().await.unwrap_or(CliStatus {
                    installed: false,
                    version: None,
                    path: None,
                    git_bash_missing: false,
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
    let session_uuid = jsonl_content
        .lines()
        .find_map(|line| {
            let v: serde_json::Value = serde_json::from_str(line).ok()?;
            v.get("sessionId")
                .or_else(|| v.get("session_id"))
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let encoded_cwd = encode_project_name(&cwd);
    eprintln!(
        "[LITTLECLAUDE:export] export_codex_to_claude: cwd={}, encoded={}, jsonl_len={}, uuid={}",
        cwd, encoded_cwd, jsonl_content.len(), session_uuid
    );
    let dir = dirs::home_dir()
        .ok_or("无法获取用户目录")?
        .join(".claude")
        .join("projects")
        .join(&encoded_cwd);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
    let file_path = dir.join(format!("{}.jsonl", session_uuid));
    std::fs::write(&file_path, &jsonl_content).map_err(|e| format!("写入文件失败: {}", e))?;

    // Write origin marker for UI hint
    let origin_path = dir.join(format!("{}.codex-origin", session_uuid));
    std::fs::write(&origin_path, "codex").ok();

    // Register in tracked_sessions.txt
    let track_path = tracked_sessions_path();
    let mut sessions = load_tracked_sessions();
    sessions.insert(session_uuid.clone());
    let content: Vec<String> = sessions.into_iter().collect();
    std::fs::write(&track_path, content.join("\n")).map_err(|e| format!("注册会话失败: {}", e))?;

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
    let file_path = dirs::home_dir()
        .ok_or("无法获取用户目录")?
        .join(".claude")
        .join("projects")
        .join(&project_dir)
        .join(format!("{}.jsonl", session_id));

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
                    .output()
            } else {
                Command::new(&candidate.path)
                    .arg("--version")
                    .env("PATH", &enriched_path)
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(0x08000000)
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
    Ok(home.join(".tokenicode").join("network_env"))
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

/// Install Claude CLI via npm. Supports system npm or local Node.js npm.
/// Install Claude CLI via npm. Supports system npm or local Node.js npm.
/// Uses --prefix to install into app-local directory when using local Node.js.
async fn install_cli_via_npm(app: &AppHandle, china: bool) -> Result<(), String> {
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
    std::fs::create_dir_all(&prefix_dir)
        .map_err(|e| format!("Failed to create npm-global dir: {}", e))?;

    // Use app-local npm cache to avoid EPERM when system cache dir is locked
    // (common on Windows with antivirus or concurrent npm processes).
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
            "@anthropic-ai/claude-code".to_string(),
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
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str)
                .env("PATH", &enriched_path)
                .stdin(Stdio::null());
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                eprintln!("npm install succeeded via {}", registry);
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
                eprintln!("{}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("npm not found or failed to run: {}", e);
                eprintln!("{}", last_err);
                return Err(last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("{}", last_err);
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
    // Only compare if both parsed to the same number of segments
    if va.len() != vb.len() && (va.is_empty() || vb.is_empty()) {
        return false;
    }
    va > vb
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
async fn try_native_cli_update(china: bool) -> Result<String, String> {
    // Skip native binary download for China  --?GCS may be blocked, herear.cn bandwidth too small
    if china {
        return Err("Native binary download skipped for China network".to_string());
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
                        binary_name = bn.to_string();
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
        let mut file =
            std::fs::File::create(&tmp_path).map_err(|e| format!("Cannot create tmp file: {e}"))?;

        use std::io::Write;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
            file.write_all(&chunk)
                .map_err(|e| format!("Write error: {e}"))?;
        }
        drop(file);

        // 5. Verify SHA-256 checksum
        if !expected_checksum.is_empty() {
            use sha2::{Digest, Sha256};
            let data =
                std::fs::read(&tmp_path).map_err(|e| format!("Cannot read tmp file: {e}"))?;
            let actual = format!("{:x}", Sha256::digest(&data));
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
pub async fn update_claude_cli(app: AppHandle) -> Result<String, String> {
    let china = is_china_network().await;

    // Phase 1: Try native binary download (non-China only, GCS CDN)
    match try_native_cli_update(china).await {
        Ok(version) => {
            eprintln!(
                "[update_claude_cli] native binary update success: v{}",
                version
            );
            return Ok(version);
        }
        Err(e) => {
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

    // Fetch target version for post-install verification (herear.cn for China, GCS for others)
    let target_version = {
        let c = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let urls = if china {
            vec![
                format!("{}/latest", CLI_MIRROR_BASE),
                format!("{}/latest", CLI_GCS_BASE),
            ]
        } else {
            vec![format!("{}/latest", CLI_GCS_BASE)]
        };
        let mut ver: Option<String> = None;
        for url in &urls {
            if let Ok(resp) = c.get(url).send().await {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        ver = Some(v);
                        break;
                    }
                }
            }
        }
        ver
    };

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
            "@anthropic-ai/claude-code@latest".to_string(),
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
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };
        #[cfg(not(target_os = "windows"))]
        let result = {
            let mut cmd = Command::new(&npm_path);
            cmd.args(&args_str);
            cmd.env("PATH", &enriched_path).stdin(Stdio::null());
            tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output()).await
        };

        match result {
            Ok(Ok(output)) if output.status.success() => {
                let check = check_claude_cli().await.unwrap_or(CliStatus {
                    installed: false,
                    version: None,
                    path: None,
                    git_bash_missing: false,
                });
                let version = check.version.unwrap_or_else(|| "unknown".to_string());
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

                return Ok(version);
            }
            Ok(Ok(output)) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                last_err = format!(
                    "npm install failed ({}): {}",
                    registry,
                    stderr.chars().take(500).collect::<String>()
                );
                eprintln!("[update_claude_cli] {}", last_err);
            }
            Ok(Err(e)) => {
                last_err = format!("Failed to run npm: {e}");
                eprintln!("[update_claude_cli] {}", last_err);
            }
            Err(_) => {
                last_err = format!("npm install timed out ({})", registry);
                eprintln!("[update_claude_cli] {}", last_err);
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

    let mut latest: Option<String> = None;
    for url in &version_urls {
        if let Ok(resp) = client.get(url).send().await {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        latest = Some(v);
                        break;
                    }
                }
            }
        }
    }
    eprintln!("[check_cli_update] after version URLs, elapsed {:?}, latest={:?}", t0.elapsed(), latest);

    // Final fallback: npm registry (skip in China  --?npm is typically blocked)
    if latest.is_none() && !china {
        if let Ok(resp) = client
            .get("https://registry.npmjs.org/@anthropic-ai/claude-code/latest")
            .header("Accept", "application/json")
            .send()
            .await
        {
            let json: serde_json::Value = resp.json().await.unwrap_or_default();
            latest = json
                .get("version")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
    }
    eprintln!("[check_cli_update] done, total elapsed {:?}, latest={:?}", t0.elapsed(), latest);

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
pub async fn install_claude_cli(app: AppHandle) -> Result<(), String> {
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

    // Phase 1 (Windows only): Ensure git-bash is available
    #[cfg(target_os = "windows")]
    {
        if find_git_bash().is_none() {
            eprintln!("git-bash not found, auto-installing PortableGit...");
            install_git_bash_inner(&app, china).await.map_err(|e| {
                format!(
                    "Failed to install Git for Windows: {}. \
                     Please install Git for Windows manually: https://git-scm.com/downloads/win",
                    e
                )
            })?;
        }

        // If CLI is already installed (only git-bash was missing), skip download phases
        if find_claude_binary().is_some() {
            eprintln!("CLI already installed, git-bash was the only missing dependency");
            finalize_cli_install_paths(&app);
            return Ok(());
        }
    }

    // Phase 2: Ensure npm is available
    let has_npm = is_system_npm_available().await || get_local_node_bin().is_some();

    if !has_npm {
        eprintln!("npm not available, deploying Node.js locally...");
        install_node_env_inner(&app, china).await.map_err(|e| {
            format!(
                "Failed to install Node.js runtime: {}. Please install Node.js manually.",
                e
            )
        })?;
    }

    // Phase 3: Install CLI via npm
    install_cli_via_npm(&app, china)
        .await
        .map_err(|npm_err| format!("CLI installation failed via npm: {}", npm_err))?;

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

/// Directory for npm global installs (--prefix target).
pub(crate) fn npm_global_dir() -> Result<std::path::PathBuf, String> {
    app_data_dir().map(|d| d.join("npm-global"))
}

/// Directory for npm cache (avoids system cache EPERM on Windows).
fn npm_cache_dir() -> Result<std::path::PathBuf, String> {
    app_data_dir().map(|d| d.join("npm-cache"))
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
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let result = {
        let mut cmd = Command::new("npm");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
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
        tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await
    };
    #[cfg(not(target_os = "windows"))]
    let node_result = {
        let mut cmd = Command::new("node");
        cmd.arg("--version")
            .env("PATH", &enriched_path)
            .stdin(Stdio::null());
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
pub async fn install_node_env(app: AppHandle) -> Result<(), String> {
    let china = is_china_network().await;
    install_node_env_inner(&app, china).await
}

async fn install_node_env_inner(app: &AppHandle, china: bool) -> Result<(), String> {
    let (archive_name, ext) = get_node_archive_info()?;
    let filename = format!("{}.{}", archive_name, ext);

    let install_dir = node_download_dir()?;
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

        match download_with_progress(app, &client, url, "node_downloading").await {
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
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes = archive_bytes
        .ok_or_else(|| format!("All Node.js download sources failed: {}", last_err))?;

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
pub(crate) async fn install_git_bash_inner(app: &AppHandle, china: bool) -> Result<(), String> {
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

        match download_with_progress(app, &client, url, "git_downloading").await {
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
                last_err = format!("Source {}: {}", url, e);
                eprintln!("{}", last_err);
            }
        }
    }

    let bytes =
        archive_bytes.ok_or_else(|| format!("All Git download sources failed: {}", last_err))?;

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
    let extract_result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        Command::new(&temp_path)
            .args([&format!("-o{}", install_dir.display()), "-y"])
            .stdin(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output(),
    )
    .await;

    // Clean up the downloaded archive regardless of result
    let _ = std::fs::remove_file(&temp_path);

    match extract_result {
        Ok(Ok(output)) if output.status.success() => {
            eprintln!("PortableGit extraction succeeded");
        }
        Ok(Ok(output)) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "PortableGit extraction failed (exit {}): {}",
                output.status, stderr
            ));
        }
        Ok(Err(e)) => {
            return Err(format!("Failed to run PortableGit extractor: {}", e));
        }
        Err(_) => {
            return Err("PortableGit extraction timed out after 120s".to_string());
        }
    }

    // Verify bash.exe exists
    let bash = install_dir.join("bin").join("bash.exe");
    if !bash.exists() {
        return Err("bash.exe not found after PortableGit extraction".to_string());
    }

    let _ = app.emit(
        "setup:download:progress",
        serde_json::json!({
            "downloaded": 0, "total": 0, "percent": 100, "phase": "git_complete"
        }),
    );

    eprintln!("PortableGit installed to {:?}", install_dir);
    Ok(())
}

/// Download a URL with streaming progress events.
async fn download_with_progress(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    phase: &str,
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
    let mut downloaded: u64 = 0;
    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        bytes.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

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

    Ok(bytes)
}

// ─── Download checksum verification (S9) ────────────────────────────────────

/// Extract the SHA-256 digest for `filename` from a checksum file body.
/// Supports both node SHASUMS256.txt lines ("<hex>  <filename>") and GitHub
/// release ".sha256" lines ("<hex> *<filename>").
fn extract_checksum(text: &str, filename: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let hex = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        if hex.len() == 64
            && hex.chars().all(|c| c.is_ascii_hexdigit())
            && name == filename
        {
            return Some(hex.to_ascii_lowercase());
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
    extract_checksum(&text, filename)
}

/// SHA-256 hex digest of a byte slice (lowercase).
fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(data))
}

#[cfg(test)]
mod checksum_tests {
    use super::*;

    #[test]
    fn parses_shasums_format() {
        let text = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  node-v22.22.0-win-x64.zip\n\
                    deadbeef00000000000000000000000000000000000000000000000000000000  node-v22.22.0-darwin-arm64.tar.gz\n";
        assert_eq!(
            extract_checksum(text, "node-v22.22.0-win-x64.zip").as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert!(extract_checksum(text, "node-v22.22.0-linux-x64.tar.gz").is_none());
    }

    #[test]
    fn parses_github_star_format() {
        let text = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *PortableGit-2.47.1.2-64-bit.7z.exe\n";
        assert_eq!(
            extract_checksum(text, "PortableGit-2.47.1.2-64-bit.7z.exe").as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
    }

    #[test]
    fn normalizes_uppercase_hex() {
        let text = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  file.zip\n";
        assert_eq!(
            extract_checksum(text, "file.zip").as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
    }

    #[test]
    fn rejects_malformed_lines() {
        assert!(extract_checksum("not-a-checksum  file.zip\n", "file.zip").is_none());
        assert!(extract_checksum("abc  file.zip\n", "file.zip").is_none());
        assert!(extract_checksum("", "file.zip").is_none());
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