//! CLI binary discovery, diagnostics, and lifecycle management.
//!
//! Priority order (highest → lowest):
//!   Tier 0 · Official     — Claude Desktop bundled, official installer (~/.claude/local)
//!   Tier 1 · AppLocal     — app self-deployed (native binary or npm --prefix)
//!   Tier 2 · System       — npm global, Homebrew, system PATH installs
//!   Tier 3 · VersionMgr   — nvm, volta, fnm, bun
//!   Tier 4 · Dynamic      — Process PATH, login shell PATH, which/where fallback
//!
//! Search is per-directory: within each dir, native binary beats shebang script,
//! but directory (tier) order is always the final priority.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─── Public Types ──────────────────────────────────────────

/// Source tier for a discovered CLI binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CliSource {
    Official = 0,
    // The app's own installs take precedence over system globals (an in-app
    // CLI update must not be shadowed by an older system copy). Listed before
    // System so tier ordering matches collect_tiered_dirs' emission order.
    AppLocal = 1,
    System = 2,
    VersionManager = 3,
    Dynamic = 4,
}

impl std::fmt::Display for CliSource {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Official => write!(f, "Official"),
            Self::System => write!(f, "System"),
            Self::AppLocal => write!(f, "App-local"),
            Self::VersionManager => write!(f, "Version Manager"),
            Self::Dynamic => write!(f, "Dynamic"),
        }
    }
}

/// A discovered CLI binary with metadata for diagnostics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCandidate {
    pub path: String,
    pub source: CliSource,
    pub is_native: bool,
    /// Filled async by the diagnose Tauri command, not by scan_all().
    pub version: Option<String>,
    /// Human-readable issues: "broken symlink", "shebang interpreter not found", etc.
    pub issues: Vec<String>,
}

/// Result of a cleanup operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed: Vec<String>,
    pub skipped: Vec<CleanupSkipped>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSkipped {
    pub path: String,
    pub reason: String,
}

// ─── Internal types ────────────────────────────────────────

#[derive(Debug, Clone)]
struct TieredDir {
    path: String,
    source: CliSource,
}

// ─── Binary validation ─────────────────────────────────────

/// Check if a file is a native binary (Mach-O, PE, ELF — NOT shebang scripts).
pub fn is_native_binary(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(mut f) = std::fs::File::open(path) {
            use std::io::Read;
            let mut magic = [0u8; 2];
            if f.read_exact(&mut magic).is_ok() {
                return magic == [0x4D, 0x5A]; // MZ (PE header)
            }
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(metadata) = std::fs::metadata(path) else {
            return false;
        };
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
        if let Ok(mut f) = std::fs::File::open(path) {
            use std::io::Read;
            let mut magic = [0u8; 4];
            if f.read_exact(&mut magic).is_ok() {
                return matches!(
                    magic,
                    [0xCF, 0xFA, 0xED, 0xFE]   // Mach-O 64-bit LE
                    | [0xCE, 0xFA, 0xED, 0xFE]  // Mach-O 32-bit LE
                    | [0xFE, 0xED, 0xFA, 0xCF]  // Mach-O 64-bit BE
                    | [0xFE, 0xED, 0xFA, 0xCE]  // Mach-O 32-bit BE
                    | [0xCA, 0xFE, 0xBA, 0xBE]  // Universal/fat binary
                    | [0x7F, 0x45, 0x4C, 0x46] // ELF
                );
            }
        }
        false
    }
}

/// Validate that a file is a real, launchable executable.
pub fn is_valid_executable(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        // Script wrappers (.cmd, .bat, .ps1) are valid if they exist
        if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if matches!(ext_lower.as_str(), "cmd" | "bat" | "ps1") {
                return true;
            }
        }
        // Binary executables — check MZ magic bytes (PE header)
        if let Ok(mut f) = std::fs::File::open(path) {
            use std::io::Read;
            let mut magic = [0u8; 2];
            if f.read_exact(&mut magic).is_ok() {
                return magic == [0x4D, 0x5A];
            }
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(metadata) = std::fs::metadata(path) else {
            return false;
        };
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
        if let Ok(mut f) = std::fs::File::open(path) {
            use std::io::Read;
            let mut magic = [0u8; 4];
            if f.read_exact(&mut magic).is_ok() {
                // Native binary
                if matches!(
                    magic,
                    [0xCF, 0xFA, 0xED, 0xFE]
                        | [0xCE, 0xFA, 0xED, 0xFE]
                        | [0xFE, 0xED, 0xFA, 0xCF]
                        | [0xFE, 0xED, 0xFA, 0xCE]
                        | [0xCA, 0xFE, 0xBA, 0xBE]
                        | [0x7F, 0x45, 0x4C, 0x46]
                ) {
                    return true;
                }
                // Shebang script — verify the interpreter exists
                if magic[0] == 0x23 && magic[1] == 0x21 {
                    use std::io::{BufRead, BufReader, Seek, SeekFrom};
                    let _ = f.seek(SeekFrom::Start(0));
                    let mut first_line = String::new();
                    if BufReader::new(&f).read_line(&mut first_line).is_ok() {
                        let shebang = first_line.trim_start_matches("#!").trim();
                        let interpreter = shebang.split_whitespace().next().unwrap_or("");
                        if !interpreter.is_empty() && Path::new(interpreter).exists() {
                            return true;
                        }
                        eprintln!(
                            "[cli_resolver] shebang interpreter '{}' not found, skipping {:?}",
                            interpreter, path
                        );
                    }
                    return false;
                }
            }
        }
        false
    }
}

/// Search a versioned directory for the newest version containing the given binary name.
fn find_newest_version_bin(base_dir: &Path, bin_name: &str) -> Option<String> {
    if !base_dir.exists() {
        return None;
    }
    if let Ok(entries) = std::fs::read_dir(base_dir) {
        let mut versions: Vec<_> = entries.flatten().filter(|e| e.path().is_dir()).collect();
        versions.sort_by(|a, b| {
            let parse = |name: &std::ffi::OsStr| -> Vec<u64> {
                name.to_string_lossy()
                    .split('.')
                    .filter_map(|s| s.parse::<u64>().ok())
                    .collect()
            };
            parse(&b.file_name()).cmp(&parse(&a.file_name()))
        });
        for entry in &versions {
            let bin = entry.path().join(bin_name);
            if is_valid_executable(&bin) {
                return Some(bin.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Detect shebang issues for diagnostics: checks if `#!/usr/bin/env X`
/// can actually resolve X on the given PATH.
#[cfg(not(target_os = "windows"))]
fn shebang_issues(path: &Path, enriched_path: &str) -> Vec<String> {
    let mut issues = Vec::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::{BufRead, BufReader, Read};
        let mut magic = [0u8; 2];
        if f.read_exact(&mut magic).is_ok() && magic == [0x23, 0x21] {
            use std::io::Seek;
            let _ = f.seek(std::io::SeekFrom::Start(0));
            let mut first_line = String::new();
            if BufReader::new(&f).read_line(&mut first_line).is_ok() {
                let shebang = first_line.trim_start_matches("#!").trim();
                let parts: Vec<&str> = shebang.split_whitespace().collect();
                // #!/usr/bin/env node → check if `node` resolves on enriched PATH
                if parts.first() == Some(&"/usr/bin/env") {
                    if let Some(arg) = parts.get(1) {
                        let found = std::process::Command::new("which")
                            .arg(arg)
                            .env("PATH", enriched_path)
                            .stdin(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .output()
                            .map(|o| o.status.success())
                            .unwrap_or(false);
                        if !found {
                            issues.push(format!(
                                "shebang uses '{}' but '{}' not found on spawn PATH",
                                shebang, arg
                            ));
                        }
                    }
                }
            }
        }
    }
    issues
}

// ─── Subprocess with timeout ───────────────────────────────

/// Run a command with a timeout. Returns stdout on success, empty string on timeout/failure.
fn cmd_with_timeout(cmd: &str, args: &[&str], timeout_secs: u64) -> String {
    #[cfg(target_os = "windows")]
    let mut child = match std::process::Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    #[cfg(not(target_os = "windows"))]
    let mut child = match std::process::Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    let mut buf = String::new();
                    if let Some(mut stdout) = child.stdout.take() {
                        use std::io::Read;
                        let _ = stdout.read_to_string(&mut buf);
                    }
                    return buf.trim().to_string();
                }
                return String::new();
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!(
                        "[cli_resolver] cmd_with_timeout: '{}' timed out ({}s)",
                        cmd, timeout_secs
                    );
                    return String::new();
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => return String::new(),
        }
    }
}

// ─── Tier collection ───────────────────────────────────────

/// Process-lifetime cache for the tier scan. The scan spawns
/// `cmd /C where` / `cmd /C npm root -g` subprocesses and stats dozens of
/// directories — ~0.5-1.5s on Windows — and runs on EVERY session start,
/// rewind, title generation and check_claude_cli. CLI locations only change
/// through this app's own install/update/delete flows, all of which call
/// invalidate_cli_cache(); re-scanning on every call was blocking tokio
/// workers and stalling concurrent sessions' stream reads.
static TIER_DIRS_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<Vec<TieredDir>>>> =
    std::sync::OnceLock::new();

/// Invalidate the tier-scan cache — call after install/update/delete/cleanup.
pub fn invalidate_cli_cache() {
    if let Some(m) = TIER_DIRS_CACHE.get() {
        if let Ok(mut guard) = m.lock() {
            *guard = None;
        }
    }
}

fn collect_tiered_dirs() -> Vec<TieredDir> {
    let cell = TIER_DIRS_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dirs) = &*guard {
        return dirs.clone();
    }
    let dirs = collect_tiered_dirs_inner();
    *guard = Some(dirs.clone());
    dirs
}

/// Uncached scan — kept as a separate function so the pure logic stays
/// testable (tests call the cached entry point, which seeds from this).
fn collect_tiered_dirs_inner() -> Vec<TieredDir> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |path: String, source: CliSource| {
        if !path.is_empty() && seen.insert(path.clone()) {
            dirs.push(TieredDir { path, source });
        }
    };

    #[cfg(target_os = "windows")]
    let bin_name = "claude.exe";
    #[cfg(not(target_os = "windows"))]
    let bin_name = "claude";

    if let Some(home) = dirs::home_dir() {
        // ── Tier 0: Official ───────────────────────────────

        // Claude Desktop bundled CLI (versioned dirs — newest version)
        #[cfg(target_os = "macos")]
        {
            let vdir = home.join("Library/Application Support/Claude/claude-code");
            if let Some(bin) = find_newest_version_bin(&vdir, bin_name) {
                if let Some(p) = Path::new(&bin).parent() {
                    push(p.to_string_lossy().to_string(), CliSource::Official);
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            for base_fn in [dirs::data_local_dir, dirs::data_dir] {
                if let Some(base) = base_fn() {
                    let vdir = base.join("Claude").join("claude-code");
                    if let Some(bin) = find_newest_version_bin(&vdir, bin_name) {
                        if let Some(p) = Path::new(&bin).parent() {
                            push(p.to_string_lossy().to_string(), CliSource::Official);
                        }
                    }
                }
            }
        }
        #[cfg(target_os = "linux")]
        if let Some(data_dir) = dirs::data_dir() {
            let vdir = data_dir.join("Claude").join("claude-code");
            if let Some(bin) = find_newest_version_bin(&vdir, bin_name) {
                if let Some(p) = Path::new(&bin).parent() {
                    push(p.to_string_lossy().to_string(), CliSource::Official);
                }
            }
        }

        // Official native installer path
        #[cfg(not(target_os = "windows"))]
        push(
            home.join(".claude/local").to_string_lossy().to_string(),
            CliSource::Official,
        );
        #[cfg(target_os = "windows")]
        push(
            home.join(".claude\\local").to_string_lossy().to_string(),
            CliSource::Official,
        );

        // ── Tier 1: AppLocal (self-managed) ────────────────
        // The app's own installs take precedence over system globals — otherwise
        // an in-app CLI update would always be shadowed by an older system copy
        // (e.g. stale npm-global in AppData/Roaming/npm).

        if let Some(cli_dir) = crate::cli_download_dir() {
            push(cli_dir.to_string_lossy().to_string(), CliSource::AppLocal);
        }
        if let Some(npm_bin) = crate::commands::cli_manage::get_npm_global_bin() {
            push(npm_bin.to_string_lossy().to_string(), CliSource::AppLocal);
        }

        // ── Tier 2: System ─────────────────────────────────

        #[cfg(target_os = "windows")]
        {
            if let Some(app_data) = dirs::data_dir() {
                push(
                    app_data.join("npm").to_string_lossy().to_string(),
                    CliSource::System,
                );
            }
            if let Some(local_data) = dirs::data_local_dir() {
                push(
                    local_data
                        .join("Programs\\claude-code")
                        .to_string_lossy()
                        .to_string(),
                    CliSource::System,
                );
            }
            push(
                home.join("scoop\\shims").to_string_lossy().to_string(),
                CliSource::System,
            );
            push(
                home.join(".cargo\\bin").to_string_lossy().to_string(),
                CliSource::System,
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            push(
                home.join(".local/bin").to_string_lossy().to_string(),
                CliSource::System,
            );
            push(
                home.join(".npm-global/bin").to_string_lossy().to_string(),
                CliSource::System,
            );
            push(
                home.join(".cargo/bin").to_string_lossy().to_string(),
                CliSource::System,
            );
        }
        // System-wide paths
        #[cfg(not(target_os = "windows"))]
        {
            push("/usr/local/bin".to_string(), CliSource::System);
            push("/opt/homebrew/bin".to_string(), CliSource::System);
        }
        // npm root -g derived bin directory (3s timeout to avoid blocking)
        #[cfg(not(target_os = "windows"))]
        {
            let root = cmd_with_timeout("npm", &["root", "-g"], 3);
            if !root.is_empty() {
                if let Some(lib_dir) = Path::new(&root).parent() {
                    let npm_bin = lib_dir.join("bin");
                    if npm_bin.exists() {
                        push(npm_bin.to_string_lossy().to_string(), CliSource::System);
                    }
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            let root = cmd_with_timeout("cmd", &["/C", "npm", "root", "-g"], 3);
            if !root.is_empty() {
                if let Some(lib_dir) = Path::new(&root).parent() {
                    push(lib_dir.to_string_lossy().to_string(), CliSource::System);
                }
            }
        }

        // ── Tier 3: Version Managers ───────────────────────

        #[cfg(target_os = "windows")]
        {
            push(
                home.join(".volta\\bin").to_string_lossy().to_string(),
                CliSource::VersionManager,
            );
            push(
                home.join(".bun\\bin").to_string_lossy().to_string(),
                CliSource::VersionManager,
            );
            // nvm-windows
            let nvm_dir = std::env::var("NVM_HOME")
                .map(PathBuf::from)
                .or_else(|_| dirs::config_dir().map(|d| d.join("nvm")).ok_or(()))
                .ok()
                .unwrap_or_else(|| home.join("AppData\\Roaming\\nvm"));
            if let Some(bin) = find_newest_version_bin(&nvm_dir, bin_name) {
                if let Some(p) = Path::new(&bin).parent() {
                    push(p.to_string_lossy().to_string(), CliSource::VersionManager);
                }
            }
            // fnm on Windows
            let fnm_default = home.join(".fnm\\aliases\\default");
            if fnm_default.exists() {
                push(
                    fnm_default.to_string_lossy().to_string(),
                    CliSource::VersionManager,
                );
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            push(
                home.join(".volta/bin").to_string_lossy().to_string(),
                CliSource::VersionManager,
            );
            push(
                home.join(".bun/bin").to_string_lossy().to_string(),
                CliSource::VersionManager,
            );
            // fnm
            let fnm_bin = home.join(".fnm/aliases/default/bin");
            if fnm_bin.exists() {
                push(
                    fnm_bin.to_string_lossy().to_string(),
                    CliSource::VersionManager,
                );
            }
            // nvm — scan for newest version
            let nvm_dir = std::env::var("NVM_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| home.join(".nvm"));
            let nvm_versions = nvm_dir.join("versions/node");
            if nvm_versions.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    let mut version_dirs: Vec<PathBuf> = entries
                        .flatten()
                        .filter(|e| e.path().is_dir())
                        .map(|e| e.path())
                        .collect();
                    version_dirs.sort_by(|a, b| {
                        let parse_ver = |p: &Path| -> (u32, u32, u32) {
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
                        let bin_dir = latest.join("bin");
                        if bin_dir.join(bin_name).exists() {
                            push(
                                bin_dir.to_string_lossy().to_string(),
                                CliSource::VersionManager,
                            );
                        }
                    }
                }
            }
        }
    }

    // ── Tier 4: Dynamic ────────────────────────────────

    // Current process PATH
    let sep = if cfg!(windows) { ';' } else { ':' };
    for entry in std::env::var("PATH").unwrap_or_default().split(sep) {
        if !entry.is_empty() {
            push(entry.to_string(), CliSource::Dynamic);
        }
    }

    // Login shell PATH (macOS/Linux — GUI apps miss version manager PATHs)
    #[cfg(not(target_os = "windows"))]
    {
        let shell_path = crate::login_shell_extra_path();
        if !shell_path.is_empty() {
            for entry in shell_path.split(':') {
                if !entry.is_empty() {
                    push(entry.to_string(), CliSource::Dynamic);
                }
            }
        }
    }

    // which/where fallback (3s timeout)
    #[cfg(not(target_os = "windows"))]
    {
        let p = cmd_with_timeout("which", &[bin_name], 3);
        if !p.is_empty() && Path::new(&p).exists() {
            if let Some(dir) = Path::new(&p).parent() {
                push(dir.to_string_lossy().to_string(), CliSource::Dynamic);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let result = cmd_with_timeout("cmd", &["/C", "where", bin_name], 3);
        if let Some(line) = result.lines().next() {
            let p = line.trim().to_string();
            if !p.is_empty() {
                if let Some(dir) = Path::new(&p).parent() {
                    push(dir.to_string_lossy().to_string(), CliSource::Dynamic);
                }
            }
        }
    }

    dirs
}

// ─── Core API ──────────────────────────────────────────────

/// Claude binary names, platform-specific.
///
/// NOTE: `dsh` AND `codex` deliberately NOT included — this list feeds the
/// claude resolution paths (resolve()/resolve_ordered(), which back
/// find_claude_binary/find_claude_binary_ordered and the claude session
/// spawn). A machine with only codex (or only dsh) installed would otherwise
/// misreport that binary as the Claude CLI, and claude sessions would spawn
/// it with claude arguments (session breakage — e.g. codex fails with
/// "CLI error: For more information, try '--help'."). codex is resolved via
/// the CodexBackend's own find_binary() (PATH + npm-global scan); dsh via
/// `find_binary_named` (see find_deepseek_binary in lib.rs). scan_all()
/// (diagnostics panel) deliberately combines both name lists so the UI can
/// show Codex installs separately (the frontend labels them by file name).
fn claude_bin_names() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["claude.exe", "claude.cmd"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &["claude"]
    }
}

/// Codex binary names — used only by scan_all() (diagnostics panel display),
/// never by the claude session spawn path.
fn codex_bin_names() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["codex.exe", "codex.cmd"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &["codex"]
    }
}

/// All binary names (claude + codex) — diagnostics/scan only.
fn all_bin_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = claude_bin_names().to_vec();
    names.extend_from_slice(codex_bin_names());
    names
}

/// Resolve the best CLI binary, respecting tier priority.
/// Within each directory: native binary preferred over shebang script.
pub fn resolve() -> Option<(String, CliSource)> {
    let dirs = collect_tiered_dirs();
    let names = claude_bin_names();

    for td in &dirs {
        // Phase 1: prefer native binary in this dir
        for name in names {
            let candidate = Path::new(&td.path).join(name);
            if is_native_binary(&candidate) {
                let path = candidate.to_string_lossy().to_string();
                eprintln!(
                    "[cli_resolver] resolved: {} (source: {}, native)",
                    path, td.source
                );
                return Some((path, td.source));
            }
        }
        // Phase 2: accept any valid executable in this dir
        for name in names {
            let candidate = Path::new(&td.path).join(name);
            if is_valid_executable(&candidate) {
                let path = candidate.to_string_lossy().to_string();
                eprintln!(
                    "[cli_resolver] resolved: {} (source: {}, script)",
                    path, td.source
                );
                return Some((path, td.source));
            }
        }
    }

    eprintln!("[cli_resolver] no CLI binary found");
    None
}

/// Return all valid CLI binaries in priority order.
/// Used by check_claude_cli to iterate on timeout.
pub fn resolve_ordered() -> Vec<(String, CliSource)> {
    let dirs = collect_tiered_dirs();
    let names = claude_bin_names();
    let mut results = Vec::new();
    let mut seen_paths = HashSet::new();

    for td in &dirs {
        for name in names {
            let candidate = Path::new(&td.path).join(name);
            let path_str = candidate.to_string_lossy().to_string();
            if (is_native_binary(&candidate) || is_valid_executable(&candidate))
                && seen_paths.insert(path_str.clone())
            {
                results.push((path_str, td.source));
            }
        }
    }

    results
}

/// Scan all possible CLI locations and return candidates with metadata.
/// Does NOT run --version (that's async, done by the diagnose Tauri command).
pub fn scan_all() -> Vec<CliCandidate> {
    let dirs = collect_tiered_dirs();
    let names = all_bin_names();
    let mut candidates = Vec::new();
    let mut seen_paths = HashSet::new();

    // Get enriched PATH for shebang validation
    #[cfg(not(target_os = "windows"))]
    let enriched_path = crate::build_enriched_path();

    for td in &dirs {
        for &name in &names {
            let candidate = Path::new(&td.path).join(name);
            let path_str = candidate.to_string_lossy().to_string();

            // Skip duplicates
            if !seen_paths.insert(path_str.clone()) {
                continue;
            }

            // Check if file exists at all (including broken symlinks)
            let exists = candidate.exists();
            let symlink_exists = std::fs::symlink_metadata(&candidate).is_ok();

            if !exists && !symlink_exists {
                continue;
            }

            let native = is_native_binary(&candidate);
            let valid = is_valid_executable(&candidate);
            let mut issues = Vec::new();

            // Broken symlink
            if symlink_exists && !exists {
                issues.push("broken symlink (target no longer exists)".to_string());
            } else if !valid {
                issues.push("not a valid executable".to_string());
            }

            // Shebang validation on Unix
            #[cfg(not(target_os = "windows"))]
            if valid && !native {
                issues.extend(shebang_issues(&candidate, &enriched_path));
            }

            // Windows: check git-bash availability — only relevant for the
            // claude CLI (it needs bash for git operations). Codex runs on
            // the native Node runtime and does not require git-bash.
            #[cfg(target_os = "windows")]
            if valid && claude_bin_names().contains(&name) {
                if crate::find_git_bash().is_none() {
                    issues.push("Git Bash not found (required on Windows)".to_string());
                }
            }

            candidates.push(CliCandidate {
                path: path_str,
                source: td.source,
                is_native: native,
                version: None,
                issues,
            });
        }
    }

    candidates
}

/// Remove stale CLI installations from user-selected paths.
/// Safety: only auto-deletes Tier 2 (AppLocal). Other tiers are skipped with reason.
pub fn cleanup(targets: &[String]) -> CleanupResult {
    let mut removed = Vec::new();
    let mut skipped = Vec::new();

    // Build a set of known AppLocal directories for safety check
    let mut app_local_prefixes: Vec<String> = Vec::new();
    if let Some(cli_dir) = crate::cli_download_dir() {
        app_local_prefixes.push(cli_dir.to_string_lossy().to_string());
    }
    if let Some(npm_bin) = crate::commands::cli_manage::get_npm_global_bin() {
        app_local_prefixes.push(npm_bin.to_string_lossy().to_string());
    }
    if let Ok(npm_dir) = crate::commands::cli_manage::npm_global_dir() {
        app_local_prefixes.push(npm_dir.to_string_lossy().to_string());
    }

    // Component-level prefix match via Path::starts_with — a raw string
    // prefix match would also accept "npm-global-evil" or "npm-global2"
    // (sibling directories with the same prefix).
    let is_app_local = |path: &str| -> bool {
        let p = Path::new(path);
        app_local_prefixes
            .iter()
            .any(|prefix| p.starts_with(Path::new(prefix)))
    };

    for target in targets {
        let path = Path::new(target);

        if !path.exists() {
            // Already gone (or broken symlink) — only removable when the
            // TARGET path itself is inside an AppLocal dir. A dangling link
            // elsewhere (e.g. /tmp/link → deleted CLI) must not be deletable
            // through cleanup().
            if is_app_local(target) && std::fs::symlink_metadata(path).is_ok() {
                let _ = std::fs::remove_file(path);
                removed.push(target.clone());
            }
            continue;
        }

        if is_app_local(target) {
            // Safe to auto-delete
            match std::fs::remove_file(path) {
                Ok(()) => {
                    eprintln!("[cli_resolver] removed: {}", target);
                    removed.push(target.clone());
                }
                Err(e) => {
                    skipped.push(CleanupSkipped {
                        path: target.clone(),
                        reason: format!("delete failed: {}", e),
                    });
                }
            }
        } else {
            // Determine source for user-friendly message
            let source = classify_path(target);
            let reason = match source {
                CliSource::Official => {
                    "Official Anthropic install — will not delete".to_string()
                }
                CliSource::System => {
                    "System install — remove manually (e.g. npm uninstall -g @anthropic-ai/claude-code)".to_string()
                }
                CliSource::VersionManager => {
                    "Managed by version manager — use its uninstall command".to_string()
                }
                _ => "Not in app-local directory — will not auto-delete".to_string(),
            };
            skipped.push(CleanupSkipped {
                path: target.clone(),
                reason,
            });
        }
    }

    // Also clean up npm node_modules if any AppLocal binary was removed
    if !removed.is_empty() {
        if let Ok(npm_dir) = crate::commands::cli_manage::npm_global_dir() {
            let claude_pkg = npm_dir
                .join("lib")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code");
            if claude_pkg.exists() {
                match std::fs::remove_dir_all(&claude_pkg) {
                    Ok(()) => {
                        eprintln!(
                            "[cli_resolver] removed npm package: {}",
                            claude_pkg.display()
                        );
                        removed.push(claude_pkg.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        eprintln!("[cli_resolver] failed to remove npm package: {}", e);
                    }
                }
            }
            // Windows: npm_global_dir is flat, no lib/node_modules
            #[cfg(target_os = "windows")]
            {
                let claude_pkg_win = npm_dir
                    .join("node_modules")
                    .join("@anthropic-ai")
                    .join("claude-code");
                if claude_pkg_win.exists() {
                    let _ = std::fs::remove_dir_all(&claude_pkg_win);
                }
            }
        }
    }

    CleanupResult { removed, skipped }
}

/// Classify a path into a CliSource tier (best-effort heuristic for cleanup messages).
fn classify_path(path: &str) -> CliSource {
    // AppLocal check
    let mut app_local_prefixes: Vec<String> = Vec::new();
    if let Some(cli_dir) = crate::cli_download_dir() {
        app_local_prefixes.push(cli_dir.to_string_lossy().to_string());
    }
    if let Some(npm_bin) = crate::commands::cli_manage::get_npm_global_bin() {
        app_local_prefixes.push(npm_bin.to_string_lossy().to_string());
    }
    if app_local_prefixes
        .iter()
        .any(|p| path.starts_with(p.as_str()))
    {
        return CliSource::AppLocal;
    }

    // Official check
    if path.contains(".claude/local") || path.contains(".claude\\local") {
        return CliSource::Official;
    }
    if path.contains("Claude/claude-code") || path.contains("Claude\\claude-code") {
        return CliSource::Official;
    }

    // VersionManager check
    let vm_markers = [".nvm", ".volta", ".fnm", ".bun", "nvm"];
    if vm_markers.iter().any(|m| path.contains(m)) {
        return CliSource::VersionManager;
    }

    CliSource::System
}

// ─── Convenience wrapper (drop-in replacement) ─────────────

/// Drop-in replacement for the old `find_claude_binary()`.
/// Returns just the path, discarding the source tier.
pub fn find_binary() -> Option<String> {
    // Check pinned CLI first
    if let Some(pinned) = get_pinned_cli() {
        let p = Path::new(&pinned);
        if is_native_binary(p) || is_valid_executable(p) {
            return Some(pinned);
        }
        eprintln!(
            "[cli_resolver] pinned CLI '{}' is no longer valid, falling back",
            pinned
        );
    }
    resolve().map(|(path, _)| path)
}

/// Find a CLI by an explicit name list (e.g. DeepSeek Harness `dsh`),
/// scanning the same tiered directories without touching the claude pin.
pub fn find_binary_named(names: &[&str]) -> Option<String> {
    let dirs = collect_tiered_dirs();
    for td in &dirs {
        for name in names {
            let candidate = Path::new(&td.path).join(name);
            if is_native_binary(&candidate) || is_valid_executable(&candidate) {
                let path = candidate.to_string_lossy().to_string();
                eprintln!("[cli_resolver] resolved {}: {} (source: {})", name, path, td.source);
                return Some(path);
            }
        }
        // npm bin-links fallback: when the target shim was locked, npm writes
        // the launcher as a dot-prefixed tombstone (`.dsh.cmd-<rand>` /
        // `.dsh.ps1-<rand>`) instead of plain `dsh.cmd` — exact-name matching
        // above misses it, and the CLI silently falls back to an OLD install.
        // Accept the tombstone .cmd/.ps1 shim (same content as the real one).
        for name in names {
            let stem = Path::new(name)
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if stem.is_empty() {
                continue;
            }
            if let Ok(rd) = std::fs::read_dir(&td.path) {
                for entry in rd.flatten() {
                    let fname = entry.file_name().to_string_lossy().to_string();
                    let lower = fname.to_lowercase();
                    let bare = lower.strip_prefix('.').unwrap_or(&lower);
                    let rest = match bare.strip_prefix(&stem) {
                        Some(r) => r,
                        None => continue,
                    };
                    let is_tomb = if let Some(r) = rest.strip_prefix('.') {
                        // `dsh.cmd-<rand>` / `dsh.ps1-<rand>`
                        let (ext, rand) = r.split_once('-').unwrap_or(("", ""));
                        matches!(ext, "cmd" | "ps1") && !rand.is_empty()
                    } else if let Some(r) = rest.strip_prefix('-') {
                        // extensionless `dsh-<rand>` — only if executable
                        !r.is_empty() && is_valid_executable(&entry.path())
                    } else {
                        false
                    };
                    if !is_tomb {
                        continue;
                    }
                    let p = entry.path();
                    if is_valid_executable(&p) {
                        let path = p.to_string_lossy().to_string();
                        eprintln!(
                            "[cli_resolver] resolved {} tombstone shim: {} (source: {})",
                            name, path, td.source
                        );
                        return Some(path);
                    }
                }
            }
        }
    }
    eprintln!("[cli_resolver] no binary found for {:?}", names);
    None
}

// ─── CLI Pinning ───────────────────────────────────────────

/// Pin file lives in ~/.her/ (survives app updates).
fn pin_file_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".her").join("cli-pin.json"))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CliPin {
    path: String,
}

/// Get the currently pinned CLI path, if any.
pub fn get_pinned_cli() -> Option<String> {
    let pin_path = pin_file_path()?;
    let content = std::fs::read_to_string(&pin_path).ok()?;
    let pin: CliPin = serde_json::from_str(&content).ok()?;
    if pin.path.is_empty() {
        None
    } else {
        Some(pin.path)
    }
}

/// Pin a specific CLI binary as the preferred one.
pub fn pin_cli(path: &str) -> Result<(), String> {
    // H6 (security): the pin is persisted and used to spawn "claude" for
    // EVERY future session — pinning an arbitrary executable is a persistent
    // execution point. Validate hard: known basename, existing regular file,
    // no symlinks.
    let p = Path::new(path);
    let basename = p
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    const ALLOWED_BASENAMES: &[&str] = &[
        "claude",
        "claude.exe",
        "claude.cmd",
        "claude.ps1",
        "codex",
        "codex.exe",
        "codex.cmd",
        "dsh",
        "dsh.exe",
        "dsh.cmd",
    ];
    if !ALLOWED_BASENAMES.contains(&basename.as_str()) {
        return Err(format!(
            "Only known CLI binaries can be pinned (rejected: {})",
            basename
        ));
    }
    match std::fs::symlink_metadata(p) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("Cannot pin a symlink".to_string());
            }
            if !meta.is_file() {
                return Err("Pin target must be a regular file".to_string());
            }
        }
        Err(e) => return Err(format!("Pin target not accessible: {}", e)),
    }
    let pin_path = pin_file_path().ok_or("Cannot determine home directory")?;
    if let Some(parent) = pin_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let pin = CliPin {
        path: path.to_string(),
    };
    let json = serde_json::to_string_pretty(&pin).map_err(|e| format!("JSON error: {}", e))?;
    std::fs::write(&pin_path, json).map_err(|e| format!("Failed to write pin file: {}", e))?;
    eprintln!("[cli_resolver] pinned CLI: {}", path);
    Ok(())
}

/// Remove the CLI pin (go back to auto-detection).
pub fn unpin_cli() -> Result<(), String> {
    if let Some(pin_path) = pin_file_path() {
        if pin_path.exists() {
            std::fs::remove_file(&pin_path)
                .map_err(|e| format!("Failed to remove pin file: {}", e))?;
            eprintln!("[cli_resolver] unpinned CLI");
        }
    }
    Ok(())
}

// ─── PATH Injection ────────────────────────────────────────

/// Inject a CLI's directory into the user's shell PATH profile.
/// Returns the shell profile file that was modified.
#[cfg(not(target_os = "windows"))]
pub fn inject_path(cli_path: &str) -> Result<String, String> {
    let dir = Path::new(cli_path)
        .parent()
        .ok_or("Cannot determine CLI directory")?
        .to_string_lossy()
        .to_string();

    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    // Escape shell metacharacters in the injected path — a CLI directory
    // containing " or $() or backticks would otherwise execute when the
    // user's next shell starts (persistent backdoor via a crafted path).
    let escaped_dir = dir
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$");
    let export_line = format!("export PATH=\"{}:$PATH\"", escaped_dir);
    let marker = "# Added by Her";
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
                return Ok(format!("Already in {}", p.display()));
            }
        }
    }

    // Append to the first existing profile
    for p in &profiles {
        if p.exists() {
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(p) {
                use std::io::Write;
                f.write_all(block.as_bytes())
                    .map_err(|e| format!("Write failed: {}", e))?;
                return Ok(format!("Injected into {}", p.display()));
            }
        }
    }

    // None exist — create ~/.zshrc
    std::fs::write(home.join(".zshrc"), block)
        .map_err(|e| format!("Failed to create .zshrc: {}", e))?;
    Ok("Created ~/.zshrc with PATH".to_string())
}

#[cfg(target_os = "windows")]
pub fn inject_path(cli_path: &str) -> Result<String, String> {
    let dir = Path::new(cli_path)
        .parent()
        .ok_or("Cannot determine CLI directory")?
        .to_string_lossy()
        .to_string();

    // Pass the path via an environment variable instead of embedding it in
    // the -Command string: a CLI directory containing quotes, $(), backticks
    // or semicolons would otherwise break out of the single-quoted literal
    // (only single quotes were escaped before) and execute arbitrary
    // PowerShell — a persistent backdoor triggered on every inject_path.
    let ps_script = "
        $dir = $env:LITTLE_CLAUDE_CLI_DIR; \
        $old = [Environment]::GetEnvironmentVariable('Path','User'); \
        if ($old -and -not $old.Contains($dir)) { \
          [Environment]::SetEnvironmentVariable('Path', $dir + ';' + $old, 'User') \
        } elseif (-not $old) { \
          [Environment]::SetEnvironmentVariable('Path', $dir, 'User') \
        }";
    let output = std::process::Command::new("powershell")
        .env("LITTLE_CLAUDE_CLI_DIR", &dir)
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("PowerShell failed: {}", e))?;

    if output.status.success() {
        Ok(format!("Added {} to user PATH", dir))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed: {}", stderr))
    }
}

// ─── Delete CLI ────────────────────────────────────────────

/// Delete a specific CLI binary. Refuses to delete Official tier and any file
/// that doesn't live inside a directory this resolver scans for CLI binaries
/// (arbitrary-path delete protection).
pub fn delete_cli(path: &str) -> Result<String, String> {
    let source = classify_path(path);

    if source == CliSource::Official {
        return Err(
            "Cannot delete Official Anthropic installation. Uninstall via Claude Desktop."
                .to_string(),
        );
    }

    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Safety (two independent gates):
    //  1. The file NAME must be a known CLI binary (claude/codex/dsh) —
    //     arbitrary filenames inside scanned dirs (e.g. %APPDATA%\npm\*.log)
    //     must never be deletable, even from a XSS'd webview.
    //  2. The parent directory must be one of the known non-Dynamic CLI dirs.
    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid path: {}", path))?;
    let lower = file_name.to_lowercase();
    let is_cli_name = ["claude", "claude.exe", "claude.cmd", "claude.ps1",
                       "codex", "codex.exe", "codex.cmd", "codex.ps1",
                       "dsh", "dsh.exe", "dsh.cmd", "dsh.ps1"]
        .iter()
        .any(|n| *n == lower);
    if !is_cli_name {
        return Err(format!(
            "Refusing to delete non-CLI file: {}",
            path
        ));
    }

    let parent = p
        .parent()
        .ok_or_else(|| format!("Invalid path: {}", path))?;
    let parent_c = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    let allowed = collect_tiered_dirs().iter().any(|td| {
        // Never auto-delete from Tier 4 (Dynamic) — those are arbitrary
        // PATH directories (scoop shims, user-installed tools, ...); a
        // XSS'd webview could otherwise delete any file in PATH.
        if td.source == CliSource::Dynamic {
            return false;
        }
        let root = Path::new(&td.path);
        let root_c = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        parent_c.starts_with(&root_c)
    });
    if !allowed {
        return Err(format!(
            "Refusing to delete file outside known CLI directories: {}",
            path
        ));
    }

    std::fs::remove_file(p).map_err(|e| format!("Delete failed: {}", e))?;
    // The tier-scan cache still lists the deleted binary's directory —
    // drop it so resolve() doesn't keep returning a now-missing path.
    invalidate_cli_cache();

    // If pinned CLI was deleted, unpin it
    if let Some(pinned) = get_pinned_cli() {
        if pinned == path {
            let _ = unpin_cli();
        }
    }

    eprintln!("[cli_resolver] deleted CLI: {} (source: {})", path, source);
    Ok(format!("Deleted {}", path))
}

// ─── Tests ─────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_is_native_binary_nonexistent() {
        assert!(!is_native_binary(Path::new("/nonexistent/path/claude")));
    }

    #[test]
    fn test_is_valid_executable_nonexistent() {
        assert!(!is_valid_executable(Path::new("/nonexistent/path/claude")));
    }

    #[test]
    fn test_classify_path_official() {
        assert_eq!(
            classify_path("/Users/test/.claude/local/claude"),
            CliSource::Official
        );
        assert_eq!(
            classify_path(
                "/Users/test/Library/Application Support/Claude/claude-code/1.0.0/claude"
            ),
            CliSource::Official
        );
    }

    #[test]
    fn test_classify_path_version_manager() {
        assert_eq!(
            classify_path("/Users/test/.nvm/versions/node/v22.0.0/bin/claude"),
            CliSource::VersionManager
        );
        assert_eq!(
            classify_path("/Users/test/.volta/bin/claude"),
            CliSource::VersionManager
        );
    }

    #[test]
    fn test_classify_path_system() {
        assert_eq!(classify_path("/usr/local/bin/claude"), CliSource::System);
        assert_eq!(classify_path("/opt/homebrew/bin/claude"), CliSource::System);
    }

    #[test]
    fn test_cleanup_refuses_official() {
        // Create a temp file in a path that looks Official
        let tmp = TempDir::new().unwrap();
        let official_dir = tmp.path().join(".claude").join("local");
        fs::create_dir_all(&official_dir).unwrap();
        let fake_cli = official_dir.join("claude");
        fs::write(&fake_cli, b"fake").unwrap();

        let result = cleanup(&[fake_cli.to_string_lossy().to_string()]);
        // File should NOT be deleted (not in AppLocal prefix)
        assert!(result.removed.is_empty());
        assert_eq!(result.skipped.len(), 1);
        assert!(result.skipped[0].reason.contains("Official"));
        // File should still exist
        assert!(fake_cli.exists());
    }

    #[test]
    fn test_cleanup_refuses_version_manager() {
        let tmp = TempDir::new().unwrap();
        let nvm_dir = tmp
            .path()
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v22")
            .join("bin");
        fs::create_dir_all(&nvm_dir).unwrap();
        let fake_cli = nvm_dir.join("claude");
        fs::write(&fake_cli, b"fake").unwrap();

        let result = cleanup(&[fake_cli.to_string_lossy().to_string()]);
        assert!(result.removed.is_empty());
        assert_eq!(result.skipped.len(), 1);
        assert!(result.skipped[0].reason.contains("version manager"));
        assert!(fake_cli.exists());
    }

    #[test]
    fn test_find_newest_version_bin_empty() {
        let tmp = TempDir::new().unwrap();
        assert!(find_newest_version_bin(tmp.path(), "claude").is_none());
    }

    #[test]
    fn test_resolve_ordered_deduplicates() {
        // resolve_ordered should not return the same path twice
        let results = resolve_ordered();
        let mut seen = HashSet::new();
        for (path, _) in &results {
            assert!(seen.insert(path.clone()), "duplicate path: {}", path);
        }
    }

    #[test]
    fn test_collect_tiered_dirs_tier_order() {
        let dirs = collect_tiered_dirs();
        // Verify tier order is non-decreasing
        let mut last_tier = CliSource::Official;
        for td in &dirs {
            assert!(
                td.source >= last_tier,
                "tier order violated: {} ({}) came after {} tier",
                td.path,
                td.source,
                last_tier
            );
            last_tier = td.source;
        }
    }

    #[test]
    fn test_scan_all_no_panic() {
        // scan_all should not panic on any system
        let candidates = scan_all();
        // Every candidate should have a non-empty path
        for c in &candidates {
            assert!(!c.path.is_empty());
        }
    }
}
