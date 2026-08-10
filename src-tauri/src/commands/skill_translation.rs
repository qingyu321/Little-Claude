use serde_json::Value;

use crate::build_smart_http_client;
use crate::commands::provider::{load_providers, provider_messages_endpoint, ApiProvider, ModelMapping};
use crate::commands::skills::{SkillTranslation, SkillTranslationConfig, SkillTranslationItem};
use crate::is_proxy_reachable;
use crate::normalize_deepseek_model_name;
use crate::safe_data_dir;

fn extract_json_array(text: &str) -> Result<Vec<SkillTranslation>, String> {
    if let Ok(parsed) = serde_json::from_str::<Vec<SkillTranslation>>(text.trim()) {
        return Ok(parsed);
    }

    let start = text
        .find('[')
        .ok_or_else(|| "Translation response did not contain a JSON array".to_string())?;
    let end = text
        .rfind(']')
        .ok_or_else(|| "Translation response did not contain a complete JSON array".to_string())?;
    if end <= start {
        return Err("Translation response JSON array was malformed".to_string());
    }

    serde_json::from_str::<Vec<SkillTranslation>>(&text[start..=end])
        .map_err(|e| format!("Cannot parse translation response: {}", e))
}

fn resolve_translation_provider(provider_id: Option<String>) -> Result<ApiProvider, String> {
    let providers_file = load_providers()?;
    let selected_id = provider_id
        .or_else(|| {
            providers_file
                .active_provider_per_backend
                .get("claude")
                .and_then(|id| id.clone())
        })
        .or(providers_file.active_provider_id.clone());
    let Some(selected_id) = selected_id else {
        return Err("No active provider configured".to_string());
    };

    providers_file
        .providers
        .into_iter()
        .find(|provider| provider.id == selected_id)
        .ok_or_else(|| format!("Provider '{}' not found", selected_id))
}

fn translation_provider_from_config(config: SkillTranslationConfig) -> Result<ApiProvider, String> {
    if config.base_url.trim().is_empty() {
        return Err("Translation API base URL is not configured".to_string());
    }
    if config.api_key.trim().is_empty() {
        return Err("Translation API key is not configured".to_string());
    }
    if config.model.trim().is_empty() {
        return Err("Translation API model is not configured".to_string());
    }

    Ok(ApiProvider {
        id: "skill-translation".to_string(),
        name: "Skill Translation".to_string(),
        base_url: config.base_url,
        api_format: config.api_format,
        api_key: Some(config.api_key),
        model_mappings: vec![ModelMapping {
            tier: "translation".to_string(),
            provider_model: config.model,
        }],
        extra_env: None,
        proxy_url: config.proxy_url,
        preset: None,
        created_at: 0,
        updated_at: 0,
        cli_backend: None,
        web_search_fallback: None,
    })
}

fn resolve_translation_model(provider: &ApiProvider) -> String {
    for tier in ["flash", "haiku", "sonnet", "opus", "pro"] {
        if let Some(mapping) = provider.model_mappings.iter().find(|mapping| {
            mapping.tier.to_lowercase().contains(tier) && !mapping.provider_model.trim().is_empty()
        }) {
            return normalize_deepseek_model_name(&mapping.provider_model);
        }
    }

    // Fall back to the first available mapping
    provider
        .model_mappings
        .iter()
        .find(|mapping| !mapping.provider_model.trim().is_empty())
        .map(|mapping| normalize_deepseek_model_name(&mapping.provider_model))
        .unwrap_or_default()
}

/// Translate skill names/descriptions through the active third-party provider.
// --- Skill translation cache (perf) ---
// Skill docs are re-translated on every preview, so the same SKILL.md hits the
// cache on repeat views. The cache key is content-addressed
// (provider.id | model | source), so identical inputs always return the cached
// translation. Effective hit rate during normal skill browsing approaches ~100%.
// Persisted to disk so it also survives app restarts.

const TRANSLATION_CACHE_META_FILE: &str = "translation-cache-meta.json";
const TRANSLATION_CACHE_MD_FILE: &str = "translation-cache-md.json";

type MetaCache = std::collections::HashMap<String, Vec<SkillTranslation>>;
type MdCache = std::collections::HashMap<String, String>;

static TRANSLATION_CACHE_META: std::sync::OnceLock<std::sync::Mutex<MetaCache>> =
    std::sync::OnceLock::new();
static TRANSLATION_CACHE_MD: std::sync::OnceLock<std::sync::Mutex<MdCache>> =
    std::sync::OnceLock::new();

fn load_translation_cache_file<T: serde::de::DeserializeOwned>(name: &str) -> Result<T, String> {
    let path = safe_data_dir()?.join(name);
    if !path.exists() {
        return Err("no cache".into());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读翻译缓存失 --? {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析翻译缓存失败: {}", e))
}

fn persist_translation_cache_file<T: serde::Serialize>(name: &str, cache: &T) {
    if let Ok(dir) = safe_data_dir() {
        let path = dir.join(name);
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(&path, json);
        }
    }
}

fn translation_meta_cache() -> &'static std::sync::Mutex<MetaCache> {
    TRANSLATION_CACHE_META.get_or_init(|| {
        std::sync::Mutex::new(
            load_translation_cache_file::<MetaCache>(TRANSLATION_CACHE_META_FILE)
                .unwrap_or_default(),
        )
    })
}

fn translation_md_cache() -> &'static std::sync::Mutex<MdCache> {
    TRANSLATION_CACHE_MD.get_or_init(|| {
        std::sync::Mutex::new(
            load_translation_cache_file::<MdCache>(TRANSLATION_CACHE_MD_FILE).unwrap_or_default(),
        )
    })
}

fn translation_cache_key(provider_id: &str, model: &str, source: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(provider_id.as_bytes());
    hasher.update(b"|");
    hasher.update(model.as_bytes());
    hasher.update(b"|");
    hasher.update(source.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[tauri::command]
pub async fn translate_skill_metadata(
    items: Vec<SkillTranslationItem>,
    provider_id: Option<String>,
    config: Option<SkillTranslationConfig>,
) -> Result<Vec<SkillTranslation>, String> {
    if items.is_empty() {
        return Ok(vec![]);
    }

    let provider = match config {
        Some(config) => translation_provider_from_config(config)?,
        None => resolve_translation_provider(provider_id)?,
    };
    let api_key = provider
        .api_key
        .clone()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "Active provider has no API key".to_string())?;
    if provider.base_url.trim().is_empty() {
        return Err("Active provider has no base URL".to_string());
    }

    let client = if let Some(ref proxy_url) = provider.proxy_url {
        if !proxy_url.trim().is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                if is_proxy_reachable(proxy_url).await {
                    reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .timeout(std::time::Duration::from_secs(60))
                        .no_proxy()
                        .proxy(proxy)
                        .build()
                        .unwrap_or_default()
                } else {
                    build_smart_http_client(
                        std::time::Duration::from_secs(10),
                        std::time::Duration::from_secs(60),
                    )
                    .await
                }
            } else {
                build_smart_http_client(
                    std::time::Duration::from_secs(10),
                    std::time::Duration::from_secs(60),
                )
                .await
            }
        } else {
            build_smart_http_client(
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(60),
            )
            .await
        }
    } else {
        build_smart_http_client(
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(60),
        )
        .await
    };

    let model = resolve_translation_model(&provider);
    let compact_items: Vec<SkillTranslationItem> = items
        .into_iter()
        .map(|item| SkillTranslationItem {
            key: item.key,
            name: item.name.chars().take(120).collect(),
            description: item.description.chars().take(800).collect(),
        })
        .collect();
    let items_json = serde_json::to_string(&compact_items)
        .map_err(|e| format!("Cannot serialize translation input: {}", e))?;

    // --- translation cache: identical metadata input  --?cached result ---
    let cache_key = translation_cache_key(&provider.id, &model, &items_json);
    if let Some(hit) = translation_meta_cache()
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
    {
        return Ok(hit);
    }

    let prompt = format!(
        "Translate these Codex skill metadata entries into concise Simplified Chinese. Preserve every key exactly. Return ONLY a JSON array, no markdown. Each item must have key, name, and description. Keep names short and natural; keep descriptions one sentence when possible.\n\n{}",
        items_json
    );

    let api_format = provider.api_format.to_lowercase();
    let (url, body) = if api_format == "openai" {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": "You are a precise product UI translator."},
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    } else {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "temperature": 0,
                "messages": [
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    };

    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .json(&body);
    if api_format == "openai" {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    } else {
        request = request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Translation request failed: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!(
            "Cannot read translation response: {}. Check that Base URL is the real API endpoint and Proxy URL is only a network proxy; if a local proxy is used, disable response compression/rewrite or leave Proxy URL empty.",
            e
        ))?;
    if !status.is_success() {
        return Err(format!(
            "Translation API returned HTTP {}: {}",
            status.as_u16(),
            text.chars().take(300).collect::<String>()
        ));
    }

    let content = if api_format == "openai" {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("choices")
                    .and_then(|choices| choices.get(0))
                    .and_then(|choice| choice.get("message"))
                    .and_then(|message| message.get("content"))
                    .and_then(|content| content.as_str())
                    .map(|content| content.to_string())
            })
            .ok_or_else(|| "OpenAI translation response had no message content".to_string())?
    } else {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("content")
                    .and_then(|content| content.as_array())
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
            .filter(|content| !content.trim().is_empty())
            .ok_or_else(|| "Anthropic translation response had no text content".to_string())?
    };

    let result = extract_json_array(&content)?;
    {
        let mut cache = translation_meta_cache().lock().expect("translation meta cache mutex poisoned");
        cache.insert(cache_key.clone(), result.clone());
        persist_translation_cache_file(TRANSLATION_CACHE_META_FILE, &*cache);
    }
    Ok(result)
}

/// Translate the full SKILL.md preview text without modifying the source file.
#[tauri::command]
pub async fn translate_skill_markdown(
    content: String,
    config: SkillTranslationConfig,
) -> Result<String, String> {
    let provider = translation_provider_from_config(config)?;
    let api_key = provider
        .api_key
        .clone()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "Translation API key is not configured".to_string())?;

    let client = if let Some(ref proxy_url) = provider.proxy_url {
        if !proxy_url.trim().is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
                if is_proxy_reachable(proxy_url).await {
                    reqwest::Client::builder()
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .timeout(std::time::Duration::from_secs(120))
                        .no_proxy()
                        .proxy(proxy)
                        .build()
                        .unwrap_or_default()
                } else {
                    build_smart_http_client(
                        std::time::Duration::from_secs(10),
                        std::time::Duration::from_secs(120),
                    )
                    .await
                }
            } else {
                build_smart_http_client(
                    std::time::Duration::from_secs(10),
                    std::time::Duration::from_secs(120),
                )
                .await
            }
        } else {
            build_smart_http_client(
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(120),
            )
            .await
        }
    } else {
        build_smart_http_client(
            std::time::Duration::from_secs(10),
            std::time::Duration::from_secs(120),
        )
        .await
    };

    let model = resolve_translation_model(&provider);

    // --- translation cache: identical markdown input  --?cached result ---
    let cache_key = translation_cache_key(&provider.id, &model, &content);
    if let Some(hit) = translation_md_cache()
        .lock()
        .unwrap()
        .get(&cache_key)
        .cloned()
    {
        return Ok(hit);
    }

    let prompt = format!(
        "Translate this Codex SKILL.md into Simplified Chinese for reading in a UI preview. Preserve Markdown structure, headings, lists, tables, frontmatter keys, code fences, inline code, commands, paths, URLs, placeholders, and model/tool names exactly. Translate only human-readable prose. Return ONLY the translated Markdown.\n\n{}",
        content
    );

    let api_format = provider.api_format.to_lowercase();
    let (url, body) = if api_format == "openai" {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": "You are a precise technical translator."},
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    } else {
        (
            provider_messages_endpoint(&provider.base_url, &api_format),
            serde_json::json!({
                "model": model,
                "max_tokens": 8192,
                "temperature": 0,
                "messages": [
                    {"role": "user", "content": prompt}
                ]
            }),
        )
    };

    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity")
        .json(&body);
    if api_format == "openai" {
        request = request.header("Authorization", format!("Bearer {}", api_key));
    } else {
        request = request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Translation request failed: {}", e))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!(
            "Cannot read translation response: {}. Check that Base URL is the real API endpoint and Proxy URL is only a network proxy; if a local proxy is used, disable response compression/rewrite or leave Proxy URL empty.",
            e
        ))?;
    if !status.is_success() {
        return Err(format!(
            "Translation API returned HTTP {}: {}",
            status.as_u16(),
            text.chars().take(300).collect::<String>()
        ));
    }

    let result = if api_format == "openai" {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("choices")
                    .and_then(|choices| choices.get(0))
                    .and_then(|choice| choice.get("message"))
                    .and_then(|message| message.get("content"))
                    .and_then(|content| content.as_str())
                    .map(|content| content.trim().to_string())
            })
            .filter(|content| !content.is_empty())
            .ok_or_else(|| "OpenAI translation response had no message content".to_string())
    } else {
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| {
                json.get("content")
                    .and_then(|content| content.as_array())
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
            .map(|content| content.trim().to_string())
            .filter(|content| !content.is_empty())
            .ok_or_else(|| "Anthropic translation response had no text content".to_string())
    };
    let translated = result?;
    {
        let mut cache = translation_md_cache().lock().expect("translation md cache mutex poisoned");
        cache.insert(cache_key.clone(), translated.clone());
        persist_translation_cache_file(TRANSLATION_CACHE_MD_FILE, &*cache);
    }
    Ok(translated)
}