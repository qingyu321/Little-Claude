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
        fallback: Option<WebSearchFallbackConfig>,
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
            fallback,
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
            "[LITTLECLAUDE:proxy] Started proxy for session {} on port {} (token {}) → {} (format {}, fallback {})",
            session_id,
            port,
            token,
            state.target_url,
            state.main_format,
            if state.fallback.is_some() { "yes" } else { "no" }
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
    /// Web-search fallback endpoint; None = plain conversion proxy (legacy).
    fallback: Option<WebSearchFallbackConfig>,
}

/// 联网搜索兜底端点配置（密钥已在 session.rs 解析完成，此处永远明文）。
#[derive(Clone)]
pub(crate) struct WebSearchFallbackConfig {
    /// 用户输入的原始端点，请求时经 provider_messages_endpoint 归一化。
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    /// 空串 = 沿用请求体里的 model。
    pub(crate) model: String,
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

/// Dispatcher: routes a request to the fallback endpoint (web_search server
/// tool present), the main Anthropic endpoint (passthrough), or the OpenAI
/// conversion pipeline.
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
    let has_web = has_web_search_tool(&anthropic_body);
    proxy_log(&format!(
        "REQ session={} has_web={} tools={} msgs={} model={} fallback={}",
        state.session_id,
        has_web,
        tool_count,
        msg_count,
        model,
        if state.fallback.is_some() { "some" } else { "none" }
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
    if has_web {
        // 能力检测式分流：主端点能联网搜索就走主端点，探测为不支持才走兜底
        // （结论按 主端点+model 缓存，见 route_web_search）。
        if state.fallback.is_some() {
            match route_web_search(state, &anthropic_body).await {
                WebRoute::Main => {
                    eprintln!(
                        "[LITTLECLAUDE:proxy] Session {} web_search request → main endpoint (capable)",
                        state.session_id
                    );
                }
                WebRoute::Fallback => return forward_to_fallback(state, &anthropic_body).await,
            }
        }
    }
    if state.main_format.eq_ignore_ascii_case("anthropic") {
        // 主端点是 Anthropic 格式：原样透传（tools 不改写，与直连行为一致）。
        let fr = forward_passthrough(&state.target_url, &state.api_key, &anthropic_body, "", false)
            .await;
        let resp = fr.response;
        // 主端点 5xx / 连接失败（UPSTREAM_CONN_ERR 也收敛为 502）→ 自动降级到
        // 兜底端点重试一次。不限于 web_search 请求：CLI 会话的 tools 里没有
        // web_search 工具（has_web=false），若只按 has_web 判定，兜底对 CLI
        // 形同虚设，主端点一抖 502 就直接透传给了用户。
        if resp.status().is_server_error() {
            if let Some(fb) = &state.fallback {
                proxy_log(&format!(
                    "FAILOVER session={} status={} main={} → fallback={}",
                    state.session_id,
                    resp.status(),
                    state.target_url,
                    fb.base_url
                ));
                eprintln!(
                    "[LITTLECLAUDE:proxy] Session {} main endpoint {} returned {} — failing over to fallback {}",
                    state.session_id, state.target_url, resp.status(), fb.base_url
                );
                return forward_passthrough(&fb.base_url, &fb.api_key, &anthropic_body, &fb.model, true)
                    .await
                    .response;
            }
        }
        // 修复 1 姊妹分支：web_search 真实请求 4xx → 状态机回退 + 转兜底重发
        // （探测 2xx 只证明最小请求能过，真实请求可能被 400 拒绝；不兜底则
        // web 搜索本运行内永久失效）。仅 has_web 请求生效——非 web 请求的
        // 4xx 保持现状透传，不扩大行为面。
        if has_web && !resp.status().is_success() {
            if let Some((st, text)) = &fr.upstream_error {
                if (400..500).contains(st) && state.fallback.is_some() {
                    return handle_web_4xx_fallback(state, &anthropic_body, model, *st, text).await;
                }
            }
        }
        return resp;
    }
    let fr = forward_openai_conversion(state, anthropic_body.clone(), is_compact_request).await;
    let resp = fr.response;
    if resp.status().is_server_error() {
        // OpenAI 转换分支同样降级：兜底端点是 Anthropic 格式，直接用原始
        // anthropic body（rewrite=true 只剔除/规范化 web_search 工具）。
        if let Some(fb) = &state.fallback {
            proxy_log(&format!(
                "FAILOVER session={} status={} main={} → fallback={} (openai conversion)",
                state.session_id,
                resp.status(),
                state.target_url,
                fb.base_url
            ));
            return forward_passthrough(&fb.base_url, &fb.api_key, &anthropic_body, &fb.model, true)
                .await
                .response;
        }
    }
    // 修复 1：openai 转换路径的 web_search 真实请求 4xx 同样兜底。
    if has_web && !resp.status().is_success() {
        if let Some((st, text)) = &fr.upstream_error {
            if (400..500).contains(st) && state.fallback.is_some() {
                return handle_web_4xx_fallback(state, &anthropic_body, model, *st, text).await;
            }
        }
    }
    resp
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
                            if inp + out + cache_read + cache_creation > 0 {
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

// ─── Web-search fallback passthrough ────────────────────────────────────

/// 单个工具是否为 web_search 服务端工具（大小写不敏感）。
///
/// CLI 2.1.227 起 WebSearch 以普通工具形式进入请求的 `tools` 数组（无
/// `type` 字段、驼峰大写名 `WebSearch`），不再有顶层 `server_tools`——
/// 大小写敏感匹配会永久漏判，fallback 永不触发。官方服务端工具格式为
/// type/name `web_search` / `web_search_20250305`。
fn is_web_search_tool(t: &Value) -> bool {
    let ttype = t
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let tname = t
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    ttype == "web_search"
        || ttype.starts_with("web_search_")
        || tname == "web_search"
        || tname == "websearch"
}

/// tools 数组（防御性含顶层 `server_tools`）里是否有 web_search 服务端工具。
fn has_web_search_tool(body: &Value) -> bool {
    let mut arrays: Vec<&Vec<Value>> = Vec::new();
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        arrays.push(tools);
    }
    if let Some(tools) = body.get("server_tools").and_then(|t| t.as_array()) {
        arrays.push(tools);
    }
    for tools in arrays {
        for t in tools {
            if is_web_search_tool(t) {
                return true;
            }
        }
    }
    false
}

/// 只提取请求体中的 web_search 服务端工具（能力探测时单独发送，隔离判定：
/// 探测请求只带 web_search，避免本地工具集干扰「端点认不认识 web_search」）。
fn web_search_tools_only(body: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for key in ["tools", "server_tools"] {
        if let Some(tools) = body.get(key).and_then(|t| t.as_array()) {
            for t in tools {
                if is_web_search_tool(t) {
                    out.push(t.clone());
                }
            }
        }
    }
    out
}

/// 判定上游 4xx 错误是否为「不支持 web_search 工具」类错误——能力检测的分水岭。
///
/// 规则：HTTP 4xx（排除认证 401/403、欠费 402、端点形状 404、超时 408、
/// 限流 429）+ 错误信息含 `tool` 关键字 + 明确的不支持语义。
///
/// 仅凭 message 含 "tool" 太宽——`tools[0].function.description` 这类参数
/// 校验错误同样提到 tool，却与「端点不支持该工具」无关（误判会把主端点
/// 永久绕开）。因此判定分三层：
/// 1. message/code 含明确能力缺失语义（not supported / unsupported /
///    unknown tool / not available / does not support / no such tool /
///    invalid tool / not recognized / not found）；
/// 2. 或错误 type/code 本身含 tool（如 tool_not_found / unsupported_tool）
///    且 message 提到 tool；
/// 3. 或 type 为 invalid_request_error 类且 message 同时含 tool 与
///    能力类词（unknown/support/available/found）——兼容 Anthropic 风格
///    （`error.type=invalid_request_error`）与 OpenAI 兼容端点（DeepSeek/
///    百炼等只有 message 或 code 字段）；error 为纯字符串 / body 非 JSON
///    时按第 1 层的 message 语义判定。
///
/// 错误类型明确为服务端故障（如 api_error）时即使 message 提到 tool 也
/// 不判定为不支持，避免把瞬时故障误判成能力缺失（误判会让主端点被永久
/// 绕开）。
fn is_tool_not_supported(status: u16, body: &str) -> bool {
    if !(400..500).contains(&status) || matches!(status, 401 | 402 | 403 | 404 | 408 | 429) {
        return false;
    }
    let (msg, etype) = match serde_json::from_str::<Value>(body) {
        Ok(v) => {
            let err = v.get("error").cloned().unwrap_or(Value::Null);
            let msg = match &err {
                Value::String(s) => s.clone(),
                _ => err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| err.get("code").and_then(|c| c.as_str()))
                    .or_else(|| v.get("message").and_then(|m| m.as_str()))
                    .unwrap_or("")
                    .to_string(),
            };
            let etype = err
                .get("type")
                .and_then(|t| t.as_str())
                .or_else(|| err.get("code").and_then(|c| c.as_str()))
                .unwrap_or("")
                .to_string();
            (msg, etype)
        }
        Err(_) => (body.to_string(), String::new()),
    };
    let msg_l = msg.to_lowercase();
    if !msg_l.contains("tool") {
        return false;
    }
    // 第 1 层：明确的工具不支持语义（对 JSON 与非 JSON body 通用）。
    for kw in [
        "unknown tool",
        "not supported",
        "not_supported",
        "unsupported",
        "not available",
        "not_available",
        "does not support",
        "no such tool",
        "invalid tool",
        "not recognized",
        "not found",
    ] {
        if msg_l.contains(kw) {
            return true;
        }
    }
    let t = etype.to_lowercase();
    // 第 2 层：type/code 本身表明工具缺失（tool_not_found / unsupported_tool…）。
    if t.contains("tool") {
        return true;
    }
    // 第 3 层：invalid_request_error 类 + message 同时提到 tool 与能力类词
    // （排除 "tools[0].function.description" 这类参数校验错误）；type/code
    // 缺失时（纯字符串 error / 非 JSON body）同样按能力类词收紧判定。
    if t.contains("invalid") || t.is_empty() {
        for kw in ["unknown", "support", "available", "found"] {
            if msg_l.contains(kw) {
                return true;
            }
        }
    }
    false
}

// ── 主端点联网搜索能力状态机（进程内存态）──────────────────────────────
// 语义：主 API 能联网搜索就走主 API，不能才走兜底（从「无条件分流」改为
// 「能力检测式」）。状态按（主端点消息 URL, model）缓存，仅本次进程运行内
// 有效；运行中改配置感知不到（新 endpoint 落到新 key，自然重新探测）。
// 状态机纯内存：探测成本由 60s 冷却封顶，无需落盘。

/// 主端点对 web_search 工具的探测结论。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum WebSearchCapability {
    /// 探测 2xx：主端点支持——web_search 请求直走主端点。
    Capable,
    /// 「工具不支持」4xx：主端点拒绝——web_search 请求直接走兜底。
    Incapable,
    /// 探测失败（5xx/超时/其他 4xx）：不缓存结论，冷却期内走兜底。
    Unknown,
}

struct CapabilityEntry {
    capability: WebSearchCapability,
    last_probe: std::time::Instant,
    /// 该 key 的探测请求是否在途（single-flight：并发 Unknown 请求只探测一次，
    /// 避免重复计费与慢探测覆盖快探测结论的 last-writer-wins 竞态）。
    probing: bool,
    /// 标记为 Incapable 的时刻；超过 INCAPABLE_TTL 后回退 Unknown 重新探测
    /// （端点/模型的 web 搜索权限可能在运行中变化，永久绕开主端点不可取）。
    incapable_since: Option<std::time::Instant>,
}

static CAPABILITY_STATE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, CapabilityEntry>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// 探测失败后的冷却期：主端点故障时避免每个 web_search 请求都先打一发探测，
/// 冷却期内直接走兜底（= 改造前的无条件分流行为，零额外延迟）。
const PROBE_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(60);

/// Incapable 标记的 TTL：超过后回退 Unknown 重新探测，给「运行中开通了
/// web 搜索权限」的端点/模型一个重试窗口。
const INCAPABLE_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// 能力状态 key：主端点消息 URL + 请求 model。model 纳入 key 是因为能力是
/// 「端点上具体模型」的属性（同一网关不同模型工具支持可能不同）；运行中
/// 切换 model 会落到新 key 重新探测。
fn capability_key(state: &ProxyState, model: &str) -> String {
    format!(
        "{}|{}",
        crate::commands::provider::provider_messages_endpoint(&state.target_url, &state.main_format),
        model
    )
}

/// 读取能力状态。返回 (状态, 是否需要探测)：Capable 永不重探；Incapable 在
/// TTL 内不重探、TTL 过后惰性回退 Unknown 触发重探；Unknown 且冷却已过 →
/// 需要探测。
fn capability_of(key: &str) -> (WebSearchCapability, bool) {
    let st = CAPABILITY_STATE.lock().unwrap_or_else(|p| p.into_inner());
    match st.get(key) {
        Some(e) => {
            if e.capability == WebSearchCapability::Incapable {
                let expired = e
                    .incapable_since
                    .is_some_and(|since| since.elapsed() >= INCAPABLE_TTL);
                if expired {
                    return (WebSearchCapability::Unknown, true);
                }
                return (WebSearchCapability::Incapable, false);
            }
            (
                e.capability,
                matches!(e.capability, WebSearchCapability::Unknown)
                    && e.last_probe.elapsed() >= PROBE_COOLDOWN,
            )
        }
        None => (WebSearchCapability::Unknown, true),
    }
}

fn mark_capability(key: &str, capability: WebSearchCapability) {
    let mut st = CAPABILITY_STATE.lock().unwrap_or_else(|p| p.into_inner());
    let now = std::time::Instant::now();
    match st.get_mut(key) {
        Some(e) => {
            e.capability = capability;
            e.last_probe = now;
            e.incapable_since = (capability == WebSearchCapability::Incapable).then_some(now);
            // 保留 e.probing：探测在途标记由 end_probe 负责清除，mark 只更新结论。
        }
        None => {
            st.insert(
                key.to_string(),
                CapabilityEntry {
                    capability,
                    last_probe: now,
                    probing: false,
                    incapable_since: (capability == WebSearchCapability::Incapable).then_some(now),
                },
            );
        }
    }
}

/// 尝试开始一次能力探测（single-flight）。返回 false 表示该 key 已有探测在途，
/// 调用方不得重复探测（直接走兜底）。探测是 async 操作，此标记在 await 前用
/// 同步锁设置、await 后由 `ProbeInFlight` guard 清除——锁只保护 HashMap 的
/// 短临界区，绝不跨 await 持有。
fn begin_probe(key: &str) -> bool {
    let mut st = CAPABILITY_STATE.lock().unwrap_or_else(|p| p.into_inner());
    match st.get_mut(key) {
        Some(e) => {
            if e.probing {
                return false;
            }
            e.probing = true;
            true
        }
        None => {
            st.insert(
                key.to_string(),
                CapabilityEntry {
                    capability: WebSearchCapability::Unknown,
                    last_probe: std::time::Instant::now(),
                    probing: true,
                    incapable_since: None,
                },
            );
            true
        }
    }
}

/// 清除某 key 的探测在途标记（探测完成/失败/panic 路径统一经 Drop 调用）。
fn end_probe(key: &str) {
    let mut st = CAPABILITY_STATE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(e) = st.get_mut(key) {
        e.probing = false;
    }
}

/// RAII guard：探测请求在途期间持有，Drop 时清除 probing 标记——
/// 无论探测以何种方式结束（正常返回/panic/任务被 abort）都不会泄漏标记。
struct ProbeInFlight<'a>(&'a str);

impl Drop for ProbeInFlight<'_> {
    fn drop(&mut self) {
        end_probe(self.0);
    }
}

/// 向主端点发一发最小探测请求，判定其是否支持 web_search 工具。
///
/// 选型：不做流式首帧探测，而是 Unknown 时先发**非流式最小探测**——同一函数
/// 覆盖 anthropic/openai 两种格式与流式/非流式真实请求。探测响应一定是 HTTP
/// 状态码 + JSON body（工具不支持错误不会藏在 SSE 首帧里），判定精确且只有
/// 一条代码路径；代价是每个 (端点, model) 首次 web_search 请求多发一发
/// max_tokens=8 的小请求（失败端点由冷却期封顶）。
async fn probe_web_search_capability(state: &ProxyState, body: &Value) -> WebSearchCapability {
    let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
    let mut tools = web_search_tools_only(body);
    if tools.is_empty() {
        tools.push(json!({"type": "web_search_20250305", "name": "web_search", "max_uses": 1}));
    }
    let probe_body = json!({
        "model": model,
        "max_tokens": 8,
        "stream": false,
        "messages": [{"role": "user", "content": "probe"}],
        "tools": tools,
    });
    let target = crate::commands::provider::provider_messages_endpoint(
        &state.target_url,
        &state.main_format,
    );
    let client = upstream_client();
    let mut req = client
        .post(&target)
        .timeout(std::time::Duration::from_secs(20));
    let payload = if state.main_format.eq_ignore_ascii_case("anthropic") {
        req = req
            .header("x-api-key", state.api_key.as_str())
            .header("anthropic-version", "2023-06-01");
        probe_body
    } else {
        req = req.header("Authorization", format!("Bearer {}", state.api_key));
        anthropic_to_openai_req(&probe_body)
    };
    let resp = match req.json(&payload).send().await {
        Ok(r) => r,
        Err(e) => {
            proxy_log(&format!("PROBE_CONN_ERR {} err={}", target, e));
            return WebSearchCapability::Unknown;
        }
    };
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        proxy_log(&format!("PROBE_OK {} status={} → capable", target, status));
        return WebSearchCapability::Capable;
    }
    let text = resp.text().await.unwrap_or_default();
    if is_tool_not_supported(status, &text) {
        proxy_log(&format!(
            "PROBE_TOOL_UNSUPPORTED {} status={} body={}",
            target,
            status,
            text.chars().take(300).collect::<String>()
        ));
        return WebSearchCapability::Incapable;
    }
    proxy_log(&format!(
        "PROBE_UNKNOWN {} status={} body={}",
        target,
        status,
        text.chars().take(200).collect::<String>()
    ));
    WebSearchCapability::Unknown
}

/// web_search 请求的路由决策：主端点能搜就走主端点，不能才兜底。
enum WebRoute {
    Main,
    Fallback,
}

async fn route_web_search(state: &ProxyState, body: &Value) -> WebRoute {
    // main_format=openai 时跳过能力检测，恒走兜底：探测把 web_search 工具转成
    // 普通 function 发给 /chat/completions，任何健康端点都回 2xx——2xx 不证明
    // 「能执行搜索」，误标 Capable 会让真实请求全走主端点而服务端搜索工具
    // 名/格式对不上，搜索静默失效（改造前该组合一律走兜底，是可用的）。
    if !state.main_format.eq_ignore_ascii_case("anthropic") {
        proxy_log(&format!(
            "ROUTE session={} → fallback (openai main format: probe semantics invalid)",
            state.session_id
        ));
        return WebRoute::Fallback;
    }
    let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("");
    let key = capability_key(state, model);
    let (cap, probe_due) = capability_of(&key);
    match cap {
        WebSearchCapability::Capable => {
            proxy_log(&format!(
                "ROUTE session={} key={} → main (capable)",
                state.session_id, key
            ));
            WebRoute::Main
        }
        WebSearchCapability::Incapable => {
            proxy_log(&format!(
                "ROUTE session={} key={} → fallback (incapable)",
                state.session_id, key
            ));
            WebRoute::Fallback
        }
        WebSearchCapability::Unknown if !probe_due => {
            proxy_log(&format!(
                "ROUTE session={} key={} → fallback (probe cooldown)",
                state.session_id, key
            ));
            WebRoute::Fallback
        }
        WebSearchCapability::Unknown => {
            // single-flight：探测在途时其他同 key 请求不再发探测，直接走兜底
            // （capability_of 与 begin_probe 之间没有 await，不会出现两个请求
            // 同时通过判定的窗口；慢探测的失败结果也不会再覆盖并发成功探测
            // 的 Capable 结论）。
            if !begin_probe(&key) {
                proxy_log(&format!(
                    "ROUTE session={} key={} → fallback (probe already in flight)",
                    state.session_id, key
                ));
                return WebRoute::Fallback;
            }
            // 探测结束（含 panic/abort）由 guard Drop 自动清除 probing 标记。
            let _probe_guard = ProbeInFlight(&key);
            let result = probe_web_search_capability(state, body).await;
            match result {
                WebSearchCapability::Capable => {
                    mark_capability(&key, WebSearchCapability::Capable);
                    proxy_log(&format!(
                        "ROUTE session={} key={} → main (probed capable)",
                        state.session_id, key
                    ));
                    WebRoute::Main
                }
                WebSearchCapability::Incapable => {
                    mark_capability(&key, WebSearchCapability::Incapable);
                    proxy_log(&format!(
                        "ROUTE session={} key={} → fallback (probed incapable)",
                        state.session_id, key
                    ));
                    WebRoute::Fallback
                }
                WebSearchCapability::Unknown => {
                    mark_capability(&key, WebSearchCapability::Unknown);
                    proxy_log(&format!(
                        "ROUTE session={} key={} → fallback (probe failed)",
                        state.session_id, key
                    ));
                    WebRoute::Fallback
                }
            }
        }
    }
}

/// 转发到兜底端点（rewrite=true：model 替换 + web_search 工具名规范化）。
async fn forward_to_fallback(state: &ProxyState, body: &Value) -> Response<BoxBody> {
    if let Some(fb) = &state.fallback {
        eprintln!(
            "[LITTLECLAUDE:proxy] Session {} web_search request → fallback {}",
            state.session_id, fb.base_url
        );
        return forward_passthrough(&fb.base_url, &fb.api_key, body, &fb.model, true)
            .await
            .response;
    }
    json_response(StatusCode::BAD_GATEWAY, json!({
        "type": "error",
        "error": {"type": "api_error", "message": "Web-search fallback not configured"}
    }))
}

/// 真实 web_search 请求在主端点 4xx 时：回退能力状态机并用原请求转兜底重发。
///
/// 探测只验证「最小请求能过」，真实请求（完整上下文/多轮/tool_result/图片）
/// 仍可能被主端点 400 拒绝（如网关拒绝 tool_result、上下文超限、内容过滤）——
/// 不兜底的话错误直接透传用户且状态机永不回退，web 搜索本运行内永久失效
/// （改造前这类请求一律走兜底）。标记语义：
/// - 工具不支持类 4xx（is_tool_not_supported）→ Incapable（TTL 内不重探）；
/// - 其他 4xx → Unknown（回退冷却，60s 后重新探测）。
async fn handle_web_4xx_fallback(
    state: &ProxyState,
    body: &Value,
    model: &str,
    status: u16,
    upstream_text: &str,
) -> Response<BoxBody> {
    let key = capability_key(state, model);
    let tool_unsupported = is_tool_not_supported(status, upstream_text);
    let cap = if tool_unsupported {
        WebSearchCapability::Incapable
    } else {
        WebSearchCapability::Unknown
    };
    mark_capability(&key, cap);
    proxy_log(&format!(
        "WEB_4XX_FALLBACK session={} status={} classify={} key={}",
        state.session_id,
        status,
        if tool_unsupported { "incapable" } else { "unknown-retry" },
        key
    ));
    eprintln!(
        "[LITTLECLAUDE:proxy] Session {} main endpoint returned {} on web_search request — marking {:?}, retrying fallback",
        state.session_id, status, cap
    );
    forward_to_fallback(state, body).await
}

/// 兜底请求体改写：model → fallback.model（非空时）；web_search 服务端工具
/// → `{"type":"web_search_20250305","name":"web_search","max_uses":1}`。
///
/// 其余工具（bash/read/Edit 等本地工具）**原样保留**，只改写 web_search——
/// 兜底/降级请求必须带着完整工具集发给 fallback 端点（本地工具由 CLI 自己
/// 执行，端点只需认识声明；服务端工具只有 web_search 需要按兼容端点要求
/// 版本化，旧名 `web_search` 会被 DeepSeek 等端点拒绝）。
fn prepare_fallback_body(body: &Value, model: &str) -> Value {
    let mut out = body.clone();
    if !model.trim().is_empty() {
        out["model"] = Value::String(model.trim().to_string());
    }
    for key in ["tools", "server_tools"] {
        if let Some(tools) = out.get_mut(key).and_then(|t| t.as_array_mut()) {
            for t in tools.iter_mut() {
                let ttype = t.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let tname = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
                // 只改写 web_search 工具；客户端工具（Agent/Bash/WebSearch 等）
                // 必须原样保留——降级/兜底请求要带着完整工具集发给 fallback 端点。
                if ttype == "web_search"
                    || ttype.starts_with("web_search_")
                    || tname == "web_search"
                {
                    *t = json!({"type": "web_search_20250305", "name": "web_search", "max_uses": 1});
                }
            }
        }
    }
    out
}

/// 上游转发结果：HTTP 响应 + 可选的上游错误快照。
///
/// `upstream_error` 仅在非 2xx 时携带 `(HTTP 状态码, 原始上游错误 body 文本)`
/// ——`forward_messages` 用它做 web_search 真实请求的 4xx 语义判定（工具不支持
/// → 标记 Incapable；其他 4xx → 回退 Unknown 冷却重探，两者都转兜底重发）。
struct ForwardResult {
    response: Response<BoxBody>,
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

/// Anthropic 格式原样转发（JSON / SSE 字节流，不做任何转换）。
///
/// headers: `x-api-key`（替换）、`anthropic-version: 2023-06-01`、content-type。
/// 注意：DeepSeek 等 anthropic 兼容端点只认 `x-api-key`，不接受 Bearer。
///
/// `rewrite = true` 时先过 `prepare_fallback_body`（仅兜底分支用；
/// 主端点透传 `rewrite = false`，tools 不改写）。透传分支不记 usage——
/// 前端从 CLI 流事件的 usage 字段直接记账。
async fn forward_passthrough(
    base_url: &str,
    api_key: &str,
    body: &Value,
    model: &str,
    rewrite: bool,
) -> ForwardResult {
    let target = crate::commands::provider::provider_messages_endpoint(base_url, "anthropic");
    let payload = if rewrite {
        prepare_fallback_body(body, model)
    } else {
        body.clone()
    };
    let is_stream = payload
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);

    // Log the key length only, never key material — the first 8 chars of a
    // long-lived API key are still usable by an attacker who reads
    // %TEMP%\littleclaude-proxy.log.
    proxy_log(&format!(
        "FWD {} rewrite={} key=<{} chars> model={} tools={}",
        target,
        rewrite,
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
        proxy_log(&format!(
            "UPSTREAM_ERR {} status={} body={}",
            target,
            status,
            text.chars().take(400).collect::<String>()
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
        let total = self.input_tokens + self.output_tokens
            + self.cache_read_tokens + self.cache_creation_tokens;
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
    fn has_web_search_tool_detects_server_tool() {
        // 裸名
        assert!(has_web_search_tool(&json!({
            "model": "m",
            "tools": [{"type": "web_search", "name": "web_search", "max_uses": 1}]
        })));
        // 带版本号
        assert!(has_web_search_tool(&json!({
            "tools": [{"type": "web_search_20250305", "name": "web_search"}]
        })));
        assert!(has_web_search_tool(&json!({
            "tools": [{"type": "web_search_20260209", "name": "web_search"}]
        })));
        // 只匹配 name
        assert!(has_web_search_tool(&json!({
            "tools": [{"type": "custom", "name": "web_search"}]
        })));
        // 顶层 server_tools
        assert!(has_web_search_tool(&json!({
            "server_tools": [{"type": "web_search", "name": "web_search"}]
        })));
        // 非 web_search 工具
        assert!(!has_web_search_tool(&json!({
            "tools": [{"type": "custom", "name": "bash", "description": "x"}]
        })));
        // 无 tools 字段
        assert!(!has_web_search_tool(&json!({"model": "m"})));
        // 空 body
        assert!(!has_web_search_tool(&json!({})));
    }

    #[test]
    fn prepare_fallback_body_rewrites_tools_and_model() {
        let body = json!({
            "model": "main-model",
            "max_tokens": 100,
            "stream": true,
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [
                {"type": "web_search", "name": "web_search", "max_uses": 1},
                {"type": "custom", "name": "bash", "description": "d", "input_schema": {"type": "object"}}
            ]
        });
        let out = prepare_fallback_body(&body, "deepseek-v4-flash");
        assert_eq!(out["model"], "deepseek-v4-flash");
        assert_eq!(out["max_tokens"], 100);
        let tools = out["tools"].as_array().unwrap();
        // web_search 被规范化
        assert_eq!(tools[0]["type"], "web_search_20250305");
        assert_eq!(tools[0]["name"], "web_search");
        assert_eq!(tools[0]["max_uses"], 1);
        // 其他工具原样
        assert_eq!(tools[1]["type"], "custom");
        assert_eq!(tools[1]["name"], "bash");
        // 已版本化的工具也被统一到 20250305
        let out2 = prepare_fallback_body(
            &json!({"tools": [{"type": "web_search_20260209", "name": "web_search"}]}),
            "",
        );
        assert_eq!(out2["tools"][0]["type"], "web_search_20250305");
    }

    #[test]
    fn prepare_fallback_body_keeps_model_when_empty() {
        let body = json!({"model": "m", "tools": [{"type": "custom"}]});
        let out = prepare_fallback_body(&body, "  ");
        assert_eq!(out["model"], "m");
        // 非 web_search 请求：tools 不误改
        let tools = out["tools"].as_array().unwrap();
        assert_eq!(tools[0]["type"], "custom");
    }

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

    #[tokio::test]
    async fn forward_messages_fails_over_on_main_5xx() {
        // 主端点：502 + 真空 body（zen 不稳时的典型形态）
        let main_addr = spawn_fake_http(502, "").await;
        // 兜底端点：200 + 合法 Anthropic 响应（特征 id=fallback-msg）
        let fb_addr = spawn_fake_http(
            200,
            r#"{"type":"message","id":"fallback-msg-1","model":"m","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}"#,
        )
        .await;

        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "main-key".into(),
            token: "t".into(),
            session_id: "test-failover".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: format!("http://127.0.0.1:{}", fb_addr.port()),
                api_key: "fallback-key".into(),
                model: "".into(),
            }),
        };
        let resp = forward_messages(
            &state,
            json!({
                "model": "m",
                "max_tokens": 10,
                "stream": false,
                "messages": [{"role": "user", "content": "hi"}],
                "tools": [{"type": "custom", "name": "bash", "description": "d", "input_schema": {"type": "object"}}]
            }),
        )
        .await;
        assert_eq!(resp.status(), hyper::StatusCode::OK);
        use http_body_util::BodyExt;
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let txt = String::from_utf8_lossy(&bytes);
        assert!(
            txt.contains("fallback-msg-1"),
            "expected response to come from fallback endpoint, got: {}",
            txt
        );
    }

    #[tokio::test]
    async fn forward_messages_5xx_passthrough_without_fallback() {
        // 无兜底配置：主端点 5xx 必须原样透传（不降级不吞错）。
        let main_addr = spawn_fake_http(502, "").await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-nofailover".into(),
            main_format: "anthropic".into(),
            fallback: None,
        };
        let resp = forward_messages(
            &state,
            json!({"model": "m", "stream": false, "messages": [{"role": "user", "content": "hi"}]}),
        )
        .await;
        assert_eq!(resp.status(), hyper::StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn forward_messages_main_2xx_no_failover() {
        // 主端点正常（200）→ 不降级，直接返回主端点响应。
        let main_addr = spawn_fake_http(
            200,
            r#"{"type":"message","id":"main-msg-1","model":"m","role":"assistant","content":[{"type":"text","text":"from main"}],"usage":{"input_tokens":1,"output_tokens":1}}"#,
        )
        .await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-mainok".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: "http://127.0.0.1:1".into(), // 不可达，但不应被请求
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let resp = forward_messages(
            &state,
            json!({"model": "m", "stream": false, "messages": [{"role": "user", "content": "hi"}]}),
        )
        .await;
        assert_eq!(resp.status(), hyper::StatusCode::OK);
        use http_body_util::BodyExt;
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&bytes).contains("main-msg-1"));
    }

    // ── 能力检测：is_tool_not_supported 纯函数 ──────────────────────────

    #[test]
    fn is_tool_not_supported_matches_anthropic_style() {
        assert!(is_tool_not_supported(
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"Unknown tool: web_search"}}"#
        ));
        assert!(is_tool_not_supported(
            400,
            r#"{"error":{"message":"This model does not support the web_search tool","type":"invalid_request_error"}}"#
        ));
    }

    #[test]
    fn is_tool_not_supported_matches_openai_compat() {
        // DeepSeek 风格：只有 message/code，type 缺失
        assert!(is_tool_not_supported(
            400,
            r#"{"error":{"message":"tool web_search not available","code":"tool_not_found"}}"#
        ));
        // 百炼风格：code=InvalidParameter
        assert!(is_tool_not_supported(
            400,
            r#"{"error":{"code":"InvalidParameter","message":"The tool web_search is not supported by this model","request_id":"r1"}}"#
        ));
        // error 为纯字符串
        assert!(is_tool_not_supported(400, r#"{"error":"tool web_search is not supported"}"#));
        // 非 JSON 纯文本
        assert!(is_tool_not_supported(400, "tool 'web_search' unknown"));
    }

    #[test]
    fn is_tool_not_supported_rejects_non_tool_errors() {
        // 模型不存在（无 tool 关键字）
        assert!(!is_tool_not_supported(
            400,
            r#"{"error":{"message":"model not found","type":"invalid_request_error"}}"#
        ));
        // 非 4xx（2xx/5xx）
        assert!(!is_tool_not_supported(200, r#"{"error":{"message":"tool x"}}"#));
        assert!(!is_tool_not_supported(500, r#"{"error":{"message":"tool x"}}"#));
        // 认证 / 限流 / 超时 / 端点形状
        assert!(!is_tool_not_supported(401, r#"{"error":{"message":"tool x"}}"#));
        assert!(!is_tool_not_supported(403, r#"{"error":{"message":"tool x"}}"#));
        assert!(!is_tool_not_supported(404, r#"{"error":{"message":"tool x"}}"#));
        assert!(!is_tool_not_supported(408, r#"{"error":{"message":"tool x"}}"#));
        assert!(!is_tool_not_supported(429, r#"{"error":{"message":"tool x"}}"#));
        // message 提到 tool 但错误类型是服务端故障（api_error）→ 不算能力缺失
        assert!(!is_tool_not_supported(
            400,
            r#"{"error":{"message":"internal tool processing failed","type":"api_error"}}"#
        ));
    }

    #[test]
    fn web_search_tools_only_extracts_only_web_tools() {
        let body = json!({
            "tools": [
                {"type": "web_search_20250305", "name": "web_search", "max_uses": 1},
                {"type": "custom", "name": "bash", "description": "d"}
            ],
            "server_tools": [{"type": "web_search", "name": "web_search"}]
        });
        let tools = web_search_tools_only(&body);
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().all(|t| is_web_search_tool(t)));
        assert!(web_search_tools_only(&json!({"tools": [{"type": "custom", "name": "bash"}]})).is_empty());
        assert!(web_search_tools_only(&json!({})).is_empty());
    }

    // ── 能力检测式路由（web_search 请求）───────────────────────────────

    #[tokio::test]
    async fn forward_messages_web_capable_uses_main_endpoint() {
        // 能力检测：主端点探测 2xx → 标记 Capable → web_search 请求直走主端点
        // （不再无条件分流到兜底；兜底端点不可达，若被命中会 502）。
        let main_addr = spawn_fake_http(
            200,
            r#"{"type":"message","id":"main-web-1","model":"m","role":"assistant","content":[{"type":"text","text":"searched"}],"usage":{"input_tokens":1,"output_tokens":1}}"#,
        )
        .await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-web-capable".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: "http://127.0.0.1:1".into(),
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let body = json!({
            "model": "m",
            "stream": false,
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
        });
        // 第一次：探测 2xx → Capable → 真实请求走主端点
        let resp = forward_messages(&state, body.clone()).await;
        assert_eq!(resp.status(), hyper::StatusCode::OK);
        use http_body_util::BodyExt;
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert!(
            String::from_utf8_lossy(&bytes).contains("main-web-1"),
            "capable main endpoint must serve web_search, got: {}",
            String::from_utf8_lossy(&bytes)
        );
        // 第二次：Capable 缓存命中，直接走主端点
        let resp2 = forward_messages(&state, body).await;
        assert_eq!(resp2.status(), hyper::StatusCode::OK);
        let bytes2 = resp2.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&bytes2).contains("main-web-1"));
    }

    #[tokio::test]
    async fn forward_messages_web_probe_tool_error_routes_to_fallback() {
        // 主端点探测返回「工具不支持」400 → 标记 Incapable → 请求转发兜底。
        let main_addr = spawn_fake_http(
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"Unknown tool: web_search"}}"#,
        )
        .await;
        let fb_addr = spawn_fake_http(
            200,
            r#"{"type":"message","id":"fallback-web-2","model":"m","role":"assistant","content":[{"type":"text","text":"searched"}],"usage":{"input_tokens":1,"output_tokens":1}}"#,
        )
        .await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-web-incapable".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: format!("http://127.0.0.1:{}", fb_addr.port()),
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let body = json!({
            "model": "m",
            "stream": false,
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
        });
        let resp = forward_messages(&state, body.clone()).await;
        assert_eq!(resp.status(), hyper::StatusCode::OK);
        use http_body_util::BodyExt;
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        assert!(
            String::from_utf8_lossy(&bytes).contains("fallback-web-2"),
            "incapable main must route web_search to fallback, got: {}",
            String::from_utf8_lossy(&bytes)
        );
        // 第二次：Incapable 缓存命中，直接走兜底
        let resp2 = forward_messages(&state, body).await;
        assert_eq!(resp2.status(), hyper::StatusCode::OK);
        let bytes2 = resp2.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&bytes2).contains("fallback-web-2"));
    }

    #[tokio::test]
    async fn forward_messages_web_probe_5xx_stays_unknown_and_fallbacks() {
        // 主端点探测 5xx（服务故障，非能力缺失）→ 保持 Unknown，按旧行为走兜底；
        // 冷却期内不重复探测，后续请求同样直接走兜底。
        let main_addr = spawn_fake_http(500, "boom").await;
        let fb_addr = spawn_fake_http(
            200,
            r#"{"type":"message","id":"fallback-web-3","model":"m","role":"assistant","content":[{"type":"text","text":"searched"}],"usage":{"input_tokens":1,"output_tokens":1}}"#,
        )
        .await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-web-unknown".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: format!("http://127.0.0.1:{}", fb_addr.port()),
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let body = json!({
            "model": "m",
            "stream": false,
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
        });
        for _ in 0..2 {
            let resp = forward_messages(&state, body.clone()).await;
            assert_eq!(resp.status(), hyper::StatusCode::OK);
            use http_body_util::BodyExt;
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            assert!(
                String::from_utf8_lossy(&bytes).contains("fallback-web-3"),
                "5xx probe must keep fallback routing, got: {}",
                String::from_utf8_lossy(&bytes)
            );
        }
    }

    // ── 修复 1：Capable 后真实请求 4xx → 状态机回退 + 转兜底重发 ────────

    const MAIN_OK_ANTHROPIC: &str = r#"{"type":"message","id":"main-web-4xx","model":"m","role":"assistant","content":[{"type":"text","text":"from main"}],"usage":{"input_tokens":1,"output_tokens":1}}"#;
    const FALLBACK_OK_ANTHROPIC: &str = r#"{"type":"message","id":"fallback-web-4xx","model":"m","role":"assistant","content":[{"type":"text","text":"from fallback"}],"usage":{"input_tokens":1,"output_tokens":1}}"#;
    // 非工具不支持类 400：参数/内容校验（tool_result 格式）——真实请求的典型
    // 拒绝形态，message 提到 tool 但无能力缺失语义。
    const REAL_400_SCHEMA: &str = r#"{"type":"error","error":{"type":"invalid_request_error","message":"Invalid value for 'messages[1].content[0].tool_result'.content: must be a string"}}"#;
    // 工具不支持类 400。
    const REAL_400_TOOL: &str = r#"{"type":"error","error":{"type":"invalid_request_error","message":"The web_search tool is not supported by this model"}}"#;

    #[tokio::test]
    async fn forward_messages_web_real_4xx_falls_back_and_marks_unknown() {
        // 主端点探测 2xx → Capable，但真实请求被 400 拒绝（非工具不支持，
        // 如 tool_result 内容校验）→ 状态回退 Unknown（冷却重探）+ 转兜底重发；
        // 冷却期内后续请求直接走兜底，不再打主端点。
        let (main_addr, main_count) = spawn_fake_http_seq(&[
            (200, MAIN_OK_ANTHROPIC, 0), // 探测
            (400, REAL_400_SCHEMA, 0),   // 第一次真实请求
            (400, REAL_400_SCHEMA, 0),
        ])
        .await;
        let fb_addr = spawn_fake_http(200, FALLBACK_OK_ANTHROPIC).await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-web-4xx-unknown".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: format!("http://127.0.0.1:{}", fb_addr.port()),
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let body = json!({
            "model": "m",
            "stream": false,
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
        });
        let resp = forward_messages(&state, body.clone()).await;
        assert_eq!(resp.status(), hyper::StatusCode::OK);
        assert!(
            response_body(resp).await.contains("fallback-web-4xx"),
            "real-request 4xx must fail over to fallback"
        );
        // 第二次：状态已回退 Unknown 且处于冷却期 → 直接走兜底（主端点不再被请求）
        let resp2 = forward_messages(&state, body).await;
        assert_eq!(resp2.status(), hyper::StatusCode::OK);
        assert!(response_body(resp2).await.contains("fallback-web-4xx"));
        assert_eq!(
            main_count.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "main endpoint must be hit exactly twice (probe + first real request)"
        );
    }

    #[tokio::test]
    async fn forward_messages_web_real_4xx_tool_error_marks_incapable() {
        // 真实请求 400 且判定为「工具不支持」→ 标记 Incapable（TTL 内不重探），
        // 后续请求直接走兜底。
        let (main_addr, main_count) = spawn_fake_http_seq(&[
            (200, MAIN_OK_ANTHROPIC, 0), // 探测
            (400, REAL_400_TOOL, 0),     // 第一次真实请求
            (400, REAL_400_TOOL, 0),
        ])
        .await;
        let fb_addr = spawn_fake_http(200, FALLBACK_OK_ANTHROPIC).await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-web-4xx-incapable".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: format!("http://127.0.0.1:{}", fb_addr.port()),
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let body = json!({
            "model": "m",
            "stream": false,
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
        });
        let resp = forward_messages(&state, body.clone()).await;
        assert_eq!(resp.status(), hyper::StatusCode::OK);
        assert!(response_body(resp).await.contains("fallback-web-4xx"));
        // 第二次：Incapable 缓存命中 → 直接走兜底，不重探不重发
        let resp2 = forward_messages(&state, body).await;
        assert_eq!(resp2.status(), hyper::StatusCode::OK);
        assert!(response_body(resp2).await.contains("fallback-web-4xx"));
        assert_eq!(
            main_count.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "main endpoint must be hit exactly twice (probe + first real request)"
        );
    }

    // ── 修复 2：openai 格式主端点跳过能力检测，恒走兜底 ──────────────────

    const MAIN_OK_OPENAI: &str = r#"{"id":"chatcmpl-main","model":"m","choices":[{"message":{"role":"assistant","content":"from main openai"},"finish_reason":"stop"}]}"#;

    #[tokio::test]
    async fn forward_messages_web_openai_format_always_fallback() {
        // main_format=openai：能力探测语义无效（web_search 转成普通 function
        // 发给 /chat/completions，任何健康端点都 2xx，不证明能执行搜索）——
        // 跳过检测恒走兜底，且不向主端点发任何请求（含探测）。
        let (main_addr, main_count) = spawn_fake_http_seq(&[(200, MAIN_OK_OPENAI, 0)]).await;
        let fb_addr = spawn_fake_http(200, FALLBACK_OK_ANTHROPIC).await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-web-openai-format".into(),
            main_format: "openai".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: format!("http://127.0.0.1:{}", fb_addr.port()),
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let body = json!({
            "model": "m",
            "stream": false,
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
        });
        for _ in 0..2 {
            let resp = forward_messages(&state, body.clone()).await;
            assert_eq!(resp.status(), hyper::StatusCode::OK);
            assert!(
                response_body(resp).await.contains("fallback-web-4xx"),
                "openai main format must always route web_search to fallback"
            );
        }
        assert_eq!(
            main_count.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "openai main endpoint must not be probed or hit"
        );
    }

    // ── 修复 3：并发探测 single-flight ──────────────────────────────────

    #[tokio::test]
    async fn forward_messages_web_concurrent_probe_single_flight() {
        // 同 key 两个并发 Unknown 请求：只探测一次（探测慢 300ms），另一请求
        // 直接走兜底；主端点总共只收到 2 个请求（1 次探测 + 1 次真实请求），
        // 不会出现双探测重复计费 / 慢探测覆盖快探测结论。
        let (main_addr, main_count) = spawn_fake_http_seq(&[
            (200, MAIN_OK_ANTHROPIC, 300), // 探测（慢）
            (200, MAIN_OK_ANTHROPIC, 0),   // 探测成功者的真实请求
            (200, MAIN_OK_ANTHROPIC, 0),
        ])
        .await;
        let fb_addr = spawn_fake_http(200, FALLBACK_OK_ANTHROPIC).await;
        let state = ProxyState {
            target_url: format!("http://127.0.0.1:{}", main_addr.port()),
            api_key: "k".into(),
            token: "t".into(),
            session_id: "test-web-singleflight".into(),
            main_format: "anthropic".into(),
            fallback: Some(WebSearchFallbackConfig {
                base_url: format!("http://127.0.0.1:{}", fb_addr.port()),
                api_key: "fk".into(),
                model: "".into(),
            }),
        };
        let body = json!({
            "model": "m",
            "stream": false,
            "messages": [{"role": "user", "content": "search"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
        });
        let (r1, r2) = tokio::join!(
            forward_messages(&state, body.clone()),
            forward_messages(&state, body.clone()),
        );
        let t1 = response_body(r1).await;
        let t2 = response_body(r2).await;
        assert_eq!(t1.contains("main-web-4xx"), t2.contains("fallback-web-4xx"),
            "exactly one concurrent request must be served by main, the other by fallback: main={} fallback={}", t1, t2);
        assert_eq!(
            main_count.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "concurrent Unknown requests must trigger exactly one probe + one real request"
        );
    }

    // ── 修复 4：402 排除 + 判定收紧 + Incapable TTL ──────────────────────

    #[test]
    fn is_tool_not_supported_rejects_402_and_param_schema_errors() {
        // 欠费 402：即使 message 提到 tool 也不是「工具不支持」
        assert!(!is_tool_not_supported(
            402,
            r#"{"error":{"message":"Insufficient balance for tool web_search","type":"invalid_request_error"}}"#
        ));
        // 参数校验错误（tools[0].function.description）：提到 tool 但不是能力缺失
        assert!(!is_tool_not_supported(
            400,
            r#"{"error":{"type":"invalid_request_error","message":"Invalid value for 'tools[0].function.description': must be a string"}}"#
        ));
        // type=invalid_request_error + message 提到 tool 但无能力语义 → 不判定
        assert!(!is_tool_not_supported(
            400,
            r#"{"error":{"message":"The tools parameter is malformed","type":"invalid_request_error"}}"#
        ));
        // 明确语义仍命中（回归保护）
        assert!(is_tool_not_supported(
            400,
            r#"{"error":{"message":"tool web_search is not supported"}}"#
        ));
        assert!(is_tool_not_supported(
            400,
            r#"{"error":{"message":"tool 'web_search' not available","code":"tool_not_found"}}"#
        ));
        assert!(is_tool_not_supported(400, "tool 'web_search' unknown"));
    }

    #[test]
    fn incapable_ttl_expires_back_to_unknown() {
        let key = "incapable-ttl-test|m";
        mark_capability(key, WebSearchCapability::Incapable);
        let (cap, due) = capability_of(key);
        assert_eq!(cap, WebSearchCapability::Incapable);
        assert!(!due);
        // 模拟 TTL 过期：把 incapable_since 拨回 30 分钟前 → 惰性回退 Unknown 重探
        {
            let mut st = CAPABILITY_STATE.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(e) = st.get_mut(key) {
                e.incapable_since = Some(
                    std::time::Instant::now() - INCAPABLE_TTL - std::time::Duration::from_secs(1),
                );
            }
        }
        let (cap, due) = capability_of(key);
        assert_eq!(cap, WebSearchCapability::Unknown);
        assert!(due);
        // 重新标记 Incapable → TTL 重置，不再重探
        mark_capability(key, WebSearchCapability::Incapable);
        let (cap, due) = capability_of(key);
        assert_eq!(cap, WebSearchCapability::Incapable);
        assert!(!due);
        // Capable 后不再受 TTL 影响
        mark_capability(key, WebSearchCapability::Capable);
        let (cap, due) = capability_of(key);
        assert_eq!(cap, WebSearchCapability::Capable);
        assert!(!due);
    }
}
