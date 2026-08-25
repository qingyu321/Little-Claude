//! 面试秒出答案 — 多模态直连模块。
//!
//! 使用多模态 API 直接处理语音并生成答案，无需本地 ASR 引擎。
//!
//! ## 架构
//!
//! ```text
//! InterviewPipeline
//!   ├── WASAPI loopback → system_audio.rs (Windows only)
//!   ├── 前端 Web Audio API mic 采集
//!   └── 多模态 API 直连 → interview_mimo_answer (Rust reqwest)
//! ```

pub mod commands;
pub mod local_asr;
pub mod protocol;
pub mod realtime;
pub mod search;
pub mod system_audio;
