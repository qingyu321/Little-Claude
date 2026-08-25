# Little Claude — 架构快照报告（v1.2.0）

> 生成时间：本会话按需盘点；数据来自工作区 `D:\agent self\agent\tokenicode-src` 实际代码扫描。
> 与仓库内 `ARCHITECTURE.md`（2026-03-02，10 stores / 0.8.0）相比，本快照反映 **当前实际代码** 的规模与模块（19 stores / 1.2.0），可作为架构文档的增量对齐参考。

---

## 1. 项目总览

**Little Claude（tokenicode）** 是为 Claude Code CLI 打造的桌面原生 GUI，基于 **Tauri 2 + React 19 + TypeScript + Tailwind CSS 4 + Zustand 5**，支持 macOS / Windows / Linux。当前版本 **1.2.0**，产物含 `Little Claude.exe` 与 `LittleClaude-Portable.exe`，另有 `editions/alpha` 版本化入口。

### 分层示意

```
┌──────────────────────────────────────────────┐
│  React 前端（155 文件 / ~53.4k LOC）           │
│  App.tsx → AppShell → Sidebar|ChatPanel|面板   │
│  19 个 Zustand store ｜ tauri-bridge.ts 单一入口│
└───────────────┬──────────────────────────────┘
                │  Tauri IPC：invoke + events（147 个 command）
┌───────────────▼──────────────────────────────┐
│  Rust 后端（48 文件 / ~32.6k LOC）             │
│  lib.rs（3,060 LOC）+ commands/*（31 模块）     │
│  backends/（Claude / DeepSeek / Codex）        │
│  ProcessManager · StdinManager · WatcherManager│
└───────────────┬──────────────────────────────┘
                │  stdin/stdout 管道（NDJSON + 控制协议）
        Claude Code CLI ｜ DeepSeek Harness ｜ Codex CLI
```

---

## 2. 技术栈清单

| 层 | 技术 | 说明 |
|----|------|------|
| 桌面壳 | Tauri 2（`@tauri-apps/api 2.11`，CLI 2.11） | 原生窗口 + 系统集成 |
| 前端框架 | React 19.1 + TypeScript 5.8 | 函数组件 + 类型安全 |
| 样式 | Tailwind CSS 4（`@tailwindcss/vite` + typography） | 原子类 + 富文本排版 |
| 状态 | Zustand 5（19 个 store） | `persist` 中间件持久化 localStorage |
| 富文本输入 | TipTap 3（starter-kit / placeholder / hard-break） | 附带文件 chip 扩展 |
| 代码预览 | CodeMirror 6（@uiw/react-codemirror 4.25） | 12 种语言 lang 包 + vscode 主题 |
| Markdown | react-markdown 10 + rehype-highlight/raw/sanitize + remark-gfm + remark-cjk-friendly | 中文友好渲染 |
| 虚拟列表 | react-virtuoso | 会话分页大列表 |
| 测试 | Vitest 4 + @vitest/coverage-v8 | 单测 / 覆盖率 |
| 构建 | Vite 7 + @vitejs/plugin-react | dev / build |
| 后端 | Rust (tokio / serde / reqwest 0.12 / notify) | 进程、文件、网络 |
| 原生插件 | plugin-dialog / notification / opener / process | 系统对话框、通知、打开方式 |
| 富交互扩展 | speech（语音）、video-analysis（feature 门控）、pet（桌面宠物）、wallpaper | 增值模块 |

依赖要点：`dependency` 集中在上述；另有 `@codemirror/lang-*` 全语言族，`highlight.js`、`@lezer/highlight`。

---

## 3. 模块概览

### 3.1 前端 Store（19 个）

| Store | 职责 | 持久化 |
|-------|------|--------|
| `chatStore` | 消息、流式状态、per-tab 缓存、权限态 | 否 |
| `sessionStore` | 会话列表/选中/草稿、stdin→tab 路由、置顶/归档 | 否（名称落盘） |
| `settingsStore` | 主题/字号/语言/模型/模式/布局、onboarding 标识 | 是（localStorage） |
| `fileStore` | 文件树、预览、编辑缓冲、changed 文件、最近项目 | 否 |
| `agentStore` | 多智能体树、阶段追踪、per-tab 缓存 | 否 |
| `commandStore` | 统一命令（内置+自定义+技能）前缀模式 | 否 |
| `skillStore` | 技能 CRUD / 启停 / 内容编辑 | 否 |
| `providerStore` | 多厂商 API 配置、模型映射、活跃厂商 | 是（providers.json） |
| `setupStore` | CLI 安装/登录向导 | 否 |
| `mcpStore` | MCP 服务器（读 ~/.claude.json） | 否 |
| `speechStore` | 语音识别/合成状态 | 否 |
| `videoAnalysisRuntimeStore` | 视频分析运行时 | 否 |
| `goalStore` | 会话目标（DSH ui-goal 移植）：单目标可编辑/暂停/恢复，localStorage | 是 |
| `todoStore` | 会话待办（pending/in_progress/completed） | 否（内存为主） |
| `feedbackStore` | 消息反馈 | 否 |
| `interviewStore` | 面试助手会话态 | 否 |
| `previewStore` | 独立预览面板态 | 否 |
| `tokenSpeedStore` | Token 速率/统计 | 否 |
| `lightboxStore` | 图片灯箱 | 否 |

> 新增对比 ARCHITECTURE.md：扩出 speech / videoAnalysis / goal / todo / feedback / interview / preview / tokenSpeed / lightbox 共 9 个新 store。

### 3.2 Rust 后端（commands/* 31 模块 + interview + backends）

`tauri::command` 总计 **147 个**；`lib.rs` 为装配入口（3,060 LOC，较旧文档 4600 描述已重构拆分）。

| 域 | 模块 |
|----|------|
| 会话/进程 | `session`、`claude_process`、`cli_resolver`、`dsh_service`、`handoff` |
| 厂商后接 | `backends/claude.rs`、`backends/deepseek.rs`、`backends/codex.rs`、`codex_config.rs`、`dsh_events.rs` |
| 文件/项目 | `files`、`search`、`ls_persist` |
| 技能/命令 | `skills`、`skill_translation` |
| 重放/回滚 | `rewind` |
| 导出 | `export` |
| 厂商/模型 | `provider`、`local_model`、`anthropic_proxy`、`model_windows` |
| 语音 | `speech`、`speech_runtime` |
| 视频 | `video_analysis`（feature 门控） |
| 宠物/壁纸/外观 | `pet`、`wallpaper`、`ui` |
| 升级/签名 | `web_update`、`download_cancel` |
| 元数据/资料 | `metadata`、`profile`、`preview` |
| 安装/运维 | `cli_manage`、`prereq`、`auth`、`git`、`external` |
| 面试 | `interview/`（mod、protocol、commands、local_asr、system_audio） |

### 3.3 关键前端管线

- **流式消息**：`hooks/useStreamProcessor.ts` 解析 `claude:stream` NDJSON → `chatStore`，支持前台/后台 tab 分流。
- **IPC 单一入口**：`lib/tauri-bridge.ts` 封装全部 invoke + 事件监听。
- **分页加载**：会话列表 `load_session_tail / load_session_more`（512KiB 倒序块）配合 `react-virtuoso firstItemIndex` 向上翻页。
- **DSH 对接**：`dsh_service` + `handoff`（`write_handoff_file` → `<cwd>/.tokenicode/handoff/`）、fork 会话、zstd 日志读取。
- **依赖注入与签名**：`web_update` 强制 ed25519 签名校验（payload = `version|sha256|zipUrl`）。

---

## 4. 关键文件索引

| 关注点 | 文件 |
|--------|------|
| 前端入口/装配 | `src/App.tsx`、`src/main.tsx`、`pet-main.tsx`（宠物壳） |
| 布局 | `src/components/layout/AppShell.tsx`、`Sidebar.tsx`、`SecondaryPanel.tsx` |
| 会话界面 | `chat/ChatPanel.tsx`、`InputBar.tsx`、`MessageBubble.tsx`、`TiptapEditor.tsx` |
| 状态（19） | `src/stores/*.ts`（见 3.1 表） |
| 流处理 | `src/hooks/useStreamProcessor.ts`、`useFileAttachments.ts`、`useRewind.ts` |
| IPC 桥 | `src/lib/tauri-bridge.ts` |
| i18n | `src/lib/i18n.ts` + `i18n-dict-zh.ts` + `i18n-dict-en.ts` |
| 会话装载/导出 | `lib/session-loader.ts`、`session-disk-load.ts`、`session-exporter.ts`、`turns.ts` |
| 版本/版本化 | `src/lib/edition.ts`、`version.ts`、`src/lib/changelog.ts` |
| 目标/待办 | `src/stores/goalStore.ts`、`todoStore.ts`；组件 `chat/GoalBar.tsx`、`chat/TodoDock.tsx`、`chat/DeliverablesChips.tsx` |
| 面试助手 | `src/components/interview/*`、`src-tauri/src/interview/*` |
| 插件面板 | `src/components/plugins/PluginsPanel.tsx` |
| Onboarding | `src/components/onboarding/OnboardingWizard.tsx` |
| 统计弹窗 | `src/components/profile/ProfileStatsModal.tsx` |
| Rust 入口/命令 | `src-tauri/src/lib.rs`、`commands/mod.rs`、`commands/claude_process.rs`、`protocol.rs`（SDK 控制协议） |
| 后端厂商 | `src-tauri/src/backends/{claude,deepseek,codex,codex_config,dsh_events}.rs` |
| 面试协议 | `src-tauri/src/interview/protocol.rs` |
| 构建/脚本 | `scripts/`（含 `sign-web-update.py`、`make-web-update.ps1`） |

---

## 5. 与仓库内 ARCHITECTURE.md 的差异（快速对齐）

| 项 | 旧文档（2026-03） | 现状（快照） |
|----|------------------|--------------|
| 版本 | 0.8.0 | 1.2.0 |
| Stores | 10 | 19（+speech/videoAnalysis/goal/todo/feedback/interview/preview/tokenSpeed/lightbox） |
| Rust 规模 | lib.rs ~4600 LOC 单文件 | 拆分为 lib.rs 3060 + commands/*（31 模块），147 个 command |
| 后端 | 仅 Claude CLI | Claude + DeepSeek Harness + Codex 三款后接 |
| 特征模块 | — | 面试、语音、视频分析、桌面宠物、本地模型、插件面板、签名热更新、token 统计 |

---

*报告为只读盘点产物，不修改任何源码。*
