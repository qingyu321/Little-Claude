use serde::Serialize;
use tauri::{AppHandle, Emitter};

// ── Types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PrerequisiteItem {
    pub(crate) key: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) status: String,       // "ok" | "missing" | "checking"
    pub(crate) version: Option<String>,
    pub(crate) installable: bool,
    pub(crate) required: bool,
    /// 手动下载 URL——自动安装失败时的兜底引导（无手动安装途径的项为 None）
    #[serde(rename = "manualUrl")]
    pub(crate) manual_url: Option<String>,
}

// ── Helpers: individual checks with timeout ──────────────────────────────

async fn check_cli_item() -> PrerequisiteItem {
    eprintln!("[prereq] check_cli_item START");
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::commands::cli_manage::check_claude_cli(),
    )
    .await
    {
        Ok(Ok(status)) => {
            eprintln!("[prereq] check_cli_item OK installed={}", status.installed);
            PrerequisiteItem {
                key: "claude-cli".into(),
                name: "Claude CLI".into(),
                description: "AI 对话引擎".into(),
                status: if status.installed {
                    "ok".into()
                } else {
                    "missing".into()
                },
                version: status.version,
                installable: true,
                required: true,
                manual_url: None,
            }
        }
        Ok(Err(e)) => {
            eprintln!("[prereq] check_cli_item error: {e}");
            PrerequisiteItem {
                key: "claude-cli".into(),
                name: "Claude CLI".into(),
                description: "AI 对话引擎".into(),
                status: "missing".into(),
                version: Some(e),
                installable: true,
                required: true,
                manual_url: None,
            }
        }
        Err(_elapsed) => {
            eprintln!("[prereq] check_cli_item TIMEOUT");
            PrerequisiteItem {
                key: "claude-cli".into(),
                name: "Claude CLI".into(),
                description: "AI 对话引擎".into(),
                status: "missing".into(),
                version: Some("检测超时".into()),
                installable: true,
                required: true,
                manual_url: None,
            }
        }
    }
}

async fn check_git_item() -> Option<PrerequisiteItem> {
    #[cfg(target_os = "windows")]
    {
        eprintln!("[prereq] check_git_item START");
        let git_bash = crate::find_git_bash();
        eprintln!("[prereq] check_git_item found={}", git_bash.is_some());
        Some(PrerequisiteItem {
            key: "git".into(),
            name: "Git Bash".into(),
            description: "命令行工具 (Claude CLI 依赖)".into(),
            status: if git_bash.is_some() {
                "ok".into()
            } else {
                "missing".into()
            },
            version: None,
            installable: true,
            required: true,
            manual_url: Some("https://git-scm.com/downloads/win".into()),
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

async fn check_node_item() -> PrerequisiteItem {
    eprintln!("[prereq] check_node_item START");
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::commands::cli_manage::check_node_env(),
    )
    .await
    {
        Ok(Ok(status)) => {
            eprintln!("[prereq] check_node_item OK available={}", status.node_available);
            PrerequisiteItem {
                key: "node".into(),
                name: "Node.js (内置)".into(),
                description: "JavaScript 运行时 (npm 全局 CLI 需要)".into(),
                status: if status.node_available {
                    "ok".into()
                } else {
                    "missing".into()
                },
                version: status.node_version,
                installable: true,
                required: false,
                manual_url: Some("https://nodejs.org/zh-cn/download/".into()),
            }
        }
        Ok(Err(e)) => {
            eprintln!("[prereq] check_node_item error: {e}");
            PrerequisiteItem {
                key: "node".into(),
                name: "Node.js (内置)".into(),
                description: "JavaScript 运行时".into(),
                status: "missing".into(),
                version: Some(e),
                installable: true,
                required: false,
                manual_url: Some("https://nodejs.org/zh-cn/download/".into()),
            }
        }
        Err(_elapsed) => {
            eprintln!("[prereq] check_node_item TIMEOUT");
            PrerequisiteItem {
                key: "node".into(),
                name: "Node.js (内置)".into(),
                description: "JavaScript 运行时".into(),
                status: "missing".into(),
                version: Some("检测超时".into()),
                installable: true,
                required: false,
                manual_url: Some("https://nodejs.org/zh-cn/download/".into()),
            }
        }
    }
}

async fn check_auth_item() -> PrerequisiteItem {
    eprintln!("[prereq] check_auth_item START");
    match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::commands::auth::check_claude_auth(),
    )
    .await
    {
        Ok(Ok(auth_status)) => {
            // First check OAuth login
            if auth_status.authenticated || auth_status.unknown {
                eprintln!("[prereq] check_auth_item OK (OAuth)");
                return PrerequisiteItem {
                    key: "auth".into(),
                    name: "API 凭证".into(),
                    description: "Claude 登录或 API Key (选其一即可)".into(),
                    status: "ok".into(),
                    version: Some("已登录".into()),
                    installable: true,
                    required: false,
                    manual_url: None,
                };
            }
            // Not logged in — check if any provider has an API key
            eprintln!("[prereq] check_auth_item no OAuth, checking provider API keys");
            match crate::commands::provider::load_providers() {
                Ok(providers) => {
                    let has_api_key = providers.providers.iter().any(|p| {
                        p.api_key.as_ref().map_or(false, |k| !k.is_empty())
                    });
                    if has_api_key {
                        eprintln!("[prereq] check_auth_item OK (API Key)");
                        PrerequisiteItem {
                            key: "auth".into(),
                            name: "API 凭证".into(),
                            description: "Claude 登录或 API Key (选其一即可)".into(),
                            status: "ok".into(),
                            version: Some("API Key".into()),
                            installable: true,
                            required: false,
                            manual_url: None,
                        }
                    } else {
                        eprintln!("[prereq] check_auth_item no auth found");
                        PrerequisiteItem {
                            key: "auth".into(),
                            name: "API 凭证".into(),
                            description: "Claude 登录或 API Key (选其一即可)".into(),
                            status: "missing".into(),
                            version: None,
                            installable: true,
                            required: false,
                            manual_url: None,
                        }
                    }
                }
                Err(_) => {
                    eprintln!("[prereq] check_auth_item provider read error");
                    PrerequisiteItem {
                        key: "auth".into(),
                        name: "API 凭证".into(),
                        description: "Claude 登录或 API Key (选其一即可)".into(),
                        status: "missing".into(),
                        version: None,
                        installable: true,
                        required: false,
                        manual_url: None,
                    }
                }
            }
        }
        Ok(Err(e)) => {
            eprintln!("[prereq] check_auth_item error: {e}");
            PrerequisiteItem {
                key: "auth".into(),
                name: "API 凭证".into(),
                description: "Claude 登录或 API Key (选其一即可)".into(),
                status: "missing".into(),
                version: Some(e),
                installable: true,
                required: false,
                manual_url: None,
            }
        }
        Err(_elapsed) => {
            eprintln!("[prereq] check_auth_item TIMEOUT");
            PrerequisiteItem {
                key: "auth".into(),
                name: "API 凭证".into(),
                description: "Claude 登录或 API Key (选其一即可)".into(),
                status: "missing".into(),
                version: Some("检测超时".into()),
                installable: true,
                required: false,
                manual_url: None,
            }
        }
    }
}

async fn check_ollama_item() -> PrerequisiteItem {
    eprintln!("[prereq] check_ollama_item START");
    match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::commands::local_model::check_local_model_service(),
    )
    .await
    {
        Ok(Ok(status)) => {
            eprintln!("[prereq] check_ollama_item OK installed={}", status.installed);
            PrerequisiteItem {
                key: "ollama".into(),
                name: "Ollama".into(),
                description: "本地模型服务 (可选)".into(),
                status: if status.installed {
                    "ok".into()
                } else {
                    "missing".into()
                },
                version: status.version,
                installable: false,
                required: false,
                manual_url: Some("https://ollama.com/download".into()),
            }
        }
        _ => {
            eprintln!("[prereq] check_ollama_item missing/timeout");
            PrerequisiteItem {
                key: "ollama".into(),
                name: "Ollama".into(),
                description: "本地模型服务 (可选)".into(),
                status: "missing".into(),
                version: None,
                installable: false,
                required: false,
                manual_url: Some("https://ollama.com/download".into()),
            }
        }
    }
}

// ── Check all prerequisites (parallel, 25s total timeout) ─────────────────

#[tauri::command]
pub async fn check_prerequisites() -> Result<Vec<PrerequisiteItem>, String> {
    eprintln!("[prereq] check_prerequisites START (parallel)");

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(25),
        async {
            let (cli, git, node, auth, ollama) = tokio::join!(
                check_cli_item(),
                check_git_item(),
                check_node_item(),
                check_auth_item(),
                check_ollama_item(),
            );

            let mut items = vec![cli, node, auth, ollama];
            if let Some(g) = git {
                // Insert Git after CLI, before Node
                items.insert(1, g);
            }
            items
        },
    )
    .await;

    match result {
        Ok(items) => {
            eprintln!("[prereq] check_prerequisites DONE ({} items)", items.len());
            Ok(items)
        }
        Err(_) => {
            eprintln!("[prereq] check_prerequisites GLOBAL TIMEOUT");
            // Return whatever we can with timeout markers
            Ok(vec![
                PrerequisiteItem {
                    key: "claude-cli".into(),
                    name: "Claude CLI".into(),
                    description: "AI 对话引擎".into(),
                    status: "missing".into(),
                    version: Some("检测超时，请重试".into()),
                    installable: true,
                    required: true,
                    manual_url: None,
                },
                PrerequisiteItem {
                    key: "node".into(),
                    name: "Node.js (内置)".into(),
                    description: "JavaScript 运行时".into(),
                    status: "missing".into(),
                    version: Some("检测超时，请重试".into()),
                    installable: true,
                    required: false,
                    manual_url: Some("https://nodejs.org/zh-cn/download/".into()),
                },
                PrerequisiteItem {
                    key: "auth".into(),
                    name: "API 凭证".into(),
                    description: "Claude 登录或 API Key (选其一即可)".into(),
                    status: "missing".into(),
                    version: Some("检测超时，请重试".into()),
                    installable: true,
                    required: false,
                    manual_url: None,
                },
                PrerequisiteItem {
                    key: "ollama".into(),
                    name: "Ollama".into(),
                    description: "本地模型服务 (可选)".into(),
                    status: "missing".into(),
                    version: None,
                    installable: false,
                    required: false,
                    manual_url: Some("https://ollama.com/download".into()),
                },
            ])
        }
    }
}

// ── Install / fix a single prerequisite ──────────────────────────────────

#[tauri::command]
pub async fn install_prerequisite(
    app: AppHandle,
    key: String,
) -> Result<(), String> {
    let _ = app.emit(
        "prereq:install:progress",
        serde_json::json!({ "key": key, "phase": "start", "message": "Starting..." }),
    );

    let result: Result<(), String> = match key.as_str() {
        "claude-cli" => {
            // 无 scope：设置页前置检查安装不带取消令牌（保持原行为）
            crate::commands::cli_manage::install_claude_cli(app.clone(), None).await
        }
        "git" => {
            #[cfg(target_os = "windows")]
            {
                let china = crate::commands::cli_manage::is_china_network().await;
                let no_scope = crate::commands::download_cancel::CancelScope::new(None);
                crate::commands::cli_manage::install_git_bash_inner(&app, china, &no_scope).await
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(())
            }
        }
        "node" => {
            crate::commands::cli_manage::install_node_env(app.clone(), None).await
        }
        "auth" => {
            crate::commands::auth::start_claude_login(app.clone()).await
        }
        "ollama" => {
            Err("Ollama is not auto-installable. Please download from https://ollama.com/download".into())
        }
        _ => Err(format!("Unknown prerequisite: {}", key)),
    };

    match &result {
        Ok(()) => {
            let _ = app.emit(
                "prereq:install:progress",
                serde_json::json!({ "key": key, "phase": "complete", "message": "Done" }),
            );
        }
        Err(e) => {
            let _ = app.emit(
                "prereq:install:progress",
                serde_json::json!({ "key": key, "phase": "error", "message": e }),
            );
        }
    }

    result
}
