# Little Claude

Little Claude 是 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 的原生桌面客户端，基于 **Tauri 2 + React 19 + TypeScript** 构建。它把 Claude Code 的多会话终端工作流搬进一个完整的桌面 GUI：多会话标签页、文件浏览与编辑、轮次回退与文件恢复、斜杠命令、命令面板、MCP 服务器管理，以及多 Provider API 配置系统。

## 功能亮点

- **多会话标签页** — 多个会话并行运行、随时切换，背景会话继续接收流式输出，切换不丢上下文
- **文件浏览与编辑** — 内置文件树、Markdown / HTML / SVG / PDF / 图片预览、CodeMirror 代码编辑、拖拽上传
- **回退与恢复（Rewind）** — 基于 Claude Code 检查点，可回退到任意轮次并恢复当时的文件状态
- **斜杠命令与命令面板** — 内置命令 + 自定义命令 + Skills，一键唤起
- **MCP 服务器管理** — 自动扫描并管理 `~/.claude.json` 等位置的 MCP 服务器配置
- **多 Provider API 配置** — Anthropic / OpenAI 兼容格式，内置预设（DeepSeek、智谱 GLM、通义千问 Coder、Kimi、MiniMax），支持自定义 Base URL、API Key、模型映射与代理
- **权限模式** — 4 种模式（标准自动 / 全自动 / 询问 / 计划），会话内可随时切换
- **界面定制** — 多主题（含 VS Code Dark）、字体切换、中英文界面

## 更新记录

### v1.1.0-alpha.1 (2026-08-02)

- 自动更新链路迁移到本仓库：新的更新签名密钥，CI 自动签名安装包并维护 `latest.json`
- 修复 CI 构建依赖问题（`@codemirror/state` 显式声明）

### v1.1.1 (2026-08-02)

- 消息内容可鼠标选中复制 — 正文、思考、工具调用均支持选中复制
- 版本号改为构建时注入（`__APP_VERSION__`），修复设置页与更新检查显示旧版本的漂移问题
- 便携单 EXE 打包 — 单文件、免安装、免管理员、无临时解压，JS 混淆闭源（控制流扁平化 / 字符串数组 / 死代码注入）
- 发布链路迁移 — 自动更新检查与发布目标统一指向公开仓库 Little-Claude
- CI 发布修复 — 改为直接 shell 构建保留 bundle 产物，修复 release 发布失败

### v1.1.0 (2026-07-31)

- tok 速度实时显示
- 优化安全漏洞与展示
- 修复 API 提供商更换错误的 bug

### v1.0.9 (2026-07-30)

- 面试模块：模型直接识别 + 本地识别转文本发送答案
- 已知问题：回滚代码会丢失上下文

### v1.0.8 (2026-07-29)

- 面试模块：语音识别自动出答案
- 性能优化 + 消息虚拟化 — 可在设置里关闭流式输出显示获得极高性能（130 轮对话不卡）

### v1.0.7 (2026-07-25)

- 修复 v1.0.6 中附件上传的问题
- 优化对话性能 — 修复 agent 运行时对话框卡住

### v1.0.6 (2026-07-24)

- 历史搜索优化 — 按对话内容 / 时间 / CLI 后端搜索，点击跳转后蓝光闪烁提示位置
- 一键安装前置依赖 — 设置 → 环境设置，傻瓜式安装环境

### v1.0.5 (2026-07-24)

- 新增 codex CLI 支持 — 可在 Little Claude 里使用 codex，支持 claude / codex 对话相互转换

### v1.0.4 (2026-07-24)

- 动态壁纸透明度调节优化
- 语音识别系统优化 — 可直接语音输入
- 相对稳定的版本

### v1.0.3 (2026-07-24)

- 修复打开设置跳黑框的视觉问题
- ccswitch 内核隔离 — 不再受 ccswitch 环境配置密钥影响

### v1.0.2 (2026-07-23)

- 动态壁纸上传 + 语音输入 — 自动选择核显 / 独显 / CPU 压缩视频（NV 驱动需 >610，否则走 CPU）
- 语音输入可点击修改

### v1.0.1 (2026-07-22)

- 第一版 Little Claude — 基于 mistydew/tokenicode-deepseek-alpha 开发
- 修复 Bash 和 websearch 问题
- 导入 video-analysis skill — 视频链接 → 自动下载 → ASR 转写 → 多模态识图 → 交叉验证生成内容

## 下载

请到 [GitHub Releases](https://github.com/qingyu321/Little-Claude/releases) 下载对应平台的安装包：

- Windows：NSIS 安装版 / 便携版（x64）
- macOS：Apple Silicon / Intel（dmg）
- Linux：deb / AppImage / rpm

## 快速开始

1. 从 Releases 下载并安装对应平台的安装包。
2. 打开 Little Claude，在设置中配置 API Provider（或使用本机已安装的 Claude Code CLI）。
3. 选择项目文件夹，开始对话。

## 本地开发

环境要求：

- Node.js、pnpm、Rust（Tauri 2 构建环境）
- Windows 打包需要 MSVC Build Tools

常用命令：

```bash
pnpm install        # 安装依赖
pnpm build          # 前端类型检查 + Vite 构建
pnpm tauri dev      # 开发模式（Vite dev server + Tauri 应用）
pnpm tauri build    # 构建生产应用
```

Rust 侧检查：

```bash
cd src-tauri && cargo check && cargo clippy
```

## 许可证

本项目基于 **Apache License 2.0** 授权，请阅读 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

## 致谢

- [TOKENICODE](https://github.com/yiliqi78/TOKENICODE)（TinyZ / yiliqi78）：本项目的代码基础，感谢原作者的辛勤付出与开源贡献
- [Tauri](https://tauri.app)、[React](https://react.dev) 与 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 生态
