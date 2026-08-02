//! Claude CLI backend — wraps the existing Claude CLI integration.
//!
//! This module will be extracted from `lib.rs` in Phase 1B.
//! For now, it is a skeleton that delegates to the existing code paths.

use super::*;
use crate::commands::StartSessionParams;
use serde_json::Value;
use std::collections::HashMap;

pub struct ClaudeBackend {}

impl ClaudeBackend {
    pub fn new() -> Self {
        Self {}
    }
}

#[async_trait::async_trait]
impl CliBackend for ClaudeBackend {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn find_binary(&self) -> Option<String> {
        crate::find_claude_binary()
    }

    fn build_args(&self, params: &StartSessionParams) -> Vec<String> {
        let mut args = vec![
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--replay-user-messages".to_string(),
            "--strict-mcp-config".to_string(),
        ];
        // A2: --include-partial-messages is opt-out (default true for backward compat).
        if params.include_partial_messages.unwrap_or(true) {
            args.push("--include-partial-messages".to_string());
        }
        args
    }

    fn build_env(&self, _params: &StartSessionParams) -> HashMap<String, String> {
        HashMap::new()
    }

    fn build_initial_message(&self, params: &StartSessionParams) -> Option<String> {
        if params.prompt.is_empty() {
            return None;
        }
        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": params.prompt}]
            }
        });
        Some(msg.to_string())
    }

    fn translate_stdout_line(&self, line: &str, _stdin_id: &str) -> Option<UnifiedEvent> {
        // Pass-through: parse the line as JSON and forward it as-is.
        match serde_json::from_str::<Value>(line) {
            Ok(v) => Some(UnifiedEvent::stream_event(v)),
            Err(_) => None,
        }
    }

    fn translate_stderr_line(&self, _line: &str) -> Option<UnifiedEvent> {
        None
    }

    fn build_interrupt_message(&self) -> String {
        let req = crate::protocol::ControlRequest::interrupt();
        serde_json::to_string(&req).unwrap_or_default()
    }

    fn build_permission_response(
        &self,
        request_id: &str,
        behavior: PermissionBehavior,
        updated_input: Option<Value>,
        tool_use_id: Option<&str>,
    ) -> String {
        let response_behavior = match behavior {
            PermissionBehavior::Allow => "allow",
            PermissionBehavior::Deny => "deny",
        };
        let mut response = serde_json::json!({
            "behavior": response_behavior,
        });
        if let Some(input) = updated_input {
            response["updatedInput"] = input;
        }
        if let Some(id) = tool_use_id {
            response["toolUseID"] = Value::String(id.to_string());
        }
        let msg = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response
            }
        });
        msg.to_string()
    }

    fn build_set_permission_mode_message(&self, mode: &str) -> String {
        let req = crate::protocol::ControlRequest::set_permission_mode(mode.to_string());
        serde_json::to_string(&req).unwrap_or_default()
    }

    fn build_set_model_message(&self, model: &str) -> String {
        let req = crate::protocol::ControlRequest::set_model(Some(model.to_string()));
        serde_json::to_string(&req).unwrap_or_default()
    }

    fn build_user_message(&self, text: &str, _thread_id: Option<&str>) -> String {
        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": text}]
            }
        });
        msg.to_string()
    }

    fn build_rewind_message(&self, user_message_id: &str) -> String {
        let req = crate::protocol::ControlRequest::rewind_files(user_message_id.to_string());
        serde_json::to_string(&req).unwrap_or_default()
    }
}
