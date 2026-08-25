//! 真·流式音频进大模型 — OpenAI Realtime API 兼容 WebSocket 全双工后端。
//!
//! 目标端点：火山引擎豆包（官方文档 "使用 Realtime API 调用 Doubao"）等
//! OpenAI-Realtime 兼容实时语音端点。
//!
//! 数据流：
//! - 前端把 500ms WAV chunk 经 `interview_realtime_send_audio` 推入
//!   （Rust 侧解码 → 重采样 24kHz → pcm16 base64 → input_audio_buffer.append）；
//! - 模型边听边理解，服务端事件回传：
//!   - `interview:rt-transcript`  增量转写（delta partial / completed final）
//!   - `interview:rt-answer`      答案增量 delta
//!   - `interview:rt-answer-done` 答案完成（最终文本）
//!   - `interview:rt-status`      会话状态（connecting/ready/answered/closed）
//!   - `interview:rt-error`       错误
//! - 模型调用 `web_search` 工具时由本模块执行（复用 search::web_search_inner），
//!   结果以 function_call_output 回填并续答 —— 模型边听边搜的完整闭环。

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;

/// 实时会话句柄：发送通道 + 后台任务
struct RealtimeSession {
    tx: tokio::sync::mpsc::Sender<String>,
    cancel: tokio::sync::watch::Sender<bool>,
    join: tokio::task::JoinHandle<()>,
}

static RT_SESSION: tokio::sync::Mutex<Option<RealtimeSession>> = tokio::sync::Mutex::const_new(None);

/// A tool call is executed outside the WebSocket loop so audio and cancellation
/// remain responsive while a provider-side search is in flight.
struct SearchResult {
    call_id: String,
    output: String,
}

/// 搜索配置（模型工具调用 web_search 时使用）
#[derive(Clone, Default)]
struct SearchCfg {
    base_url: Option<String>,
    api_key: Option<String>,
    api_key_env: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
}

/// Minimal percent-encoding for URL query components (no extra dependency).
/// Unreserved characters (RFC 3986 §2.3) pass through; everything else is
/// encoded as %XX so model names with `/`, `:`, CJK, etc. are safe.
fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

/// 线性重采样 i16 PCM（Realtime API 默认输入 24kHz；前端采集 16kHz）
fn resample_i16(samples: &[i16], src_rate: u32, dst_rate: u32) -> Vec<i16> {    if samples.is_empty() || src_rate == 0 || dst_rate == 0 || src_rate == dst_rate {
        return samples.to_vec();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let dst_len = (samples.len() as f64 / ratio).ceil() as usize;
    let mut out = Vec::with_capacity(dst_len);
    let last = samples.len() - 1;
    for i in 0..dst_len {
        let pos = i as f64 * ratio;
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(last);
        let frac = (pos - i0 as f64) as f32;
        out.push((samples[i0] as f32 * (1.0 - frac) + samples[i1] as f32 * frac).round() as i16);
    }
    out
}

/// 启动实时语音会话（全双工 WebSocket）。
///
/// 参数含搜索配置：模型调用 web_search 工具时由服务端（本模块）执行并回填。
#[tauri::command]
pub async fn interview_realtime_start(
    app: tauri::AppHandle,
    ws_url: String,
    api_key: Option<String>,
    api_key_env: Option<String>,
    model: Option<String>,
    transcription_model: Option<String>,
    instructions: Option<String>,
    search_base_url: Option<String>,
    search_api_key: Option<String>,
    search_api_key_env: Option<String>,
    search_model: Option<String>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    // 先停掉旧会话
    let _ = stop_inner().await;

    let api_key =
        super::commands::resolve_api_key(api_key_env.as_deref(), api_key.unwrap_or_default())?;
    if api_key.is_empty() {
        return Err("未配置实时语音 API Key（请在 设置 > 面试助手 填写或指定环境变量）".to_string());
    }
    let ws_url = ws_url.trim().to_string();
    if ws_url.is_empty() {
        return Err("未配置实时语音 WebSocket 地址".to_string());
    }

    let model = model.filter(|s| !s.trim().is_empty());
    let transcribe_model = transcription_model
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "gpt-4o-mini-transcribe".to_string());
    let instructions = instructions
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            "你是一个面试助手。面试官会说话提问，你听到问题后用中文给出简洁清晰、适合口头作答的答案（100字以内）。必要时调用 web_search 搜索资料。"
                .to_string()
        });

    let search_cfg = SearchCfg {
        base_url: search_base_url,
        api_key: search_api_key,
        api_key_env: search_api_key_env,
        model: search_model,
        proxy_url,
    };

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let app2 = app.clone();
    let join = tokio::spawn(async move {
        match run_session(
            app2.clone(),
            ws_url,
            api_key,
            model,
            transcribe_model,
            instructions,
            search_cfg,
            &mut rx,
            cancel_rx,
        )
        .await
        {
            Ok(()) => {}
            Err(e) => {
                log::warn!("[interview:rt] session ended with error: {}", e);
                let _ = app2.emit(
                    "interview:rt-error",
                    serde_json::json!({ "message": e }),
                );
                let _ = app2.emit(
                    "interview:rt-status",
                    serde_json::json!({ "status": "closed" }),
                );
            }
        }
    });

    *RT_SESSION.lock().await = Some(RealtimeSession {
        tx,
        cancel: cancel_tx,
        join,
    });
    Ok("realtime session started".to_string())
}

/// 主会话循环：发送 session.update → 双工收发。
async fn run_session(
    app: tauri::AppHandle,
    ws_url: String,
    api_key: String,
    model: Option<String>,
    transcribe_model: String,
    instructions: String,
    search_cfg: SearchCfg,
    rx: &mut tokio::sync::mpsc::Receiver<String>,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    // Keep credentials in the Authorization header. Query-string keys can leak
    // through proxy, handshake, and diagnostic logs. Providers that require a
    // query token must be configured with that token already present in ws_url.
    let mut url = ws_url;
    if let Some(m) = model {
        if !url.contains("model=") {
            let sep = if url.contains('?') { '&' } else { '?' };
            let encoded = percent_encode_component(&m);
            url.push_str(&format!("{}model={}", sep, encoded));
        }
    }

    let mut request = url
        .into_client_request()
        .map_err(|e| format!("WS 请求构造失败: {e}"))?;
    request.headers_mut().insert(
        http::header::AUTHORIZATION,
        format!("Bearer {}", api_key)
            .parse()
            .map_err(|e| format!("鉴权头构造失败: {e}"))?,
    );

    let _ = app.emit(
        "interview:rt-status",
        serde_json::json!({ "status": "connecting" }),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("WS 连接失败: {e}"))?;

    // 会话初始化：文本模态（提词面板显示文字答案）+ 服务端 VAD + 增量转写 + 工具
    let session = serde_json::json!({
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "instructions": instructions,
            "input_audio_format": "pcm16",
            "input_audio_transcription": {
                "model": transcribe_model
            },
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.5,
                "prefix_padding_ms": 300,
                "silence_duration_ms": 500
            },
            "tools": [
                {
                    "type": "function",
                    "name": "web_search",
                    "description": "联网搜索面试问题相关资料，获取最新事实与数据",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "搜索关键词（面试问题原文或关键词）"
                            }
                        },
                        "required": ["query"]
                    }
                }
            ],
            "temperature": 0.3
        }
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        session.to_string().into(),
    ))
    .await
    .map_err(|e| format!("session.update 发送失败: {e}"))?;
    ws.flush().await.map_err(|e| format!("WS flush 失败: {e}"))?;

    // 工具调用在独立任务中执行：主循环保持响应音频推送与取消，
    // 结果经 channel 回流后在循环内回填（B1 修复：不再阻塞 select）。
    let (search_tx, mut search_rx) = tokio::sync::mpsc::channel::<SearchResult>(8);
    let mut search_running = false;

    loop {
        // cancel_rx 变化优先级高于其他分支（select 偏置），保证 stop 立即生效
        tokio::select! {
            biased;
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    break;
                }
            }
            msg = rx.recv() => {
                match msg {
                    Some(text) => {
                        // stop_inner 会塞一条空串用于唤醒本分支 —— 不转发
                        if text.is_empty() {
                            continue;
                        }
                        ws.send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
                            .await
                            .map_err(|e| format!("音频推送失败: {e}"))?;
                        ws.flush().await.map_err(|e| format!("WS flush 失败: {e}"))?;
                    }
                    None => break,
                }
            }
            result = search_rx.recv(), if search_running => {
                match result {
                    Some(sr) => {
                        search_running = false;
                        let item = serde_json::json!({
                            "type": "conversation.item.create",
                            "item": {
                                "type": "function_call_output",
                                "call_id": sr.call_id,
                                "output": sr.output
                            }
                        });
                        ws.send(tokio_tungstenite::tungstenite::Message::Text(
                            item.to_string().into(),
                        ))
                        .await
                        .map_err(|e| format!("工具回填发送失败: {e}"))?;
                        let cont = serde_json::json!({ "type": "response.create" });
                        ws.send(tokio_tungstenite::tungstenite::Message::Text(
                            cont.to_string().into(),
                        ))
                        .await
                        .map_err(|e| format!("续答发送失败: {e}"))?;
                        ws.flush().await.map_err(|e| format!("WS flush 失败: {e}"))?;
                    }
                    None => { search_running = false; }
                }
            }
            msg = ws.next() => {
                match msg {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        handle_server_event(&app, &text, &search_cfg, &search_tx, &mut search_running).await?;
                    }
                    Some(Ok(_)) => {} // ping/pong/binary 忽略
                    Some(Err(e)) => return Err(format!("WS 读错误: {e}")),
                    None => return Err("WS 连接已关闭".to_string()),
                }
            }
        }
    }

    let _ = app.emit(
        "interview:rt-status",
        serde_json::json!({ "status": "closed" }),
    );
    Ok(())
}

/// 处理服务端事件：转写增量、答案增量、工具调用（异步派发）、错误。
async fn handle_server_event(
    app: &tauri::AppHandle,
    text: &str,
    search_cfg: &SearchCfg,
    search_tx: &tokio::sync::mpsc::Sender<SearchResult>,
    search_running: &mut bool,
) -> Result<(), String> {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match ty {
        "session.created" => {
            let _ = app.emit(
                "interview:rt-status",
                serde_json::json!({ "status": "ready" }),
            );
        }
        "input_audio_buffer.speech_started" => {
            // 新问题开始：前端据此重置上一题答案
            let _ = app.emit(
                "interview:rt-status",
                serde_json::json!({ "status": "speech_started" }),
            );
        }
        "conversation.item.input_audio_transcription.delta" => {
            let delta = v.get("delta").and_then(|d| d.as_str()).unwrap_or("");
            if !delta.is_empty() {
                let _ = app.emit(
                    "interview:rt-transcript",
                    serde_json::json!({ "delta": delta, "isFinal": false }),
                );
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            let t = v
                .get("transcript")
                .and_then(|d| d.as_str())
                .unwrap_or("");
            if !t.is_empty() {
                let _ = app.emit(
                    "interview:rt-transcript",
                    serde_json::json!({ "delta": t, "isFinal": true }),
                );
            }
        }
        "response.audio_transcript.delta" => {
            let delta = v.get("delta").and_then(|d| d.as_str()).unwrap_or("");
            if !delta.is_empty() {
                let _ = app.emit(
                    "interview:rt-answer",
                    serde_json::json!({ "delta": delta }),
                );
            }
        }
        "response.audio_transcript.done" => {
            let t = v
                .get("transcript")
                .and_then(|d| d.as_str())
                .unwrap_or("");
            if !t.is_empty() {
                let _ = app.emit(
                    "interview:rt-answer-done",
                    serde_json::json!({ "text": t }),
                );
            }
        }
        "response.function_call_arguments.done" => {
            let call_id = v.get("call_id").and_then(|c| c.as_str()).unwrap_or("");
            let name = v.get("name").and_then(|c| c.as_str()).unwrap_or("");
            let args = v
                .get("arguments")
                .and_then(|c| c.as_str())
                .unwrap_or("");
            if name == "web_search" && !call_id.is_empty() {
                let query: String = serde_json::from_str(args)
                    .ok()
                    .and_then(|a: serde_json::Value| {
                        a.get("query").and_then(|q| q.as_str()).map(str::to_string)
                    })
                    .unwrap_or_else(|| args.to_string());
                log::info!("[interview:rt] tool web_search query=\"{}\"", query);
                // 异步执行搜索（≤60s），主循环继续收发音频/取消信号。
                if *search_running {
                    log::warn!("[interview:rt] search already in flight, skipping duplicate tool call");
                } else {
                    *search_running = true;
                    let cfg = search_cfg.clone();
                    let tx = search_tx.clone();
                    let call = call_id.to_string();
                    tokio::spawn(async move {
                        let output = super::search::web_search_inner(
                            &query,
                            cfg.base_url.as_deref(),
                            cfg.api_key.clone(),
                            cfg.api_key_env.clone(),
                            cfg.model.as_deref(),
                            cfg.proxy_url.as_deref(),
                        )
                        .await
                        .unwrap_or_else(|e| format!("搜索失败: {e}"));
                        let _ = tx
                            .send(SearchResult { call_id: call, output })
                            .await;
                    });
                }
            }
        }
        "response.done" => {
            let status = v
                .pointer("/response/status")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            if status == "completed" {
                let _ = app.emit(
                    "interview:rt-status",
                    serde_json::json!({ "status": "answered" }),
                );
            }
        }
        "error" => {
            let msg = v
                .pointer("/error/message")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown error");
            let _ = app.emit(
                "interview:rt-error",
                serde_json::json!({ "message": msg }),
            );
        }
        _ => {}
    }
    Ok(())
}

/// 推送一帧音频（WAV base64 → pcm16 24kHz → input_audio_buffer.append）。
#[tauri::command]
pub async fn interview_realtime_send_audio(wav_base64: String) -> Result<(), String> {
    use base64::Engine as _;

    let (samples, sample_rate) = super::local_asr::decode_wav_base64_to_pcm16(&wav_base64)?;
    let pcm24 = resample_i16(&samples, sample_rate, 24000);
    let mut bytes = Vec::with_capacity(pcm24.len() * 2);
    for s in &pcm24 {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let msg = serde_json::json!({
        "type": "input_audio_buffer.append",
        "audio": b64
    })
    .to_string();

    // 只复制 Sender，锁不跨 await：主循环被搜索/网络短暂阻塞时，
    // send_audio 仍能立即返回（channel 有界缓冲），stop 也不会被锁卡住。
    let tx = {
        let guard = RT_SESSION.lock().await;
        guard.as_ref().ok_or_else(|| "实时语音会话未启动".to_string())?.tx.clone()
    };
    tx.send(msg)
        .await
        .map_err(|_| "实时语音会话已关闭".to_string())?;
    Ok(())
}

/// 停止实时语音会话。
#[tauri::command]
pub async fn interview_realtime_stop() -> Result<String, String> {
    stop_inner().await
}

async fn stop_inner() -> Result<String, String> {
    let session = RT_SESSION.lock().await.take();
    match session {
        Some(s) => {
            // 先发取消信号（watch，不依赖音频通道是否拥塞），再等任务退出；
            // 超时则 abort，杜绝旧任务与新会话并存发事件。
            let _ = s.cancel.send(true);
            let _ = s.tx.send(String::new()).await; // 顺带唤醒 recv 分支
            let mut join = s.join;
            match tokio::time::timeout(std::time::Duration::from_secs(3), &mut join).await {
                Ok(_) => {}
                Err(_) => {
                    log::warn!("[interview:rt] stop timeout, aborting session task");
                    join.abort();
                }
            }
            Ok("realtime session stopped".to_string())
        }
        None => Ok("no realtime session".to_string()),
    }
}
