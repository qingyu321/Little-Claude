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
    top_level + nested
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
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| ts.get(0..10).unwrap_or("unknown").to_string())
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
    tracked: &HashSet<String>,
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
        let session_id = value
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !tracked.contains(session_id) {
            continue;
        }
        let message_id = value
            .get("message_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if message_id.is_empty() || !seen.insert(message_id.clone()) {
            continue; // dedup within the usage log itself
        }
        // Skip turns the JSONL scan already counted with full (non-zero) input.
        // The frontend persists `msg.uuid` as `message_id`, which equals the
        // JSONL `value.uuid`; the JSONL scan's primary dedup key (`message.id`)
        // is a different ID, so without this check the same turn would be
        // counted twice.
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
    use std::io::BufRead;

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

    let tracked = crate::commands::session::load_tracked_sessions();
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

    if let Ok(entries) = std::fs::read_dir(&claude_dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(entry.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if !path.extension().map_or(false, |e| e == "jsonl") {
                    continue;
                }
                let Some(name) = path.file_stem() else {
                    continue;
                };
                let session_id = name.to_string_lossy().to_string();
                if !tracked.contains(&session_id) {
                    continue;
                }
                counted_sessions.insert(session_id.clone());

                let Ok(file) = std::fs::File::open(&path) else {
                    continue;
                };
                let reader = std::io::BufReader::new(file);
                let mut seen_message_ids: HashSet<String> = HashSet::new();

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

                    let message_key = message
                        .get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| value.get("uuid").and_then(|v| v.as_str()))
                        .unwrap_or("");
                    if !message_key.is_empty() && !seen_message_ids.insert(message_key.to_string())
                    {
                        continue;
                    }

                    let input_tokens = usage_u64(usage, "input_tokens");
                    let output_tokens = usage_u64(usage, "output_tokens");
                    let cache_tokens =
                        usage_u64(usage, "cache_read_input_tokens") + cache_creation_tokens(usage);
                    let total_tokens = input_tokens + output_tokens + cache_tokens;
                    if total_tokens == 0 {
                        continue;
                    }

                    // Record the turn-level identifiers so the usage-log merge
                    // can decide whether to skip or supplement this turn. Store
                    // BOTH the top-level `uuid` (official path persists msg.uuid)
                    // AND `message.id` (OpenAI-compat proxy path persists
                    // message_start's message.id).
                    //
                    // Split by input reliability:
                    //  - input_tokens > 0 → JSONL counted the full turn (input +
                    //    output + cache) → usage-log record for this id is SKIPPED.
                    //  - input_tokens == 0 but total > 0 → the proxy path sent the
                    //    CLI an Anthropic response whose message_start carried no
                    //    input (OpenAI usage arrives on the tail chunk), so the
                    //    JSONL only counted output. The usage-log record must
                    //    SUPPLEMENT input + cache for this id.
                    if input_tokens > 0 {
                        if let Some(uuid) = value.get("uuid").and_then(|v| v.as_str()) {
                            if !uuid.is_empty() {
                                jsonl_counted_uuids.insert(uuid.to_string());
                            }
                        }
                        if let Some(mid) = message.get("id").and_then(|v| v.as_str()) {
                            if !mid.is_empty() {
                                jsonl_counted_uuids.insert(mid.to_string());
                            }
                        }
                    } else {
                        if let Some(uuid) = value.get("uuid").and_then(|v| v.as_str()) {
                            if !uuid.is_empty() {
                                jsonl_zero_input_ids.insert(uuid.to_string());
                            }
                        }
                        if let Some(mid) = message.get("id").and_then(|v| v.as_str()) {
                            if !mid.is_empty() {
                                jsonl_zero_input_ids.insert(mid.to_string());
                            }
                        }
                    }

                    total_input += input_tokens;
                    total_output += output_tokens;
                    total_cache += cache_tokens;
                    message_count += 1;

                    // Local calendar date: the JSONL timestamp is UTC (RFC3339
                    // with Z); slicing the first 10 chars yields the UTC day,
                    // which misbuckets 00:00–02:00 local requests onto the
                    // previous day (the UI groups by local date).
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
                    entry.input_tokens += input_tokens;
                    entry.output_tokens += output_tokens;
                    entry.cache_tokens += cache_tokens;
                    entry.total_tokens += total_tokens;
                    entry.message_count += 1;

                    if let Some(model) = message.get("model").and_then(|v| v.as_str()) {
                        let model_entry =
                            models
                                .entry(model.to_string())
                                .or_insert_with(|| ProfileModelStats {
                                    model: model.to_string(),
                                    ..Default::default()
                                });
                        model_entry.total_tokens += total_tokens;
                        model_entry.message_count += 1;
                    }
                }
            }
        }
    }

    // Merge Little Claude's own usage log (authoritative counts persisted by the
    // frontend from the live NDJSON stream). This fills gaps where the Claude CLI
    // wrote zero/missing usage to its JSONL. Dedup is by (session_id, message_id),
    // so records whose JSONL message already contributed are skipped.
    merge_usage_log_into(
        &tracked,
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
