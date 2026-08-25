//! 面试模块联网搜索 — Anthropic 兼容 `/v1/messages` + `web_search_20250305` 工具。
//!
//! 默认走 DeepSeek 官方 Anthropic 端点（与 DSH web-search-deepseek 同配置：
//! `LC_SEARCH_API_KEY` → `api.deepseek.com/anthropic`），也可配置任意
//! Anthropic 兼容且支持服务端 web_search 的端点。
//!
//! 用途：
//! - 面试面板增量搜索：partial 文本防抖后调用，结果缓存；
//! - 实时语音后端（realtime.rs）模型工具调用：由模型发起 web_search 时复用。

/// 搜索结果注入提示词的最大字符数
const MAX_RESULT_CHARS: usize = 6000;
/// 整体请求超时（增量搜索应快速失败并降级）
const SEARCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 核心搜索实现（命令与实时语音后端共用）。
pub(crate) async fn web_search_inner(
    query: &str,
    base_url: Option<&str>,
    api_key: Option<String>,
    api_key_env: Option<String>,
    model: Option<&str>,
    proxy_url: Option<&str>,
) -> Result<String, String> {
    let base_url = base_url
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("https://api.deepseek.com/anthropic");
    let model = model
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("deepseek-chat");

    let api_key =
        super::commands::resolve_api_key(api_key_env.as_deref(), api_key.unwrap_or_default())?;
    if api_key.is_empty() {
        return Err("未配置搜索 API Key（请在 设置 > 面试助手 填写或指定环境变量）".to_string());
    }

    let client = super::commands::get_mimo_client(base_url, proxy_url).await;
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 2048,
        "temperature": 0.2,
        "messages": [
            {"role": "user", "content": query}
        ],
        "tools": [
            {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 3
            }
        ]
    });

    let resp = tokio::time::timeout(
        SEARCH_TIMEOUT,
        client
            .post(&url)
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send(),
    )
    .await
    .map_err(|_| "搜索请求超时（60s）".to_string())?
    .map_err(|e| format!("搜索请求失败: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        let body_text = crate::commands::anthropic_proxy::redact_secrets(&body_text);
        let snippet: String = body_text.chars().take(400).collect();
        return Err(format!("搜索 HTTP {status}: {snippet}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析搜索响应失败: {e}"))?;

    // 收集 text 块 + web_search_tool_result 内容（Anthropic 格式）
    let mut parts: Vec<String> = Vec::new();
    if let Some(blocks) = json.get("content").and_then(|c| c.as_array()) {
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        if !t.trim().is_empty() {
                            parts.push(t.trim().to_string());
                        }
                    }
                }
                Some("web_search_tool_result") => {
                    if let Some(content) = block.get("content").and_then(|c| c.as_array()) {
                        for item in content {
                            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                                if !t.trim().is_empty() {
                                    parts.push(t.trim().to_string());
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let mut result = parts.join("\n\n");
    if result.is_empty() {
        // 端点直接回答了（未调工具）——兜底取首个文本块
        if let Some(t) = json
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|blocks| blocks.iter().find_map(|b| b.get("text")))
            .and_then(|v| v.as_str())
        {
            result = t.trim().to_string();
        }
    }
    if result.is_empty() {
        return Err("搜索未返回内容".to_string());
    }

    if result.chars().count() > MAX_RESULT_CHARS {
        let mut truncated: String = result.chars().take(MAX_RESULT_CHARS).collect();
        truncated.push_str("\n…（已截断）");
        result = truncated;
    }
    Ok(result)
}

/// 面试面板联网搜索命令。
///
/// 返回可直接注入答案提示词的参考文本；失败返回 Err，调用方应降级
/// （无搜索结果仍可纯模型作答，source 徽标回退 'llm'）。
#[tauri::command]
pub async fn interview_web_search(
    query: String,
    base_url: Option<String>,
    api_key: Option<String>,
    api_key_env: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
) -> Result<String, String> {
    web_search_inner(
        &query,
        base_url.as_deref(),
        api_key,
        api_key_env,
        model.as_deref(),
        proxy_url.as_deref(),
    )
    .await
}

/// 测试搜索端点连通性（"测试搜索"按钮）——极短 query，不计费或极少计费。
#[tauri::command]
pub async fn interview_test_search(
    base_url: Option<String>,
    api_key: Option<String>,
    api_key_env: Option<String>,
    model: Option<String>,
    proxy_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let t0 = std::time::Instant::now();
    match web_search_inner(
        "1+1=? 请只回答数字",
        base_url.as_deref(),
        api_key,
        api_key_env,
        model.as_deref(),
        proxy_url.as_deref(),
    )
    .await
    {
        Ok(text) => Ok(serde_json::json!({
            "ok": true,
            "latencyMs": t0.elapsed().as_millis() as u64,
            "preview": text.chars().take(120).collect::<String>(),
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "latencyMs": t0.elapsed().as_millis() as u64,
            "error": e,
        })),
    }
}
