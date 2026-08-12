#[cfg(target_os = "macos")]
use std::process::Stdio;
use tokio::process::Command;

/// Resolve git binary path on macOS without triggering Xcode CLT install popup.
/// On non-macOS, this is unused — the caller uses "git" directly.
#[cfg(target_os = "macos")]
fn resolve_git_binary() -> Option<&'static str> {
    static GIT_BIN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    GIT_BIN
        .get_or_init(|| {
            // Check if Xcode CLT is installed (xcode-select -p does NOT trigger popup)
            let clt_check = std::process::Command::new("xcode-select")
                .arg("-p")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if let Ok(status) = clt_check {
                if status.success() {
                    // CLT installed -- /usr/bin/git works, use bare "git" to respect PATH order
                    return Some("git".to_string());
                }
            }

            // CLT not installed -- scan known third-party git install locations.
            // IMPORTANT: Do NOT include /usr/bin/git here -- that's the shim that triggers the popup.
            let candidates = [
                "/opt/homebrew/bin/git",                 // Homebrew (Apple Silicon)
                "/usr/local/bin/git",                    // Homebrew (Intel) or manual install
                "/opt/local/bin/git",                    // MacPorts
                "/nix/var/nix/profiles/default/bin/git", // Nix
            ];
            for path in &candidates {
                if std::path::Path::new(path).exists() {
                    eprintln!("resolve_git_binary: CLT not installed, using {}", path);
                    return Some(path.to_string());
                }
            }

            eprintln!("resolve_git_binary: no git found (CLT not installed, no third-party git)");
            None
        })
        .as_deref()
}

/// Run a git command in a specific working directory and return stdout.
/// Only allows safe, read-or-restore git operations.
#[tauri::command]
pub async fn run_git_command(cwd: String, args: Vec<String>) -> Result<String, String> {
    // Allowlist: only safe git subcommands
    let allowed_subcommands = [
        "status",
        "diff",
        "log",
        "show",
        "stash",
        "checkout",
        "rev-parse",
        "hash-object",
        "cat-file",
    ];
    let subcmd = args.first().map(|s| s.as_str()).unwrap_or("");
    if !allowed_subcommands.contains(&subcmd) {
        return Err(format!("Git subcommand '{}' not allowed", subcmd));
    }

    // P1-1: Reject null bytes in args (could truncate strings in C-level APIs)
    for arg in &args {
        if arg.contains('\0') {
            return Err("Arguments must not contain null bytes".to_string());
        }
    }

    // P1-1: Validate cwd is an existing directory
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Working directory does not exist: {}", cwd));
    }

    // P1-1: Reject dangerous git flags that could enable command execution or
    // arbitrary file reads/writes.
    // Short options (-c config override, -O orderfile): git accepts glued
    // values (`-cdiff.external=x`), so any prefix match is rejected — an
    // exact-equality check can be bypassed by gluing.
    // Long options: exact or `=`-form only, so `--output` alone (which takes a
    // filename as the *next* arg) is also blocked.
    let dangerous_short = ["-c", "-o"];
    let dangerous_long = [
        "--config",
        "--exec",
        "--upload-pack",
        "--receive-pack",
        "--output",
        "--pathspec-from-file",
        "--order-file",
        "--ext-diff",
        // `git diff --no-index <a> <b>` prints the contents of ANY two existing
        // files (unified diff) and works outside a git repo — this bypassed the
        // system-dir blacklist and the 10MiB cap, i.e. arbitrary file reads.
        "--no-index",
    ];
    for arg in &args[1..] {
        let lower = arg.to_lowercase();
        for prefix in &dangerous_short {
            if lower.starts_with(prefix) {
                return Err(format!("Git flag '{}' not allowed", arg));
            }
        }
        for prefix in &dangerous_long {
            if lower == *prefix || lower.starts_with(&format!("{}=", prefix)) {
                return Err(format!("Git flag '{}' not allowed", arg));
            }
        }
    }

    // On macOS, resolve git binary without triggering Xcode CLT popup
    #[cfg(target_os = "macos")]
    let git_bin = resolve_git_binary()
        .ok_or_else(|| "git not available (no Xcode CLT or Homebrew git found)".to_string())?;
    #[cfg(not(target_os = "macos"))]
    let git_bin = "git";

    let mut cmd = Command::new(git_bin);
    cmd.args(&args).current_dir(&cwd);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    // timeout() 只放弃等待 future，不会终止已 spawn 的子进程——output()
    // 默认 kill_on_drop=false，超时后 git 会继续在后台运行（网络、凭证
    // 提示等场景会残留进程并锁住工作目录）。kill_on_drop(true) 确保超时
    // 后子进程被终止，UI 不会被 hung git 阻塞。
    cmd.kill_on_drop(true);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        cmd.output(),
    )
    .await
    .map_err(|_| format!("git {} timed out after 60s", subcmd))?
    .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("git {} failed: {}", subcmd, stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
