//! 通用下载取消机制（CancellationToken）。
//!
//! 模块级注册表：`scope_id -> Arc<AtomicBool>`。下载类长任务在开始时
//! `register` 一个令牌，前端通过 `cancel_download` 命令置位它；下载循环
//! 周期检查 `is_cancelled`，置位后提前返回「已取消」错误并清理临时文件。
//!
//! 用法（异步命令内）：
//! ```ignore
//! let scope = CancelScope::new(scope_id.as_deref());
//! // ……长循环里……
//! if scope.is_cancelled() {
//!     // 清理已创建的文件
//!     return Err(download_cancel::CANCELLED_ERROR.to_string());
//! }
//! // scope 在函数返回 / future 被 drop 时自动注销注册表条目
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 用户主动取消的专用错误文案（前端以此区分「取消」与真实失败）。
/// 前缀「已取消下载」是前端识别标记（CANCELLED_ERROR_MARKER），不要改动。
pub const CANCELLED_ERROR: &str = "已取消下载 (download cancelled by user)";

/// 判断错误是否为用户主动取消（可识别被包装过的错误文案）。
pub fn is_cancelled_err(e: &str) -> bool {
    e.contains("已取消下载")
}

/// 模块级注册表：scope_id -> 取消令牌
static CANCEL_TOKENS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCEL_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册一个新的取消令牌；同一 scope_id 重复注册返回已有令牌。
pub fn register(scope_id: &str) -> Arc<AtomicBool> {
    let mut map = registry().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(scope_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

/// 请求取消指定 scope 的下载（幂等；未知 scope_id 无操作）。
pub fn cancel(scope_id: &str) {
    let map = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(token) = map.get(scope_id) {
        token.store(true, Ordering::SeqCst);
    }
}

/// 注销 scope（下载完成后调用，避免注册表无限增长）。
pub fn unregister(scope_id: &str) {
    registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(scope_id);
}

/// Tauri 命令：请求取消一个下载任务（幂等，未知 scope_id 返回 Ok）。
#[tauri::command]
pub fn cancel_download(scope_id: String) -> Result<(), String> {
    cancel(&scope_id);
    Ok(())
}

/// 取消作用域守卫：创建时注册令牌，Drop 时自动注销。
///
/// 在异步命令开头创建，无论命令成功、失败还是 future 被提前 drop，
/// 注册表条目都会在作用域析构时被清理。
pub struct CancelScope {
    scope_id: Option<String>,
    token: Option<Arc<AtomicBool>>,
}

impl CancelScope {
    /// 创建取消作用域。`scope_id` 为 None 时不注册令牌（无取消能力）。
    pub fn new(scope_id: Option<&str>) -> Self {
        let token = scope_id.map(register);
        CancelScope {
            scope_id: scope_id.map(|s| s.to_string()),
            token,
        }
    }

    /// 是否已收到取消请求。
    pub fn is_cancelled(&self) -> bool {
        self.token
            .as_ref()
            .map_or(false, |t| t.load(Ordering::SeqCst))
    }
}

impl Drop for CancelScope {
    fn drop(&mut self) {
        if let Some(id) = &self.scope_id {
            unregister(id);
        }
    }
}
