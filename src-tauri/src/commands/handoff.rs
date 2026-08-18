//! Task 01: cross-harness handoff.
//!
//! Two primitives for continuing an unfinished conversation on another
//! harness (Claude Code / Codex / DeepSeek-DSH):
//!
//! 1. `read_dsh_session_turns` — decode a DSH session log
//!    (`~/.dsh/sessions/<id>/session.jsonl.zstd`, multi-frame zstd) into
//!    unified turns (role + text + tool summaries + todos). Claude history is
//!    already readable via load_session; Codex history lives in chatStore
//!    memory. This closes the DSH read gap.
//! 2. `write_handoff_file` — persist the generated handoff brief into the
//!    project (`.tokenicode/handoff/*.md`), the "heavy channel" that every
//!    harness can read without blowing the context window.

use serde_json::{json, Value};
use std::io::Read;
use tauri::State;

/// Decode every zstd frame of a DSH session log into parsed event rows.
/// DSH appends one frame per write; ruzstd decodes one frame per
/// StreamingDecoder, so loop until the reader is exhausted (same strategy as
/// profile.rs::decode_dsh_session).
fn decode_dsh_session_lines(path: &std::path::Path) -> Result<Vec<Value>, String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开 DSH 会话日志: {}", e))?;
    let mut reader = std::io::BufReader::with_capacity(1024 * 1024, file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let mut decoder = match ruzstd::StreamingDecoder::new(&mut reader) {
            Ok(d) => d,
            Err(_) => break,
        };
        let mut chunk = [0u8; 128 * 1024];
        loop {
            match decoder.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break,
            }
        }
        let remaining = match reader.fill_buf() {
            Ok(r) => r.to_vec(),
            Err(_) => break,
        };
        if remaining.is_empty() {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut rows = Vec::new();
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            rows.push(v);
        }
    }
    Ok(rows)
}

/// Extract plain text from a DSH content-block array (text blocks only).
fn blocks_text(content: &Value) -> String {
    let mut out = String::new();
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
        }
    }
    out
}

/// Build unified turns + task state from DSH event rows.
fn build_unified_turns(rows: Vec<Value>) -> Value {
    let mut turns: Vec<Value> = Vec::new();
    let mut todos: Vec<Value> = Vec::new();
    let mut last_model = String::new();

    for row in rows {
        let etype = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let data = row.get("data");
        match etype {
            "user/message" => {
                let text = data
                    .and_then(|d| d.get("content"))
                    .map(blocks_text)
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    turns.push(json!({ "role": "user", "text": text }));
                }
            }
            "assistant/message" => {
                let message = data.and_then(|d| d.get("message"));
                let content = message.and_then(|m| m.get("content"));
                let text = content.map(blocks_text).unwrap_or_default();
                // Tool calls as compact summaries (name + truncated args)
                let mut tools: Vec<Value> = Vec::new();
                if let Some(arr) = content.and_then(|c| c.as_array()) {
                    for block in arr {
                        if block.get("type").and_then(|v| v.as_str()) == Some("tool-call") {
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let args = block
                                .get("arguments")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let summary: String = args.chars().take(300).collect();
                            tools.push(json!({ "name": name, "args": summary }));
                        }
                    }
                }
                if let Some(m) = message.and_then(|m| m.get("source")).and_then(|s| s.get("model")).and_then(|v| v.as_str()) {
                    last_model = m.to_string();
                }
                if !text.trim().is_empty() || !tools.is_empty() {
                    turns.push(json!({
                        "role": "assistant",
                        "text": text,
                        "tools": tools,
                    }));
                }
            }
            "todo/write" => {
                // Latest whole-list replacement wins (DSH todo lifetime rule)
                if let Some(arr) = data.and_then(|d| d.get("todos")).and_then(|t| t.as_array()) {
                    todos = arr
                        .iter()
                        .map(|t| {
                            json!({
                                "content": t.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                                "status": t.get("status").and_then(|v| v.as_str()).unwrap_or("pending"),
                            })
                        })
                        .collect();
                }
            }
            _ => {}
        }
    }

    json!({
        "backend": "deepseek",
        "turnCount": turns.len(),
        "turns": turns,
        "todos": todos,
        "model": last_model,
    })
}

/// Read a DSH session's history as unified turns.
/// `session_id` accepts either the LC tab id (desk_*, resolved through the
/// live mapping) or the DSH session id directly.
#[tauri::command]
pub async fn read_dsh_session_turns(
    process_mgr: State<'_, crate::commands::claude_process::ProcessManager>,
    session_id: String,
) -> Result<Value, String> {
    let dsh_sid = match process_mgr.get_deepseek_session(&session_id).await {
        Some(s) => s,
        None => session_id.clone(),
    };
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let path = home
        .join(".dsh")
        .join("sessions")
        .join(&dsh_sid)
        .join("session.jsonl.zstd");
    if !path.exists() {
        return Err(format!("DSH 会话日志不存在: {}", dsh_sid));
    }
    tokio::task::spawn_blocking(move || {
        let rows = decode_dsh_session_lines(&path)?;
        Ok(build_unified_turns(rows))
    })
    .await
    .map_err(|e| format!("DSH 会话读取任务失败: {}", e))?
}

/// Write a handoff brief into `<cwd>/.tokenicode/handoff/`. Returns the path.
/// The cwd must be an authorized root (registered project/workspace); the
/// file name is generated internally (timestamp-based, no user input).
#[tauri::command]
pub async fn write_handoff_file(cwd: String, content: String) -> Result<String, String> {
    let cwd_path = std::path::Path::new(&cwd);
    if !crate::commands::files::path_is_authorized(cwd_path) {
        return Err(format!("工作目录未授权，无法写入交接简报: {}", cwd));
    }
    const MAX_BRIEF_CHARS: usize = 200_000;
    if content.chars().count() > MAX_BRIEF_CHARS {
        return Err("交接简报过长（>200k 字符）".to_string());
    }
    let dir = cwd_path.join(".tokenicode").join("handoff");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let file = dir.join(format!("handoff-{}.md", stamp));
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("无法创建交接目录: {}", e))?;
        std::fs::write(&file, content).map_err(|e| format!("写入交接简报失败: {}", e))?;
        Ok(file.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("交接简报任务失败: {}", e))?
}
