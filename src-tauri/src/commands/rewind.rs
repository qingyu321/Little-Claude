use crate::{build_enriched_path, find_claude_binary};

#[tauri::command]
pub async fn rewind_files(
    session_id: String,
    checkpoint_uuid: String,
    cwd: String,
) -> Result<String, String> {
    // P1-1: Validate session_id and checkpoint_uuid look like UUIDs (hex + hyphens only)
    fn is_uuid_like(s: &str) -> bool {
        s.len() >= 32 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    }
    if !is_uuid_like(&session_id) {
        return Err(format!("Invalid session_id format: {}", session_id));
    }
    if !is_uuid_like(&checkpoint_uuid) {
        return Err(format!(
            "Invalid checkpoint_uuid format: {}",
            checkpoint_uuid
        ));
    }

    // M10 (security): the CLI is spawned with cwd as its working directory —
    // refuse anything that is not an existing directory (spawn would otherwise
    // fail silently or operate in an unintended location).
    if cwd.is_empty() || !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("无效的 cwd: {} — 不是存在的目录", cwd));
    }

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

    let mut rewind_cmd = tokio::process::Command::new(&claude_bin);
    rewind_cmd
        .args(&["--resume", &session_id, "--rewind-files", &checkpoint_uuid])
        .current_dir(&cwd)
        .env("PATH", &enriched_path)
        .env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1")
        .env_remove("CLAUDECODE");
    // Disable MSYS2 auto path conversion on Windows (Chinese path fix)
    #[cfg(target_os = "windows")]
    rewind_cmd
        .env("MSYS_NO_PATHCONV", "1")
        .env("MSYS2_ARG_CONV_EXCL", "*");

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        rewind_cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // kill_on_drop: timeout() 只放弃等待，不终止已 spawn 的
            // claude --rewind-files 进程；超时后残留进程会继续占用
            // 会话文件锁。
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "rewind_files timed out after 120s".to_string())?
    .map_err(|e| format!("Failed to run claude --rewind-files: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("rewind_files failed: {}", stderr))
    }
}
