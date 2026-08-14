//! DeepSeek Harness backend — one-shot `dsh --profile headless "<task>"` tasks.
//!
//! Unlike Claude/Codex, `dsh headless` is a one-shot runner: it answers ONE
//! task, prints the final assistant message as plain text to stdout, and
//! exits. There is no stream-json protocol, no persistent stdin pipe, and no
//! permission-prompt channel — so `build_initial_message` returns `None` and
//! every follow-up spawns a brand-new headless task.
//!
//! The stdout reader in `start_deepseek_session` buffers all output and emits
//! a complete assistant message (content_block_start → delta → stop →
//! message_delta → message_stop) once the process exits.

use super::*;
use crate::commands::StartSessionParams;
use std::collections::HashMap;

pub struct DeepseekBackend {}

impl DeepseekBackend {
    pub fn new() -> Self {
        Self {}
    }
}

#[async_trait::async_trait]
impl CliBackend for DeepseekBackend {
    fn name(&self) -> &'static str {
        "deepseek"
    }

    fn find_binary(&self) -> Option<String> {
        crate::find_deepseek_binary()
    }

    fn build_args(&self, params: &StartSessionParams) -> Vec<String> {
        // Task text travels as a CLI argument for headless (not stdin).
        let mut args = vec!["--profile".to_string(), "headless".to_string()];
        if !params.prompt.is_empty() {
            args.push(params.prompt.clone());
        }
        args
    }

    fn build_env(&self, _params: &StartSessionParams) -> HashMap<String, String> {
        HashMap::new()
    }

    /// No stdin message — the task is already a CLI argument.
    fn build_initial_message(&self, _params: &StartSessionParams) -> Option<String> {
        None
    }

    /// Headless stdout is final-answer plain text, not NDJSON. The reader
    /// buffers it and emits the complete message at EOF — nothing per line.
    fn translate_stdout_line(&self, _line: &str, _stdin_id: &str) -> Option<UnifiedEvent> {
        None
    }

    fn translate_stderr_line(&self, line: &str) -> Option<UnifiedEvent> {
        // Surface dsh boot errors to the chat (e.g. missing API key).
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        if trimmed.contains("Error") || trimmed.contains("error") {
            return Some(UnifiedEvent::stream_event(serde_json::json!({
                "event": {
                    "type": "result",
                    "subtype": "error",
                    "result": trimmed
                }
            })));
        }
        None
    }

    // No stdin pipe exists — the following builders are never exercised, but
    // must exist to satisfy the trait. Empty strings are inert.

    fn build_interrupt_message(&self) -> String {
        String::new()
    }

    fn build_permission_response(
        &self,
        _request_id: &str,
        _behavior: PermissionBehavior,
        _updated_input: Option<Value>,
        _tool_use_id: Option<&str>,
    ) -> String {
        String::new()
    }

    fn build_set_permission_mode_message(&self, _mode: &str) -> String {
        String::new()
    }

    fn build_set_model_message(&self, _model: &str) -> String {
        String::new()
    }

    fn build_user_message(&self, _text: &str, _thread_id: Option<&str>) -> String {
        String::new()
    }

    fn build_rewind_message(&self, _user_message_id: &str) -> String {
        String::new()
    }
}
