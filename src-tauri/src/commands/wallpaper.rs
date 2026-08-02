use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::safe_data_dir;
use crate::commands::video_analysis::video_analysis_skill_dir;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ── Dynamic Wallpaper ────────────────────────────────────────────

// ── Wallpaper HTTP server (handles Range requests for HTML5 video) ──────

/// Launches a tiny HTTP server on 127.0.0.1:0 that serves files from
/// the wallpaper directory with proper Range / 206 Partial Content support.
/// This is necessary because Tauri's asset:// protocol does not handle
/// HTTP Range requests, which are mandatory for <video> playback in WebView2.
///
/// Idempotent  --?returns the existing port if the server is already running.
/// Decode percent-encoded URL path bytes back into a UTF-8 string (e.g.
/// `%E7%BB%98`  --?`绘`).  Invalid sequences are passed through as-is.
fn percent_decode_url_path(input: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

static WALLPAPER_SERVER_PORT: std::sync::Mutex<Option<u16>> = std::sync::Mutex::new(None);

#[tauri::command]
pub async fn start_wallpaper_server() -> Result<u16, String> {
    {
        let p = WALLPAPER_SERVER_PORT.lock().expect("wallpaper server port mutex poisoned");
        if let Some(port) = *p {
            return Ok(port);
        }
    }

    let wall_dir = wallpaper_dir()?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("wallpaper server bind: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("wallpaper server addr: {}", e))?
        .port();

    *WALLPAPER_SERVER_PORT.lock().expect("wallpaper server port mutex poisoned") = Some(port);

    eprintln!("[tokenicode] wallpaper HTTP server on http://127.0.0.1:{}", port);

    tokio::spawn(async move {
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(c) => c,
                Err(_) => break,
            };
            let dir = wall_dir.clone();
            tokio::spawn(async move {
                // Read the request head (8 KiB is plenty for HTTP headers).
                let mut buf = [0u8; 8192];
                let n = match stream.read(&mut buf).await {
                    Ok(0) => return,
                    Ok(n) => n,
                    Err(_) => return,
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let lines: Vec<&str> = req.lines().collect();
                if lines.is_empty() {
                    return;
                }

                // Parse "GET /name.mp4 HTTP/1.1"
                let parts: Vec<&str> = lines[0].split_whitespace().collect();
                if parts.len() < 2 || parts[0] != "GET" {
                    return;
                }
                let path = parts[1].trim_start_matches('/');
                // URL-decode the percent-encoded path (browser sends e.g.
                // %E7%BB%98... for Chinese filenames) BEFORE validating —
                // checking the raw URL lets %2e%2e%2f sneak past as "../".
                let decoded_path = percent_decode_url_path(path);
                if decoded_path.split(['/', '\\']).any(|c| c == "..") {
                    return; // path traversal guard
                }

                let file_path = dir.join(&decoded_path);
                // Defense in depth: resolve symlinks / normalization and
                // require the result to stay inside the wallpaper directory.
                // Both sides are canonicalized so the \\?\ verbatim prefix
                // Windows returns does not break the comparison.
                let canonical_dir = match std::fs::canonicalize(&dir) {
                    Ok(d) => d,
                    Err(_) => return,
                };
                let file_path = match std::fs::canonicalize(&file_path) {
                    Ok(p) if p.starts_with(&canonical_dir) => p,
                    _ => {
                        let _ = stream
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                            .await;
                        return;
                    }
                };
                let file_size = match file_path.metadata() {
                    Ok(m) => m.len(),
                    Err(_) => {
                        let _ = stream
                            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                            .await;
                        return;
                    }
                };

                // Parse Range header (RFC 7233).  We support the common
                // "bytes=N-M" and "bytes=N-" forms; suffix ranges
                // ("bytes=-N") are not used by browsers for video.
                let mut range_start: u64 = 0;
                let mut range_end: u64 = file_size.saturating_sub(1);
                let mut is_range = false;

                for line in &lines[1..] {
                    let lower = line.to_lowercase();
                    if let Some(val) = lower.strip_prefix("range: bytes=") {
                        let val = val.trim();
                        if let Some(dash) = val.find('-') {
                            if dash > 0 {
                                // "bytes=N-M" or "bytes=N-"
                                if let Ok(s) = val[..dash].parse::<u64>() {
                                    range_start = s;
                                }
                            }
                            let end_part = &val[dash + 1..];
                            if !end_part.is_empty() {
                                if let Ok(e) = end_part.parse::<u64>() {
                                    range_end = e.min(file_size.saturating_sub(1));
                                }
                            }
                            is_range = true;
                        }
                        break;
                    }
                }

                // Inverted ranges ("bytes=100-50") must be rejected here:
                // range_end - range_start would underflow (u64) and allocate
                // a gigantic buffer below.
                if range_start >= file_size || range_end < range_start {
                    let resp = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\n\
                         Content-Range: bytes */{}\r\n\
                         Content-Length: 0\r\n\r\n",
                        file_size
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    return;
                }

                // Open the file and seek to the requested start
                let mut file = match tokio::fs::File::open(&file_path).await {
                    Ok(f) => f,
                    Err(_) => return,
                };

                if is_range {
                    let _ = file.seek(std::io::SeekFrom::Start(range_start)).await;
                    let length = (range_end - range_start + 1) as usize;
                    let mut data = vec![0u8; length];
                    if file.read_exact(&mut data).await.is_err() {
                        return;
                    }
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\n\
                         Content-Range: bytes {}-{}/{}\r\n\
                         Content-Length: {}\r\n\
                         Content-Type: video/mp4\r\n\
                         Accept-Ranges: bytes\r\n\r\n",
                        range_start, range_end, file_size, length
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&data).await;
                } else {
                    let mut data = Vec::with_capacity(file_size as usize);
                    if file.read_to_end(&mut data).await.is_err() {
                        return;
                    }
                    let head = format!(
                        "HTTP/1.1 200 OK\r\n\
                         Content-Length: {}\r\n\
                         Content-Type: video/mp4\r\n\
                         Accept-Ranges: bytes\r\n\r\n",
                        file_size
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&data).await;
                }
            });
        }
    });

    Ok(port)
}

fn wallpaper_dir() -> Result<PathBuf, String> {
    safe_data_dir().map(|d| d.join("wallpapers"))
}

fn find_ffmpeg_binary() -> Option<PathBuf> {
    let skill_dir = video_analysis_skill_dir().ok()?;
    #[cfg(target_os = "windows")]
    let ffmpeg = skill_dir.join("bin").join("ffmpeg.exe");
    #[cfg(not(target_os = "windows"))]
    let ffmpeg = skill_dir.join("bin").join("ffmpeg");
    if ffmpeg.is_file() {
        Some(ffmpeg)
    } else {
        None
    }
}

/// Probe ffmpeg -encoders to list available hardware encoders, best first.
/// HEVC is preferred for smaller files, H.264 for broader hardware support.
fn detect_gpu_encoders(ffmpeg: &Path) -> Vec<(&'static str, &'static str)> {
    let mut cmd = std::process::Command::new(ffmpeg);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = match cmd
        .args(["-hide_banner", "-encoders"])
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => return vec![],
    };
    let mut list: Vec<(&'static str, &'static str)> = Vec::new();
    // Try HEVC NVENC first (best compression), fall back to H.264 NVENC (broader HW support)
    if output.contains("hevc_nvenc") {
        list.push(("hevc_nvenc", "nvidia-hevc"));
    }
    if output.contains("h264_nvenc") {
        list.push(("h264_nvenc", "nvidia-h264"));
    }
    list
}

fn quality_params(quality: &str) -> (u32, u32) {
    match quality {
        "fast" => (30, 720),
        "quality" => (24, 1080),
        _ => (28, 1080), // balanced (default)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperInfo {
    name: String,
    path: String,
    size_bytes: u64,
    duration_secs: f64,
    compressed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WallpaperProgress {
    stage: String, // "probing" | "compressing" | "done" | "error"
    progress: u32, // 0-100
    message: String,
    encoder: String,
    input_size: u64,
    output_size: Option<u64>,
}

#[tauri::command]
pub async fn list_wallpapers() -> Result<Vec<WallpaperInfo>, String> {
    let dir = wallpaper_dir()?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut result = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("read wallpaper dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |e| e != "mp4") {
            continue;
        }
        let name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
        let duration = probe_video_duration(&path).unwrap_or(0.0);
        result.push(WallpaperInfo {
            name,
            path: path.to_string_lossy().to_string(),
            size_bytes: size,
            duration_secs: duration,
            compressed: true,
        });
    }
    result.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(result)
}

fn probe_video_duration(video_path: &Path) -> Option<f64> {
    let ffmpeg = find_ffmpeg_binary()?;
    let mut cmd = std::process::Command::new(&ffmpeg);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .args([
            "-i",
            &video_path.to_string_lossy(),
            "-f",
            "null",
            "-",
        ])
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if line.contains("Duration:") {
            let dur = line
                .split("Duration:")
                .nth(1)?
                .split(',')
                .next()?
                .trim();
            let parts: Vec<&str> = dur.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].trim().parse().ok()?;
                let m: f64 = parts[1].trim().parse().ok()?;
                let s: f64 = parts[2].trim().parse().ok()?;
                return Some(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn delete_wallpaper(name: String) -> Result<(), String> {
    let dir = wallpaper_dir()?;
    let path = dir.join(format!("{}.mp4", name));
    if path.is_file() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete wallpaper: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_wallpaper_path(name: String) -> Result<String, String> {
    let dir = wallpaper_dir()?;
    let path = dir.join(format!("{}.mp4", name));
    if path.is_file() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err(format!("Wallpaper not found: {}", name))
    }
}

#[tauri::command]
pub async fn compress_wallpaper(
    app: AppHandle,
    input_path: String,
    quality: String,
) -> Result<WallpaperInfo, String> {
    let input = std::path::PathBuf::from(&input_path);
    if !input.is_file() {
        return Err("Input file not found".to_string());
    }

    let input_size = input.metadata().map(|m| m.len()).unwrap_or(0);
    let input_name = input
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let ffmpeg = find_ffmpeg_binary()
        .ok_or_else(|| "FFmpeg not found. Install video-analysis runtime first.".to_string())?;

    // Build the cascade of encoders to try, best-first.
    // HEVC NVENC (smallest file)  --?H.264 NVENC (broader HW support)  --?CPU (always works)
    let gpu_encoders = detect_gpu_encoders(&ffmpeg);
    let mut encoder_cascade: Vec<(&str, &str)> = Vec::new();
    for (enc, label) in &gpu_encoders {
        encoder_cascade.push((*enc, *label));
    }
    encoder_cascade.push(("libx264", "cpu")); // always-last fallback (H.264 = universal browser support)

    let (crf, max_height) = quality_params(&quality);

    let wp_dir = wallpaper_dir()?;
    std::fs::create_dir_all(&wp_dir)
        .map_err(|e| format!("create wallpaper dir: {}", e))?;
    let output_path = wp_dir.join(format!("{}.mp4", input_name));
    let output_path_str = output_path.to_string_lossy().to_string();

    // Build ffmpeg args  --?quality control + hwaccel varies per encoder
    let build_args = |enc: &str| -> Vec<String> {
        let mut a: Vec<String> = vec!["-y".into()];

        if matches!(enc, "hevc_nvenc" | "h264_nvenc") {
            // Full GPU pipeline for Optimus dual-GPU laptops.
            // hwaccel cuda  --?decode on NVIDIA; hwaccel_output_format cuda  --?            // keep frames in GPU memory so NVENC can consume them directly.
            // Without this, NVENC receives zero frames (frame=0).
            a.push("-hwaccel".into());
            a.push("cuda".into());
            a.push("-hwaccel_output_format".into());
            a.push("cuda".into());
        }

        a.push("-i".into());
        a.push(input_path.clone());

        match enc {
            "hevc_nvenc" | "h264_nvenc" => {
                // GPU-resident scale filter (scale_cuda); regular scale can't
                // process cuda-format frames.
                a.push("-vf".into());
                a.push(format!("scale_cuda=-2:{}", max_height));
                // Output fps (scale_cuda has no built-in fps param)
                a.push("-r".into());
                a.push("30".into());
            }
            _ => {
                a.push("-vf".into());
                a.push(format!("scale=-2:{}:flags=lanczos,fps=30", max_height));
            }
        }

        a.push("-c:v".into());
        a.push(enc.into());
        match enc {
            "hevc_nvenc" | "h264_nvenc" => {
                a.push("-cq".into()); a.push(crf.to_string());
                a.push("-bf".into()); a.push("0".into());
                a.push("-spatial-aq".into()); a.push("1".into());
                a.push("-preset".into()); a.push("p1".into());
                // No -pix_fmt: scale_cuda outputs GPU-native format;
                // forcing yuv420p crashes the filter graph (-40 ENOSYS).
            }
            _ => {
                a.push("-crf".into()); a.push(crf.to_string());
                a.push("-preset".into()); a.push("medium".into());
                a.push("-pix_fmt".into()); a.push("yuv420p".into());
            }
        }
        a.push("-an".into());
        a.push("-movflags".into()); a.push("+faststart".into());
        a
    };

    let _ = app.emit("wallpaper:progress", WallpaperProgress {
        stage: "probing".into(), progress: 5,
        message: format!(
            "可用编码 --? {}",
            encoder_cascade.iter().map(|(_, l)| *l).collect::<Vec<_>>().join("  --?")
        ),
        encoder: encoder_cascade.first().map(|(_, l)| *l).unwrap_or("cpu").into(),
        input_size, output_size: None,
    });

    // Helper to run ffmpeg with given args
    async fn run_ffmpeg_cmd(
        ffmpeg: &Path, args: Vec<String>, output_path: &str,
    ) -> Result<std::process::Output, String> {
        let mut cmd = tokio::process::Command::new(ffmpeg);
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.args(&args).arg(output_path)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 FFmpeg 失败: {}", e))?
            .wait_with_output().await
            .map_err(|e| format!("FFmpeg 进程错误: {}", e))
    }

    // Try each encoder in cascade order
    let mut last_error = String::new();
    let mut final_label = "cpu";
    let mut output = None;

    for (i, (enc, label)) in encoder_cascade.iter().enumerate() {
        let args = build_args(enc);
        let progress_pct = 10 + i as u32 * 25 / encoder_cascade.len() as u32;
        let _ = app.emit("wallpaper:progress", WallpaperProgress {
            stage: "compressing".into(), progress: progress_pct,
            message: format!("正在尝试 {} 编码 --?(CQ {})...", label, crf),
            encoder: (*label).into(), input_size, output_size: None,
        });

        match run_ffmpeg_cmd(&ffmpeg, args.clone(), &output_path_str).await {
            Ok(out) if out.status.success() => {
                output = Some(out);
                final_label = label;
                break;
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let tail = if stderr.len() > 2000 {
                    format!("...{}", crate::utf8_suffix(&stderr, 2000).trim())
                } else {
                    stderr.trim().to_string()
                };
                last_error = tail;
                eprintln!("[tokenicode] {} encoder failed (args: ffmpeg {})", label, args.join(" "));
                eprintln!("[tokenicode] {} stderr: {}", label, last_error);
            }
            Err(e) => {
                last_error = e;
            }
        }
    }

    let output = match output {
        Some(o) => o,
        None => return Err(format!("所有编码器均失败,最后一次错 --? {}", last_error)),
    };

    // Final sanity check (CPU should never fail here, but just in case)
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail = if stderr.len() > 600 { &stderr[stderr.len() - 600..] } else { &stderr };
        return Err(format!("FFmpeg 压缩失败: {}", tail));
    }

    if !output_path.is_file() {
        return Err("Output file was not created".to_string());
    }

    let output_size = output_path.metadata().map(|m| m.len()).unwrap_or(0);
    let duration = probe_video_duration(&output_path).unwrap_or(0.0);
    let savings = if input_size > 0 {
        ((input_size - output_size) as f64 / input_size as f64 * 100.0).round() as u32
    } else {
        0
    };

    let _ = app.emit(
        "wallpaper:progress",
        WallpaperProgress {
            stage: "done".into(),
            progress: 100,
            message: format!(
                "压缩完成! {}MB -> {}MB, 节省 {}%, {} 编码",
                input_size / 1_048_576,
                output_size / 1_048_576,
                savings,
                final_label
            ),
            encoder: final_label.into(),
            input_size,
            output_size: Some(output_size),
        },
    );

    Ok(WallpaperInfo {
        name: input_name,
        path: output_path_str,
        size_bytes: output_size,
        duration_secs: duration,
        compressed: true,
    })
}

