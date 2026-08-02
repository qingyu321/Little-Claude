//! CLI backend abstraction for multi-CLI support (Claude + Codex).
//!
//! This module defines:
//! - `CliBackend` trait: uniform interface for spawning, communicating with, and
//!   translating output from different AI coding CLIs.
//! - `UnifiedEvent`: a normalized event model that both backends translate into,
//!   keeping the frontend's stream processor unchanged.
//! - `resolve_backend()`: resolves `"claude"` / `"codex"` strings to backend instances.

pub mod claude;
pub mod codex;
pub mod codex_config;

use crate::commands::StartSessionParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

// ─── Backend trait ──────────────────────────────────────────────────────────

/// Behavior for a permission/approval response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionBehavior {
    Allow,
    Deny,
}

/// Every CLI backend (Claude, Codex) implements this trait.
///
/// The trait methods cover the full lifecycle:
/// 1. **Spawn**: `find_binary`, `build_args`, `build_env`, `build_initial_message`
/// 2. **Stream processing**: `translate_stdout_line`, `translate_stderr_line`
/// 3. **Runtime control**: `build_interrupt_message`, `build_permission_response`,
///    `build_set_permission_mode_message`, `build_set_model_message`,
///    `build_rewind_message`
/// 4. **Follow-up messages**: `build_user_message`
#[async_trait::async_trait]
pub trait CliBackend: Send + Sync {
    /// Human-readable backend name for logging.
    fn name(&self) -> &'static str;

    /// Locate the CLI binary on this system.
    fn find_binary(&self) -> Option<String>;

    /// CLI arguments for child process spawn (e.g. `--output-format stream-json`).
    fn build_args(&self, params: &StartSessionParams) -> Vec<String>;

    /// Environment variables for the child process.
    fn build_env(&self, params: &StartSessionParams) -> HashMap<String, String>;

    /// The first message written to stdin after spawn.
    /// Claude: NDJSON `{type:"user", message:{...}}` with the prompt.
    /// Codex: JSON-RPC `initialize` + `initialized` + `thread/start` sequence.
    /// Returns `None` if stdin should stay empty (pre-warm).
    fn build_initial_message(&self, params: &StartSessionParams) -> Option<String>;

    /// Translate one stdout line into zero or more `UnifiedEvent`s for the frontend.
    ///
    /// Returns `None` if the line should be skipped (internal protocol messages,
    /// already-handled control requests, etc.).
    fn translate_stdout_line(
        &self,
        line: &str,
        stdin_id: &str,
    ) -> Option<UnifiedEvent>;

    /// Translate one stderr line into an optional `UnifiedEvent`.
    fn translate_stderr_line(&self, line: &str) -> Option<UnifiedEvent>;

    /// Build the message to send on stdin to interrupt the current turn.
    fn build_interrupt_message(&self) -> String;

    /// Build the stdin message responding to a permission/approval request.
    fn build_permission_response(
        &self,
        request_id: &str,
        behavior: PermissionBehavior,
        updated_input: Option<Value>,
        tool_use_id: Option<&str>,
    ) -> String;

    /// Build the stdin message to change permission mode at runtime.
    fn build_set_permission_mode_message(&self, mode: &str) -> String;

    /// Build the stdin message to change model at runtime.
    fn build_set_model_message(&self, model: &str) -> String;

    /// Build the stdin message for a follow-up user message (after the first message).
    /// `thread_id` is required by Codex for `turn/start`; ignored by Claude.
    fn build_user_message(&self, text: &str, thread_id: Option<&str>) -> String;

    /// Build the stdin message for rewinding files to a checkpoint.
    fn build_rewind_message(&self, user_message_id: &str) -> String;

    /// Whether to emit a synthetic `ProcessExit` event after stdout EOF.
    fn emits_process_exit(&self) -> bool {
        true
    }
}

// ─── Unified Event Model ────────────────────────────────────────────────────

/// Normalized event format emitted to the frontend.
///
/// The frontend's `useStreamProcessor.ts` already handles all these event types
/// (they mirror Claude CLI's NDJSON format). Codex events are translated into
/// this format by `CodexBackend::translate_stdout_line`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UnifiedEvent {
    /// Streaming incremental content (partial text, thinking, tool metadata).
    #[serde(rename = "stream_event")]
    StreamEvent {
        event: StreamEventInner,
    },

    /// Complete assistant message (one or more content blocks).
    #[serde(rename = "assistant")]
    Assistant {
        message: AssistantMessage,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_tool_use_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(flatten)]
        extra: Value,
    },

    /// User / tool_result message.
    #[serde(rename = "user")]
    User {
        message: UserMessage,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_tool_use_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(flatten)]
        extra: Value,
    },

    /// System lifecycle event (init, error, etc.).
    #[serde(rename = "system")]
    System {
        subtype: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(flatten)]
        extra: Value,
    },

    /// Permission / approval request from the CLI.
    /// Frontend renders as PermissionCard / QuestionCard / PlanReviewCard.
    #[serde(rename = "little_claude_permission_request")]
    PermissionRequest {
        request_id: String,
        tool_name: String,
        #[serde(default)]
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
        #[serde(flatten)]
        extra: Value,
    },

    /// Turn / generation completed.
    #[serde(rename = "result")]
    Result {
        subtype: String,
        #[serde(default)]
        usage: Usage,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_cost_usd: Option<f64>,
        #[serde(default)]
        duration_ms: u64,
        #[serde(default)]
        num_turns: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        uuid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_tool_use_id: Option<String>,
        #[serde(flatten)]
        extra: Value,
    },

    /// CLI process exited.
    #[serde(rename = "process_exit")]
    ProcessExit,

    /// Rate limit / token usage update.
    #[serde(rename = "rate_limit_event")]
    RateLimitEvent {
        #[serde(flatten)]
        extra: Value,
    },
}

// ─── Stream event inner types ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEventInner {
    #[serde(flatten)]
    pub fields: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    #[serde(default)]
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_sequence: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
    #[serde(flatten)]
    pub extra: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    #[serde(default)]
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(flatten)]
    pub extra: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Plain text block.
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(flatten)]
        extra: Value,
    },
    /// Tool use / function call block.
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
        #[serde(flatten)]
        extra: Value,
    },
    /// Tool result block.
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        #[serde(flatten)]
        extra: Value,
    },
    /// Thinking / reasoning block.
    #[serde(rename = "thinking")]
    Thinking {
        thinking: String,
        #[serde(flatten)]
        extra: Value,
    },
    /// Catch-all for unknown block types.
    #[serde(untagged)]
    Other(Value),
}

/// Token usage counters.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write_tokens: Option<u64>,
    #[serde(flatten)]
    pub extra: Value,
}

// ─── Backend Registry ──────────────────────────────────────────────────────

/// Resolve a backend by name. Returns the default ("claude") for `None` or
/// unrecognized names.
pub fn resolve_backend(name: Option<&str>) -> Arc<dyn CliBackend> {
    match name.unwrap_or("claude") {
        "codex" => Arc::new(codex::CodexBackend::new()),
        _ => Arc::new(claude::ClaudeBackend::new()),
    }
}

/// List available backend names (for UI).
pub fn backend_names() -> Vec<&'static str> {
    vec!["claude", "codex"]
}

// ─── Helpers for building content blocks ───────────────────────────────────

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        ContentBlock::Text {
            text: text.into(),
            extra: Value::Object(serde_json::Map::new()),
        }
    }

    pub fn tool_use(id: impl Into<String>, name: impl Into<String>, input: Value) -> Self {
        ContentBlock::ToolUse {
            id: id.into(),
            name: name.into(),
            input,
            extra: Value::Object(serde_json::Map::new()),
        }
    }

    pub fn tool_result(tool_use_id: impl Into<String>, content: Value) -> Self {
        ContentBlock::ToolResult {
            tool_use_id: tool_use_id.into(),
            content,
            is_error: None,
            extra: Value::Object(serde_json::Map::new()),
        }
    }

    pub fn thinking(text: impl Into<String>) -> Self {
        ContentBlock::Thinking {
            thinking: text.into(),
            extra: Value::Object(serde_json::Map::new()),
        }
    }
}

impl UnifiedEvent {
    pub fn stream_event(event: Value) -> Self {
        UnifiedEvent::StreamEvent {
            event: StreamEventInner { fields: event },
        }
    }

    pub fn system(subtype: &str, extra: Value) -> Self {
        UnifiedEvent::System {
            subtype: subtype.to_string(),
            model: None,
            extra,
        }
    }

    pub fn result_success(
        usage: Usage,
        duration_ms: u64,
        num_turns: u32,
        uuid: Option<String>,
    ) -> Self {
        UnifiedEvent::Result {
            subtype: "success".to_string(),
            usage,
            total_cost_usd: None,
            duration_ms,
            num_turns,
            uuid,
            result: None,
            parent_tool_use_id: None,
            extra: Value::Object(serde_json::Map::new()),
        }
    }

    pub fn process_exit() -> Self {
        UnifiedEvent::ProcessExit
    }
}

/// Create a minimal JSON Value object (for serde flatten default).
pub(crate) fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}
