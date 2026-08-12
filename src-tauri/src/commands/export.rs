use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

use crate::commands::session::decode_project_name;

// ── Path safety (H1 fix) ─────────────────────────────────────────────
// Mirrors the protections already shipped in files.rs (reject_unsafe_path /
// is_system_dir) and session.rs (canonical ~/.claude/projects check). Those
// helpers are private to their modules, so minimal equivalents live here.
// WebView-supplied paths must never reach fs::File::open/create unvalidated:
// an injected frontend could otherwise read ~/.ssh/id_rsa or overwrite
// ~/.claude/credentials.json / providers.json.

/// Reject empty, NUL-containing, or `..`-traversing paths
/// (mirror of files.rs::reject_unsafe_path).
fn reject_unsafe_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".to_string());
    }
    if path.contains('\0') {
        return Err("路径包含非法字符 (NUL)".to_string());
    }
    for part in Path::new(path).components() {
        if let std::path::Component::ParentDir = part {
            return Err("路径包含越权访问 (..)".to_string());
        }
    }
    Ok(())
}

/// System-critical directories that export output must never touch.
/// Case-insensitive prefix match on '/'-normalized paths (mirror of
/// files.rs::is_system_dir).
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

/// Export output must never land in system dirs or app-private dirs
/// (~/.ssh, ~/.claude, ~/.tokenicode). The parent directory exists, so both
/// sides are canonicalized — a symlink cannot smuggle a write into a
/// blacklisted location.
fn reject_sensitive_output_dir(dir: &Path) -> Result<(), String> {
    if is_system_dir(dir) {
        return Err(format!("拒绝写入系统目录: {}", dir.display()));
    }
    if let Some(home) = dirs::home_dir() {
        let home_c = home.canonicalize().unwrap_or(home);
        // ~/.claude/projects/ is the CLI's session store AND the /export
        // slash command's default output location (InputBar writes .md/.json
        // beside the source JSONL there) — exporting into it is the product's
        // existing behavior, so the projects subtree is exempt from the
        // .claude blacklist. credentials.json / tokenicode_session_names.json
        // in the ~/.claude root remain blocked.
        let projects_c = home_c
            .join(".claude")
            .join("projects")
            .canonicalize()
            .unwrap_or_else(|_| home_c.join(".claude").join("projects"));
        if dir.starts_with(&projects_c) {
            return Ok(());
        }
        for name in [".ssh", ".claude", ".tokenicode"] {
            let target = home_c.join(name);
            let target_c = target.canonicalize().unwrap_or(target);
            if dir.starts_with(&target_c) {
                return Err(format!("拒绝写入敏感目录: {}", dir.display()));
            }
        }
    }
    Ok(())
}

/// Session source must be an existing file inside the canonical
/// ~/.claude/projects tree — the CLI's standard location for session JSONL
/// files (mirrors session.rs::load_session / delete_session). Blocks
/// arbitrary file reads.
fn resolve_session_source(path: &str) -> Result<std::path::PathBuf, String> {
    reject_unsafe_path(path)?;
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("会话文件不存在: {}", path));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("无法解析会话文件 '{}': {}", path, e))?;
    let home = dirs::home_dir().ok_or("无法定位用户主目录")?;
    let root_c = home
        .join(".claude")
        .join("projects")
        .canonicalize()
        .map_err(|e| format!("无法解析 ~/.claude/projects 目录: {}", e))?;
    if !canonical.starts_with(&root_c) {
        return Err(format!(
            "拒绝读取 ~/.claude/projects/ 之外的会话文件: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// Text-only extensions allowed for export output.
const ALLOWED_EXPORT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "json", "jsonl", "txt", "html", "htm", "csv", "log", "xml", "yaml", "yml",
];

/// Export output target: a plain file name (no separators), a text-only
/// extension from the whitelist, an already-existing parent directory, and
/// no system/private directories. Never creates directories on the user's
/// behalf.
fn resolve_output_target(output_path: &str) -> Result<std::path::PathBuf, String> {
    reject_unsafe_path(output_path)?;
    if output_path.ends_with('/') || output_path.ends_with('\\') {
        return Err("输出路径不能以路径分隔符结尾".to_string());
    }
    let p = Path::new(output_path);
    let file_name = p
        .file_name()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| format!("无效的输出文件名: {}", output_path))?;
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXPORT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "不允许的导出文件扩展名: '{}'（仅支持 md/markdown/json/txt/html 等文本格式）",
            if ext.is_empty() { "(无扩展名)" } else { &ext }
        ));
    }
    let parent = p
        .parent()
        .filter(|par| par.is_dir())
        .ok_or_else(|| format!("输出目录不存在: {}", output_path))?;
    let parent_c = parent
        .canonicalize()
        .map_err(|e| format!("无法解析输出目录 '{}': {}", parent.display(), e))?;
    reject_sensitive_output_dir(&parent_c)?;
    Ok(parent_c.join(file_name))
}

#[tauri::command]
pub async fn export_session_markdown(
    path: String,
    output_path: String,
    conversation_only: bool,
) -> Result<(), String> {
    // H1: validate both paths before any fs access — the source must be a
    // session file under the canonical ~/.claude/projects/ tree, the target
    // a plain text file in an existing, non-sensitive directory.
    let source = resolve_session_source(&path)?;
    let target = resolve_output_target(&output_path)?;
    // M8: the body is pure synchronous file IO (GB-scale sessions can take
    // seconds) — run it on the blocking pool, never a tokio worker.
    tokio::task::spawn_blocking(move || -> Result<(), String> {
    use std::io::{BufRead, Write};
    let file = std::fs::File::open(&source).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);

    // 报告B6: stream to the output file instead of accumulating the whole
    // markdown in memory — a GB-scale session previously OOM'd or ballooned
    // memory during export. Only the current line's text lives in RAM now.
    let out = std::fs::File::create(&target)
        .map_err(|e| format!("Failed to create output: {}", e))?;
    let mut writer = std::io::BufWriter::with_capacity(64 * 1024, out);
    writeln!(writer, "# Claude Code Session\n").map_err(|e| format!("Failed to write: {}", e))?;
    writeln!(writer, "*Exported from: {}*\n\n---\n\n", source.display())
        .map_err(|e| format!("Failed to write: {}", e))?;

    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                let msg_type = json["type"].as_str().unwrap_or("");
                match msg_type {
                    "user" | "human" => {
                        let mut text_buf = String::new();
                        let content = &json["message"]["content"];
                        if let Some(text) = content.as_str() {
                            text_buf.push_str(text);
                            text_buf.push_str("\n\n");
                        } else if let Some(arr) = content.as_array() {
                            for block in arr {
                                if let Some(text) = block["text"].as_str() {
                                    text_buf.push_str(text);
                                    text_buf.push_str("\n\n");
                                }
                            }
                        }
                        if !conversation_only || !text_buf.trim().is_empty() {
                            writer
                                .write_all(b"## User\n\n")
                                .map_err(|e| format!("Failed to write: {}", e))?;
                            writer
                                .write_all(text_buf.as_bytes())
                                .map_err(|e| format!("Failed to write: {}", e))?;
                        }
                    }
                    "assistant" => {
                        let mut has_text = false;
                        let mut text_buf = String::new();
                        if let Some(content) = json["message"]["content"].as_array() {
                            for block in content {
                                if block["type"].as_str() == Some("text") {
                                    if let Some(text) = block["text"].as_str() {
                                        has_text = true;
                                        text_buf.push_str(text);
                                        text_buf.push_str("\n\n");
                                    }
                                } else if !conversation_only
                                    && block["type"].as_str() == Some("tool_use")
                                {
                                    let name = block["name"].as_str().unwrap_or("Tool");
                                    text_buf.push_str(&format!("**Tool: {}**\n\n", name));
                                    if let Some(input) = block.get("input") {
                                        text_buf.push_str("```json\n");
                                        text_buf.push_str(
                                            &serde_json::to_string_pretty(input)
                                                .unwrap_or_default(),
                                        );
                                        text_buf.push_str("\n```\n\n");
                                    }
                                }
                            }
                        }
                        if !conversation_only || has_text {
                            writer
                                .write_all(b"## Assistant\n\n")
                                .map_err(|e| format!("Failed to write: {}", e))?;
                            writer
                                .write_all(text_buf.as_bytes())
                                .map_err(|e| format!("Failed to write: {}", e))?;
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Flush buffered output (also surfaces late write errors)
    writer.flush().map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}

#[tauri::command]
pub async fn export_session_json(path: String, output_path: String) -> Result<(), String> {
    // H1: validate both paths before any fs access (see export_session_markdown).
    let source = resolve_session_source(&path)?;
    let target = resolve_output_target(&output_path)?;
    // M8: synchronous file IO on the blocking pool (see export_session_markdown).
    tokio::task::spawn_blocking(move || -> Result<(), String> {
    use std::io::{BufRead, Write};
    let file = std::fs::File::open(&source).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);

    // 报告B6: stream the JSON array out line by line instead of collecting
    // every message and pretty-printing the whole array in memory. Output is
    // still a valid JSON array (compact form) — memory stays O(line size).
    let out = std::fs::File::create(&target)
        .map_err(|e| format!("Failed to create output: {}", e))?;
    let mut writer = std::io::BufWriter::with_capacity(64 * 1024, out);
    writer.write_all(b"[").map_err(|e| format!("Failed to write: {}", e))?;

    let mut first = true;
    for line in reader.lines() {
        if let Ok(line) = line {
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                if !first {
                    writer
                        .write_all(b",")
                        .map_err(|e| format!("Failed to write: {}", e))?;
                }
                first = false;
                serde_json::to_writer(&mut writer, &json)
                    .map_err(|e| format!("Failed to serialize: {}", e))?;
            }
        }
    }

    writer.write_all(b"]").map_err(|e| format!("Failed to write: {}", e))?;
    writer.flush().map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}

/// List recent projects by scanning ~/.claude/projects/ directory names
#[tauri::command]
pub async fn list_recent_projects() -> Result<Vec<Value>, String> {
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let mut projects: HashMap<String, u64> = HashMap::new();

    if let Ok(entries) = std::fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                let _decoded = decode_project_name(&dir_name);
                // Get the actual path (not the shortened ~/ version)
                let actual_path = dir_name.replace('-', "/");

                // Find the most recent session file in this project
                let mut latest: u64 = 0;
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        if let Ok(meta) = file.metadata() {
                            if let Ok(modified) = meta.modified() {
                                if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                                    latest = latest.max(dur.as_millis() as u64);
                                }
                            }
                        }
                    }
                }

                // Only include if the actual directory exists
                if std::path::Path::new(&actual_path).exists() {
                    projects.insert(actual_path.clone(), latest);
                }
            }
        }
    }

    let mut result: Vec<Value> = projects
        .into_iter()
        .map(|(path, ts)| {
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let short_path = {
                if let Some(home) = dirs::home_dir() {
                    let home_str = home.to_string_lossy().to_string();
                    if path.starts_with(&home_str) {
                        format!("~{}", &path[home_str.len()..])
                    } else {
                        path.clone()
                    }
                } else {
                    path.clone()
                }
            };
            serde_json::json!({
                "name": name,
                "path": path,
                "shortPath": short_path,
                "lastUsed": ts,
            })
        })
        .collect();

    result.sort_by(|a, b| {
        let ta = a["lastUsed"].as_u64().unwrap_or(0);
        let tb = b["lastUsed"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    // TK-321: Keep only the 4 most recent projects
    result.truncate(4);

    Ok(result)
}
