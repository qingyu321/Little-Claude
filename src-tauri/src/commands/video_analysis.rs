use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use tokio::process::Command;

use crate::build_smart_http_client;
use crate::commands::reveal_in_finder;
use crate::embedded_resources;
use crate::safe_data_dir;

// Runtime download / status helpers live in speech_runtime.rs (unconditionally
// compiled) so that `speech` / `wallpaper` do not depend on this optional module.
use super::speech_runtime::{
    detect_device_backend, download_first_ok_to_file, emit_skill_runtime_progress,
    video_analysis_skill_dir, RuntimeDepCheck, VIDEO_ANALYSIS_SKILL_NAME,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Bundled skills + optional runtime environment download
// ================================================================

/// China-first PyPI mirrors for manual / automatic pip installs.
const VIDEO_ANALYSIS_PIP_MIRROR_PRIMARY: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";
const VIDEO_ANALYSIS_PIP_MIRROR_FALLBACK: &str = "https://mirrors.aliyun.com/pypi/simple";
const VIDEO_ANALYSIS_PIP_TRUSTED_HOST_PRIMARY: &str = "pypi.tuna.tsinghua.edu.cn";
const VIDEO_ANALYSIS_PIP_TRUSTED_HOST_FALLBACK: &str = "mirrors.aliyun.com";

/// HuggingFace China mirror (faster-whisper model weights).
const VIDEO_ANALYSIS_HF_MIRROR: &str = "https://hf-mirror.com";

/// Build the HuggingFace repo name for a given model size.
fn whisper_repo_name(model_size: &str) -> String {
    format!("Systran/faster-whisper-{}", model_size)
}

/// Build the local model directory name for a given model size.
fn whisper_model_dir_name(model_size: &str) -> String {
    format!("faster-whisper-{}", model_size)
}

/// Read the configured ASR model size from the video-analysis config.
fn configured_asr_model_size() -> String {
    load_video_analysis_multimodal_config().asr_model_size
}

/// ffmpeg Windows x64 builds  --?China mirrors first, then upstream.
/// BtbN GPL shared build is widely mirrored; ghproxy speeds GitHub for CN users.
const VIDEO_ANALYSIS_FFMPEG_URLS: &[&str] = &[
    // China: ghproxy  --?GitHub release
    "https://mirror.ghproxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    // China: gitclone proxy
    "https://gitclone.com/github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    // Upstream GitHub
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    // Gyan essentials (smaller; good fallback)
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
];

/// Model files required under models/faster-whisper-small/
const VIDEO_ANALYSIS_WHISPER_FILES: &[&str] = &[
    "config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.txt",
];

fn video_analysis_runtime_marker(skill_dir: &Path) -> PathBuf {
    skill_dir.join(".tokenicode-runtime-installed")
}

fn video_analysis_dismiss_marker() -> Result<PathBuf, String> {
    safe_data_dir().map(|d| d.join("video-analysis-runtime-dismissed"))
}

/// Default multimodal (vision) model used by the video-analysis skill (Mode B).
/// Stored under ~/.tokenicode/video-analysis-multimodal.json
fn video_analysis_multimodal_config_path() -> Result<PathBuf, String> {
    safe_data_dir().map(|d| d.join("video-analysis-multimodal.json"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoAnalysisMultimodalConfig {
    /// OpenAI-compatible base URL, e.g. https://api.example.com/v1
    #[serde(default)]
    base_url: String,
    /// API key for the multimodal endpoint (optional if api_key_env is set)
    #[serde(default)]
    api_key: String,
    /// Name of an environment variable that holds the API key (optional if api_key is set).
    /// Example: OPENAI_API_KEY / MY_VISION_KEY. Either api_key or api_key_env is enough.
    #[serde(default)]
    api_key_env: String,
    /// Vision-capable model name
    #[serde(default)]
    model: String,
    /// Enable acceleration pipeline (VAD, scene detection, pHash dedup, grid stitching).
    /// Default false  --?existing behavior unchanged.
    #[serde(default)]
    acceleration_enabled: bool,
    /// faster-whisper ASR model size: tiny, base, small, medium, large-v2, large-v3, large-v3-turbo.
    /// Default "small"  --?good balance of speed and accuracy for Chinese.
    #[serde(default = "default_asr_model_size")]
    asr_model_size: String,
}

fn default_asr_model_size() -> String {
    "small".to_string()
}

impl VideoAnalysisMultimodalConfig {
    /// Valid env var name: starts with letter/underscore, then alnum/underscore.
    fn is_valid_env_name(name: &str) -> bool {
        let mut chars = name.chars();
        match chars.next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    }

    fn has_secret(&self) -> bool {
        !self.api_key.trim().is_empty() || !self.api_key_env.trim().is_empty()
    }

    fn is_complete(&self) -> bool {
        !self.base_url.trim().is_empty() && self.has_secret() && !self.model.trim().is_empty()
    }

    fn normalized(mut self) -> Self {
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        // Accept host without scheme; default to https.
        if !self.base_url.is_empty()
            && !self.base_url.starts_with("http://")
            && !self.base_url.starts_with("https://")
        {
            self.base_url = format!("https://{}", self.base_url);
        }
        self.api_key = self.api_key.trim().to_string();
        self.api_key_env = self.api_key_env.trim().to_string();
        // Reject invalid env names (spaces, dashes, etc.) so we never look them up.
        if !self.api_key_env.is_empty() && !Self::is_valid_env_name(&self.api_key_env) {
            self.api_key_env.clear();
        }
        self.model = self.model.trim().to_string();
        self
    }

    /// Resolve the actual secret: direct api_key wins; else read api_key_env from process env.
    fn resolve_secret(&self) -> Option<String> {
        let direct = self.api_key.trim();
        if !direct.is_empty() {
            return Some(direct.to_string());
        }
        let env_name = self.api_key_env.trim();
        if env_name.is_empty() || !Self::is_valid_env_name(env_name) {
            return None;
        }
        std::env::var(env_name)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
}

fn load_video_analysis_multimodal_config() -> VideoAnalysisMultimodalConfig {
    let Ok(path) = video_analysis_multimodal_config_path() else {
        return VideoAnalysisMultimodalConfig::default();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return VideoAnalysisMultimodalConfig::default();
    };
    let mut cfg = serde_json::from_str::<VideoAnalysisMultimodalConfig>(&raw)
        .unwrap_or_default()
        .normalized();
    // API key is stored TENC1-encrypted (same scheme as providers.json).
    // Legacy plaintext values pass through untouched.
    if cfg.api_key.starts_with(crate::commands::provider::ENC_MAGIC) {
        match crate::commands::provider::decrypt_providers(&cfg.api_key) {
            Ok(plain) => cfg.api_key = plain,
            Err(e) => {
                eprintln!("[LITTLECLAUDE:video-analysis] Failed to decrypt API key: {}", e);
                cfg.api_key.clear();
            }
        }
    }
    cfg
}

fn save_video_analysis_multimodal_config_file(
    cfg: &VideoAnalysisMultimodalConfig,
) -> Result<(), String> {
    let path = video_analysis_multimodal_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    let normalized = cfg.clone().normalized();
    let mut to_store = normalized.clone();
    // Encrypt the API key before writing; skip empty values.
    if !to_store.api_key.is_empty() && !to_store.api_key.starts_with(crate::commands::provider::ENC_MAGIC) {
        match crate::commands::provider::encrypt_providers(&to_store.api_key) {
            Ok(enc) => to_store.api_key = enc,
            Err(e) => return Err(format!("Failed to encrypt API key: {}", e)),
        }
    }
    let json = serde_json::to_string_pretty(&to_store)
        .map_err(|e| format!("Failed to serialize multimodal config: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

/// Inject TOKENICODE_VIDEO_ANALYSIS_* (+ CUSTOM_API_KEY) into CLI env when configured.
/// Secret may come from a direct api_key field OR from a named system environment variable.
pub(crate) fn inject_video_analysis_multimodal_env(env: &mut HashMap<String, String>) {
    let cfg = load_video_analysis_multimodal_config();
    if !cfg.is_complete() {
        return;
    }

    let secret = match cfg.resolve_secret() {
        Some(s) => s,
        None => {
            // Config points at an env var that is not set / empty  --?do not mark READY.
            eprintln!(
                "[tokenicode] video-analysis multimodal: api_key_env '{}' is unset or empty",
                cfg.api_key_env
            );
            return;
        }
    };

    env.insert(
        "TOKENICODE_VIDEO_ANALYSIS_BASE_URL".to_string(),
        cfg.base_url.clone(),
    );
    env.insert(
        "TOKENICODE_VIDEO_ANALYSIS_API_KEY".to_string(),
        secret.clone(),
    );
    env.insert(
        "TOKENICODE_VIDEO_ANALYSIS_MODEL".to_string(),
        cfg.model.clone(),
    );
    if !cfg.api_key_env.is_empty() {
        env.insert(
            "TOKENICODE_VIDEO_ANALYSIS_API_KEY_ENV".to_string(),
            cfg.api_key_env.clone(),
        );
        // Also expose the named env var itself so scripts using --custom-api-key-env work.
        env.entry(cfg.api_key_env.clone())
            .or_insert_with(|| secret.clone());
    }
    // Skill Mode B uses CUSTOM_API_KEY by default; inject so scripts can pick it up
    // without the agent pasting the key into the command line.
    env.entry("CUSTOM_API_KEY".to_string())
        .or_insert_with(|| secret);
    // Compact hint for the agent (no secret).
    env.insert(
        "TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY".to_string(),
        "1".to_string(),
    );

    // Inject acceleration flag so the skill can pick it up.
    if cfg.acceleration_enabled {
        env.insert(
            "TOKENICODE_VIDEO_ANALYSIS_ACCELERATE".to_string(),
            "1".to_string(),
        );
    } else {
        env.insert(
            "TOKENICODE_VIDEO_ANALYSIS_ACCELERATE".to_string(),
            "0".to_string(),
        );
    }

    // Inject ASR model size so analyze_video.py reads it as the default for --asr-model.
    env.insert(
        "TOKENICODE_VIDEO_ANALYSIS_ASR_MODEL".to_string(),
        cfg.asr_model_size.clone(),
    );
}

#[tauri::command]
pub async fn get_video_analysis_multimodal_config() -> Result<VideoAnalysisMultimodalConfig, String> {
    Ok(load_video_analysis_multimodal_config())
}

#[tauri::command]
pub async fn save_video_analysis_multimodal_config(
    config: VideoAnalysisMultimodalConfig,
) -> Result<VideoAnalysisMultimodalConfig, String> {
    let normalized = config.normalized();
    save_video_analysis_multimodal_config_file(&normalized)?;
    Ok(normalized)
}

/// Toggle acceleration only  --?does not touch API key/model fields.
#[tauri::command]
pub async fn set_video_analysis_acceleration(
    enabled: bool,
) -> Result<VideoAnalysisMultimodalConfig, String> {
    let mut cfg = load_video_analysis_multimodal_config();
    cfg.acceleration_enabled = enabled;
    save_video_analysis_multimodal_config_file(&cfg)?;
    Ok(cfg)
}

/// Set ASR model size  --?does not touch API key/model fields.
#[tauri::command]
pub async fn set_video_analysis_asr_model(
    model_size: String,
) -> Result<VideoAnalysisMultimodalConfig, String> {
    let valid_sizes = ["tiny", "base", "small", "medium", "large-v2", "large-v3", "large-v3-turbo"];
    let normalized = model_size.trim().to_lowercase();
    if !valid_sizes.contains(&normalized.as_str()) {
        return Err(format!(
            "无效的模型大 --? {}。可 --? {}",
            model_size,
            valid_sizes.join(", ")
        ));
    }
    let mut cfg = load_video_analysis_multimodal_config();
    cfg.asr_model_size = normalized;
    save_video_analysis_multimodal_config_file(&cfg)?;
    Ok(cfg)
}

fn video_analysis_primary_download_url() -> String {
    VIDEO_ANALYSIS_FFMPEG_URLS
        .first()
        .copied()
        .unwrap_or("https://pypi.tuna.tsinghua.edu.cn/simple")
        .to_string()
}

fn video_analysis_pip_install_cmd(skill_dir: &Path) -> String {
    let req = skill_dir.join("requirements.txt");
    format!(
        "python -m pip install -i {} --trusted-host {} -r \"{}\"",
        VIDEO_ANALYSIS_PIP_MIRROR_PRIMARY,
        VIDEO_ANALYSIS_PIP_TRUSTED_HOST_PRIMARY,
        req.display()
    )
}

fn video_analysis_manual_guide(skill_dir: &Path) -> String {
    let model_size = configured_asr_model_size();
    let repo = whisper_repo_name(&model_size);
    let model_dir_name = whisper_model_dir_name(&model_size);
    let model_url = format!(
        "{}/{}/tree/main",
        VIDEO_ANALYSIS_HF_MIRROR, repo
    );
    format!(
        "手动安装(国内镜像)\n\
         1) 安装 Python 3.11+ 后,在技能目录执行:\n\
         {}\n\
         备用 pip 源:-i {} --trusted-host {}\n\
         2) 下载 ffmpeg(解压后 --?ffmpeg/ffprobe 放到 bin/):\n\
         {}\n\
         3) 下载 faster-whisper-{} 模型 --?models/{}/:\n\
         {}\n\
         技能目录:{}",
        video_analysis_pip_install_cmd(skill_dir),
        VIDEO_ANALYSIS_PIP_MIRROR_FALLBACK,
        VIDEO_ANALYSIS_PIP_TRUSTED_HOST_FALLBACK,
        VIDEO_ANALYSIS_FFMPEG_URLS.first().copied().unwrap_or(""),
        model_size,
        model_dir_name,
        model_url,
        skill_dir.display()
    )
}

fn extract_ffmpeg_zip(zip_path: &Path, bin_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir)
        .map_err(|e| format!("Failed to create {}: {}", bin_dir.display(), e))?;

    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open {}: {}", zip_path.display(), e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("zip open error: {}", e))?;

    let mut found_ffmpeg = false;
    let mut found_ffprobe = false;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry error: {}", e))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let file_name = name.rsplit('/').next().unwrap_or("");
        let lower = file_name.to_ascii_lowercase();

        let target_name = if lower == "ffmpeg.exe" || lower == "ffmpeg" {
            found_ffmpeg = true;
            #[cfg(target_os = "windows")]
            {
                "ffmpeg.exe"
            }
            #[cfg(not(target_os = "windows"))]
            {
                "ffmpeg"
            }
        } else if lower == "ffprobe.exe" || lower == "ffprobe" {
            found_ffprobe = true;
            #[cfg(target_os = "windows")]
            {
                "ffprobe.exe"
            }
            #[cfg(not(target_os = "windows"))]
            {
                "ffprobe"
            }
        } else {
            continue;
        };

        let target = bin_dir.join(target_name);
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("create {}: {}", target.display(), e))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("write {}: {}", target.display(), e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
        }
    }

    if !found_ffmpeg || !found_ffprobe {
        return Err(
            "ffmpeg 压缩包中未找 --?ffmpeg/ffprobe 可执行文件,请换源或手动安装".to_string(),
        );
    }
    Ok(())
}

/// Try every available Python interpreter + flag combination to create a venv.
/// Returns `Ok(true)` if `--without-pip` was needed (caller must bootstrap pip).
///
/// Strategy order:
///   1. python  -m venv          (most common)
///   2. python3 -m venv          (Linux/macOS where `python` is missing)
///   3. py -3   -m venv          (Windows launcher)
///   4. python  -m venv --without-pip   (missing ensurepip)
///   5. python3 -m venv --without-pip
///   6. py -3   -m venv --without-pip
async fn try_create_venv(venv_dir: &Path) -> Result<bool, String> {
    let dir_str = venv_dir.to_string_lossy().to_string();

    // (command, args_tail, without_pip)
    // py launcher is Windows-only; --without-pip variants are the last resort
    #[cfg(target_os = "windows")]
    let strategies: &[(&str, &[&str], bool)] = &[
        ("python", &["-m", "venv"], false),
        ("python3", &["-m", "venv"], false),
        ("py", &["-3", "-m", "venv"], false),
        ("python", &["-m", "venv", "--without-pip"], true),
        ("python3", &["-m", "venv", "--without-pip"], true),
        ("py", &["-3", "-m", "venv", "--without-pip"], true),
    ];

    #[cfg(not(target_os = "windows"))]
    let strategies: &[(&str, &[&str], bool)] = &[
        ("python", &["-m", "venv"], false),
        ("python3", &["-m", "venv"], false),
        ("python", &["-m", "venv", "--without-pip"], true),
        ("python3", &["-m", "venv", "--without-pip"], true),
    ];

    let mut last_stderr = String::new();

    for (cmd, args, without_pip) in strategies {
        let mut full_args: Vec<&str> = args.to_vec();
        full_args.push(&dir_str);

        // Bound every strategy with a timeout: a wedged python (hung venv
        // creation) must not stall the whole install forever. kill_on_drop is
        // required — timeout() only drops the future, the child would survive.
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            Command::new(*cmd)
                .args(&full_args)
                .env("PYTHONUTF8", "1")
                .kill_on_drop(true)
                .output(),
        )
        .await;

        match output {
            Ok(Ok(o)) if o.status.success() => {
                return Ok(*without_pip);
            }
            Ok(Ok(o)) => {
                last_stderr = String::from_utf8_lossy(&o.stderr).to_string();
                // continue to next strategy
            }
            Ok(Err(_)) => {
                // binary not found — continue
            }
            Err(_) => {
                eprintln!("[video-analysis] {} {:?} timed out after 60s", cmd, full_args);
                last_stderr = format!("{} 超时(60s)", cmd);
                // continue to next strategy
            }
        }
    }

    // All strategies exhausted
    let hint = if cfg!(target_os = "linux") {
        "\n(Debian/Ubuntu: sudo apt install python3-venv)"
    } else if cfg!(target_os = "windows") {
        "\n(从 https://python.org 安装 Python 3.11+，安装时勾选 Add Python to PATH)"
    } else {
        ""
    };

    Err(format!(
        "python -m venv 失败: {}{}",
        last_stderr.trim(),
        hint
    ))
}

/// Bootstrap pip into a venv that was created with --without-pip.
/// Tries `ensurepip --upgrade` first, then falls back to downloading get-pip.py.
async fn bootstrap_pip_in_venv(app: &AppHandle, venv_python: &Path) -> Result<(), String> {
    // Strategy 1: ensurepip (usually works even when base Python's ensurepip didn't)
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        Command::new(venv_python)
            .args(["-m", "ensurepip", "--upgrade"])
            .env("PYTHONUTF8", "1")
            .kill_on_drop(true)
            .output(),
    )
    .await;

    match &output {
        Ok(Ok(o)) if o.status.success() => return Ok(()),
        _ => {}
    }
    if matches!(&output, Err(_)) {
        eprintln!(
            "[video-analysis] ensurepip timed out after 60s, falling back to get-pip.py"
        );
    }

    emit_skill_runtime_progress(
        app,
        VIDEO_ANALYSIS_SKILL_NAME,
        "python",
        "",
        73,
        "ensurepip 不可用，通过 get-pip.py 安装 pip ...",
        0,
        0,
    );

    // Strategy 2: Download get-pip.py and run it
    let client = crate::build_smart_http_client(
        std::time::Duration::from_secs(5),
        std::time::Duration::from_secs(30),
    )
    .await;

    let resp = client
        .get("https://bootstrap.pypa.io/get-pip.py")
        .send()
        .await
        .map_err(|e| format!("下载 get-pip.py 失败: {e}"))?;

    let script = resp.text().await.map_err(|e| format!("读取 get-pip.py 失败: {e}"))?;
    // Use a short temp path to avoid Windows MAX_PATH issues
    let tmp = std::env::temp_dir().join(format!("tokenicode_getpip_{}.py", std::process::id()));
    std::fs::write(&tmp, script).map_err(|e| format!("写入 get-pip.py 失败: {e}"))?;

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        Command::new(venv_python)
            .arg(&tmp)
            .env("PYTHONUTF8", "1")
            .kill_on_drop(true)
            .output(),
    )
    .await;

    let _ = std::fs::remove_file(&tmp);

    match output {
        Ok(Ok(o)) if o.status.success() => Ok(()),
        Ok(Ok(o)) => Err(format!(
            "get-pip.py 失败: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Ok(Err(e)) => Err(format!("无法启动 get-pip.py: {e}")),
        Err(_) => {
            eprintln!("[video-analysis] get-pip.py timed out after 120s");
            Err("get-pip.py 超时(120s)，请检查网络后重试".to_string())
        }
    }
}

async fn install_video_analysis_python_deps(
    app: &AppHandle,
    skill_dir: &Path,
) -> Result<(), String> {
    let requirements = skill_dir.join("requirements.txt");
    if !requirements.is_file() {
        return Err("requirements.txt missing in skill directory".to_string());
    }

    let venv_dir = skill_dir.join(".venv");
    let wheelhouse = skill_dir.join("wheelhouse");
    std::fs::create_dir_all(&wheelhouse)
        .map_err(|e| format!("Failed to create wheelhouse: {}", e))?;

    emit_skill_runtime_progress(
        app,
        VIDEO_ANALYSIS_SKILL_NAME,
        "python",
        VIDEO_ANALYSIS_PIP_MIRROR_PRIMARY,
        72,
        "创建 Python 虚拟环境 .venv ...",
        0,
        0,
    );

    #[cfg(target_os = "windows")]
    let venv_python = venv_dir.join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let venv_python = venv_dir.join("bin").join("python");

    if !venv_python.exists() {
        let used_without_pip = try_create_venv(&venv_dir).await?;
        if used_without_pip {
            // ensurepip not available in base Python — bootstrap pip into the fresh venv
            bootstrap_pip_in_venv(app, &venv_python).await?;
        }
    }

    let mirrors = [
        (
            VIDEO_ANALYSIS_PIP_MIRROR_PRIMARY,
            VIDEO_ANALYSIS_PIP_TRUSTED_HOST_PRIMARY,
        ),
        (
            VIDEO_ANALYSIS_PIP_MIRROR_FALLBACK,
            VIDEO_ANALYSIS_PIP_TRUSTED_HOST_FALLBACK,
        ),
    ];

    let mut last_err = String::new();
    for (idx, (mirror, trusted)) in mirrors.iter().enumerate() {
        emit_skill_runtime_progress(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            "python",
            mirror,
            78 + (idx as u8 * 4),
            &format!("pip 安装依赖(国内镜 --?{} --?..", mirror),
            0,
            0,
        );

        // Download wheels into wheelhouse first (so offline re-setup works later).
        // Failures here are non-fatal  --?we still try online install from the mirror.
        match tokio::time::timeout(
            std::time::Duration::from_secs(600),
            Command::new(&venv_python)
                .args([
                    "-m",
                    "pip",
                    "download",
                    "-i",
                    mirror,
                    "--trusted-host",
                    trusted,
                    "-d",
                ])
                .arg(&wheelhouse)
                .arg("-r")
                .arg(&requirements)
                .env("PYTHONUTF8", "1")
                .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            Ok(Ok(out)) if !out.status.success() => {
                eprintln!(
                    "[video-analysis] pip download failed ({}): {}",
                    mirror,
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            Ok(Err(e)) => {
                eprintln!("[video-analysis] pip download spawn failed: {}", e);
            }
            Err(_) => {
                eprintln!(
                    "[video-analysis] pip download timed out after 600s ({})",
                    mirror
                );
            }
            _ => {}
        }

        emit_skill_runtime_progress(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            "python",
            mirror,
            88,
            &format!("pip install({} --?..", mirror),
            0,
            0,
        );

        // Prefer offline wheelhouse if download succeeded; fall back to online mirror.
        match tokio::time::timeout(
            std::time::Duration::from_secs(600),
            Command::new(&venv_python)
                .args([
                    "-m",
                    "pip",
                    "install",
                    "--no-index",
                    "--find-links",
                ])
                .arg(&wheelhouse)
                .arg("-r")
                .arg(&requirements)
                .env("PYTHONUTF8", "1")
                .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            Ok(Ok(out)) if out.status.success() => {
                return Ok(());
            }
            Ok(Ok(out)) => {
                last_err = format!(
                    "offline pip install failed: {}; ",
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            Ok(Err(_)) => {
                // spawn failed — silently fall through to the online mirror
            }
            Err(_) => {
                eprintln!("[video-analysis] offline pip install timed out after 600s");
                last_err = format!("offline pip install 超时(600s); ");
            }
        }

        let online = match tokio::time::timeout(
            std::time::Duration::from_secs(600),
            Command::new(&venv_python)
                .args([
                    "-m",
                    "pip",
                    "install",
                    "-i",
                    mirror,
                    "--trusted-host",
                    trusted,
                    "-r",
                ])
                .arg(&requirements)
                .env("PYTHONUTF8", "1")
                .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(format!("pip install spawn failed: {}", e)),
            Err(_) => {
                eprintln!(
                    "[video-analysis] pip install timed out after 600s ({})",
                    mirror
                );
                last_err = format!("{}pip install 超时(600s, {}); ", last_err, mirror);
                continue; // try the fallback mirror
            }
        };

        if online.status.success() {
            return Ok(());
        }
        last_err = format!(
            "{}pip install failed ({}): {}",
            last_err,
            mirror,
            String::from_utf8_lossy(&online.stderr)
        );
    }

    Err(format!(
        "Python 依赖安装失败(已尝试清华/阿里云镜像)。\n\
         可手动执行:\n{}\n错误:{}",
        video_analysis_pip_install_cmd(skill_dir),
        last_err
    ))
}

/// M6: model.bin 大小下限（约为 faster-whisper 实际大小的 ~90%，按档位
/// 保守取值，留 ~10% 余量防镜像差异误判）。下限过低会让半下载文件通过
/// 校验且永不重下——截断到阈值之上的文件在推理时才报错。
/// tiny ~75MB→68MB、base ~145MB→130MB、small ~488MB→440MB、
/// medium ~1.4GB→1.2GB、large ~3GB→2.7GB。
fn whisper_model_min_bytes(model_size: &str) -> u64 {
    match model_size {
        "tiny" => 68 * 1024 * 1024,
        "base" => 130 * 1024 * 1024,
        "small" => 440 * 1024 * 1024,
        "medium" => 1200 * 1024 * 1024,
        "large-v2" | "large-v3" | "large-v3-turbo" => 2700 * 1024 * 1024,
        _ => 100 * 1024 * 1024,
    }
}

/// M6: 校验 whisper 模型文件——model.bin 达到档位大小下限；config.json
/// 可解析为 JSON 且声明 model_type=whisper。半下载/被投毒文件直接拒绝。
fn verify_whisper_model_files(model_dir: &Path, model_size: &str) -> Result<(), String> {
    let model_bin = model_dir.join("model.bin");
    let len = model_bin
        .metadata()
        .map(|m| m.len())
        .map_err(|e| format!("Failed to stat model.bin: {}", e))?;
    let min = whisper_model_min_bytes(model_size);
    if len < min {
        return Err(format!(
            "语音模型 model.bin 大小异常 ({} bytes < {} bytes)——下载可能被中断或被镜像投毒，请重试",
            len, min
        ));
    }
    let cfg_path = model_dir.join("config.json");
    let cfg_valid = std::fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .map_or(false, |v| {
            v.get("model_type").and_then(|t| t.as_str()) == Some("whisper")
        });
    if !cfg_valid {
        return Err(
            "语音模型 config.json 缺失或非法（应声明 model_type=whisper）——下载可能被中断，请重试"
                .to_string(),
        );
    }
    Ok(())
}

/// M6: 校验下载的 ffmpeg zip——大小下限（BtbN win64-gpl ~80-100MB、
/// Gyan essentials ~50MB+，20MB 下限足以拦截被劫持的小文件）+ zip 结构
/// 合法且含 ffmpeg/ffprobe 条目（防损坏文件解压到一半）。
fn verify_ffmpeg_zip(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Failed to stat ffmpeg zip: {}", e))?;
    if meta.len() < 20 * 1024 * 1024 {
        return Err(format!(
            "ffmpeg zip 大小异常 ({} bytes < 20MB)——下载可能被中断或被镜像投毒，请重试",
            meta.len()
        ));
    }
    let file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open ffmpeg zip: {}", e))?;
    let archive =
        zip::ZipArchive::new(file).map_err(|e| format!("ffmpeg zip 不是有效的 zip 文件: {}", e))?;
    let names: Vec<String> = archive.file_names().map(String::from).collect();
    let has = |needle: &str| names.iter().any(|n| n.ends_with(needle) || n == needle);
    if !(has("ffmpeg.exe") || has("ffmpeg")) || !(has("ffprobe.exe") || has("ffprobe")) {
        return Err("ffmpeg zip 缺少 ffmpeg/ffprobe 条目——zip 不完整，请重试".to_string());
    }
    Ok(())
}

async fn download_whisper_model(
    app: &AppHandle,
    client: &reqwest::Client,
    model_dir: &Path,
    model_size: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(model_dir)
        .map_err(|e| format!("Failed to create model dir: {}", e))?;

    let repo = whisper_repo_name(model_size);
    let total_files = VIDEO_ANALYSIS_WHISPER_FILES.len() as u8;
    for (i, file_name) in VIDEO_ANALYSIS_WHISPER_FILES.iter().enumerate() {
        let dest = model_dir.join(file_name);
        // M6: 跳过条件与 verify_whisper_model_files 同口径——model.bin 须达到
        // 档位下限、config.json 须合法，否则半下载文件会被跳过 → 校验失败
        // 死循环。其余小文件保持「非空即存在」。
        let already_ok = match *file_name {
            "model.bin" => dest
                .metadata()
                .map(|m| m.len() >= whisper_model_min_bytes(model_size))
                .unwrap_or(false),
            "config.json" => std::fs::read_to_string(&dest)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .map_or(false, |v| {
                    v.get("model_type").and_then(|t| t.as_str()) == Some("whisper")
                }),
            _ => dest.is_file() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false),
        };
        if already_ok {
            continue;
        }

        let start = 40 + (i as u8 * 30 / total_files);
        let end = 40 + ((i as u8 + 1) * 30 / total_files);
        let urls = [
            format!(
                "{}/{}/resolve/main/{}?download=true",
                VIDEO_ANALYSIS_HF_MIRROR, repo, file_name
            ),
            format!(
                "https://huggingface.co/{}/resolve/main/{}?download=true",
                repo, file_name
            ),
        ];
        let url_refs: Vec<&str> = urls.iter().map(|s| s.as_str()).collect();
        download_first_ok_to_file(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            client,
            &url_refs,
            &dest,
            "model",
            start,
            end,
            &format!("模型 {}", file_name),
        )
        .await?;
    }
    Ok(())
}

/// Locate the video-analysis skill source on disk (resource_dir or dev tree).
/// Does NOT use embedded fallback  --?the installer handles that separately so
/// files go directly to ~/.claude/skills/ without an intermediate cache.
fn find_bundled_skill_on_disk(app: &AppHandle) -> Option<PathBuf> {
    // 1) Tauri resource_dir (production bundle with external resources).
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir
                .join("bundled-skills")
                .join(VIDEO_ANALYSIS_SKILL_NAME),
            resource_dir
                .join("resources")
                .join("bundled-skills")
                .join(VIDEO_ANALYSIS_SKILL_NAME),
        ];
        if let Some(p) = candidates.into_iter().find(|p| p.join("SKILL.md").is_file()) {
            return Some(p);
        }
    }

    // 2) Dev fallback: open source tree directly when running `tauri dev`.
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("bundled-skills")
        .join(VIDEO_ANALYSIS_SKILL_NAME);
    if dev_path.join("SKILL.md").is_file() {
        return Some(dev_path);
    }

    None
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create {}: {}", dst.display(), e))?;
    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {}: {}", entry.path().display(), e))?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
            }
            std::fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "Failed to copy {}  --?{}: {}",
                    entry.path().display(),
                    target.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

/// Install only the skill body (SKILL.md + scripts + docs). Runtime deps stay optional.
///
/// Sources are tried in order:
/// 1. On-disk Tauri resource directory (bundled app)
/// 2. Dev source tree (`tauri dev`)
/// 3. Embedded binary via `rust-embed`  --?extracted directly to destination,
///    no intermediate persistent cache (standalone portable .exe).
pub(crate) fn install_bundled_video_analysis_skill(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = video_analysis_skill_dir()?;

    // Clean old skill-body files (not runtime dirs: .venv, models, wheelhouse, bin, video-results).
    if dest.exists() {
        for name in [
            "SKILL.md",
            "README.md",
            "USAGE.md",
            "requirements.txt",
            "setup_offline.bat",
            "setup_offline.sh",
            "scripts",
            "tests",
        ] {
            let p = dest.join(name);
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else if p.is_file() {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    // Try on-disk sources first (resource_dir, dev tree).
    if let Some(src) = find_bundled_skill_on_disk(app) {
        copy_dir_recursive(&src, &dest)?;
        eprintln!(
            "[tokenicode] Installed skill from disk: {}  --?{}",
            src.display(),
            dest.display()
        );
    } else {
        // Standalone portable .exe  --?extract directly from embedded binary.
        embedded_resources::extract_skill_to(VIDEO_ANALYSIS_SKILL_NAME, &dest)?;
    }

    Ok(dest)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillRuntimeStatus {
    skill_name: String,
    skill_installed: bool,
    skill_path: Option<String>,
    runtime_installed: bool,
    dismissed: bool,
    download_url: String,
    missing: Vec<String>,
    message: String,
    /// China-first pip mirror for manual installs.
    pip_mirror: String,
    /// Fallback pip mirror.
    pip_mirror_fallback: String,
    /// One-line pip install command using the China mirror.
    pip_install_cmd: String,
    /// Multi-line manual install guide (ffmpeg + model + pip).
    manual_guide: String,
    /// HuggingFace China mirror for the ASR model.
    model_mirror: String,
    /// High-level status for frontend dispatch.
    #[serde(default)]
    status: String,
    /// Per-dependency check results.
    #[serde(default)]
    checks: Vec<RuntimeDepCheck>,
    /// Whether one-click auto-install is supported on the current platform.
    #[serde(default)]
    auto_install_supported: bool,
    /// Whether an install is currently in-flight (singleton guard).
    #[serde(default)]
    installing: bool,
    /// Detected compute device backend: "cuda", "amd-gpu", "apple-silicon", or "cpu".
    #[serde(default)]
    device_backend: String,
    /// Human-readable device label for UI display.
    #[serde(default)]
    device_backend_label: String,
}

fn inspect_video_analysis_runtime(skill_dir: &Path) -> (bool, Vec<String>) {
    let mut missing = Vec::new();

    #[cfg(target_os = "windows")]
    let ffmpeg = skill_dir.join("bin").join("ffmpeg.exe");
    #[cfg(target_os = "windows")]
    let ffprobe = skill_dir.join("bin").join("ffprobe.exe");
    #[cfg(not(target_os = "windows"))]
    let ffmpeg = skill_dir.join("bin").join("ffmpeg");
    #[cfg(not(target_os = "windows"))]
    let ffprobe = skill_dir.join("bin").join("ffprobe");

    let model_size = configured_asr_model_size();
    let model_dir_name = whisper_model_dir_name(&model_size);

    // Model is ready when at least model.bin exists (other files may stream later).
    let model_bin = skill_dir
        .join("models")
        .join(&model_dir_name)
        .join("model.bin");
    let model_dir = skill_dir.join("models").join(&model_dir_name);

    #[cfg(target_os = "windows")]
    let venv_python = skill_dir.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let venv_python = skill_dir.join(".venv").join("bin").join("python");

    let checks: Vec<(&str, bool)> = vec![
        ("bin/ffmpeg", ffmpeg.is_file()),
        ("bin/ffprobe", ffprobe.is_file()),
        (
            "models/faster-whisper",
            model_dir.is_dir() && (model_bin.is_file() || model_dir.join("config.json").is_file()),
        ),
        (".venv", venv_python.is_file()),
    ];

    for (label, ok) in checks {
        if !ok {
            missing.push(label.to_string());
        }
    }

    // Marker means a previous install finished; still re-check core binaries.
    if video_analysis_runtime_marker(skill_dir).exists() && missing.is_empty() {
        return (true, missing);
    }
    (missing.is_empty(), missing)
}

#[tauri::command]
pub async fn get_video_analysis_runtime_status() -> Result<SkillRuntimeStatus, String> {
    let skill_dir = video_analysis_skill_dir()?;
    let skill_installed = skill_dir.join("SKILL.md").is_file();
    let (runtime_installed, missing) = if skill_installed {
        inspect_video_analysis_runtime(&skill_dir)
    } else {
        (
            false,
            vec![
                "skill body".into(),
                "bin/ffmpeg".into(),
                "models".into(),
                ".venv".into(),
            ],
        )
    };
    let dismissed = video_analysis_dismiss_marker()
        .map(|p| p.exists())
        .unwrap_or(false);

    // Build structured check results
    let mut checks: Vec<RuntimeDepCheck> = Vec::new();
    let add_check = |checks: &mut Vec<RuntimeDepCheck>, name: &str, label: &str, ready: bool, detail: Option<&str>| {
        checks.push(RuntimeDepCheck {
            name: name.to_string(),
            label: label.to_string(),
            ready,
            detail: detail.map(|d| d.to_string()),
        });
    };

    #[cfg(target_os = "windows")]
    let ffmpeg_check = skill_dir.join("bin").join("ffmpeg.exe");
    #[cfg(target_os = "windows")]
    let ffprobe_check = skill_dir.join("bin").join("ffprobe.exe");
    #[cfg(not(target_os = "windows"))]
    let ffmpeg_check = skill_dir.join("bin").join("ffmpeg");
    #[cfg(not(target_os = "windows"))]
    let ffprobe_check = skill_dir.join("bin").join("ffprobe");

    let asr_model_size = configured_asr_model_size();
    let model_dir = skill_dir.join("models").join(whisper_model_dir_name(&asr_model_size));
    let model_bin = model_dir.join("model.bin");
    #[cfg(target_os = "windows")]
    let venv_python = skill_dir.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let venv_python = skill_dir.join(".venv").join("bin").join("python");

    let ffmpeg_ok = ffmpeg_check.is_file();
    let ffprobe_ok = ffprobe_check.is_file();
    let model_ok = model_dir.is_dir() && (model_bin.is_file() || model_dir.join("config.json").is_file());
    let venv_ok = venv_python.is_file();

    // Try to get real version strings for ffmpeg/ffprobe (lightweight, timeout-protected).
    let ffmpeg_detail = if ffmpeg_ok {
        let mut c = std::process::Command::new(&ffmpeg_check);
        #[cfg(target_os = "windows")]
        {
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        c.arg("-version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .ok()
            .and_then(|o| {
                let first_line = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                if first_line.is_empty() { None } else { Some(first_line) }
            })
    } else { None };

    add_check(&mut checks, "ffmpeg", "ffmpeg", ffmpeg_ok, ffmpeg_detail.as_deref());
    add_check(&mut checks, "ffprobe", "ffprobe", ffprobe_ok, None);
    add_check(&mut checks, "whisper_model", &format!("faster-whisper-{} 模型", asr_model_size), model_ok, None);
    add_check(&mut checks, "python_venv", "Python 虚拟环境 + 依赖", venv_ok, None);

    let status_label = if !skill_installed {
        "body-only"
    } else if runtime_installed {
        "ready"
    } else {
        "need-download"
    };

    let message = if !skill_installed {
        "video-analysis 技能本体尚未安装".to_string()
    } else if runtime_installed {
        "运行环境已就绪(ffmpeg / 模型 / Python 依赖)".to_string()
    } else {
        format!(
            "技能本体已安装,但运行环境未下载。缺少:{}",
            if missing.is_empty() {
                "未知".to_string()
            } else {
                missing.join(", ")
            }
        )
    };

    // Auto-install supported on Windows x64 (has pre-built ffmpeg URLs and venv logic).
    let auto_supported = cfg!(target_os = "windows") && cfg!(target_arch = "x86_64");
    let (device_backend, device_backend_label) = detect_device_backend();

    Ok(SkillRuntimeStatus {
        skill_name: VIDEO_ANALYSIS_SKILL_NAME.to_string(),
        skill_installed,
        skill_path: skill_installed.then(|| skill_dir.to_string_lossy().to_string()),
        runtime_installed,
        dismissed,
        download_url: video_analysis_primary_download_url(),
        missing,
        message,
        pip_mirror: VIDEO_ANALYSIS_PIP_MIRROR_PRIMARY.to_string(),
        pip_mirror_fallback: VIDEO_ANALYSIS_PIP_MIRROR_FALLBACK.to_string(),
        pip_install_cmd: video_analysis_pip_install_cmd(&skill_dir),
        manual_guide: video_analysis_manual_guide(&skill_dir),
        model_mirror: format!(
            "{}/{}/tree/main",
            VIDEO_ANALYSIS_HF_MIRROR,
            whisper_repo_name(&asr_model_size)
        ),
        status: status_label.to_string(),
        checks,
        auto_install_supported: auto_supported,
        installing: false, // checked on the first call; concurrent requests get existing state
        device_backend: device_backend.to_string(),
        device_backend_label: device_backend_label.to_string(),
    })
}

#[tauri::command]
pub async fn dismiss_video_analysis_runtime_prompt() -> Result<(), String> {
    let marker = video_analysis_dismiss_marker()?;
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    std::fs::write(&marker, b"1")
        .map_err(|e| format!("Failed to write dismiss marker: {}", e))?;
    Ok(())
}

/// Open the skill directory in the system file manager so the user can install manually.
#[tauri::command]
pub async fn open_video_analysis_skill_dir() -> Result<String, String> {
    let skill_dir = video_analysis_skill_dir()?;
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill dir: {}", e))?;
    // Reuse reveal_in_finder semantics for a folder.
    let path = skill_dir.to_string_lossy().to_string();
    reveal_in_finder(path.clone()).await?;
    Ok(path)
}

/// Download + install video-analysis runtime using China-first mirrors:
/// 1) ffmpeg/ffprobe zip  2) faster-whisper model  3) pip deps via Tsinghua/Aliyun
#[tauri::command]
pub async fn download_video_analysis_runtime(app: AppHandle) -> Result<SkillRuntimeStatus, String> {
    // L5: 安装中标志——防止并发重复下载（ffmpeg ~100MB + whisper 模型 ~460MB，
    // 并发下载既浪费带宽又互相覆盖文件）。
    static INSTALLING: std::sync::OnceLock<std::sync::atomic::AtomicBool> =
        std::sync::OnceLock::new();
    let flag = INSTALLING.get_or_init(|| std::sync::atomic::AtomicBool::new(false));
    if flag.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("video-analysis 运行环境正在安装中，请稍候再试".to_string());
    }
    let result = download_video_analysis_runtime_inner(&app).await;
    flag.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

/// L5: 实际安装流程——由外层命令函数包一层，失败路径统一清理
/// tokenicode-va-runtime-{pid} 临时目录，不再残留半下载文件。
async fn download_video_analysis_runtime_inner(
    app: &AppHandle,
) -> Result<SkillRuntimeStatus, String> {
    let skill_dir = video_analysis_skill_dir()?;
    if !skill_dir.join("SKILL.md").is_file() {
        return Err(
            "video-analysis skill body is not installed yet. Restart the app first.".to_string(),
        );
    }

    let primary_url = video_analysis_primary_download_url();
    emit_skill_runtime_progress(
        app,
        VIDEO_ANALYSIS_SKILL_NAME,
        "starting",
        &primary_url,
        0,
        "准备通过国内镜像下载运行环境...",
        0,
        0,
    );

    let client = build_smart_http_client(
        std::time::Duration::from_secs(15),
        // Large archives (ffmpeg ~100MB+, model ~460MB) need a long timeout.
        std::time::Duration::from_secs(60 * 30),
    )
    .await;

    let tmp_dir = std::env::temp_dir().join(format!(
        "tokenicode-va-runtime-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // 安装主体：内部任何 `?` 失败统一经下方 match 清理 tmp_dir
    let body = async {

    // ---- 1) ffmpeg (0%  --?35%) ----
    let bin_dir = skill_dir.join("bin");
    #[cfg(target_os = "windows")]
    let ffmpeg_ready = bin_dir.join("ffmpeg.exe").is_file() && bin_dir.join("ffprobe.exe").is_file();
    #[cfg(not(target_os = "windows"))]
    let ffmpeg_ready = bin_dir.join("ffmpeg").is_file() && bin_dir.join("ffprobe").is_file();

    if !ffmpeg_ready {
        let zip_path = tmp_dir.join("ffmpeg.zip");
        let used = download_first_ok_to_file(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            &client,
            VIDEO_ANALYSIS_FFMPEG_URLS,
            &zip_path,
            "ffmpeg",
            2,
            30,
            "ffmpeg",
        )
        .await?;
        // M6: ffmpeg 下载没有官方 .sha256 源——至少校验大小下限 + zip 结构
        // 合法（防镜像返回损坏/被劫持的小文件），通过后再解压。
        verify_ffmpeg_zip(&zip_path)?;
        emit_skill_runtime_progress(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            "extracting",
            &used,
            32,
            "解压 ffmpeg / ffprobe  --?bin/ ...",
            0,
            0,
        );
        extract_ffmpeg_zip(&zip_path, &bin_dir)?;
        let _ = std::fs::remove_file(&zip_path);
        emit_skill_runtime_progress(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            "ffmpeg",
            &used,
            35,
            "ffmpeg 安装完成",
            0,
            0,
        );
    } else {
        emit_skill_runtime_progress(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            "ffmpeg",
            &primary_url,
            35,
            "ffmpeg 已存在,跳过下载",
            0,
            0,
        );
    }

    // ---- 2) faster-whisper model (35%  --?70%) ----
    let model_size = configured_asr_model_size();
    let model_dir = skill_dir.join("models").join(whisper_model_dir_name(&model_size));
    // M6: 安装守卫与 download_whisper_model 内的跳过条件同口径——直接复用
    // verify_whisper_model_files（model.bin 达到档位下限 + config.json 合法），
    // 半下载文件不会绕过校验分支（只查 model.bin 大小的旧守卫会放行截断文件）。
    if verify_whisper_model_files(&model_dir, &model_size).is_ok() {
        emit_skill_runtime_progress(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            "model",
            VIDEO_ANALYSIS_HF_MIRROR,
            70,
            "语音模型已存在,跳过下载",
            0,
            0,
        );
    } else {
        download_whisper_model(app, &client, &model_dir, &model_size).await?;
        // M6: model.bin 大小下限 + config.json 合法性校验（防供应链投毒/
        // 半下载损坏）——校验失败时重下不会陷入「跳过→校验失败」死循环。
        verify_whisper_model_files(&model_dir, &model_size)?;
        emit_skill_runtime_progress(
            app,
            VIDEO_ANALYSIS_SKILL_NAME,
            "model",
            VIDEO_ANALYSIS_HF_MIRROR,
            70,
            "语音模型安装完成",
            0,
            0,
        );
    }

    // ---- 3) Python deps via China pip mirrors (70%  --?98%) ----
    install_video_analysis_python_deps(app, &skill_dir).await?;
    emit_skill_runtime_progress(
        app,
        VIDEO_ANALYSIS_SKILL_NAME,
        "python",
        VIDEO_ANALYSIS_PIP_MIRROR_PRIMARY,
        98,
        "Python 依赖安装完成",
        0,
        0,
    );

    // Write marker + clear dismiss.
    std::fs::write(
        video_analysis_runtime_marker(&skill_dir),
        format!(
            "installed\nffmpeg_primary={}\npip_mirror={}\nmodel_mirror={}\ninstalled_at_unix={}\n",
            primary_url,
            VIDEO_ANALYSIS_PIP_MIRROR_PRIMARY,
            VIDEO_ANALYSIS_HF_MIRROR,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        ),
    )
    .map_err(|e| format!("Failed to write runtime marker: {}", e))?;

    if let Ok(marker) = video_analysis_dismiss_marker() {
        let _ = std::fs::remove_file(marker);
    }

    let _ = std::fs::remove_dir_all(&tmp_dir);

    emit_skill_runtime_progress(
        app,
        VIDEO_ANALYSIS_SKILL_NAME,
        "complete",
        &primary_url,
        100,
        "运行环境安装完成",
        0,
        0,
    );

    get_video_analysis_runtime_status().await
    };
    match body.await {
        Ok(status) => Ok(status),
        Err(e) => {
            // L5: 失败路径清理临时目录（ffmpeg.zip / 半下载模型残留）
            let _ = std::fs::remove_dir_all(&tmp_dir);
            Err(e)
        }
    }
}
