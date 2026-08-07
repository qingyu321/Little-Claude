use rust_embed::RustEmbed;
#[cfg(feature = "video-analysis")]
use std::path::Path;

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
pub(crate) fn resolve_frontend_asset(path: &str) -> Option<(Vec<u8>, &'static str)> {
    // Normalize: strip leading slash, fall back to index.html for root
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

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
