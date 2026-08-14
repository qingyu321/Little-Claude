//! DSH session-event → UnifiedEvent translation (D-N1-B service integration).
//!
//! Pure functions over the mux-frame `payload` shapes verified against a live
//! service (2026-08-13): `session/event` frames carry token-level
//! `assistant/chunk` deltas (block-start / text-delta / reasoning-delta /
//! tool-call-delta / block-end / usage / finish), while `assistant/message`
//! and `tool/result` carry the final shapes. The output is the same
//! stream-json shape the frontend's `useStreamProcessor` already consumes.
//!
//! Deliberate decisions (design §6.7):
//! - plugin-injected `user/message` frames (AGENTS.md/CLAUDE.md snapshots,
//!   sandbox policy) are dropped — the UI shows only real user messages.
//! - usage counters are camelCase on the wire; converted to snake_case.
//! - a tool-call block has no `block-start` frame; the first `tool-call-delta`
//!   for an index implies block start.

use serde_json::{json, Value};
use std::collections::HashSet;

/// Translator state kept across frames of one session (per session, one
/// instance per mux connection).
#[derive(Default)]
pub struct DshTranslator {
    /// Block indices for which `content_block_start` was already emitted.
    started: HashSet<u64>,
    /// Tool-call blocks: index → (id, name) — for block-end completion.
    tool_blocks: std::collections::HashMap<u64, (String, String)>,
    /// Latest usage (camelCase→snake_case), for `assistant/message` / `turn/end`.
    pub usage: Option<Value>,
    /// Model from the last `request/header` (for `result` attribution).
    pub model: Option<String>,
}

impl DshTranslator {
    /// Reset per-turn state. DSH renumbers block indices from 0 on every new
    /// turn, so `started`/`tool_blocks` from the previous turn must not leak
    /// into the next one — a stale entry would suppress `content_block_start`
    /// and make `block-end` misclassify a text block as a tool block.
    /// Called on `turn/start` (and on `turn/end` so a trailing state never
    /// survives into a turn that emits no `turn/start`).
    pub fn reset_for_turn(&mut self) {
        self.started.clear();
        self.tool_blocks.clear();
        self.usage = None;
    }
}

/// Translate one `session/event` mux-frame payload into UnifiedEvent JSON
/// values (each already shaped like `{"event": {…}}` for `claude:stream:{id}`).
pub fn translate_session_event(state: &mut DshTranslator, payload: &Value) -> Vec<Value> {
    let event = match payload.get("event") {
        Some(e) => e,
        None => return Vec::new(),
    };
    let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let data = event.get("data").cloned().unwrap_or_default();

    match etype {
        "user/message" => translate_user_message(&data),
        "request/header" => translate_request_header(state, &data),
        "assistant/chunk" => translate_chunk(state, &data),
        "assistant/message" => translate_assistant_message(state, &data),
        "tool/result" => translate_tool_result(&data),
        "turn/end" => translate_turn_end(state, &data),
        "todo/write" => translate_todo_write(&data),
        // turn/start clears the standing todo plan (DSH todo lifetime rule:
        // latest todo/write with no later turn/start). Forwarded so the
        // frontend TodoDock can implement the same "clear on next turn".
        "turn/start" => translate_turn_start(&data),
        "compaction/start" | "compaction/summary" | "compaction/end" => {
            translate_compaction_event(etype, &data)
        }
        _ => Vec::new(),
    }
}

/// Translate a `session/projection` mux frame. Only the `contextPressure`
/// key is forwarded (`context_update`); the host's token-meter projection is
/// the authoritative occupancy source — `projectedTokens` = last usage anchor
/// + surface delta re-estimate, which DSH's own occupancy displays read.
/// Other keys (tokenUsage / contextBreakdown / …) have no consumer yet and
/// return `Value::Null`.
pub fn translate_projection_frame(payload: &Value) -> Value {
    let key = payload.get("key").and_then(|v| v.as_str()).unwrap_or("");
    if key != "contextPressure" {
        return Value::Null;
    }
    let value = payload.get("value").cloned().unwrap_or_else(|| json!({}));
    let mut out = json!({ "type": "context_update" });
    // camelCase → snake_case; absent fields stay absent so the frontend can
    // tell "no capacity declared" from "declared zero".
    if let Some(v) = value.get("contextWindow") {
        out["context_window"] = v.clone();
    }
    if let Some(v) = value.get("pressureTokens") {
        out["pressure_tokens"] = v.clone();
    }
    if let Some(v) = value.get("projectedTokens") {
        out["projected_tokens"] = v.clone();
    }
    out
}

/// Translate `approval/requested` / `question/requested` mux frames into
/// LC `PermissionRequest` events (rendered by PermissionCard / QuestionCard).
pub fn translate_interaction_frame(payload: &Value) -> Vec<Value> {
    let ftype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match ftype {
        "approval/requested" => {
            let request_id = payload
                .get("approvalId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_name = payload
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let tool_use_id = payload.get("callId").and_then(|v| v.as_str()).map(|s| s.to_string());
            let description = payload.get("reason").and_then(|v| v.as_str()).map(|s| s.to_string());
            vec![json!({
                "type": "little_claude_permission_request",
                "request_id": request_id,
                "tool_name": tool_name,
                "input": payload.get("input").cloned().unwrap_or_else(|| json!({})),
                "description": description,
                "tool_use_id": tool_use_id,
            })]
        }
        "question/requested" => {
            // DSH AskUserQuestion → same shape Claude CLI emits for
            // AskUserQuestion so the existing QuestionCard renders it.
            let request_id = payload
                .get("questionRpcId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let questions = payload
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([]));
            vec![json!({
                "type": "little_claude_permission_request",
                "request_id": request_id,
                "tool_name": "AskUserQuestion",
                "input": json!({ "questions": questions }),
                "description": null,
                "tool_use_id": null,
            })]
        }
        _ => Vec::new(),
    }
}

// ─── per-type translators ─────────────────────────────────────────────────

/// `todo/write` — the model's whole task list (whole-list replacement, DSH
/// `dsh-tool-todo`). Forwarded as `stream_event.todo_update` so the frontend
/// TodoDock can render the standing plan with per-item status (pending /
/// in_progress / completed — spinner & checkmark states).
fn translate_todo_write(data: &Value) -> Vec<Value> {
    let todos = data.get("todos").cloned().unwrap_or_else(|| json!([]));
    vec![json!({
        "type": "stream_event",
        "event": { "type": "todo_update", "todos": todos },
    })]
}

/// `turn/start` — a new turn begins; the previous standing todo plan clears
/// (DSH lifetime rule: latest `todo/write` with no later `turn/start`).
fn translate_turn_start(data: &Value) -> Vec<Value> {
    let turn = data.get("turn").and_then(|v| v.as_u64()).unwrap_or(0);
    vec![json!({
        "type": "stream_event",
        "event": { "type": "turn_start", "turn": turn },
    })]
}

/// `compaction/start|summary|end` — DSH's automatic context-compaction
/// lifecycle (`thresholdRatio` pressure trigger at agent/pre-step, or
/// context-overflow recovery). Forwarded so the frontend Ctx bar can drop
/// immediately: the `contextPressure` projection is NOT pushed on compaction
/// (compaction produces no usage), so without these events the bar would
/// freeze at the pre-compact ≈100% until the next request refreshes it.
/// `compaction/summary` is only emitted on the success path — its
/// `shadowedTokenCount` is the token-meter heuristic estimate of the replaced
/// range (≈ how much the occupancy just shrank).
fn translate_compaction_event(etype: &str, data: &Value) -> Vec<Value> {
    let compaction_id = data
        .get("compactionId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let turn = data.get("turn").and_then(|v| v.as_u64());
    match etype {
        "compaction/start" => vec![json!({
            "type": "compaction_start",
            "compaction_id": compaction_id,
            "turn": turn,
        })],
        "compaction/summary" => vec![json!({
            "type": "compaction_summary",
            "compaction_id": compaction_id,
            "shadowed_token_count": data.get("shadowedTokenCount").cloned().unwrap_or(json!(0)),
            "shadowed_seq_count": data.get("shadowedSeqs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
        })],
        "compaction/end" => {
            let mut out = json!({
                "type": "compaction_end",
                "compaction_id": compaction_id,
                "turn": turn,
            });
            if let Some(err) = data.get("error") {
                out["error"] = err.clone();
            }
            vec![out]
        }
        _ => Vec::new(),
    }
}

fn translate_user_message(data: &Value) -> Vec<Value> {
    // Drop plugin-injected frames (workspace instructions, policy snapshots).
    let source_kind = data
        .pointer("/source/kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if source_kind != "user" {
        return Vec::new();
    }
    vec![json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": translate_content_blocks(data.get("content").cloned().unwrap_or_default()),
            "id": data.get("id").cloned(),
        },
    })]
}

fn translate_request_header(state: &mut DshTranslator, data: &Value) -> Vec<Value> {
    let model = data
        .pointer("/header/config/model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(m) = model.clone() {
        state.model = Some(m);
    }
    let mut extra = json!({});
    if let Some(config) = data.pointer("/header/config") {
        extra["config"] = config.clone();
    }
    vec![json!({
        "type": "system",
        "subtype": "init",
        "model": model,
    })]
}

fn translate_chunk(state: &mut DshTranslator, data: &Value) -> Vec<Value> {
    let chunk = match data.get("chunk") {
        Some(c) => c,
        None => return Vec::new(),
    };
    let ctype = chunk.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let index = chunk.get("index").and_then(|v| v.as_u64()).unwrap_or(0);

    match ctype {
        "block-start" => {
            let block_type = chunk
                .get("blockType")
                .and_then(|v| v.as_str())
                .unwrap_or("text");
            let content_block = match block_type {
                "reasoning" => json!({ "type": "thinking", "thinking": "" }),
                "tool-use" => {
                    // Unlikely (no block-start for tools) but keep safe.
                    let id = chunk.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = chunk.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    state.started.insert(index);
                    state.tool_blocks.insert(index, (id.clone(), name.clone()));
                    return vec![json!({
                        "event": {
                            "type": "content_block_start",
                            "index": index,
                            "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
                        }
                    })];
                }
                _ => json!({ "type": "text", "text": "" }),
            };
            state.started.insert(index);
            vec![json!({
                "event": {
                    "type": "content_block_start",
                    "index": index,
                    "content_block": content_block,
                }
            })]
        }
        "reasoning-delta" => {
            let text = chunk.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if !state.started.contains(&index) {
                state.started.insert(index);
                return vec![json!({
                    "event": {
                        "type": "content_block_start",
                        "index": index,
                        "content_block": { "type": "thinking", "thinking": "" },
                    }
                })];
            }
            vec![json!({
                "event": {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "thinking_delta", "thinking": text },
                }
            })]
        }
        "text-delta" => {
            let text = chunk.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if !state.started.contains(&index) {
                state.started.insert(index);
                return vec![json!({
                    "event": {
                        "type": "content_block_start",
                        "index": index,
                        "content_block": { "type": "text", "text": "" },
                    }
                })];
            }
            vec![json!({
                "event": {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "text_delta", "text": text },
                }
            })]
        }
        "tool-call-delta" => {
            let id = chunk.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = chunk.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args_delta = chunk.get("argumentsDelta").and_then(|v| v.as_str()).unwrap_or("");
            let mut out = Vec::new();
            if !state.started.contains(&index) {
                state.started.insert(index);
                state.tool_blocks.insert(index, (id.clone(), name.clone()));
                out.push(json!({
                    "event": {
                        "type": "content_block_start",
                        "index": index,
                        "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} },
                    }
                }));
            }
            out.push(json!({
                "event": {
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": "input_json_delta", "partial_json": args_delta },
                }
            }));
            out
        }
        "block-end" => {
            // Finalize the block: for tool-use blocks the finished `block`
            // carries the full JSON arguments → parse into `input`.
            if let Some((id, name)) = state.tool_blocks.remove(&index) {
                let input = chunk
                    .pointer("/block/arguments")
                    .and_then(|v| v.as_str())
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .unwrap_or_else(|| json!({}));
                vec![
                    json!({
                        "event": {
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "input_json_delta", "partial_json": "" },
                        }
                    }),
                    json!({
                        "event": { "type": "content_block_stop", "index": index }
                    }),
                    // Synthetic assistant chunk so the frontend finalizes a
                    // tool_use block as a complete message (mirrors Claude's
                    // stream where the tool_use block arrives in content).
                    json!({
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "content": [{ "type": "tool_use", "id": id, "name": name, "input": input }],
                        },
                    }),
                ]
            } else {
                vec![json!({
                    "event": { "type": "content_block_stop", "index": index }
                })]
            }
        }
        "usage" => {
            state.usage = Some(convert_usage(chunk.get("usage").cloned().unwrap_or_default()));
            Vec::new()
        }
        "finish" => {
            let reason = chunk
                .pointer("/reason/kind")
                .and_then(|v| v.as_str())
                .unwrap_or("stop");
            let stop_reason = match reason {
                "stop" => "end_turn",
                "max_tokens" | "max-tokens" => "max_tokens",
                other => other,
            };
            vec![
                json!({
                    "event": {
                        "type": "message_delta",
                        "delta": { "stop_reason": stop_reason, "stop_sequence": null },
                    }
                }),
                json!({ "event": { "type": "message_stop" } }),
            ]
        }
        _ => Vec::new(),
    }
}

fn translate_assistant_message(state: &mut DshTranslator, data: &Value) -> Vec<Value> {
    let message = data.get("message").cloned().unwrap_or_default();
    let mut content = translate_content_blocks(message.get("content").cloned().unwrap_or_default());
    // Fill in tool inputs parsed from the finished tool blocks.
    for block in content.iter_mut() {
        if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
            if let Some(id) = block.get("id").and_then(|v| v.as_str()) {
                if let Some((_, _)) = state.tool_blocks.iter().find(|(_, (tid, _))| tid == id) {
                    // input already merged during block-end; nothing to do.
                }
            }
        }
    }
    let usage = data
        .get("usage")
        .cloned()
        .map(convert_usage)
        .or_else(|| state.usage.clone());
    if let Some(u) = &usage {
        state.usage = Some(u.clone());
    }
    let model = data.pointer("/message/source/model").and_then(|v| v.as_str());
    vec![json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": content,
            "model": model,
            "id": message.get("id").cloned(),
        },
        "usage": usage,
    })]
}

fn translate_tool_result(data: &Value) -> Vec<Value> {
    let message = data.get("message").cloned().unwrap_or_default();
    let mut blocks = Vec::new();
    if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) == Some("tool-result") {
                blocks.push(json!({
                    "type": "tool_result",
                    "tool_use_id": block.get("toolCallId").cloned().unwrap_or_default(),
                    "content": block.get("content").cloned().unwrap_or_else(|| json!([])),
                    "is_error": block.get("isError").cloned().unwrap_or(json!(false)),
                }));
            } else {
                // Non-result blocks inside a tool message are still part of
                // the tool_result payload (DSH wraps them as text).
                blocks.push(json!({
                    "type": "tool_result",
                    "tool_use_id": message.get("id").cloned().unwrap_or_default(),
                    "content": [block.clone()],
                    "is_error": json!(false),
                }));
            }
        }
    }
    if blocks.is_empty() {
        return Vec::new();
    }
    vec![json!({
        "type": "user",
        "message": { "role": "user", "content": blocks },
    })]
}

fn translate_turn_end(state: &mut DshTranslator, data: &Value) -> Vec<Value> {
    let reason = data
        .get("reason")
        .and_then(|v| v.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("completed");
    // Interrupted/cancelled turns (user Stop, steer 打断, kill) are NOT
    // errors — mapping them to subtype "error" put the tab into the red
    // error state after every Stop and kept it there through the next turn.
    // Only genuinely failed turns report an error.
    let ok = matches!(
        reason,
        "completed" | "interrupted" | "cancelled" | "cancelled-turn" | "killed" | "steer" | "user-steer"
    );
    let subtype = if ok { "success" } else { "error" };
    let mut result = json!({
        "type": "result",
        "subtype": subtype,
        "usage": state.usage.clone().unwrap_or_else(|| json!({})),
        "duration_ms": 0,
        "num_turns": data.get("turn").and_then(|v| v.as_u64()).unwrap_or(1),
    });
    if !ok {
        result["error"] = json!({
            "type": "dsh_turn_end",
            "reason": reason,
        });
        result["result"] = json!({ "kind": "error", "reason": reason });
    }
    vec![result]
}

/// Convert DSH camelCase usage to LC snake_case.
fn convert_usage(u: Value) -> Value {
    json!({
        "input_tokens": u.get("inputTokens").cloned().unwrap_or(json!(0)),
        "output_tokens": u.get("outputTokens").cloned().unwrap_or(json!(0)),
        "cache_read_input_tokens": u.get("cacheReadTokens").cloned(),
        "cache_creation_input_tokens": u.get("cacheCreationTokens").cloned(),
        "thinking_tokens": u.get("reasoningTokens").cloned(),
    })
}

/// Convert DSH content blocks to LC (Claude) content blocks.
fn translate_content_blocks(content: Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(arr) = content.as_array() {
        for block in arr {
            match block.get("type").and_then(|v| v.as_str()) {
                Some("text") => out.push(json!({
                    "type": "text",
                    "text": block.get("text").cloned().unwrap_or_default(),
                })),
                Some("reasoning") | Some("thinking") => out.push(json!({
                    "type": "thinking",
                    "thinking": block.get("text").cloned().unwrap_or_default(),
                })),
                Some("tool-call") => {
                    let input = block
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or_else(|| json!({}));
                    out.push(json!({
                        "type": "tool_use",
                        "id": block.get("id").cloned().unwrap_or_default(),
                        "name": block.get("name").cloned().unwrap_or_default(),
                        "input": input,
                    }));
                }
                Some("tool-result") => out.push(json!({
                    "type": "tool_result",
                    "tool_use_id": block.get("toolCallId").cloned().unwrap_or_default(),
                    "content": block.get("content").cloned().unwrap_or_else(|| json!([])),
                    "is_error": block.get("isError").cloned().unwrap_or(json!(false)),
                })),
                _ => out.push(block.clone()),
            }
        }
    }
    out
}

// ─── tests (fixtures from live capture 2026-08-13) ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(payload: Value) -> Value {
        payload
    }

    fn ev(events: &[Value], i: usize) -> &Value {
        &events[i]
    }

    #[test]
    fn text_turn_produces_full_stream_sequence() {
        // probe1: "回复OK两个字" — 5 chunks + message + turn/end
        let mut st = DshTranslator::default();
        let mut out = Vec::new();

        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "request/header", "seq": 11, "data": {
                "header": { "config": { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 256000 } }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 15, "data": {
                "turn": 1, "step": 1,
                "chunk": { "type": "block-start", "index": 0, "blockType": "text" }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 16, "data": {
                "turn": 1, "step": 1, "chunk": { "type": "text-delta", "index": 0, "text": "OK" }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 17, "data": {
                "turn": 1, "step": 1, "chunk": { "type": "block-end", "index": 0, "block": { "type": "text", "text": "OK" } }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 18, "data": {
                "turn": 1, "step": 1,
                "chunk": { "type": "usage", "usage": { "inputTokens": 12460, "outputTokens": 2, "cacheReadTokens": 0, "reasoningTokens": 0 } }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 19, "data": {
                "turn": 1, "step": 1, "chunk": { "type": "finish", "reason": { "kind": "stop" } }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/message", "seq": 20, "data": {
                "turn": 1, "step": 1,
                "message": { "role": "assistant", "content": [{ "type": "text", "text": "OK" }],
                    "source": { "kind": "model", "provider": "deepseek-official", "model": "deepseek-v4-flash" },
                    "id": "m_1" },
                "usage": { "inputTokens": 12460, "outputTokens": 2, "cacheReadTokens": 0, "reasoningTokens": 0 }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "turn/end", "seq": 22, "data": { "turn": 1, "reason": { "kind": "completed" } } }
        }))));

        // 1 system init + 2 start/delta + stop + message_delta + message_stop
        // + assistant + result
        assert_eq!(out.len(), 8, "got: {}", serde_json::to_string(&out).unwrap());
        assert_eq!(ev(&out, 0)["type"], "system");
        assert_eq!(ev(&out, 0)["model"], "deepseek-v4-flash");
        assert_eq!(ev(&out, 1)["event"]["type"], "content_block_start");
        assert_eq!(ev(&out, 1)["event"]["content_block"]["type"], "text");
        assert_eq!(ev(&out, 2)["event"]["type"], "content_block_delta");
        assert_eq!(ev(&out, 2)["event"]["delta"]["text"], "OK");
        assert_eq!(ev(&out, 3)["event"]["type"], "content_block_stop");
        assert_eq!(ev(&out, 4)["event"]["type"], "message_delta");
        assert_eq!(ev(&out, 4)["event"]["delta"]["stop_reason"], "end_turn");
        assert_eq!(ev(&out, 5)["event"]["type"], "message_stop");
        assert_eq!(ev(&out, 6)["type"], "assistant");
        assert_eq!(ev(&out, 6)["message"]["content"][0]["text"], "OK");
        assert_eq!(ev(&out, 6)["usage"]["input_tokens"], 12460);
        assert_eq!(ev(&out, 7)["type"], "result");
        assert_eq!(ev(&out, 7)["subtype"], "success");
    }

    #[test]
    fn plugin_user_messages_are_dropped() {
        let mut st = DshTranslator::default();
        let out = translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "user/message", "seq": 8, "data": {
                "content": [{ "type": "text", "text": "worktree instructions" }],
                "source": { "kind": "plugin", "plugin": "dsh-system-prompt" },
                "role": "user", "id": "p_1"
            } }
        })));
        assert!(out.is_empty(), "plugin frame must be dropped");

        let out2 = translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "user/message", "seq": 9, "data": {
                "content": [{ "type": "text", "text": "hello" }],
                "source": { "kind": "user", "rpcId": "r_1" },
                "role": "user", "id": "u_1"
            } }
        })));
        assert_eq!(out2.len(), 1);
        assert_eq!(out2[0]["type"], "user");
        assert_eq!(out2[0]["message"]["content"][0]["text"], "hello");
    }

    #[test]
    fn reasoning_and_tool_turn_translate() {
        // probe2 essence: reasoning block → tool block → result
        let mut st = DshTranslator::default();
        let mut out = Vec::new();
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 1, "data": {
                "turn": 1, "step": 1, "chunk": { "type": "block-start", "index": 0, "blockType": "reasoning" }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 2, "data": {
                "turn": 1, "step": 1, "chunk": { "type": "reasoning-delta", "index": 0, "text": "The user asks" }
            } }
        }))));
        // tool-call delta (index 2) — first frame implies block start
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 10, "data": {
                "turn": 1, "step": 1,
                "chunk": { "type": "tool-call-delta", "index": 2, "id": "call_1", "name": "read", "argumentsDelta": "{\"f" }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 11, "data": {
                "turn": 1, "step": 1,
                "chunk": { "type": "tool-call-delta", "index": 2, "id": "call_1", "name": "read", "argumentsDelta": "ile\":1}" }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 12, "data": {
                "turn": 1, "step": 1,
                "chunk": { "type": "block-end", "index": 2, "block": { "type": "tool-call", "id": "call_1", "name": "read", "arguments": "{\"file\":1}" } }
            } }
        }))));
        // tool result
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "tool/result", "seq": 13, "data": {
                "turn": 1, "step": 1,
                "message": { "source": { "kind": "tool", "callId": "call_1" },
                    "content": [{ "type": "tool-result", "toolCallId": "call_1",
                        "content": [{ "type": "text", "text": "file contents" }], "isError": false }],
                    "role": "user", "id": "tr_1" }
            } }
        }))));
        // turn end with usage carried from assistant/message below
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "assistant/chunk", "seq": 14, "data": {
                "turn": 1, "step": 1,
                "chunk": { "type": "usage", "usage": { "inputTokens": 500, "outputTokens": 10, "cacheReadTokens": 0, "reasoningTokens": 300 } }
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "turn/end", "seq": 15, "data": { "turn": 1, "reason": { "kind": "completed" } } }
        }))));

        // 1 start(reasoning) + 1 thinking_delta + 1 start(tool) + 2 input_json_delta
        // + 2 (input_json_delta empty + stop + assistant tool block) = 3 + 1 tool_result user + 1 result
        assert_eq!(ev(&out, 0)["event"]["content_block"]["type"], "thinking", "reasoning start");
        assert_eq!(ev(&out, 1)["event"]["delta"]["type"], "thinking_delta");
        assert_eq!(ev(&out, 1)["event"]["delta"]["thinking"], "The user asks");
        // tool block start at index 2
        let idx2 = out.iter().position(|e| e["event"]["type"] == "content_block_start" && e["event"]["index"] == 2).unwrap();
        assert_eq!(ev(&out, idx2)["event"]["content_block"]["name"], "read");
        assert_eq!(ev(&out, idx2)["event"]["content_block"]["id"], "call_1");
        // input deltas
        let deltas: Vec<&Value> = out.iter().filter(|e| e["event"]["type"] == "content_block_delta" && e["event"]["index"] == 2).collect();
        assert_eq!(deltas.len(), 3, "2 streamed + 1 finalize empty");
        assert_eq!(deltas[0]["event"]["delta"]["partial_json"], "{\"f");
        // finalize: assistant tool_use with parsed input
        let asst = out.iter().find(|e| e["type"] == "assistant").unwrap();
        assert_eq!(asst["message"]["content"][0]["type"], "tool_use");
        assert_eq!(asst["message"]["content"][0]["input"]["file"], 1);
        // tool result
        let user = out.iter().find(|e| e["type"] == "user").unwrap();
        assert_eq!(user["message"]["content"][0]["type"], "tool_result");
        assert_eq!(user["message"]["content"][0]["tool_use_id"], "call_1");
        assert_eq!(user["message"]["content"][0]["is_error"], false);
        // result usage carries snake_case + thinking
        let result = out.iter().find(|e| e["type"] == "result").unwrap();
        assert_eq!(result["usage"]["input_tokens"], 500);
        assert_eq!(result["usage"]["thinking_tokens"], 300);
        assert_eq!(result["subtype"], "success");
    }

    #[test]
    fn approval_frame_becomes_permission_request() {
        let out = translate_interaction_frame(&json!({
            "type": "approval/requested", "sessionId": "s_x",
            "approvalId": "ap_1", "toolName": "bash", "callId": "call_2",
            "reason": "run a command"
        }));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "little_claude_permission_request");
        assert_eq!(out[0]["request_id"], "ap_1");
        assert_eq!(out[0]["tool_name"], "bash");
        assert_eq!(out[0]["tool_use_id"], "call_2");
        assert_eq!(out[0]["description"], "run a command");
    }

    #[test]
    fn question_frame_becomes_ask_user_question() {
        let out = translate_interaction_frame(&json!({
            "type": "question/requested", "sessionId": "s_x",
            "questionRpcId": "q_1",
            "questions": [{ "id": "q1", "question": "Continue?", "options": ["yes", "no"] }]
        }));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["tool_name"], "AskUserQuestion");
        assert_eq!(out[0]["request_id"], "q_1");
        assert_eq!(out[0]["input"]["questions"][0]["question"], "Continue?");
    }

    #[test]
    fn todo_write_becomes_todo_update() {
        let mut st = DshTranslator::default();
        let out = translate_session_event(&mut st, &frame(json!({
            "event": {
                "type": "todo/write", "seq": 40,
                "data": {
                    "todos": [
                        { "content": "调研协议", "status": "completed" },
                        { "content": "接入服务", "status": "in_progress" },
                        { "content": "验证全链路", "status": "pending" },
                    ]
                }
            }
        })));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "stream_event");
        assert_eq!(out[0]["event"]["type"], "todo_update");
        let todos = out[0]["event"]["todos"].as_array().unwrap();
        assert_eq!(todos.len(), 3);
        // status values pass through for the frontend's three-state rendering
        assert_eq!(todos[0]["status"], "completed");
        assert_eq!(todos[1]["status"], "in_progress");
        assert_eq!(todos[2]["status"], "pending");
        assert_eq!(todos[1]["content"], "接入服务");
    }

    #[test]
    fn turn_start_emits_clear_marker() {
        let mut st = DshTranslator::default();
        let out = translate_session_event(&mut st, &frame(json!({
            "event": {
                "type": "turn/start", "seq": 30,
                "data": { "turn": 2 }
            }
        })));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "stream_event");
        assert_eq!(out[0]["event"]["type"], "turn_start");
        assert_eq!(out[0]["event"]["turn"], 2);
    }

    #[test]
    fn compaction_lifecycle_translates() {
        let mut st = DshTranslator::default();
        let mut out = Vec::new();
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "compaction/start", "seq": 50, "data": {
                "compactionId": "c_1", "sourceCommandId": "cmd_1", "turn": 3
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "compaction/summary", "seq": 51, "data": {
                "compactionId": "c_1",
                "shadowedRange": { "start": 10, "end": 40 },
                "shadowedSeqs": [10, 11, 12],
                "shadowedTokenCount": 680000,
                "summary": [{ "type": "text", "text": "compressed…" }],
            } }
        }))));
        out.extend(translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "compaction/end", "seq": 52, "data": {
                "compactionId": "c_1", "turn": 3
            } }
        }))));

        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["type"], "compaction_start");
        assert_eq!(out[0]["compaction_id"], "c_1");
        assert_eq!(out[0]["turn"], 3);
        assert_eq!(out[1]["type"], "compaction_summary");
        assert_eq!(out[1]["shadowed_token_count"], 680000);
        assert_eq!(out[1]["shadowed_seq_count"], 3);
        assert_eq!(out[2]["type"], "compaction_end");
        assert_eq!(out[2].get("error"), None);
    }

    #[test]
    fn compaction_failure_carries_error() {
        let mut st = DshTranslator::default();
        let out = translate_session_event(&mut st, &frame(json!({
            "type": "session/event", "sessionId": "s_x",
            "event": { "type": "compaction/end", "seq": 60, "data": {
                "compactionId": "c_2", "turn": 1,
                "error": { "type": "summary_error", "message": "summary is not smaller" }
            } }
        })));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "compaction_end");
        assert_eq!(out[0]["error"]["type"], "summary_error");
        assert_eq!(out[0]["error"]["message"], "summary is not smaller");
    }

    #[test]
    fn context_pressure_projection_translates() {
        // Host projection carries projectedTokens (occupancy display value).
        let v = translate_projection_frame(&json!({
            "type": "session/projection", "sessionId": "s_x",
            "key": "contextPressure",
            "value": { "contextWindow": 1000000, "pressureTokens": 780000, "projectedTokens": 795000 },
            "seq": 21
        }));
        assert_eq!(v["type"], "context_update");
        assert_eq!(v["context_window"], 1000000);
        assert_eq!(v["pressure_tokens"], 780000);
        assert_eq!(v["projected_tokens"], 795000);

        // Fixture-style projection without projectedTokens — consumers fall
        // back to pressureTokens, so it must translate too.
        let v2 = translate_projection_frame(&json!({
            "type": "session/projection", "sessionId": "s_x",
            "key": "contextPressure",
            "value": { "contextWindow": 1000000, "pressureTokens": 780000 },
            "seq": 22
        }));
        assert_eq!(v2.get("projected_tokens"), None);
        assert_eq!(v2["pressure_tokens"], 780000);

        // Non-contextPressure keys have no consumer yet → Null.
        let v3 = translate_projection_frame(&json!({
            "type": "session/projection", "sessionId": "s_x",
            "key": "tokenUsage", "value": { "uncachedInputTokens": 1 }, "seq": 23
        }));
        assert!(v3.is_null());
    }
}
