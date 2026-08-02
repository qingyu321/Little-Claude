//! Codex config.toml generator.
//!
//! Codex CLI reads its provider configuration from `~/.codex/config.toml`,
//! unlike Claude CLI which uses environment variables. This module translates
//! Little Claude's provider model into Codex's TOML format and writes it before
//! each Codex session starts.

use crate::ApiProvider;
use std::path::PathBuf;

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
    toml.push_str(&format!("model = \"{}\"\n", model));
    toml.push_str(&format!("model_provider = \"{}\"\n", provider_id));
    // Sandbox mode: read-only, workspace-write, or danger-full-access
    toml.push_str(&format!("sandbox_mode = \"{}\"\n", sandbox_mode));
    // Disable telemetry / response storage for privacy
    toml.push_str("disable_response_storage = true\n");

    // Reasoning effort and context window (previously passed via -c CLI flags)
    if let Some(effort) = reasoning_effort {
        toml.push_str(&format!("model_reasoning_effort = \"{}\"\n", effort));
    }
    if let Some(window) = context_window {
        toml.push_str(&format!("model_context_window = {}\n", window));
    }
    toml.push('\n');

    // Provider block
    toml.push_str(&format!("[model_providers.{}]\n", provider_id));
    toml.push_str(&format!("name = \"{}\"\n", provider.name));
    toml.push_str(&format!("base_url = \"{}\"\n", provider.base_url));
    toml.push_str(&format!("wire_api = \"{}\"\n", wire_api));

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
            toml.push_str(&format!("proxy = \"{}\"\n", proxy));
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

/// Get the path to the Codex config file (`~/.codex/config.toml`).
pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

/// Write the config to `~/.codex/config.toml`, creating the directory if needed.
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

    std::fs::write(&path, toml_content)
        .map_err(|e| format!("Failed to write config.toml: {}", e))?;

    eprintln!("[codex_config] Written config to {}", path.display());
    eprintln!("[codex_config] Content:\n{}", toml_content);

    Ok(path)
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
