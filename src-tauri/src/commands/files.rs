use notify::Watcher;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
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
    root.children = Some(read_dir_recursive(dir, 1, max_depth));
    Ok(vec![root])
}

fn read_dir_recursive(dir: &Path, current_depth: u32, max_depth: u32) -> Vec<FileNode> {
    let mut nodes = vec![];
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return nodes,
    };
    let mut entry_list: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    // Sort: directories first, then alphabetically
    entry_list.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        b_is_dir
            .cmp(&a_is_dir)
            .then(a.file_name().cmp(&b.file_name()))
    });
    for entry in entry_list {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files and node_modules
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let children = if is_dir && current_depth < max_depth {
            Some(read_dir_recursive(&path, current_depth + 1, max_depth))
        } else if is_dir {
            Some(vec![])
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
    let norm = path.to_string_lossy().replace('\\', "/").to_uppercase();
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

#[tauri::command]
pub async fn watch_directory(
    app: AppHandle,
    state: State<'_, WatcherManager>,
    path: String,
) -> Result<(), String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;
    let watch_key = canonical.to_string_lossy().to_string();

    let mut watchers = state.watchers.lock().await;
    if watchers.contains_key(&watch_key) {
        // 报告B5: the existing entry may be a dead watcher — when the watched
        // directory is deleted, notify stops delivering events and does NOT
        // auto-reconnect after the directory is recreated. Replace the entry
        // so re-watch after directory recreation actually re-establishes
        // monitoring (dropping the old watcher stops its listeners).
        watchers.remove(&watch_key);
    }

    let app_clone = app.clone();
    let watch_key_clone = watch_key.clone();
    let mut watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let payload = serde_json::json!({
                    "path": watch_key_clone,
                    "kind": format!("{:?}", event.kind),
                    "paths": event.paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
                });
                let _ = app_clone.emit("fs:change", payload);
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
