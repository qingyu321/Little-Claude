use rust_embed::RustEmbed;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Embedded bundled skills — extracted directly to their final destination
/// (~/.claude/skills/) when no on-disk source is available.
///
/// `rust-embed` bakes all files under `resources/bundled-skills/` into the
/// binary at compile time, making the .exe fully self-contained.
#[cfg(feature = "video-analysis")]
#[derive(RustEmbed)]
#[folder = "resources/bundled-skills/"]
pub(crate) struct BundledSkills;

/// Embedded frontend SPA (Vite production build output).
/// In release mode, the entire React app is served directly from memory
/// via a custom URI scheme — no files are written to disk.
#[derive(RustEmbed)]
#[folder = "../dist/"]
pub(crate) struct FrontendAssets;

/// Resolve a frontend asset path to a (content_type, bytes) pair.
/// `path` is the URL path relative to the origin (e.g. "index.html", "assets/index-abc123.js").
///
/// 加载优先级（热更新支持）：
///   1) 磁盘资源树（~/.tokenicode/web-resources/ 版本指针指向的目录）——
///      指针一旦存在即为唯一来源（避免新旧 chunk 混用，hash 资源 404）
///   2) 嵌入资源（无热更时的默认）
pub(crate) fn resolve_frontend_asset(path: &str) -> Option<(Vec<u8>, &'static str)> {
    // Normalize: strip leading slash, fall back to index.html for root
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // 1) 磁盘资源树优先
    if let Some(dir) = current_web_resources_dir() {
        let rel = safe_asset_relative(path)?; // 无法安全化 → 404
        if let Some(entry) = disk_entry(&dir, &rel) {
            return Some(entry);
        }
        // SPA routing fallback → 磁盘树内的 index.html（不混用嵌入资源）
        return disk_entry(&dir, "index.html");
    }

    // 2) 嵌入资源（原逻辑）
    // Try exact path first
    if let Some(f) = FrontendAssets::get(path) {
        let mime = mime_for_path(path);
        return Some((f.data.to_vec(), mime));
    }
    // Try with "index.html" for directory-like paths (SPA routing fallback)
    if let Some(f) = FrontendAssets::get("index.html") {
        return Some((f.data.to_vec(), "text/html"));
    }
    None
}

// === 热更新磁盘资源（web-resources）===
// 目录结构（放在 safe_data_dir 下——NSIS 重装不清除，便携/安装版一致）：
//   ~/.tokenicode/web-resources/
//     current.json          ← 版本指针 { "version": "1.1.2", "dir": "dist-v1.1.2" }
//     dist-v1.1.2/          ← 当前生效的前端资源（index.html + assets/...）
//     dist-v1.1.2/          ← 上一版（保留用于回滚）
// 指针写入/切换由 commands/web_update.rs 的热更命令完成，此处只负责读取。

/// 热更新磁盘资源根目录。
pub(crate) fn web_resources_root() -> Option<PathBuf> {
    crate::safe_data_dir().ok().map(|d| d.join("web-resources"))
}

/// 当前生效磁盘资源目录的进程内缓存（命令热更成功后 refresh 失效重读）。
static WEB_RESOURCES_DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn web_resources_state() -> &'static Mutex<Option<PathBuf>> {
    WEB_RESOURCES_DIR.get_or_init(|| Mutex::new(None))
}

/// 读版本指针 current.json，返回当前磁盘资源目录；无热更/指针损坏 → None。
pub(crate) fn current_web_resources_dir() -> Option<PathBuf> {
    let state = web_resources_state();
    if let Ok(guard) = state.lock() {
        if let Some(dir) = guard.as_ref() {
            return Some(dir.clone());
        }
    }
    let root = web_resources_root()?;
    let text = std::fs::read_to_string(root.join("current.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let dir = json.get("dir")?.as_str()?;
    // 目录名必须是单个简单段（防指针注入穿越）
    let dir_path = Path::new(dir);
    if dir_path.is_absolute() || dir_path.components().count() != 1 {
        return None;
    }
    let full = root.join(dir_path);
    // 指针指向的树必须完整（index.html 存在）才生效
    if !full.join("index.html").is_file() {
        return None;
    }
    if let Ok(mut guard) = state.lock() {
        *guard = Some(full.clone());
    }
    Some(full)
}

/// 热更命令成功后使指针缓存失效（下次请求重新读磁盘）。
pub(crate) fn refresh_web_resources_dir() {
    if let Ok(mut guard) = web_resources_state().lock() {
        *guard = None;
    }
}

/// 从磁盘目录读取资源文件。
fn disk_entry(dir: &Path, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    let file = dir.join(rel);
    if !file.is_file() {
        return None;
    }
    let data = std::fs::read(&file).ok()?;
    Some((data, mime_for_path(rel)))
}

/// 资源路径安全化：拒绝 ".."、反斜杠、盘符/协议段，返回可安全 join 的相对路径。
fn safe_asset_relative(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    for seg in normalized.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return None,
            s if s.contains(':') => return None, // Windows 盘符 / URL scheme
            s => out.push(s),
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out.join("/"))
}

fn mime_for_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Extract one bundled skill's files from the embedded binary directly to
/// `dest_dir`. Creates the destination directory if it doesn't exist.
/// Only files belonging to `skill_name` (the top-level subdirectory inside
/// `bundled-skills/`) are extracted.
#[cfg(feature = "video-analysis")]
pub(crate) fn extract_skill_to(skill_name: &str, dest_dir: &Path) -> Result<(), String> {
    let prefix = format!("{}/", skill_name);

    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create {}: {}", dest_dir.display(), e))?;

    let mut extracted = 0usize;
    for item in BundledSkills::iter() {
        let rel_path = item.as_ref();
        if !rel_path.starts_with(&prefix) {
            continue;
        }

        let data = BundledSkills::get(rel_path)
            .ok_or_else(|| format!("Embedded file not found: {}", rel_path))?;

        // Strip the skill directory prefix to get the relative path inside dest_dir
        let relative = rel_path
            .strip_prefix(&prefix)
            .unwrap_or(rel_path)
            .trim_start_matches('/');

        let dest = if relative.is_empty() {
            continue; // skip the directory entry itself
        } else {
            dest_dir.join(relative)
        };

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
        }

        std::fs::write(&dest, &data.data)
            .map_err(|e| format!("Failed to write {}: {}", dest.display(), e))?;
        extracted += 1;
    }

    eprintln!(
        "[little-claude] Extracted {} files for embedded '{}' → {}",
        extracted,
        skill_name,
        dest_dir.display()
    );
    Ok(())
}
