use serde_json::Value;

/// Returns matching sessions with snippets, sorted by match_count descending (max 50).
#[tauri::command]
/// Search session content with optional role filter.
/// role_filter: "user" | "assistant" | null (search both)
pub async fn search_sessions(query: String, role_filter: Option<String>) -> Result<Vec<Value>, String> {
    if query.len() < 2 {
        return Ok(vec![]);
    }
    // M8: the body scans every tracked session JSONL synchronously (can take
    // hundreds of ms on large histories) — run it on the blocking pool.
    tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let claude_dir = home.join(".claude").join("projects");

    if !claude_dir.exists() {
        return Ok(vec![]);
    }

    let tracked = crate::commands::session::load_tracked_sessions();
    let query_lower = query.to_lowercase();
    let role_filter_lower = role_filter.map(|r| r.to_lowercase());

    let mut results: Vec<Value> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for file in files.flatten() {
                        let path = file.path();
                        if path.extension().map_or(false, |e| e == "jsonl") {
                            if let Some(name) = path.file_stem() {
                                let id = name.to_string_lossy().to_string();
                                if !tracked.contains(&id) {
                                    continue;
                                }

                                // Get session metadata (preview, project, origin)
                                // (报告B4: cache-aware — unchanged files skip the re-read)
                                let (preview, cwd, origin) =
                                    crate::commands::session::extract_session_info_cached(&path);
                                let project_dir = entry.file_name().to_string_lossy().to_string();
                                let project = if cwd.is_empty() {
                                    crate::commands::session::decode_project_name(&project_dir)
                                } else {
                                    cwd
                                };
                                let modified = std::fs::metadata(&path)
                                    .and_then(|m| m.modified())
                                    .ok()
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);

                                if let Some(result) = search_session_file(
                                    &path,
                                    &query_lower,
                                    role_filter_lower.as_deref(),
                                ) {
                                    results.push(serde_json::json!({
                                        "session_id": id,
                                        "project": project,
                                        "project_dir": project_dir,
                                        "preview": preview,
                                        "modified_at": modified,
                                        "origin": if origin.is_empty() { "claude".to_string() } else { origin },
                                        "user_match_count": result.user_count,
                                        "assistant_match_count": result.assistant_count,
                                        "user_snippets": result.user_snippets,
                                        "assistant_snippets": result.assistant_snippets,
                                        "user_match_indices": result.user_match_indices,
                                        "assistant_match_indices": result.assistant_match_indices,
                                    }));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by total match count descending, then by modified time descending
    results.sort_by(|a, b| {
        let ca = a["user_match_count"].as_u64().unwrap_or(0)
            + a["assistant_match_count"].as_u64().unwrap_or(0);
        let cb = b["user_match_count"].as_u64().unwrap_or(0)
            + b["assistant_match_count"].as_u64().unwrap_or(0);
        let by_count = cb.cmp(&ca);
        if by_count != std::cmp::Ordering::Equal {
            return by_count;
        }
        let ta = a["modified_at"].as_u64().unwrap_or(0);
        let tb = b["modified_at"].as_u64().unwrap_or(0);
        tb.cmp(&ta)
    });

    results.truncate(50);
    Ok(results)
    })
    .await
    .map_err(|e| format!("Search task panicked: {}", e))?
}

pub struct SessionSearchResult {
    user_count: u64,
    assistant_count: u64,
    user_snippets: Vec<String>,
    assistant_snippets: Vec<String>,
    user_match_indices: Vec<usize>,
    assistant_match_indices: Vec<usize>,
}

/// Extract a snippet around the first occurrence of query in text.
pub fn extract_snippet(full_text: &str, full_text_lower: &str, query_lower: &str) -> String {
    let chars: Vec<char> = full_text_lower.chars().collect();
    let query_len = query_lower.chars().count();
    if let Some(char_pos) = chars
        .windows(query_len)
        .position(|w| w.iter().collect::<String>() == query_lower)
    {
        let original_chars: Vec<char> = full_text.chars().collect();
        let total_chars = original_chars.len();
        let start = if char_pos > 60 { char_pos - 60 } else { 0 };
        let end = std::cmp::min(total_chars, char_pos + query_len + 60);
        let mut snippet: String = original_chars[start..end].iter().collect();
        if start > 0 { snippet = format!("...{}", snippet); }
        if end < total_chars { snippet = format!("{}...", snippet); }
        snippet
    } else {
        // Fallback: truncate to ~120 chars
        let original_chars: Vec<char> = full_text.chars().collect();
        let total_chars = original_chars.len();
        if total_chars > 120 {
            let mut s: String = original_chars[..120].iter().collect();
            s.push_str("...");
            s
        } else {
            full_text.to_string()
        }
    }
}

/// Extract text from content blocks (assistant-style array format).
/// Skips tool_use, tool_result, thinking, and image blocks.
pub fn extract_text_blocks(blocks: &[Value], text_parts: &mut Vec<String>) {
    for block in blocks {
        let block_type = block["type"].as_str().unwrap_or("");
        if block_type == "tool_result"
            || block_type == "tool_use"
            || block_type == "thinking"
            || block_type == "image"
        {
            continue;
        }
        if block_type == "text" {
            if let Some(text) = block["text"].as_str() {
                text_parts.push(text.to_string());
            }
        }
    }
}

/// Search a single session JSONL file. Returns per-role match counts, snippets, and message indices.
/// role_filter: None = search both roles, Some("user") = user only, Some("assistant") = assistant only.
pub fn search_session_file(
    path: &std::path::Path,
    query_lower: &str,
    role_filter: Option<&str>,
) -> Option<SessionSearchResult> {
    use std::io::BufRead;

    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut user_count: u64 = 0;
    let mut assistant_count: u64 = 0;
    let mut user_snippets: Vec<String> = Vec::new();
    let mut assistant_snippets: Vec<String> = Vec::new();
    let mut user_match_indices: Vec<usize> = Vec::new();
    let mut assistant_match_indices: Vec<usize> = Vec::new();
    let mut user_turn: usize = 0; // 1-based - which user message this belongs to
    const MAX_SNIPPETS: usize = 5;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        // Skip non-message lines (quick pre-filter to avoid JSON parsing overhead)
        if !line.contains("\"type\":\"user\"")
            && !line.contains("\"type\":\"human\"")
            && !line.contains("\"type\":\"assistant\"")
            && !line.contains("\"type\": \"user\"")
            && !line.contains("\"type\": \"human\"")
            && !line.contains("\"type\": \"assistant\"")
            && !line.contains("\"role\":\"user\"")
            && !line.contains("\"role\":\"assistant\"")
            && !line.contains("\"role\": \"user\"")
            && !line.contains("\"role\": \"assistant\"")
        {
            continue;
        }

        let obj: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Determine role
        let role = if obj["type"].as_str() == Some("human")
            || obj["type"].as_str() == Some("user")
            || obj["message"]["role"].as_str() == Some("user")
        {
            "user"
        } else if obj["type"].as_str() == Some("assistant")
            || obj["message"]["role"].as_str() == Some("assistant")
        {
            "assistant"
        } else {
            continue;
        };

        // Apply role filter
        if let Some(filter) = role_filter {
            if role != filter {
                continue;
            }
        }

        // Skip meta and sidechain messages
        if obj["isMeta"].as_bool() == Some(true) || obj["isSidechain"].as_bool() == Some(true) {
            continue;
        }

        // Track user turn number - increment BEFORE text extraction for accurate indexing
        if role == "user" {
            user_turn += 1;
        }

        // Extract text from content - handles both array format (assistant)
        // and plain string format (user messages)
        let mut text_parts: Vec<String> = Vec::new();

        // Try top-level content first (array or string)
        if let Some(arr) = obj["content"].as_array() {
            extract_text_blocks(arr, &mut text_parts);
        } else if let Some(s) = obj["content"].as_str() {
            text_parts.push(s.to_string());
        }

        // Try message.content (array or string)
        if let Some(arr) = obj["message"]["content"].as_array() {
            extract_text_blocks(arr, &mut text_parts);
        } else if let Some(s) = obj["message"]["content"].as_str() {
            text_parts.push(s.to_string());
        }

        let full_text = text_parts.join(" ");
        let full_text_lower = full_text.to_lowercase();

        if !full_text_lower.contains(query_lower) {
            continue;
        }

        // Increment per-role counter and collect snippets
        if role == "user" {
            user_count += 1;
            if user_snippets.len() < MAX_SNIPPETS {
                let snippet = extract_snippet(&full_text, &full_text_lower, query_lower);
                user_snippets.push(snippet);
                user_match_indices.push(user_turn);
            }
        } else {
            assistant_count += 1;
            if assistant_snippets.len() < MAX_SNIPPETS {
                let snippet = extract_snippet(&full_text, &full_text_lower, query_lower);
                assistant_snippets.push(snippet);
                assistant_match_indices.push(user_turn);
            }
        }
    }

    if user_count > 0 || assistant_count > 0 {
        Some(SessionSearchResult {
            user_count,
            assistant_count,
            user_snippets,
            assistant_snippets,
            user_match_indices,
            assistant_match_indices,
        })
    } else {
        None
    }
}
