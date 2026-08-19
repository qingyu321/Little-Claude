use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Default, Serialize, Clone)]
struct ProfileDailyStats {
    date: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_tokens: u64,
    total_tokens: u64,
    message_count: u64,
}

#[derive(Default, Serialize, Clone)]
struct ProfileModelStats {
    model: String,
    total_tokens: u64,
    message_count: u64,
}

fn usage_u64(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Full-input-token semantics shared with the frontend's
/// `semanticContextTokens` (src/lib/context-tokens.ts). The two endpoint
/// families report input_tokens differently:
///  - Anthropic official: input_tokens is the UNCACHED remainder — full
///    context = input + cacheRead + cacheCreation.
///  - DeepSeek / OpenAI-compatible endpoints (incl. this app's OpenAI→
///    Anthropic conversion proxy and the DSH backend): input_tokens is the
///    FULL context, ALREADY including cache hits/writes. Verified on 96/96
///    usage-log records (5 sessions): input == cache_read + cache_creation
///    holds exactly, so summing the three fields double-counts (~140K shown
///    for a real ~70K context).
/// Detection from the numbers: when the cached share is non-zero and input
/// alone covers it, input IS the full context.
fn semantic_full_input(input: u64, cache: u64) -> u64 {
    if cache > 0 && input >= cache {
        input
    } else {
        input + cache
    }
}

/// Total tokens for one turn under the semantic rule: full input + output.
fn semantic_total(input: u64, cache: u64, output: u64) -> u64 {
    semantic_full_input(input, cache) + output
}

fn cache_creation_tokens(usage: &Value) -> u64 {
    let top_level = usage_u64(usage, "cache_creation_input_tokens");
    let nested = usage
        .get("cache_creation")
        .map(|v| {
            usage_u64(v, "ephemeral_1h_input_tokens") + usage_u64(v, "ephemeral_5m_input_tokens")
        })
        .unwrap_or(0);
    // The Claude CLI reports cache-creation tokens BOTH at the top level
    // (usage.cache_creation_input_tokens) and inside the nested
    // usage.cache_creation object — they are the same value in two
    // representations, so summing them double-counts (observed: identical
    // numbers in both slots on real sessions). Prefer the top-level value;
    // fall back to the nested object only for older CLI snapshots that wrote
    // only the nested form.
    if top_level > 0 {
        top_level
    } else {
        nested
    }
}

/// Convert an RFC3339 timestamp (UTC or with offset, optional fractional
/// seconds — the format used by both the Claude CLI JSONL and Little Claude's
/// own usage log) into a LOCAL calendar date string (YYYY-MM-DD).
///
/// The profile UI groups by local date; taking the raw first 10 characters
/// would split days on UTC midnight, shifting late-evening/early-morning
/// requests across day boundaries (e.g. 00:00–02:00 local lands on the
/// previous UTC day). Falls back to the raw prefix on parse failure.
fn local_date_from_timestamp(ts: &str) -> String {
    // RFC3339 (Claude CLI JSONL + frontend usage-log records).
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
        return dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();
    }
    // Unix seconds — the Anthropic→OpenAI conversion proxy persisted
    // SystemTime::now().as_secs() as a plain integer string. Parsing it as
    // RFC3339 fails, and the raw-prefix fallback would slice the digits
    // (1786584107 → "1786584107") producing a garbage bucket instead of a
    // date. Bucket by the local calendar day of that epoch.
    if let Ok(secs) = ts.trim().parse::<i64>() {
        if secs > 0 && secs < 4_102_444_800 {
            // 2100-01-01 — sane upper bound for unix seconds.
            if let Some(dt) = chrono::DateTime::from_timestamp(secs, 0) {
                return dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string();
            }
        }
    }
    ts.get(0..10).unwrap_or("unknown").to_string()
}

/// Path to Little Claude's own usage log (append-only NDJSON).
/// One file per machine, shared across all sessions -- keyed by date + session + message id.
/// This is the durability layer that makes token stats correct even when the Claude CLI
/// writes zero/missing usage values to its own JSONL files.
fn tokenicode_usage_log_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(crate::safe_data_dir_name()).join("usage_log.jsonl")
}

/// Append a single usage record to Little Claude's usage log.
/// Called by the frontend after each turn's `result` event (authoritative token counts).
/// Idempotent: `get_profile_stats` dedupes by (session_id, message_id).
#[tauri::command]
pub fn append_usage_record(
    session_id: String,
    message_id: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    model: String,
    timestamp: String,
) -> Result<(), String> {
    append_usage_record_impl(
        &session_id,
        &message_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        &model,
        &timestamp,
    )
}

/// Non-command implementation so the Anthropic→OpenAI conversion proxy can
/// persist usage directly (the proxy knows the full OpenAI usage incl. cache,
/// which the CLI drops from message_delta). Same format as the command.
pub fn append_usage_record_impl(
    session_id: &str,
    message_id: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    model: &str,
    timestamp: &str,
) -> Result<(), String> {
    use std::io::Write as _;

    let path = tokenicode_usage_log_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let record = serde_json::json!({
        "session_id": session_id,
        "message_id": message_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_creation_tokens": cache_creation_tokens,
        "model": model,
        "timestamp": timestamp,
    });

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", record).map_err(|e| e.to_string())
}

/// Merge Little Claude's own usage log into the in-memory daily/model accumulators.
/// Reads the append-only NDJSON log, dedupes by (session_id, message_id), and adds
/// each record's tokens to the same `daily`/`models` maps that the JSONL scan uses.
///
/// `jsonl_counted_uuids` is the set of turn-level `value.uuid` / `message.id`
/// strings that the JSONL scan already counted WITH reliable input tokens
/// (input_tokens > 0). Records whose `message_id` is in that set are skipped.
///
/// `jsonl_zero_input_ids` is the set for turns the JSONL counted but whose
/// input tokens were 0 (OpenAI-compat proxy path: message_start carried no
/// input). Records there SUPPLEMENT input + cache (output already counted).
fn merge_usage_log_into(
    jsonl_counted_uuids: &HashSet<String>,
    jsonl_zero_input_ids: &HashSet<String>,
    daily: &mut HashMap<String, ProfileDailyStats>,
    models: &mut HashMap<String, ProfileModelStats>,
    total_input: &mut u64,
    total_output: &mut u64,
    total_cache: &mut u64,
    total_semantic: &mut u64,
    message_count: &mut u64,
) {
    use std::io::BufRead as _;

    let path = tokenicode_usage_log_path();
    let Ok(file) = std::fs::File::open(&path) else {
        return;
    };
    let mut seen: HashSet<String> = HashSet::new();
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // No session filter: the usage log is this machine's own append-only
        // record of every turn's authoritative token counts (session ids in
        // the log are Little Claude's internal desk_* ids — they are NOT the
        // CLI jsonl filenames, so a tracked-session filter would drop every
        // record). Dedup happens by (message_id) against the JSONL scan.
        let message_id = value
            .get("message_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if message_id.is_empty() || !seen.insert(message_id.clone()) {
            continue; // dedup within the usage log itself
        }
        // Skip turns the JSONL scan already counted with full (non-zero) input.
        // The frontend persists the assistant message id (msg_*) as
        // `message_id`, which matches the JSONL `message.id` dedup key used
        // by the scan — without this check the same turn would be counted
        // twice.
        if jsonl_counted_uuids.contains(&message_id) {
            continue;
        }
        let input_tokens = usage_u64(&value, "input_tokens");
        let output_tokens = usage_u64(&value, "output_tokens");
        let cache_read = usage_u64(&value, "cache_read_tokens");
        let cache_creation = usage_u64(&value, "cache_creation_tokens");
        let cache_tokens = cache_read + cache_creation;
        // S-sem: DeepSeek/OpenAI-compat endpoints report input_tokens already
        // containing the cached share — summing all three double-counts.
        // The totals/daily/model aggregates use the semantic rule; the
        // input/output/cache detail columns keep their raw values.
        let total_tokens = semantic_total(input_tokens, cache_tokens, output_tokens);
        if total_tokens == 0 {
            continue;
        }

        // Decide what to contribute:
        //  - JSONL counted this turn but only output (input was 0 on the proxy
        //    path) → supplement input + cache; output is already in the JSONL.
        //  - otherwise (JSONL didn't count it at all) → full contribution.
        let (add_input, add_output, add_cache, add_msg) =
            if jsonl_zero_input_ids.contains(&message_id) {
                (input_tokens, 0u64, cache_tokens, false)
            } else {
                (input_tokens, output_tokens, cache_tokens, true)
            };
        if add_input == 0 && add_output == 0 && add_cache == 0 {
            continue;
        }

        *total_input += add_input;
        *total_output += add_output;
        *total_cache += add_cache;
        // Semantic total of what THIS record contributes (cache double-count
        // removed for DeepSeek-style records).
        *total_semantic += semantic_total(add_input, add_cache, add_output);
        if add_msg {
            *message_count += 1;
        }

        // Local calendar date — same rule as the JSONL scan below.
        let date = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(local_date_from_timestamp)
            .unwrap_or_else(|| "unknown".to_string());
        let entry = daily
            .entry(date.clone())
            .or_insert_with(|| ProfileDailyStats {
                date,
                ..Default::default()
            });
        entry.input_tokens += add_input;
        entry.output_tokens += add_output;
        entry.cache_tokens += add_cache;
        entry.total_tokens += semantic_total(add_input, add_cache, add_output);
        if add_msg {
            entry.message_count += 1;
        }

        if let Some(model) = value.get("model").and_then(|v| v.as_str()) {
            let model_entry =
                models
                    .entry(model.to_string())
                    .or_insert_with(|| ProfileModelStats {
                        model: model.to_string(),
                        ..Default::default()
                    });
            model_entry.total_tokens += semantic_total(add_input, add_cache, add_output);
            if add_msg {
                model_entry.message_count += 1;
            }
        }
    }
}

// ── DSH usage sync ────────────────────────────────────────────────────────
// DSH-GUI-direct sessions never pass through the Little Claude frontend, so
// their usage never reaches usage_log automatically. Every get_profile_stats
// run therefore scans ~/.dsh/sessions/**/session.jsonl.zstd (multi-frame
// zstd, one frame per append) for assistant/message usage records and appends
// any unseen message ids — profile numbers keep moving even for sessions
// started outside Little Claude. Files whose (mtime, size) are unchanged
// since the last sync are skipped (incremental).

static DSH_SYNC_STATE: std::sync::OnceLock<
    std::sync::Mutex<HashMap<std::path::PathBuf, (u128, u64)>>,
> = std::sync::OnceLock::new();

fn dsh_sync_state() -> &'static std::sync::Mutex<HashMap<std::path::PathBuf, (u128, u64)>> {
    DSH_SYNC_STATE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Decode one DSH session file (multi-frame zstd) and return per-assistant-
/// message usage rows: (message_id, input, output, cache_read, cache_creation,
/// model, unix_secs). A file being appended to right now may end in a partial
/// frame — frames already fully written are kept, only the torn tail is lost
/// (it will be picked up on the next sync once the file's mtime changes).
fn decode_dsh_session(
    path: &std::path::Path,
) -> Result<Vec<(String, u64, u64, u64, u64, String, i64)>, String> {
    use std::io::{BufRead, Read};

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    // DSH appends one zstd FRAME per write; ruzstd's Read impl decodes a
    // single frame per StreamingDecoder, so loop frame-by-frame until the
    // underlying reader is exhausted.
    let mut reader = std::io::BufReader::with_capacity(1024 * 1024, file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let mut decoder = match ruzstd::StreamingDecoder::new(&mut reader) {
            Ok(d) => d,
            Err(_) => break, // torn tail / corrupt frame — keep what we have
        };
        let mut chunk = [0u8; 128 * 1024];
        loop {
            match decoder.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(_) => break, // frame error mid-way — keep what we have
            }
        }
        let remaining = match reader.fill_buf() {
            Ok(r) => r.to_vec(),
            Err(_) => break,
        };
        if remaining.is_empty() {
            break; // no more frames
        }
    }
    let text = String::from_utf8_lossy(&buf);

    let mut rows = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant/message") {
            continue;
        }
        let data = v.get("data").cloned().unwrap_or_default();
        let Some(mid) = data
            .pointer("/message/id")
            .and_then(|x| x.as_str())
            .map(String::from)
        else {
            continue;
        };
        let Some(usage) = data.get("usage").filter(|u| u.is_object()) else {
            continue;
        };
        let inp = usage.get("inputTokens").and_then(|x| x.as_u64()).unwrap_or(0);
        let out = usage.get("outputTokens").and_then(|x| x.as_u64()).unwrap_or(0);
        let cr = usage.get("cacheReadTokens").and_then(|x| x.as_u64()).unwrap_or(0);
        let cc = usage.get("cacheCreationTokens").and_then(|x| x.as_u64()).unwrap_or(0);
        if inp + out + cr + cc == 0 {
            continue;
        }
        let model = data
            .pointer("/message/source/model")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let ts = v
            .get("time")
            .and_then(|x| x.as_u64())
            .map(|t| (t / 1000) as i64)
            .unwrap_or(0);
        rows.push((mid, inp, out, cr, cc, model, ts));
    }
    Ok(rows)
}

/// Scan all DSH sessions and append unseen usage records to usage_log.
/// Returns the number of records added. Incremental via (mtime, size) cache.
fn sync_dsh_usage_impl() -> usize {
    let Some(home) = dirs::home_dir() else {
        return 0;
    };
    let root = home.join(".dsh").join("sessions");
    if !root.is_dir() {
        return 0;
    }

    // Existing message ids (dedup key).
    let mut seen: HashSet<String> = HashSet::new();
    let log_path = tokenicode_usage_log_path();
    if let Ok(file) = std::fs::File::open(&log_path) {
        use std::io::BufRead as _;
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(mid) = v.get("message_id").and_then(|x| x.as_str()) {
                    seen.insert(mid.to_string());
                }
            }
        }
    }

    // Walk sessions tree for session.jsonl.zstd files.
    let mut additions: Vec<String> = Vec::new();
    let mut new_state: HashMap<std::path::PathBuf, (u128, u64)> = HashMap::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.file_name().and_then(|n| n.to_str()) != Some("session.jsonl.zstd") {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&p) else {
                continue;
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let size = meta.len();
            // Incremental: skip unchanged files (keep them in the new state).
            if let Ok(guard) = dsh_sync_state().lock() {
                if guard.get(&p) == Some(&(mtime, size)) {
                    new_state.insert(p.clone(), (mtime, size));
                    continue;
                }
            }
            let rows = match decode_dsh_session(&p) {
                Ok(r) => r,
                Err(_) => {
                    // Partial frame (session being written right now) — skip.
                    continue;
                }
            };
            let session_id = p
                .parent()
                .and_then(|d| d.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            for (mid, inp, out, cr, cc, model, ts) in rows {
                if mid.is_empty() || !seen.insert(mid.clone()) {
                    continue;
                }
                let rec = serde_json::json!({
                    "session_id": session_id,
                    "message_id": mid,
                    "input_tokens": inp,
                    "output_tokens": out,
                    "cache_read_tokens": cr,
                    "cache_creation_tokens": cc,
                    "model": model,
                    "timestamp": ts.to_string(),
                });
                additions.push(rec.to_string());
            }
            new_state.insert(p.clone(), (mtime, size));
        }
    }

    if !additions.is_empty() {
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            use std::io::Write as _;
            for line in &additions {
                let _ = writeln!(file, "{}", line);
            }
        }
    }
    if let Ok(mut guard) = dsh_sync_state().lock() {
        *guard = new_state;
    }
    additions.len()
}

#[tauri::command]
pub fn sync_dsh_usage() -> Result<usize, String> {
    Ok(sync_dsh_usage_impl())
}

#[tauri::command]
pub async fn get_profile_stats() -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let claude_dir = home.join(".claude").join("projects");
    // DSH-GUI-direct sessions: sync their usage into usage_log first so the
    // stats below include everything (incremental, cheap when unchanged).
    // #17 (perf): the sync itself walks ~/.dsh/sessions + decodes zstd —
    // it must not run on the async executor either.
    tokio::task::spawn_blocking(sync_dsh_usage_impl)
        .await
        .map_err(|e| format!("DSH usage sync task failed: {}", e))?;

    // NOTE: no early return when ~/.claude/projects is missing — pure-DeepSeek
    // machines have no Claude CLI data, but the usage log (frontend-persisted
    // + the DSH sync just performed) is still authoritative. scan_profile_stats
    // already tolerates a missing dir (read_dir error → empty scan) and then
    // merges the usage log, so all-zero stats only occur when there is truly
    // nothing to count.

    // The full scan now covers EVERY session jsonl under ~/.claude/projects
    // (cc-switch style: all machine-wide Claude Code usage, including CLI
    // sessions started in a terminal), so it can be thousands of files and
    // hundreds of MB — never run that on the async executor. spawn_blocking
    // keeps the Tauri main thread responsive while the scan runs.
    let mut stats: Value =
        tokio::task::spawn_blocking(move || scan_profile_stats(&claude_dir))
            .await
            .map_err(|e| format!("Profile stats task failed: {}", e))?
            .map_err(|e| format!("Profile stats scan failed: {}", e))?;

    // DSH sessions have no ~/.claude/projects JSONL, so the scan's
    // `counted_sessions` never sees them. Add the DSH session count so the
    // "会话总数" line reflects DeepSeek-only users too.
    let dsh_count = count_dsh_sessions(&home.join(".dsh"));
    if dsh_count > 0 {
        if let Some(obj) = stats.as_object_mut() {
            let cur = obj.get("sessionCount").and_then(|v| v.as_u64()).unwrap_or(0);
            obj["sessionCount"] = serde_json::json!(cur + dsh_count);
        }
    }
    Ok(stats)
}

/// Count DeepSeek Harness sessions (`~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd`).
/// Depth-capped walk — a pathological tree must not stall profile stats.
fn count_dsh_sessions(root: &std::path::Path) -> u64 {
    fn walk(dir: &std::path::Path, depth: u32) -> u64 {
        if depth > 4 {
            return 0;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        let mut n = 0u64;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                n += walk(&p, depth + 1);
            } else if p.file_name().map_or(false, |f| f == "session.jsonl.zstd") {
                n += 1;
            }
        }
        n
    }
    walk(root, 0)
}

/// One representative assistant message (deduped by message.id across all
/// files, stop_reason/output-max selection — mirrors cc-switch).
#[derive(Clone)]
struct ParsedAssistantUsage {
    message_id: String,
    uuid: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_tokens: u64,
    stop_reason: Option<String>,
    timestamp: Option<String>,
}

/// Recursively collect every jsonl under `dir` (main sessions, subagents,
/// workflows) and merge assistant usage rows into `msgs`, deduped by
/// message.id with cc-switch's representative-row rule. `counted_sessions`
/// gets the file stem of top-level (project-dir) jsonl files only.
fn collect_jsonl_files_recursive(
    dir: &std::path::Path,
    counted_sessions: &mut HashSet<String>,
    msgs: &mut HashMap<String, ParsedAssistantUsage>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_jsonl_files_recursive(&p, counted_sessions, msgs);
            continue;
        }
        if !p.extension().map_or(false, |e| e == "jsonl") {
            continue;
        }
        // Top-level (project dir directly) jsonl files are main sessions.
        if p.parent().and_then(|pp| pp.parent()) == Some(dir) {
            if let Some(stem) = p.file_stem() {
                counted_sessions.insert(stem.to_string_lossy().to_string());
            }
        }
        scan_jsonl_file(&p, msgs);
    }
}

/// Parse one jsonl file, merging each assistant message into `msgs` with the
/// representative-row rule: a row with stop_reason beats one without; among
/// equal stop-reason status, the larger output_tokens wins.
fn scan_jsonl_file(path: &std::path::Path, msgs: &mut HashMap<String, ParsedAssistantUsage>) {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        // Perf #1: cheap substring prefilter BEFORE full JSON parsing — in a
        // typical session jsonl the assistant rows are a small minority and
        // from_str on every line (user/tool/system/summary...) dominated the
        // scan cost. Both compact and pretty key spellings covered.
        if !line.contains("\"type\":\"assistant\"") && !line.contains("\"type\": \"assistant\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let Some(message_id) = message.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if message_id.is_empty() {
            continue;
        }
        let parsed = ParsedAssistantUsage {
            message_id: message_id.to_string(),
            uuid: value
                .get("uuid")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            model: message
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            input_tokens: usage_u64(usage, "input_tokens"),
            output_tokens: usage_u64(usage, "output_tokens"),
            cache_tokens: usage_u64(usage, "cache_read_input_tokens")
                + cache_creation_tokens(usage),
            stop_reason: message
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            timestamp: value
                .get("timestamp")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        };
        let should_replace = match msgs.get(message_id) {
            None => true,
            Some(existing) => {
                if parsed.stop_reason.is_some() && existing.stop_reason.is_none() {
                    true
                } else if parsed.stop_reason.is_some() == existing.stop_reason.is_some() {
                    parsed.output_tokens > existing.output_tokens
                } else {
                    false
                }
            }
        };
        if should_replace {
            msgs.insert(message_id.to_string(), parsed);
        }
    }
}

/// Scan ~/.claude/projects/**/*.jsonl + Little Claude's usage log and
/// aggregate per-day / per-model token statistics. Runs on the blocking
/// pool (see get_profile_stats).
fn scan_profile_stats(claude_dir: &std::path::Path) -> Result<Value, String> {
    let mut daily: HashMap<String, ProfileDailyStats> = HashMap::new();
    let mut models: HashMap<String, ProfileModelStats> = HashMap::new();
    let mut counted_sessions: HashSet<String> = HashSet::new();

    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache = 0u64;
    // S-sem: semantic total (cache double-count removed for DeepSeek-style
    // records) — this is what totalTokens / peakDayTokens expose. The
    // input/output/cache detail columns keep their raw values.
    let mut total_semantic = 0u64;
    let mut message_count = 0u64;
    // Turn-level uuids (== the `msg.uuid` the frontend persists) for assistant
    // messages the JSONL scan already counted. Used to suppress those turns in
    // the usage-log merge and avoid double-counting.
    let mut jsonl_counted_uuids: HashSet<String> = HashSet::new();
    // Turn-level ids where the JSONL only counted output (input was 0 — the
    // OpenAI-compat proxy path can't put input on message_start). Usage-log
    // records for these ids SUPPLEMENT input + cache instead of being skipped.
    let mut jsonl_zero_input_ids: HashSet<String> = HashSet::new();

    // ─── JSONL scan (cc-switch compatible) ─────────────────────────────
    // Walk EVERY jsonl under ~/.claude/projects recursively — main session
    // files, Task/subagent files (SESSION_ID/subagents/*.jsonl) and workflow
    // files (subagents/workflows/wf_*/*.jsonl) — so machine-wide Claude Code
    // usage is counted (terminal CLI sessions included, same as cc-switch).
    //
    // Dedup: the CLI can write the SAME assistant message.id multiple times
    // (message_start snapshot vs final record, replay/rewind copies, and
    // subagent duplicates of a parent turn). Keep ONE representative row per
    // message.id across all files, preferring a row with a stop_reason and,
    // among equal-stop rows, the largest output_tokens (the message_start
    // snapshot carries partial usage — issue anthropics/claude-code#22671).
    let mut msgs: HashMap<String, ParsedAssistantUsage> = HashMap::new();
    collect_jsonl_files_recursive(&claude_dir, &mut counted_sessions, &mut msgs);

    for msg in msgs.values() {
        // S-sem: DeepSeek/OpenAI-compat endpoints (incl. this app's proxy)
        // report input_tokens already containing the cached share, so the
        // naive input + cache + output sum double-counts cache (~2x on real
        // DeepSeek sessions — the frontend's semanticContextTokens already
        // handles this for the Ctx bar; the profile aggregation must match).
        let total_tokens = semantic_total(msg.input_tokens, msg.cache_tokens, msg.output_tokens);
        if total_tokens == 0 {
            continue;
        }
        // Record the turn-level identifiers so the usage-log merge can decide
        // whether to skip or supplement this turn. Same split as before:
        //  - input > 0 → JSONL counted the full turn → usage-log SKIPPED.
        //  - input == 0 but total > 0 → proxy path: JSONL only counted output,
        //    usage-log SUPPLEMENTS input + cache.
        // Record BOTH dedup keys so the usage-log merge matches whichever
        // identifier the frontend persisted: `message.id` (msg_* — the
        // common case) and `value.uuid` (older frontend builds / proxy
        // paths persisted msg.uuid, which equals the JSONL value.uuid).
        if msg.input_tokens > 0 {
            jsonl_counted_uuids.insert(msg.message_id.clone());
            if !msg.uuid.is_empty() {
                jsonl_counted_uuids.insert(msg.uuid.clone());
            }
        } else {
            jsonl_zero_input_ids.insert(msg.message_id.clone());
            if !msg.uuid.is_empty() {
                jsonl_zero_input_ids.insert(msg.uuid.clone());
            }
        }

        total_input += msg.input_tokens;
        total_output += msg.output_tokens;
        total_cache += msg.cache_tokens;
        total_semantic += total_tokens;
        message_count += 1;

        let date = msg
            .timestamp
            .as_deref()
            .map(local_date_from_timestamp)
            .unwrap_or_else(|| "unknown".to_string());
        let entry = daily
            .entry(date.clone())
            .or_insert_with(|| ProfileDailyStats {
                date,
                ..Default::default()
            });
        entry.input_tokens += msg.input_tokens;
        entry.output_tokens += msg.output_tokens;
        entry.cache_tokens += msg.cache_tokens;
        entry.total_tokens += total_tokens;
        entry.message_count += 1;

        if !msg.model.is_empty() {
            let model_entry =
                models
                    .entry(msg.model.clone())
                    .or_insert_with(|| ProfileModelStats {
                        model: msg.model.clone(),
                        ..Default::default()
                    });
            model_entry.total_tokens += total_tokens;
            model_entry.message_count += 1;
        }
    }

    // Merge Little Claude's own usage log (authoritative counts persisted by the
    // frontend from the live NDJSON stream). This fills gaps where the Claude CLI
    // wrote zero/missing usage to its JSONL. Dedup is by (session_id, message_id),
    // so records whose JSONL message already contributed are skipped.
    merge_usage_log_into(
        &jsonl_counted_uuids,
        &jsonl_zero_input_ids,
        &mut daily,
        &mut models,
        &mut total_input,
        &mut total_output,
        &mut total_cache,
        &mut total_semantic,
        &mut message_count,
    );

    let mut daily_values: Vec<ProfileDailyStats> = daily.into_values().collect();
    daily_values.sort_by(|a, b| a.date.cmp(&b.date));
    let peak_day_tokens = daily_values
        .iter()
        .map(|d| d.total_tokens)
        .max()
        .unwrap_or(0);

    let mut model_values: Vec<ProfileModelStats> = models.into_values().collect();
    model_values.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));
    model_values.truncate(8);

    Ok(serde_json::json!({
        "totalInputTokens": total_input,
        "totalOutputTokens": total_output,
        "totalCacheTokens": total_cache,
        "totalTokens": total_semantic,
        "sessionCount": counted_sessions.len() as u64,
        "messageCount": message_count,
        "activeDays": daily_values.iter().filter(|d| d.date != "unknown").count() as u64,
        "peakDayTokens": peak_day_tokens,
        "daily": daily_values,
        "models": model_values,
    }))
}

#[cfg(test)]
mod tests {
    use super::{decode_dsh_session, local_date_from_timestamp, semantic_total, sync_dsh_usage_impl};

    /// Local-machine verification: decodes a REAL multi-frame DSH session
    /// file (ignored on CI — requires ~/.dsh/sessions on this machine).
    #[test]
    #[ignore]
    fn decode_real_dsh_session_files() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let root = home.join(".dsh").join("sessions");
        if !root.is_dir() {
            return;
        }
        let mut total_rows = 0usize;
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if p.file_name().and_then(|n| n.to_str()) != Some("session.jsonl.zstd") {
                    continue;
                }
                match decode_dsh_session(&p) {
                    Ok(rows) => {
                        eprintln!("decoded {} rows from {}", rows.len(), p.display());
                        total_rows += rows.len();
                    }
                    Err(e) => panic!("decode failed for {}: {}", p.display(), e),
                }
            }
        }
        assert!(total_rows > 0, "no session files decoded");
    }

    #[test]
    fn sync_dsh_usage_is_idempotent() {
        // Running twice must not duplicate records (message_id dedup). Safe to
        // call on any machine: no ~/.dsh → 0 additions both times.
        let first = sync_dsh_usage_impl();
        let second = sync_dsh_usage_impl();
        assert!(second == 0 || second <= first, "second sync added records");
    }

    #[test]
    fn rfc3339_utc_is_bucketed_to_local_date() {
        // 2026-08-14T20:00:00Z — local (+08:00) is 2026-08-15.
        assert_eq!(local_date_from_timestamp("2026-08-14T20:00:00Z"), "2026-08-15");
    }

    #[test]
    fn unix_seconds_are_bucketed_to_local_date() {
        // 1786584107 == 2026-08-13T01:21:47Z → local (+08:00) 2026-08-13 09:21.
        assert_eq!(local_date_from_timestamp("1786584107"), "2026-08-13");
    }

    #[test]
    fn garbage_falls_back_to_raw_prefix() {
        assert_eq!(local_date_from_timestamp("not-a-timestamp"), "not-a-time");
        assert_eq!(local_date_from_timestamp(""), "unknown");
    }

    // ── S-sem: DeepSeek-style usage must not double-count cache ─────────

    #[test]
    fn deepseek_input_includes_cache_so_total_is_input_plus_output() {
        // Verified real shape: input == cache_read + cache_creation exactly.
        // Naive sum = 70_000 + 69_000 + 1_000 + 500 = 140_500 (2x inflated);
        // semantic = 70_000 + 500 = 70_500.
        assert_eq!(semantic_total(70_000, 70_000, 500), 70_500);
    }

    #[test]
    fn anthropic_input_is_uncached_so_cache_is_added() {
        // Anthropic official: input is the uncached remainder, cache separate.
        assert_eq!(semantic_total(6, 85_163, 900), 86_069);
    }

    #[test]
    fn zero_cache_keeps_plain_sum() {
        assert_eq!(semantic_total(38_428, 0, 669), 39_097);
    }

    #[test]
    fn partial_cache_share_below_input_returns_input() {
        // Ambiguous case documented in context-tokens.ts: a small cache hit
        // with a large fresh input misreads as "input covers the cached
        // share" and the cache part is NOT added (Anthropic shape loses the
        // small cache share — a few percent at most, matches the frontend).
        assert_eq!(semantic_total(50_000, 2_000, 300), 50_300);
    }

    #[test]
    fn supplement_branch_uses_same_rule() {
        // Proxy path with input=0: JSONL counted output only; the usage-log
        // record supplements input+cache. Semantic total = cache + output.
        assert_eq!(semantic_total(0, 8_000, 1_200), 9_200);
    }
}
