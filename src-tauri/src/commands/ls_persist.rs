//! localStorage 磁盘持久化 + origin 迁移（设置不再因 origin 变更而丢失）。
//!
//! 背景：v1.1.2 起主窗口改用自定义协议 `tokico://`（Windows origin 变为
//! `http://tokico.localhost`），而 WebView2 的 localStorage 按 origin 隔离，
//! 导致从 `http://tauri.localhost`（v1.1.1 默认）升级的用户丢失全部本地设置
//! （字号、主题、模型、头像……）。
//!
//! 本模块两层兜底：
//!   1. **磁盘快照**（`load/save/remove_ls_entry`）：前端把 localStorage 镜像到
//!      `~/.tokenicode/localstorage.json`，任何 origin 变更都能从磁盘灌回。
//!   2. **一次性迁移**（`ensure_migrated`）：首次启动用隐藏窗口加载旧 origin
//!      `http://tauri.localhost`，读出旧 localStorage 写入磁盘快照，之后销毁。
//!
//! 迁移全程防御式：任何失败都置标志并返回 Ok，绝不阻塞应用启动。

use crate::safe_data_dir;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// 磁盘快照文件（key→value 的 JSON 对象）。
fn snapshot_path() -> Result<PathBuf, String> {
    Ok(safe_data_dir()?.join("localstorage.json"))
}

/// 迁移完成标志文件（存在即不再迁移）。
fn migrated_flag_path() -> Result<PathBuf, String> {
    Ok(safe_data_dir()?.join(".origin-migrated-v2"))
}

/// 原子写：先写临时文件再 rename，避免半截 JSON。
fn atomic_write(path: &std::path::Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("写入临时文件失败: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("原子替换失败: {}", e))?;
    Ok(())
}

/// 从磁盘读快照；缺失/损坏返回空表（不报错，降级为"无历史设置"）。
fn load_snapshot_map() -> HashMap<String, String> {
    snapshot_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

/// 进程内快照缓存（首次访问从磁盘加载），Mutex 串行化读-改-写防竞争。
static SNAPSHOT: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();

fn snapshot_state() -> &'static Mutex<Option<HashMap<String, String>>> {
    SNAPSHOT.get_or_init(|| Mutex::new(None))
}

fn ensure_loaded(guard: &mut Option<HashMap<String, String>>) {
    if guard.is_none() {
        *guard = Some(load_snapshot_map());
    }
}

/// 把内存快照序列化并原子落盘（调用方需已持锁）。
fn flush_locked(map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    atomic_write(&snapshot_path()?, &json)
}

/// 读取整个 localStorage 磁盘快照，返回 JSON 对象字符串。
/// 前端启动时调用，把结果灌回当前 origin 的 localStorage。
#[tauri::command]
pub fn load_ls_snapshot() -> Result<String, String> {
    let state = snapshot_state();
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    ensure_loaded(&mut guard);
    let map = guard.as_ref().ok_or_else(|| "快照未加载".to_string())?;
    serde_json::to_string(map).map_err(|e| e.to_string())
}

/// 写入单个 key 到磁盘快照。前端镜像 localStorage.setItem 时调用。
#[tauri::command]
pub fn save_ls_entry(key: String, value: String) -> Result<(), String> {
    let state = snapshot_state();
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    ensure_loaded(&mut guard);
    let map = guard.as_mut().ok_or_else(|| "快照未加载".to_string())?;
    map.insert(key, value);
    flush_locked(map)
}

/// 从磁盘快照删除单个 key。前端镜像 localStorage.removeItem 时调用。
#[tauri::command]
pub fn remove_ls_entry(key: String) -> Result<(), String> {
    let state = snapshot_state();
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    ensure_loaded(&mut guard);
    let map = guard.as_mut().ok_or_else(|| "快照未加载".to_string())?;
    if map.remove(&key).is_some() {
        flush_locked(map)?;
    }
    Ok(())
}

// ─────────────────────────── origin 迁移 ───────────────────────────

/// 迁移窗口 dump 回来的 localStorage（JSON 字符串），由 receive_ls_migration_dump 填入。
static MIGRATION_DUMP: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn migration_dump_slot() -> &'static Mutex<Option<String>> {
    MIGRATION_DUMP.get_or_init(|| Mutex::new(None))
}

/// 迁移窗口内的 JS 通过此命令把旧 origin 的 localStorage 传回 Rust。
#[tauri::command]
pub fn receive_ls_migration_dump(dump: String) -> Result<(), String> {
    if let Ok(mut g) = migration_dump_slot().lock() {
        *g = Some(dump);
    }
    Ok(())
}

/// 旧 origin 迁移页 URL。Windows 默认 asset 协议为 http://tauri.localhost，
/// macOS/Linux 为 tauri://localhost。带 __migrate=1 让前端 bootstrap 短路不渲染。
fn old_origin_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html?__migrate=1"
    } else {
        "tauri://localhost/index.html?__migrate=1"
    }
}

/// 注入迁移窗口的脚本：等 __TAURI_INTERNALS__ 就绪后 dump localStorage 并回传。
/// localStorage 与 IPC 桥均不依赖 React，页面一加载即可用。
const DUMP_SCRIPT: &str = r#"(function(){try{
if(!window.__TAURI_INTERNALS__||window.__lcDumpSent)return;
var d={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);d[k]=localStorage.getItem(k);}
window.__lcDumpSent=true;
window.__TAURI_INTERNALS__.invoke('receive_ls_migration_dump',{dump:JSON.stringify(d)});
}catch(e){}})();"#;

/// 实际迁移：建隐藏窗口→轮询 eval dump→写快照→销毁窗口。返回迁移的 key 数。
async fn run_migration(app: &AppHandle) -> Result<usize, String> {
    if let Ok(mut g) = migration_dump_slot().lock() {
        *g = None;
    }

    let url: tauri::Url = old_origin_url()
        .parse()
        .map_err(|e| format!("迁移 URL 解析失败: {}", e))?;

    let webview = WebviewWindowBuilder::new(app, "__lc_migrate__", WebviewUrl::External(url))
        .visible(false)
        .focused(false)
        .inner_size(160.0, 120.0)
        .build()
        .map_err(|e| format!("创建迁移窗口失败: {}", e))?;

    // 轮询：反复 eval dump 脚本直到收到结果或超时（最多 ~5s）。
    let mut received: Option<String> = None;
    for _ in 0..25 {
        let _ = webview.eval(DUMP_SCRIPT);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(mut g) = migration_dump_slot().lock() {
            if let Some(d) = g.take() {
                received = Some(d);
                break;
            }
        }
    }

    let _ = webview.destroy();

    let dump = received.ok_or_else(|| "未收到旧 origin 数据（可能不可达或本就为空）".to_string())?;
    let map: HashMap<String, String> =
        serde_json::from_str(&dump).map_err(|e| format!("dump 解析失败: {}", e))?;
    let count = map.len();

    // 写入快照：已存在的 key 不覆盖（磁盘数据优先，迁移只补缺）。
    {
        let state = snapshot_state();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        ensure_loaded(&mut guard);
        let snap = guard.as_mut().ok_or_else(|| "快照未加载".to_string())?;
        for (k, v) in map {
            snap.entry(k).or_insert(v);
        }
        flush_locked(snap)?;
    }

    Ok(count)
}

/// 一次性迁移入口（前端 bootstrap 在灌盘前调用）。
/// dev 构建 origin 从未变过（一直是 Vite dev server），直接跳过。
/// 返回迁移的 key 数；任何失败都置标志并返回 Ok（非致命）。
#[tauri::command]
pub async fn ensure_migrated(app: AppHandle) -> Result<u64, String> {
    if cfg!(debug_assertions) {
        return Ok(0);
    }
    let flag = match migrated_flag_path() {
        Ok(p) => p,
        Err(_) => return Ok(0),
    };
    if flag.exists() {
        return Ok(0);
    }

    let migrated = match run_migration(&app).await {
        Ok(n) => {
            eprintln!("[little-claude] origin migration: recovered {} keys", n);
            n
        }
        Err(e) => {
            eprintln!("[little-claude] origin migration failed (non-fatal): {}", e);
            0
        }
    };

    // 无论成败都置标志，避免每次启动重试拖慢。
    if let Some(parent) = flag.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&flag, "1");
    Ok(migrated as u64)
}
