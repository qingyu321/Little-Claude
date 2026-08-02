# 便携版冒烟验证清单（Portable Smoke Test）

在**干净机器**上（无开发环境：无 pnpm/无 Rust/无 Claude CLI/无 Node）验证
`dist-portable/LittleClaude-v<version>-Portable.exe`。

构建命令：`powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1`

---

## 场景 A — 正常环境（Win10 20H2+，有 WebView2）

- [ ] 双击 exe 直接启动，无安装过程、无 UAC 提权
- [ ] 首次运行 SmartScreen 提示（未签名）→ "更多信息" → "仍要运行" 可放行
- [ ] 启动目录（exe 所在目录）**不产生任何文件**；系统临时目录无该应用相关解压文件
- [ ] 断网状态下 UI 仍能完整加载（证明前端资源来自二进制内存，非网络）
- [ ] 新建会话、发送消息、流式输出正常；文件树 / 设置 / 会话列表可打开

## 场景 B — 缺 WebView2（精简版系统 / LTSC / 已卸载）

- [ ] 启动弹出**原生对话框**（非应用内弹窗）：提示缺少 WebView2 运行时
- [ ] 点"是"→ 打开微软官方下载页（go.microsoft.com/fwlink/p/?LinkId=2124703）
- [ ] 安装 Evergreen Bootstrapper（用户级，无需管理员）后重新双击 → 正常启动

## 场景 C — 无 Claude CLI / 无 Node

- [ ] 设置 → 前置条件（Prerequisites）显示 Claude CLI 未安装
- [ ] 点一键安装：自动检测/下载 Node.js（若缺失）→ npm 安装 CLI 成功
- [ ] 国内网络下走镜像源安装成功（install_claude_cli 的 china 分支）
- [ ] 安装完成后直接可用（新会话能跑通一条完整对话）

## 场景 D — 双开

- [ ] exe 已运行时再次双击 → 不启动第二个进程，**已有窗口被聚焦/置顶**
- [ ] 任务管理器确认只有一个 Little Claude 进程

## 场景 E — 便携性

- [ ] 复制 exe 到另一台无开发环境的机器（U 盘拷贝即可）→ 同样可运行
- [ ] 换目录运行后，`~/.tokenicode/`、`~/.claude/` 中的配置仍被读取
  （便携 = 免安装；用户数据按设计写用户目录）
- [ ] 首次运行技能（video-analysis 等）正确出现在技能列表（bundled 解压到
  `~/.claude/skills/`）

## 场景 F — 闭源混淆抽查

- [ ] 用文本编辑器打开 exe 搜索前端明文字符串（如 "Little Claude"、中文文案）
      → 找不到可读源码片段（前端已混淆；Rust 侧字符串为二进制资源，可接受
      少量可见）
- [ ] （可选）把 dist 产物 JS 拖入格式化工具 → 控制流扁平化/字符串数组结构明显

---

## 已知限制（预期内，非 bug）

| 现象 | 说明 |
|------|------|
| SmartScreen "未知发布者" | 未签名；正式分发建议 OV/EV 代码签名证书 |
| 杀软误报可能 | 单文件 + 混淆 + 自定义协议是典型特征，若误报需加白或签名 |
| 运行时写 `~/.tokenicode/`、`~/.claude/` | 设计如此（配置/会话/技能数据），换机需连同复制 |
| 更新方式 | 无自动更新器；GitHub Releases 手动下载替换 exe |
