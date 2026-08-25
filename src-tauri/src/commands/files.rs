use notify::event::ModifyKind;
use notify::Watcher;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as TokioMutex;

// ── File watcher manager ─────────────────────────────────────────────

/// Manages active file watchers
#[derive(Default)]
pub(crate) struct WatcherManager {
    watchers: Arc<TokioMutex<HashMap<String, notify::RecommendedWatcher>>>,
}

// ── File tree types ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
}

// ── File tree ────────────────────────────────────────────────────────

// ── R1: mtime-validated depth-1 tree cache ───────────────────────────

/// Cache for depth-1 directory listings keyed by canonical path. An entry is
/// reused only while the directory's mtime is unchanged — creating/removing/
/// renaming a direct child updates the directory mtime, so the cache stays
/// consistent without re-scanning. Watch events additionally invalidate
/// entries explicitly (covers coarse mtime granularity).
struct TreeDirCache {
    inner: StdMutex<HashMap<PathBuf, TreeDirCacheEntry>>,
}

struct TreeDirCacheEntry {
    mtime_ns: u128,
    children: Arc<Vec<FileNode>>,
}

impl TreeDirCache {
    const MAX_ENTRIES: usize = 512;

    fn get(&self, dir: &Path, mtime_ns: u128) -> Option<Arc<Vec<FileNode>>> {
        let map = self.inner.lock().unwrap();
        map.get(dir)
            .filter(|e| e.mtime_ns == mtime_ns)
            .map(|e| e.children.clone())
    }

    fn insert(&self, dir: PathBuf, mtime_ns: u128, children: Vec<FileNode>) {
        let mut map = self.inner.lock().unwrap();
        if map.len() >= Self::MAX_ENTRIES {
            map.clear();
        }
        map.insert(
            dir,
            TreeDirCacheEntry {
                mtime_ns,
                children: Arc::new(children),
            },
        );
    }

    /// Drop the cached listing of `path` and of its direct parent (the only
    /// directories whose direct-child list can have changed).
    fn invalidate(&self, path: &Path) {
        let mut map = self.inner.lock().unwrap();
        if let Some(parent) = path.parent() {
            map.remove(parent);
        }
        map.remove(path);
    }
}

static TREE_DIR_CACHE: OnceLock<TreeDirCache> = OnceLock::new();

fn tree_dir_cache() -> &'static TreeDirCache {
    TREE_DIR_CACHE.get_or_init(|| TreeDirCache {
        inner: StdMutex::new(HashMap::new()),
    })
}

/// Directory mtime in nanoseconds since the epoch (cache validity token).
fn dir_mtime_ns(dir: &Path) -> Option<u128> {
    let meta = fs::metadata(dir).ok()?;
    Some(
        meta.modified()
            .ok()?
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    )
}

#[tauri::command]
pub async fn read_file_tree(path: String, depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let max_depth = depth.unwrap_or(3).min(8);
    // P1 (perf): the scan is synchronous fs work — running it inline blocked
    // a tokio worker and stalled IPC/stream events app-wide while a deep
    // (depth 8) search scan ran. Move it to the blocking pool.
    tokio::task::spawn_blocking(move || -> Result<Vec<FileNode>, String> {
        let dir = Path::new(&path);
        if !dir.is_dir() {
            return Err(format!("Not a directory: {}", path));
        }
        // Refuse to enumerate system-critical directories (symlinked roots too).
        if let Ok(canon) = fs::canonicalize(dir) {
            if is_system_dir(&canon) {
                return Err(format!("拒绝访问系统目录: {}", path));
            }
            // S5 (security): 目录枚举接入授权门 —— 只允许白名单根、已注册
            // 项目/工作区根（前端 setWorkingDirectory/会话启动时注册）。
            // 防止被攻陷渲染层枚举任意非黑名单目录结构。
            if !path_authorized(&canon) {
                return Err(format!(
                    "拒绝浏览未授权目录（请先在应用中选择该目录为工作区）: {}",
                    path
                ));
            }
        }
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let mut root = FileNode {
            name,
            path: path.clone(),
            is_dir: true,
            children: None,
        };
        // R1: depth=1 reads (the lazy-loading pattern used by the file tree)
        // go through an mtime-validated cache, so repeated refreshes of
        // unchanged directories cost one stat instead of a full rescan.
        // Deeper scans (full-tree search) bypass the cache.
        let children = if max_depth == 1 {
            match fs::canonicalize(dir) {
                Ok(canon) => match dir_mtime_ns(&canon) {
                    Some(mtime) => {
                        let cache = tree_dir_cache();
                        match cache.get(&canon, mtime) {
                            Some(cached) => cached.as_ref().clone(),
                            None => {
                                let children = read_dir_recursive(dir, 1, 1);
                                cache.insert(canon, mtime, children.clone());
                                children
                            }
                        }
                    }
                    None => read_dir_recursive(dir, 1, 1),
                },
                Err(_) => read_dir_recursive(dir, 1, 1),
            }
        } else {
            read_dir_recursive(dir, 1, max_depth)
        };
        root.children = Some(children);
        Ok(vec![root])
    })
    .await
    .map_err(|e| format!("file tree task failed: {}", e))?
}

fn read_dir_recursive(dir: &Path, current_depth: u32, max_depth: u32) -> Vec<FileNode> {
    let mut nodes = vec![];
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return nodes,
    };
    // Collect (name, is_dir, path) in a single pass — file_type() (a syscall)
    // is invoked exactly once per entry. The old code called it inside the
    // sort comparator (twice per comparison, O(n log n) syscalls per dir).
    let mut entry_list: Vec<(String, bool, std::path::PathBuf)> = entries
        .filter_map(|e| e.ok())
        .map(|entry| {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (
                entry.file_name().to_string_lossy().to_string(),
                is_dir,
                entry.path(),
            )
        })
        .collect();
    // Sort: directories first, then alphabetically (same order as before)
    entry_list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (name, is_dir, path) in entry_list {
        // Skip hidden files and node_modules
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        // R1: directories at the depth limit carry `children: null` so the
        // frontend can distinguish "not yet loaded" from "loaded, empty"
        // (files also carry null — `is_dir` disambiguates).
        let children = if is_dir && current_depth < max_depth {
            Some(read_dir_recursive(&path, current_depth + 1, max_depth))
        } else {
            None
        };
        nodes.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
    }
    nodes
}

// ── Path safety ──────────────────────────────────────────────────────

/// Reject paths with null bytes or `..` traversal attempts.
fn reject_unsafe_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".to_string());
    }
    if path.contains('\0') {
        return Err("路径包含非法字符 (NUL)".to_string());
    }
    for part in std::path::Path::new(path).components() {
        if let std::path::Component::ParentDir = part {
            return Err("路径包含越权访问 (..)".to_string());
        }
    }
    Ok(())
}

/// Sensitive user-directory entries (relative to the user's home) that file
/// commands must never touch even though they are not OS-system dirs: they
/// hold credentials (SSH keys, cloud CLI tokens, git/npm/registry auth,
/// browser login state). A renderer compromise could otherwise read them
/// directly — the system-dir blacklist alone leaves every user-level secret
/// in reach. Matched case-insensitively on the canonical path relative to
/// the canonical home (a non-canonical input simply doesn't match here and
/// is re-checked after canonicalize in safe_resolve).
fn is_sensitive_user_dir(path: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let Ok(home_c) = std::fs::canonicalize(&home) else {
        return false;
    };
    let Ok(rel) = path.strip_prefix(&home_c) else {
        return false;
    };
    let norm = rel.to_string_lossy().replace('\\', "/").to_lowercase();
    const SENSITIVE: &[&str] = &[
        ".ssh",
        ".aws",
        ".gnupg",
        ".kube",
        ".docker",
        ".netrc",
        ".npmrc",
        ".yarnrc.yml",
        ".pypirc",
        ".m2",
        // Browser login/cookie stores under ~/.config on Linux/macOS
        ".config/google-chrome",
        ".config/chromium",
        ".config/microsoft-edge",
        // GitHub CLI / Google Cloud CLI credential stores
        ".config/gh",
        ".config/gcloud",
        // H4: Windows browser credential stores (%LOCALAPPDATA% = home/AppData/Local)
        "appdata/local/google/chrome/user data",
        "appdata/local/microsoft/edge/user data",
        "appdata/local/bravesoftware/brave-browser/user data",
        // H4: editor token/session stores under %APPDATA%
        "appdata/roaming/code",
        "appdata/roaming/cursor",
        // H4: macOS browser + editor credential stores and the keychain db
        "library/application support/google/chrome",
        "library/application support/chromium",
        "library/application support/microsoft edge",
        "library/application support/code",
        "library/application support/cursor",
        "library/keychains",
    ];
    SENSITIVE
        .iter()
        .any(|s| norm == *s || norm.starts_with(&format!("{}/", s)))
}

/// System-critical directories that file commands must never touch.
/// Case-insensitive prefix match on '/'-normalized paths, so Windows drives
/// and case-sensitive macOS/Linux roots are both covered.
fn is_system_dir(path: &Path) -> bool {
    if is_sensitive_user_dir(path) {
        return true;
    }
    // Strip the Windows verbatim prefix (`\\?\C:\...` / `\\.\C:\...`) that
    // fs::canonicalize returns — prefix matching against it would miss every
    // blacklist entry (`//?/C:/WINDOWS` vs `C:/WINDOWS`), letting reads like
    // `\\?\C:\Program Files\...\config.json` slip through.
    let s = path.to_string_lossy();
    let s = match s.strip_prefix(r"\\?\").or_else(|| s.strip_prefix(r"\\.\")) {
        Some(rest) => std::borrow::Cow::Owned(rest.to_string()),
        None => s,
    };
    let norm = s.replace('\\', "/").to_uppercase();
    const ROOTS: &[&str] = &[
        // Windows
        "C:/WINDOWS",
        "C:/PROGRAMDATA",
        "C:/PROGRAM FILES",
        "C:/PROGRAM FILES (X86)",
        "C:/$RECYCLE.BIN",
        "C:/SYSTEM VOLUME INFORMATION",
        // macOS / Linux
        "/SYSTEM",
        "/ETC",
        "/USR",
        "/BIN",
        "/SBIN",
        "/DEV",
        "/PROC",
        "/SYS",
        "/LIBRARY",
        // macOS 的 /etc、/var、/tmp 都是指向 /private/* 的符号链接——canonicalize
        // 后路径归一化成 /PRIVATE/...，缺此前缀时黑名单被整个绕过
        // （/private/etc/passwd 等直接读写成功）。
        "/PRIVATE",
    ];
    ROOTS.iter().any(|root| norm == *root || norm.starts_with(&format!("{}/", root)))
}

// ── B1: authorized-path gate ──────────────────────────────────────────────
// The renderer's file commands (read/write/delete/rename/copy/...) must never
// reach ARBITRARY user files: a compromised renderer could otherwise read
// ~/.ssh, cloud credentials, browser cookies etc. directly. A path is
// authorized only when it falls under one of:
//   1. fixed whitelist roots (the app's own data + Claude/Codex config trees),
//   2. a project root registered by start_claude_session (Rust-internal,
//      NOT reachable from IPC — a compromised renderer cannot add roots),
//   3. a path the user explicitly picked via a native file dialog
//      (frontend registers it after the dialog; TTL-bounded).
// read_file_tree / watch_directory stay open (project browsing + the A1
// sensitive-dir blacklist already gate them).

use std::time::Instant;

static AUTHORIZED_PATHS: OnceLock<StdMutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
/// How long a dialog-picked path stays authorized (long enough for import /
/// export / skin-pick flows; short enough that a stale grant expires).
const EXTERNAL_PATH_TTL: Duration = Duration::from_secs(30 * 60);

fn authorized_paths() -> &'static StdMutex<HashMap<PathBuf, Instant>> {
    AUTHORIZED_PATHS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// S1 (defense-in-depth): 授权根数量上限 —— 防止被攻陷渲染层无限灌入授权项。
const MAX_AUTHORIZED_ROOTS: usize = 64;

/// Insert a root into the authorized map with audit logging + capacity bound.
/// Every IPC-reachable grant goes through here so abuse shows up in logs.
fn insert_authorized_root(canon: PathBuf, source: &str) {
    if let Ok(mut map) = authorized_paths().lock() {
        // 容量上限：超出时淘汰最早的授权（map 无序，线性找最旧即可）
        while map.len() >= MAX_AUTHORIZED_ROOTS {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, at)| at.elapsed())
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            } else {
                break;
            }
        }
        eprintln!(
            "[LITTLECLAUDE:security] authorize root ({source}): {}",
            canon.display()
        );
        map.insert(canon, Instant::now());
    }
}

/// Reject grants for hidden directories (any `.`-prefixed component under the
/// user's home). The app's own managed config trees (~/.claude, ~/.codex,
/// safe_data_dir) are whitelisted independently and don't need these grants;
/// blocking dot-dirs here closes the easiest exfiltration targets (dotfile
/// configs, token stores) that aren't already in the sensitive list.
fn rejects_hidden_dir(canon: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let Ok(home_c) = fs::canonicalize(&home) else {
        return false;
    };
    let Ok(rel) = canon.strip_prefix(&home_c) else {
        return false; // outside home: hidden-dir rule doesn't apply
    };
    rel.iter().any(|c| {
        let s = c.to_string_lossy();
        s.starts_with('.') && s != "."
    })
}

/// Register a project root (called from start_claude_session on every spawn).
/// Rust-internal only — there is deliberately NO IPC command for this, so a
/// compromised renderer cannot grant itself arbitrary roots.
pub(crate) fn register_project_root(path: &Path) {
    let Ok(canon) = fs::canonicalize(path) else {
        return;
    };
    if let Ok(mut map) = authorized_paths().lock() {
        map.insert(canon, Instant::now());
    }
}

/// Register the user-chosen working directory (frontend calls this whenever
/// workingDirectory changes — the user explicitly picked this folder as the
/// workspace, so it is long-lived, same semantics as a session project root).
/// Required so file browsing/preview works BEFORE the first message spawns a
/// session (no session → no register_project_root). Rejects sensitive/system
/// dirs, so a compromised renderer still cannot grant ~/.ssh etc.
#[tauri::command]
pub fn register_workspace_root(path: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    let canon = fs::canonicalize(Path::new(&path))
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    if is_system_dir(&canon) {
        return Err(format!("拒绝注册系统/敏感目录为工作目录: {}", path));
    }
    // S1 (defense-in-depth): 隐藏目录（.git/.ssh 类）不允许经 IPC 授权
    if rejects_hidden_dir(&canon) {
        return Err(format!("拒绝授权隐藏目录: {}", path));
    }
    insert_authorized_root(canon, "workspace_root");
    Ok(())
}

/// Register a path the user picked in a native dialog (frontend calls this
/// right after dialog.open/save returns). Rejects sensitive/system dirs so a
/// compromised renderer cannot grant itself ~/.ssh etc. The picked file may
/// not exist yet (save dialogs name a new file) — the nearest existing
/// ancestor is what gets authorized.
#[tauri::command]
pub fn authorize_external_path(path: String) -> Result<(), String> {
    reject_unsafe_path(&path)?;
    let p = Path::new(&path);
    let canon = resolve_nearest_existing(p)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    if is_system_dir(&canon) {
        return Err(format!("拒绝授权系统/敏感目录: {}", path));
    }
    // Authorize the directory containing the picked file (or the dir itself),
    // canonicalized so the starts_with comparison in path_authorized works.
    let root = if canon.is_dir() {
        fs::canonicalize(&canon).unwrap_or(canon)
    } else {
        match canon.parent() {
            Some(parent) => fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf()),
            None => canon,
        }
    };
    // S1 (defense-in-depth): 隐藏目录不允许经 IPC 授权
    if rejects_hidden_dir(&root) {
        return Err(format!("拒绝授权隐藏目录: {}", path));
    }
    insert_authorized_root(root, "external_dialog");
    Ok(())
}

/// Canonicalize the nearest existing ancestor of `p` (p itself if it exists),
/// appending the non-existent tail back — like safe_resolve's fallback, used
/// by authorize_external_path for save-dialog targets that don't exist yet.
fn resolve_nearest_existing(p: &Path) -> Result<std::path::PathBuf, String> {
    if let Ok(c) = fs::canonicalize(p) {
        return Ok(c);
    }
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p;
    loop {
        let Some(parent) = cur.parent() else {
            return Err(format!("路径不存在: {}", p.display()));
        };
        if parent == cur {
            return Err(format!("路径不存在: {}", p.display()));
        }
        if let Some(name) = cur.file_name() {
            suffix.push(name.to_os_string());
        }
        cur = parent;
        if cur.exists() {
            break;
        }
    }
    let mut result = fs::canonicalize(cur)
        .map_err(|e| format!("Cannot resolve path '{}': {}", p.display(), e))?;
    for name in suffix.iter().rev() {
        result.push(name);
    }
    Ok(result)
}

/// Fixed whitelist roots — the app's own data and the Claude/Codex config
/// trees the app legitimately manages. All compared against canonical paths.
fn whitelist_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".claude")); // projects/jsonl, settings, skills, commands
        roots.push(home.join(".claude.json")); // file-level auth/config
        roots.push(home.join(".mcp.json"));
        roots.push(home.join(".codex"));
    }
    if let Ok(data) = crate::safe_data_dir() {
        roots.push(data); // providers, wallpapers, usage_log, pets, skills
    }
    // H4/#16: authorize ONLY the app's own temp subdir, not the whole shared
    // temp dir — on multi-user systems %TEMP%//tmp hold other apps' files,
    // and a compromised renderer could pre-plant or read them through the
    // file commands. save_temp_file's fallback writes exactly here.
    roots.push(std::env::temp_dir().join("tokenicode"));
    roots
}

/// Convenience for other command modules (e.g. git): canonicalize and check
/// authorization in one step. Returns false when the path doesn't resolve.
pub(crate) fn path_is_authorized(p: &Path) -> bool {
    let Ok(canon) = fs::canonicalize(p) else {
        return false;
    };
    path_authorized(&canon)
}

/// True when the canonical path falls under a whitelist root or a registered
/// project/external root (or is a whitelisted root itself).
fn path_authorized(canon: &Path) -> bool {
    // Sweep expired external grants on every check (cheap: few entries).
    if let Ok(mut map) = authorized_paths().lock() {
        map.retain(|_, at| at.elapsed() < EXTERNAL_PATH_TTL);
        for root in map.keys() {
            if canon == root || canon.starts_with(root) {
                return true;
            }
        }
    }
    for root in whitelist_roots() {
        let Ok(root_c) = fs::canonicalize(&root) else {
            continue;
        };
        if canon == root_c || canon.starts_with(&root_c) {
            return true;
        }
    }
    false
}

/// safe_resolve + the B1 authorization gate. All sensitive file commands go
/// through this; tree browsing keeps using safe_resolve alone.
pub(crate) fn resolve_authorized(path: &str) -> Result<std::path::PathBuf, String> {
    let resolved = safe_resolve(path)?;
    if !path_authorized(&resolved) {
        return Err(format!("拒绝访问未授权路径: {}", path));
    }
    Ok(resolved)
}

/// Resolve a path for file commands: canonicalize (following symlinks) and
/// reject system-critical directories. Write targets that do not exist yet
/// are resolved through their nearest existing ancestor, so the final path
/// is still symlink-free and checked before any create_dir_all.
fn safe_resolve(path: &str) -> Result<std::path::PathBuf, String> {
    reject_unsafe_path(path)?;
    let p = Path::new(path);
    if is_system_dir(p) {
        return Err(format!("拒绝访问系统目录: {}", path));
    }
    if p.exists() {
        let canon = fs::canonicalize(p)
            .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
        if is_system_dir(&canon) {
            return Err(format!("拒绝访问系统目录: {}", path));
        }
        return Ok(canon);
    }
    // Does not exist yet — walk up to the nearest existing ancestor.
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p;
    loop {
        let Some(parent) = cur.parent() else {
            return Err(format!("路径不存在: {}", path));
        };
        if parent == cur {
            return Err(format!("路径不存在: {}", path));
        }
        if let Some(name) = cur.file_name() {
            suffix.push(name.to_os_string());
        }
        cur = parent;
        if cur.exists() {
            break;
        }
    }
    let canon_root = fs::canonicalize(cur)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    if is_system_dir(&canon_root) {
        return Err(format!("拒绝访问系统目录: {}", path));
    }
    let mut result = canon_root;
    for name in suffix.iter().rev() {
        result.push(name);
    }
    Ok(result)
}

/// Maximum file size for read operations (10 MiB).
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

fn check_file_size(path: &Path) -> Result<u64, String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Cannot read file: {}", e))?;
    if metadata.len() > MAX_READ_SIZE {
        return Err(format!(
            "文件过大 ({}MB, 限制 {}MB)",
            metadata.len() / 1_048_576,
            MAX_READ_SIZE / 1_048_576,
        ));
    }
    Ok(metadata.len())
}

// ── File content ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    let resolved = resolve_authorized(&path)?;
    check_file_size(&resolved)?;
    // P1 (perf): up to 10MiB of synchronous disk read — keep it off the
    // async executor.
    let display = path.clone();
    tokio::task::spawn_blocking(move || {
        fs::read_to_string(&resolved).map_err(|e| format!("Cannot read file '{}': {}", display, e))
    })
    .await
    .map_err(|e| format!("file read task failed: {}", e))?
}

#[tauri::command]
pub async fn check_file_access(path: String) -> Result<bool, String> {
    reject_unsafe_path(&path)?;
    // Keep the boolean semantics callers rely on: nonexistent or inaccessible
    // paths (including system dirs) resolve to `false`, not an error.
    match fs::canonicalize(&path) {
        Ok(p) => {
            // L1: also require authorization — otherwise this command is a
            // whole-disk file-existence oracle for a compromised renderer.
            Ok(!is_system_dir(&p) && path_authorized(&p) && p.is_file())
        }
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let resolved = resolve_authorized(&path)?;
    check_file_size(&resolved)?;
    // P1 (perf): sync read + base64 of up to 10MiB — blocking pool.
    let display = path.clone();
    tokio::task::spawn_blocking(move || {
        let data =
            fs::read(&resolved).map_err(|e| format!("Cannot read file '{}': {}", display, e))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&data))
    })
    .await
    .map_err(|e| format!("file read task failed: {}", e))?
}

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    let resolved = resolve_authorized(&path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent directory: {}", e))?;
    }
    fs::write(&resolved, content).map_err(|e| format!("Cannot write file '{}': {}", path, e))
}

// ── File operations ──────────────────────────────────────────────────

#[tauri::command]
pub async fn copy_file(source: String, dest: String) -> Result<(), String> {
    let src = resolve_authorized(&source)?;
    let dst = resolve_authorized(&dest)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent directory: {}", e))?;
    }
    // P1 (perf): copies can be GB-scale — must not block the async executor.
    let (s_disp, d_disp) = (source.clone(), dest.clone());
    tokio::task::spawn_blocking(move || {
        fs::copy(&src, &dst)
            .map_err(|e| format!("Cannot copy '{}' to '{}': {}", s_disp, d_disp, e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("file copy task failed: {}", e))?
}

#[tauri::command]
pub async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let src = resolve_authorized(&old_path)?;
    let dst = resolve_authorized(&new_path)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent directory: {}", e))?;
    }
    fs::rename(&src, &dst)
        .map_err(|e| format!("Cannot rename '{}' to '{}': {}", old_path, new_path, e))?;
    Ok(())
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    let resolved = resolve_authorized(&path)?;
    if !resolved.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    // Use trash (recycle bin) instead of permanent deletion
    trash::delete(&resolved).map_err(|e| format!("Cannot delete '{}': {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let resolved = resolve_authorized(&path)?;
    fs::create_dir_all(&resolved)
        .map_err(|e| format!("Cannot create directory '{}': {}", path, e))?;
    Ok(())
}

// ── File watching ────────────────────────────────────────────────────

/// Frontend-compatible change kinds. (The old code emitted the notify Debug
/// string, e.g. "Create(CreateKind::File)", which never matched the frontend's
/// 'created'/'modified'/'removed' — aggregating with real kinds fixes that.)
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum ChangeKind {
    Created,
    Modified,
    Removed,
}

impl ChangeKind {
    fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Created => "created",
            ChangeKind::Modified => "modified",
            ChangeKind::Removed => "removed",
        }
    }
}

/// Aggregate buffer for one watched directory (R3). The notify callback runs
/// on notify's thread, so buffering uses a plain std Mutex with short critical
/// sections, and the debounce flush is spawned onto the tokio runtime.
struct WatchBuffer {
    debounce: Duration,
    inner: StdMutex<WatchBufferInner>,
}

#[derive(Default)]
struct WatchBufferInner {
    /// Deduplicated path -> latest change kind (last write wins).
    paths: HashMap<PathBuf, ChangeKind>,
    /// Whether a debounce flush task is already pending.
    flushing: bool,
}

impl WatchBuffer {
    fn new(debounce: Duration) -> Self {
        Self {
            debounce,
            inner: StdMutex::new(WatchBufferInner::default()),
        }
    }

    fn push(&self, path: PathBuf, kind: ChangeKind) {
        let mut inner = self.inner.lock().unwrap();
        match inner.paths.get(&path) {
            // 创建后立即写入（git checkout、编辑器保存新文件）不应把 created
            // 降级为 modified——树结构信号丢失会导致前端不刷新文件树。
            Some(_) if kind == ChangeKind::Modified => {}
            _ => {
                inner.paths.insert(path, kind);
            }
        }
    }

    /// Arm the debounce flush if none is pending. Returns true when the caller
    /// must spawn the flush task.
    fn arm(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.flushing {
            return false;
        }
        inner.flushing = true;
        true
    }

    /// Take all buffered changes and disarm the flush flag.
    fn drain(&self) -> Vec<(PathBuf, ChangeKind)> {
        let mut inner = self.inner.lock().unwrap();
        inner.flushing = false;
        inner.paths.drain().collect()
    }
}

/// Map a notify event to (path, kind) pairs. Renames arrive as a
/// Modify(Name) event carrying the old and new paths — split them into a
/// removed + created pair so the frontend refreshes the tree.
fn classify_event(event: &notify::Event) -> Vec<(PathBuf, ChangeKind)> {
    use notify::EventKind;
    let mut out = Vec::new();
    match &event.kind {
        EventKind::Create(_) => {
            for p in &event.paths {
                out.push((p.clone(), ChangeKind::Created));
            }
        }
        EventKind::Remove(_) => {
            for p in &event.paths {
                out.push((p.clone(), ChangeKind::Removed));
            }
        }
        EventKind::Modify(ModifyKind::Name(_)) => {
            if event.paths.len() >= 2 {
                out.push((event.paths[0].clone(), ChangeKind::Removed));
                out.push((event.paths[1].clone(), ChangeKind::Created));
            } else {
                for p in &event.paths {
                    out.push((p.clone(), ChangeKind::Modified));
                }
            }
        }
        EventKind::Modify(_) => {
            for p in &event.paths {
                out.push((p.clone(), ChangeKind::Modified));
            }
        }
        EventKind::Access(_) => {}
        _ => {
            for p in &event.paths {
                out.push((p.clone(), ChangeKind::Modified));
            }
        }
    }
    out
}

/// 规整事件路径：去掉 Windows `\\?\` verbatim 前缀（fs::canonicalize 产生），
/// 使事件路径与前端树节点路径（原始入参的 DOS 路径）格式一致——否则前端
/// 的 markStale / 改动徽标 / 预览自动重载在 Windows 上全部匹配不上。
fn normalize_event_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => s.to_string(),
    }
}

/// Paths under these directory names are excluded from fs:change events —
/// mirrors the frontend's own filter (App.tsx) plus the file tree's
/// exclusions (node_modules, target). Keeps npm install / build / git
/// operation storms out of the IPC pipeline entirely.
fn is_noisy_path(root: &str, path: &Path) -> bool {
    const NOISY: &[&str] = &[".claude", ".git", "node_modules", "__pycache__", "target"];
    let rel = path.strip_prefix(Path::new(root)).unwrap_or(path);
    rel.components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        NOISY.iter().any(|n| name == *n)
    })
}

/// Max concurrent recursive watchers — each recursive watcher holds one
/// ReadDirectoryChangesW handle per subdirectory on Windows, so cap the
/// count to stop a runaway caller from exhausting handles/memory.
const MAX_WATCHERS: usize = 8;

#[tauri::command]
pub async fn watch_directory(
    app: AppHandle,
    state: State<'_, WatcherManager>,
    path: String,
) -> Result<(), String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    if is_system_dir(&canonical) {
        return Err("拒绝监视系统目录".to_string());
    }
    // S5 (security): 长驻目录监听接入授权门 —— 只允许白名单根与已注册
    // 项目/工作区根（前端 setWorkingDirectory / App 启动恢复时注册）。
    if !path_is_authorized(&canonical) {
        return Err(format!(
            "拒绝监视未授权目录（请先在应用中选择该目录为工作区）: {}",
            path
        ));
    }
    let watch_key = canonical.to_string_lossy().to_string();

    let mut watchers = state.watchers.lock().await;
    if watchers.len() >= MAX_WATCHERS && !watchers.contains_key(&watch_key) {
        return Err(format!("监视器数量已达上限 ({} 个)", MAX_WATCHERS));
    }
    if watchers.contains_key(&watch_key) {
        // 报告B5: the existing entry may be a dead watcher — when the watched
        // directory is deleted, notify stops delivering events and does NOT
        // auto-reconnect after the directory is recreated. Replace the entry
        // so re-watch after directory recreation actually re-establishes
        // monitoring (dropping the old watcher stops its listeners).
        watchers.remove(&watch_key);
    }

    // R3: aggregate notify events into a deduplicated buffer and flush at most
    // once per debounce window (300ms), so event storms (npm install, git
    // operations) converge to one fs:change batch instead of one event per
    // notify callback. The flush emits one event per change kind present in
    // the batch, which keeps the existing single-`kind` frontend contract.
    let buffer = Arc::new(WatchBuffer::new(Duration::from_millis(300)));
    let runtime = tokio::runtime::Handle::current();

    let app_clone = app.clone();
    let watch_key_clone = watch_key.clone();
    let buffer_clone = buffer.clone();
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let mut pushed = false;
                for (path, kind) in classify_event(&event) {
                    if is_noisy_path(&watch_key_clone, &path) {
                        continue;
                    }
                    buffer_clone.push(path, kind);
                    pushed = true;
                }
                if pushed && buffer_clone.arm() {
                    let buffer = buffer_clone.clone();
                    let app = app_clone.clone();
                    let root = watch_key_clone.clone();
                    runtime.spawn(async move {
                        tokio::time::sleep(buffer.debounce).await;
                        let drained = buffer.drain();
                        if drained.is_empty() {
                            return;
                        }
                        // Invalidate the R1 tree cache for every changed path
                        // (its direct parent's listing may have changed).
                        for (p, _) in &drained {
                            tree_dir_cache().invalidate(p);
                        }
                        let mut by_kind: HashMap<ChangeKind, Vec<String>> = HashMap::new();
                        for (p, k) in drained {
                            by_kind
                                .entry(k)
                                .or_default()
                                .push(normalize_event_path(&p));
                        }
                        for (k, paths) in by_kind {
                            let payload = serde_json::json!({
                                "path": root,
                                "kind": k.as_str(),
                                "paths": paths,
                            });
                            let _ = app.emit("fs:change", payload);
                        }
                    });
                }
            }
        },
    )
    .map_err(|e| format!("Cannot create watcher: {}", e))?;

    watcher
        .watch(&canonical, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("Cannot watch '{}': {}", watch_key, e))?;

    watchers.insert(watch_key, watcher);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_directory(
    state: State<'_, WatcherManager>,
    path: String,
) -> Result<(), String> {
    let mut watchers = state.watchers.lock().await;
    match fs::canonicalize(&path) {
        Ok(canonical) => {
            watchers.remove(&canonical.to_string_lossy().to_string());
        }
        Err(_) => {
            // #6 (bug): the watched directory was deleted (branch switch,
            // cleanup) — canonicalize fails and the entry used to leak
            // forever; after MAX_WATCHERS dead entries, ALL file watching
            // died with "watcher limit reached" until a restart. Fall back
            // to matching the raw path against the stored keys.
            let norm = path.replace('\\', "/").to_lowercase();
            let norm = norm.trim_end_matches('/').to_string();
            watchers.retain(|k, _| {
                let kn = k.replace('\\', "/").to_lowercase();
                kn.trim_end_matches('/') != norm
            });
        }
    }
    Ok(())
}

// ── File utilities ───────────────────────────────────────────────────

#[tauri::command]
pub async fn get_file_size(path: String) -> Result<u64, String> {
    let resolved = resolve_authorized(&path)?;
    let meta = fs::metadata(&resolved).map_err(|e| format!("Cannot stat '{}': {}", path, e))?;
    Ok(meta.len())
}

/// Save a file to a temp directory and return its path.
/// Uses a unique suffix to avoid name collisions (e.g. multiple pasted images all named "image.png").
#[tauri::command]
pub async fn save_temp_file(
    name: String,
    data: Vec<u8>,
    cwd: Option<String>,
) -> Result<String, String> {
    // A9: refuse oversized attachments before writing anything to disk.
    // Mirrors the frontend gate in useFileAttachments (50MB).
    const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "File exceeds the {} MiB attachment limit",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    // If a working directory is provided, save inside it so Claude CLI can access the file.
    // Falls back to system temp if cwd is not set. B1: the cwd must itself be
    // an authorized project root (register_project_root on session spawn) —
    // an arbitrary cwd would let a compromised renderer write attachments
    // into any directory it picks.
    let tmp = if let Some(ref dir) = cwd {
        reject_unsafe_path(dir)?;
        let dir_p = Path::new(dir);
        let cwd_ok = fs::canonicalize(dir_p).map(|c| path_authorized(&c)).unwrap_or(false);
        if !cwd_ok {
            return Err(format!("拒绝使用未授权工作目录保存附件: {}", dir));
        }
        let p = std::path::PathBuf::from(dir)
            .join(".tokenicode")
            .join("tmp");
        if std::fs::create_dir_all(&p).is_ok() {
            // Ensure .tokenicode is gitignored in user's project
            let gitignore = std::path::PathBuf::from(dir)
                .join(".tokenicode")
                .join(".gitignore");
            // M7: 不无条件覆盖用户已有的 .gitignore——已含 `*` 行则跳过；
            // 已有文件但无 `*` 行则追加（保留用户原有规则）；无文件才新建。
            let existing = fs::read_to_string(&gitignore).unwrap_or_default();
            if !existing.lines().any(|l| l.trim() == "*") {
                let _ = std::fs::write(
                    &gitignore,
                    if existing.trim().is_empty() {
                        "*\n".to_string()
                    } else {
                        format!("{}\n*\n", existing.trim_end())
                    },
                );
            }
            p
        } else {
            std::env::temp_dir().join("tokenicode")
        }
    } else {
        std::env::temp_dir().join("tokenicode")
    };
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // M7: 临时文件永不清理会无限累积——每次写入前清扫 mtime 超过 14 天的旧文件。
    cleanup_stale_temp_files(&tmp);

    // Split name into stem + extension, append timestamp + counter for uniqueness
    let path_buf = std::path::PathBuf::from(&name);
    let stem = path_buf
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path_buf
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let unique_name = format!("{}_{}{}{}", stem, ts, count, ext);
    let path = tmp.join(&unique_name);
    std::fs::write(&path, &data).map_err(|e| format!("Failed to write temp file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// 清扫临时目录中 mtime 超过 14 天的旧文件（save_temp_file 的附属目录）。
/// 低 9: 从 7 天延长到 14 天——聊天里的图片/文件附件可能仍被旧会话引用，
/// 7 天窗口在活跃会话切换后可能误删仍引用的附件。
fn cleanup_stale_temp_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let Some(cutoff) = SystemTime::now().checked_sub(Duration::from_secs(14 * 24 * 3600)) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let stale = meta.modified().map(|m| m < cutoff).unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tok-s3-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_traversal() {
        assert!(safe_resolve("../etc/passwd").is_err());
        assert!(safe_resolve("a/b/../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_nul_and_empty() {
        assert!(safe_resolve("").is_err());
        assert!(safe_resolve("a\0b").is_err());
    }

    #[test]
    fn rejects_system_dirs_string_level() {
        // Pure string checks — valid on every platform.
        assert!(safe_resolve("/etc/passwd").is_err());
        assert!(safe_resolve("/usr/bin/sh").is_err());
        assert!(safe_resolve("/System/Library/CoreServices").is_err());
        assert!(safe_resolve("C:\\Windows\\System32\\config\\SAM").is_err());
        assert!(safe_resolve("C:\\Program Files\\App\\x").is_err());
        assert!(safe_resolve("C:\\Program Files (x86)\\App\\x").is_err());
        // H1: macOS 的 /etc、/var、/tmp 是 /private/* 的符号链接——直接访问
        // /private/* 路径（canonicalize 后的真实路径）也必须被拒绝。
        assert!(safe_resolve("/private/etc/passwd").is_err());
        assert!(safe_resolve("/private/var/log/system.log").is_err());
        assert!(safe_resolve("/private/tmp/x").is_err());
    }

    #[test]
    fn rejects_sensitive_user_dirs() {
        // Credential-bearing user dirs are rejected whether the input is a
        // bare path or goes through canonicalize (the canonical check inside
        // safe_resolve is what actually fires for existing paths).
        if let Some(home) = dirs::home_dir() {
            for sub in [
                ".ssh",
                ".ssh/id_rsa",
                ".aws",
                ".aws/credentials",
                ".gnupg",
                ".gnupg/private-keys-v1.d",
                ".kube",
                ".kube/config",
                ".docker",
                ".docker/config.json",
                ".npmrc",
                ".yarnrc.yml",
                ".pypirc",
                ".m2",
            ] {
                let p = home.join(sub);
                if !p.exists() {
                    continue; // only assert on dirs that exist on this machine
                }
                assert!(
                    safe_resolve(&p.to_string_lossy()).is_err(),
                    "expected rejection for {}",
                    p.display()
                );
            }
        }
    }

    #[test]
    fn resolves_existing_file() {
        let root = temp_root("existing");
        let file = root.join("hello.txt");
        fs::write(&file, "hi").unwrap();
        let resolved = safe_resolve(file.to_str().unwrap()).unwrap();
        assert!(resolved.is_file());
        assert_eq!(fs::read_to_string(&resolved).unwrap(), "hi");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolves_new_file_via_nearest_ancestor() {
        let root = temp_root("newfile");
        let target = root.join("deep").join("nest").join("new.txt");
        let resolved = safe_resolve(target.to_str().unwrap()).unwrap();
        assert_eq!(resolved.file_name().and_then(|n| n.to_str()), Some("new.txt"));
        assert!(!resolved.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_new_file_under_system_ancestor() {
        // The parent chain does not exist, but the nearest existing ancestor
        // (/etc) is a system dir — must be rejected, not created.
        assert!(safe_resolve("/etc/new/child/file.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_into_system_dir() {
        let root = temp_root("symlink");
        let link = root.join("evil_link");
        std::os::unix::fs::symlink("/etc/passwd", &link).unwrap();
        assert!(safe_resolve(link.to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_into_private_dir() {
        // H1: macOS 上 /etc、/var、/tmp 均指向 /private/*——符号链接指向
        // /private 家族路径时，canonicalize 后必须被 "/PRIVATE" 前缀拦住。
        // 仅当目标真实存在（macOS）时断言拒绝；Linux 无 /private 目录，
        // 悬空链接走最近存在祖先分支，不构成漏洞路径，跳过。
        let root = temp_root("symlink-private");
        for target in ["/private/etc/passwd", "/private/var/log"] {
            if !std::path::Path::new(target).exists() {
                continue;
            }
            let link = root.join(format!("link_{}", target.replace('/', "_")));
            if std::os::unix::fs::symlink(target, &link).is_err() {
                continue; // 无权限创建链接的平台跳过（如非管理员）
            }
            assert!(safe_resolve(link.to_str().unwrap()).is_err());
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_regular_file_is_allowed() {
        let root = temp_root("symlink-ok");
        let real = root.join("real.txt");
        fs::write(&real, "data").unwrap();
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let resolved = safe_resolve(link.to_str().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&resolved).unwrap(), "data");
        fs::remove_dir_all(&root).unwrap();
    }
}
