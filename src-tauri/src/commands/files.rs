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
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    // Refuse to enumerate system-critical directories (symlinked roots too).
    if let Ok(canon) = fs::canonicalize(dir) {
        if is_system_dir(&canon) {
            return Err(format!("拒绝访问系统目录: {}", path));
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
    // R1: depth=1 reads (the lazy-loading pattern used by the file tree) go
    // through an mtime-validated cache, so repeated refreshes of unchanged
    // directories cost one stat instead of a full rescan. Deeper scans
    // (full-tree search) bypass the cache.
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

/// System-critical directories that file commands must never touch.
/// Case-insensitive prefix match on '/'-normalized paths, so Windows drives
/// and case-sensitive macOS/Linux roots are both covered.
fn is_system_dir(path: &Path) -> bool {
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
    ];
    ROOTS.iter().any(|root| norm == *root || norm.starts_with(&format!("{}/", root)))
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
    let resolved = safe_resolve(&path)?;
    check_file_size(&resolved)?;
    fs::read_to_string(&resolved).map_err(|e| format!("Cannot read file '{}': {}", path, e))
}

#[tauri::command]
pub async fn check_file_access(path: String) -> Result<bool, String> {
    reject_unsafe_path(&path)?;
    // Keep the boolean semantics callers rely on: nonexistent or inaccessible
    // paths (including system dirs) resolve to `false`, not an error.
    match fs::canonicalize(&path) {
        Ok(p) => Ok(!is_system_dir(&p) && p.is_file()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let resolved = safe_resolve(&path)?;
    check_file_size(&resolved)?;
    let data = fs::read(&resolved).map_err(|e| format!("Cannot read file '{}': {}", path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

#[tauri::command]
pub async fn write_file_content(path: String, content: String) -> Result<(), String> {
    let resolved = safe_resolve(&path)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent directory: {}", e))?;
    }
    fs::write(&resolved, content).map_err(|e| format!("Cannot write file '{}': {}", path, e))
}

// ── File operations ──────────────────────────────────────────────────

#[tauri::command]
pub async fn copy_file(source: String, dest: String) -> Result<(), String> {
    let src = safe_resolve(&source)?;
    let dst = safe_resolve(&dest)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create parent directory: {}", e))?;
    }
    fs::copy(&src, &dst)
        .map_err(|e| format!("Cannot copy '{}' to '{}': {}", source, dest, e))?;
    Ok(())
}

#[tauri::command]
pub async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let src = safe_resolve(&old_path)?;
    let dst = safe_resolve(&new_path)?;
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
    let resolved = safe_resolve(&path)?;
    if !resolved.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    // Use trash (recycle bin) instead of permanent deletion
    trash::delete(&resolved).map_err(|e| format!("Cannot delete '{}': {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let resolved = safe_resolve(&path)?;
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
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    let watch_key = canonical.to_string_lossy().to_string();

    let mut watchers = state.watchers.lock().await;
    watchers.remove(&watch_key);
    Ok(())
}

// ── File utilities ───────────────────────────────────────────────────

#[tauri::command]
pub async fn get_file_size(path: String) -> Result<u64, String> {
    let resolved = safe_resolve(&path)?;
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
    // Falls back to system temp if cwd is not set.
    let tmp = if let Some(ref dir) = cwd {
        reject_unsafe_path(dir)?;
        let p = std::path::PathBuf::from(dir)
            .join(".tokenicode")
            .join("tmp");
        if std::fs::create_dir_all(&p).is_ok() {
            // Ensure .tokenicode is gitignored in user's project
            let gitignore = std::path::PathBuf::from(dir)
                .join(".tokenicode")
                .join(".gitignore");
            if !gitignore.exists() {
                let _ = std::fs::write(&gitignore, "*\n");
            }
            p
        } else {
            std::env::temp_dir().join("tokenicode")
        }
    } else {
        std::env::temp_dir().join("tokenicode")
    };
    std::fs::create_dir_all(&tmp).map_err(|e| format!("Failed to create temp dir: {}", e))?;

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
