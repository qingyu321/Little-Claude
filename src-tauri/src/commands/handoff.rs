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

/// Generic multi-frame zstd DSH decoder core.
///
/// DSH appends one zstd FRAME per write; ruzstd's StreamingDecoder decodes a
/// single frame per instance, so loop frame-by-frame until the underlying
/// reader is exhausted (same strategy as profile.rs::decode_dsh_session).
/// D1: factored out so both the full-file reader (`decode_dsh_session_lines`)
/// and the bounded list reader (`decode_dsh_session_head`) share one
/// implementation instead of copy-pasting the frame loop. A torn tail frame
/// (file being appended right now) or a truncated reader just ends the row
/// list early — callers keep whatever fully-decoded frames precede it.
fn decode_dsh_frames<R: std::io::Read>(reader: R) -> Vec<Value> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::with_capacity(1024 * 1024, reader);
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
    rows
}

/// Decode every zstd frame of a DSH session log into parsed event rows.
/// D1: pub(crate) so session.rs reuses this exact multi-frame decode path
/// instead of copy-pasting it.
pub(crate) fn decode_dsh_session_lines(path: &std::path::Path) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开 DSH 会话日志: {}", e))?;
    Ok(decode_dsh_frames(file))
}

/// D1: bounded variant — decode only the leading frames (at most `max_bytes`
/// of compressed input). Used by list_dsh_sessions: listing metadata (create
/// event with cwd/createdAt, first user message, early turns) sits at the HEAD
/// of the log, so an 11 MB session is not fully decoded just to appear in the
/// conversation list. Frames cut off by the byte cap are dropped cleanly.
pub(crate) fn decode_dsh_session_head(
    path: &std::path::Path,
    max_bytes: u64,
) -> Result<Vec<Value>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开 DSH 会话日志: {}", e))?;
    Ok(decode_dsh_frames(file.take(max_bytes)))
}

/// Extract plain text from a DSH content-block array (text blocks only).
/// D1: pub(crate) — reused by session.rs::list_dsh_sessions preview extraction.
pub(crate) fn blocks_text(content: &Value) -> String {
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
    // Fork-anchor support: the seq of the latest turn/end seen so far. When a
    // user turn is emitted, it carries this as `forkSeq` — the fork point
    // RIGHT BEFORE that turn (DSH forks at completed-turn boundaries). The
    // first user turn has none (DSH cannot fork to an empty session), which
    // mirrors the live-session anchor semantics (T02 known limitation).
    let mut last_turn_end_seq: Option<u64> = None;

    for row in rows {
        let etype = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let data = row.get("data");
        // D1: event timestamp (ms) — lets the conversation-list reload path
        // stamp ChatMessage entries with real times instead of Date.now().
        let time = row.get("time").and_then(|v| v.as_u64()).unwrap_or(0);
        match etype {
            "user/message" => {
                let text = data
                    .and_then(|d| d.get("content"))
                    .map(blocks_text)
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    let mut t = json!({ "role": "user", "text": text, "time": time });
                    if let Some(seq) = last_turn_end_seq {
                        t["forkSeq"] = json!(seq);
                    }
                    turns.push(t);
                }
            }
            "turn/end" => {
                // Record the completed-turn boundary seq for the next user
                // turn's fork anchor.
                if let Some(seq) = row.get("seq").and_then(|v| v.as_u64()) {
                    last_turn_end_seq = Some(seq);
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
                        "time": time,
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

/// Resolve the on-disk path of a DSH session log by session id.
///
/// Two layouts are handled:
///  1. flat:   ~/.dsh/sessions/<id>/session.jsonl.zstd (legacy fast path)
///  2. nested: ~/.dsh/sessions/<encoded-cwd>/<id>/session.jsonl.zstd
///     — the REAL layout (verified: every session.jsonl.zstd sits exactly one
///     level below a per-cwd directory). We scan the direct subdirs once.
/// Returns None when no layout matches.
pub(crate) fn resolve_dsh_session_log(
    home: &std::path::Path,
    dsh_sid: &str,
) -> Option<std::path::PathBuf> {
    let sessions_root = home.join(".dsh").join("sessions");
    // 1. flat fast path
    let flat = sessions_root.join(dsh_sid).join("session.jsonl.zstd");
    if flat.exists() {
        return Some(flat);
    }
    // 2. nested: scan the per-cwd dirs one level down
    if let Ok(entries) = std::fs::read_dir(&sessions_root) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(dsh_sid).join("session.jsonl.zstd");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
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
    // D1: handles both the flat and the real nested (<encoded-cwd>/<id>) layout.
    let path = resolve_dsh_session_log(&home, &dsh_sid)
        .ok_or_else(|| format!("DSH 会话日志不存在: {}", dsh_sid))?;
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

#[cfg(test)]
mod d1_handoff_tests {
    use super::{build_unified_turns, decode_dsh_session_lines, resolve_dsh_session_log};

    /// Local-machine verification (ignored on CI — needs ~/.dsh/sessions):
    /// the real DSH layout nests logs one level below a per-cwd dir, so the
    /// flat path alone would find nothing. Assert resolve + decode + turns all
    /// work end-to-end for every top-level session id on disk.
    #[test]
    #[ignore]
    fn resolve_and_decode_real_dsh_sessions() {
        let Some(home) = dirs::home_dir() else { return };
        let sessions_root = home.join(".dsh").join("sessions");
        if !sessions_root.is_dir() {
            return;
        }
        // Collect real (encoded-cwd, session-id) pairs from the nested layout.
        let mut ids: Vec<String> = Vec::new();
        if let Ok(l1) = std::fs::read_dir(&sessions_root) {
            for cwd_dir in l1.flatten() {
                let cwd_path = cwd_dir.path();
                if !cwd_path.is_dir() {
                    continue;
                }
                if let Ok(l2) = std::fs::read_dir(&cwd_path) {
                    for sid_dir in l2.flatten() {
                        if sid_dir.path().join("session.jsonl.zstd").exists() {
                            if let Some(name) = sid_dir.file_name().to_str() {
                                ids.push(name.to_string());
                            }
                        }
                    }
                }
            }
        }
        assert!(!ids.is_empty(), "no nested DSH sessions found on disk");

        let mut resolved = 0usize;
        let mut with_turns = 0usize;
        for id in &ids {
            let Some(path) = resolve_dsh_session_log(&home, id) else {
                panic!("resolve_dsh_session_log failed for nested session {}", id);
            };
            assert!(path.exists(), "resolved path does not exist: {}", path.display());
            resolved += 1;
            let rows = decode_dsh_session_lines(&path)
                .unwrap_or_else(|e| panic!("decode failed for {}: {}", path.display(), e));
            let unified = build_unified_turns(rows);
            let turn_count = unified.get("turnCount").and_then(|v| v.as_u64()).unwrap_or(0);
            if turn_count > 0 {
                with_turns += 1;
            }
            eprintln!("dsh {}: turns={} model={:?}", id, turn_count, unified.get("model"));
        }
        assert_eq!(resolved, ids.len(), "some sessions did not resolve");
        assert!(with_turns > 0, "no DSH session produced any turns");
    }
}
