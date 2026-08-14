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
        let total_tokens = input_tokens + output_tokens + cache_tokens;
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
        entry.total_tokens += add_input + add_output + add_cache;
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
            model_entry.total_tokens += add_input + add_output + add_cache;
            if add_msg {
                model_entry.message_count += 1;
            }
        }
    }
}

#[tauri::command]
pub async fn get_profile_stats() -> Result<Value, String> {
    let home = dirs::home_dir().ok_or("Cannot find home dir")?;
    let claude_dir = home.join(".claude").join("projects");
    if !claude_dir.exists() {
        return Ok(serde_json::json!({
            "totalInputTokens": 0u64,
            "totalOutputTokens": 0u64,
            "totalCacheTokens": 0u64,
            "totalTokens": 0u64,
            "sessionCount": 0u64,
            "messageCount": 0u64,
            "activeDays": 0u64,
            "peakDayTokens": 0u64,
            "daily": [],
            "models": [],
        }));
    }

    // The full scan now covers EVERY session jsonl under ~/.claude/projects
    // (cc-switch style: all machine-wide Claude Code usage, including CLI
    // sessions started in a terminal), so it can be thousands of files and
    // hundreds of MB — never run that on the async executor. spawn_blocking
    // keeps the Tauri main thread responsive while the scan runs.
    tokio::task::spawn_blocking(move || scan_profile_stats(&claude_dir))
        .await
        .map_err(|e| format!("Profile stats task failed: {}", e))?
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
        let total_tokens = msg.input_tokens + msg.output_tokens + msg.cache_tokens;
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
        "totalTokens": total_input + total_output + total_cache,
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
    use super::local_date_from_timestamp;

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
}
