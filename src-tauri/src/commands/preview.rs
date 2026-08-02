use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PreviewCommand {
    Open { url: String },
    Refresh,
    Back,
    Forward,
}

fn normalize_preview_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Preview URL is empty".to_string());
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file:")
        || lower.starts_with("data:")
        || lower.starts_with("about:")
    {
        return Ok(trimmed.to_string());
    }
    if lower.starts_with("localhost")
        || lower.starts_with("127.0.0.1")
        || lower.starts_with("[::1]")
    {
        return Ok(format!("http://{}", trimmed));
    }
    Ok(format!("https://{}", trimmed))
}

fn emit_preview_command(app: &AppHandle, command: PreviewCommand) -> Result<(), String> {
    app.emit("tokenicode-preview-command", command)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_open_url(app: AppHandle, url: String) -> Result<String, String> {
    let normalized = normalize_preview_url(&url)?;
    emit_preview_command(
        &app,
        PreviewCommand::Open {
            url: normalized.clone(),
        },
    )?;
    Ok(normalized)
}

#[tauri::command]
pub async fn preview_refresh(app: AppHandle) -> Result<(), String> {
    emit_preview_command(&app, PreviewCommand::Refresh)
}

#[tauri::command]
pub async fn preview_back(app: AppHandle) -> Result<(), String> {
    emit_preview_command(&app, PreviewCommand::Back)
}

#[tauri::command]
pub async fn preview_forward(app: AppHandle) -> Result<(), String> {
    emit_preview_command(&app, PreviewCommand::Forward)
}
