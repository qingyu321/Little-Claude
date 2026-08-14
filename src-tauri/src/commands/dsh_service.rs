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
        tokio::spawn(read_mux_loop(self.ws_url.clone(), mux_tx.clone()));
        tokio::spawn(route_mux_frames(
            mux_rx2,
            self.base_url.clone(),
            self.session_routes.clone(),
            self.last_seqs.clone(),
            self.translators.clone(),
        ));
        // Host stream: keep the socket alive and surface session lifecycle
        // end events to the owning tab (prevents permanent "running" UI).
        tokio::spawn(read_host_loop(
            self.ws_url.clone(),
            self.session_routes.clone(),
            self.translators.clone(),
            self.last_seqs.clone(),
        ));
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
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
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
    let mut attempt: u32 = 0;
    loop {
        match open_ws(&ws_url).await {
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
                            if seqs.get(&sid).is_some_and(|&last| seq <= last) {
                                continue; // duplicate / out-of-order — drop
                            }
                            seqs.insert(sid.clone(), seq);
                        }
                        // New turn: clear the translator's per-turn state so
                        // stale block indices can't leak. turn/end is NOT reset
                        // here — translate_turn_end reads state.usage, so it
                        // must run before the next turn/start clears it.
                        let ev_type = payload.pointer("/event/type").and_then(|v| v.as_str());
                        let events = {
                            let mut ts = translators.lock().await;
                            let t = ts.entry(sid).or_default();
                            if ev_type == Some("turn/start") {
                                t.reset_for_turn();
                            }
                            dsh_events::translate_session_event(t, &payload)
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
                                let _ = unary(
                                    &base_url,
                                    "respond",
                                    json!({
                                        "type": "client-response",
                                        "rpcId": approval_id,
                                        "result": { "ok": true, "value": {
                                            "sessionId": sid,
                                            "approvalId": approval_id,
                                            "outcome": "allowed-once",
                                        } },
                                    }),
                                )
                                .await;
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
            }));
        }

        // 2. Spawn our own on a free port.
        let bin = crate::find_deepseek_binary()
            .ok_or_else(|| "dsh CLI (DeepSeek Harness) not found. Install it with: npm install -g @deepseek-ai/dsh --registry=https://registry.npmjs.org/".to_string())?;

        for try_port in DEFAULT_PORT + 1..DEFAULT_PORT + 1 + SPAWN_PORT_TRIES {
            let port = if port_free(try_port) { try_port } else { continue };
            // M2: a spawn failure (port race, binary hiccup) should not abort
            // the whole probe — log and try the next port, mirroring the
            // never-became-ready path below.
            let child = match spawn_dsh_web(&bin, port) {
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
                    return Ok(Arc::new(DshServiceState {
                        base_url,
                        ws_url: format!("ws://127.0.0.1:{}", port),
                        spawned: true,
                        child: std::sync::Mutex::new(Some(child)),
                        session_routes: Arc::new(Mutex::new(HashMap::new())),
                        last_seqs: Arc::new(Mutex::new(HashMap::new())),
                        translators: Arc::new(Mutex::new(HashMap::new())),
                    }));
                }
                tokio::time::sleep(READY_INTERVAL).await;
            }
            // Never became ready — kill and try the next port.
            let mut child = child;
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        Err(format!(
            "dsh web failed to start on ports {}–{} (binary: {})",
            DEFAULT_PORT + 1,
            DEFAULT_PORT + SPAWN_PORT_TRIES,
            bin
        ))
    }
}

/// Spawn `dsh --profile web --port <p>` (cmd wrapper for .cmd on Windows).
fn spawn_dsh_web(bin: &str, port: u16) -> Result<tokio::process::Child, String> {
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
        .env("DSH_TELEMETRY_DISABLED", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd.spawn().map_err(|e| format!("Failed to spawn dsh web: {}", e))
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
