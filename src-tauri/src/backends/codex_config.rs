//! Codex config.toml generator.
//!
//! Codex CLI reads its provider configuration from `~/.codex/config.toml`,
//! unlike Claude CLI which uses environment variables. This module translates
//! Little Claude's provider model into Codex's TOML format and writes it before
//! each Codex session starts.

use crate::ApiProvider;
use std::collections::HashSet;
use std::path::PathBuf;

/// TOML 字符串值转义：双引号包裹 + 转义内部引号/反斜杠/换行等。
/// provider 的 model/base_url/name 等是用户输入，直接拼接可注入 TOML
/// 结构（伪造键、注释掉后续配置）——统一经此函数输出。
fn escape_toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            // TOML 禁止裸控制字符（U+0000–U+0008、U+000A–U+001F、U+007F）——
            // 已转义的 \b\f\n\r\t 之外，其余控制字符统一输出 \uXXXX 转义，
            // 否则生成的 config.toml 无法被 codex 解析。
            '\u{0000}'..='\u{0007}' | '\u{000B}' | '\u{000E}'..='\u{001F}' | '\u{007F}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Generate a Codex `config.toml` string from a Little Claude provider configuration.
///
/// Maps:
/// - `model` (passed from UI) → `model` (overrides provider mapping)
/// - `base_url` → `[model_providers.<id>].base_url`
/// - `api_format` → `wire_api` ("anthropic" → "messages", "openai" → "responses")
/// - `api_key` → `[model_providers.<id>].api_key`
/// - `model_mappings` → fallback `model` when `preferred_model` is None
pub(crate) fn generate_config_toml(
    provider: &ApiProvider,
    sandbox_mode: &str,
    reasoning_effort: Option<&str>,
    context_window: Option<u32>,
    preferred_model: Option<&str>,
) -> String {
    // Use a stable provider ID — Codex uses this internally
    let provider_id = sanitize_provider_id(&provider.name);

    // Codex v0.146+ only accepts wire_api = "responses" (OpenAI Responses API).
    // Codex appends /responses to the base_url — providers must have an
    // OpenAI-compatible endpoint (e.g. https://api.deepseek.com/v1).
    // Anthropic-format URLs (e.g. https://api.deepseek.com/anthropic) won't work.
    let wire_api = "responses";

    // Pick model: use the UI-resolved model if provided, otherwise fall back
    // to the provider's sonnet-tier mapping.
    let model = preferred_model
        .or_else(|| {
            provider
                .model_mappings
                .iter()
                .find(|m| m.tier == "sonnet")
                .or_else(|| provider.model_mappings.first())
                .map(|m| m.provider_model.as_str())
        })
        .unwrap_or("gpt-5.4");

    let mut toml = String::new();

    // Top-level settings
    // M5: 所有用户输入的字符串值统一走 escape_toml_string（引号/换行转义）。
    toml.push_str(&format!("model = {}\n", escape_toml_string(model)));
    toml.push_str(&format!(
        "model_provider = {}\n",
        escape_toml_string(&provider_id)
    ));
    // Sandbox mode: read-only, workspace-write, or danger-full-access
    toml.push_str(&format!(
        "sandbox_mode = {}\n",
        escape_toml_string(sandbox_mode)
    ));
    // Disable telemetry / response storage for privacy
    toml.push_str("disable_response_storage = true\n");

    // Reasoning effort and context window (previously passed via -c CLI flags)
    if let Some(effort) = reasoning_effort {
        toml.push_str(&format!(
            "model_reasoning_effort = {}\n",
            escape_toml_string(effort)
        ));
    }
    if let Some(window) = context_window {
        toml.push_str(&format!("model_context_window = {}\n", window));
    }
    toml.push('\n');

    // Provider block
    toml.push_str(&format!("[model_providers.{}]\n", provider_id));
    toml.push_str(&format!("name = {}\n", escape_toml_string(&provider.name)));
    toml.push_str(&format!(
        "base_url = {}\n",
        escape_toml_string(&provider.base_url)
    ));
    toml.push_str(&format!("wire_api = {}\n", escape_toml_string(wire_api)));

    // Codex does NOT support inline api_key — must use env_key + set env var before spawn.
    // Use requires_openai_auth = false for third-party providers, with env_key reference.
    // The actual API key value is injected as TOKENICODE_CODEX_API_KEY env var at spawn time.
    if provider.api_key.as_ref().map_or(false, |k| !k.is_empty()) {
        toml.push_str("env_key = \"TOKENICODE_CODEX_API_KEY\"\n");
        toml.push_str("requires_openai_auth = false\n");
    }

    // Add proxy if configured
    if let Some(ref proxy) = provider.proxy_url {
        if !proxy.is_empty() {
            toml.push_str(&format!("proxy = {}\n", escape_toml_string(proxy)));
        }
    }

    toml
}

/// Get the path to the Codex config directory (`~/.codex/`).
pub fn config_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

/// 应用管理过的顶层键集合：合并时若本次生成未包含其中某个键（如
/// `model_reasoning_effort` / `model_context_window` 为条件性写入），
/// 需从现有文件删除残留旧值，避免用户切换配置后旧值仍生效。
const MANAGED_TOP_KEYS: &[&str] = &[
    "model",
    "model_provider",
    "sandbox_mode",
    "disable_response_storage",
    "model_reasoning_effort",
    "model_context_window",
];

/// 应用写过的 model_providers 块 id 持久化文件路径（`~/.codex/managed_providers.json`）。
/// 合并时删除「应用管理过但本次未生成」的旧块——用户切换/删除 provider 后，
/// 旧 [model_providers.<id>] 块（含 base_url、可能内嵌凭据）不再永久残留；
/// 不在该列表中的块视为用户自定义，按「保留未知键」原则不动。
fn managed_providers_path() -> PathBuf {
    config_dir().join("managed_providers.json")
}

fn load_managed_providers() -> HashSet<String> {
    std::fs::read_to_string(managed_providers_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_managed_providers(ids: &HashSet<String>) {
    let list: Vec<&String> = ids.iter().collect();
    let _ = std::fs::write(
        managed_providers_path(),
        serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string()),
    );
}

/// Get the path to the Codex config file (`~/.codex/config.toml`).
pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

/// Write the config to `~/.codex/config.toml`, creating the directory if needed.
///
/// M5: 合并式写入——先读现有 config.toml（合法 TOML 时），保留未知键
/// （用户手动配置的字段）与未知的 model_providers 块，只更新/插入应用
/// 管理的键。现有文件不存在或不是合法 TOML 时回退全量覆盖（备份保留）。
///
/// Returns the path that was written to.
pub fn write_config(toml_content: &str) -> Result<PathBuf, String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.codex/: {}", e))?;

    let path = config_path();

    // Back up existing config if present
    if path.exists() {
        let backup = dir.join("config.toml.tokenicode.bak");
        let _ = std::fs::copy(&path, &backup);
    }

    // 应用管理过的 provider 块 id 列表（跨写入持久化，供合并时清理旧块）
    let mut managed = load_managed_providers();
    let final_content = match std::fs::read_to_string(&path) {
        Ok(existing) => merge_generated_into(&existing, toml_content, &mut managed),
        Err(_) => {
            // 全量覆盖路径（文件缺失/非法）同样记录本次生成的 provider id，
            // 否则首次写入的块不在 managed 列表、日后切换 provider 时无法清理。
            collect_generated_provider_ids(toml_content, &mut managed);
            toml_content.to_string()
        }
    };
    // 落盘失败不影响主流程（下次写入再试）
    save_managed_providers(&managed);

    std::fs::write(&path, final_content)
        .map_err(|e| format!("Failed to write config.toml: {}", e))?;

    eprintln!("[codex_config] Written config to {}", path.display());
    eprintln!("[codex_config] Content:\n{}", toml_content);

    Ok(path)
}

/// 从生成的 TOML 中收集 model_providers 块 id 并入 `managed`。
/// 无论后续合并是否成功，本次生成的 provider id 都是应用管理过的。
fn collect_generated_provider_ids(generated: &str, managed: &mut HashSet<String>) {
    if let Ok(v) = generated.parse::<toml::Value>() {
        let ids: HashSet<String> = v
            .as_table()
            .and_then(|t| t.get("model_providers"))
            .and_then(|t| t.as_table())
            .map(|gp| gp.keys().cloned().collect())
            .unwrap_or_default();
        managed.extend(ids);
    }
}

/// 把生成的 TOML（应用管理的键）合并进现有 TOML 文本：保留现有未知键，
/// `model_providers` 表按 provider 键合并（保留用户自定义的其他 provider
/// 块），其余应用管理的键覆盖写入。同时：
/// - 删除「应用管理过但本次未生成」的 model_providers 块（用户切换/删除
///   provider 后旧块不再残留，含 base_url 与可能内嵌的凭据）；
/// - 删除「应用管理但本次未生成」的顶层键（条件性写入的旧值不残留）；
/// - 本次生成的 provider id 记录进 `managed`，供后续写入清理旧块。
///
/// 任一侧解析失败则回退全量使用 generated。
fn merge_generated_into(
    existing: &str,
    generated: &str,
    managed: &mut HashSet<String>,
) -> String {
    let Ok(generated_val) = generated.parse::<toml::Value>() else {
        return generated.to_string();
    };
    collect_generated_provider_ids(generated, managed);

    let Ok(existing_val) = existing.parse::<toml::Value>() else {
        return generated.to_string();
    };
    let (Some(generated_table), Some(existing_table)) =
        (generated_val.as_table(), existing_val.as_table())
    else {
        return generated.to_string();
    };
    let mut out = existing_table.clone();

    // [model_providers.<id>] 按 provider 合并：删除应用管理过但本次未生成的
    // 旧块；保留用户自定义的其他块；生成的块整体覆盖写入。
    if let Some(gp) = generated_table
        .get("model_providers")
        .and_then(|v| v.as_table())
    {
        let entry = out
            .entry("model_providers")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()));
        if let Some(ep) = entry.as_table_mut() {
            let stale: Vec<String> = ep
                .keys()
                .filter(|k| managed.contains(*k) && !gp.contains_key(*k))
                .cloned()
                .collect();
            for k in stale {
                eprintln!("[codex_config] removing stale provider block {}", k);
                ep.remove(&k);
            }
            for (k, v) in gp {
                ep.insert(k.clone(), v.clone());
            }
        }
    }
    // 顶层键：应用管理但本次未生成（条件性写入）的键删除残留旧值
    for k in MANAGED_TOP_KEYS {
        if !generated_table.contains_key(*k) {
            out.remove(*k);
        }
    }
    for (k, v) in generated_table {
        if k != "model_providers" {
            out.insert(k.clone(), v.clone());
        }
    }
    toml::to_string(&out).unwrap_or_else(|_| generated.to_string())
}

/// Sanitize a provider name into a valid TOML table key.
/// Only keeps ASCII alphanumeric chars, hyphens, and underscores.
/// Consecutive non-alphanumeric chars collapse to a single underscore.
/// Falls back to "provider" if the result is empty (e.g. pure-CJK names).
fn sanitize_provider_id(name: &str) -> String {
    let mut result = String::with_capacity(name.len());
    let mut prev_underscore = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            result.push(c.to_ascii_lowercase());
            prev_underscore = false;
        } else if c == '_' {
            if !prev_underscore {
                result.push('_');
                prev_underscore = true;
            }
        } else {
            // Any other char → underscore (collapse consecutive)
            if !prev_underscore {
                result.push('_');
                prev_underscore = true;
            }
        }
    }
    let sanitized = result.trim_matches('_').to_string();
    if sanitized.is_empty() {
        "provider".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_config_openai() {
        let provider = ApiProvider {
            id: "test".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_format: "openai".into(),
            api_key: Some("sk-test123".into()),
            model_mappings: vec![crate::commands::ModelMapping {
                tier: "sonnet".into(),
                provider_model: "gpt-5.4".into(),
            }],
            extra_env: None,
            proxy_url: None,
            preset: None,
            created_at: 0,
            updated_at: 0,
            cli_backend: Some("codex".into()),
        };

        let toml = generate_config_toml(&provider, "read-only", None, None, None);
        assert!(toml.contains("model = \"gpt-5.4\""));
        assert!(toml.contains("model_provider = \"openai\""));
        assert!(toml.contains("base_url = \"https://api.openai.com/v1\""));
        assert!(toml.contains("wire_api = \"responses\""));
        assert!(toml.contains("env_key = \"TOKENICODE_CODEX_API_KEY\""));
        assert!(toml.contains("requires_openai_auth = false"));
    }

    #[test]
    fn test_escape_toml_string_control_chars() {
        // 低 3: TOML 禁用控制字符必须 \uXXXX 转义，否则生成的 config.toml 无法解析
        assert_eq!(escape_toml_string("a\u{0001}b"), r#""a\u0001b""#);
        assert_eq!(escape_toml_string("a\u{000B}b"), r#""a\u000bb""#);
        assert_eq!(escape_toml_string("a\u{001F}b"), r#""a\u001fb""#);
        assert_eq!(escape_toml_string("a\u{007F}b"), r#""a\u007fb""#);
        // 已转义的控制字符保持原转义
        assert_eq!(escape_toml_string("a\u{0008}b"), r#""a\bb""#);
        assert_eq!(escape_toml_string("a\u{000C}b"), r#""a\fb""#);
    }

    #[test]
    fn test_generate_config_with_preferred_model() {
        let provider = ApiProvider {
            id: "test3".into(),
            name: "Test".into(),
            base_url: "https://api.test.com/v1".into(),
            api_format: "openai".into(),
            api_key: None,
            model_mappings: vec![crate::commands::ModelMapping {
                tier: "sonnet".into(),
                provider_model: "default-model".into(),
            }],
            extra_env: None,
            proxy_url: None,
            preset: None,
            created_at: 0,
            updated_at: 0,
            cli_backend: Some("codex".into()),
        };

        // When preferred_model is provided, it takes precedence over provider mapping
        let toml = generate_config_toml(&provider, "read-only", None, None, Some("custom-model"));
        assert!(toml.contains("model = \"custom-model\""));
        // Without preferred_model, falls back to provider mapping
        let toml2 = generate_config_toml(&provider, "read-only", None, None, None);
        assert!(toml2.contains("model = \"default-model\""));
    }

    #[test]
    fn test_generate_config_anthropic_format() {
        let provider = ApiProvider {
            id: "test2".into(),
            name: "Anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            api_format: "anthropic".into(),
            api_key: None,
            model_mappings: vec![],
            extra_env: None,
            proxy_url: None,
            preset: None,
            created_at: 0,
            updated_at: 0,
            cli_backend: Some("codex".into()),
        };

        let toml = generate_config_toml(&provider, "read-only", None, None, None);
        // All providers use wire_api = "responses" for Codex ≥0.146
        assert!(toml.contains("wire_api = \"responses\""));
        assert!(toml.contains("model = \"gpt-5.4\"")); // default fallback
    }

    #[test]
    fn test_escape_toml_string() {
        // M5: 引号/反斜杠/换行必须转义，防 TOML 注入
        assert_eq!(escape_toml_string("plain"), "\"plain\"");
        assert_eq!(escape_toml_string("a\"b"), r#""a\"b""#);
        assert_eq!(escape_toml_string("a\nb"), r#""a\nb""#);
        assert_eq!(escape_toml_string("a\\b"), r#""a\\b""#);
        assert_eq!(escape_toml_string("a\rb\tc"), r#""a\rb\tc""#);
    }

    #[test]
    fn test_merge_preserves_unknown_keys() {
        // M5: 合并式写入保留未知键 + 未知 provider 块
        let existing = r#"
model = "user-model"
custom_key = "keep-me"
[model_providers.custom]
name = "My Custom"
base_url = "https://custom.example.com"
"#;
        let generated = "model = \"gpt-5.4\"\nmodel_provider = \"deepseek\"\n[model_providers.deepseek]\nname = \"DeepSeek\"\nbase_url = \"https://api.deepseek.com/v1\"\nwire_api = \"responses\"\n";
        let mut managed = HashSet::new();
        let merged = merge_generated_into(existing, generated, &mut managed);
        let parsed: toml::Value = merged.parse().expect("merged output must be valid TOML");
        let t = parsed.as_table().expect("must be a table");
        // 应用管理的键被更新
        assert_eq!(t.get("model").and_then(|v| v.as_str()), Some("gpt-5.4"));
        assert_eq!(
            t.get("model_provider").and_then(|v| v.as_str()),
            Some("deepseek")
        );
        // 未知键保留
        assert_eq!(t.get("custom_key").and_then(|v| v.as_str()), Some("keep-me"));
        // 未知 provider 块保留，新 provider 块合并
        let providers = t.get("model_providers").and_then(|v| v.as_table()).unwrap();
        assert!(providers.contains_key("custom"));
        assert_eq!(
            providers
                .get("deepseek")
                .and_then(|v| v.get("base_url"))
                .and_then(|v| v.as_str()),
            Some("https://api.deepseek.com/v1")
        );
    }

    #[test]
    fn test_merge_falls_back_on_invalid_existing() {
        // 现有文件不是合法 TOML → 全量使用 generated
        let mut managed = HashSet::new();
        let merged = merge_generated_into("not = [valid toml", "model = \"x\"\n", &mut managed);
        assert_eq!(merged, "model = \"x\"\n");
    }

    #[test]
    fn test_merge_removes_stale_managed_provider_blocks() {
        // 中 2: 应用管理过的旧 provider 块（用户切换/删除 provider 后残留）
        // 必须删除；用户自定义块与未知键仍保留。
        let existing = r#"
model = "gpt-5.4"
model_reasoning_effort = "high"
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/v1"
wire_api = "responses"
[model_providers.custom]
name = "My Custom"
base_url = "https://custom.example.com"
"#;
        let generated = "model = \"gpt-5.4\"\nmodel_provider = \"zhipu\"\n[model_providers.zhipu]\nname = \"Zhipu\"\nbase_url = \"https://api.zhipu.com/v1\"\nwire_api = \"responses\"\n";
        // deepseek 是应用此前写入过的块（记录在 managed 列表）
        let mut managed: HashSet<String> =
            ["deepseek".to_string()].into_iter().collect();
        let merged = merge_generated_into(existing, generated, &mut managed);
        let parsed: toml::Value = merged.parse().expect("merged output must be valid TOML");
        let t = parsed.as_table().expect("must be a table");
        let providers = t.get("model_providers").and_then(|v| v.as_table()).unwrap();
        // 应用管理的旧块被删除，用户自定义块保留，新块合并
        assert!(!providers.contains_key("deepseek"));
        assert!(providers.contains_key("custom"));
        assert!(providers.contains_key("zhipu"));
        // 条件性写入键的残留旧值也被删除（本次生成未包含 model_reasoning_effort）
        assert!(t.get("model_reasoning_effort").is_none());
        // managed 列表记录本次生成的 id，供下次清理
        assert!(managed.contains("zhipu"));
    }

    #[test]
    fn test_sanitize_provider_id() {
        assert_eq!(sanitize_provider_id("OpenAI (Official)"), "openai_official");
        assert_eq!(sanitize_provider_id("DeepSeek"), "deepseek");
        assert_eq!(sanitize_provider_id("___test___"), "test");
        // CJK names → fallback to "provider" (TOML keys must be ASCII)
        assert_eq!(sanitize_provider_id("北洛"), "provider");
        assert_eq!(sanitize_provider_id("千问"), "provider");
        // Mixed ASCII + CJK → keep only ASCII
        assert_eq!(sanitize_provider_id("阿里云 Qwen"), "qwen");
    }
}
