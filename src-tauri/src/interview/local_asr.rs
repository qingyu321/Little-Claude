//! 本地 ASR 引擎 — 基于 sherpa-onnx OfflineRecognizer + SenseVoice 多语言模型。
//!
//! 仅在启用 `local-asr` feature 时编译。
//! 使用 SenseVoice Small INT8 模型 (zh/en/ja/ko/yue)，~240MB，2 个文件。
//!
//! 模型文件：
//! - model.int8.onnx  — INT8 量化 SenseVoice 模型
//! - tokens.txt       — 词表

use std::path::PathBuf;

use crate::commands::download_cancel::{self, CancelScope};

// ============================================================
// 条件编译：仅在 local-asr feature 启用时编译实际逻辑
// ============================================================

#[cfg(feature = "local-asr")]
mod engine {
    use std::path::{Path, PathBuf};
    use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};

    /// 默认采样率（SenseVoice 模型要求 16kHz）
    pub const MODEL_SAMPLE_RATE: i32 = 16000;

    /// 本地 ASR 引擎（基于 sherpa-onnx OfflineRecognizer + SenseVoice）
    pub struct LocalAsrEngine {
        recognizer: OfflineRecognizer,
        model_dir: PathBuf,
        initialized: bool,
    }

    unsafe impl Send for LocalAsrEngine {}
    unsafe impl Sync for LocalAsrEngine {}

    impl LocalAsrEngine {
        /// 创建引擎并加载 SenseVoice 模型。
        ///
        /// `model_dir` 应包含 `model.int8.onnx` 和 `tokens.txt`。
        pub fn new(model_dir: &Path) -> Result<Self, String> {
            let model_dir = model_dir.to_path_buf();

            let model_path = model_dir.join("model.int8.onnx");
            let tokens_path = model_dir.join("tokens.txt");

            if !model_path.is_file() {
                return Err(format!(
                    "Model file not found: {}\nPlease download the ASR model first.",
                    model_path.display()
                ));
            }
            if !tokens_path.is_file() {
                return Err(format!(
                    "Tokens file not found: {}\nPlease download the ASR model first.",
                    tokens_path.display()
                ));
            }

            let mut config = OfflineRecognizerConfig::default();
            config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                model: Some(model_path.to_string_lossy().to_string()),
                language: Some("auto".to_string()),
                use_itn: true,
            };
            config.model_config.tokens = Some(tokens_path.to_string_lossy().to_string());
            config.model_config.num_threads = 2;
            config.model_config.provider = Some("cpu".to_string());

            let recognizer = OfflineRecognizer::create(&config)
                .ok_or_else(|| "Failed to create OfflineRecognizer — check model files".to_string())?;

            eprintln!(
                "[local-asr] SenseVoice engine initialized from {}",
                model_dir.display()
            );

            Ok(Self {
                recognizer,
                model_dir,
                initialized: true,
            })
        }

        /// 转录音频样本为文本。
        ///
        /// `samples`: f32 数组，值范围 [-1.0, 1.0]
        /// `sample_rate`: 输入采样率（应为 16000）
        pub fn transcribe(&self, samples: &[f32], sample_rate: i32) -> Result<String, String> {
            if samples.is_empty() {
                return Ok(String::new());
            }
            let stream = self.recognizer.create_stream();
            stream.accept_waveform(sample_rate, samples);
            self.recognizer.decode(&stream);
            stream
                .get_result()
                .map(|r| r.text)
                .ok_or_else(|| "No recognition result".to_string())
        }

        /// 模型路径
        pub fn model_dir(&self) -> &Path {
            &self.model_dir
        }

        /// 是否已初始化
        pub fn is_initialized(&self) -> bool {
            self.initialized
        }
    }
}

// ============================================================
// Stub：默认构建（不含 local-asr）的占位实现
// ============================================================

#[cfg(not(feature = "local-asr"))]
mod engine {
    use std::path::Path;

    pub struct LocalAsrEngine {
        _private: (),
    }
    pub const MODEL_SAMPLE_RATE: i32 = 16000;

    unsafe impl Send for LocalAsrEngine {}
    unsafe impl Sync for LocalAsrEngine {}

    impl LocalAsrEngine {
        pub fn new(_model_dir: &Path) -> Result<Self, String> {
            Err("Local ASR is not compiled (missing 'local-asr' feature)".to_string())
        }
        pub fn transcribe(
            &self,
            _samples: &[f32],
            _sample_rate: i32,
        ) -> Result<String, String> {
            Err("Local ASR not compiled".to_string())
        }
        pub fn model_dir(&self) -> &Path {
            Path::new("")
        }
        pub fn is_initialized(&self) -> bool {
            false
        }
    }
}

// ============================================================
// 公共 API
// ============================================================

pub use engine::LocalAsrEngine;
pub use engine::MODEL_SAMPLE_RATE;

/// 模型下载镜像源（按优先级排序）。
/// 注意：zh-en-only 模型在 HuggingFace 上为私有仓库，请使用多语言版本 (zh/en/ja/ko/yue)。
pub const MODEL_DOWNLOAD_URLS: &[(&str, &str)] = &[
    // HF-Mirror (国内 HuggingFace 镜像 — 实测可下载)
    (
        "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
        "HF-Mirror (国内镜像)",
    ),
    // HuggingFace 官方（国内可能被墙，作为后备）
    (
        "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
        "HuggingFace (全球)",
    ),
];

/// 模型文件列表（SenseVoice 多语言 INT8 量化模型）
pub const MODEL_FILES: &[&str] = &[
    "model.int8.onnx", // ~239 MB
    "tokens.txt",      // ~316 KB
];

/// 返回模型默认安装目录
pub fn default_model_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::safe_data_dir_name())
        .join("models")
        .join("sensevoice")
}

// ============================================================
// Tauri 命令
// ============================================================

/// 检查本地 ASR 模型是否已安装
#[tauri::command]
pub fn check_local_asr_model() -> Result<serde_json::Value, String> {
    let model_dir = default_model_dir();
    let installed = MODEL_FILES.iter().all(|f| model_dir.join(f).is_file());
    Ok(serde_json::json!({
        "installed": installed,
        "model_dir": model_dir.to_string_lossy(),
        "files": if installed {
            MODEL_FILES.iter().map(|f| f.to_string()).collect::<Vec<_>>()
        } else {
            vec![]
        },
    }))
}

/// 检查 sherpa-onnx 运行时是否可用（feature 是否编译进去）
#[tauri::command]
pub fn check_local_asr_runtime() -> serde_json::Value {
    serde_json::json!({
        "available": cfg!(feature = "local-asr"),
        "engine": "sherpa-onnx (SenseVoice OfflineRecognizer)",
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// 构建 HTTP 客户端（支持系统代理环境变量 https_proxy/http_proxy）
fn build_download_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(1200)); // 20 分钟超时（模型 ~240MB）

    // 读取系统代理环境变量
    if let Ok(proxy_url) = std::env::var("https_proxy")
        .or_else(|_| std::env::var("HTTPS_PROXY"))
        .or_else(|_| std::env::var("http_proxy"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
    {
        if !proxy_url.is_empty() {
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                builder = builder.proxy(proxy);
                eprintln!("[local-asr] Using proxy: {}", proxy_url);
            }
        }
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// 下载本地 ASR 模型（异步，通过事件报告进度，进度数值基于字节数）。
///
/// 流式写盘 + 断点续传：
/// - 先写 `<文件>.part` 临时文件，下载完成并校验通过后再 rename 为最终文件；
/// - `.part` 已存在且大小 > 0 时发送 `Range: bytes={len}-` 续传（配合 If-Range
///   与上次记录的 ETag；服务器返回 206 则追加写，200 则截断重写，不支持
///   Range 时从零重下）；
/// - 完整性校验：比对响应 Content-Length 与实际字节数，不一致删除 .part 并报错；
///   全量下载时响应带 Content-MD5 则顺带校验（HuggingFace 无公开 SHA 数据源，
///   以大小校验 + 可选 MD5/ETag 兜底）。
///
/// mirror_index: None=自动尝试所有镜像, Some(0)=HF-Mirror, Some(1)=HuggingFace
#[tauri::command]
pub async fn download_local_asr_model(
    app: tauri::AppHandle,
    mirror_index: Option<usize>,
    scope_id: Option<String>,
) -> Result<String, String> {
    use tauri::Emitter;

    let scope = CancelScope::new(scope_id.as_deref());

    let model_dir = default_model_dir();
    std::fs::create_dir_all(&model_dir)
        .map_err(|e| format!("Failed to create model dir: {}", e))?;

    let client = build_download_client()?;

    // 确定要尝试的镜像列表
    let mirrors: Vec<(usize, &str, &str)> = if let Some(idx) = mirror_index {
        if let Some(&(url, name)) = MODEL_DOWNLOAD_URLS.get(idx) {
            vec![(idx, url, name)]
        } else {
            return Err(format!("Invalid mirror index {}", idx));
        }
    } else {
        MODEL_DOWNLOAD_URLS
            .iter()
            .enumerate()
            .map(|(i, &(url, name))| (i, url, name))
            .collect()
    };

    let mut last_err = String::new();
    let mut total_bytes: u64 = 0;

    for (mirror_idx, base_url, name) in &mirrors {
        if scope.is_cancelled() {
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }

        eprintln!(
            "[local-asr] Trying mirror {}: {} ({})",
            mirror_idx, name, base_url
        );

        // Pre-flight check — 先试 tokens.txt（小文件）
        let check_url = format!("{}/tokens.txt", base_url);
        match client.head(&check_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                eprintln!(
                    "[local-asr] Mirror {} reachable (HTTP {})",
                    name,
                    resp.status()
                );
            }
            Ok(resp) => {
                last_err = format!(
                    "镜像 {} 不可用 (HTTP {})。URL: {}",
                    name,
                    resp.status(),
                    check_url
                );
                eprintln!("[local-asr] {}", last_err);
                continue;
            }
            Err(e) => {
                last_err = format!("无法连接镜像 {}：{}", name, e);
                eprintln!("[local-asr] {}", last_err);
                continue;
            }
        }

        // 下载所有文件
        let total = MODEL_FILES.len();
        let mut success = true;
        for (i, file_name) in MODEL_FILES.iter().enumerate() {
            let url = format!("{}/{}", base_url, file_name);
            let dest = model_dir.join(file_name);

            // 已存在且非空的最终文件跳过：镜像切换重试时 240MB 大文件不白下，
            // 也不覆盖磁盘上已安装的完好模型。
            if dest.exists() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                eprintln!("[local-asr] {} already present, skipping", file_name);
                continue;
            }

            let _ = app.emit(
                "local-asr:download-progress",
                serde_json::json!({
                    "file": file_name,
                    "current": 0,
                    "total": 0,
                    "status": "downloading",
                    "mirror": name,
                }),
            );

            match download_model_file(&app, &client, &url, &dest, name, &scope).await {
                Ok(bytes) => {
                    total_bytes += bytes;
                    eprintln!(
                        "[local-asr] Downloaded {}/{}: {} ({} bytes) from {}",
                        i + 1,
                        total,
                        file_name,
                        bytes,
                        name
                    );
                }
                Err(e) => {
                    if download_cancel::is_cancelled_err(&e) {
                        // 用户取消：.part 已在内部清理，直接向上传播（不尝试下一镜像）
                        return Err(e);
                    }
                    last_err = format!("下载 {} 失败: {}", file_name, e);
                    eprintln!("[local-asr] {}", last_err);
                    success = false;
                    break;
                }
            }
        }

        // 如果中间有失败：绝不删除已安装/已下好的最终文件（240MB 模型删了
        // 要全量重下，且可能误删用户磁盘上完好的旧模型）。只清掉当前镜像留下
        // 的 .part/.etag —— 跨镜像续传会把两个镜像的部分内容混成一个文件
        // （If-Range 的 ETag 来自上一镜像，两镜像内容不一致时无法检出），
        // 因此换镜像必须强制全量重下。
        if !success {
            for file_name in MODEL_FILES {
                let _ = std::fs::remove_file(model_dir.join(format!("{}.part", file_name)));
                let _ = std::fs::remove_file(model_dir.join(format!("{}.etag", file_name)));
            }
            continue;
        }

        let _ = app.emit(
            "local-asr:download-progress",
            serde_json::json!({
                "file": "",
                "current": total_bytes,
                "total": total_bytes,
                "status": "done",
                "mirror": name,
            }),
        );

        eprintln!(
            "[local-asr] Model downloaded successfully from {} to {}",
            name,
            model_dir.display()
        );
        return Ok(model_dir.to_string_lossy().to_string());
    }

    if scope.is_cancelled() {
        return Err(download_cancel::CANCELLED_ERROR.to_string());
    }

    Err(format!(
        "所有镜像下载失败。最后的错误：{}\n\n请检查网络连接，或在系统环境变量中设置 https_proxy 后重启应用。",
        last_err
    ))
}

/// 下载单个模型文件：流式写 `.part` → 校验 → rename 为最终文件。
///
/// 断点续传：
/// - `.part` 已存在且大小 > 0 → 发送 `Range: bytes={len}-`；
/// - 响应 206（配合 If-Range 的 ETag 确认资源未变）→ 追加写；
/// - 响应 200（服务器不支持 Range / 资源已变化）→ 截断重写；
/// - 校验失败时删除 `.part`（`.etag` 一并清理）；用户取消时保留
///   `.part`/`.etag` 供下次断点续传。
async fn download_model_file(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
    mirror_name: &str,
    scope: &CancelScope,
) -> Result<u64, String> {
    use tauri::Emitter;

    let part_path = std::path::PathBuf::from(format!("{}.part", dest.display()));
    let etag_path = std::path::PathBuf::from(format!("{}.etag", dest.display()));

    // 已有部分文件 → 尝试断点续传
    let existing = part_path
        .metadata()
        .ok()
        .map(|m| m.len())
        .filter(|&l| l > 0);

    let mut req = client.get(url);
    if let Some(len) = existing {
        req = req.header(reqwest::header::RANGE, format!("bytes={}-", len));
        // If-Range：服务器确认资源未变才返回 206 续传；变了返回 200 全量 → 截断重下
        if let Ok(etag) = std::fs::read_to_string(&etag_path) {
            let etag = etag.trim().to_string();
            if !etag.is_empty() {
                req = req.header(reqwest::header::IF_RANGE, etag);
            }
        }
    }

    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("下载 {} 失败: {}", url, e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading {}", resp.status(), url));
    }

    // 206 = 续传（追加写）；其他成功状态码 = 全量（截断重写）
    let resume = existing.is_some() && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;

    // Content-Length：206 时是剩余字节数，加上已有部分即为文件总大小
    let expected_total: Option<u64> = match (existing, resp.content_length()) {
        (Some(len), Some(rem)) if resume => Some(len + rem),
        (_, Some(total)) => Some(total),
        _ => None,
    };

    // Content-MD5（base64 编码的 16 字节摘要）仅在非续传时可信（206 只回传部分实体）。
    // reqwest::header 无 CONTENT_MD5 常量（http crate 未收录该头），用 HeaderName 构造。
    let content_md5 = if resume {
        None
    } else {
        // from_static 是 infallible 的（编译期校验头名合法性）
        let hdr = reqwest::header::HeaderName::from_static("content-md5");
        resp.headers()
            .get(hdr)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };

    // 记录 ETag 到 sidecar，供下次续传的 If-Range 使用
    // （资源变化时服务器返回 200 全量，自动截断重下）
    if let Some(etag) = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
    {
        if !etag.is_empty() {
            let _ = std::fs::write(&etag_path, etag);
        }
    }

    // 打开 .part：续传追加，全量截断（含 200 重下场景）
    let mut file = if resume {
        std::fs::OpenOptions::new().append(true).open(&part_path)
    } else {
        std::fs::File::create(&part_path)
    }
    .map_err(|e| format!("打开临时文件失败 {}: {}", part_path.display(), e))?;

    use std::io::Write;
    let file_label = dest
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut downloaded: u64 = if resume { existing.unwrap_or(0) } else { 0 };
    let mut last_emit = 0u64;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取 {} 数据失败: {}", file_label, e))?
    {
        if scope.is_cancelled() {
            // 取消：保留 .part/.etag 供下次断点续传（240MB 文件下了一半不该作废）
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }

        file.write_all(&chunk)
            .map_err(|e| format!("写入 {} 失败: {}", part_path.display(), e))?;
        downloaded += chunk.len() as u64;

        // 节流进度事件（~256 KiB 一次，或下载完成时），数值基于字节数
        if downloaded - last_emit >= 256 * 1024
            || expected_total.map_or(false, |t| downloaded >= t)
        {
            last_emit = downloaded;
            let _ = app.emit(
                "local-asr:download-progress",
                serde_json::json!({
                    "file": file_label,
                    "current": downloaded,
                    "total": expected_total.unwrap_or(0),
                    "status": "downloading",
                    "mirror": mirror_name,
                }),
            );
        }
    }

    file.flush()
        .map_err(|e| format!("写入 {} 失败: {}", part_path.display(), e))?;
    file.sync_all()
        .map_err(|e| format!("写入 {} 失败: {}", part_path.display(), e))?;
    drop(file);

    // 1) 大小校验（Content-Length 可得时实际字节数必须一致，防止截断/镜像损坏）
    if let Some(expected) = expected_total {
        if downloaded != expected {
            let _ = std::fs::remove_file(&part_path);
            let _ = std::fs::remove_file(&etag_path);
            return Err(format!(
                "{} 下载不完整：预期 {} 字节，实际 {} 字节",
                file_label, expected, downloaded
            ));
        }
    }

    // 2) Content-MD5 顺带校验（仅全量下载；HuggingFace 通常不发送该头，缺失即跳过）
    if let Some(md5_b64) = content_md5 {
        match verify_content_md5(&part_path, &md5_b64) {
            Ok(true) => {
                eprintln!("[local-asr] {} Content-MD5 verified", file_label);
            }
            Ok(false) => {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(&etag_path);
                return Err(format!("{} 校验和 (Content-MD5) 不匹配", file_label));
            }
            Err(e) => {
                // 校验器自身失败（如 base64 解析错误）不算下载失败，仅记录日志
                eprintln!(
                    "[local-asr] {} Content-MD5 check skipped: {}",
                    file_label, e
                );
            }
        }
    }

    // 3) 校验通过：rename 为最终文件
    if let Err(e) = std::fs::rename(&part_path, dest) {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "移动 {} 到最终位置失败: {}",
            part_path.display(),
            e
        ));
    }
    let _ = std::fs::remove_file(&etag_path);

    Ok(downloaded)
}

/// 校验文件的 Content-MD5（base64 编码的 16 字节 MD5 摘要），流式读取避免
/// 把整个模型读进内存。
fn verify_content_md5(path: &std::path::Path, md5_b64: &str) -> Result<bool, String> {
    use std::io::Read;

    use base64::Engine as _;
    use md5::Digest;

    let expected = base64::engine::general_purpose::STANDARD
        .decode(md5_b64.trim())
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    if expected.len() != 16 {
        return Ok(false);
    }

    let mut file = std::fs::File::open(path).map_err(|e| format!("读取文件失败: {}", e))?;
    let mut hasher = md5::Md5::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().as_slice() == expected.as_slice())
}

/// 删除已下载的模型
#[tauri::command]
pub fn delete_local_asr_model() -> Result<String, String> {
    let model_dir = default_model_dir();
    if model_dir.is_dir() {
        std::fs::remove_dir_all(&model_dir)
            .map_err(|e| format!("Failed to delete model dir: {}", e))?;
        Ok(format!("Deleted {}", model_dir.display()))
    } else {
        Ok("Model not installed".to_string())
    }
}

/// 用本地 ASR 引擎测试一段 WAV 文件
#[tauri::command]
pub fn test_local_asr(model_dir: Option<String>) -> Result<String, String> {
    let dir = model_dir.map(PathBuf::from).unwrap_or_else(default_model_dir);
    let engine = LocalAsrEngine::new(&dir)?;
    let model_dir_str = engine.model_dir().to_string_lossy().to_string();
    drop(engine);
    Ok(format!(
        "Local ASR engine initialized successfully with model at {}",
        model_dir_str
    ))
}

// ============================================================
// 流式 ASR 会话命令（面试面板转录用）
//
// 由于 SenseVoice 使用 OfflineRecognizer（非流式），我们采用累积+定期解码策略：
// - start: 创建引擎 + 清空缓冲区
// - push: 追加音频样本到缓冲区 → 全量解码 → 发送事件
// - stop:  最终解码 → 发送最终结果 → 释放引擎
// ============================================================

/// 全局 ASR 引擎 + 累积音频缓冲区
static ACTIVE_SESSION: std::sync::OnceLock<
    std::sync::Mutex<Option<(LocalAsrEngine, Vec<f32>)>>,
> = std::sync::OnceLock::new();

/// 启动本地 ASR 会话 — 加载模型并创建引擎，清空音频缓冲区
#[tauri::command]
pub fn start_local_asr_session() -> Result<String, String> {
    let model_dir = default_model_dir();
    if !model_dir.join("model.int8.onnx").is_file() {
        return Err(
            "Model not installed. Please download the ASR model in Settings > Interview Helper."
                .to_string(),
        );
    }

    let engine = LocalAsrEngine::new(&model_dir)?;
    let lock = ACTIVE_SESSION.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = lock.lock().map_err(|e| format!("Lock error: {}", e))?;
    *guard = Some((engine, Vec::new()));
    Ok(format!(
        "Local ASR session started with model at {}",
        model_dir.display()
    ))
}

/// 推送音频数据到本地 ASR 引擎（WAV base64，单声道 16bit）。
/// 只累积音频，不做推理——推理在 stop 时一次性完成，避免 UI 冻结。
#[tauri::command]
pub fn push_local_asr_audio(wav_base64: String) -> Result<(), String> {
    let samples = decode_wav_base64_to_f32(&wav_base64)?;

    let lock = match ACTIVE_SESSION.get() {
        Some(l) => l,
        None => return Ok(()), // 引擎尚未启动（冷启动窗口），静默丢弃
    };
    let mut guard = match lock.lock() {
        Ok(g) => g,
        Err(_) => return Ok(()), // Mutex 中毒，静默丢弃
    };
    let (_engine, buffer) = match guard.as_mut() {
        Some(s) => s,
        None => return Ok(()), // 引擎正在重启（stop→start 窗口），静默丢弃
    };

    // 只累积，不做推理（SenseVoice OfflineRecognizer 是全量模型，逐帧推理极慢）
    buffer.extend_from_slice(&samples);
    Ok(())
}

/// 停止本地 ASR 会话 — 对全部累积音频运行一次性推理，返回转录文本。
/// 同时通过 `local-asr:transcript` 事件发送结果（供混合对比面板使用）。
#[tauri::command]
pub fn stop_local_asr_session(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    // 先取出 session，释放锁后再推理
    let session = {
        let lock = ACTIVE_SESSION
            .get()
            .ok_or("No active ASR session.")?;
        let mut guard = lock.lock().map_err(|e| format!("Lock error: {}", e))?;
        guard.take()
    };

    let mut result_text = String::new();

    if let Some((engine, buffer)) = session {
        if !buffer.is_empty() {
            let audio_dur = buffer.len() as f32 / MODEL_SAMPLE_RATE as f32;
            eprintln!(
                "[local-asr] Running inference on {:.1}s of audio ({} samples)...",
                audio_dur,
                buffer.len()
            );

            // 推理在锁外执行，不阻塞后续 push 调用
            match engine.transcribe(&buffer, MODEL_SAMPLE_RATE) {
                Ok(text) => {
                    let trimmed = text.trim().to_string();
                    eprintln!(
                        "[local-asr] Inference done: {} chars, \"{}\"",
                        trimmed.len(),
                        if trimmed.len() > 80 { &trimmed[..80] } else { &trimmed }
                    );
                    let _ = app.emit(
                        "local-asr:transcript",
                        serde_json::json!({
                            "text": trimmed.clone(),
                            "startTime": 0.0,
                            "isFinal": true,
                        }),
                    );
                    result_text = trimmed;
                }
                Err(e) => {
                    eprintln!("[local-asr] Inference error: {}", e);
                }
            }
        } else {
            eprintln!("[local-asr] stop called but buffer is empty (no audio pushed)");
        }
        drop(engine);
    }

    Ok(result_text)
}

/// 转录并重置：取走当前缓冲区 → 推理 → 放回空缓冲区，不销毁引擎。
/// 避免每次推理后重新加载 239MB 模型（~500ms-1s 冷启动）。
/// 推理在锁外执行，引擎留在锁内供后续 push 继续使用。
#[tauri::command]
pub fn transcribe_and_reset_local_asr(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;

    // 取出缓冲区，放回空 Vec，引擎保留
    let buffer = {
        let lock = ACTIVE_SESSION
            .get()
            .ok_or("No active ASR session.")?;
        let mut guard = lock.lock().map_err(|e| format!("Lock error: {}", e))?;
        let (_, buf) = guard
            .as_mut()
            .ok_or("ASR engine not initialized.")?;
        std::mem::replace(buf, Vec::new())
    };

    if buffer.is_empty() {
        eprintln!("[local-asr] transcribe_and_reset: buffer is empty");
        return Ok(String::new());
    }

    // 推理在锁外执行
    let audio_dur = buffer.len() as f32 / MODEL_SAMPLE_RATE as f32;
    eprintln!(
        "[local-asr] transcribe_and_reset: {:.1}s of audio ({} samples)...",
        audio_dur, buffer.len()
    );

    // 需要借用 engine 做推理——短暂加锁只读访问
    let result_text = {
        let lock = ACTIVE_SESSION.get().unwrap();
        let guard = lock.lock().map_err(|e| format!("Lock error: {}", e))?;
        match guard.as_ref() {
            Some((engine, _)) => match engine.transcribe(&buffer, MODEL_SAMPLE_RATE) {
                Ok(text) => {
                    let trimmed = text.trim().to_string();
                    eprintln!(
                        "[local-asr] transcribe_and_reset done: {} chars, \"{}\"",
                        trimmed.len(),
                        if trimmed.len() > 80 { &trimmed[..80] } else { &trimmed }
                    );
                    let _ = app.emit(
                        "local-asr:transcript",
                        serde_json::json!({
                            "text": trimmed.clone(),
                            "startTime": 0.0,
                            "isFinal": true,
                        }),
                    );
                    trimmed
                }
                Err(e) => {
                    eprintln!("[local-asr] transcribe_and_reset inference error: {}", e);
                    String::new()
                }
            },
            None => {
                eprintln!("[local-asr] transcribe_and_reset: engine gone");
                String::new()
            }
        }
    };

    Ok(result_text)
}

// ============================================================
// WAV 解码工具
// ============================================================

/// 解码 WAV base64 为 f32 样本数组（单声道 16bit，重采样到模型采样率）
#[cfg(feature = "local-asr")]
fn decode_wav_base64_to_f32(base64: &str) -> Result<Vec<f32>, String> {
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    if bytes.len() < 44 {
        return Err("WAV too short".to_string());
    }

    // 解析 WAV 头
    let sample_rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    let num_channels = u16::from_le_bytes([bytes[22], bytes[23]]);
    let bits_per_sample = u16::from_le_bytes([bytes[34], bytes[35]]);

    if bits_per_sample != 16 || num_channels != 1 {
        return Err(format!(
            "Unsupported WAV format: {}ch {}bit (need mono 16bit)",
            num_channels, bits_per_sample
        ));
    }

    // 查找 data chunk
    let mut offset = 12usize;
    let mut data_start = 0usize;
    let mut data_size = 0usize;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        if chunk_id == b"data" {
            data_start = offset + 8;
            data_size = chunk_size.min(bytes.len() - data_start);
            break;
        }
        offset += 8 + chunk_size;
        if chunk_size % 2 != 0 {
            offset += 1;
        }
    }

    if data_start == 0 || data_size == 0 {
        return Err("No data chunk in WAV".to_string());
    }

    let pcm = &bytes[data_start..data_start + data_size];
    let sample_count = pcm.len() / 2;

    // 读取 i16 样本并转换为 f32
    let mut samples: Vec<f32> = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        let sample = i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]);
        samples.push(sample as f32 / 32768.0);
    }

    // 如果需要重采样
    if sample_rate as i32 != MODEL_SAMPLE_RATE as i32 {
        samples = resample_linear(&samples, sample_rate, MODEL_SAMPLE_RATE as u32);
    }

    Ok(samples)
}

/// Stub for non-local-asr builds
#[cfg(not(feature = "local-asr"))]
fn decode_wav_base64_to_f32(_base64: &str) -> Result<Vec<f32>, String> {
    Err("Local ASR not compiled".to_string())
}

/// 线性重采样
fn resample_linear(samples: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate {
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
        out.push(samples[i0] * (1.0 - frac) + samples[i1] * frac);
    }
    out
}
