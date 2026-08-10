//! 前端资源热更新（"Lua 式热更"：引擎 exe 不动，业务资源 dist/ 免重装升级）。
//!
//! 流程：下载 zip（流式 + 进度事件）→ SHA256 校验 → 解压（防 zip-slip）
//! → 完整性校验（index.html + manifest.json 版本匹配）→ 原子切换版本目录
//! + 写版本指针 → 刷新资源加载缓存。资源加载侧见 embedded_resources.rs。

use crate::embedded_resources::{refresh_web_resources_dir, web_resources_root};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// 下载进度事件负载（前端监听 `update:progress`）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateProgress {
    /// "download" | "verify" | "extract" | "switching" | "done" | "error"
    pub(crate) phase: &'static str,
    pub(crate) downloaded: u64,
    pub(crate) total: Option<u64>,
    pub(crate) message: Option<String>,
}

/// zip 内的发布清单（与 scripts/make-web-update.ps1 生成格式一致）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    version: String,
    #[serde(default)]
    rust_changed: bool,
}

/// 版本号 "X.Y.Z"（可带 v 前缀）校验。
fn valid_version(v: &str) -> bool {
    let s = v.trim().trim_start_matches('v');
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// 解析三位版本号为排序键。
fn version_key(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let parse = |x: Option<&str>| x.and_then(|s| s.parse().ok()).unwrap_or(0);
    (parse(it.next()), parse(it.next()), parse(it.next()))
}

/// 流式下载并应用前端资源热更新包。
///
/// 参数：`url`（https 资源包直链）、`sha256`（zip 校验和，防篡改）、
/// `version`（目标版本，用于版本化目录与指针）。
///
/// 返回应用后的版本号；失败返回可读错误（进度事件同时发 error 相位）。
#[tauri::command]
pub async fn download_web_update(
    app: AppHandle,
    url: String,
    sha256: String,
    version: String,
) -> Result<String, String> {
    let version = version.trim().to_string();
    if !valid_version(&version) {
        return Err(format!("无效版本号: {}", version));
    }
    if !url.starts_with("https://") {
        return Err("资源包地址必须是 https://（拒绝非加密传输，防中间人篡改）".to_string());
    }

    let root = web_resources_root().ok_or_else(|| "无法定位数据目录".to_string())?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("无法创建资源目录 {}: {}", root.display(), e))?;
    let staging = root.join(format!("staging-{}", version));
    let target = root.join(format!("dist-{}", version));

    // 1) 流式下载到临时 zip（同时计算 SHA256）
    let tmp = std::env::temp_dir().join(format!("little-claude-web-update-{}.zip", version));
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client 初始化失败: {}", e))?;

    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败（GitHub 不可达？）: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let mut out = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("无法写入临时文件: {}", e))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断: {}", e))? {
        hasher.update(&chunk);
        tokio::io::AsyncWriteExt::write_all(&mut out, &chunk)
            .await
            .map_err(|e| format!("写入临时文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        // 进度节流：每 1MB 或收尾时发射
        if downloaded - last_emit >= 1_048_576 || downloaded == total.unwrap_or(u64::MAX) {
            last_emit = downloaded;
            let _ = app.emit(
                "update:progress",
                UpdateProgress {
                    phase: "download",
                    downloaded,
                    total,
                    message: None,
                },
            );
        }
    }
    drop(out);

    // 2) SHA256 校验
    let actual = format!("{:x}", hasher.finalize());
    if actual != sha256.trim().to_lowercase() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "校验失败: SHA256 不匹配（期望 {}，实际 {}）——资源包可能被篡改或下载损坏",
            sha256.trim().to_lowercase(),
            actual
        ));
    }
    let _ = app.emit(
        "update:progress",
        UpdateProgress {
            phase: "verify",
            downloaded,
            total,
            message: None,
        },
    );

    // 3) 解压到 staging（防 zip-slip）
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| format!("清理旧 staging 失败: {}", e))?;
    }
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("创建 staging 失败: {}", e))?;
    extract_zip(&tmp, &staging)?;
    let _ = app.emit(
        "update:progress",
        UpdateProgress {
            phase: "extract",
            downloaded,
            total,
            message: None,
        },
    );

    // 4) 完整性校验（index.html + manifest 版本匹配）——不完整绝不切换指针
    if !staging.join("index.html").is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("资源包缺少 index.html，已中止".to_string());
    }
    let manifest: PackageManifest = {
        let text = std::fs::read_to_string(staging.join("manifest.json"))
            .map_err(|_| "资源包缺少 manifest.json，已中止".to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("manifest.json 解析失败: {}", e))?
    };
    if manifest.version != version {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "manifest 版本 {} 与目标版本 {} 不一致，已中止",
            manifest.version, version
        ));
    }

    // 5) 原子切换：staging → dist-<version>，写版本指针（tmp + rename 原子写）
    let _ = app.emit(
        "update:progress",
        UpdateProgress {
            phase: "switching",
            downloaded,
            total,
            message: None,
        },
    );
    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("清理旧版本目录失败: {}", e))?;
    }
    std::fs::rename(&staging, &target)
        .map_err(|e| format!("切换资源目录失败: {}", e))?;
    let pointer = serde_json::json!({
        "version": version,
        "dir": format!("dist-{}", version),
    });
    let pointer_tmp = root.join("current.json.tmp");
    std::fs::write(&pointer_tmp, serde_json::to_string(&pointer).unwrap())
        .map_err(|e| format!("写入版本指针失败: {}", e))?;
    std::fs::rename(&pointer_tmp, root.join("current.json"))
        .map_err(|e| format!("提交版本指针失败: {}", e))?;
    refresh_web_resources_dir();
    let _ = std::fs::remove_file(&tmp);

    // 6) 清理：保留当前 + 上一版（回滚用），删除更旧的 dist-* 目录
    cleanup_old_versions(&root, 2);

    let _ = app.emit(
        "update:progress",
        UpdateProgress {
            phase: "done",
            downloaded,
            total,
            message: Some(version.clone()),
        },
    );
    eprintln!("[LITTLECLAUDE:update] web resources → {}", version);
    Ok(version)
}

/// 查询当前生效的磁盘资源版本（无热更 → None，前端回退 APP_VERSION）。
#[tauri::command]
pub fn get_web_resource_version() -> Option<String> {
    let root = web_resources_root()?;
    let text = std::fs::read_to_string(root.join("current.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(|s| s.to_string())
}

/// 解压 zip 到 dest，拒绝 zip-slip（../、绝对路径、盘符）。
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("无法打开资源包: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("资源包解析失败（可能不是有效 zip）: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取资源包条目失败: {}", e))?;
        let name = entry
            .enclosed_name()
            .ok_or_else(|| format!("资源包包含不安全路径: {}", entry.name()))?;
        if entry.is_dir() {
            std::fs::create_dir_all(dest.join(&name))
                .map_err(|e| format!("创建目录失败 {}: {}", name.display(), e))?;
            continue;
        }
        let out = dest.join(&name);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {}", parent.display(), e))?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("解压 {} 失败: {}", name.display(), e))?;
        std::fs::write(&out, &buf)
            .map_err(|e| format!("写入 {} 失败: {}", out.display(), e))?;
    }
    Ok(())
}

/// 按版本数值排序保留最新的 `keep` 个 dist-* 目录。
fn cleanup_old_versions(root: &Path, keep: usize) {
    let mut dirs: Vec<(PathBuf, (u64, u64, u64))> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(v) = name.strip_prefix("dist-v") {
                if e.path().is_dir() && valid_version(v) {
                    dirs.push((e.path(), version_key(v)));
                }
            }
        }
    }
    dirs.sort_by_key(|(_, key)| *key);
    while dirs.len() > keep {
        if let Some((oldest, _)) = dirs.first() {
            let _ = std::fs::remove_dir_all(oldest);
        }
        dirs.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_validation_accepts_three_parts() {
        assert!(valid_version("1.1.3"));
        assert!(valid_version("v1.1.3"));
        assert!(valid_version("2.0.0"));
        assert!(!valid_version("1.1"));
        assert!(!valid_version("1.1.3.4"));
        assert!(!valid_version("1.x.3"));
        assert!(!valid_version("../etc"));
    }

    #[test]
    fn version_key_orders_numerically() {
        let v110 = version_key("v1.1.0");
        let v111 = version_key("1.1.2");
        let v1110 = version_key("v1.1.10");
        assert!(v110 < v111);
        // 字典序会错乱的地方：1.1.2 vs 1.1.10 → 数值序 2 < 10
        assert!(v111 < v1110);
    }

    #[test]
    fn cleanup_keeps_newest_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for v in ["dist-v1.1.0", "dist-v1.1.2", "dist-v1.1.3", "dist-v1.1.10"] {
            std::fs::create_dir_all(root.join(v)).unwrap();
        }
        cleanup_old_versions(root, 2);
        let remaining: Vec<String> = std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("dist-"))
            .collect();
        assert!(remaining.contains(&"dist-v1.1.3".to_string()));
        assert!(remaining.contains(&"dist-v1.1.10".to_string()));
        assert!(!remaining.contains(&"dist-v1.1.0".to_string()));
        assert!(!remaining.contains(&"dist-v1.1.2".to_string()));
    }
}
