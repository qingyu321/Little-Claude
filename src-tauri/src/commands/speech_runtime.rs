//! Runtime download / status helpers shared between the `speech` module
//! (unconditionally compiled) and the `video-analysis` module (feature-gated
//! behind `feature = "video-analysis"`).
//!
//! These symbols were moved out of `video_analysis.rs` so that `speech.rs` and
//! `wallpaper.rs` do not depend on the optional module.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

use futures_util::StreamExt;

pub(crate) const VIDEO_ANALYSIS_SKILL_NAME: &str = "video-analysis";

/// Detect the best available compute backend for faster-whisper.
/// Returns (backend_id, human_label).
pub(crate) fn detect_device_backend() -> (&'static str, &'static str) {
    #[cfg(target_os = "windows")]
    {
        // Check for NVIDIA CUDA driver DLL.
        let cuda_dll = std::path::Path::new("C:\\Windows\\System32\\nvcuda.dll");
        if cuda_dll.exists() {
            return ("cuda", "NVIDIA GPU (CUDA)");
        }
        // Check for AMD ROCm / DirectML  --?not yet supported by faster-whisper,
        // but detect the hardware so the user knows they have a GPU.
        let amd_dll = std::path::Path::new("C:\\Windows\\System32\\amdhdl64.dll");
        if amd_dll.exists() {
            return ("amd-gpu", "AMD GPU (CPU 回退  --?faster-whisper 暂不支持 ROCm)");
        }
    }
    #[cfg(target_os = "macos")]
    {
        // Apple Silicon has an integrated GPU + MPS backend. faster-whisper
        // doesn't use MPS natively but CTranslate2 can leverage it.
        // Report "apple-silicon" so the user knows they have a capable GPU.
        return ("apple-silicon", "Apple Silicon (MPS  --?部分加 --?");
    }
    #[cfg(target_os = "linux")]
    {
        let cuda_so = std::path::Path::new("/usr/lib/x86_64-linux-gnu/libcuda.so");
        if cuda_so.exists() {
            return ("cuda", "NVIDIA GPU (CUDA)");
        }
        let cuda_so2 = std::path::Path::new("/usr/local/cuda/lib64/libcuda.so");
        if cuda_so2.exists() {
            return ("cuda", "NVIDIA GPU (CUDA)");
        }
    }
    ("cpu", "CPU (Intel / AMD 核显)")
}

pub(crate) fn video_analysis_skill_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| {
            h.join(".claude")
                .join("skills")
                .join(VIDEO_ANALYSIS_SKILL_NAME)
        })
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

pub(crate) fn emit_skill_runtime_progress(
    app: &AppHandle,
    skill_name: &str,
    phase: &str,
    url: &str,
    percent: u8,
    message: &str,
    downloaded: u64,
    total: u64,
) {
    let _ = app.emit(
        "skill-runtime:download:progress",
        serde_json::json!({
            "skill": skill_name,
            "phase": phase,
            "url": url,
            "percent": percent,
            "message": message,
            "downloaded": downloaded,
            "total": total,
        }),
    );
}

/// Stream a URL to a local file with skill-runtime progress events.
/// `progress_start`/`progress_end` map the file's own 0-100% into a global range.
pub(crate) async fn download_file_with_skill_progress(
    app: &AppHandle,
    skill_name: &str,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    phase: &str,
    progress_start: u8,
    progress_end: u8,
    label: &str,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    emit_skill_runtime_progress(
        app,
        skill_name,
        phase,
        url,
        progress_start,
        &format!("连接 {} ...", label),
        0,
        0,
    );

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed ({}): {}", url, e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {}", resp.status(), url));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();
    let mut file = std::fs::File::create(dest)
        .map_err(|e| format!("Failed to create {}: {}", dest.display(), e))?;

    use std::io::Write;
    let span = progress_end.saturating_sub(progress_start) as u64;
    let mut last_emit = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Write error {}: {}", dest.display(), e))?;
        downloaded += chunk.len() as u64;

        // Throttle UI updates (~every 256 KiB or on completion).
        if downloaded - last_emit >= 256 * 1024 || (total > 0 && downloaded >= total) {
            last_emit = downloaded;
            let local_pct = if total > 0 {
                (downloaded * 100 / total).min(100)
            } else {
                0
            };
            let global = progress_start as u64 + (local_pct * span / 100);
            let msg = if total > 0 {
                format!(
                    "{} {:.1}/{:.1} MB ({}%)",
                    label,
                    downloaded as f64 / 1_048_576.0,
                    total as f64 / 1_048_576.0,
                    local_pct
                )
            } else {
                format!("{} {:.1} MB", label, downloaded as f64 / 1_048_576.0)
            };
            emit_skill_runtime_progress(app, skill_name, phase, url, global as u8, &msg, downloaded, total);
        }
    }

    file.flush()
        .map_err(|e| format!("Flush error {}: {}", dest.display(), e))?;

    // 大小校验兜底：Content-Length 可得时实际字节数必须一致。
    // ffmpeg 为滚动构建（BtbN latest / gyan.dev essentials），无公开 SHA 数据源，
    // 以大小校验防止截断/镜像损坏；不匹配时删除文件避免误用坏文件。
    if total > 0 && downloaded != total {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "{} 下载不完整：预期 {} 字节，实际 {} 字节",
            label, total, downloaded
        ));
    }

    emit_skill_runtime_progress(
        app,
        skill_name,
        phase,
        url,
        progress_end,
        &format!("{} 完成 ({:.1} MB)", label, downloaded as f64 / 1_048_576.0),
        downloaded,
        total,
    );
    Ok(downloaded)
}

pub(crate) async fn download_first_ok_to_file(
    app: &AppHandle,
    skill_name: &str,
    client: &reqwest::Client,
    urls: &[&str],
    dest: &Path,
    phase: &str,
    progress_start: u8,
    progress_end: u8,
    label: &str,
) -> Result<String, String> {
    let mut last_err = String::new();
    for (i, url) in urls.iter().enumerate() {
        eprintln!("[{}] trying {} source {}: {}", skill_name, label, i, url);
        // Clean partial file before each attempt.
        let _ = std::fs::remove_file(dest);
        match download_file_with_skill_progress(
            app,
            skill_name,
            client,
            url,
            dest,
            phase,
            progress_start,
            progress_end,
            label,
        )
        .await
        {
            Ok(_) => return Ok(url.to_string()),
            Err(e) => {
                last_err = e;
                eprintln!("[{}] {} failed: {}", skill_name, url, last_err);
            }
        }
    }
    Err(format!("{} 全部镜像失败: {}", label, last_err))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeDepCheck {
    pub(crate) name: String,
    pub(crate) label: String,
    pub(crate) ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechRuntimeStatus {
    pub(crate) status: String,
    pub(crate) checks: Vec<RuntimeDepCheck>,
    pub(crate) auto_install_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) device_backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) device_backend_label: Option<String>,
}
