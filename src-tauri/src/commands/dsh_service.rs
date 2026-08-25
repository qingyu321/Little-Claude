//! DSH (DeepSeek Harness) service client — D-N1-B service integration transport.
//!
//! Owns the `dsh --profile web` service lifecycle:
//! 1. **Probe & host**: reuse an externally running service (default port 3080,
//!    verified via `host.describe`); otherwise spawn our own `dsh web` on a
//!    free port and poll until ready.
//! 2. **Unary RPC**: `POST /api/<method>` with the four-quadrant envelope
//!    (`client-request` / `server-response`, rpcId echo validation).
//! 3. **WS downlinks**: one mux stream (`/api/events.mux`) + one host stream
//!    (`/api/events.host`) per service, broadcast to the translation task.
//!
//! Trust fence: loopback hosts pass the browser-trust gate without a token —
//! a plain `Host: 127.0.0.1:<port>` header is sufficient. All payloads are
//! plain JSON (no codec), so a bare HTTP/WS client is the official path.

use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex, RwLock};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Default port probed first — an externally running `dsh web` wins over spawning.
const DEFAULT_PORT: u16 = 3080;
/// How long to wait for a spawned service to become ready (60 × 500ms = 30s).
const READY_POLLS: u32 = 60;
const READY_INTERVAL: Duration = Duration::from_millis(500);
/// Spawn probes: try 4 consecutive ports above the default if it is busy.
const SPAWN_PORT_TRIES: u16 = 4;
/// Unary request timeout.
const UNARY_TIMEOUT: Duration = Duration::from_secs(30);
/// Short timeout for liveness probes (ensure / spawn readiness). A hung or
/// half-dead service must not block session startup for 30s.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// Max reconnect backoff (exponential 1s -> 2s -> ... capped here).
const RECONNECT_BACKOFF_CAP: Duration = Duration::from_secs(30);

/// Shared, lazily-created HTTP client.
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        match reqwest::Client::builder().timeout(UNARY_TIMEOUT).build() {
            Ok(c) => c,
            // Never panic the whole process on client construction failure —
            // fall back to a default client (loses the 30s timeout, but keeps
            // the service usable).
            Err(e) => {
                log::warn!("[dsh:service] reqwest client build failed, using default: {}", e);
                reqwest::Client::new()
            }
        }
    })
}

/// Short-timeout client for liveness probes (2s). Never used for real RPC.
static PROBE_HTTP: OnceLock<reqwest::Client> = OnceLock::new();
fn probe_http() -> &'static reqwest::Client {
    PROBE_HTTP.get_or_init(|| {
        match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[dsh:service] probe client build failed, using default: {}", e);
                reqwest::Client::new()
            }
        }
    })
}

/// Exponential reconnect backoff: 1s -> 2s -> 4s -> ... capped at 30s.
async fn reconnect_delay(attempt: &mut u32) {
    let seconds = 1u64 << (*attempt).min(5);
    let delay = Duration::from_secs(seconds.min(RECONNECT_BACKOFF_CAP.as_secs()));
    *attempt = attempt.saturating_add(1);
    tokio::time::sleep(delay).await;
}

/// One routed LC tab on a DSH session.
#[derive(Debug, Clone)]
pub struct DshRoute {
    /// LC `stdin_id` (tab) receiving translated stream events.
    pub stdin_id: String,
    /// Bypass mode: approval frames are auto-allowed instead of surfacing
    /// PermissionCards (mirrors Claude's `--dangerously-skip-permissions`).
    pub auto_allow: bool,
    /// DSH agent preset the tab's session was composed with. Carried so the
    /// R11 self-heal (service restart → session rebuild) recreates the session
    /// under the SAME preset (bash/web-search/file tools stay available) instead
    /// of falling back to the profile default.
    pub agent_preset: Option<String>,
}

/// Per-service state (one per running `dsh web`).
pub struct DshServiceState {
    /// `http://127.0.0.1:<port>`
    pub base_url: String,
    /// `ws://127.0.0.1:<port>`
    pub ws_url: String,
    /// Whether LC spawned this service (LC owns its lifecycle then).
    #[allow(dead_code)]
    pub spawned: bool,
    /// Child handle of the spawned service (only when `spawned`) — kept
    /// alive so `kill_on_drop` reaps it when the state Arc is released.
    #[allow(dead_code)]
    child: std::sync::Mutex<Option<tokio::process::Child>>,
    /// Handles of the mux/host reader tasks — aborted on Drop so a
    /// service replacement (respawn) never leaks reconnect loops pinned
    /// to a stale ws_url (they would otherwise retry forever).
    reader_handles: std::sync::Mutex<Vec<tokio::task::AbortHandle>>,
    /// Wall-clock (unix secs) when the spawned child was created — used to
    /// guard taskkill against PID reuse (kill only if the PID still belongs
    /// to a process born at that moment).
    spawned_at: Option<u64>,
    /// Route map: dsh `sessionId` → routed LC tab.
    pub session_routes: Arc<Mutex<HashMap<String, DshRoute>>>,
    /// Highest consumed seq per session (reconnect catch-up baseline).
    pub last_seqs: Arc<Mutex<HashMap<String, u64>>>,
    /// Per-session translators (S1). Held here — not as locals of
    /// route_mux_frames — so kill_session / lifecycle ends can drop stale
    /// entries (D10: they used to grow unboundedly for every session ever
    /// routed on this service).
    pub translators: Arc<Mutex<HashMap<String, crate::backends::dsh_events::DshTranslator>>>,
}

impl DshServiceState {
    /// Start the mux/host reader tasks. Both streams must stay open for the
    /// whole service lifetime; reconnects happen with a short backoff.
    pub fn start_readers(&self) {
        let (mux_tx, _) = broadcast::channel::<Value>(512);
        let mux_rx2 = mux_tx.subscribe();
        // Route mux frames to the translate task (single consumer).
        let mut handles = Vec::with_capacity(3);
        handles.push(tokio::spawn(read_mux_loop(self.ws_url.clone(), mux_tx.clone())).abort_handle());
        handles.push(tokio::spawn(route_mux_frames(
            mux_rx2,
            self.base_url.clone(),
            self.session_routes.clone(),
            self.last_seqs.clone(),
            self.translators.clone(),
        ))
        .abort_handle());
        // Host stream: keep the socket alive and surface session lifecycle
        // end events to the owning tab (prevents permanent "running" UI).
        handles.push(tokio::spawn(read_host_loop(
            self.ws_url.clone(),
            self.session_routes.clone(),
            self.translators.clone(),
            self.last_seqs.clone(),
        ))
        .abort_handle());
        *self.reader_handles.lock().unwrap() = handles;
    }

    /// Best-effort synchronous teardown of a spawned service (app exit or
    /// stale-service replacement). Windows: `taskkill /T` kills the whole
    /// cmd -> node tree (kill_on_drop alone would only kill cmd.exe).
    /// Elsewhere: `start_kill` + `kill_on_drop` reaps on Arc drop.
    pub fn shutdown_sync(&self) {
        if !self.spawned {
            return; // external service — never touch it
        }
        #[cfg(target_os = "windows")]
        {
            let pid = self.child.lock().unwrap().as_ref().and_then(|c| c.id());
            if let Some(pid) = pid {
                // PID-reuse guard: taskkill by PID could kill an UNRELATED
                // process if our child already exited and the OS reused the
                // PID. Verify the live process at that PID was created at
                // (approximately) the moment we spawned the service before
                // killing. PowerShell query is sync and bounded (2s).
                let guard_ok = self.spawned_at.map(|want| {
                    // want = unix secs when we spawned the child. The live
                    // process's StartTime (unix secs) must match within a
                    // generous ±10s window — a reused PID would show a
                    // completely different birth time.
                    let script = format!(
                        "try {{ $p = Get-Process -Id {} -ErrorAction Stop; [int64]($p.StartTime.ToUniversalTime().Subtract([datetime]::new(1970,1,1,0,0,0,[datetimekind]::Utc)).TotalSeconds) }} catch {{ -1 }}",
                        pid
                    );
                    // #19 (bug): .output() had NO timeout — a hung PowerShell
                    // blocked this sync fn forever (and with it ensure()/exit
                    // hooks that call it). Spawn + poll with a hard deadline.
                    let out = (|| -> Option<std::process::Output> {
                        let mut child = std::process::Command::new("powershell")
                            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                            .creation_flags(0x08000000)
                            .stdout(std::process::Stdio::piped())
                            .stderr(std::process::Stdio::null())
                            .spawn()
                            .ok()?;
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(3);
                        loop {
                            match child.try_wait() {
                                Ok(Some(status)) => {
                                    let mut stdout = Vec::new();
                                    if let Some(mut s) = child.stdout.take() {
                                        use std::io::Read;
                                        let _ = s.read_to_end(&mut stdout);
                                    }
                                    return Some(std::process::Output {
                                        status,
                                        stdout,
                                        stderr: Vec::new(),
                                    });
                                }
                                Ok(None) => {
                                    if std::time::Instant::now() >= deadline {
                                        let _ = child.kill();
                                        let _ = child.wait();
                                        return None;
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                }
                                Err(_) => return None,
                            }
                        }
                    })();
                    match out {
                        Some(o) if o.status.success() => {
                            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                            match s.parse::<i64>() {
                                Ok(born) => {
                                    let want_i = want as i64;
                                    (born - want_i).abs() <= 10
                                }
                                Err(_) => false,
                            }
                        }
                        _ => false,
                    }
                });
                if guard_ok.unwrap_or(false) {
                    // Same CREATE_NO_WINDOW fix — taskkill flashed a console
                    // on service replacement / app exit.
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                } else {
                    log::warn!(
                        "[dsh:service] skip taskkill pid {} — process missing or age mismatch (PID reuse guard)",
                        pid
                    );
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Some(mut c) = self.child.lock().unwrap().take() {
                let _ = c.start_kill();
            }
        }
    }
}

/// Reads `server-request` frames from the mux WebSocket and broadcasts them.
async fn read_mux_loop(ws_url: String, tx: broadcast::Sender<Value>) {
    // The mux downlink lives at /api/events.mux — `ws_url` is the bare
    // ws://host:port root. Opening the ROOT path made the server reject the
    // upgrade (close 1006) and the reader reconnect with backoff forever, so
    // DSH realtime events (assistant chunks, `contextPressure` projections,
    // tool results, turn/end) never reached the frontend: live replies only
    // appeared after reopening from disk, and the DeepSeek Ctx bar stayed 0.
    // Same trim+append pattern as the host loop below.
    let mux_ws = format!("{}/api/events.mux", ws_url.trim_end_matches("/api/events.mux"));
    let mut attempt: u32 = 0;
    loop {
        match open_ws(&mux_ws).await {
            Ok(mut ws) => {
                attempt = 0; // connected — reset backoff
                log::info!("[dsh:service] mux connected ({})", ws_url);
                loop {
                    match ws.next().await {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            match serde_json::from_str::<Value>(&text) {
                                Ok(frame) => {
                                    let _ = tx.send(frame);
                                }
                                Err(e) => log::warn!("[dsh:service] bad mux frame: {}", e),
                            }
                        }
                        Some(Ok(_)) => {} // ping/pong/binary ignored
                        Some(Err(e)) => {
                            log::warn!("[dsh:service] mux read error: {}", e);
                            break;
                        }
                        None => break,
                    }
                }
                log::warn!("[dsh:service] mux closed, reconnecting…");
            }
            Err(e) => log::warn!("[dsh:service] mux connect failed: {}", e),
        }
        reconnect_delay(&mut attempt).await;
    }
}

/// Keeps the host downlink socket open. Session lifecycle frames (ended /
/// deleted / killed) are surfaced to the owning tab as `process_exit` so the
/// UI can't stay in a permanent "running" state when the service closes a
/// session out from under us.
async fn read_host_loop(
    ws_url: String,
    session_routes: Arc<Mutex<HashMap<String, DshRoute>>>,
    translators: Arc<Mutex<HashMap<String, crate::backends::dsh_events::DshTranslator>>>,
    last_seqs: Arc<Mutex<HashMap<String, u64>>>,
) {
    let host_ws = format!("{}/api/events.host", ws_url.trim_end_matches("/api/events.mux"));
    let mut attempt: u32 = 0;
    loop {
        match open_ws(&host_ws).await {
            Ok(mut ws) => {
                attempt = 0; // connected — reset backoff
                while let Some(Ok(msg)) = ws.next().await {
                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                            if let Some(exit) = parse_host_lifecycle_exit(&frame) {
                                let sid = exit.0.clone();
                                let routes = session_routes.lock().await;
                                if let Some(route) = routes.get(&sid).cloned() {
                                    drop(routes);
                                    let _ = crate::emit_stream_event(
                                        &route.stdin_id,
                                        json!({ "type": "process_exit", "code": 0 }),
                                    );
                                }
                                // D10: session is gone — prune translator +
                                // seq bookkeeping so the maps don't grow with
                                // every session ever routed.
                                translators.lock().await.remove(&sid);
                                last_seqs.lock().await.remove(&sid);
                            }
                        }
                    }
                }
                log::warn!("[dsh:service] host stream closed, reconnecting…");
            }
            Err(e) => log::warn!("[dsh:service] host connect failed: {}", e),
        }
        reconnect_delay(&mut attempt).await;
    }
}

/// Best-effort detection of a host-frame that terminates a DSH session.
/// Returns `(sessionId)` when the frame looks like a lifecycle end event.
/// Unknown frame shapes are ignored (never guess — the mux stream remains
/// the authoritative event source).
fn parse_host_lifecycle_exit(frame: &Value) -> Option<(String,)> {
    let payload = frame.get("payload")?;
    let sid = payload.get("sessionId").and_then(|v| v.as_str())?;
    if sid.is_empty() {
        return None;
    }
    let ty = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let ty_lower = ty.to_ascii_lowercase();
    let looks_like_end = ["ended", "closed", "deleted", "killed", "removed", "cancelled"]
        .iter()
        .any(|k| ty_lower.contains(k));
    if !looks_like_end {
        return None;
    }
    log::info!("[dsh:service] host lifecycle end for session {} ({})", sid, ty);
    Some((sid.to_string(),))
}

/// Raw WebSocket connect (text messages only — the server closes with 1008
/// if the client ever sends anything).
async fn open_ws(
    url: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| format!("WS connect {}: {}", url, e))?;
    Ok(ws)
}

/// Broadcast consumer: translate mux frames → UnifiedEvent JSON, route by
/// sessionId to the owning tab's `claude:stream:{stdinId}` channel.
async fn route_mux_frames(
    mut rx: broadcast::Receiver<Value>,
    base_url: String,
    session_routes: Arc<Mutex<HashMap<String, DshRoute>>>,
    last_seqs: Arc<Mutex<HashMap<String, u64>>>,
    translators: Arc<Mutex<HashMap<String, crate::backends::dsh_events::DshTranslator>>>,
) {
    use crate::backends::dsh_events;
    // S1: one translator per DSH session. DSH block indices restart from 0 on
    // every turn, so a shared translator would let concurrent tabs' frames
    // collide on the same indices (missed content_block_start, tool blocks
    // misclassified at block-end, usage polluted across sessions). The map
    // lives on DshServiceState so lifecycle ends can prune it (D10).
    loop {
        match rx.recv().await {
            Ok(frame) => {
                let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                let session_id = payload.get("sessionId").and_then(|v| v.as_str());
                let frame_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match frame_type {
                    "session/event" => {
                        let sid = session_id.unwrap_or_default().to_string();
                        let route = {
                            let routes = session_routes.lock().await;
                            routes.get(&sid).cloned()
                        };
                        let Some(route) = route else {
                            continue; // not our session
                        };
                        // Seq monotonicity: drop stale/replayed frames after a
                        // reconnect (the server may replay from an earlier
                        // checkpoint). last_seqs is the high-water mark.
                        let seq = payload.pointer("/event/seq").and_then(|v| v.as_u64());
                        if let Some(seq) = seq {
                            let mut seqs = last_seqs.lock().await;
                            if let Some(&last) = seqs.get(&sid) {
                                if seq <= last {
                                    if last - seq > 1000 {
                                        // #23: a huge backwards jump means the
                                        // service restarted and seq counters
                                        // reset — holding the old watermark
                                        // would silently drop ALL new frames
                                        // until they climb past it. Re-arm.
                                        log::warn!(
                                            "[dsh:service] {} seq reset detected ({} → {}), re-arming watermark",
                                            sid, last, seq
                                        );
                                    } else {
                                        continue; // duplicate / out-of-order — drop
                                    }
                                } else if seq > last + 1 {
                                    // #23: surface server-side frame loss instead
                                    // of swallowing it without a trace.
                                    log::warn!(
                                        "[dsh:service] {} seq gap {} → {} ({} frames lost upstream)",
                                        sid, last, seq, seq - last - 1
                                    );
                                }
                            }
                            seqs.insert(sid.clone(), seq);
                        }
                        // Per-turn translator state: reset BEFORE translating
                        // turn/start (new turn — stale block indices must not
                        // leak in), and AFTER translating turn/end (translate_
                        // turn_end reads state.usage first, then the state is
                        // cleared so a following turn that emits no turn/start
                        // cannot inherit stale indices — see reset_for_turn).
                        let ev_type = payload.pointer("/event/type").and_then(|v| v.as_str());
                        let events = {
                            let mut ts = translators.lock().await;
                            let t = ts.entry(sid).or_default();
                            if ev_type == Some("turn/start") {
                                t.reset_for_turn();
                            }
                            let evs = dsh_events::translate_session_event(t, &payload);
                            if ev_type == Some("turn/end") {
                                t.reset_for_turn();
                            }
                            evs
                        };
                        for ev in events {
                            let _ = crate::emit_stream_event(&route.stdin_id, ev);
                        }
                    }
                    "approval/requested" => {
                        let sid = session_id.unwrap_or_default().to_string();
                        let route = {
                            let routes = session_routes.lock().await;
                            routes.get(&sid).cloned()
                        };
                        let Some(route) = route else {
                            continue;
                        };
                        if route.auto_allow {
                            // Bypass mode: auto-approve instead of surfacing a card.
                            let approval_id = payload
                                .get("approvalId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !approval_id.is_empty() {
                                // #20 (bug): fire the respond RPC from a spawned
                                // task. This mux consumer is the SINGLE reader of
                                // the broadcast(512) channel — a synchronous wait
                                // (up to 30s per unary) used to stall every other
                                // session's frames until >512 piled up and were
                                // dropped as Lagged.
                                let base = base_url.clone();
                                let sid_owned = sid.clone();
                                tokio::spawn(async move {
                                    let _ = unary(
                                        &base,
                                        "respond",
                                        json!({
                                            "type": "client-response",
                                            "rpcId": approval_id,
                                            "result": { "ok": true, "value": {
                                                "sessionId": sid_owned,
                                                "approvalId": approval_id,
                                                "outcome": "allowed-once",
                                            } },
                                        }),
                                    )
                                    .await;
                                });
                            }
                        } else {
                            for ev in dsh_events::translate_interaction_frame(&payload) {
                                let _ = crate::emit_stream_event(&route.stdin_id, ev);
                            }
                        }
                    }
                    "question/requested" => {
                        let sid = session_id.unwrap_or_default().to_string();
                        let route = {
                            let routes = session_routes.lock().await;
                            routes.get(&sid).cloned()
                        };
                        if let Some(route) = route {
                            for ev in dsh_events::translate_interaction_frame(&payload) {
                                let _ = crate::emit_stream_event(&route.stdin_id, ev);
                            }
                        }
                    }
                    "session/projection" => {
                        // Context-pressure projections (pushed on usage /
                        // request/context events) feed the live Ctx bar —
                        // previously dropped as informational.
                        let sid = session_id.unwrap_or_default().to_string();
                        let route = {
                            let routes = session_routes.lock().await;
                            routes.get(&sid).cloned()
                        };
                        let Some(route) = route else {
                            continue;
                        };
                        // Capture cumulative sessionStats into the translator so
                        // turn/end can derive the per-turn API duration.
                        {
                            let mut ts = translators.lock().await;
                            let t = ts.entry(sid.clone()).or_default();
                            dsh_events::translate_stats_projection(t, &payload);
                        }
                        let ev = dsh_events::translate_projection_frame(&payload);
                        if !ev.is_null() {
                            let _ = crate::emit_stream_event(&route.stdin_id, ev);
                        }
                    }
                    _ => {} // subscribed / queue / jobs / stream/error — informational
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                log::warn!("[dsh:service] mux lagged, dropped {} frames", n);
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// Manager owned by AppState. Tracks at most one live service.
#[derive(Default)]
pub struct DshServiceManager {
    inner: RwLock<Option<Arc<DshServiceState>>>,
}

impl Drop for DshServiceState {
    fn drop(&mut self) {
        // Abort the mux/host reader tasks — without this, a service
        // replacement (respawn) leaks three reconnect loops pinned to the
        // stale ws_url, retrying forever against a dead port.
        if let Ok(handles) = self.reader_handles.lock() {
            for h in handles.iter() {
                h.abort();
            }
        }
    }
}

impl DshServiceManager {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Drop for DshServiceManager {
    fn drop(&mut self) {
        // Last-resort cleanup: the tokio runtime may already be gone during
        // app teardown, so only the synchronous path is safe here. The
        // primary cleanup runs in lib.rs's RunEvent::Exit hook (teardown()),
        // which fires while the runtime is still alive.
        if let Some(state) = self.inner.try_write().ok().and_then(|mut g| g.take()) {
            state.shutdown_sync();
        }
    }
}

impl DshServiceManager {
    /// Get the current service if one exists (no spawn). For teardown paths
    /// (kill_session) where spawning a fresh service just to delete a route
    /// would be wasteful.
    pub async fn get(&self) -> Option<Arc<DshServiceState>> {
        self.inner.read().await.clone()
    }

    /// Get the current service, ensuring one exists (probe → spawn).
    /// A cached Arc is only reused if it still answers host.describe with
    /// the short probe timeout; a dead service is torn down and respawned
    /// instead of pinning every session to a corpse (H1).
    pub async fn ensure(&self) -> Result<Arc<DshServiceState>, String> {
        {
            let guard = self.inner.read().await;
            if let Some(state) = guard.as_ref() {
                let base = state.base_url.clone();
                if probe_unary(&base, "host.describe", json!({})).await.is_ok() {
                    return Ok(state.clone());
                }
                log::warn!("[dsh:service] cached service at {} not responding", base);
            }
        }
        // Double-checked: only one spawner wins the write lock.
        let mut guard = self.inner.write().await;
        if let Some(state) = guard.as_ref() {
            let base = state.base_url.clone();
            if probe_unary(&base, "host.describe", json!({})).await.is_ok() {
                return Ok(state.clone());
            }
            log::warn!("[dsh:service] cached service dead, replacing");
            let stale = guard.take();
            if let Some(stale) = stale {
                stale.shutdown_sync(); // usually already dead — no-op
            }
        }
        let state = self.spawn_or_reuse().await?;
        state.start_readers();
        *guard = Some(state.clone());
        Ok(state)
    }

    /// Tear down the current service (spawned only — external services are
    /// never touched). Used by the app-exit hook and by ensure() when the
    /// cached service is detected dead.
    pub fn teardown(&self) {
        if let Some(state) = self.inner.try_write().ok().and_then(|mut g| g.take()) {
            state.shutdown_sync();
        }
    }

    async fn spawn_or_reuse(&self) -> Result<Arc<DshServiceState>, String> {
        // 1. Probe the default port for an externally running service.
        if let Ok(desc) = probe_unary(&format!("http://127.0.0.1:{}", DEFAULT_PORT), "host.describe", json!({})).await {
            log::info!(
                "[dsh:service] reusing external dsh at :{} (cwd={})",
                DEFAULT_PORT,
                desc.get("cwd").and_then(|v| v.as_str()).unwrap_or("")
            );
            return Ok(Arc::new(DshServiceState {
                base_url: format!("http://127.0.0.1:{}", DEFAULT_PORT),
                ws_url: format!("ws://127.0.0.1:{}", DEFAULT_PORT),
                spawned: false,
                child: std::sync::Mutex::new(None),
                session_routes: Arc::new(Mutex::new(HashMap::new())),
                last_seqs: Arc::new(Mutex::new(HashMap::new())),
                translators: Arc::new(Mutex::new(HashMap::new())),
                reader_handles: std::sync::Mutex::new(Vec::new()),
                spawned_at: None,
            }));
        }

        // 2. Spawn our own on a free port.
        let bin = crate::find_deepseek_binary()
            .ok_or_else(|| "dsh CLI (DeepSeek Harness) not found. Install it with: npm install -g @deepseek-ai/dsh --registry=https://registry.npmjs.org/".to_string())?;

        // Spawn on an UNPREDICTABLE port: fixed low ports (3081..3085) let a
        // same-machine attacker pre-occupy the range and impersonate our
        // service (the loopback trust fence has no token). Random high ports
        // in the dynamic range make pre-occupation impractical.
        let base = 49_152 + (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u16 % 16_000)
            .unwrap_or(0));
        // Keep the most informative stderr tail across attempts: a boot crash
        // (bad credentials schema, broken plugin tree) fails identically on
        // every port, so the LAST tail is the actual diagnosis.
        let mut last_tail = String::new();
        for try_port in base..base + SPAWN_PORT_TRIES {
            let port = if port_free(try_port) { try_port } else { continue };
            // M2: a spawn failure (port race, binary hiccup) should not abort
            // the whole probe — log and try the next port, mirroring the
            // never-became-ready path below.
            let (mut child, stderr_tail) = match spawn_dsh_web(&bin, port) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[dsh:service] spawn failed on :{}: {}", port, e);
                    continue;
                }
            };
            let base_url = format!("http://127.0.0.1:{}", port);
            // Poll until ready (short probe timeout — a hung spawn probe
            // must not stall session startup for 30s per attempt).
            for _ in 0..READY_POLLS {
                if probe_unary(&base_url, "host.describe", json!({})).await.is_ok() {
                    log::info!("[dsh:service] spawned dsh web at :{}", port);
                    let spawned_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    return Ok(Arc::new(DshServiceState {
                        base_url,
                        ws_url: format!("ws://127.0.0.1:{}", port),
                        spawned: true,
                        child: std::sync::Mutex::new(Some(child)),
                        session_routes: Arc::new(Mutex::new(HashMap::new())),
                        last_seqs: Arc::new(Mutex::new(HashMap::new())),
                        translators: Arc::new(Mutex::new(HashMap::new())),
                reader_handles: std::sync::Mutex::new(Vec::new()),
                spawned_at: Some(spawned_at),
                    }));
                }
                tokio::time::sleep(READY_INTERVAL).await;
            }
            // Never became ready — kill, capture why, try the next port.
            let _ = child.kill().await;
            let _ = child.wait().await;
            last_tail = stderr_tail_text(&stderr_tail);
            if !last_tail.is_empty() {
                log::warn!("[dsh:service] :{} never became ready; stderr tail:\n{}", port, last_tail);
            }
        }
        if last_tail.is_empty() {
            Err(format!(
                "dsh web failed to start (binary: {}); no stderr output captured",
                bin
            ))
        } else {
            Err(format!(
                "dsh web failed to start (binary: {});\n--- dsh stderr tail ---\n{}",
                bin, last_tail
            ))
        }
    }
}

/// Ring-buffered tail of a spawned service's stderr (last N lines), shared
/// between the reader task and failure paths so a boot crash surfaces its
/// actual cause instead of dying silently (stderr used to go to null — a
/// plugin-tree crash was completely undiagnosable).
pub type DshStderrTail = Arc<std::sync::Mutex<Vec<String>>>;
/// How many trailing stderr lines to keep.
const STDERR_TAIL_LINES: usize = 12;

fn spawn_dsh_web(bin: &str, port: u16) -> Result<(tokio::process::Child, DshStderrTail), String> {
    let mut cmd = {
        #[cfg(target_os = "windows")]
        {
            let needs_cmd = bin.ends_with(".cmd")
                || bin.ends_with(".bat")
                || (!bin.contains('\\') && !bin.contains('/') && !bin.contains('.'));
            if needs_cmd {
                let mut c = tokio::process::Command::new("cmd");
                c.arg("/C").arg(bin);
                c
            } else {
                tokio::process::Command::new(bin)
            }
        }
        #[cfg(not(target_os = "windows"))]
        tokio::process::Command::new(bin)
    };
    cmd.arg("--profile")
        .arg("web")
        .arg("--port")
        .arg(port.to_string())
        // dsh-web-app (0.1.0-rc.7+) opens the OS default browser at the web UI
        // by default (`openBrowser: true`). LC renders sessions natively and
        // never wants that handoff — pass the documented opt-out.
        .arg("--no-open")
        .env("DSH_TELEMETRY_DISABLED", "1")
        // Isolated DSH_HOME: LC's bundled dsh (flat credentials schema) must
        // never fight the desktop GUI's runtime copy (versioned schema) over
        // the shared ~/.dsh/.credentials.yaml — whichever service wrote last
        // used to crash the other on boot ("the value for \"version\" … must
        // be a string"). A per-app home ends the format war for good.
        .env(
            "DSH_HOME",
            crate::app_data_dir()?
                .join("dsh-home")
                .to_string_lossy()
                .to_string(),
        )
        .stdout(std::process::Stdio::null())
        // Piped, not null: the tail is kept for failure diagnostics.
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // User report: every first DSH message popped a visible cmd console
    // window (and re-popped after each service death) — this was the only
    // console spawn on the send path missing CREATE_NO_WINDOW (claude at
    // session.rs:690 and codex at lib.rs:1584 both set it).
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn dsh web: {}", e))?;
    let tail: DshStderrTail = Arc::new(std::sync::Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail_sink = Arc::clone(&tail);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buf = match tail_sink.lock() {
                    Ok(b) => b,
                    Err(_) => break,
                };
                if buf.len() >= STDERR_TAIL_LINES {
                    buf.remove(0);
                }
                buf.push(line);
            }
        });
    }
    Ok((child, tail))
}

/// Snapshot the stderr tail as a single diagnostic string (empty if none).
fn stderr_tail_text(tail: &DshStderrTail) -> String {
    tail.lock().map(|b| b.join("\n")).unwrap_or_default()
}

/// Is the port bindable right now (best-effort)?
fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Probe whether a `dsh web` service already answers on the default port
/// (3080). Used by `check_dsh_cli` to report service-mode availability.
pub async fn probe_default_service() -> bool {
    let base = format!("http://127.0.0.1:{}", DEFAULT_PORT);
    probe_unary(&base, "host.describe", json!({})).await.is_ok()
}

/// D3: 服务状态灯命令——报告当前已知的 dsh 服务，绝不 spawn。
/// `ensure()` 在没有服务时会拉起 `dsh web`，状态探测不能走它。
/// 优先级：LC 自管服务（ensure 缓存的 spawned/外部接管实例，探活确认）→
/// 外部默认端口 3080 → stopped。
/// 返回 { running, baseUrl, spawned, external }：
///  - spawned=true  → LC 本次运行亲自 spawn 的服务（随机端口）
///  - external=true → 非 LC spawn（外部 3080 或被接管的外部实例）
#[tauri::command]
pub async fn dsh_service_status(
    mgr: tauri::State<'_, DshServiceManager>,
) -> Result<Value, String> {
    // 1. LC 自管服务（get() 只读缓存，不 spawn）——探活确认仍在应答
    if let Some(state) = mgr.get().await {
        if probe_unary(&state.base_url, "host.describe", json!({}))
            .await
            .is_ok()
        {
            return Ok(json!({
                "running": true,
                "baseUrl": state.base_url,
                "spawned": state.spawned,
                "external": !state.spawned,
            }));
        }
        // 缓存实例已死——如实落到外部探测（ensure 下次会自行替换它）
    }
    // 2. 外部默认端口 3080
    if probe_default_service().await {
        return Ok(json!({
            "running": true,
            "baseUrl": format!("http://127.0.0.1:{}", DEFAULT_PORT),
            "spawned": false,
            "external": true,
        }));
    }
    // 3. 都没有
    Ok(json!({
        "running": false,
        "baseUrl": Value::Null,
        "spawned": false,
        "external": false,
    }))
}

/// Live DSH model catalog (`llm.models` — requires no session) for the
/// DeepSeek backend: the same provider groups/models DSH's own model picker
/// renders. The input-bar model dropdown fills its DeepSeek list from this so
/// a pick is a REAL catalog id — `apply_deepseek_model` then finds it in
/// `session.models` and `session.selectModel` sticks. (Non-catalog ids — e.g.
/// DeepSeek REST API names like `deepseek-chat` — are rejected by the host and
/// the session keeps the default `deepseek-v4-flash`, which is exactly the
/// "other model ran as flash" symptom this fixes.)
#[tauri::command]
pub async fn dsh_llm_models(
    mgr: tauri::State<'_, DshServiceManager>,
) -> Result<Value, String> {
    let service = mgr.ensure().await?;
    unary(&service.base_url, "llm.models", json!({})).await
}

/// Map a Little-Claude permission mode onto the DSH permission default
/// (`permission.defaultPreset` — the only knob the DSH RPC surface exposes, a
/// sandbox-mode preset folded into a fresh session's initial permission).
///
/// - bypass  (全自动)  → danger-full-access (sandbox full + approval never)
/// - plan    (计划)    → read-only (no writes while planning; true DSH plan
///                      collaboration has no reachable RPC, read-only is the
///                      safe stand-in)
/// - code/ask (标准自动/询问) → workspace-write (approval ask)
pub fn map_permission_mode_to_dsh_preset(permission_mode: &str) -> &'static str {
    match permission_mode {
        "bypassPermissions" | "bypass" => "danger-full-access",
        "plan" => "read-only",
        _ => "workspace-write",
    }
}

/// Set the DSH `permission` settings namespace default preset. Only NEW
/// sessions inherit it (a session pins its initial permission at creation, so
/// existing sessions are left untouched). Reads the revision freshly to avoid
/// stale expectedRevision races.
pub async fn dsh_set_permission_default(
    base_url: &str,
    default_preset: &str,
) -> Result<Value, String> {
    let describe = unary(base_url, "settings.describe", json!({})).await?;
    let namespaces = describe
        .get("namespaces")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let revision = namespaces
        .iter()
        .find(|n| n.get("ns").and_then(|v| v.as_str()) == Some("permission"))
        .and_then(|n| n.get("revision").and_then(|v| v.as_u64()))
        .unwrap_or(0);
    unary(
        base_url,
        "settings.mutate",
        json!({
            "ns": "permission",
            "ops": [{ "op": "set", "path": ["defaultPreset"], "value": default_preset }],
            "expectedRevision": revision,
        }),
    )
    .await
}

/// Align the live DSH permission default with a Little-Claude mode string.
/// Called by the mode selector on DeepSeek so sessions created after the
/// switch inherit the matching sandbox/approval.
#[tauri::command]
pub async fn dsh_set_permission_mode(
    mgr: tauri::State<'_, DshServiceManager>,
    permission_mode: String,
) -> Result<Value, String> {
    let service = mgr.ensure().await?;
    dsh_set_permission_default(
        &service.base_url,
        map_permission_mode_to_dsh_preset(&permission_mode),
    )
    .await
}

/// Agent preset roster for the DeepSeek backend, straight from the live DSH
/// service (`agentPreset.list`) — the same catalog the DeepSeek Harness GUI's
/// preset picker renders. Used by the input-bar preset selector. Lazy: loads
/// on open; once the service answers, the list is what the session composer
/// validates against.
#[tauri::command]
pub async fn dsh_agent_presets(
    mgr: tauri::State<'_, DshServiceManager>,
) -> Result<Value, String> {
    let service = mgr.ensure().await?;
    unary(
        &service.base_url,
        "agentPreset.list",
        json!({}),
    )
    .await
}

/// Unary RPC: `POST /api/<method>` with the client-request envelope.
/// Returns the `result.value` on success; error code+message otherwise.
pub async fn unary(base_url: &str, method: &str, payload: Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let url = format!("{}/api/{}", base_url, method);
    let resp = http()
        .post(&url)
        .header("content-type", "application/json")
        .json(&json!({
            "type": "client-request",
            "rpcId": id,
            "method": method,
            "payload": payload,
        }))
        .send()
        .await
        .map_err(|e| format!("dsh unary {}: {}", method, e))?;
    if !resp.status().is_success() {
        return Err(format!(
            "dsh unary {}: HTTP {} ({})",
            method,
            resp.status(),
            resp.text().await.unwrap_or_default().trim()
        ));
    }
    let full: Value = resp.json().await.map_err(|e| format!("dsh unary {}: bad JSON: {}", method, e))?;
    if full.get("rpcId").and_then(|v| v.as_str()) != Some(id.as_str()) {
        return Err(format!("dsh unary {}: rpcId echo mismatch", method));
    }
    let result = full.get("result").cloned().unwrap_or_default();
    if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = result.get("error").cloned().unwrap_or_default();
        return Err(format!(
            "dsh unary {}: {} {}",
            method,
            err.get("code").and_then(|v| v.as_str()).unwrap_or("internal"),
            err.get("message").and_then(|v| v.as_str()).unwrap_or("")
        ));
    }
    Ok(result.get("value").cloned().unwrap_or(Value::Null))
}

/// Liveness-probe RPC using the 2s short-timeout client. Used by ensure()
/// and spawn-readiness polling — never for real work (real RPC keeps the
/// 30s budget via `unary`).
pub async fn probe_unary(base_url: &str, method: &str, payload: Value) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let url = format!("{}/api/{}", base_url, method);
    let resp = probe_http()
        .post(&url)
        .header("content-type", "application/json")
        .json(&json!({
            "type": "client-request",
            "rpcId": id,
            "method": method,
            "payload": payload,
        }))
        .send()
        .await
        .map_err(|e| format!("dsh probe {}: {}", method, e))?;
    if !resp.status().is_success() {
        return Err(format!("dsh probe {}: HTTP {}", method, resp.status()));
    }
    let full: Value = resp
        .json()
        .await
        .map_err(|e| format!("dsh probe {}: bad JSON: {}", method, e))?;
    if full.get("rpcId").and_then(|v| v.as_str()) != Some(id.as_str()) {
        return Err(format!("dsh probe {}: rpcId echo mismatch", method));
    }
    let result = full.get("result").cloned().unwrap_or_default();
    if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("dsh probe {}: result not ok", method));
    }
    Ok(result.get("value").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
mod live_tests {
    //! End-to-end tests against a REAL `dsh web` service (must be running on
    //! the default port). Run with: cargo test -- --ignored live
    //!
    //! These verify the full wire path an LC session takes: unary RPC →
    //! mux WebSocket → event translation, exactly as `start_deepseek_session`
    //! composes it.

    use super::*;
    use crate::backends::dsh_events::{translate_session_event, DshTranslator};
    use tokio::time::{timeout, Duration as TokioDuration};

    const BASE: &str = "http://127.0.0.1:3080";

    #[tokio::test]
    #[ignore]
    async fn live_unary_roundtrip() {
        let v = unary(BASE, "host.describe", json!({})).await.expect("host.describe");
        assert!(v.get("cwd").is_some(), "describe has cwd: {}", v);
        println!("[live] host.describe ok: {}", v);
    }

    #[tokio::test]
    #[ignore]
    async fn live_full_turn_via_mux() {
        // 1. Create a session (temp cwd to avoid touching user files).
        let created = unary(BASE, "session.create", json!({
            "cwd": std::env::temp_dir().to_string_lossy(),
        }))
        .await
        .expect("session.create");
        let sid = created
            .get("sessionId")
            .and_then(|v| v.as_str())
            .expect("sessionId")
            .to_string();
        println!("[live] session: {}", sid);

        // 2. Open the mux stream and subscribe to frames.
        let (ws, _) = tokio_tungstenite::connect_async(format!(
            "ws://127.0.0.1:3080/api/events.mux"
        ))
        .await
        .expect("mux ws");
        let mut ws = ws;
        let mut translator = DshTranslator::default();

        // 3. Prompt (short task, no tools).
        unary(BASE, "session.prompt", json!({
            "sessionId": sid,
            "mode": "queue",
            "content": [{ "type": "text", "text": "回复OK两个字，不要调用任何工具。" }],
        }))
        .await
        .expect("session.prompt");

        // 4. Read frames until turn/end, translating as we go.
        let mut saw_message = false;
        let mut saw_result = false;
        let mut saw_tool_or_thinking = false;
        let deadline = TokioDuration::from_secs(90);
        let outcome = timeout(deadline, async {
            loop {
                match ws.next().await {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                        let frame: Value = serde_json::from_str(&t).expect("frame json");
                        let payload = frame.get("payload").cloned().unwrap_or_default();
                        if payload.get("type").and_then(|v| v.as_str()) != Some("session/event") {
                            continue;
                        }
                        let events = translate_session_event(&mut translator, &payload);
                        for ev in events {
                            match ev.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                                "assistant" => {
                                    saw_message = true;
                                    let text = ev
                                        .pointer("/message/content/0/text")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    println!("[live] assistant: {:?}", text);
                                }
                                "result" => {
                                    saw_result = true;
                                    println!("[live] result: {:?}", ev);
                                }
                                "stream_event" | "stream" => {
                                    let inner = ev.get("event").unwrap_or(&ev);
                                    let t = inner
                                        .get("type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    if t.contains("thinking") || t.contains("tool") {
                                        saw_tool_or_thinking = true;
                                    }
                                }
                                _ => {}
                            }
                            if saw_message && saw_result {
                                return;
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => panic!("ws error: {}", e),
                    None => panic!("ws closed early"),
                }
            }
        })
        .await;
        assert!(outcome.is_ok(), "turn did not complete in 90s");
        assert!(saw_message, "assistant message received");
        assert!(saw_result, "result received");
        assert!(!saw_tool_or_thinking, "no tool/thinking expected for this task");
        println!("[live] full turn OK (message + result)");
    }
}

#[cfg(test)]
mod permission_mapping_tests {
    use super::map_permission_mode_to_dsh_preset;

    #[test]
    fn bypass_maps_to_full_access() {
        assert_eq!(map_permission_mode_to_dsh_preset("bypassPermissions"), "danger-full-access");
        assert_eq!(map_permission_mode_to_dsh_preset("bypass"), "danger-full-access");
    }

    #[test]
    fn plan_maps_to_read_only() {
        assert_eq!(map_permission_mode_to_dsh_preset("plan"), "read-only");
    }

    #[test]
    fn code_and_ask_map_to_workspace_write() {
        assert_eq!(map_permission_mode_to_dsh_preset("code"), "workspace-write");
        assert_eq!(map_permission_mode_to_dsh_preset("ask"), "workspace-write");
        assert_eq!(map_permission_mode_to_dsh_preset(""), "workspace-write");
    }
}
