//! Anthropic → OpenAI local conversion proxy.
//!
//! Claude CLI only speaks the Anthropic Messages API (POST /v1/messages with
//! Anthropic SSE streaming). Some providers — especially private/专属 Aliyun
//! endpoints — only expose the OpenAI chat/completions API. This module runs a
//! local HTTP proxy on 127.0.0.1 that:
//!
//! 1. Receives Anthropic Messages requests from Claude CLI
//! 2. Converts the request body to OpenAI chat/completions format
//! 3. Forwards it to the real provider endpoint with the provider's API key
//! 4. Converts the response (JSON or SSE) back to Anthropic format
//!
//! The proxy is bound to a random loopback port and protected by a random
//! per-session token embedded in the URL path, so other local processes
//! cannot use it.

use futures_util::StreamExt;
use http_body::Frame;
use http_body_util::{BodyExt as _, Full, StreamBody};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// One running proxy instance, keyed by session_id in `ProxyManager`.
pub struct ProxyEntry {
    /// Send shutdown signal to the proxy accept loop.
    pub shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

/// Registry of running proxies, registered as Tauri state.
#[derive(Default)]
pub struct ProxyManager {
    proxies: Arc<Mutex<HashMap<String, ProxyEntry>>>,
}

impl Clone for ProxyManager {
    fn clone(&self) -> Self {
        Self {
            proxies: self.proxies.clone(),
        }
    }
}

impl ProxyManager {
    pub fn new() -> Self {
        Self {
            proxies: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Start a proxy for `session_id`, returning the base URL to inject
    /// as `ANTHROPIC_BASE_URL` (e.g. `http://127.0.0.1:45678/<token>`).
    pub async fn start(
        &self,
        session_id: &str,
        target_url: String,
        api_key: String,
        main_format: String,
    ) -> Result<String, String> {
        // Replace any existing proxy for this session
        self.stop(session_id).await;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Failed to bind proxy listener: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to get proxy port: {}", e))?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();

        let state = ProxyState {
            target_url,
            api_key,
            token: token.clone(),
            session_id: session_id.to_string(),
            main_format,
        };

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let accept_state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    res = listener.accept() => {
                        let (stream, _) = match res {
                            Ok(v) => v,
                            Err(_) => break,
                        };
                        let conn_state = accept_state.clone();
                        tokio::spawn(async move {
                            let io = TokioIo::new(stream);
                            let svc = service_fn(move |req| {
                                let s = conn_state.clone();
                                async move {
                                    Ok::<Response<BoxBody>, std::convert::Infallible>(
                                        handle_request(req, s).await,
                                    )
                                }
                            });
                            let _ = http1::Builder::new()
                                .serve_connection(io, svc)
                                .await;
                        });
                    }
                }
            }
        });

        self.proxies.lock().await.insert(
            session_id.to_string(),
            ProxyEntry {
                shutdown: Some(shutdown_tx),
            },
        );
        eprintln!(
            "[LITTLECLAUDE:proxy] Started proxy for session {} on port {} (token {}) → {} (format {})",
            session_id,
            port,
            token,
            state.target_url,
            state.main_format,
        );
        Ok(format!("http://127.0.0.1:{}/{}", port, token))
    }

    /// Stop and remove the proxy for `session_id`.
    pub async fn stop(&self, session_id: &str) {
        let mut map = self.proxies.lock().await;
        if let Some(entry) = map.remove(session_id) {
            if let Some(tx) = entry.shutdown {
                let _ = tx.send(());
            }
            eprintln!("[LITTLECLAUDE:proxy] Stopped proxy for session {}", session_id);
        }
    }
}

/// Shared state for one proxy instance (cloned into each connection task).
#[derive(Clone)]
struct ProxyState {
    target_url: String,
    api_key: String,
    token: String,
    /// Little Claude session id this proxy serves. Used to persist the
    /// authoritative OpenAI usage (incl. cache) straight to the usage log —
    /// the CLI drops message_delta fields it doesn't know, so the frontend
    /// can't rely on the stream to carry input/cache back.
    session_id: String,
    /// Main endpoint format: "openai" → conversion branch; "anthropic" →
    /// passthrough branch.
    main_format: String,
}

type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

/// 代理诊断日志（追加到 %TEMP%/littleclaude-proxy.log）。
///
/// release 构建的代理进程没有控制台，eprintln 不可见——文件日志用于排查
/// "启用兜底后 502" 类问题：记录每次转发的目标、状态码与响应摘要。
fn proxy_log(msg: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("littleclaude-proxy.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            f,
            "[{}] {}",
            chrono::Local::now().format("%H:%M:%S%.3f"),
            msg
        );
    }
}

/// Redact likely API-key material from an upstream error message before it is
/// forwarded to the UI. Providers sometimes echo keys back in error bodies.
fn redact_secrets(s: &str) -> String {
    // Common key shapes: sk-... (OpenAI-style), key-... , and long base64/hex tokens.
    let mut out = s.to_string();
    for pat in ["sk-", "key-", "Bearer ", "x-api-key: "] {
        let mut start = 0;
        while let Some(rel) = out[start..].find(pat) {
            let m = start + rel; // start of the pattern match
            let i = m + pat.len();
            // Take up to 64 chars of the trailing token value.
            let rest = &out[i..];
            let len = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
                .count()
                .min(64);
            if len >= 8 {
                // Replace from the pattern start so the prefix (sk- etc.)
                // is hidden too.
                out.replace_range(m..i + len, "[REDACTED]");
                start = m + "[REDACTED]".len();
            } else {
                start = i;
            }
        }
    }
    out
}

/// HTTP handler: validates the token prefix, then dispatches to the
/// conversion pipeline.
async fn handle_request(req: Request<Incoming>, state: ProxyState) -> Response<BoxBody> {
    let path = req.uri().path().to_string();
    let token_prefix = format!("/{}", state.token);

    if !path.starts_with(&token_prefix) {
        return json_response(StatusCode::NOT_FOUND, json!({
            "type": "error",
            "error": {"type": "not_found_error", "message": "Not found"}
        }));
    }
    if req.method() != Method::POST {
        return json_response(StatusCode::METHOD_NOT_ALLOWED, json!({
            "type": "error",
            "error": {"type": "method_not_allowed", "message": "Method not allowed"}
        }));
    }

    let api_path = path.trim_start_matches(&token_prefix);
    let body_bytes = match req.into_body().collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) => {
            return json_response(StatusCode::BAD_REQUEST, json!({
                "type": "error",
                "error": {"type": "api_error", "message": format!("Invalid request body: {}", e)}
            }));
        }
    };

    match api_path {
        "/v1/messages" => {
            let body_json: Value = match serde_json::from_slice(&body_bytes) {
                Ok(v) => v,
                Err(_) => {
                    return json_response(StatusCode::BAD_REQUEST, json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": "Invalid JSON body"}
                    }));
                }
            };
            forward_messages(&state, body_json).await
        }
        "/v1/messages/count_tokens" => {
            // Rough estimation — used by the CLI for budget/context checks.
            // Content may be a plain string or a block array
            // ([{type: "text", text: ...}]); count both forms.
            let body_json: Value = serde_json::from_slice(&body_bytes).unwrap_or(json!({}));
            let mut text_len = 0usize;
            if let Some(arr) = body_json.get("messages").and_then(|m| m.as_array()) {
                for m in arr {
                    match m.get("content") {
                        Some(Value::String(s)) => text_len += s.len(),
                        Some(Value::Array(blocks)) => {
                            for b in blocks {
                                if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                                    text_len += s.len();
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            match body_json.get("system") {
                Some(Value::String(sys)) => text_len += sys.len(),
                Some(Value::Array(sys_blocks)) => {
                    for b in sys_blocks {
                        if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                            text_len += s.len();
                        }
                    }
                }
                _ => {}
            }
            let input_tokens = (text_len / 3).max(1);
            json_response(StatusCode::OK, json!({"input_tokens": input_tokens}))
        }
        _ => json_response(StatusCode::NOT_FOUND, json!({
            "type": "error",
            "error": {"type": "not_found_error", "message": format!("Unknown endpoint {}", api_path)}
        })),
    }
}

/// Shared upstream client — reuses the connection pool across proxy requests.
/// No total timeout on the client itself: streaming responses can legitimately
/// stay open for minutes. Non-streaming requests get their own per-request
/// timeout below; the connect timeout guards against dead hosts.
static UPSTREAM_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn upstream_client() -> &'static reqwest::Client {
    UPSTREAM_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            // 转发通道必须直连上游：不继承进程 env 的 HTTP(S)_PROXY（用户代理
            // 残留会拦截本地/上游请求，表现为神秘 502；provider 的 proxyUrl
            // 走的是 CLI 子进程 env 注入，与这里无关）。
            .no_proxy()
            .build()
            .unwrap_or_default()
    })
}

/// Dispatcher: Anthropic-format providers pass through untouched;
/// OpenAI-format providers go through the conversion pipeline.
async fn forward_messages(state: &ProxyState, anthropic_body: Value) -> Response<BoxBody> {
    let tool_count = anthropic_body
        .get("tools")
        .and_then(|t| t.as_array())
        .map_or(0, |t| t.len());
    let msg_count = anthropic_body
        .get("messages")
        .and_then(|m| m.as_array())
        .map_or(0, |m| m.len());
    let model = anthropic_body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    proxy_log(&format!(
        "REQ session={} tools={} msgs={} model={}",
        state.session_id,
        tool_count,
        msg_count,
        model,
    ));

    // Compact summary requests (CLI /compact) declare no tools and carry a
    // single digest user message. Their usage is compression overhead, not
    // dialogue — excluded from the usage log so profile stats stay clean.
    // (The frontend applies the same exclusion to its in-memory session
    // stats via the pending '/compact' card; this Rust gate covers the
    // proxy-path usage_log persistence that bypasses the frontend.)
    let is_compact_request = anthropic_body
        .get("tools")
        .and_then(|t| t.as_array())
        .map_or(true, |tools| tools.is_empty())
        && anthropic_body
            .get("messages")
            .and_then(|m| m.as_array())
            .map_or(0, |msgs| msgs.len())
            <= 1;
    if state.main_format.eq_ignore_ascii_case("anthropic") {
        // 主端点是 Anthropic 格式：原样透传（tools 不改写，与直连行为一致）。
        let fr = forward_passthrough(&state.target_url, &state.api_key, &anthropic_body)
            .await;
        return fr.response;
    }
    let fr = forward_openai_conversion(state, anthropic_body.clone(), is_compact_request).await;
    fr.response
}
/// Forward a converted Anthropic request to the OpenAI endpoint.
async fn forward_openai_conversion(
    state: &ProxyState,
    anthropic_body: Value,
    is_compact: bool,
) -> ForwardResult {
    let openai_body = anthropic_to_openai_req(&anthropic_body);
    let is_stream = openai_body
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);

    let target = format!(
        "{}/chat/completions",
        state.target_url.trim_end_matches('/')
    );
    let client = upstream_client();
    let mut req = client
        .post(&target)
        .header("Authorization", format!("Bearer {}", state.api_key))
        .header("Content-Type", "application/json")
        .json(&openai_body);
    if !is_stream {
        req = req.timeout(std::time::Duration::from_secs(60));
    }
    let resp = match req.send().await
    {
        Ok(r) => r,
        Err(e) => {
            return ForwardResult::ok(json_response(StatusCode::BAD_GATEWAY, json!({
                "type": "error",
                "error": {"type": "api_error", "message": format!("Upstream connection failed: {}", e)}
            })));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        // Forward the upstream error, wrapped in Anthropic error format.
        // 原始 body 随 ForwardResult 带给调用方做 4xx 语义判定。
        let text = resp.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").cloned())
            .and_then(|e| e.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| text.chars().take(500).collect());
        // Some providers echo the API key back in error bodies (e.g.
        // "Invalid API key: sk-..."). Redact it before it reaches the UI.
        let message = redact_secrets(&message);
        eprintln!(
            "[LITTLECLAUDE:proxy] Upstream error HTTP {}: {}",
            status, message
        );
        return ForwardResult::err(
            status,
            text,
            json_response(status, json!({
                "type": "error",
                "error": {"type": "api_error", "message": message}
            })),
        );
    }

    if !is_stream {
        // Non-streaming: convert whole JSON response.
        match resp.text().await {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(openai) => {
                    let anthropic = openai_to_anthropic_resp(&openai);
                    // Persist authoritative usage (incl. cache) for non-streaming
                    // responses too — same CLI-drops-message_delta rationale.
                    // Compact summary turns are compression overhead — skip.
                    if !is_compact {
                        if let Some(usage) = openai.get("usage") {
                            let inp = usage.get("prompt_tokens").and_then(|u| u.as_u64()).unwrap_or(0);
                            let out = usage.get("completion_tokens").and_then(|u| u.as_u64()).unwrap_or(0);
                            let cache_read = usage.get("prompt_cache_hit_tokens").and_then(|u| u.as_u64()).unwrap_or(0);
                            let cache_creation = usage.get("prompt_cache_miss_tokens").and_then(|u| u.as_u64()).unwrap_or(0);
                            if inp.saturating_add(out).saturating_add(cache_read).saturating_add(cache_creation) > 0 {
                                let mid = openai
                                    .get("id")
                                    .and_then(|i| i.as_str())
                                    .unwrap_or("")
                                    .trim_start_matches("chatcmpl-");
                                let ts = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs();
                                let model = openai.get("model").and_then(|m| m.as_str()).unwrap_or("");
                                let _ = crate::commands::profile::append_usage_record_impl(
                                    &state.session_id,
                                    mid,
                                    inp,
                                    out,
                                    cache_read,
                                    cache_creation,
                                    model,
                                    &ts.to_string(),
                                );
                            }
                        }
                    }
                    ForwardResult::ok(json_response(StatusCode::OK, anthropic))
                }
                Err(_) => ForwardResult::ok(json_response(StatusCode::BAD_GATEWAY, json!({
                    "type": "error",
                    "error": {"type": "api_error", "message": "Invalid upstream response"}
                }))),
            },
            Err(e) => ForwardResult::ok(json_response(StatusCode::BAD_GATEWAY, json!({
                "type": "error",
                "error": {"type": "api_error", "message": format!("Upstream read failed: {}", e)}
            }))),
        }
    } else {
        // Streaming: convert OpenAI SSE → Anthropic SSE line by line.
        // Use an mpsc channel so the conversion task can push frames
        // asynchronously while the response body streams them out.
        let (mut tx, rx) = tokio::sync::mpsc::channel::<Result<Frame<Bytes>, hyper::Error>>(64);
        let session_id_owned = state.session_id.clone();
        tokio::spawn(async move {
            let mut conv = SseConverter::new();
            let mut stream = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();

            let send_events = |tx: &mut tokio::sync::mpsc::Sender<
                Result<Frame<Bytes>, hyper::Error>,
            >,
                               events: Vec<String>| {
                for ev in events {
                    let frame = Frame::data(Bytes::from(format!("{}\n\n", ev)));
                    if tx.try_send(Ok(frame)).is_err() {
                        return false; // receiver dropped
                    }
                }
                true
            };

            // Persist the authoritative OpenAI usage (input + output + cache)
            // straight to Little Claude's usage log. The CLI drops message_delta
            // fields it doesn't know, so input/cache would otherwise never reach
            // the frontend and the per-turn stats would show input = 0.
            // Compact summary turns are compression overhead — skip.
            let persist = |conv: &SseConverter| {
                if is_compact {
                    return;
                }
                if let Some((mid, inp, out, cache_read, cache_creation)) = conv.usage_record() {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let _ = crate::commands::profile::append_usage_record_impl(
                        &session_id_owned,
                        &mid,
                        inp,
                        out,
                        cache_read,
                        cache_creation,
                        &conv.model,
                        &ts.to_string(),
                    );
                }
            };

            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(_) => break,
                };
                buf.extend_from_slice(&chunk);
                // Split into lines
                loop {
                    let newline = match buf.iter().position(|&b| b == b'\n') {
                        Some(p) => p,
                        None => break,
                    };
                    let line: Vec<u8> = buf.drain(..=newline).collect();
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim();
                    if let Some(data) = trimmed.strip_prefix("data:") {
                        let payload = data.trim();
                        if payload == "[DONE]" {
                            let events = conv.finish();
                            persist(&conv);
                            if !send_events(&mut tx, events) {
                                break;
                            }
                            break;
                        }
                        let events = conv.on_openai_chunk(payload);
                        if !send_events(&mut tx, events) {
                            break;
                        }
                    }
                }
            }
            // Flush any remaining accumulated output if the stream ended
            // without [DONE] (some providers omit the terminator).
            if !conv.is_finished() {
                let events = conv.finish();
                persist(&conv);
                let _ = send_events(&mut tx, events);
            }
            // Dropping tx closes the response body (EOF for the CLI).
        });

        let body = http_body_util::BodyExt::boxed(StreamBody::new(
            futures_util::stream::unfold(
                rx,
                |mut rx| async move { rx.recv().await.map(|item| (item, rx)) },
            ),
        ));

        ForwardResult::ok(
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .body(body)
                .unwrap_or_else(|_| {
                    json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": "Stream setup failed"}
                    }))
                }),
        )
    }
}


/// Anthropic 格式原样转发（JSON / SSE 字节流，不做任何转换）。
///
/// headers: `x-api-key`（替换）、`anthropic-version: 2023-06-01`、content-type。
/// 注意：DeepSeek 等 anthropic 兼容端点只认 `x-api-key`，不接受 Bearer。
///
/// 上游转发结果：HTTP 响应 + 可选的上游错误快照。
///
/// `upstream_error` 仅在非 2xx 时携带 `(HTTP 状态码, 原始上游错误 body 文本)`，
/// 供调用方决定透传还是改写错误信息。
struct ForwardResult {
    response: Response<BoxBody>,
    /// Kept for diagnostics (error bodies are already surfaced in the
    /// response); no longer consumed by forward_messages after the
    /// web-search fallback removal.
    #[allow(dead_code)]
    upstream_error: Option<(u16, String)>,
}

impl ForwardResult {
    fn ok(response: Response<BoxBody>) -> Self {
        Self {
            response,
            upstream_error: None,
        }
    }

    fn err(status: StatusCode, upstream_body: String, response: Response<BoxBody>) -> Self {
        Self {
            response,
            upstream_error: Some((status.as_u16(), upstream_body)),
        }
    }
}

/// 透传分支不记 usage——前端从 CLI 流事件的 usage 字段直接记账。
async fn forward_passthrough(
    base_url: &str,
    api_key: &str,
    body: &Value,
) -> ForwardResult {
    let target = crate::commands::provider::provider_messages_endpoint(base_url, "anthropic");
    let payload = body.clone();
    let is_stream = payload
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);

    // Log the key length only, never key material — the first 8 chars of a
    // long-lived API key are still usable by an attacker who reads
    // %TEMP%\littleclaude-proxy.log.
    proxy_log(&format!(
        "FWD {} key=<{} chars> model={} tools={}",
        target,
        api_key.len(),
        payload.get("model").and_then(|m| m.as_str()).unwrap_or(""),
        payload
            .get("tools")
            .and_then(|t| t.as_array())
            .map_or(0, |t| t.len())
    ));

    let client = upstream_client();
    let mut req = client
        .post(&target)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&payload);
    if !is_stream {
        req = req.timeout(std::time::Duration::from_secs(60));
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            proxy_log(&format!("UPSTREAM_CONN_ERR {} err={}", target, e));
            return ForwardResult::ok(json_response(StatusCode::BAD_GATEWAY, json!({
                "type": "error",
                "error": {"type": "api_error", "message": format!("Upstream connection failed: {}", e)}
            })));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        // 上游错误响应是 JSON（非 SSE），提取 error.message（脱敏后）包成
        // Anthropic 错误格式回传；原始 body 随 ForwardResult 带给调用方做
        // 4xx 语义判定（工具不支持 vs 其他错误）。
        let text = resp.text().await.unwrap_or_default();
        // Redact the body before logging: an upstream that echoes the API
        // key in its error message would otherwise persist it to the
        // on-disk proxy log.
        let body_for_log = redact_secrets(&text.chars().take(400).collect::<String>());
        proxy_log(&format!(
            "UPSTREAM_ERR {} status={} body={}",
            target, status, body_for_log
        ));
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").cloned())
            .and_then(|e| e.get("message").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| text.chars().take(500).collect());
        let message = redact_secrets(&message);
        eprintln!(
            "[LITTLECLAUDE:proxy] Upstream error HTTP {}: {}",
            status, message
        );
        return ForwardResult::err(
            status,
            text,
            json_response(status, json!({
                "type": "error",
                "error": {"type": "api_error", "message": message}
            })),
        );
    }

    proxy_log(&format!("UPSTREAM_OK {} status={}", target, status));

    if !is_stream {
        // 非流式：原样 JSON 返回（Anthropic 格式响应，无需转换）。
        match resp.text().await {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(v) => ForwardResult::ok(json_response(StatusCode::OK, v)),
                Err(_) => ForwardResult::ok(json_response(StatusCode::BAD_GATEWAY, json!({
                    "type": "error",
                    "error": {"type": "api_error", "message": "Invalid upstream response"}
                }))),
            },
            Err(e) => ForwardResult::ok(json_response(StatusCode::BAD_GATEWAY, json!({
                "type": "error",
                "error": {"type": "api_error", "message": format!("Upstream read failed: {}", e)}
            }))),
        }
    } else {
        // 流式：SSE 原始字节流转发。禁止行解析/重组——任何 event:/data:
        // 行的丢失都会让 CLI 解析错乱。
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<Frame<Bytes>, hyper::Error>>(64);
        tokio::spawn(async move {
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(_) => break,
                };
                if tx.send(Ok(Frame::data(chunk))).await.is_err() {
                    break; // receiver dropped
                }
            }
            // Dropping tx closes the response body (EOF for the CLI).
        });

        let body = http_body_util::BodyExt::boxed(StreamBody::new(
            futures_util::stream::unfold(
                rx,
                |mut rx| async move { rx.recv().await.map(|item| (item, rx)) },
            ),
        ));

        ForwardResult::ok(
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .body(body)
                .unwrap_or_else(|_| {
                    json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": "Stream setup failed"}
                    }))
                }),
        )
    }
}

fn json_response(status: StatusCode, body: Value) -> Response<BoxBody> {
    let bytes = Bytes::from(body.to_string());
    let full = Full::new(bytes)
        .map_err(|never| -> hyper::Error { match never {} })
        .boxed();
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(full)
        .unwrap_or_else(|_| {
            Response::new(
                Full::new(Bytes::from("{}"))
                    .map_err(|never| -> hyper::Error { match never {} })
                    .boxed(),
            )
        })
}

// ─── Request conversion: Anthropic Messages → OpenAI chat/completions ─────

fn anthropic_to_openai_req(body: &Value) -> Value {
    let mut out = serde_json::Map::new();

    // Passthrough fields
    for key in ["model", "max_tokens", "temperature", "top_p", "stop", "stream"] {
        if let Some(v) = body.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if out.get("stream").is_none() {
        out.insert("stream".to_string(), json!(true));
    }

    // system → leading system message
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = body.get("system") {
        let sys_text = blocks_to_plain_text(system);
        if !sys_text.is_empty() {
            messages.push(json!({"role": "system", "content": sys_text}));
        }
    }

    if let Some(arr) = body.get("messages").and_then(|m| m.as_array()) {
        for m in arr {
            convert_message(m, &mut messages);
        }
    }
    out.insert("messages".to_string(), Value::Array(messages));

    // tools
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let converted: Vec<Value> = tools
            .iter()
            .filter_map(convert_tool)
            .collect();
        if !converted.is_empty() {
            out.insert("tools".to_string(), Value::Array(converted));
        }
    }

    Value::Object(out)
}

/// Extract plain text from a value that may be a string or an array of
/// content blocks (Anthropic format).
fn blocks_to_plain_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn convert_message(m: &Value, out: &mut Vec<Value>) {
    let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
    match role {
        "user" => match m.get("content") {
            Some(Value::String(s)) => {
                out.push(json!({"role": "user", "content": s}));
            }
            Some(Value::Array(blocks)) => {
                let mut texts: Vec<String> = Vec::new();
                let mut images: Vec<Value> = Vec::new();
                for b in blocks {
                    match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "text" => {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                texts.push(t.to_string());
                            }
                        }
                        "image" => {
                            if let Some(src) = b.get("source") {
                                let media = src
                                    .get("media_type")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("image/png");
                                let data = src
                                    .get("data")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("");
                                images.push(json!({
                                    "type": "image_url",
                                    "image_url": {"url": format!("data:{};base64,{}", media, data)}
                                }));
                            }
                        }
                        "tool_result" => {
                            let tid = b
                                .get("tool_use_id")
                                .and_then(|t| t.as_str())
                                .unwrap_or("");
                            let content = blocks_to_plain_text(
                                b.get("content").unwrap_or(&Value::Null),
                            );
                            out.push(json!({
                                "role": "tool",
                                "tool_call_id": tid,
                                "content": content
                            }));
                        }
                        _ => {}
                    }
                }
                if !texts.is_empty() || !images.is_empty() {
                    let mut parts: Vec<Value> = Vec::new();
                    for t in texts {
                        parts.push(json!({"type": "text", "text": t}));
                    }
                    for i in images {
                        parts.push(i);
                    }
                    out.push(json!({"role": "user", "content": parts}));
                }
            }
            _ => {}
        },
        "assistant" => {
            let mut text_parts: Vec<String> = Vec::new();
            let mut tool_calls: Vec<Value> = Vec::new();
            match m.get("content") {
                Some(Value::String(s)) => text_parts.push(s.clone()),
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                            "text" => {
                                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                    text_parts.push(t.to_string());
                                }
                            }
                            "tool_use" => {
                                let id = b.get("id").and_then(|i| i.as_str()).unwrap_or("");
                                let name = b
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("");
                                let input = b.get("input").cloned().unwrap_or(Value::Null);
                                let args = serde_json::to_string(&input)
                                    .unwrap_or_else(|_| "{}".to_string());
                                tool_calls.push(json!({
                                    "id": id,
                                    "type": "function",
                                    "function": {"name": name, "arguments": args}
                                }));
                            }
                            // thinking blocks are dropped — the upstream model
                            // does its own reasoning.
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            let has_tool_calls = !tool_calls.is_empty();
            let mut oa = serde_json::Map::new();
            oa.insert("role".to_string(), json!("assistant"));
            if has_tool_calls {
                oa.insert("tool_calls".to_string(), Value::Array(tool_calls));
            }
            if text_parts.len() == 1 {
                oa.insert("content".to_string(), json!(text_parts[0]));
            } else if text_parts.len() > 1 {
                oa.insert("content".to_string(), json!(text_parts.join("\n")));
            } else if !has_tool_calls {
                oa.insert("content".to_string(), json!(""));
            }
            out.push(Value::Object(oa));
        }
        _ => {
            // system etc. — passthrough
            out.push(m.clone());
        }
    }
}

fn convert_tool(t: &Value) -> Option<Value> {
    let name = t.get("name").and_then(|n| n.as_str())?;
    let description = t
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("");
    let parameters = t
        .get("input_schema")
        .cloned()
        .unwrap_or(json!({"type": "object"}));
    Some(json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters
        }
    }))
}

// ─── Response conversion: OpenAI → Anthropic (non-streaming) ─────────────

fn openai_to_anthropic_resp(body: &Value) -> Value {
    let id = body.get("id").and_then(|i| i.as_str()).unwrap_or("");
    let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
    let first = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .unwrap_or(&Value::Null);
    let message = first.get("message").unwrap_or(&Value::Null);

    let mut content: Vec<Value> = Vec::new();
    if let Some(rc) = message
        .get("reasoning_content")
        .and_then(|r| r.as_str())
    {
        if !rc.is_empty() {
            content.push(json!({"type": "thinking", "thinking": rc}));
        }
    }
    if let Some(t) = message.get("content") {
        match t {
            Value::String(s) if !s.is_empty() => {
                content.push(json!({"type": "text", "text": s}));
            }
            Value::Array(parts) => {
                for p in parts {
                    if let Some(txt) = p.get("text").and_then(|x| x.as_str()) {
                        if !txt.is_empty() {
                            content.push(json!({"type": "text", "text": txt}));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(tcs) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for tc in tcs {
            let id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let args_str = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|a| a.as_str())
                .unwrap_or("{}");
            let input = serde_json::from_str::<Value>(args_str).unwrap_or(Value::Null);
            content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }));
        }
    }

    let finish = first
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .unwrap_or("");
    let stop_reason = match finish {
        "tool_calls" => "tool_use",
        "length" => "max_tokens",
        _ => "end_turn",
    };

    let usage = body.get("usage").unwrap_or(&Value::Null);
    let input_tokens = usage
        .get("prompt_tokens")
        .and_then(|u| u.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .get("completion_tokens")
        .and_then(|u| u.as_u64())
        .unwrap_or(0);
    // OpenAI-compatible providers (opencode, DeepSeek…) report cache as
    // prompt_cache_hit_tokens (cache read) / prompt_cache_miss_tokens
    // (cache creation). Map them to the Anthropic field names so token
    // stats can count cache hits and cache misses.
    let cache_read_input_tokens = usage
        .get("prompt_cache_hit_tokens")
        .and_then(|u| u.as_u64())
        .unwrap_or(0);
    let cache_creation_input_tokens = usage
        .get("prompt_cache_miss_tokens")
        .and_then(|u| u.as_u64())
        .unwrap_or(0);

    json!({
        "id": format!("msg_{}", id.trim_start_matches("chatcmpl-")),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": cache_read_input_tokens,
            "cache_creation_input_tokens": cache_creation_input_tokens
        }
    })
}

// ─── Response conversion: OpenAI SSE → Anthropic SSE (streaming) ─────────

struct SseConverter {
    msg_id: String,
    model: String,
    sent_start: bool,
    thinking_open: bool,
    text_open: bool,
    block_index: usize,
    tool_calls: Vec<Value>, // [{index,id,name,args}]
    finish_reason: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    finished: bool,
}

impl SseConverter {
    fn new() -> Self {
        Self {
            msg_id: String::new(),
            model: String::new(),
            sent_start: false,
            thinking_open: false,
            text_open: false,
            block_index: 0,
            tool_calls: Vec::new(),
            finish_reason: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            finished: false,
        }
    }

    fn is_finished(&self) -> bool {
        self.finished
    }

    /// The accumulated authoritative usage + stable message id, for persisting
    /// to Little Claude's usage log directly from the proxy (the CLI drops
    /// message_delta fields it doesn't know, so input/cache never reach the
    /// frontend stream). Returns None when no usable usage was seen.
    fn usage_record(&self) -> Option<(String, u64, u64, u64, u64)> {
        let total = self.input_tokens.saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens).saturating_add(self.cache_creation_tokens);
        if total == 0 || self.msg_id.is_empty() {
            return None;
        }
        Some((
            self.msg_id.clone(),
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_creation_tokens,
        ))
    }

    /// Process one `data: {json}` payload from the OpenAI SSE stream.
    /// Returns Anthropic SSE event strings (without the trailing blank line).
    fn on_openai_chunk(&mut self, data: &str) -> Vec<String> {
        let mut events = Vec::new();
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return events,
        };

        // Usage may arrive in a dedicated chunk or with the final chunk.
        // Map OpenAI cache fields → Anthropic names so input AND cache
        // (hit + miss) tokens are carried through the conversion.
        if let Some(usage) = v.get("usage") {
            if let Some(t) = usage.get("prompt_tokens").and_then(|u| u.as_u64()) {
                self.input_tokens = t;
            }
            if let Some(t) = usage.get("completion_tokens").and_then(|u| u.as_u64()) {
                self.output_tokens = t;
            }
            if let Some(t) = usage
                .get("prompt_cache_hit_tokens")
                .and_then(|u| u.as_u64())
            {
                self.cache_read_tokens = t;
            }
            if let Some(t) = usage
                .get("prompt_cache_miss_tokens")
                .and_then(|u| u.as_u64())
            {
                self.cache_creation_tokens = t;
            }
        }

        if !self.sent_start {
            self.msg_id = format!(
                "msg_{}",
                v.get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .trim_start_matches("chatcmpl-")
            );
            self.model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            let msg = json!({
                "type": "message_start",
                "message": {
                    "id": self.msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": {"input_tokens": self.input_tokens, "output_tokens": 0}
                }
            });
            events.push(format!("event: message_start\ndata: {}", msg));
            self.sent_start = true;
        }

        let first = v
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .cloned()
            .unwrap_or(json!({}));
        let delta = first.get("delta").cloned().unwrap_or(json!({}));

        // Reasoning content (Qwen etc.)
        if let Some(rc) = delta.get("reasoning_content").and_then(|r| r.as_str()) {
            if !rc.is_empty() {
                if !self.thinking_open {
                    events.push(self.block_start("thinking", json!({
                        "type": "thinking",
                        "thinking": ""
                    })));
                    self.thinking_open = true;
                }
                events.push(self.block_delta("thinking_delta", json!({
                    "type": "thinking_delta",
                    "thinking": rc
                })));
            }
        }

        // Text content
        if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
            if !c.is_empty() {
                if self.thinking_open {
                    events.push(self.block_stop());
                    self.thinking_open = false;
                }
                if !self.text_open {
                    events.push(self.block_start("text", json!({"type": "text", "text": ""})));
                    self.text_open = true;
                }
                events.push(self.block_delta("text_delta", json!({
                    "type": "text_delta",
                    "text": c
                })));
            }
        }

        // Tool calls (accumulated across chunks)
        if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tcs {
                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                // Cap the tool-call index: a malicious/malformed upstream could
                // claim index=1e9 and this loop would allocate a billion
                // placeholder entries (OOM). Real tool streams have < 100
                // parallel calls; anything above the cap is dropped.
                if idx > 4096 {
                    continue;
                }
                while self.tool_calls.len() <= idx {
                    self.tool_calls
                        .push(json!({"id": "", "name": "", "args": ""}));
                }
                let entry = &mut self.tool_calls[idx];
                if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                    entry["id"] = json!(id);
                }
                if let Some(name) = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
                {
                    entry["name"] = json!(name);
                }
                if let Some(args) = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|a| a.as_str())
                {
                    entry["args"] = json!(entry["args"].as_str().unwrap_or("").to_string() + args);
                }
            }
        }

        if let Some(fr) = first.get("finish_reason").and_then(|f| f.as_str()) {
            self.finish_reason = fr.to_string();
        }

        events
    }

    /// Finalize the stream: close open blocks, emit tool_use blocks,
    /// message_delta and message_stop. Returns the final SSE events.
    fn finish(&mut self) -> Vec<String> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut events = Vec::new();

        if self.thinking_open {
            events.push(self.block_stop());
            self.thinking_open = false;
        }
        if self.text_open {
            events.push(self.block_stop());
            self.text_open = false;
        }

        // Flush accumulated tool calls as complete tool_use blocks
        // Collect first to avoid borrowing self.tool_calls while calling
        // &mut self methods below.
        let pending: Vec<(String, String, String)> = self
            .tool_calls
            .iter()
            .filter_map(|tc| {
                let name = tc.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name.is_empty() {
                    return None;
                }
                let id = tc.get("id").and_then(|i| i.as_str()).unwrap_or("");
                let args = tc.get("args").and_then(|a| a.as_str()).unwrap_or("{}");
                Some((id.to_string(), name.to_string(), args.to_string()))
            })
            .collect();
        for (id, name, args) in pending {
            let _ = serde_json::from_str::<Value>(&args).unwrap_or(Value::Null);
            events.push(self.block_start("tool_use", json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": json!({})
            })));
            events.push(self.block_delta("input_json_delta", json!({
                "type": "input_json_delta",
                "partial_json": args
            })));
            events.push(self.block_stop());
        }

        let stop_reason = match self.finish_reason.as_str() {
            "tool_calls" => "tool_use",
            "length" => "max_tokens",
            _ => "end_turn",
        };
        let delta = json!({
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": null},
            "usage": {
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "cache_read_input_tokens": self.cache_read_tokens,
                "cache_creation_input_tokens": self.cache_creation_tokens
            }
        });
        events.push(format!("event: message_delta\ndata: {}", delta));
        events.push(format!("event: message_stop\ndata: {}", json!({"type": "message_stop"})));
        events
    }

    fn block_start(&mut self, _kind: &str, block: Value) -> String {
        let ev = json!({
            "type": "content_block_start",
            "index": self.block_index,
            "content_block": block
        });
        let s = format!("event: content_block_start\ndata: {}", ev);
        self.block_index += 1;
        s
    }

    fn block_delta(&mut self, delta_kind: &str, delta: Value) -> String {
        let ev = json!({
            "type": "content_block_delta",
            "index": self.block_index.saturating_sub(1),
            "delta": delta
        });
        let _ = delta_kind; // kind is embedded in delta.type by caller
        format!("event: content_block_delta\ndata: {}", ev)
    }

    fn block_stop(&mut self) -> String {
        let ev = json!({
            "type": "content_block_stop",
            "index": self.block_index.saturating_sub(1)
        });
        format!("event: content_block_stop\ndata: {}", ev)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_to_openai_plain() {
        let body = json!({
            "model": "qwen3.8-max-preview",
            "max_tokens": 1024,
            "system": "You are helpful.",
            "messages": [
                {"role": "user", "content": "hello"}
            ]
        });
        let oa = anthropic_to_openai_req(&body);
        assert_eq!(oa["model"], "qwen3.8-max-preview");
        assert_eq!(oa["stream"], true);
        let msgs = oa["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are helpful.");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "hello");
    }

    #[test]
    fn anthropic_to_openai_tools() {
        let body = json!({
            "model": "m",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image", "source": {"media_type": "image/png", "data": "AA=="}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "checking"},
                    {"type": "tool_use", "id": "t1", "name": "read", "input": {"path": "/a"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "file contents"}
                ]}
            ],
            "tools": [{
                "name": "read",
                "description": "read a file",
                "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}
            }]
        });
        let oa = anthropic_to_openai_req(&body);
        let msgs = oa["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"][1]["type"], "image_url");
        assert_eq!(
            msgs[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AA=="
        );
        // assistant: text + tool_calls
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "checking");
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "read");
        assert_eq!(
            msgs[1]["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"/a"}"#
        );
        // tool result
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "t1");
        assert_eq!(msgs[2]["content"], "file contents");
        // tools converted to functions
        let tools = oa["tools"].as_array().unwrap();
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "read");
    }

    #[test]
    fn openai_to_anthropic_resp_plain() {
        let body = json!({
            "id": "chatcmpl-abc",
            "model": "qwen",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "hi there"
                },
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "prompt_cache_hit_tokens": 4, "prompt_cache_miss_tokens": 6}
        });
        let an = openai_to_anthropic_resp(&body);
        assert_eq!(an["type"], "message");
        assert_eq!(an["id"], "msg_abc");
        assert_eq!(an["stop_reason"], "end_turn");
        assert_eq!(an["content"][0]["type"], "text");
        assert_eq!(an["content"][0]["text"], "hi there");
        assert_eq!(an["usage"]["input_tokens"], 10);
        assert_eq!(an["usage"]["output_tokens"], 5);
        // Cache fields must survive the OpenAI → Anthropic conversion.
        assert_eq!(an["usage"]["cache_read_input_tokens"], 4);
        assert_eq!(an["usage"]["cache_creation_input_tokens"], 6);
    }

    #[test]
    fn sse_converter_maps_cache_fields_on_final_chunk() {
        let mut c = SseConverter::new();
        // Intermediate content chunk (no usage yet).
        c.on_openai_chunk(r#"{"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[{"delta":{"content":"hi"}}]}"#);
        // Final chunk carries the full usage incl. cache hit + miss.
        c.on_openai_chunk(r#"{"id":"chatcmpl-1","model":"deepseek-v4-flash","choices":[],"usage":{"prompt_tokens":84,"completion_tokens":16,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":84}}"#);
        let events = c.finish();
        let joined = events.join("\n");
        let delta = events
            .iter()
            .find(|e| e.contains("\"message_delta\""))
            .expect("message_delta present");
        let data = delta.split("data: ").nth(1).unwrap();
        let v: Value = serde_json::from_str(data).unwrap();
        let usage = &v["usage"];
        assert_eq!(usage["input_tokens"], 84);
        assert_eq!(usage["output_tokens"], 16);
        assert_eq!(usage["cache_read_input_tokens"], 0);
        assert_eq!(usage["cache_creation_input_tokens"], 84);
        assert!(joined.contains("message_stop"));
    }

    #[test]
    fn openai_to_anthropic_resp_thinking_and_tools() {
        let body = json!({
            "id": "chatcmpl-x",
            "model": "qwen",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "reasoning_content": "let me think",
                    "content": "answer",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "bash", "arguments": "{\"cmd\":\"ls\"}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let an = openai_to_anthropic_resp(&body);
        assert_eq!(an["stop_reason"], "tool_use");
        let content = an["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["thinking"], "let me think");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "answer");
        assert_eq!(content[2]["type"], "tool_use");
        assert_eq!(content[2]["name"], "bash");
        assert_eq!(content[2]["input"]["cmd"], "ls");
    }

    #[test]
    fn sse_converter_streams_text_and_tools() {
        let mut conv = SseConverter::new();

        // chunk 1: reasoning
        let evs = conv.on_openai_chunk(
            r#"{"id":"chatcmpl-1","model":"qwen","choices":[{"delta":{"role":"assistant","reasoning_content":"think"},"finish_reason":null}]}"#,
        );
        assert!(evs.iter().any(|e| e.contains("content_block_start") && e.contains("thinking")));
        assert!(evs.iter().any(|e| e.contains("thinking_delta")));

        // chunk 2: text
        let evs = conv.on_openai_chunk(
            r#"{"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}"#,
        );
        assert!(evs.iter().any(|e| e.contains("content_block_stop"))); // closes thinking
        assert!(evs.iter().any(|e| e.contains("text_delta") && e.contains("Hel")));

        // chunk 3: text continuation
        let evs = conv.on_openai_chunk(
            r#"{"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}"#,
        );
        assert!(evs.iter().any(|e| e.contains("text_delta") && e.contains("lo")));

        // chunk 4: tool call (split across two chunks)
        let evs = conv.on_openai_chunk(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\"cmd\":\"ls"}}]},"finish_reason":null}]}"#,
        );
        assert!(evs.is_empty()); // tool calls accumulate silently
        let evs = conv.on_openai_chunk(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"}"}}]},"finish_reason":"tool_calls"}]}"#,
        );
        assert!(evs.is_empty());

        // finish
        let evs = conv.finish();
        assert!(evs.iter().any(|e| e.contains("message_delta") && e.contains("tool_use")));
        assert!(evs.iter().any(|e| e.contains("content_block_start") && e.contains("tool_use")));
        assert!(evs.iter().any(|e| e.contains("message_stop")));
        // idempotent
        assert!(conv.finish().is_empty());
    }

    #[test]
    fn redact_secrets_hides_keys() {
        assert_eq!(
            redact_secrets("Invalid API key: sk-abc123XYZ-_def456"),
            "Invalid API key: [REDACTED]"
        );
        assert_eq!(
            redact_secrets("no secrets here"),
            "no secrets here"
        );
        // Short values (not keys) are left alone.
        assert_eq!(redact_secrets("sk-short"), "sk-short");
    }

    #[test]
    fn sse_converter_no_double_start() {
        let mut conv = SseConverter::new();
        conv.on_openai_chunk(r#"{"choices":[{"delta":{"content":"a"},"finish_reason":null}]}"#);
        let evs = conv.on_openai_chunk(r#"{"choices":[{"delta":{"content":"b"},"finish_reason":null}]}"#);
        // second chunk must not re-emit message_start / content_block_start
        assert!(!evs.iter().any(|e| e.contains("message_start")));
        assert_eq!(evs.iter().filter(|e| e.contains("content_block_start")).count(), 0);
    }

    // ── 主端点 5xx / 连接失败自动降级到兜底端点 ──────────────────────────

    /// 起一个本地 fake HTTP 服务器：任意 POST → 固定状态码 + body。
    async fn spawn_fake_http(
        status: u16,
        body: &'static str,
    ) -> std::net::SocketAddr {
        use http_body_util::Full;
        use hyper::service::service_fn;
        use hyper::{Request, Response, StatusCode};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let srv = service_fn(move |req: Request<hyper::body::Incoming>| async move {
                eprintln!(
                    "FAKE_SRV[{}] got {} {}",
                    status,
                    req.method(),
                    req.uri()
                );
                let resp = Response::builder()
                    .status(StatusCode::from_u16(status).unwrap())
                    .header("content-type", "application/json")
                    .body(Full::new(hyper::body::Bytes::from(body)))
                    .unwrap();
                Ok::<_, std::convert::Infallible>(resp)
            });
            loop {
                let (sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let srv = srv.clone();
                tokio::spawn(async move {
                    let io = hyper_util::rt::TokioIo::new(sock);
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, srv)
                        .await;
                });
            }
        });
        addr
    }

    /// 按请求序号轮转响应的 fake 服务器：第 i 次请求返回
    /// responses[min(i, len-1)]（元组 = (状态码, body, 延迟毫秒)）。
    /// 返回 (地址, 请求计数)，用于断言「探测只发了一次」「主端点没被打到」。
    async fn spawn_fake_http_seq(
        responses: &'static [(u16, &'static str, u64)],
    ) -> (
        std::net::SocketAddr,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use http_body_util::Full;
        use hyper::service::service_fn;
        use hyper::{Request, Response, StatusCode};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count2 = count.clone();
        tokio::spawn(async move {
            let srv = service_fn(move |_req: Request<hyper::body::Incoming>| {
                let c = count2.clone();
                async move {
                    let i = c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let (status, body, delay_ms) = responses[i.min(responses.len() - 1)];
                    if delay_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                    let resp = Response::builder()
                        .status(StatusCode::from_u16(status).unwrap())
                        .header("content-type", "application/json")
                        .body(Full::new(hyper::body::Bytes::from(body)))
                        .unwrap();
                    Ok::<_, std::convert::Infallible>(resp)
                }
            });
            loop {
                let (sock, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let srv = srv.clone();
                tokio::spawn(async move {
                    let io = hyper_util::rt::TokioIo::new(sock);
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, srv)
                        .await;
                });
            }
        });
        (addr, count)
    }

    /// 读取响应 body 为文本。
    async fn response_body(resp: Response<BoxBody>) -> String {
        use http_body_util::BodyExt;
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8_lossy(&bytes).to_string()
    }


}
