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

### v1.0.1 ~ v1.1.0

- 以早期功能基线重新发布，版本号从 `1.0.x` 开始
- 完整更新说明见 [GitHub Releases](https://github.com/qingyu321/Little-Claude-Updater/releases)

## 下载

请到 [GitHub Releases](https://github.com/qingyu321/Little-Claude-Updater/releases) 下载对应平台的安装包：

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
