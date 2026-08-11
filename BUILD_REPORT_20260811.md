# 修复报告 & 构建指令（2026-08-11）

> 用途：交给主代理执行构建。所有相关文件地址见下文，改动内容以 `git diff` 为准。
> 项目根目录：`D:\agent self\agent\tokenicode-src\`（Windows 10，pnpm，Tauri 2 + React 19）

---

## 一、本次会话已完成的修复（无需再改代码）

### 1. 百炼大模型平台端点验证（全部通过 ✅）

- 工作空间端点（Anthropic 兼容）：`https://ws-apsamkv6wrjnd47x.cn-beijing.maas.aliyuncs.com/apps/anthropic`
- OpenAI 兼容端点：`https://ws-apsamkv6wrjnd47x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
- 验证矩阵（密钥 `sk-ws-...`）：
  - `/apps/anthropic/v1/messages`：普通消息 / 带工具 / 流式（SSE）全 200
  - **带工具请求稳定性：8/8 全 200**（旧 token-plan 端点为 8 次 7 次 http=000/500，新端点无此问题）
  - 模型名 `qwen3.8-max` / `qwen3-max` / `qwen3.5-plus` / `qwen3.5-flash` 均被接受；**`claude-*` 官方名返回 400 `Model not exist`（服务端严格按模型名路由，配置 provider 时模型名必须用百炼模型列表）**
  - `/apps/anthropic/v1/models` 返回 404 `Not support`（该端点不支持模型查询，属正常）
  - `/compatible-mode/v1`：models 列表 + chat completions 全 200
- 详细记录：`C:\Users\19425\.claude\projects\D--agent-self-agent-tokenicode-src\memory\bailian-ws-endpoint-test.md`

### 2. `~/.claude/settings.json` AMD 污染清理（已完成并验证 ✅）

- 文件：`C:\Users\19425\.claude\settings.json`
- **删除 11 项** AMD Radeon 工具写入的 env 变量：
  - `ANTHROPIC_BASE_URL`（指向 `https://developer.amd.com.cn/radeon/api/v1`）
  - `ANTHROPIC_AUTH_TOKEN`（`rc-da90fe7...`）
  - `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_{FABLE,HAIKU,OPUS,SONNET}_MODEL` + 4 个 `_MODEL_NAME`（全部 = `DeepSeek-V4-Flash`）
- **保留**：`CLAUDE_CODE_ATTRIBUTION_HEADER`、`CLAUDE_CODE_EFFORT_LEVEL`、顶层 `includeCoAuthoredBy` / `model` / `theme`
- **验证**：清理后 `claude -p` 直连正常回复（清理前报 `There's an issue with the selected model` 且零网络请求——settings.json env 优先级高于进程环境变量，请求被劫持到 AMD 网关）
- 根因机理：Claude CLI 启动时 `~/.claude/settings.json` 的 `env` 块优先于进程环境变量；AMD 工具写入后所有 CLI 请求被劫持。

### 3. 应用侧防线（已内置，构建时无需改动）

- `src-tauri/src/commands/session.rs:346-448`：激活 provider 时 `--settings` 内联注入完整 env 覆盖——`ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` + `ANTHROPIC_AUTH_TOKEN=""`（压掉 OAuth 泄漏）+ 5 个 MODEL 系列变量（含 `ANTHROPIC_DEFAULT_FABLE_MODEL`，防大小写敏感网关 401）+ `PROXY_CLEAR_VARS` 清空（进程 env + settings env 双保险，防 Clash 等系统代理劫持）。
- 结论：**应用内激活 provider 不受外部 settings.json 污染影响**；全新电脑上无污染源，开箱即用。

---

## 二、当前工作区待构建改动（12 个文件，+376 / -48，未提交）

路径前缀：`D:\agent self\agent\tokenicode-src\`

| # | 文件（相对路径） | 改动量 | 内容摘要（以 git diff 为准） |
|---|---|---|---|
| 1 | `src-tauri/src/commands/cli_manage.rs` | +129/-28 | CLI/Node/Git 下载安装健壮性：校验和解析支持裸 64-hex 单段行（华为云镜像 `{file}.sha256` 格式）、坏行跳过不中断整文件、错误信息去 URL 展示（详情留在 stderr 日志） |
| 2 | `src-tauri/src/commands/prereq.rs` | +22/-3 | 前置检查相关（详情见 diff） |
| 3 | `src-tauri/src/commands/session.rs` | +13/-6 | 代理残留清除与 --settings env 覆盖完善 |
| 4 | `src/pet/PetStage.tsx` | +157/-20 | 桌宠舞台渲染增强 |
| 5 | `src/pet/petEngine.ts` | +19/-3 | 桌宠引擎逻辑 |
| 6 | `src/lib/pet/constants.ts` | +20/-0 | 桌宠常量 |
| 7 | `src/lib/pet/types.ts` | +8/-3 | 桌宠类型 |
| 8 | `src/hooks/usePetBridge.ts` | +13/-5 | 桌宠桥接 hook |
| 9 | `src/components/settings/PetTab.tsx` | +5/-2 | 桌宠设置页 |
| 10 | `src/components/settings/PrerequisitesTab.tsx` | +31/-23 | 前置检查设置页 |
| 11 | `src/lib/i18n.ts` | +6/-4 | 中英文案 |
| 12 | `src/lib/tauri-bridge.ts` | +1/-0 | IPC 桥接（新增一行） |

---

## 三、构建指令

```bash
# 项目根目录
cd "D:\agent self\agent\tokenicode-src"

# 1. 依赖安装（如 node_modules 已存在可跳过）
pnpm install

# 2. 前端类型检查（可选，快速反馈）
pnpm build

# 3. Rust 检查（可选）
cd src-tauri && cargo check && cargo clippy

# 4. 生产构建（主目标）
pnpm tauri:build
```

**产物地址**（构建成功后）：
- Windows 安装包：`D:\agent self\agent\tokenicode-src\src-tauri\target\release\bundle\nsis\*.exe`
- 便携可执行：`D:\agent self\agent\tokenicode-src\src-tauri\target\release\*.exe`

**注意事项**：
1. **dev/release 数据隔离是刻意设计**：dev 构建（`pnpm tauri:dev`）用 `.dev` identifier + 数据目录后缀，与 release 完全隔离；生产构建必须走 `pnpm tauri:build`。
2. 构建环境 Windows 10 Home；需要 Rust 工具链 + pnpm + Node（如缺 `cargo`，安装 [rustup](https://rustup.rs) 后重试）。
3. 未提交改动共 12 个文件——若需提交，请按语义拆分（桌宠模块 / CLI 安装健壮性 / 代理清理），勿一次性 `git add -A` 打包。
4. 当前 git 分支：`main`，最近提交 `c4684e8`（v1.1.2 修复批次）。

---

## 四、构建后验证清单

1. 启动 release 版 exe，确认应用能正常打开（桌宠、设置页渲染正常）
2. 设置 → CLI 管理：确认 CLI 安装/更新路径正常（本次 cli_manage.rs 改动涉及下载容错）
3. 设置 → 添加百炼 provider（Anthropic 兼容格式，端点 `.../apps/anthropic`，模型 `qwen3.8-max`），激活后发消息验证回复
4. 桌宠功能冒烟测试（如有）
