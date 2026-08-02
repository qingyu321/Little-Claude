use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub pid: u32,
    pub cli_path: String,
}

#[derive(Debug)]
pub struct ManagedProcess {
    pub child: Child,
    /// Which CLI backend owns this process: "claude" or "codex".
    pub backend: String,
}

#[derive(Debug, Default, Clone)]
pub struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<ManagedProcess>>>>>,
    /// Codex thread IDs keyed by session_id, populated after thread/start response.
    pub(crate) codex_thread_ids: Arc<Mutex<HashMap<String, String>>>,
}

impl ProcessManager {
    /// Look up the backend name ("claude" or "codex") for a session.
    pub async fn get_backend(&self, session_id: &str) -> Option<String> {
        let map = self.processes.lock().await;
        map.get(session_id)
            .and_then(|p| {
                // Try to lock — if the process is being modified, skip
                p.try_lock().ok()
            })
            .map(|p| p.backend.clone())
    }

    /// Retrieve the Codex thread ID for a session.
    pub async fn get_codex_thread_id(&self, session_id: &str) -> Option<String> {
        let map = self.codex_thread_ids.lock().await;
        map.get(session_id).cloned()
    }

    /// Remove the Codex thread ID when a session is cleaned up.
    pub async fn remove_codex_thread_id(&self, session_id: &str) {
        let mut map = self.codex_thread_ids.lock().await;
        map.remove(session_id);
    }
}

/// Manages stdin handles for sending user responses to Claude processes
#[derive(Debug, Default, Clone)]
pub struct StdinManager {
    handles: Arc<Mutex<HashMap<String, ChildStdin>>>,
}

impl StdinManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, stdin: ChildStdin) {
        let mut map = self.handles.lock().await;
        map.insert(id, stdin);
    }

    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let mut map = self.handles.lock().await;
        if let Some(stdin) = map.get_mut(id) {
            // Atomic write: message + newline in one call to prevent interleaving (P1-2 fix)
            let payload = format!("{}\n", message);
            // Bound the lock hold: if a dead CLI leaves its stdin pipe open and
            // full, the write would block forever and stall every session's
            // sends (the lock is global). Timeout releases the lock with an
            // error; callers surface it to the user.
            let res = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                async {
                    stdin
                        .write_all(payload.as_bytes())
                        .await
                        .map_err(|e| format!("Failed to write to stdin: {}", e))?;
                    stdin
                        .flush()
                        .await
                        .map_err(|e| format!("Failed to flush stdin: {}", e))?;
                    Ok::<(), String>(())
                },
            )
            .await;
            match res {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(e),
                Err(_) => Err(format!(
                    "Timed out writing to stdin for session: {}",
                    id
                )),
            }
        } else {
            Err(format!("No stdin handle for session: {}", id))
        }
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.handles.lock().await;
        map.remove(id);
    }

    /// Clone the inner handles Arc for use in spawned tasks that need to write
    /// to stdin without holding a full `StdinManager` reference.
    pub fn clone_handles(&self) -> Arc<Mutex<HashMap<String, ChildStdin>>> {
        self.handles.clone()
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            codex_thread_ids: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, process: ManagedProcess) {
        let mut map = self.processes.lock().await;
        map.insert(id, Arc::new(Mutex::new(process)));
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.processes.lock().await;
        if let Some(proc) = map.remove(id) {
            // Actually kill the child process to prevent zombie leaks (P0-2 fix)
            let mut managed = proc.lock().await;
            if let Err(e) = managed.child.kill().await {
                eprintln!(
                    "[LITTLECLAUDE] Failed to kill process for session {}: {}",
                    id, e
                );
            }
        }
    }

    /// TK-329: List all active stdinIds so the frontend can detect orphaned processes
    /// after a browser refresh (frontend state is wiped but backend keeps processes alive).
    pub async fn active_ids(&self) -> Vec<String> {
        let map = self.processes.lock().await;
        map.keys().cloned().collect()
    }

    /// 等待进程退出状态并返回退出码。
    ///
    /// 供 stdout 读取循环在 EOF 后调用 —— 此时进程即将退出，等待成本极低；
    /// 超时（进程卡死）或进程已被移除时返回 None，调用方按"无退出码"处理。
    /// Unix 下被信号杀死的进程 `status.code()` 也为 None。
    pub async fn wait_status(&self, id: &str, timeout: std::time::Duration) -> Option<i32> {
        let proc = {
            let map = self.processes.lock().await;
            map.get(id).cloned()
        }?;
        let mut managed = proc.lock().await;
        match tokio::time::timeout(timeout, managed.child.wait()).await {
            Ok(Ok(status)) => status.code(),
            Ok(Err(e)) => {
                eprintln!("[LITTLECLAUDE] wait_status({id}) failed: {e}");
                None
            }
            Err(_) => {
                eprintln!("[LITTLECLAUDE] wait_status({id}) timed out after {timeout:?}");
                None
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StartSessionParams {
    pub prompt: String,
    pub cwd: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    /// When set, resume an existing Claude CLI session instead of starting a new one.
    /// The value should be the Claude CLI session ID (UUID).
    pub resume_session_id: Option<String>,
    /// Thinking effort level: "off", "low", "medium", "high", or "max".
    pub thinking_level: Option<String>,
    /// Session mode: "ask", "plan", or "auto" (default).
    pub session_mode: Option<String>,
    /// Active provider ID from providers.json.
    /// When set, the provider's env vars are injected into the CLI process.
    pub provider_id: Option<String>,
    /// Declared model context window. Used to override Claude Code auto-compact window.
    pub context_window: Option<u32>,
    /// Permission mode for CLI. Maps from frontend session modes:
    ///   "acceptEdits" (code mode) | "default" (ask mode) | "plan" | "bypassPermissions" (bypass)
    /// When not "bypassPermissions", enables --permission-prompt-tool stdio for structured
    /// permission requests via the SDK control protocol.
    pub permission_mode: Option<String>,
    /// Which CLI backend to use: "claude" (default) or "codex".
    /// When "codex", the backend spawns Codex CLI instead of Claude CLI.
    #[serde(default)]
    pub cli_backend: Option<String>,
    /// When false, omit --include-partial-messages from CLI args.
    /// This reduces stream event volume by 10-50×, improving performance on
    /// low-CPU / integrated-GPU machines. Default (None) = include (backward compat).
    #[serde(default)]
    pub include_partial_messages: Option<bool>,
}
