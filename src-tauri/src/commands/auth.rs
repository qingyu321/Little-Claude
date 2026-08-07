use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use std::process::Stdio;

use crate::{build_enriched_path, find_claude_binary, strip_ansi};
#[cfg(target_os = "windows")]
use crate::claude_needs_cmd_wrapper;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::shell_single_quote;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;


/// Run a Claude CLI subcommand (e.g. `claude doctor`) as a one-shot process
/// and return its combined stdout/stderr output.
#[tauri::command]
pub async fn run_claude_command(subcommand: String, cwd: Option<String>) -> Result<String, String> {
    // P1-1: Allowlist safe subcommands
    let allowed = ["doctor", "--version", "config", "mcp"];
    if !allowed.contains(&subcommand.as_str()) {
        return Err(format!("Claude subcommand '{}' not allowed", subcommand));
    }

    let binary = find_claude_binary().ok_or_else(|| "Claude CLI not found".to_string())?;
    let enriched_path = build_enriched_path();
    #[cfg(target_os = "windows")]
    let mut cmd = if claude_needs_cmd_wrapper(&binary) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&binary).arg(&subcommand);
        c
    } else {
        let mut c = Command::new(&binary);
        c.arg(&subcommand);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&binary);
        c.arg(&subcommand);
        c
    };
    cmd.env("PATH", &enriched_path);
    cmd.env_remove("CLAUDECODE");
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
        // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
        cmd.env("MSYS_NO_PATHCONV", "1")
            .env("MSYS2_ARG_CONV_EXCL", "*");
    }
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    // timeout() 只放弃等待，不会终止已 spawn 的子进程；kill_on_drop(true)
    // 确保 30s 超时后 claude 子进程被终止（残留进程会一直占着锁/输出）。
    cmd.kill_on_drop(true);
    let future = cmd.output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), future)
        .await
        .map_err(|_| format!("claude {} timed out after 30s", subcommand))?
        .map_err(|e| format!("Failed to run claude {}: {}", subcommand, e))?;
    let stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        let combined = if stderr.is_empty() {
            stdout
        } else {
            format!("{}\n{}", stdout, stderr)
        };
        Ok(combined.trim().to_string())
    } else {
        let combined = format!("{}\n{}", stdout, stderr);
        Err(combined.trim().to_string())
    }
}


/// Start the Claude OAuth login flow by running `claude login`.
#[tauri::command]
pub async fn start_claude_login(app: AppHandle) -> Result<(), String> {
    fn emit_to_frontend(app: &AppHandle, event: &str, payload: Value) -> Result<(), String> {
        if let Err(e1) = app.emit_to("main", event, payload.clone()) {
            if let Err(e2) = app.emit(event, payload) {
                return Err(format!("emit_to failed: {}, emit failed: {}", e1, e2));
            }
        }
        Ok(())
    }

    let claude_bin = find_claude_binary().ok_or_else(|| {
        "Claude CLI not found. Please install it first via the Setup Wizard.".to_string()
    })?;
    let enriched_path = build_enriched_path();

    // On Windows, .cmd/.bat files must be launched via cmd /C (same logic as start_session)
    #[cfg(target_os = "windows")]
    let mut child = {
        let needs_cmd = claude_bin.ends_with(".cmd")
            || claude_bin.ends_with(".bat")
            || (!claude_bin.contains('\\')
                && !claude_bin.contains('/')
                && !claude_bin.contains('.'));
        let mut cmd = if needs_cmd {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&claude_bin);
            c
        } else {
            Command::new(&claude_bin)
        };
        cmd.args(["login"])
            .env("PATH", &enriched_path)
            .env_remove("CLAUDECODE")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Failed to start login (tried '{}'): {}", claude_bin, e))?
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = Command::new(&claude_bin)
        .args(["login"])
        .env("PATH", &enriched_path)
        .env_remove("CLAUDECODE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start login (tried '{}'): {}", claude_bin, e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app1 = app.clone();
    let stdout_handle = tokio::spawn(async move {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = emit_to_frontend(
                    &app1,
                    "setup:login:output",
                    serde_json::json!({ "stream": "stdout", "line": line }),
                );
            }
        }
    });

    let app2 = app.clone();
    let stderr_handle = tokio::spawn(async move {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = emit_to_frontend(
                    &app2,
                    "setup:login:output",
                    serde_json::json!({ "stream": "stderr", "line": line }),
                );
            }
        }
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Login process error: {}", e))?;

    let _ = stdout_handle.await;
    let _ = stderr_handle.await;

    let code = status.code().unwrap_or(-1);
    let _ = app.emit_to(
        "main",
        "setup:login:exit",
        serde_json::json!({ "code": code }),
    );

    if code != 0 {
        return Err(format!("Login exited with code {}", code));
    }
    Ok(())
}


#[derive(Debug, Serialize, Deserialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub unknown: bool,
}


/// Check whether the Claude CLI is authenticated by running a lightweight check.
#[tauri::command]
pub async fn check_claude_auth() -> Result<AuthStatus, String> {
    let claude_bin = find_claude_binary().unwrap_or_else(|| {
        #[cfg(target_os = "windows")]
        {
            "claude.cmd".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            "claude".to_string()
        }
    });
    let enriched_path = build_enriched_path();

    // First try a quick credential file check (instant, no subprocess)
    if let Some(home) = dirs::home_dir() {
        let cred_path = home.join(".claude").join("credentials.json");
        if cred_path.exists() {
            // Parse JSON and check for actual token fields
            if let Ok(content) = std::fs::read_to_string(&cred_path) {
                if let Ok(json) = serde_json::from_str::<Value>(&content) {
                    let has_token = ["claudeAiOAuthToken", "accessToken", "token", "apiKey"]
                        .iter()
                        .any(|key| {
                            json.get(key)
                                .and_then(|v| v.as_str())
                                .map(|s| !s.is_empty())
                                .unwrap_or(false)
                        });
                    if has_token {
                        return Ok(AuthStatus {
                            authenticated: true,
                            unknown: false,
                        });
                    }
                }
                // JSON invalid or no token found  --?fall through to claude doctor
            }
        }
        // Also check .claude.json (older format)
        let alt_path = std::path::Path::new(&home).join(".claude.json");
        if alt_path.exists() {
            return Ok(AuthStatus {
                authenticated: true,
                unknown: false,
            });
        }
    }

    // Fallback: run `claude doctor` with a shorter timeout
    #[cfg(target_os = "windows")]
    let mut cmd = if claude_needs_cmd_wrapper(&claude_bin) {
        let mut c = Command::new("cmd");
        c.args(["/C", &claude_bin, "doctor"]);
        c
    } else {
        let mut c = Command::new(&claude_bin);
        c.arg("doctor");
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&claude_bin);
        c.arg("doctor");
        c
    };
    cmd.env("PATH", &enriched_path).env_remove("CLAUDECODE");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    // kill_on_drop: 8s 超时只放弃等待，须终止 claude doctor 子进程（同
    // run_claude_command 的 30s 处理，防止超时后残留进程继续运行）。
    cmd.kill_on_drop(true);
    let result = tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            let combined = format!("{} {}", stdout, stderr);

            let has_auth_issue = combined.contains("not authenticated")
                || combined.contains("not logged in")
                || combined.contains("login required")
                || combined.contains("unauthorized")
                || combined.contains("no api key");

            Ok(AuthStatus {
                authenticated: output.status.success() && !has_auth_issue,
                unknown: false,
            })
        }
        Ok(Err(e)) => Err(format!("Failed to run auth check: {}", e)),
        Err(_) => {
            // Timeout  --?cannot determine auth status
            Ok(AuthStatus {
                authenticated: false,
                unknown: true,
            })
        }
    }
}


/// Open a native terminal window to run `claude login`.
/// On macOS: uses osascript to open Terminal.app.
/// On Linux: tries common terminal emulators.
/// On Windows: opens cmd.exe with enriched PATH.
#[tauri::command]
pub async fn open_terminal_login() -> Result<(), String> {
    let claude_bin = find_claude_binary().ok_or_else(|| {
        "Claude CLI not found. Please install it first via the Setup Wizard.".to_string()
    })?;

    #[cfg(target_os = "macos")]
    {
        let command = format!("{} login", shell_single_quote(&claude_bin));
        let script = format!(
            r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators in order of preference
        let xterm_cmd = format!("{} login", shell_single_quote(&claude_bin));
        let terminals = [
            ("gnome-terminal", vec!["--", &claude_bin, "login"]),
            ("konsole", vec!["-e", &claude_bin, "login"]),
            ("xterm", vec!["-e", xterm_cmd.as_str()]),
        ];
        let mut opened = false;
        for (term, args) in &terminals {
            if std::process::Command::new(term)
                .args(args.iter().copied())
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            return Err("No supported terminal emulator found".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Spawn cmd /k with CREATE_NEW_CONSOLE to open a visible terminal window.
        // This avoids the `start` command's tricky quoting rules.
        let enriched_path = build_enriched_path();
        std::process::Command::new("cmd")
            .arg("/k")
            .arg(&format!("\"{}\" login", claude_bin))
            .env("PATH", &enriched_path)
            .creation_flags(0x00000010) // CREATE_NEW_CONSOLE
            .spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
    }

    Ok(())
}

