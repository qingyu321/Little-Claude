//! Codex CLI backend — wraps OpenAI Codex App Server protocol.
//!
//! Codex uses a JSON-RPC-like protocol over stdin/stdout (JSONL-framed).
//! This module:
//! 1. Translates Codex App Server events into `UnifiedEvent` for the frontend.
//! 2. Manages the initialization handshake (initialize → initialized → thread/start).
//! 3. Routes server-initiated approval requests to the frontend.

use super::*;
use crate::commands::StartSessionParams;
use serde_json::Value;
use std::collections::HashMap;

pub struct CodexBackend {}

impl CodexBackend {
    pub fn new() -> Self {
        Self {}
    }

    /// Generate a monotonically increasing request ID for JSON-RPC.
    /// IDs 1-2 are reserved for handshake (1=initialize, 2=thread/start).
    /// User messages and runtime control start at 3.
    fn next_id() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(3);
        COUNTER.fetch_add(1, Ordering::Relaxed)
    }

    /// Build the "initialized" notification (JSON-RPC notification — no id field).
    /// Sent after receiving the initialize response to acknowledge readiness.
    pub fn build_initialized_message() -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        })
        .to_string()
    }

    /// Build the thread/start or thread/resume request.
    /// Uses id=2 (reserved for thread handshake).
    ///
    /// Codex ≥0.146 requires `threadId` for ALL thread lifecycle methods:
    /// - New session → `thread/start` with a generated UUID as threadId
    /// - Resume → `thread/resume` with the existing threadId
    pub fn build_thread_start_message(resume_thread_id: Option<&str>) -> String {
        let mut params = serde_json::json!({});
        let method;
        if let Some(thread_id) = resume_thread_id {
            params["threadId"] = serde_json::Value::String(thread_id.to_string());
            method = "thread/resume";
        } else {
            // New session: generate a fresh thread ID
            params["threadId"] =
                serde_json::Value::String(uuid::Uuid::new_v4().to_string());
            method = "thread/start";
        }
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
            "params": params
        })
        .to_string()
    }
}

#[async_trait::async_trait]
impl CliBackend for CodexBackend {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn find_binary(&self) -> Option<String> {
        // Search the system PATH manually.
        if let Ok(path_var) = std::env::var("PATH") {
            let exts: Vec<&str> = if cfg!(target_os = "windows") {
                vec!["cmd", "exe"]
            } else {
                vec![""]
            };
            let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
            for dir in path_var.split(sep) {
                for ext in &exts {
                    let name = if ext.is_empty() {
                        "codex".to_string()
                    } else {
                        format!("codex.{}", ext)
                    };
                    let path = std::path::PathBuf::from(dir).join(&name);
                    if path.is_file() {
                        return Some(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
        // Check common npm global locations
        if let Some(home) = dirs::home_dir() {
            #[cfg(target_os = "windows")]
            let npm_bin = home.join("AppData").join("Roaming").join("npm").join("codex.cmd");
            #[cfg(not(target_os = "windows"))]
            let npm_bin = home.join(".local").join("bin").join("codex");
            if npm_bin.exists() {
                return Some(npm_bin.to_string_lossy().into_owned());
            }
        }
        // App-managed npm-global (where install_codex_via_npm installs codex).
        // cli_resolver's tiered scan covers claude.cmd there, but CodexBackend
        // has its own PATH-based lookup — without this, an app-installed codex
        // is invisible ("codex not found") while claude resolves fine.
        if let Some(npm_bin) = crate::commands::cli_manage::get_npm_global_bin() {
            #[cfg(target_os = "windows")]
            let codex_bin = npm_bin.join("codex.cmd");
            #[cfg(not(target_os = "windows"))]
            let codex_bin = npm_bin.join("codex");
            if codex_bin.exists() {
                return Some(codex_bin.to_string_lossy().into_owned());
            }
        }
        None
    }

    fn build_args(&self, _params: &StartSessionParams) -> Vec<String> {
        // All session config (model, sandbox, reasoning_effort, context_window)
        // is written to ~/.codex/config.toml before spawn. CLI flags like
        // --sandbox, --model, -c were removed in Codex v0.146+.
        vec!["app-server".to_string()]
    }

    fn build_env(&self, _params: &StartSessionParams) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("NO_COLOR".to_string(), "1".to_string());
        env
    }

    fn build_initial_message(&self, params: &StartSessionParams) -> Option<String> {
        let init = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "cwd": params.cwd,
                "clientInfo": {
                    "name": "Little Claude",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        });
        Some(init.to_string())
    }

    fn translate_stdout_line(&self, line: &str, _stdin_id: &str) -> Option<UnifiedEvent> {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[codex:event:parse_error] {}", e);
                return None;
            }
        };

        // Dispatch by message shape:
        // - Has "id" AND "result" → response to a client request
        // - Has "id" AND "error" → error response
        // - Has "method" (no "id") → server notification (streaming event)
        // - Has "id" AND "method" (no "result"/"error") → server-initiated request (approval)

        let has_id = msg.get("id").is_some();
        let has_method = msg.get("method").is_some();
        let has_result = msg.get("result").is_some();
        let has_error = msg.get("error").is_some();

        if has_id && has_method && !has_result && !has_error {
            self.translate_approval_request(&msg)
        } else if has_method && !has_id {
            self.translate_notification(&msg)
        } else if has_id && (has_result || has_error) {
            self.translate_response(&msg)
        } else {
            None
        }
    }

    fn translate_stderr_line(&self, line: &str) -> Option<UnifiedEvent> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        // Detect error patterns in Codex stderr output and surface them to the chat.
        // Codex writes human-readable errors to stderr (not JSON-RPC), e.g.:
        //   ERROR: unexpected status 401 Unauthorized: ...
        //   ERROR: Missing environment variable: `TOKENICODE_CODEX_API_KEY`.
        //   ERROR: Reconnecting... 1/5
        let is_error = trimmed.contains("ERROR:") || trimmed.contains("error:");
        let is_warning = trimmed.contains("WARN:") || trimmed.contains("warning:");

        if is_error || is_warning {
            let icon = if is_error { "⚠️" } else { "⚡" };
            let label = if is_error { "Error" } else { "Warning" };
            Some(UnifiedEvent::stream_event(serde_json::json!({
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "text",
                        "text": format!("\n{} Codex {}: {}\n", icon, label, trimmed)
                    }
                }
            })))
        } else {
            None
        }
    }

    fn build_interrupt_message(&self) -> String {
        let interrupt = serde_json::json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(),
            "method": "turn/interrupt"
        });
        interrupt.to_string()
    }

    fn build_permission_response(
        &self,
        request_id: &str,
        behavior: PermissionBehavior,
        _updated_input: Option<Value>,
        _tool_use_id: Option<&str>,
    ) -> String {
        let allow = matches!(behavior, PermissionBehavior::Allow);
        let resp = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id.parse::<u64>().unwrap_or(0),
            "result": {
                "allow": allow
            }
        });
        resp.to_string()
    }

    fn build_set_permission_mode_message(&self, mode: &str) -> String {
        // Map Claude permission mode to Codex sandbox mode
        let sandbox = match mode {
            "bypassPermissions" => "danger-full-access",
            "acceptEdits" => "workspace-write",
            _ => "read-only",
        };
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(),
            "method": "config/batchWrite",
            "params": {
                "edits": [{
                    "keyPath": "sandbox_mode",
                    "mergeStrategy": "replace",
                    "value": sandbox
                }],
                "reloadUserConfig": true
            }
        })
        .to_string()
    }

    fn build_set_model_message(&self, model: &str) -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(),
            "method": "config/batchWrite",
            "params": {
                "edits": [{
                    "keyPath": "model",
                    "mergeStrategy": "replace",
                    "value": model
                }],
                "reloadUserConfig": true
            }
        })
        .to_string()
    }

    fn build_user_message(&self, text: &str, thread_id: Option<&str>) -> String {
        let mut params = serde_json::json!({
            "input": [{
                "type": "text",
                "text": text
            }]
        });
        if let Some(tid) = thread_id {
            params["threadId"] = serde_json::Value::String(tid.to_string());
        }
        let turn = serde_json::json!({
            "jsonrpc": "2.0",
            "id": Self::next_id(),
            "method": "turn/start",
            "params": params
        });
        turn.to_string()
    }

    fn build_rewind_message(&self, _user_message_id: &str) -> String {
        String::new()
    }
}

// ─── Codex event translation ───────────────────────────────────────────────

impl CodexBackend {
    fn translate_notification(&self, msg: &Value) -> Option<UnifiedEvent> {
        let method = msg.get("method")?.as_str()?;
        let params = msg.get("params");

        match method {
            // item/started: params.item contains the item object (type, id, text, command, etc.)
            "item/started" => {
                let item = params?.get("item")?;
                let item_type = item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match item_type {
                    "agentMessage" => Some(UnifiedEvent::stream_event(serde_json::json!({
                        "event": {
                            "type": "content_block_start",
                            "index": 0,
                            "content_block": {
                                "type": "text",
                                "text": ""
                            }
                        }
                    }))),
                    "reasoning" => Some(UnifiedEvent::stream_event(serde_json::json!({
                        "event": {
                            "type": "content_block_start",
                            "index": 0,
                            "content_block": {
                                "type": "thinking",
                                "thinking": ""
                            }
                        }
                    }))),
                    "commandExecution" => {
                        let command = item
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        Some(UnifiedEvent::stream_event(serde_json::json!({
                            "event": {
                                "type": "content_block_start",
                                "index": 0,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": item.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                                    "name": "Bash",
                                    "input": {
                                        "command": command,
                                        "description": item.get("description").and_then(|v| v.as_str()).unwrap_or("")
                                    }
                                }
                            }
                        })))
                    }
                    "fileChange" => {
                        let path = item
                            .get("path")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let diff = item
                            .get("diff")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let tool_name = if item
                            .get("is_new_file")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                        {
                            "Write"
                        } else {
                            "Edit"
                        };
                        Some(UnifiedEvent::stream_event(serde_json::json!({
                            "event": {
                                "type": "content_block_start",
                                "index": 0,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": item.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                                    "name": tool_name,
                                    "input": {
                                        "file_path": path,
                                        "content": diff
                                    }
                                }
                            }
                        })))
                    }
                    _ => None,
                }
            }

            // item/agentMessage/delta: params has "delta" field (not "text")
            "item/agentMessage/delta" => {
                let delta = params?.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                Some(UnifiedEvent::stream_event(serde_json::json!({
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {
                            "type": "text_delta",
                            "text": delta
                        }
                    }
                })))
            }

            // item/reasoning/summaryTextDelta: params has "delta" field
            "item/reasoning/summaryTextDelta" => {
                let delta = params?.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                if delta.is_empty() {
                    return None;
                }
                Some(UnifiedEvent::stream_event(serde_json::json!({
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {
                            "type": "thinking_delta",
                            "thinking": delta
                        }
                    }
                })))
            }

            "item/commandExecution/outputDelta" => {
                let output_b64 = params
                    ?.get("output")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let decoded = base64_decode(output_b64)
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .unwrap_or_else(|_| "[binary output]".to_string());
                Some(UnifiedEvent::stream_event(serde_json::json!({
                    "event": {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {
                            "type": "text_delta",
                            "text": decoded
                        }
                    }
                })))
            }

            "item/completed" => {
                let item = params?.get("item")?;
                let item_type = item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match item_type {
                    "reasoning" => {
                        let summary = item
                            .get("summary")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("\n"))
                            .unwrap_or_default();
                        if summary.is_empty() {
                            return None;
                        }
                        Some(UnifiedEvent::Assistant {
                            message: AssistantMessage {
                                content: vec![ContentBlock::thinking(summary)],
                                model: None,
                                id: item.get("id").and_then(|v| v.as_str()).map(String::from),
                                role: Some("assistant".to_string()),
                                stop_reason: None,
                                stop_sequence: None,
                                usage: None,
                                extra: empty_object(),
                            },
                            session_id: String::new(),
                            parent_tool_use_id: None,
                            uuid: None,
                            extra: empty_object(),
                        })
                    }
                    "agentMessage" => {
                        let text = item
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let mut content: Vec<ContentBlock> = Vec::new();
                        if let Some(reasoning) =
                            item.get("reasoning").and_then(|v| v.as_str())
                        {
                            content.push(ContentBlock::thinking(reasoning));
                        }
                        content.push(ContentBlock::text(text));
                        Some(UnifiedEvent::Assistant {
                            message: AssistantMessage {
                                content,
                                model: None,
                                id: item
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .map(String::from),
                                role: Some("assistant".to_string()),
                                stop_reason: None,
                                stop_sequence: None,
                                usage: None,
                                extra: empty_object(),
                            },
                            session_id: String::new(),
                            parent_tool_use_id: None,
                            uuid: None,
                            extra: empty_object(),
                        })
                    }
                    "commandExecution" | "fileChange" => {
                        let tool_name = if item_type == "commandExecution" {
                            "Bash"
                        } else {
                            "Write"
                        };
                        let tool_id = item
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let tool_input = self.extract_tool_input(item, item_type);
                        Some(UnifiedEvent::Assistant {
                            message: AssistantMessage {
                                content: vec![ContentBlock::tool_use(
                                    tool_id, tool_name, tool_input,
                                )],
                                model: None,
                                id: None,
                                role: Some("assistant".to_string()),
                                stop_reason: None,
                                stop_sequence: None,
                                usage: None,
                                extra: empty_object(),
                            },
                            session_id: String::new(),
                            parent_tool_use_id: None,
                            uuid: None,
                            extra: empty_object(),
                        })
                    }
                    "toolResult" => {
                        let tool_use_id = item
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let result_text = item
                            .get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let content = serde_json::json!([{"type": "text", "text": result_text}]);
                        Some(UnifiedEvent::User {
                            message: UserMessage {
                                content: vec![ContentBlock::tool_result(
                                    tool_use_id, content,
                                )],
                                role: Some("user".to_string()),
                                model: None,
                                extra: empty_object(),
                            },
                            session_id: String::new(),
                            parent_tool_use_id: None,
                            uuid: None,
                            extra: empty_object(),
                        })
                    }
                    _ => None,
                }
            }

            "turn/completed" => {
                // Codex v0.146+: turn may have status "failed" even on turn/completed
                let turn = params.and_then(|p| p.get("turn"));
                let turn_status = turn
                    .and_then(|t| t.get("status"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if turn_status == "failed" {
                    let error_msg = turn
                        .and_then(|t| t.get("error"))
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .or_else(|| {
                            turn.and_then(|t| t.get("error"))
                                .and_then(|e| e.as_str())
                        })
                        .unwrap_or("turn failed");
                    return Some(UnifiedEvent::Result {
                        subtype: "error".to_string(),
                        usage: Usage::default(),
                        total_cost_usd: None,
                        duration_ms: 0,
                        num_turns: 0,
                        uuid: None,
                        result: Some(error_msg.to_string()),
                        parent_tool_use_id: None,
                        extra: empty_object(),
                    });
                }
                let usage = self.extract_usage(params);
                let duration_ms = params
                    .and_then(|p| p.get("duration_ms"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                Some(UnifiedEvent::result_success(
                    usage,
                    duration_ms,
                    1,
                    params
                        .and_then(|p| p.get("turn_id"))
                        .and_then(|v| v.as_str())
                        .map(String::from),
                ))
            }

            "turn/failed" => {
                let error = params
                    .and_then(|p| p.get("error"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error");
                Some(UnifiedEvent::Result {
                    subtype: "error".to_string(),
                    usage: Usage::default(),
                    total_cost_usd: None,
                    duration_ms: 0,
                    num_turns: 0,
                    uuid: None,
                    result: Some(error.to_string()),
                    parent_tool_use_id: None,
                    extra: empty_object(),
                })
            }

            "thread/tokenUsage/updated" => Some(UnifiedEvent::RateLimitEvent {
                extra: params.cloned().unwrap_or(empty_object()),
            }),

            "error" => {
                let error_msg = params
                    .and_then(|p| p.get("error"))
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error");
                eprintln!("[codex:error] {}", error_msg);
                // Only emit on first error (reconnection attempts are duplicates)
                Some(UnifiedEvent::stream_event(serde_json::json!({
                    "event": {
                        "type": "content_block_start",
                        "index": 0,
                        "content_block": {
                            "type": "text",
                            "text": format!("\n⚠️ Error: {}\n", error_msg)
                        }
                    }
                })))
            }

            "warning" => {
                let warn_msg = params
                    .and_then(|p| p.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                eprintln!("[codex:warn] {}", warn_msg);
                // Show warnings as system messages
                Some(UnifiedEvent::system(
                    "warning",
                    serde_json::json!({"message": warn_msg}),
                ))
            }

            "thread/status/changed" => {
                // Codex v0.146+: status can be string ("completed") or object ({"type":"systemError"})
                let status_str = params
                    .and_then(|p| p.get("status"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| {
                        params
                            .and_then(|p| p.get("status"))
                            .and_then(|s| s.get("type"))
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    });
                match status_str.as_deref() {
                    Some("completed") | Some("error") | Some("systemError") => {
                        Some(UnifiedEvent::process_exit())
                    }
                    _ => None,
                }
            }

            _ => None,
        }
    }

    fn translate_approval_request(&self, msg: &Value) -> Option<UnifiedEvent> {
        let _method = msg.get("method")?.as_str()?;
        // Accept BOTH numeric ids (codex's default) and string ids — a
        // string id (e.g. "req_…") read with as_u64() returns None and the
        // whole permission request would be silently dropped.
        let id = match msg.get("id") {
            Some(v) if v.is_u64() => v.as_u64().unwrap_or(0).to_string(),
            Some(v) if v.is_string() => v.as_str().unwrap_or("").to_string(),
            _ => return None,
        };
        if id.is_empty() {
            return None;
        }
        let params = msg.get("params");

        let tool_name = params
            .and_then(|p| p.get("tool_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_tool")
            .to_string();
        let input = params
            .and_then(|p| p.get("input"))
            .cloned()
            .unwrap_or(empty_object());
        let description = params
            .and_then(|p| p.get("description"))
            .and_then(|v| v.as_str())
            .map(String::from);

        Some(UnifiedEvent::PermissionRequest {
            request_id: id,
            tool_name,
            input,
            description,
            tool_use_id: None,
            extra: empty_object(),
        })
    }

    fn translate_response(&self, msg: &Value) -> Option<UnifiedEvent> {
        if let Some(result) = msg.get("result") {
            if let Some(model) = result.get("model").and_then(|v| v.as_str()) {
                return Some(UnifiedEvent::system(
                    "init",
                    serde_json::json!({
                        "model": model,
                        "session_id": result.get("thread").and_then(|t| t.get("id")).and_then(|v| v.as_str()).unwrap_or("")
                    }),
                ));
            }
        }
        None
    }

    fn extract_usage(&self, params: Option<&Value>) -> Usage {
        let usage = params.and_then(|p| p.get("usage"));
        Usage {
            input_tokens: usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            output_tokens: usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
            cache_write_tokens: None,
            extra: empty_object(),
        }
    }

    fn extract_tool_input(&self, item: &Value, item_type: &str) -> Value {
        match item_type {
            "commandExecution" => {
                let command = item
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                serde_json::json!({"command": command})
            }
            "fileChange" => {
                let path = item
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let diff = item
                    .get("diff")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                serde_json::json!({
                    "file_path": path,
                    "content": diff
                })
            }
            _ => empty_object(),
        }
    }
}

/// Base64 decode helper (Codex sends output chunks base64-encoded).
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|e| format!("base64 decode error: {}", e))
}
