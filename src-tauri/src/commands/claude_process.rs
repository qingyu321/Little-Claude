use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

/// Windows Job Object wrapper (cfg(windows) only): puts a spawned CLI process
/// tree into a Job so killing a session kills the whole tree (node, shell
/// wrappers, etc.), not just the direct child. `Child::kill()` only kills the
/// direct process, which historically left orphaned grandchildren behind.
///
/// Lifecycle: created in `ProcessManager::insert` right after spawn, assigned
/// the child process, and terminated in `ProcessManager::remove`. The handle
/// closes on drop; with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set, closing the
/// last handle kills anything still in the job — a safety net for app exit,
/// session cleanup, or a TerminateJobObject failure.
#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    #[derive(Debug, Default)]
    pub(crate) struct WinJob {
        handle: HANDLE,
    }

    // HANDLE is a raw-pointer wrapper; ownership of the handle lives in this
    // struct, and it is only ever touched under the ProcessManager jobs lock.
    unsafe impl Send for WinJob {}
    unsafe impl Sync for WinJob {}

    impl WinJob {
        /// Create a named job (name embeds the child pid for debugging in
        /// Process Explorer / Sysinternals). Returns None on any failure —
        /// callers degrade to plain `Child::kill()`.
        pub(crate) fn create(pid: u32) -> Option<WinJob> {
            let name = format!("little-claude-{pid}");
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                let handle = match CreateJobObjectW(None, PCWSTR::from_raw(wide.as_ptr())) {
                    Ok(h) if !h.is_invalid() => h,
                    Ok(_) => {
                        eprintln!("[LITTLECLAUDE] CreateJobObjectW returned an invalid handle");
                        return None;
                    }
                    Err(e) => {
                        eprintln!("[LITTLECLAUDE] CreateJobObjectW failed: {}", e);
                        return None;
                    }
                };

                // ZERO-init is required: SetInformationJobObject reads the whole
                // struct, so any garbage in the unused fields makes it fail with
                // ERROR_INVALID_PARAMETER. `::default()` is `mem::zeroed()` here.
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if let Err(e) = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) {
                    eprintln!("[LITTLECLAUDE] SetInformationJobObject failed: {}", e);
                    let _ = CloseHandle(handle);
                    return None;
                }
                Some(WinJob { handle })
            }
        }

        /// Assign the child process to this job. Returns false on failure —
        /// the most common cause is the parent app already running inside
        /// another job that does not allow breakaway (e.g. launched from an
        /// IDE/terminal that manages jobs); in that case the caller falls back
        /// to `Child::kill()` for this session.
        pub(crate) fn assign(&self, child: &tokio::process::Child) -> bool {
            let Some(raw) = child.raw_handle() else {
                eprintln!("[LITTLECLAUDE] AssignProcessToJobObject skipped: child already exited");
                return false;
            };
            unsafe {
                match AssignProcessToJobObject(self.handle, HANDLE(raw)) {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!(
                            "[LITTLECLAUDE] AssignProcessToJobObject failed (job disabled for this session, falling back to Child::kill): {}",
                            e
                        );
                        false
                    }
                }
            }
        }

        /// Kill every process in the job tree. Returns true on success; on
        /// failure KILL_ON_JOB_CLOSE still cleans up when the handle closes.
        pub(crate) fn terminate(&self) -> bool {
            unsafe {
                match TerminateJobObject(self.handle, 0) {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!(
                            "[LITTLECLAUDE] TerminateJobObject failed (KILL_ON_JOB_CLOSE will clean up on handle close): {}",
                            e
                        );
                        false
                    }
                }
            }
        }
    }

    impl Drop for WinJob {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

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
    /// Windows Job Objects keyed by session_id for whole-tree kill.
    /// Empty on non-Windows (field only exists under cfg(windows)).
    #[cfg(windows)]
    jobs: Arc<Mutex<HashMap<String, windows_job::WinJob>>>,
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
///
/// M3: handles are wrapped in a per-session `Arc<Mutex<ChildStdin>>` so a
/// stuck CLI (full pipe, dead process) blocks ONLY its own session's writes
/// for the 10s timeout — with a single global lock, one wedged session
/// stalled every other session's sends / permission responses.
#[derive(Debug, Default, Clone)]
pub struct StdinManager {
    handles: Arc<Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>>,
}

impl StdinManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, stdin: ChildStdin) {
        let mut map = self.handles.lock().await;
        map.insert(id, Arc::new(Mutex::new(stdin)));
    }

    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        // Short critical section: clone the per-session Arc and release the
        // map lock BEFORE writing, so a slow write never blocks other
        // sessions' sends.
        let stdin_arc = {
            let map = self.handles.lock().await;
            map.get(id).cloned()
        };
        let Some(stdin_arc) = stdin_arc else {
            return Err(format!("No stdin handle for session: {}", id));
        };
        // Atomic write: message + newline in one call to prevent interleaving (P1-2 fix)
        let payload = format!("{}\n", message);
        // Bound the per-session lock hold: if a dead CLI leaves its stdin
        // pipe open and full, the write would block forever — timeout
        // releases the per-session lock with an error; callers surface it.
        let res = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            async {
                let mut stdin = stdin_arc.lock().await;
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
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.handles.lock().await;
        map.remove(id);
    }
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            codex_thread_ids: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(windows)]
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn insert(&self, id: String, process: ManagedProcess) {
        #[cfg(windows)]
        {
            // Put the child into a Job Object so the whole process tree (node,
            // cmd wrappers, etc.) dies with the session. Failure is non-fatal:
            // the job simply isn't tracked and removal falls back to
            // Child::kill(). The jobs lock is taken alone (never nested with
            // the processes lock in the same order as remove, so no deadlock).
            if let Some(pid) = process.child.id() {
                if let Some(job) = windows_job::WinJob::create(pid) {
                    if job.assign(&process.child) {
                        self.jobs.lock().await.insert(id.clone(), job);
                    }
                    // assign failed: job drops here, handle closes; the job is
                    // empty, so KILL_ON_JOB_CLOSE is a no-op.
                }
            }
        }
        let mut map = self.processes.lock().await;
        map.insert(id, Arc::new(Mutex::new(process)));
    }

    pub async fn remove(&self, id: &str) {
        let mut map = self.processes.lock().await;
        if let Some(proc) = map.remove(id) {
            // Actually kill the child process to prevent zombie leaks (P0-2 fix)
            let mut managed = proc.lock().await;
            #[cfg(windows)]
            {
                // Kill the whole job tree first. The WinJob handle is closed
                // when `job` drops — KILL_ON_JOB_CLOSE then catches any
                // straggler that raced in after TerminateJobObject.
                let killed_by_job = if let Some(job) = self.jobs.lock().await.remove(id) {
                    job.terminate()
                } else {
                    false
                };
                // TerminateJobObject already killed the direct child, so only
                // fall through to Child::kill() when the job path failed.
                if !killed_by_job {
                    if let Err(e) = managed.child.kill().await {
                        eprintln!(
                            "[LITTLECLAUDE] Failed to kill process for session {}: {}",
                            id, e
                        );
                    }
                }
            }
            #[cfg(not(windows))]
            {
                if let Err(e) = managed.child.kill().await {
                    eprintln!(
                        "[LITTLECLAUDE] Failed to kill process for session {}: {}",
                        id, e
                    );
                }
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
