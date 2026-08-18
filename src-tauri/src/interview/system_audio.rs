//! WASAPI Loopback — 系统音频输出采集。
//!
//! 在 Windows 上用 WASAPI Loopback 模式捕获系统音频（扬声器输出），
//! 每 ~800ms 产生一个 WAV chunk，通过 mpsc channel 发送给会话管线。
//!
//! 仅在 Windows 上编译；其他平台提供空实现（永远返回不可用错误）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;

/// 系统音频采集的一个 chunk。
pub struct SystemAudioChunk {
    pub chunk_id: String,
    /// 内存中的 WAV 字节（16kHz 单声道 16bit PCM）：经 channel 直传消费方，
    /// 不再写临时文件再读回（每 chunk 省一次磁盘往返）。
    pub wav_bytes: Vec<u8>,
    /// 该 chunk 重采样后单声道信号的峰值（0..1）。前端据此门控判句：
    /// peak 过低说明 loopback 抓到的是静音/底噪，该块按静音处理。
    pub peak: f32,
}

/// 系统音频采集线程的控制句柄。
pub struct SystemAudioHandle {
    stop_flag: Arc<AtomicBool>,
    #[allow(dead_code)]
    thread: Option<std::thread::JoinHandle<()>>,
}

impl SystemAudioHandle {
    /// 发出停止信号并等待线程退出。
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            log::info!("[sys_audio] waiting for capture thread to stop...");
            let _ = t.join();
            log::info!("[sys_audio] capture thread stopped");
        }
    }
}

impl Drop for SystemAudioHandle {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

// ══════════════════════════════════════════════════════════════════
// Windows WASAPI 实现
// ══════════════════════════════════════════════════════════════════

#[cfg(target_os = "windows")]
mod wasapi_impl {
    use super::*;
    use std::io::Write;
    use tokio::sync::mpsc;

    // NOTE: 不能 `use windows::core::*` — 会引入 windows::core::Result 遮蔽 std::result::Result
    use windows::Win32::System::Com::{
        CoInitializeEx, CoCreateInstance, CoTaskMemFree, CoUninitialize,
        CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::Media::Audio::{
        IAudioClient, IAudioCaptureClient, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_BUFFERFLAGS_SILENT,
        eRender, eConsole,
    };

    /// 启动 WASAPI loopback 捕获。
    pub fn start_wasapi_loopback(
        chunk_tx: mpsc::Sender<SystemAudioChunk>,
        app_handle: tauri::AppHandle,
        session_id: String,
    ) -> std::result::Result<SystemAudioHandle, String> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let flag = stop_flag.clone();

        let thread = std::thread::Builder::new()
            .name("wasapi-loopback".into())
            .spawn(move || {
                if let Err(e) = run_loopback(chunk_tx, &flag, &app_handle, &session_id) {
                    log::error!("[sys_audio] WASAPI loopback failed: {e}");
                    let _ = app_handle.emit("interview:system-audio-error", serde_json::json!({
                        "sessionId": session_id,
                        "chunkId": "wasapi",
                        "error": e,
                    }));
                }
            })
            .map_err(|e| format!("创建采集线程失败: {e}"))?;

        Ok(SystemAudioHandle {
            stop_flag,
            thread: Some(thread),
        })
    }

    /// WASAPI loopback 主循环。
    fn run_loopback(
        chunk_tx: mpsc::Sender<SystemAudioChunk>,
        stop_flag: &AtomicBool,
        app_handle: &tauri::AppHandle,
        session_id: &str,
    ) -> std::result::Result<(), String> {
        // ── 1. 初始化 COM ──
        // 失败（如已初始化）不影响 loopback 采集，忽略返回值
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); };

        let result = run_capture_loop(chunk_tx, stop_flag, app_handle, session_id);

        unsafe { CoUninitialize(); }
        result
    }

    /// 设置并运行音频捕获循环。
    fn run_capture_loop(
        chunk_tx: mpsc::Sender<SystemAudioChunk>,
        stop_flag: &AtomicBool,
        app_handle: &tauri::AppHandle,
        session_id: &str,
    ) -> std::result::Result<(), String> {
        // ── 2. 创建 MMDeviceEnumerator ──
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        }.map_err(|e| format!("创建 MMDeviceEnumerator 失败: {e}"))?;

        // ── 3. 获取默认音频输出设备 ──
        let device = unsafe {
            enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
        }.map_err(|e| format!("获取默认输出设备失败: {e}"))?;

        // ── 4. 激活 IAudioClient (windows 0.58: Activate<T> 是泛型的，IID 由 T 推断) ──
        let audio_client: IAudioClient = unsafe {
            device.Activate::<IAudioClient>(CLSCTX_ALL, None)
        }.map_err(|e| format!("激活 IAudioClient 失败: {e}"))?;

        // ── 5. 获取混音格式 ──
        let wfx_ptr = unsafe {
            audio_client.GetMixFormat()
        }.map_err(|e| format!("GetMixFormat 失败: {e}"))?;
        let sample_rate = unsafe { (*wfx_ptr).nSamplesPerSec };
        let channels = unsafe { (*wfx_ptr).nChannels };
        let bits_per_sample = unsafe { (*wfx_ptr).wBitsPerSample };
        let block_align = unsafe { (*wfx_ptr).nBlockAlign };
        let raw_format_tag = unsafe { (*wfx_ptr).wFormatTag };
        // R12 (bug): WAVE_FORMAT_EXTENSIBLE (0xFFFE) carries the REAL sample
        // format in the SubFormat GUID — the old code assumed float32 for ANY
        // 32-bit extensible mix format, so integer-PCM mixes decoded into
        // garbage (distorted peaks, broken transcription). Resolve to the
        // effective tag here; unknown subtypes fail loudly instead of
        // producing garbage audio.
        let format_tag = if raw_format_tag == 0xFFFE {
            let ext = unsafe {
                &*(wfx_ptr as *const windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE)
            };
            let sub = ext.SubFormat;
            let known_tail = sub.data2 == 0x0000
                && sub.data3 == 0x0010
                && sub.data4 == [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
            if known_tail && sub.data1 == 0x00000003 {
                3u16 // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT → WAVE_FORMAT_IEEE_FLOAT
            } else if known_tail && sub.data1 == 0x00000001 {
                1u16 // KSDATAFORMAT_SUBTYPE_PCM → WAVE_FORMAT_PCM
            } else {
                return Err(format!(
                    "Unsupported extensible mix SubFormat: {:08x}-{:04x}-{:04x}",
                    sub.data1, sub.data2, sub.data3
                ));
            }
        } else {
            raw_format_tag
        };
        log::info!(
            "[sys_audio] mix format: {} Hz, {} ch, {} bit, tag={}, align={}",
            sample_rate, channels, bits_per_sample, format_tag, block_align
        );

        // ── 6. 初始化 AudioClient（loopback 模式） ──
        const REFTIMES_PER_SEC: i64 = 10_000_000;
        let buffer_duration = REFTIMES_PER_SEC; // 1s buffer
        unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                buffer_duration,
                0,
                wfx_ptr,
                None,
            )
        }.map_err(|e| format!("IAudioClient::Initialize 失败: {e}"))?;

        // Free the WAVEFORMATEX (CoTaskMemFree in windows 0.58 takes Option<*const c_void>)
        unsafe { CoTaskMemFree(Some(wfx_ptr.cast())) };

        // ── 7. 获取 IAudioCaptureClient (windows 0.58: GetService<T> 是泛型的) ──
        let capture_client: IAudioCaptureClient = unsafe {
            audio_client.GetService::<IAudioCaptureClient>()
        }.map_err(|e| format!("GetService(IAudioCaptureClient) 失败: {e}"))?;

        // ── 8. 获取缓冲区大小 ──
        let buffer_frame_count = unsafe { audio_client.GetBufferSize() }
            .map_err(|e| format!("GetBufferSize 失败: {e}"))?;
        log::info!("[sys_audio] buffer size: {} frames", buffer_frame_count);

        // ── 9. 开始捕获 ──
        unsafe { audio_client.Start() }
            .map_err(|e| format!("IAudioClient::Start 失败: {e}"))?;
        log::info!("[sys_audio] capturing system audio...");
        let _ = app_handle.emit("interview:system-audio-started", serde_json::json!({
            "sessionId": session_id,
            "sampleRate": sample_rate,
            "channels": channels,
        }));

        // ── 10. 捕获循环 ──
        // 幻觉抑制已由 peak 门控 + whisper 解码参数 + 前端黑名单三道防线负责，
        // 分块缩到 800ms 压低转写延迟（从 1.2s→0.8s），判句等待也对应缩短。
        // 麦克风走人声、电平足，前端用 500ms。
        let chunk_interval_ms: u64 = 800;
        let mut chunk_index: u64 = 0;
        let mut dropped_chunks: u64 = 0; // channel 满时丢弃的块数（背压）
        let mut consecutive_errors: u32 = 0; // GetBuffer 连续失败计数
        let mut peak_max: f32 = 0.0; // 本秒内 chunk 峰值最大者（诊断：≈0 = loopback 没抓到声音）
        let mut silent_chunks: u64 = 0; // 峰值极低的 chunk 累计
        let mut pcm_buffer: Vec<u8> = Vec::new();
        let bytes_per_frame = block_align as usize;
        let bytes_per_chunk = (sample_rate as usize * bytes_per_frame * chunk_interval_ms as usize) / 1000;
        let bytes_per_chunk = (bytes_per_chunk / bytes_per_frame) * bytes_per_frame;

        let start = std::time::Instant::now();
        let mut last_status = start;
        let mut total_frames_read: u64 = 0;

        while !stop_flag.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(10));

            // GetBuffer 签名: (ppdata: *mut *mut u8, pnumframestoread: *mut u32,
            //                  pdwflags: *mut u32, devicepos: Option<*mut u64>,
            //                  qpcpos: Option<*mut u64>) -> Result<()>
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut num_frames_read: u32 = 0;
            let mut flags: u32 = 0;

            let get_result = unsafe {
                capture_client.GetBuffer(
                    &mut data_ptr,
                    &mut num_frames_read,
                    &mut flags,
                    None,
                    None,
                )
            };
            if let Err(e) = get_result {
                // 设备拔出/切换 → AUDCLNT_E_DEVICE_INVALIDATED 等。
                // 不再吞错：连续失败超阈值则上报前端并退出循环（原先静默挂死）。
                consecutive_errors += 1;
                if consecutive_errors >= 50 {
                    log::error!("[sys_audio] GetBuffer 连续失败 {} 次: {e}", consecutive_errors);
                    let _ = app_handle.emit("interview:system-audio-error", serde_json::json!({
                        "sessionId": session_id,
                        "chunkId": "wasapi",
                        "error": format!("系统音频采集连续失败（音频设备可能已变更）: {e}"),
                    }));
                    break;
                }
                continue; // 失败路径不调 ReleaseBuffer
            }
            consecutive_errors = 0;

            if num_frames_read > 0 && !data_ptr.is_null() {
                total_frames_read += num_frames_read as u64;
                let bytes_read = num_frames_read as usize * bytes_per_frame;
                // WASAPI 规范：AUDCLNT_BUFFERFLAGS_SILENT (0x2) 表示缓冲区内容未定义，
                // 应视为全零（静音）。不检查此标志会读未初始化内存 → 噪声/垃圾样本
                let is_silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                if is_silent {
                    pcm_buffer.extend(std::iter::repeat_n(0u8, bytes_read));
                } else {
                    let data = unsafe { std::slice::from_raw_parts(data_ptr, bytes_read) };
                    pcm_buffer.extend_from_slice(data);
                }
            }

            unsafe { let _ = capture_client.ReleaseBuffer(num_frames_read); }

            // 每秒报告一次状态
            let now = std::time::Instant::now();
            if now.duration_since(last_status).as_millis() >= 1000 {
                last_status = now;
                let elapsed = now.duration_since(start).as_secs();
                let _ = app_handle.emit("interview:system-audio-status", serde_json::json!({
                    "sessionId": session_id,
                    "elapsedSecs": elapsed,
                    "totalFramesRead": total_frames_read,
                    "bufferBytes": pcm_buffer.len(),
                    "chunksProduced": chunk_index,
                    "droppedChunks": dropped_chunks,
                    "peakMax": peak_max,
                    "silentChunks": silent_chunks,
                }));
                peak_max = 0.0; // 每秒重置，下一轮重新取最大
            }

            if pcm_buffer.len() >= bytes_per_chunk {
                let chunk_id = format!("sys_{chunk_index}");
                chunk_index += 1;

                match encode_wav_chunk(
                    &chunk_id,
                    &pcm_buffer,
                    sample_rate,
                    channels,
                    bits_per_sample,
                    format_tag,
                ) {
                    Ok((wav_bytes, peak)) => {
                        peak_max = peak_max.max(peak);
                        if peak < 0.001 { silent_chunks += 1; }
                        log::info!("[sys_audio] chunk #{}: {} frames, {:.0}ms, peak={:.4}",
                            chunk_index, pcm_buffer.len() / bytes_per_frame,
                            (pcm_buffer.len() / bytes_per_frame) as f64 / sample_rate as f64 * 1000.0,
                            peak);
                        // bounded channel：转写跟不上采集时丢弃当前块（drop-newest），
                        // 避免 unbounded 积压拖垮内存与延迟
                        match chunk_tx.try_send(SystemAudioChunk { chunk_id, wav_bytes, peak }) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                dropped_chunks += 1;
                                log::warn!("[sys_audio] channel full, dropped chunk (累计 {})", dropped_chunks);
                            }
                            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                                // 接收端已随会话销毁 —— 继续采下去只是空转，退出循环
                                log::info!("[sys_audio] 接收端已关闭（会话结束），退出采集循环");
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[sys_audio] encode WAV chunk failed: {e}");
                    }
                }
                pcm_buffer.clear();
            }
        }

        // ── 11. 停止 ──
        unsafe { let _ = audio_client.Stop(); }
        log::info!("[sys_audio] capture stopped");
        Ok(())
    }

    /// 将原始 PCM 数据编码为 **16kHz 单声道 16-bit PCM WAV** 字节（内存中，不落盘）。
    ///
    /// WASAPI loopback 输出的格式随系统混音格式变化（通常 48kHz 立体声 float32），
    /// 但多模态端点按 16kHz 单声道 WAV 消费。
    /// 此函数做四件事：
    /// 1. 解码原始字节 → f32 样本
    /// 2. 立体声 → 单声道（取各声道均值）
    /// 3. 重采样到 16kHz（线性插值）
    /// 4. f32 → i16 → 标准 WAV 字节流
    fn encode_wav_chunk(
        chunk_id: &str,
        raw_pcm: &[u8],
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
        format_tag: u16,
    ) -> std::io::Result<(Vec<u8>, f32)> {

        // ── Step 1: 解码原始字节 → f32 样本 ──
        // R12: tag 3 = IEEE float (extensible float mixes are normalized to
        // tag 3 at parse time); raw 0xFFFE kept for safety. Unaligned reads
        // avoided by copying per-sample instead of raw pointer casts.
        let float_samples: Vec<f32> = if (format_tag == 3 || format_tag == 0xFFFE)
            && bits_per_sample == 32
        {
            raw_pcm
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect()
        } else if bits_per_sample == 32 {
            raw_pcm
                .chunks_exact(4)
                .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2_147_483_648.0f32)
                .collect()
        } else if bits_per_sample == 16 {
            raw_pcm
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0f32)
                .collect()
        } else if bits_per_sample == 24 {
            let count = raw_pcm.len() / 3;
            let mut out = Vec::with_capacity(count);
            for i in 0..count {
                let off = i * 3;
                let raw = raw_pcm[off] as i32
                    | ((raw_pcm[off + 1] as i32) << 8)
                    | ((raw_pcm[off + 2] as i32) << 16);
                let val = if raw & 0x800000 != 0 { raw | !0xFFFFFF } else { raw };
                out.push(val as f32 / 8_388_608.0f32);
            }
            out
        } else {
            // 8-bit: unsigned → signed normalized
            raw_pcm.iter().map(|&b| (b as f32 - 128.0) / 128.0).collect()
        };

        // ── Step 2: 立体声 → 单声道 ──
        let mono: Vec<f32> = if channels > 1 {
            let ch = channels as usize;
            let mono_len = float_samples.len() / ch;
            let mut out = Vec::with_capacity(mono_len);
            for i in 0..mono_len {
                let mut sum = 0.0f32;
                for c in 0..ch {
                    sum += float_samples[i * ch + c];
                }
                out.push(sum / ch as f32);
            }
            out
        } else {
            float_samples
        };

        // ── Step 3: 重采样到 16kHz ──
        // SenseVoice 本地 ASR 要求 16kHz；Mimo 端点也支持 16k。
        // 前端 concatWavChunks 会按需降到 8kHz 发送 Mimo（体积优先）。
        const TARGET_RATE: u32 = 16_000;
        let resampled: Vec<f32> = if sample_rate != TARGET_RATE && !mono.is_empty() {
            log::info!(
                "[sys_audio] resampling chunk {}: {}Hz {}ch → {}Hz mono ({} src samples → {} dst samples)",
                chunk_id, sample_rate, channels, TARGET_RATE,
                mono.len(),
                (mono.len() as f64 * TARGET_RATE as f64 / sample_rate as f64).ceil() as usize,
            );
            resample_linear(&mono, sample_rate, TARGET_RATE)
        } else {
            mono
        };

        // ── Step 4: f32 → i16 → bytes ──
        let pcm_data: Vec<u8> = resampled
            .iter()
            .map(|&s| {
                let clamped = s.clamp(-1.0, 1.0);
                (clamped * 32767.0) as i16
            })
            .flat_map(|s| s.to_le_bytes())
            .collect();

        // ── Step 5: 写入标准 WAV (mono, 16kHz, 16-bit PCM) ──
        let out_channels: u16 = 1;
        let out_bits: u16 = 16;
        let out_rate: u32 = TARGET_RATE;
        let bytes_per_sample: u16 = out_bits / 8;
        let block_align: u16 = out_channels * bytes_per_sample;
        let byte_rate: u32 = out_rate * block_align as u32;
        let data_size: u32 = pcm_data.len() as u32;
        let fmt_size: u32 = 16;
        let file_size: u32 = 36 + fmt_size + data_size;

        let mut wav: Vec<u8> = Vec::with_capacity(44 + pcm_data.len());
        wav.write_all(b"RIFF")?;
        wav.write_all(&file_size.to_le_bytes())?;
        wav.write_all(b"WAVE")?;
        wav.write_all(b"fmt ")?;
        wav.write_all(&fmt_size.to_le_bytes())?;
        wav.write_all(&1u16.to_le_bytes())?; // PCM
        wav.write_all(&out_channels.to_le_bytes())?;
        wav.write_all(&out_rate.to_le_bytes())?;
        wav.write_all(&byte_rate.to_le_bytes())?;
        wav.write_all(&block_align.to_le_bytes())?;
        wav.write_all(&out_bits.to_le_bytes())?;
        wav.write_all(b"data")?;
        wav.write_all(&data_size.to_le_bytes())?;
        wav.write_all(&pcm_data)?;

        // 返回重采样后单声道信号的峰值（0..1）—— 送进端点的真实电平，
        // 供前端/日志判断 loopback 到底采没采到声音（peak≈0 = 抓到的就是静音）
        let peak = resampled
            .iter()
            .fold(0.0f32, |m, &s| m.max(s.abs()));

        Ok((wav, peak))
    }

    /// 线性插值重采样：src_rate → dst_rate。
    /// 简单但有效；对于语音识别场景质量足够。
    fn resample_linear(samples: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
        if samples.is_empty() {
            return vec![];
        }
        let ratio = src_rate as f64 / dst_rate as f64;
        let out_len = (samples.len() as f64 / ratio).ceil() as usize;
        let mut out = Vec::with_capacity(out_len);
        let last = samples.len() - 1;
        for i in 0..out_len {
            let pos = i as f64 * ratio;
            let i0 = pos as usize;
            let i1 = (i0 + 1).min(last);
            let frac = (pos - i0 as f64) as f32;
            out.push(samples[i0] + (samples[i1] - samples[i0]) * frac);
        }
        out
    }
}

// ══════════════════════════════════════════════════════════════════
// 非 Windows 平台 — 空实现
// ══════════════════════════════════════════════════════════════════

#[cfg(not(target_os = "windows"))]
mod wasapi_impl {
    use super::*;
    use tokio::sync::mpsc;

    pub fn start_wasapi_loopback(
        _chunk_tx: mpsc::Sender<SystemAudioChunk>,
        _app_handle: tauri::AppHandle,
        _session_id: String,
    ) -> std::result::Result<SystemAudioHandle, String> {
        Err("系统音频采集仅支持 Windows（需要 WASAPI）".into())
    }
}

// ══════════════════════════════════════════════════════════════════
// 公共 API
// ══════════════════════════════════════════════════════════════════

/// 启动系统音频采集。
pub fn start_system_audio_capture(
    chunk_tx: tokio::sync::mpsc::Sender<SystemAudioChunk>,
    app_handle: tauri::AppHandle,
    session_id: String,
) -> std::result::Result<SystemAudioHandle, String> {
    wasapi_impl::start_wasapi_loopback(chunk_tx, app_handle, session_id)
}
