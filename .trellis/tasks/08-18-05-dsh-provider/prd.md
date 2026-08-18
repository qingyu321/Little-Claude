# PRD — DSH provider 一等公民

**优先级**: P1 | **状态**: planning | **来源**: DSH 模块全面排查（用户报告：DeepSeek 没有对应的 API 提供商前端）

## 背景

provider 系统四层（类型/预设/表单/路由）只覆盖 claude/codex：
- `providerStore.ts:29` 类型无 `'deepseek'`；预设/表单/Tab 同缺
- `session.rs:121-135` 路由只识别 `cli_backend:"codex"`
- DSH 的认证/模型完全走 DSH 自己的 `~/.dsh` 配置；`start_deepseek_session` 只传 cwd（lib.rs:2031），前端 model/provider 参数全部丢弃
- 预设里的 "DeepSeek"（api.deepseek.com/anthropic）是走 claude 后端的兼容 API，与 DSH 后端无关，需在 UI 上避免混淆

## 目标

**前端**
1. `ApiProvider.cliBackend` / 预设类型加 `'deepseek'`（providerStore.ts、provider-presets.ts）
2. ProviderForm/ProviderManager 增加 deepseek 选项与第三个 Tab
3. 新增 DSH 原生预设（官方 DeepSeek 模型映射）
4. `setActive` 联动与 App.tsx:215-230 启动纠偏适配 deepseek provider
5. DSH 后端专属模型列表/映射（MODEL_OPTIONS 目前只有 Claude 两档）
6. DSH 服务参数可见性（外部服务地址/端口、LC 自管服务的状态——CliTab 目前只认 3080）

**后端**
7. `session.rs` 识别 `provider.cli_backend == "deepseek"` 路由
8. `start_deepseek_session` 把 model/凭证传入 DSH——视 DSH service API 支持：session.create/prompt 载荷带 model；或 spawn 服务时注入 provider env（dsh_service.rs:732-739）
9. `resolve_provider_env` 的 DSH 等价物（对照 claude 路径 session.rs:250-308）

## 前置依赖

- ✅ `get_backend()` DSH 接线修复（v1.1.9 已含）
- ✅ 运行环境/CLI 管理安装入口补齐（v1.1.9 已含）
- 需调研：DSH service API 是否支持按会话指定 model 与凭证（host.describe/session.create 载荷）

## 验收标准

- [ ] 用户可在 provider 系统中新建/激活 DeepSeek 后端 provider，自动切换 header
- [ ] DSH 会话使用 provider 配置的凭证与模型（或明确提示需在 dsh 侧配置并给出引导）
- [ ] provider 表单对 DSH 的字段语义正确（base URL 是否适用按调研结论定）
- [ ] 三个后端在 UI 上呈现一致、无混淆文案

## 关键文件

`src/stores/providerStore.ts`、`src/lib/provider-presets.ts`、`src/components/settings/ProviderForm.tsx`、`ProviderManager.tsx`、`src-tauri/src/commands/session.rs`、`src-tauri/src/lib.rs`（start_deepseek_session）、`src-tauri/src/commands/dsh_service.rs`
