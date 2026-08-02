use serde_json::Value;
use std::collections::HashMap;

use crate::commands::session::decode_project_name;

#[tauri::command]
pub async fn export_session_markdown(
    path: String,
    output_path: String,
    conversation_only: bool,
) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);

    // 报告B6: stream to the output file instead of accumulating the whole
    // markdown in memory — a GB-scale session previously OOM'd or ballooned
    // memory during export. Only the current line's text lives in RAM now.
    let out = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output: {}", e))?;
    let mut writer = std::io::BufWriter::with_capacity(64 * 1024, out);
    writeln!(writer, "# Claude Code Session\n").map_err(|e| format!("Failed to write: {}", e))?;
    writeln!(writer, "*Exported from: {}*\n\n---\n\n", path)
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
}

#[tauri::command]
pub async fn export_session_json(path: String, output_path: String) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let file = std::fs::File::open(&path).map_err(|e| format!("Failed to open session: {}", e))?;
    let reader = std::io::BufReader::new(file);

    // 报告B6: stream the JSON array out line by line instead of collecting
    // every message and pretty-printing the whole array in memory. Output is
    // still a valid JSON array (compact form) — memory stays O(line size).
    let out = std::fs::File::create(&output_path)
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
