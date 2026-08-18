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
    // M8 (security): cwd must be an authorized root (registered project /
    // workspace / dialog pick) — a compromised renderer must not be able to
    // run git inside ANY repository on the machine.
    if !crate::commands::files::path_is_authorized(cwd_path) {
        return Err(format!("Git is not authorized in this directory: {}", cwd));
    }

    // #14 (security): destructive variants get a second-level allowlist.
    if subcmd == "stash" {
        let variant = args.get(1).map(|s| s.as_str()).unwrap_or("");
        if !matches!(variant, "list" | "show") {
            return Err("Only `git stash list/show` is allowed".to_string());
        }
    }
    if subcmd == "checkout" {
        for arg in &args[1..] {
            let lower = arg.to_lowercase();
            if lower == "-f" || lower == "--force" || lower == "-b" || lower.starts_with("-b") {
                return Err(format!("Git checkout flag '{}' not allowed", arg));
            }
            // R10 (security): the pathspec-restore form (`checkout <ref> -- <paths>`)
            // runs the repo's filter.*.smudge/clean drivers on every restored
            // file — a malicious .git/config + .gitattributes turns that into
            // arbitrary command execution. Only branch/commit-level checkout
            // stays allowed.
            if arg == "--" {
                return Err(
                    "Git checkout with pathspec restore is not allowed".to_string(),
                );
            }
        }
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

    // #14/M8 (security): a malicious repo's .git/config can define
    // diff.external / textconv drivers / fsmonitor / hooks that EXECUTE when
    // status/diff/show/checkout run. Neutralize the config-driven vectors:
    // flags disable external diff + textconv; env overrides (command-line
    // precedence, beat repo config) kill fsmonitor and redirect hooks to a
    // nonexistent dir. GIT_CONFIG_NOSYSTEM also skips system-level config.
    let mut exec_args: Vec<String> = Vec::with_capacity(args.len() + 2);
    exec_args.push(args[0].clone());
    if matches!(subcmd, "diff" | "show" | "log") {
        exec_args.push("--no-ext-diff".to_string());
        exec_args.push("--no-textconv".to_string());
    }
    exec_args.extend(args[1..].iter().cloned());

    let mut cmd = Command::new(git_bin);
    cmd.args(&exec_args).current_dir(&cwd);
    cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    cmd.env("GIT_CONFIG_COUNT", "2");
    cmd.env("GIT_CONFIG_KEY_0", "core.fsmonitor");
    cmd.env("GIT_CONFIG_VALUE_0", "false");
    cmd.env("GIT_CONFIG_KEY_1", "core.hooksPath");
    cmd.env(
        "GIT_CONFIG_VALUE_1",
        std::env::temp_dir()
            .join("tokenicode")
            .join("no-hooks")
            .to_string_lossy()
            .as_ref(),
    );
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    // timeout() 只放弃等待 future，不会终止已 spawn 的子进程——
    // kill_on_drop(true) 确保超时后子进程被终止，UI 不会被 hung git 阻塞。
    cmd.kill_on_drop(true);

    // #13 (perf/safety): output() buffered the ENTIRE stdout before the 4MB
    // cap applied — a multi-GB diff was read fully into memory first. Read
    // through take() so the cap is enforced WHILE streaming; stderr is
    // drained concurrently (bounded) so neither pipe can deadlock us.
    const MAX_STDOUT_BYTES: u64 = 4 * 1024 * 1024;
    const MAX_STDERR_BYTES: u64 = 1024 * 1024;
    use tokio::io::AsyncReadExt;
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    let mut stdout_r = child.stdout.take().expect("stdout piped");
    let mut stderr_r = child.stderr.take().expect("stderr piped");
    let mut out_buf: Vec<u8> = Vec::new();
    let mut err_buf: Vec<u8> = Vec::new();
    let read_result = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let mut out_limited = (&mut stdout_r).take(MAX_STDOUT_BYTES + 1);
        let mut err_limited = (&mut stderr_r).take(MAX_STDERR_BYTES + 1);
        tokio::join!(
            out_limited.read_to_end(&mut out_buf),
            err_limited.read_to_end(&mut err_buf),
            child.wait()
        )
    })
    .await
    .map_err(|_| format!("git {} timed out after 60s", subcmd))?;
    let (_, _, wait_res) = read_result;
    let status = wait_res.map_err(|e| format!("Failed to wait for git: {}", e))?;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&err_buf).to_string();
        return Err(format!("git {} failed: {}", subcmd, stderr));
    }

    // L7: cap applied during the read above; trim the +1 overflow byte here
    // (from_utf8_lossy tolerates cutting mid-char).
    if out_buf.len() > MAX_STDOUT_BYTES as usize {
        out_buf.truncate(MAX_STDOUT_BYTES as usize);
    }
    Ok(String::from_utf8_lossy(&out_buf).to_string())
}
