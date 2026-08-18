//! 面试模块 Tauri 命令。
//!
//! 多模态直连模式：WASAPI/Mic 音频采集 → 前端累积 → 合并 WAV
//! → 发送到多模态 API → 返回答案。无需本地 ASR 引擎。

use std::collections::HashMap;
use tauri::Emitter;

use super::system_audio::{self, SystemAudioChunk};

// ── System audio raw state (mimo passthrough, no ASR engine) ──
static SYS_AUDIO_RAW: tokio::sync::Mutex<Option<(
    tokio::sync::oneshot::Sender<()>,
    system_audio::SystemAudioHandle,
)>> = tokio::sync::Mutex::const_new(None);

// ── Cached HTTP client for mimo API (reuses TLS + keep-alive across questions) ──
static MIMO_CLIENTS: tokio::sync::Mutex<Option<HashMap<String, reqwest::Client>>> =
    tokio::sync::Mutex::const_new(None);

/// M4 (security, shared): resolve the API key from a renderer-controlled env
/// variable name. The value gets shipped as a Bearer token to a
/// renderer-controlled URL — an arbitrary name is a confused-deputy
/// env-exfiltration primitive. Restrict to plausible API-key variable names
/// and exclude credential-ish ones. Both interview_mimo_answer and
/// interview_test_mimo MUST go through this (R1: the test command used to
/// skip it entirely).
fn resolve_api_key(env_name: Option<&str>, fallback: String) -> Result<String, String> {
    let Some(env_name) = env_name.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return Ok(fallback);
    };
    let shape_ok = env_name.len() <= 64
        && env_name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && env_name
            .chars()
            .next()
            .map(|c| c.is_ascii_uppercase())
            .unwrap_or(false)
        && (env_name.ends_with("_API_KEY")
            || env_name.ends_with("_TOKEN")
            || env_name.ends_with("_KEY"));
    let upper = env_name.to_uppercase();
    let excluded = ["AWS", "SECRET", "PASSWORD", "PRIVATE", "PATH", "CREDENTIAL"];
    let excluded_hit = excluded.iter().any(|banned| upper.contains(banned));
    if shape_ok && !excluded_hit {
        Ok(std::env::var(env_name).unwrap_or(fallback))
    } else {
        Err(format!(
            "环境变量名不符合 API key 命名要求（仅允许 *_API_KEY/*_TOKEN/*_KEY）: {}",
            env_name
        ))
    }
}

async fn get_mimo_client(base_url: &str, proxy_url: Option<&str>) -> reqwest::Client {
    let key = format!("{}|{}", base_url, proxy_url.unwrap_or(""));
    // Fast path: cached client with matching key
    {
        let guard = MIMO_CLIENTS.lock().await;
        if let Some(map) = guard.as_ref() {
            if let Some(client) = map.get(&key) {
                return client.clone();
            }
        }
    }
    // Build new client with proxy support.
    // R15 (bug): NO total-request timeout here — reqwest's `timeout` covers
    // the whole body read, so a streaming answer longer than the old 30s cap
    // was killed mid-sentence. Long streams are instead guarded by a
    // per-chunk watchdog in the consumer (120s without a new chunk).
    const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    let builder = || reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT);
    let client = match proxy_url.filter(|p| !p.is_empty()) {
        Some(purl) => match reqwest::Proxy::all(purl) {
            Ok(proxy) if crate::is_proxy_reachable(purl).await => builder()
                .no_proxy()
                .proxy(proxy)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            _ => builder().build().unwrap_or_else(|_| reqwest::Client::new()),
        },
        None => builder().build().unwrap_or_else(|_| reqwest::Client::new()),
    };
    // Cache it
    let mut guard = MIMO_CLIENTS.lock().await;
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(key, client.clone());
    drop(guard);
    client
}

// ── Commands ──

/// 启动系统音频采集（WASAPI loopback, 无需 ASR 引擎）。
/// 与 interview_start_system_audio 不同：不进行 whisper 转写，
/// 只将每个 chunk 的 peak + wavBase64 发送到前端。用于 mimo 多模态直连模式。
#[tauri::command]
pub async fn interview_start_system_audio_raw(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // channel 8：local ASR 推理期间（几百 ms~数秒）前端 push 命令被占用时，
    // 采集线程还能继续投递 ~6.4s 音频（800ms × 8）而不丢 chunk。
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<SystemAudioChunk>(8);
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    // 启动 WASAPI（chunk 以内存 WAV 字节经 channel 直传，不落盘）
    let handle = system_audio::start_system_audio_capture(
        chunk_tx, app_handle.clone(), "mimo".to_string(),
    ).map_err(|e| format!("系统音频启动失败: {e}"))?;

    // 存储 cancel_tx 和 handle，以便 stop 命令可以停止采集
    let mut guard = SYS_AUDIO_RAW.lock().await;
    *guard = Some((cancel_tx, handle));
    drop(guard);

    // 后台处理：读取 WAV → base64 → 发送事件（无转写）
    let sid = "mimo-direct".to_string();
    tokio::spawn(async move {
        log::info!("[sys_audio_raw] passthrough task started");
        loop {
            tokio::select! {
                chunk = chunk_rx.recv() => {
                    let chunk = match chunk {
                        Some(c) => c,
                        None => break,
                    };
                    let _ = app_handle.emit("interview:system-audio-chunk", serde_json::json!({
                        "sessionId": sid,
                        "chunkId": chunk.chunk_id,
                    }));

                    let wav_base64 = {
                        use base64::Engine as _;
                        Some(base64::engine::general_purpose::STANDARD.encode(&chunk.wav_bytes))
                    };

                    let _ = app_handle.emit("interview:system-audio-result", serde_json::json!({
                        "sessionId": sid,
                        "chunkId": chunk.chunk_id,
                        "transcript": "",
                        "peak": chunk.peak,
                        "wavBase64": wav_base64,
                    }));
                }
                _ = &mut cancel_rx => {
                    log::info!("[sys_audio_raw] cancel received, exiting task");
                    break;
                }
            }
        }
        log::info!("[sys_audio_raw] passthrough task ended");
    });

    Ok(())
}

/// 停止系统音频 raw 采集。
#[tauri::command]
pub async fn interview_stop_system_audio_raw() -> Result<(), String> {
    let (cancel_tx, mut handle) = {
        let mut guard = SYS_AUDIO_RAW.lock().await;
        guard.take().ok_or("没有正在运行的系统音频采集".to_string())?
    };
    let _ = cancel_tx.send(());
    handle.stop();
    log::info!("[sys_audio_raw] stopped and cleaned up");
    Ok(())
}

/// mimo 多模态 API 直连回答（两段式：ASR 转写 → 文本回答）。
///
/// 第一跳 ASR：整段 WAV 发给 `asr_model`（mimo-v2.5-asr）转写出问题文本。
///   网关禁止携带 text part（提示词由网关注入），content 只能含音频；
///   不开 stream（ASR 回复短，一次性读更稳）。转写成功后经
///   `interview:mimo-question` 事件把问题文本推给前端，替换
///   "🔊 语音问题" 占位。
/// 第二跳回答：问题文本 + system 提示发给 `model`（mimo-v2.5-pro，纯文本
///   推理模型）求答。该端点不接受音频（input_audio → 404，2026-07-28
///   实测），故必须拆两段。
///
/// 性能优化：
/// - 第二跳 `stream: true`，SSE 增量 emit `interview:mimo-token`，前端逐字渲染；
/// - 自适应：端点未返回 `text/event-stream` 时回退整段解析（invoke 返回值兜底）；
/// - 大字符串 audio_base64 经索引赋值移动进 ASR body，避开 json! 内部 clone；
/// - 全链路打点：`[mimo-perf]` 记录 client_ready、asr_done、answer_headers、
///   first_body_chunk、stream_done、total。
///
/// `app` 由 Tauri 自动注入（前端 invoke 不传），仅用于 emit 事件。
/// 任何失败返回 Err，前端负责展示错误并降级提示。
#[tauri::command]
pub async fn interview_mimo_answer(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    api_key_env: Option<String>,
    model: String,
    asr_model: String,
    audio_base64: String,
    prompt_text: Option<String>,
    proxy_url: Option<String>,
    // B2: true = audio + prompt in one API call (no separate ASR step).
    is_single_hop: Option<bool>,
    // B2: Custom answer system prompt (overrides hardcoded default).
    answer_prompt: Option<String>,
    // B2: Answer max_tokens (default 512).
    max_tokens: Option<u32>,
    // B2: Answer temperature (default 0).
    temperature: Option<f64>,
    // 本地 ASR 旁路：不为空时跳过 ASR 步，直接用此文本作为问题
    question_text: Option<String>,
) -> Result<String, String> {
    let t0 = std::time::Instant::now();
    let request_id = uuid::Uuid::new_v4().to_string();
    let audio_b64_chars = audio_base64.len();
    let is_single_hop = is_single_hop.unwrap_or(false);
    let max_tokens = max_tokens.unwrap_or(512);
    let temperature = temperature.unwrap_or(0.0);

    // 解析 API key: 优先环境变量名，再 fallback 到明文 key（M4 共享校验）。
    let api_key = resolve_api_key(api_key_env.as_deref(), api_key)?;

    let client = get_mimo_client(&base_url, proxy_url.as_deref()).await;
    log::info!(
        "[mimo-perf] rid={} client_ready +{}ms",
        request_id,
        t0.elapsed().as_millis()
    );

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    // 解析 prompt：优先 B2 自定义 prompt → 原有 prompt_text → 硬编码默认值
    let prompt = answer_prompt.or(prompt_text).unwrap_or_else(|| {
        "你是一个面试助手。针对以下中文面试问题，用中文给出简洁清晰的答案（100字以内，适合口头作答）。".to_string()
    });

    let body: serde_json::Value;

    // ── 文本旁路：本地 ASR 已识别出问题 → 跳过音频 ASR，直接调用 Pro 模型 ──
    if let Some(ref q) = question_text {
        let q = q.trim();
        if q.is_empty() {
            return Err("question_text is empty".to_string());
        }
        log::info!(
            "[mimo-perf] rid={} text_only question_chars={}",
            request_id,
            q.len()
        );
        let _ = app.emit(
            "interview:mimo-question",
            serde_json::json!({ "requestId": &request_id, "text": q }),
        );
        body = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": true,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": q}
            ]
        });
    } else if is_single_hop {
        // ── 单跳模式：音频 + prompt 在一次请求中完成（无需单独 ASR 步骤）──
        // 适用于 gpt-4o-audio-preview 等原生多模态模型。
        // prompt 作为 text part 与音频一起放在 user message 中。
        log::info!(
            "[mimo-perf] rid={} single_hop mode audio_b64_chars={}",
            request_id,
            audio_b64_chars,
        );
        // 单跳模式下不提取问题文本，emit 空问题通知（前端不用它显示问题）
        let _ = app.emit(
            "interview:mimo-question",
            serde_json::json!({ "requestId": &request_id, "text": "" }),
        );

        let user_text = format!("{}\n\n请先转写音频中的面试问题，然后用中文给出简洁清晰的答案（100字以内，适合口头作答）。", prompt);
        let mut b = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": true,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_audio", "input_audio": {"data": "", "format": "wav"}},
                        {"type": "text", "text": user_text}
                    ]
                }
            ]
        });
        b["messages"][0]["content"][0]["input_audio"]["data"] =
            serde_json::Value::String(audio_base64);
        body = b;
    } else {
        // ── 两跳模式：ASR 转写 → 文本回答（现有 mimo 方案）──
        let t_asr = std::time::Instant::now();
        let mut asr_body = serde_json::json!({
            "model": asr_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_audio", "input_audio": {"data": "", "format": "wav"}}
                    ]
                }
            ]
        });
        asr_body["messages"][0]["content"][0]["input_audio"]["data"] =
            serde_json::Value::String(audio_base64);

        let asr_resp = client
            .post(&url)
            .bearer_auth(&api_key)
            .json(&asr_body)
            .send()
            .await
            .map_err(|e| format!("ASR 请求失败: {e}"))?;
        let asr_status = asr_resp.status();
        if !asr_status.is_success() {
            let body_text = asr_resp.text().await.unwrap_or_default();
            return Err(format!("ASR HTTP {asr_status}: {body_text}"));
        }
        let asr_json: serde_json::Value = asr_resp
            .json()
            .await
            .map_err(|e| format!("解析 ASR 响应失败: {e}"))?;
        let question = asr_json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        log::info!(
            "[mimo-perf] rid={} asr_done +{}ms (asr {}ms) audio_b64_chars={} question_chars={}",
            request_id,
            t0.elapsed().as_millis(),
            t_asr.elapsed().as_millis(),
            audio_b64_chars,
            question.len()
        );
        if question.is_empty() {
            return Err("未能从音频中识别到有效的面试问题".to_string());
        }
        let _ = app.emit(
            "interview:mimo-question",
            serde_json::json!({ "requestId": &request_id, "text": &question }),
        );

        body = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": true,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": question}
            ]
        });
    }

    let t_send = std::time::Instant::now();
    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("API 请求失败: {e}"))?;
    let status = resp.status();
    log::info!(
        "[mimo-perf] rid={} answer_headers +{}ms (send {}ms) status={}",
        request_id,
        t0.elapsed().as_millis(),
        t_send.elapsed().as_millis(),
        status
    );

    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        // Some upstreams echo the Authorization header back in error bodies.
        let body_text = crate::commands::anthropic_proxy::redact_secrets(&body_text);
        return Err(format!("HTTP {status}: {body_text}"));
    }

    // 按 content-type 分流：event-stream 走流式，否则走整段（兼容不支持 stream 的端点）
    let is_sse = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("text/event-stream"))
        .unwrap_or(false);

    let text = if is_sse {
        // ── 流式分支：逐 chunk 累积，按行解析 SSE，增量 emit token ──
        // R4 (bug): accumulate BYTES and split on b'\n' — the old path ran
        // from_utf8_lossy on each raw chunk, and TLS record boundaries can
        // land mid-codepoint, turning every split CJK character into U+FFFD
        // garbage in the streamed answer. Only complete lines get decoded.
        // R15: per-chunk watchdog replaces the old 30s whole-request timeout
        // (which killed long streaming answers mid-sentence).
        const CHUNK_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(120);
        let mut resp = resp;
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut full_text = String::new();
        let mut first_chunk = true;
        loop {
            let chunk = tokio::time::timeout(CHUNK_WATCHDOG, resp.chunk())
                .await
                .map_err(|_| "读取流超时（120s 无新数据）".to_string())?
                .map_err(|e| format!("读取流失败: {e}"))?;
            let bytes = match chunk {
                Some(b) => b,
                None => break,
            };
            if first_chunk {
                first_chunk = false;
                log::info!(
                    "[mimo-perf] rid={} first_body_chunk +{}ms",
                    request_id,
                    t0.elapsed().as_millis()
                );
            }
            byte_buf.extend_from_slice(&bytes);
            // 消费所有完整行（字节层切分，行内才做 UTF-8 解码）
            while let Some(nl) = byte_buf.iter().position(|&b| b == b'\n') {
                let line_bytes: Vec<u8> = byte_buf.drain(..=nl).collect();
                let line = String::from_utf8(line_bytes)
                    .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
                let line = line.trim().to_string();
                if let Some(delta) = parse_sse_data_line(&line) {
                    full_text.push_str(&delta);
                    let _ = app.emit(
                        "interview:mimo-token",
                        serde_json::json!({ "requestId": &request_id, "delta": delta }),
                    );
                }
            }
        }
        // 残留的无尾换行最后一行
        if !byte_buf.is_empty() {
            let tail = String::from_utf8(byte_buf)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
            let tail = tail.trim().to_string();
            if !tail.is_empty() {
                if let Some(delta) = parse_sse_data_line(&tail) {
                    full_text.push_str(&delta);
                    let _ = app.emit(
                        "interview:mimo-token",
                        serde_json::json!({ "requestId": &request_id, "delta": delta }),
                    );
                }
            }
        }
        log::info!(
            "[mimo-perf] rid={} stream_done +{}ms answer_chars={}",
            request_id,
            t0.elapsed().as_millis(),
            full_text.len()
        );
        full_text.trim().to_string()
    } else {
        // ── 整段分支：端点未走 SSE，一次性解析（前端用 invoke 返回值渲染）──
        let body_text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
        log::info!(
            "[mimo-perf] rid={} body_complete(non-sse) +{}ms body_chars={}",
            request_id,
            t0.elapsed().as_millis(),
            body_text.len()
        );
        let json: serde_json::Value =
            serde_json::from_str(&body_text).map_err(|e| format!("解析响应失败: {e}"))?;
        json.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };

    log::info!(
        "[mimo-perf] rid={} total +{}ms",
        request_id,
        t0.elapsed().as_millis()
    );

    if text.is_empty() {
        return Err("API 返回空答案".to_string());
    }
    Ok(text)
}

/// 解析一行 SSE `data: {...}`，返回其中 `choices[0].delta.content`（非空时）。
/// 非 `data:` 行、空行、`[DONE]`、JSON 解析失败、无 delta 均返回 None。
fn parse_sse_data_line(line: &str) -> Option<String> {
    let data = line.strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    let delta = v
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()?;
    if delta.is_empty() {
        None
    } else {
        Some(delta.to_string())
    }
}

/// 连接预热：进入面试模式时调用，只建立 TCP/TLS，零计费。
///
/// mimo client 虽有缓存，但第一题仍要付一次冷 TLS 握手（几百 ms）。
/// 向 base_url 发一个轻量 GET（接受任何状态码、静默失败），让连接进入
/// keep-alive 连接池，第一题即可复用热连接。不调用模型、不消耗 token。
#[tauri::command]
pub async fn interview_prewarm_connection(
    base_url: String,
    proxy_url: Option<String>,
) -> Result<(), String> {
    const PREWARM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
    let t0 = std::time::Instant::now();
    let client = get_mimo_client(&base_url, proxy_url.as_deref()).await;
    let url = base_url.trim_end_matches('/').to_string();
    match tokio::time::timeout(PREWARM_TIMEOUT, client.get(&url).send()).await {
        Ok(Ok(resp)) => log::info!(
            "[mimo-perf] prewarm done +{}ms status={} (connection pooled)",
            t0.elapsed().as_millis(),
            resp.status()
        ),
        Ok(Err(e)) => log::warn!("[mimo-perf] prewarm failed (ignored): {e}"),
        Err(_) => log::warn!("[mimo-perf] prewarm timeout after 5s (ignored)"),
    }
    Ok(())
}

/// 验证面试端点连通性和模型可用性（"测试连接" 按钮）。
///
/// 向 answer 模型发一条极短文本消息（不流式），验证端点和 API key 有效。
/// 两跳模式下还会验证 ASR 模型（发一段空白 WAV 确认模型存在且路由正确）。
/// 返回 JSON 包含各步耗时和状态，前端据此展示通过/失败。
#[tauri::command]
pub async fn interview_test_mimo(
    base_url: String,
    api_key: String,
    api_key_env: Option<String>,
    model: String,
    asr_model: String,
    is_single_hop: Option<bool>,
    proxy_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let is_single_hop = is_single_hop.unwrap_or(false);
    // R1 (security): same M4 gate as interview_mimo_answer — the test button
    // used to be an UNVALIDATED env-read + exfiltration primitive (arbitrary
    // env value shipped as Bearer to a renderer-controlled URL).
    let api_key = resolve_api_key(api_key_env.as_deref(), api_key)?;

    let client = get_mimo_client(&base_url, proxy_url.as_deref()).await;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut results = serde_json::Map::new();

    // ── 测试 1: answer 模型（文本 → 文本，极短，不计费）──
    let t0 = std::time::Instant::now();
    let answer_body = serde_json::json!({
        "model": &model,
        "max_tokens": 1,
        "temperature": 0,
        "stream": false,
        "messages": [
            {"role": "user", "content": "Hi"}
        ]
    });
    match client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&answer_body)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            let elapsed_ms = t0.elapsed().as_millis() as u64;
            if status.is_success() {
                results.insert("answer".to_string(), serde_json::json!({
                    "ok": true,
                    "model": &model,
                    "latencyMs": elapsed_ms,
                    "status": status.as_u16(),
                }));
            } else {
                let body_text = resp.text().await.unwrap_or_default();
                let body_text = crate::commands::anthropic_proxy::redact_secrets(&body_text);
                results.insert("answer".to_string(), serde_json::json!({
                    "ok": false,
                    "model": &model,
                    "latencyMs": elapsed_ms,
                    "status": status.as_u16(),
                    "error": body_text.chars().take(200).collect::<String>(),
                }));
            }
        }
        Err(e) => {
            results.insert("answer".to_string(), serde_json::json!({
                "ok": false,
                "model": &model,
                "latencyMs": t0.elapsed().as_millis(),
                "error": e.to_string(),
            }));
        }
    }

    // ── 测试 2: ASR 模型（仅两跳模式，发一段最小合法 WAV 验证路由）──
    if !is_single_hop && !asr_model.is_empty() {
        let t1 = std::time::Instant::now();
        let tiny_wav = tiny_silent_wav_base64();
        let mut asr_body = serde_json::json!({
            "model": &asr_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_audio", "input_audio": {"data": "", "format": "wav"}}
                    ]
                }
            ]
        });
        asr_body["messages"][0]["content"][0]["input_audio"]["data"] =
            serde_json::Value::String(tiny_wav);

        match client
            .post(&url)
            .bearer_auth(&api_key)
            .json(&asr_body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                let elapsed_ms = t1.elapsed().as_millis() as u64;
                if status.is_success() {
                    results.insert("asr".to_string(), serde_json::json!({
                        "ok": true,
                        "model": &asr_model,
                        "latencyMs": elapsed_ms,
                        "status": status.as_u16(),
                    }));
                } else {
                    let body_text = resp.text().await.unwrap_or_default();
                    let body_text = crate::commands::anthropic_proxy::redact_secrets(&body_text);
                    results.insert("asr".to_string(), serde_json::json!({
                        "ok": false,
                        "model": &asr_model,
                        "latencyMs": elapsed_ms,
                        "status": status.as_u16(),
                        "error": body_text.chars().take(200).collect::<String>(),
                    }));
                }
            }
            Err(e) => {
                results.insert("asr".to_string(), serde_json::json!({
                    "ok": false,
                    "model": &asr_model,
                    "latencyMs": t1.elapsed().as_millis(),
                    "error": e.to_string(),
                }));
            }
        }
    }

    Ok(serde_json::Value::Object(results))
}

/// 生成一段最小合法 WAV 的 base64（静默，16-bit PCM, mono, 8000 Hz, ~0.25s）。
/// 用于测试 ASR 端点路由是否可用，不会触发实际转写。
fn tiny_silent_wav_base64() -> String {
    let sample_rate: u32 = 8000;
    let num_channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let num_samples: u32 = sample_rate / 4; // 0.25 秒
    let data_size: u32 = num_samples * (bits_per_sample as u32 / 8) * (num_channels as u32);
    let file_size: u32 = 36 + data_size;

    let mut wav = Vec::with_capacity(44 + data_size as usize);
    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * num_channels as u32 * (bits_per_sample / 8) as u32;
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = num_channels * (bits_per_sample / 8);
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    // silence samples (all zeros)
    wav.resize(44 + data_size as usize, 0u8);

    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(&wav)
}
