//! 本地 ASR 引擎 — 基于 sherpa-onnx OnlineRecognizer 的**流式**语音识别。
//!
//! 仅在启用 `local-asr` feature 时编译。
//! 默认使用流式 Zipformer 中文模型（~60MB，CPU 实时，支持增量 partial 输出）：
//! - encoder-epoch-99-avg-1.onnx
//! - decoder-epoch-99-avg-1.onnx
//! - joiner-epoch-99-avg-1.onnx
//! - tokens.txt
//!
//! 同时兼容流式 Paraformer 布局（encoder.onnx + decoder.onnx + tokens.txt）——
//! 引擎启动时按模型目录内实际文件自动识别。
//!
//! 流式引擎把每帧音频喂给 OnlineRecognizer，decode 后立即产出
//! partial（is_final=false）/ final（is_final=true）文本，经 `local-asr:transcript`
//! 事件推给前端 —— 面试官边说话边出字；端点检测（enable_endpoint + rule3
//! 最大句长）在快速无停顿语音下自动切句。

use std::path::{Path, PathBuf};

use crate::commands::download_cancel::{self, CancelScope};

// ============================================================
// 条件编译：仅在 local-asr feature 启用时编译实际逻辑
// ============================================================

#[cfg(feature = "local-asr")]
mod engine {
    use std::path::{Path, PathBuf};
    use sherpa_onnx::{
        OnlineParaformerModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
        OnlineTransducerModelConfig,
    };

    /// 默认采样率（流式模型要求 16kHz）
    pub const MODEL_SAMPLE_RATE: i32 = 16000;

    /// 一条转录事件（partial 或 final）。
    #[derive(Clone, Debug)]
    pub struct TranscriptEvent {
        pub text: String,
        pub is_final: bool,
    }

    impl TranscriptEvent {
        pub fn to_json(&self) -> serde_json::Value {
            serde_json::json!({
                "text": self.text,
                "startTime": 0.0,
                "isFinal": self.is_final,
            })
        }
    }

    /// 模型族（按目录内文件自动识别）
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum ModelKind {
        /// 流式 Zipformer transducer（encoder/decoder/joiner + tokens）
        Zipformer,
        /// 流式 Paraformer（encoder + decoder + tokens）
        Paraformer,
    }

    /// 本地流式 ASR 引擎（sherpa-onnx OnlineRecognizer）。
    ///
    /// 引擎持有识别器与活动流：每帧音频 accept 后立即 decode，
    /// 产出增量 partial 文本；is_final / endpoint 时重置流开始新一句。
    pub struct LocalAsrEngine {
        recognizer: OnlineRecognizer,
        stream: OnlineStream,
        model_dir: PathBuf,
        kind: ModelKind,
        /// 上次已发出的文本 —— 去重，避免同一 partial 重复 emit
        last_text: String,
        initialized: bool,
    }

    unsafe impl Send for LocalAsrEngine {}
    unsafe impl Sync for LocalAsrEngine {}

    impl LocalAsrEngine {
        /// 创建流式引擎并加载模型（自动识别 Zipformer / Paraformer 布局）。
        ///
        /// `model_dir` 应包含 tokens.txt + 对应模型文件（见模块注释）。
        pub fn new(model_dir: &Path) -> Result<Self, String> {
            let model_dir = model_dir.to_path_buf();

            let tokens_path = model_dir.join("tokens.txt");
            if !tokens_path.is_file() {
                return Err(format!(
                    "Tokens file not found: {}\nPlease download the ASR model first.",
                    tokens_path.display()
                ));
            }

            let para_encoder = model_dir.join("encoder.onnx");
            let para_decoder = model_dir.join("decoder.onnx");
            let zip_encoder = model_dir.join("encoder-epoch-99-avg-1.onnx");
            let zip_decoder = model_dir.join("decoder-epoch-99-avg-1.onnx");
            let zip_joiner = model_dir.join("joiner-epoch-99-avg-1.onnx");

            let mut config = OnlineRecognizerConfig::default();
            config.model_config.tokens = Some(tokens_path.to_string_lossy().to_string());
            config.model_config.num_threads = 2;
            config.model_config.provider = Some("cpu".to_string());
            config.decoding_method = Some("greedy_search".to_string());
            // 端点检测：短/长静音判句 + 最大句长（快速无停顿语音自动切句）
            config.enable_endpoint = true;
            config.rule1_min_trailing_silence = 2.5;
            config.rule2_min_trailing_silence = 1.0;
            config.rule3_min_utterance_length = 15.0;

            let kind;
            if para_encoder.is_file() && para_decoder.is_file() {
                config.model_config.paraformer = OnlineParaformerModelConfig {
                    encoder: Some(para_encoder.to_string_lossy().to_string()),
                    decoder: Some(para_decoder.to_string_lossy().to_string()),
                };
                kind = ModelKind::Paraformer;
            } else if zip_encoder.is_file() && zip_decoder.is_file() && zip_joiner.is_file() {
                config.model_config.transducer = OnlineTransducerModelConfig {
                    encoder: Some(zip_encoder.to_string_lossy().to_string()),
                    decoder: Some(zip_decoder.to_string_lossy().to_string()),
                    joiner: Some(zip_joiner.to_string_lossy().to_string()),
                };
                kind = ModelKind::Zipformer;
            } else {
                return Err(format!(
                    "No streaming ASR model found in {} (need Zipformer encoder/decoder/joiner \
                     or Paraformer encoder/decoder + tokens.txt)",
                    model_dir.display()
                ));
            }

            let recognizer = OnlineRecognizer::create(&config)
                .ok_or_else(|| "Failed to create OnlineRecognizer — check model files".to_string())?;
            let stream = recognizer.create_stream();

            eprintln!(
                "[local-asr] Streaming engine initialized ({:?}) from {}",
                kind,
                model_dir.display()
            );

            Ok(Self {
                recognizer,
                stream,
                model_dir,
                kind,
                last_text: String::new(),
                initialized: true,
            })
        }

        /// 模型族
        pub fn kind(&self) -> ModelKind {
            self.kind
        }

        /// 模型路径
        pub fn model_dir(&self) -> &Path {
            &self.model_dir
        }

        /// 是否已初始化
        pub fn is_initialized(&self) -> bool {
            self.initialized
        }

        /// 喂入一帧音频并立即增量解码，返回本次要 emit 的转录事件。
        ///
        /// `samples`: f32 数组，值范围 [-1.0, 1.0]
        /// `sample_rate`: 输入采样率（应为 16000）
        pub fn feed(&mut self, samples: &[f32], sample_rate: i32) -> Vec<TranscriptEvent> {
            if samples.is_empty() {
                return Vec::new();
            }
            self.stream.accept_waveform(sample_rate, samples);
            let mut events = Vec::new();

            while self.recognizer.is_ready(&self.stream) {
                self.recognizer.decode(&self.stream);
            }

            if let Some(r) = self.recognizer.get_result(&self.stream) {
                if !r.text.is_empty() && r.text != self.last_text {
                    events.push(TranscriptEvent {
                        text: r.text.clone(),
                        is_final: r.is_final,
                    });
                    self.last_text = r.text.clone();
                }
                // 句终（is_final 或端点检测）→ 重置流开始新一句
                if r.is_final || self.recognizer.is_endpoint(&self.stream) {
                    self.recognizer.reset(&self.stream);
                    self.last_text.clear();
                }
            }
            events
        }

        /// 冲刷当前流的最终结果（停录/切句时调用），并重置流。
        pub fn flush_final(&mut self) -> Option<TranscriptEvent> {
            self.stream.input_finished();
            while self.recognizer.is_ready(&self.stream) {
                self.recognizer.decode(&self.stream);
            }
            let ev = self
                .recognizer
                .get_result(&self.stream)
                .filter(|r| !r.text.is_empty())
                .map(|r| TranscriptEvent {
                    text: r.text,
                    is_final: true,
                });
            self.recognizer.reset(&self.stream);
            self.last_text.clear();
            ev
        }
    }
}

// ============================================================
// Stub：默认构建（不含 local-asr）的占位实现
// ============================================================

#[cfg(not(feature = "local-asr"))]
mod engine {
    use std::path::Path;

    /// 一条转录事件（partial 或 final）。
    #[derive(Clone, Debug)]
    pub struct TranscriptEvent {
        pub text: String,
        pub is_final: bool,
    }

    impl TranscriptEvent {
        pub fn to_json(&self) -> serde_json::Value {
            serde_json::json!({
                "text": self.text,
                "startTime": 0.0,
                "isFinal": self.is_final,
            })
        }
    }

    /// 模型族（按目录内文件自动识别）
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum ModelKind {
        Zipformer,
        Paraformer,
    }

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
        pub fn kind(&self) -> ModelKind {
            ModelKind::Zipformer
        }
        pub fn feed(&mut self, _samples: &[f32], _sample_rate: i32) -> Vec<TranscriptEvent> {
            Vec::new()
        }
        pub fn flush_final(&mut self) -> Option<TranscriptEvent> {
            None
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
pub use engine::TranscriptEvent;
pub use engine::MODEL_SAMPLE_RATE;

/// 模型下载镜像源（按优先级排序）。
/// 流式 Zipformer 中文模型（sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23）。
pub const MODEL_DOWNLOAD_URLS: &[(&str, &str)] = &[
    // HF-Mirror (国内 HuggingFace 镜像 — 实测可下载)
    (
        "https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main",
        "HF-Mirror (国内镜像)",
    ),
    // HuggingFace 官方（国内可能被墙，作为后备）
    (
        "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main",
        "HuggingFace (全球)",
    ),
];

/// 模型文件列表（流式 Zipformer 中文 14M，CPU 实时）
pub const MODEL_FILES: &[&str] = &[
    "encoder-epoch-99-avg-1.onnx", // ~56 MB
    "decoder-epoch-99-avg-1.onnx",  // ~8 MB
    "joiner-epoch-99-avg-1.onnx",   // ~1 MB
    "tokens.txt",                   // ~316 KB
];

/// 返回模型默认安装目录
pub fn default_model_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::safe_data_dir_name())
        .join("models")
        .join("asr-streaming")
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
        "engine": "sherpa-onnx (OnlineRecognizer streaming)",
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

    // M1/B4: cap the total download — a hijacked endpoint must not be able
    // to fill the disk (ASR models are < 1GB; 4GiB ceiling stops runaway
    // streams while leaving resume + retry headroom).
    const MAX_ASR_MODEL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
    if let Some(total) = expected_total {
        if total > MAX_ASR_MODEL_BYTES {
            return Err(format!(
                "模型文件过大 ({} bytes, 上限 4 GiB)",
                total
            ));
        }
    }

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取 {} 数据失败: {}", file_label, e))?
    {
        if scope.is_cancelled() {
            // 取消：保留 .part/.etag 供下次断点续传（240MB 文件下了一半不该作废）
            return Err(download_cancel::CANCELLED_ERROR.to_string());
        }

        downloaded += chunk.len() as u64;
        if downloaded > MAX_ASR_MODEL_BYTES {
            return Err(format!(
                "模型文件超过 4 GiB 上限（已下载 {} bytes），已中止",
                downloaded
            ));
        }
        file.write_all(&chunk)
            .map_err(|e| format!("写入 {} 失败: {}", part_path.display(), e))?;

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

/// models/ 下现行的模型目录名；其余子目录视为历史版本遗留的孤儿
/// （如旧版非流式 SenseVoice 的 `sensevoice` 目录，~239MB）。
const KNOWN_MODEL_DIR_NAMES: &[&str] = &["asr-streaming"];

/// 递归统计目录大小（孤儿目录数量有限，直接遍历即可）
fn dir_size_recursive(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size_recursive(&p);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// 检测 models/ 根目录下的历史遗留孤儿模型目录（名称 + 字节数）
#[tauri::command]
pub fn list_orphan_asr_model_dirs() -> Result<serde_json::Value, String> {
    let models_root = default_model_dir()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位模型根目录".to_string())?;
    let mut orphans: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&models_root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if KNOWN_MODEL_DIR_NAMES.iter().any(|k| *k == name) {
                continue;
            }
            orphans.push(serde_json::json!({
                "name": name,
                "path": p.to_string_lossy(),
                "bytes": dir_size_recursive(&p),
            }));
        }
    }
    Ok(serde_json::json!({ "orphans": orphans }))
}

/// 删除指定孤儿模型目录。安全约束：只接受纯目录名（禁止路径分隔符），
/// 且不得是现行模型目录 —— 防止被诱导删除在用模型或任意路径。
#[tauri::command]
pub fn delete_orphan_asr_model_dir(name: String) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法目录名".to_string());
    }
    if KNOWN_MODEL_DIR_NAMES.iter().any(|k| *k == name) {
        return Err(format!("{} 是正在使用的模型目录", name));
    }
    let models_root = default_model_dir()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位模型根目录".to_string())?;
    let target = models_root.join(&name);
    if !target.is_dir() {
        return Ok("目录不存在（可能已被清理）".to_string());
    }
    let bytes = dir_size_recursive(&target);
    std::fs::remove_dir_all(&target)
        .map_err(|e| format!("删除失败: {}", e))?;
    eprintln!("[LITTLECLAUDE:security] orphan asr model dir deleted: {} ({} bytes)", target.display(), bytes);
    Ok(format!("已删除 {}（约 {:.0} MB）", name, bytes as f64 / (1024.0 * 1024.0)))
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
// ============================================================
// 流式引擎持有 OnlineRecognizer + 活动流，push 每帧喂入并立即增量解码：
// - start: 创建流式引擎（识别器 + 空流）
// - push:  喂入一帧 → decode → 产出 partial/final 事件（local-asr:transcript）
// - stop:  input_finished + 最终冲刷 → 释放引擎
// - transcribe_and_reset: 冲刷当前流的最终结果并重置（兼容旧调用，返回最终文本）

/// 全局流式 ASR 引擎（识别器 + 活动流）
static ACTIVE_SESSION: std::sync::OnceLock<std::sync::Mutex<Option<LocalAsrEngine>>> =
    std::sync::OnceLock::new();

/// R5 (bug): generation counter closing the transcribe-window race. start and
/// stop bump it; an in-flight push/transcribe only writes the engine back if
/// the generation is unchanged (otherwise the write-back used to RESURRECT a
/// stopped session — 239MB model resident again — or clobber a fresh one).
static SESSION_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 取出当前会话（引擎 + 当前 generation），锁外使用。
fn take_session() -> Result<Option<(LocalAsrEngine, u64)>, String> {
    let lock = ACTIVE_SESSION
        .get()
        .ok_or("No active ASR session.")?;
    let mut guard = lock.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(guard
        .take()
        .map(|e| (e, SESSION_GEN.load(std::sync::atomic::Ordering::SeqCst))))
}

/// 放回会话（generation 未变且槽位为空时），否则丢弃引擎。
fn put_back_session(engine: LocalAsrEngine, gen: u64) {
    let lock = match ACTIVE_SESSION.get() {
        Some(l) => l,
        None => {
            drop(engine);
            return;
        }
    };
    let mut guard = match lock.lock() {
        Ok(g) => g,
        Err(_) => {
            drop(engine);
            return;
        }
    };
    if SESSION_GEN.load(std::sync::atomic::Ordering::SeqCst) == gen && guard.is_none() {
        *guard = Some(engine);
    } else {
        eprintln!("[local-asr] write-back skipped: session changed during use (stop/start won)");
        drop(engine);
    }
}

/// 启动本地流式 ASR 会话 — 加载模型并创建引擎。
/// R6 (perf): async + spawn_blocking — 加载模型是秒级阻塞操作，不能冻结 IPC 线程。
#[tauri::command]
pub async fn start_local_asr_session() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let model_dir = default_model_dir();
        let missing = MODEL_FILES
            .iter()
            .filter(|f| !model_dir.join(f).is_file())
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!(
                "Model not installed (missing {}). Please download the ASR model in Settings > Interview Helper.",
                missing.join(", ")
            ));
        }

        let engine = LocalAsrEngine::new(&model_dir)?;
        let lock = ACTIVE_SESSION.get_or_init(|| std::sync::Mutex::new(None));
        let mut guard = lock.lock().map_err(|e| format!("Lock error: {}", e))?;
        SESSION_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *guard = Some(engine);
        Ok(format!(
            "Local ASR session started with model at {}",
            model_dir.display()
        ))
    })
    .await
    .map_err(|e| format!("ASR start task failed: {}", e))?
}

/// 推送音频帧到流式 ASR 引擎（WAV base64，单声道 16bit）并立即增量解码。
/// 产出的 partial/final 文本经 `local-asr:transcript` 事件推给前端。
#[tauri::command]
pub async fn push_local_asr_audio(
    app: tauri::AppHandle,
    wav_base64: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let samples = decode_wav_base64_to_f32(&wav_base64)?;
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let (session, gen) = match take_session() {
            Ok(Some(v)) => v,
            Ok(None) => {
                // 引擎尚未启动（冷启动窗口）——前端有 pendingAudioRef 暂存，
                // 这里丢弃属预期，仅记日志便于诊断音频丢失场景
                eprintln!("[local-asr] push dropped: no active session (cold-start window)");
                return Ok(());
            }
            Err(e) => {
                eprintln!("[local-asr] push dropped: {}", e);
                return Ok(());
            }
        };
        let mut engine = session;
        let events = engine.feed(&samples, MODEL_SAMPLE_RATE);
        put_back_session(engine, gen);
        for ev in &events {
            let _ = app2.emit("local-asr:transcript", ev.to_json());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("ASR push task failed: {}", e))?
}

/// 停止本地 ASR 会话 — 冲刷最终文本并释放引擎。
/// 同时通过 `local-asr:transcript` 事件发送最终结果（供混合对比面板使用）。
#[tauri::command]
pub async fn stop_local_asr_session(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        // R5: bump the generation FIRST — an in-flight transcribe/push then
        // sees the change and drops the engine instead of resurrecting it.
        SESSION_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        let mut result_text = String::new();
        if let Some((mut engine, _gen)) = take_session()? {
            if let Some(ev) = engine.flush_final() {
                let trimmed = ev.text.trim().to_string();
                let preview = preview_chars(&trimmed, 80);
                eprintln!("[local-asr] stop flush: {} chars, \"{}\"", trimmed.len(), preview);
                let _ = app2.emit("local-asr:transcript", ev.to_json());
                result_text = trimmed;
            } else {
                eprintln!("[local-asr] stop called but no pending final text");
            }
            // engine dropped here (session ended)
        }
        Ok(result_text)
    })
    .await
    .map_err(|e| format!("ASR stop task failed: {}", e))?
}

/// 冲刷并重置：取走引擎 → 锁外冲刷最终文本 → 放回引擎（流已重置）。
/// 与旧行为一致：引擎保留在内存，避免每次重新加载模型（秒级冷启动）。
#[tauri::command]
pub async fn transcribe_and_reset_local_asr(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Emitter;
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let (session, gen) = match take_session() {
            Ok(Some(v)) => v,
            Ok(None) => {
                eprintln!("[local-asr] transcribe_and_reset: engine gone (busy or stopped)");
                return Ok(String::new());
            }
            Err(e) => {
                eprintln!("[local-asr] transcribe_and_reset: {}", e);
                return Ok(String::new());
            }
        };
        let mut engine = session;

        let result_text = match engine.flush_final() {
            Some(ev) => {
                let trimmed = ev.text.trim().to_string();
                let preview = preview_chars(&trimmed, 80);
                eprintln!(
                    "[local-asr] transcribe_and_reset done: {} chars, \"{}\"",
                    trimmed.len(),
                    preview
                );
                let _ = app2.emit("local-asr:transcript", ev.to_json());
                trimmed
            }
            None => {
                eprintln!("[local-asr] transcribe_and_reset: no pending text");
                String::new()
            }
        };

        // 放回引擎（generation 未变且槽位为空时；stop/start 优先）
        put_back_session(engine, gen);
        Ok(result_text)
    })
    .await
    .map_err(|e| format!("ASR transcribe task failed: {}", e))?
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

    // R23 (bug): the header is renderer-controlled input — sample_rate=0 made
    // resample_linear compute a zero ratio → usize::MAX capacity → panic that
    // took down the whole app. Validate a sane range up front.
    if !(1_000..=384_000).contains(&sample_rate) {
        return Err(format!("Invalid WAV sample rate: {}", sample_rate));
    }

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

/// 解码 WAV base64 为 i16 PCM 样本（单声道 16bit，原始采样率不重采样）。
/// 供实时语音后端（interview_realtime）把前端 WAV 转成 Realtime API 的
/// pcm16 音频流。返回 (样本, 采样率)。
#[cfg(feature = "local-asr")]
pub(crate) fn decode_wav_base64_to_pcm16(
    base64: &str,
) -> Result<(Vec<i16>, u32), String> {
    use base64::Engine as _;

    // DoS 上限：正常 500ms@16kHz chunk ≈ 22KB base64。4MB ≈ 3MB PCM
    // ≈ 96 秒音频，远超任何合法单块；超出直接拒绝，防内存放大攻击。
    const MAX_AUDIO_B64_LEN: usize = 4_000_000;
    if base64.len() > MAX_AUDIO_B64_LEN {
        return Err(format!(
            "Audio payload too large: {} bytes (max {})",
            base64.len(),
            MAX_AUDIO_B64_LEN
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    if bytes.len() < 44 {
        return Err("WAV too short".to_string());
    }

    let sample_rate = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]);
    let num_channels = u16::from_le_bytes([bytes[22], bytes[23]]);
    let bits_per_sample = u16::from_le_bytes([bytes[34], bytes[35]]);

    if !(1_000..=384_000).contains(&sample_rate) {
        return Err(format!("Invalid WAV sample rate: {}", sample_rate));
    }
    if bits_per_sample != 16 || num_channels != 1 {
        return Err(format!(
            "Unsupported WAV format: {}ch {}bit (need mono 16bit)",
            num_channels, bits_per_sample
        ));
    }

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
    let mut samples: Vec<i16> = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        samples.push(i16::from_le_bytes([pcm[i * 2], pcm[i * 2 + 1]]));
    }
    Ok((samples, sample_rate))
}

/// Stub for non-local-asr builds
#[cfg(not(feature = "local-asr"))]
pub(crate) fn decode_wav_base64_to_pcm16(
    base64: &str,
) -> Result<(Vec<i16>, u32), String> {
    // 与 local-asr 版本保持一致的输入上限校验（防内存放大）
    const MAX_AUDIO_B64_LEN: usize = 4_000_000;
    if base64.len() > MAX_AUDIO_B64_LEN {
        return Err("Audio payload too large".to_string());
    }
    Err("Local ASR not compiled".to_string())
}

/// 日志预览：按字符（非字节）截断。
/// 字节切片 `&s[..n]` 会在多字节 UTF-8（中文/emoji）字符中间 panic —
/// 转写文本 >80 字节时闪退的根因，禁止直接对字符串做字节切片。
fn preview_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

/// 线性重采样
fn resample_linear(samples: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    // R23: belt-and-braces guards (callers validate too) — zero/empty inputs
    // must never reach the capacity math below.
    if samples.is_empty() || src_rate == 0 || dst_rate == 0 {
        return Vec::new();
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_never_panics_on_multibyte_boundaries() {
        // 中文每个字 3 字节：100 字 = 300 字节，旧实现 &s[..80] 会切在
        // 字符中间 panic（80 不是 3 的倍数）
        let cn = "中".repeat(100);
        let p = preview_chars(&cn, 80);
        assert_eq!(p.chars().count(), 80); // 80 个字符
        assert_eq!(p.len(), 240); // 字节长度保持完整字符（80×3），未在中间切断

        // emoji 4 字节边界
        let emoji = "🎤".repeat(60);
        assert_eq!(preview_chars(&emoji, 30).chars().count(), 30);

        // 短文本 / 空文本
        assert_eq!(preview_chars("短", 80), "短");
        assert_eq!(preview_chars("", 80), "");

        // 混合中英
        let mixed = format!("面试问题{}", "abc".repeat(50));
        let p = preview_chars(&mixed, 80);
        assert_eq!(p.chars().count(), 80);
    }

    #[test]
    fn preview_caps_at_ascii_too() {
        let long_ascii = "a".repeat(200);
        assert_eq!(preview_chars(&long_ascii, 80), "a".repeat(80));
    }
}
