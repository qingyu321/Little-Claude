use tauri::{AppHandle};

use crate::build_smart_http_client;
use crate::commands::external::reveal_in_finder;
use crate::commands::video_analysis::{
    detect_device_backend, download_first_ok_to_file, emit_skill_runtime_progress,
    RuntimeDepCheck, SpeechRuntimeStatus,
};

/// Speech-to-text offline model  --?whisper.cpp ggml-tiny.bin (~75 MB).
/// ggml-tiny is the smallest multilingual model that supports zh+en.
const SPEECH_SKILL_NAME: &str = "speech";
const SPEECH_MODEL_FILE: &str = "ggml-tiny.bin";
const SPEECH_MODEL_URLS: &[&str] = &[
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
];
/* ------------------------------------------------------------------ */
/*  Speech-to-text offline model commands                              */
/* ------------------------------------------------------------------ */

fn speech_models_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    Ok(home.join(".claude").join("speech-models"))
}

/// Check whether offline whisper model files are present.
#[tauri::command]
pub async fn get_speech_runtime_status() -> Result<SpeechRuntimeStatus, String> {
    let models_dir = speech_models_dir()?;
    let model_exists = models_dir.join(SPEECH_MODEL_FILE).is_file()
        || models_dir.join("ggml-base.bin").is_file()
        || models_dir.join("ggml-small.bin").is_file();

    let mut checks: Vec<RuntimeDepCheck> = Vec::new();
    checks.push(RuntimeDepCheck {
        name: "whisper_model".to_string(),
        label: "whisper 离线模型".to_string(),
        ready: model_exists,
        detail: Some(if model_exists {
            models_dir.to_string_lossy().to_string()
        } else {
            "未下载".to_string()
        }),
    });

    let status = if model_exists { "ready" } else { "missing" };

    // Auto-install downloads ggml-tiny.bin from hf-mirror (~75 MB).
    let auto_supported = true;
    let (device_backend, device_backend_label) = detect_device_backend();

    Ok(SpeechRuntimeStatus {
        status: status.to_string(),
        checks,
        auto_install_supported: auto_supported,
        device_backend: Some(device_backend.to_string()),
        device_backend_label: Some(device_backend_label.to_string()),
    })
}

/// Download the whisper.cpp ggml-tiny.bin model (~75 MB) for offline speech
/// recognition.  Uses hf-mirror (China-friendly) with automatic HuggingFace
/// fallback.  Emits progress events so the frontend can show a progress bar.
#[tauri::command]
pub async fn download_speech_runtime(app: AppHandle) -> Result<SpeechRuntimeStatus, String> {
    let models_dir = speech_models_dir()?;
    std::fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Failed to create speech models dir: {}", e))?;

    let dest = models_dir.join(SPEECH_MODEL_FILE);

    // Skip if already downloaded and large enough (> 10 MB  --?ggml-tiny is ~75 MB).
    if dest.is_file()
        && dest.metadata().map(|m| m.len() > 10_000_000).unwrap_or(false)
    {
        emit_skill_runtime_progress(
            &app,
            SPEECH_SKILL_NAME,
            "model",
            SPEECH_MODEL_URLS[0],
            100,
            "whisper 模型已存在,跳过下载",
            0,
            0,
        );
        return get_speech_runtime_status().await;
    }

    emit_skill_runtime_progress(
        &app,
        SPEECH_SKILL_NAME,
        "starting",
        SPEECH_MODEL_URLS[0],
        0,
        "准备下载 whisper 离线模型(~75 MB --?..",
        0,
        0,
    );

    let client = build_smart_http_client(
        std::time::Duration::from_secs(15),
        std::time::Duration::from_secs(60 * 10), // 75 MB × slow connection headroom
    )
    .await;

    // Use download_first_ok_to_file with speech skill name so progress events
    // carry `skill: "speech"` for the frontend to pick up.
    let used_url = download_first_ok_to_file(
        &app,
        SPEECH_SKILL_NAME,
        &client,
        SPEECH_MODEL_URLS,
        &dest,
        "model",
        2,
        98,
        "whisper 模型",
    )
    .await?;

    emit_skill_runtime_progress(
        &app,
        SPEECH_SKILL_NAME,
        "complete",
        &used_url,
        100,
        "whisper 离线模型安装完成",
        0,
        0,
    );

    get_speech_runtime_status().await
}

/// Open the speech models directory in the system file manager.
#[tauri::command]
pub async fn open_speech_skill_dir() -> Result<String, String> {
    let dir = speech_models_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create speech models dir: {}", e))?;
    let path = dir.to_string_lossy().to_string();
    reveal_in_finder(path.clone()).await?;
    Ok(path)
}