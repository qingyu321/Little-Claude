# DeepSeek Harness CLI 集成调研报告（Little Claude）

> **报告日期**：2026-08-13
> **调研方式**：联网搜索（官方新闻 + GitHub 生态）+ 本地代码全量分析（Explore agent 逐文件核实行号）
> **状态**：调研完成，**尚未动手**。官方 CLI 未发布，等发布后按本报告路径实施。
> **本报告用途**：直接喂给任务（agent）即可开始集成工作，无需重新调研。

---

## 一、任务目标

1. **目标 A（集成）**：将 DeepSeek 官方开源 harness 的 CLI 集成进 Little Claude（Tauri 2 + React 桌面应用），作为与 Claude CLI、Codex CLI 并列的第三后端。
2. **目标 B（首选）**：把该 harness 设置为 Little Claude 的**首选（默认）harness**——新会话、聊天头切换、安装向导、Provider 表单全部默认指向它。
3. **前置条件**：DeepSeek 官方 CLI 尚未发布（见 §二），须在其发布后先验证协议形态（§四.2 的决策点 D1），再决定走哪条集成路径。

---

## 二、联网调研结论（2026-08-13 为止）

### 2.1 官方状态：确认在自研，未发布

- **2026 年 5 月**：DeepSeek 高级研究员陈德立确认内部组建 Agent Harness 团队，目标「Build DeepSeek Code Harness from scratch, to rival Claude Code」，官网随后放出大量相关岗位。
- **2026 年 7 月底**：团队负责人崔天意（ACM 金牌得主）线上招募开发者。
- **2026-08-11**：36kr/量子位报道称官方版本「几乎要推出了」（It's almost ready to launch），**无具体发布时间**。
- **结论**：截至今天官方 CLI 尚未发布；生态已围绕 DeepSeek V4（Pro/Flash）形成大量第三方 harness。

来源：[36kr/量子位报道](https://eu.36kr.com/en/p/3934404658642055)

### 2.2 社区候选 harness 全景

| 项目 | 作者/组织 | 形态 | 协议 | 集成适配性评估 |
|---|---|---|---|---|
| **zagens** | didclawapp-ai | Rust harness v0.9.0：headless CLI `zagens` + TUI `zagens-tui` + **Windows Tauri 桌面应用** | **自有协议**（Kernel V3 事件源），非 stream-json/SDK 控制协议 | 中——需完整翻译层；但其本身就是 Tauri 应用，与我们产品形态重叠 |
| **deepseek-harness** | HenryZ838978（ModelBest/MiniCPM 团队） | Python 库 `pip install deepseek-harness` + `dsh` CLI（chat/doctor/validate）+ MCP server `npx @deepseek-harness/mcp`，MIT，2026-05-09 | 协议适配器；文档化 **16 个 DeepSeek API 协议怪癖**、12 个探针、270+ 试验审计 | 中——更像 API 适配层而非完整 harness |
| **tylerbuilds/deepseek-harness** | tylerbuilds | Node.js v0.3.0「MorpheOS Code」：Ink TUI、8 工具、SQLite 会话持久化 + resume、slash commands、873 测试 | 自有 | 中 |
| **DeepSeekCode** | QingJ01（npm `@qingj/deepseekcode`） | **Claude Code 源码 fork**（in-place 改 ~10 个文件把 API 路由到 DeepSeek Anthropic 端点） | ✅ **与 Claude Code 完全兼容**（stream-json + 权限协议原版） | **最高**——协议零翻译；1M 上下文；模型别名 pro/flash；配置隔离 `.deepseek-code` |
| **wtcc** | UnstoppableCurry | Claude Code fork：中文 i18n（378 key）+ 多 provider（Anthropic/OpenAI/Gemini/DeepSeek/Kimi/GLM/Qwen 一套 CLI） | ✅ Claude Code 协议 | 高——但多 provider 定位与我们自己的 Provider 系统重叠 |
| **DeepSeek-TUI** | Hmbown | Rust 终端 Agent，1.9 万 star：**RLM 架构**（Pro 主模型调度 ≤16 个 Flash 子模型并行）、1M 上下文、三档操作模式（Plan/Agent/YOLO）、思考过程流式输出、MCP、LSP 诊断、会话保存恢复、HTTP/SSE 运行时 API | Codex 风格架构 | 高——能力最接近 Claude Code；安装 `npm install -g deepseek-tui` 或二进制包（含 Windows） |
| **deep-claude** | dennisonbertram | 本地代理：把 Claude Code 指向 DeepSeek/OpenRouter 的 Anthropic 兼容端点，配置隔离 | ✅ 协议不变（代理层透明） | 高——但只是代理，不是独立 harness；与我们的 anthropic_proxy 思路同源 |
| **deepseek-as-subagent** | PsChina | MCP server：让 DeepSeek 在 Claude Code / Codex CLI 里作为**真正的 sub-agent**（自己的 7 工具循环）运行 | N/A | 不替代 harness——但可作为「DeepSeek 优先」的补充方案 |

### 2.3 生态共识（集成时直接用到的知识）

- **官方 Anthropic 兼容端点**：`https://api.deepseek.com/anthropic`（支持字段：model/max_tokens/stop_sequences/stream/system）——本项目当前已在用（用户现处于「A 格式」直连）。
- **环境变量惯例**：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（DeepSeek key）、`ANTHROPIC_MODEL=deepseek-v4-pro`、`CLAUDE_CODE_SUBAGENT_MODEL`。
- **`CLAUDE_CODE_ATTRIBUTION_HEADER=0`** 可显著提升 DeepSeek 缓存命中率（实测 50%→90%+）。
- **DeepSeek API 协议怪癖**（deepseek-harness 文档化，集成时注意）：
  - `reasoning_content` 必须原样回传（thinking 模式强制要求，缺失报 400）；
  - thinking 默认开启；
  - 上下文上限 1,048,576 token（1M）；
  - 官方单端点原生支持工具 + 搜索（无 `type` 格式、免 `reasoning_content` 拆分）。
- **成本/缓存参考**（Pi harness 数据，仅参考）：99.93% 缓存命中率下 10 亿 token 约 19 元；DeepSeek V4 Flash 单任务平均 $0.028 vs Claude Code $0.195（约 7 倍差距）——**这正是「首选 DeepSeek harness」的经济动机**。
- **Pi 的 DeepSeek 适配要点**（2026-04 加入原生支持）：修复 V4 会话回放的 400 错误、按 DeepSeek 接口保留 reasoning_content、内部推理强度映射到 DeepSeek thinking 级别。

---

## 三、项目架构现状（集成前必读）

### 3.1 双 CLI 抽象层已存在（最大的好消息）

```
src-tauri/src/backends/mod.rs
  ├── trait CliBackend            （spawn / env / initial message / translate_stdout_line / build_*）
  │     └── translate_stdout_line → UnifiedEvent（mod.rs:109-202，8 种：stream_event /
  │          assistant / user / system / permission_request / result / process_exit / rate_limit_event）
  ├── backends/claude.rs          NDJSON 透传实现
  └── backends/codex.rs           JSON-RPC App Server 协议翻译实现（第二后端的完整范例）
```

- **UnifiedEvent 是前端唯一认的事件形态**——翻译层正确时前端流处理**零改动**（codex 已实证）。
- **codex 范例关键函数**：
  - `CodexBackend::find_binary`（codex.rs:75-109）——PATH 手动扫 + npm 全局目录；
  - `build_permission_response`（codex.rs:212-228）——权限响应回 JSON-RPC result；
  - `translate_notification` / `translate_response`（codex.rs:296-691）——事件翻译全集；
  - `translate_approval_request`（codex.rs:693-720）——把外部权限请求翻译成 `UnifiedEvent::PermissionRequest`。
- **重要遗留**：Claude 主路径 `start_claude_session`（session.rs:128）**并未走 trait**，是硬编码独立实现；codex 走 `start_codex_session`（lib.rs:1390，走 trait）。集成 DeepSeek 时两个选择：仿 codex 走 trait（推荐），或顺手把 Claude 路径也重构进 trait（§七 建议先做，见决策点 D2）。

### 3.2 前端链路（零改动的前提）

- `useStreamProcessor.ts`：`KNOWN_STREAM_TYPES`（:242-246）= little_claude_permission_request / stream_event / system / assistant / user / human / tool_result / tool_use_summary / result / process_exit / content_block_delta / rate_limit_event；消费字段含 `content_block_start/delta`（text_delta/thinking_delta/tool_use）、`message_start/message_delta` 的 usage、`user` 消息 `uuid`（checkpointUuid，:1379）。
- `session-loader.ts`：`parseSessionMessages`（:88-320）解析 Claude JSONL——`type: user/human/assistant`、`message.content` 块（text/tool_use/tool_result/thinking）、`uuid`/`parentUuid`/`sessionId`/`isSidechain`/`userType: external`/`entrypoint`/`cwd`/`version`/`gitBranch`/ISO `timestamp`/`isMeta`（:121-122）。
- `turns.ts`：`parseTurns`/`extractCodeChanges`（:36-119）纯函数，只依赖 `toolName`（Edit/Write/Bash，:100-115）与 `checkpointUuid`（:68）——DeepSeek 用相同工具名则零改动。

### 3.3 通用基础设施（与 CLI 无关，直接复用）

- `ProcessManager` / `StdinManager` / Windows Job Object（commands/claude_process.rs:129-370）——纯进程管理；`ManagedProcess.backend` 字段（:140）已字符串化，加 `"deepseek"` 即可。
- `StartSessionParams`（claude_process.rs:372-405）：`cli_backend: Option<String>`（:398-399）已存在；`SessionInfo`（:129-134）通用。
- Windows `cmd /C` 包装（session.rs:632-660）、错误 193/13/88 重试（:662-791）、MSYS 路径转换禁用（:540-548）——全部通用。

---

## 四、集成改动面全清单（按优先级）

### 4.1 CLI 进程启动 【必需】

- **注册点**：`resolve_backend`（backends/mod.rs:307-312，`match name.unwrap_or("claude")`）、`backend_names`（mod.rs:315-317）——加 `"deepseek"`。
- **路由分支**：`start_claude_session` 内 `cli_backend == "codex"` 分支旁（session.rs:166-177）加 `"deepseek"`；provider 声明的 backend 覆盖（session.rs:150-164，`provider.cli_backend == "codex"` 时改路由）同步扩展。
- **Claude 专用 spawn 参数**（session.rs:182-236，新 CLI 不支持则必须翻译/省略）：
  | 参数 | 行号 | 依赖方 |
  |---|---|---|
  | `--input-format stream-json` | 182-184 | 流式输入 |
  | `--output-format stream-json` | 185-186 | 流式输出 |
  | `--verbose` | 187 | 调试 |
  | `--replay-user-messages` | 188 | Rewind/checkpoint |
  | `--strict-mcp-config` | 192 | MCP 冷启动 |
  | `--include-partial-messages` | 195-200 | A2 性能开关 |
  | `--resume <uuid>`（含 UUID 校验） | 204-216 | 会话恢复 |
  | `--allowedTools` | 220-225 | 工具白名单 |
  | `--permission-mode` + `--permission-prompt-tool stdio` | 231-235 | **SDK 控制协议**（§4.2） |
  | `--model` | 335-338 | 半通用 |
  | `--settings <json>` | 465-466 | Claude settings.json 覆盖 |
- **Claude 特有 env 注入**（session.rs:471-572）：`CLAUDE_CODE_EFFORT_LEVEL`（472）、`CLAUDE_CODE_MAX_OUTPUT_TOKENS`（482）、`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`（489，rewind 依赖）、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（517-529）、`CLAUDE_CODE_GIT_BASH_PATH`（550-571，**Windows 硬性要求，缺失直接报错**）、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`（lib.rs:1116）。
- **通用部分复用**：`PROXY_CLEAR_VARS` + `NO_PROXY=*`（session.rs:268-272, 357-362）。

### 4.2 协议解析 【必需，决策点 D1】

- **Claude 路径 stdout 解析**（session.rs:853-1167）：逐行 NDJSON（916-919），`control_request` 截获（925-1062）：`can_use_tool` → 发 `little_claude_permission_request` 给前端（1006-1015）；`hook_callback` → 自动 allow（1017-1029）；未知 subtype → deny（1030-1043）；bypass 模式自动批准（940-969）。
- **SDK 控制协议缺失的后果**（DeepSeek 不实现时）：权限批准/拒绝（`respond_permission` session.rs:1272）、运行中 interrupt（`send_control_request` session.rs:1361）、运行时切模型/权限模式、AskUserQuestion/ExitPlanMode 路由（前端 QuestionCard/PlanReviewCard 依赖）、rewind 的 `rewind_files` control_request（protocol.rs:129-135）全部不可用。
- **处理方式（codex 已示范）**：写翻译层把外部协议请求翻译成 UnifiedEvent；`protocol.rs` 的 SDK 控制协议类型仅 Claude 使用。
- **决策点 D1（等官方 CLI 发布后验证）**：
  - **路径 1（最省力）**：官方 CLI 兼容 Claude 的 `--output-format stream-json` + `--permission-prompt-tool stdio`（DeepSeekCode fork 证明 DeepSeek API 走 Anthropic 格式无障碍）→ 直接仿 claude.rs 透传，翻译层免写，工作量约为 codex 的 60%。
  - **路径 2**：自有协议 → 仿 codex.rs 写翻译层（1 个文件）。

### 4.3 前端流处理 【翻译层正确时零改动】

- `useStreamProcessor.ts` 全部事件分支（stream_event :803/:1760、assistant :957/:1938、user/human :1170、result :1232、process_exit :1424、system/init :1507-1510、little_claude_permission_request :692）。
- **codex 已验证此路径**：翻译到 Claude 兼容形态后此文件无需改动。

### 4.4 CLI 检测与安装 【必需】

- `find_claude_binary`（lib.rs:287-289）→ `cli_resolver::find_binary`（cli_resolver.rs:942）；分层扫描 `collect_tiered_dirs_inner`（:362-459）：Tier 0 官方目录 / Tier 1 AppLocal（`%LOCALAPPDATA%/<app>/cli`，lib.rs:131-133）/ Tier 2 系统（npm/scoop/Volta）；`bin_names()`（:650-657）已含 `["claude.exe","claude.cmd","codex.exe","codex.cmd"]`——加 DeepSeek 二进制名。
- `check_claude_cli`（cli_manage.rs:137）、`check_codex_cli`（cli_manage.rs:327）——DeepSeek 需 `check_deepseek_cli`（`--version` 探测，2s 超时 + fallback）。
- 安装：`install_claude_cli`（cli_manage.rs:1996）/ `install_codex_cli`（cli_manage.rs:552，npm `@openai/codex`）——DeepSeek 对应 npm 包 + `update_*` + `check_*_update`（cli_manage.rs:594-735）+ pin/delete/cleanup（cli_resolver.rs:982-1100）。
- 前端：`SetupWizard.tsx:46-127`（checkClaudeCli → install → 验证）；`setupStore.ts`（step/cliVersion/cliPath 状态机）；设置页 `CliTab.tsx`（`cliType: 'claude' | 'codex'` 双卡片，:33；更新/取消仅 claude 支持 CancellationToken，:52-56）。

### 4.5 Provider/模型注入 【必需】

- `resolve_provider_env`（lib.rs:994-1127）：注入 `ANTHROPIC_BASE_URL`（:1046-1056，去 `/v1` 归一化）、`ANTHROPIC_API_KEY`（:1062-1066）、`extra_env`（:1072-1087）、清 `ANTHROPIC_AUTH_TOKEN`（:1097）、proxy（:1101-1105）——全部是 Anthropic 协议假设；若 DeepSeek 官方 CLI 走自有协议需新建注入策略。
- `--settings` env 覆盖（session.rs:364-466）：`ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`（:409-422）——Claude 特有。
- `anthropic_proxy.rs`（session.rs:284-330）：provider `api_format == "openai"` 时启动本地转换代理——DeepSeek 走 Anthropic 兼容端点则保留，走自有协议则不需要。
- 前端：`api-provider.ts`（`resolveModelOrError` :24-71：opus/sonnet/haiku tier 映射——**DeepSeek 需自己的 modelMappings**；`envFingerprint` :104-122 按 backend 指纹化）、`providerStore.ts`（`ApiProvider.cliBackend: 'claude'|'codex'` :41-42、`activeProviderPerBackend` :55-56、`getActiveProviderForBackend` :73）、`api-config.ts`（:17-18 同字段）、`ModelSelector.tsx:34-36`——全部需扩 `'deepseek'`。

### 4.6 会话生命周期 【必需——最大改动面】

**会话目录硬编码 `~/.claude/projects/`（约 8 处）**：
- `list_sessions`（session.rs:1680-1739）：扫 `~/.claude/projects/<encoded_cwd>/<uuid>.jsonl`（:1682）、`extract_session_info_cached` 读 preview/cwd/origin（:1717）。
- `load_session`（session.rs:2211-2255）：canonical 校验必须在 projects 树内（:2214-2233），50MiB 上限。
- `delete_session`（session.rs:1632-1677）：canonical 校验（:1653-1671）。
- `truncate_session_history`（session.rs:2381+，rewind 用）。
- `rewind_files`（rewind.rs:43-48）——`claude --resume --rewind-files`，**硬编码 claude binary**（rewind.rs:30-39）。
- 导出：`export_session_markdown`/`export_session_json`（export.rs:163, :269，路径校验 export.rs:69-115）；`list_recent_projects`（export.rs:313）。
- `search_sessions`（search.rs:68）。
- 辅助：`tracked_sessions.txt`（session.rs:1460-1463，app 侧所有权索引）、`session_names.json`（metadata.rs:20，重命名/收藏按 session id，不依赖路径）、`encode/decode_project_name`（session.rs:1931-2100）。

**策略二选一（决策点 D3）**：
- **方案 (a) 兼容方案（推荐，codex 已示范）**：会话文件仍写 `~/.claude/projects/`，格式由 app 侧重建——`export_codex_to_claude`（cli_manage.rs:780-851）+ 前端 `reconstructJsonl`（src/lib/session-exporter.ts:187-259）生成 Claude 兼容 JSONL。**所有生命周期命令零改动**。
- **方案 (b) 参数化方案**：projects_root 按 backend 解析（如 `~/.deepseek/projects`）——上述 8 处全改 + 前端 SessionListItem.path 语义变化。
- **origin 标记坑**：`_origin` 字段（session.rs:1853-1860）从 JSONL 的 `system/init` 行的 `_origin` 读，缺省 `"claude"`；**本仓库没有任何地方写 `_origin`**（`.codex-origin` 标记文件写了但没人读），实际 origin 恒回退 "claude"——DeepSeek 若要正确 origin，必须在重建 JSONL 时注入 `_origin: "deepseek"`。

### 4.7 首选 harness 【必需，改动点多但浅】

- **配置点已存在**：`settingsStore.ts:262` `cliBackend: 'claude' | 'codex'`（持久化）——扩展为 `'claude' | 'codex' | 'deepseek'`。
- **默认值散布点（全部 `|| 'claude'`，共 17 处，要改为指向新默认）**：
  - `useStreamProcessor.ts:1389, 2517, 2808`
  - `ChatPanel.tsx:435, 1055, 2053, 2068`
  - `InputBar.tsx:413, 1103, 1278, 1294`
  - `api-provider.ts:25, 106, 120`
  - `ModelSelector.tsx:34`
  - `usePetBridge.ts:100`
  - `providerStore.ts:321`
  - `backends/mod.rs:308`
- **UI 呈现**：
  - `CliBackendToggle`（ChatPanel.tsx:433-518，聊天头下拉切换 + 确认弹窗）——硬编码 `(['claude', 'codex'])`（:476）；
  - `CliTab.tsx` 双卡片（:456-476）；
  - `ProviderForm` 的 cliBackend 选择；
  - `ConversationSearch.tsx:17, 188, 402`（`BackendFilter = 'all' | 'claude' | 'codex'` 过滤器）；
  - `ConversationList.tsx:355`（`session.origin || 'claude'`）；
  - i18n（i18n.ts:789-796, 2000-2007）。
- **"首选"的完整语义**：默认值从 `'claude'` 改为 `'deepseek'` + SetupWizard/CliTab 默认卡片换成 DeepSeek + 新用户 onboarding 默认。

### 4.8 命令/技能/重放 【部分必需】

- **Slash commands**【可选】：`list_all_commands`（skills.rs:680-712）扫 `~/.claude/commands/*.md` + `{cwd}/.claude/commands/*.md`（已兼容 `.codex/skills`/`.agents/skills`，:800）；`run_claude_command`（cli_manage.rs:79-133）**硬编码 claude binary**——需按 backend 分派；`commandStore.ts:23-26` 已带 backend 参数；`run_claude_plugin_command`（cli_manage.rs:60）【不需要】。
- **Skills**【可选】：`list_skills`/`read_skill`/`write_skill`/`delete_skill`/`toggle_skill_enabled`（skills.rs:455-724）目录约定同上（另兼容 `.codex/skills`）；`skill_translation.rs` 同理。
- **Rewind/checkpoint**【必需（若保功能）】：依赖链 `--replay-user-messages`（session.rs:188）→ 用户消息 uuid 作 checkpointUuid（useStreamProcessor.ts:1379）→ `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`（session.rs:489）→ SDK `rewind_files` control_request（protocol.rs:129-135）或一次性 `claude --resume --rewind-files`（rewind.rs:43-48）；前端 `useRewind.ts`（`restoreFilesViaCheckpoint` :30-52 无 checkpoint 静默降级 + `truncateSessionHistory` :143）。**DeepSeek 无原生 checkpoint 时**：降级为仅对话回退，文件恢复需 app 侧快照（可选实现）。
- **其他硬编码 claude 的能力**：标题生成 `generate_session_title`（metadata.rs:85-214）用 `claude -p --output-format json --max-turns 1 --dangerously-skip-permissions`（:112-123）——需对应 one-shot 模式或改走主模型直呼。
- **登录**【不需要】：`start_claude_login`/`check_claude_auth`（auth.rs）——DeepSeek 通常 API key 模式。

---

## 五、功能依赖裁剪表（官方 CLI 协议未知时的风险区）

| 能力 | 依赖 | 官方 CLI 不实现时 | 工作量 |
|---|---|---|---|
| 权限确认（PermissionCard） | SDK 控制协议 `can_use_tool` | 降级：bypass 模式 / 翻译层（codex 已示范） | 中 |
| Rewind 文件恢复 | `--replay-user-messages` + `rewind_files` | 降级：仅对话回退 + app 侧文件快照 | 中-大 |
| 运行时切模型/权限模式 / interrupt | SDK control protocol | 降级：重启进程实现 | 小 |
| AskUserQuestion / PlanReview | SDK control protocol | 翻译层 or 不展示 | 小-中 |
| Slash commands / Skills | `~/.claude/commands`、`~/.claude/skills` 目录约定 | 沿用约定零改动；否则加目录 | 小 |
| 会话恢复 `--resume <uuid>` | CLI 原生 | app 侧 JSONL 重建（方案 a） | 中 |
| 标题生成 | `claude -p` one-shot | 按 backend 分派 or 主模型直呼 | 小 |
| MCP | `--strict-mcp-config` + 协议 | 取决于 CLI 原生 MCP 支持 | 未知 |

---

## 六、实施步骤（官方 CLI 发布后按序执行）

1. **协议验证（决策点 D1）**：官方 CLI 发布后，用 `--help` / 实测确认：是否支持 `--output-format stream-json`？是否支持 `--permission-prompt-tool stdio`（SDK 控制协议）？会话文件格式？→ 决定路径 1（透传）或路径 2（翻译层）。
2. **【建议先行，不依赖官方】Claude 主路径重构进 trait**（决策点 D2）：把 `start_claude_session`（session.rs:128）的硬编码逻辑收敛进 `CliBackend`，避免第三个后端再复制一份硬编码——codex 集成时就该做，现在做成本最低。
3. **`backends/deepseek.rs`**：实现 `CliBackend`（spawn / env / initial message / translate_stdout_line / build_*）——仿 codex.rs（路径 1 则仿 claude.rs 更简）。
4. **注册与路由**：`backends/mod.rs:307-317` 加 `"deepseek"`；`session.rs:150-177` 加路由分支；`ManagedProcess.backend` 字段。
5. **CLI 检测/安装**：`find_binary` 扩展（仿 codex.rs:75-109）+ `check_deepseek_cli` / `install_deepseek_cli` / update / pin / delete / cleanup（仿 cli_manage.rs:327-735）+ SetupWizard 卡片 + CliTab 卡片。
6. **前端字符串扩展**：`settingsStore.cliBackend` 联合类型 + 17 处默认值 + CliBackendToggle / ProviderForm / ConversationSearch / i18n / ModelSelector。
7. **Provider**：`cliBackend: 'deepseek'` 类型 + env 注入策略（Anthropic 兼容则复用 `ANTHROPIC_*`，否则新建）+ 模型映射（DeepSeek 模型 ID 列表）。
8. **会话存储**：选方案 (a) 重建 JSONL 写 `~/.claude/projects/`（仿 `export_codex_to_claude` + `reconstructJsonl`，**注入 `_origin: "deepseek"`**）——所有生命周期命令零改动；或方案 (b) 参数化 projects root（8 处全改）。
9. **功能裁剪落地**：按 §五 表格逐项决定（权限/rewind/slash/skills/标题生成）。
10. **首选化**：默认值指向 deepseek + 向导/设置默认卡片。
11. **验证**（§七）+ 发布（§八）。

---

## 七、验证方案

1. `cd src-tauri && cargo check && cargo test`（后端，注意现有 55 个测试全绿基线）+ `cargo clippy`。
2. `npx tsc --noEmit`（前端 0 错误基线）+ `npx vitest run`（4 文件 43 测试基线）。
3. 手动 `pnpm tauri:dev` 全流程：
   - 新会话默认走 DeepSeek（首选生效）；
   - 聊天头 CliBackendToggle 三选一切换 + 确认弹窗；
   - 流式文本/思考/工具调用/权限卡片（或降级形态）正常；
   - 会话列表 origin 标记正确（`_origin: "deepseek"`）；
   - 重开会话（resume）恢复消息与 Ctx bar 统计；
   - 删除/重命名/收藏/导出/搜索对 deepseek 会话可用；
   - 后台会话 + 多标签并发；
   - Rewind 行为（原生或降级）；
   - Slash commands / Skills 目录约定。
4. 跨会话场景：与 claude/codex 会话并存、切换后端时 Provider 各用各的（activeProviderPerBackend）。

---

## 八、发布流程（沿用既有手动流水线）

1. 版本号 + changelog（changelog.ts / README 两仓库）。
2. `pnpm tauri build --no-bundle` → `src-tauri/target/release/little-claude.exe` → 拷贝 `release-artifacts/`。
3. `python scripts/replace-release-asset.py <tag> <exe>`（DELETE 旧 + POST 新，uploads.github.com）。
4. PATCH release body（追加 rebuilt 条目 + 更新校验和）。
5. pub-repo：README + latest.json sha256 提交推送（`GIT_SSL_NO_VERIFY=true`）。
6. 验证三件套：raw latest.json / API digest / HEAD Content-Length。
7. 注意：`git push` 必须用 D:\Git；代理不稳时 curl 加 `-k` 重试。

---

## 九、背景与相关历史（任务上下文，避免重复踩坑）

### 9.1 本项目 DeepSeek 使用史（2026 年）

- 用户长期以 DeepSeek 为主力模型，端点形态：`https://api.deepseek.com/anthropic`（A 格式直连），模型 `deepseek-v4-pro` / `deepseek-v4-flash`。
- **Ctx bar 双倍计数修复（2026-08-13 刚发布）**：DeepSeek 语义下 `input_tokens` 已含缓存份额（96/96 usage_log 记录验证 input == cache_read + cache_creation），新增 `src/lib/context-tokens.ts` 的 `semanticContextTokens` 语义探测公式——集成 DeepSeek 官方 CLI 时**必须延续此公式**（其 usage 语义大概率同 DeepSeek API）。
- 环境变量污染教训：`settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 曾污染 CLI 标题请求导致 401——现用 `--settings` 注入覆盖。

### 9.2 opencode 网关集成失败史（前车之鉴）

| 问题 | 根因 | 教训 |
|---|---|---|
| tool_result → 400 | opencode zen 网关不支持工具结果回传 | 集成前必须验证工具回传协议 |
| Go 的 deepseek 403（RegionError） | 模型托管中国区需账户 opt-in | 非密钥/代理问题，排查要快 |
| 模型名大小写敏感 | 网关只认小写 | 模型映射要规范化 |
| WebSearch 401 | 代理层只转 output 丢 input/缓存；会话被 opencode 代理劫持 | 集成时要验证 usage 字段透传完整性 |

### 9.3 相关项目模块（本任务不涉及）

- 桌宠（pet 模块）、面试助手、视频分析、技能双副本部署（bundled-skills ↔ ~/.claude/skills）——与 harness 集成正交，但注意技能目录约定改动会影响它们。

---

## 十、附录

### 10.1 关键文件速查表

| 文件 | 角色 |
|---|---|
| `src-tauri/src/backends/mod.rs` | CliBackend trait + UnifiedEvent + 注册点（:307-317） |
| `src-tauri/src/backends/claude.rs` | Claude NDJSON 透传实现（翻译层范例-简版） |
| `src-tauri/src/backends/codex.rs` | Codex 翻译实现（**第二后端完整范例**：find_binary :75-109 / translate :296-691 / approval :693-720） |
| `src-tauri/src/commands/session.rs` | Claude 硬编码路径（:128）、spawn 参数（:182-236）、stdout 解析（:853-1167）、env（:471-572）、会话目录（:1680-1739 等 8 处） |
| `src-tauri/src/commands/claude_process.rs` | ProcessManager/StdinManager（复用，加 backend 字符串即可） |
| `src-tauri/src/commands/cli_manage.rs` | check/install/update（codex 范例 :327-735）、export_codex_to_claude（:780-851） |
| `src-tauri/src/commands/cli_resolver.rs` | find_binary / bin_names（:650-657）/ tiered dirs（:362-459） |
| `src-tauri/src/commands/rewind.rs` | rewind_files 硬编码 claude（:30-48） |
| `src-tauri/src/commands/metadata.rs` | 标题生成硬编码 claude（:112-123）、session_names |
| `src-tauri/src/protocol.rs` | SDK 控制协议类型（仅 Claude） |
| `src-tauri/src/lib.rs` | start_codex_session（:1390）、resolve_provider_env（:994-1127）、find_claude_binary（:287-289） |
| `src/hooks/useStreamProcessor.ts` | 前端流处理（翻译正确则零改动） |
| `src/lib/session-loader.ts` | JSONL 解析（:88-320） |
| `src/lib/session-exporter.ts` | reconstructJsonl（:187-259，会话重建关键） |
| `src/stores/settingsStore.ts` | cliBackend 配置点（:262） |
| `src/lib/api-provider.ts` | 模型映射 / envFingerprint（:24-71, :104-122） |
| `src/stores/providerStore.ts` | ApiProvider.cliBackend（:41-42）/ activeProviderPerBackend（:55-56） |
| `src/components/settings/CliTab.tsx` | CLI 管理双卡片（:33, :456-476） |
| `src/components/chat/ChatPanel.tsx` | CliBackendToggle（:433-518） |

### 10.2 外部资源链接

- [36kr/量子位：官方 Harness 进展](https://eu.36kr.com/en/p/3934404658642055)
- [zagens（Rust harness）](https://github.com/didclawapp-ai/zagens)
- [HenryZ838978/deepseek-harness（Python + dsh CLI）](https://github.com/HenryZ838978/deepseek-harness)
- [tylerbuilds/deepseek-harness（Node.js）](https://github.com/tylerbuilds/deepseek-harness)
- [DeepSeekCode（Claude Code fork，协议最兼容）](https://www.npmjs.com/package/@qingj/deepseekcode)
- [wtcc（Claude Code 多 provider fork）](https://github.com/UnstoppableCurry/wtcc)
- [DeepSeek-TUI（Rust，1.9 万 star）](https://cloud.tencent.cn/developer/article/2667249?policyId=1003)
- [deep-claude（本地代理）](https://github.com/dennisonbertram/deep-claude)
- [deepseek-as-subagent（MCP sub-agent）](https://github.com/PsChina/deepseek-as-subagent)
- [awesome-deepseek-agent（官方列表）](https://github.com/deepseek-ai/awesome-deepseek-agent)

### 10.3 决策点汇总

| 编号 | 决策 | 当前建议 |
|---|---|---|
| D1 | 官方 CLI 协议形态（发布后验证） | 兼容 stream-json → 透传路径；否则翻译层 |
| D2 | Claude 主路径是否重构进 trait | **建议先做**（不依赖官方，成本最低） |
| D3 | 会话存储方案 (a) 重建 JSONL vs (b) 参数化目录 | 方案 (a)，codex 已示范，生命周期零改动 |
| D4 | 官方发布前是否先集成社区候选 | **不建议**——翻译层大概率重写；可考虑 DeepSeekCode（协议兼容）作为临时过渡 |
| D5 | rewind 无原生 checkpoint 时的降级范围 | 仅对话回退起步，文件快照后补 |

---

## 十一、v2 批次（2026-08-14）：首选化 + TodoDock + 安装适配

D-N1-B 服务集成（上一轮）完成后，本轮按用户要求收尾三项：

### 11.1 字体大小修复（persist v30）

- 根因：代码默认 `fontSize: 14`（与注释 "default 18" 长期不符）；dev 隔离数据目录
  （`.dev`）初建时把默认 14 落进磁盘快照，此后每次启动灌回 14，用户看到"字体变小"。
- 修复：默认值 14→18；persist version 29→30，migrate 把存量 `fontSize === 14` 一律升 18。
- 正式目录快照本就是 18，不受影响。

### 11.2 DeepSeek Harness 首选化

- `settingsStore` 默认 `cliBackend: 'claude'` → `'deepseek'`（服务模式 = 真流式 + 真上下文延续）。
- 存量用户已持久化的 cliBackend 不被 migrate 改写（尊重既有选择，聊天头部 CliBackendToggle 可随时切）。

### 11.3 TodoDock 步骤面板（转圈/打勾）

- 排查结论：DSH webui 的"总步骤完成情况"= `dsh-tool-todo` 的 `todo_write` 工具 + `todo/write`
  事件（整表替换、last-write-wins）+ `todos` projection（`turn/start` 清空），web 端由
  ui-conversation 的 TodoDock 渲染（折叠头部 + `N 完成 · N 进行中 · N 待办` 计数）。
- LC 此前只有 Claude 风格的树状 TodoMsg（消息流内），缺 DSH 风格常驻面板。
- 落地：
  - Rust `dsh_events.rs`：`todo/write` → `stream_event.todo_update`（透传 3 态列表）；
    `turn/start` → `stream_event.turn_start`（standing plan 清空标记）。+2 单测（真实帧形状）。
  - 前端 `todoStore.ts`（会话内内存）+ `TodoDock.tsx`（GoalBar 旁：折叠头部计数、
    行状态 pending 空圆 / in_progress 旋转环 / completed 打勾）+ `useStreamProcessor`
    消费 `todo_update`/`turn_start` + i18n zh/en。

### 11.4 dsh 依赖安装适配

- Rust：`check_dsh_cli`（二进制 + `--version` + **默认端口 3080 服务探测**
  `dsh_service::probe_default_service`）；`install_dsh_cli`（npm `@deepseek-ai/dsh`，
  中国 registry 优先、npm 缺失时先装 Node，复用 Codex 安装管线）。`CliStatus` 增
  `service_running: Option<bool>`。
- 前端：`tauri-bridge` 增 `checkDshCli`/`installDshCli`；`CliTab` 增 DeepSeek Harness
  卡片（版本 + 服务运行状态点 + 检测/安装按钮，标注"首选"）。

### 11.5 验证

- cargo test **107 passed**（+2 todo 翻译单测）；tsc 0 错误；`vite build` 成功。
