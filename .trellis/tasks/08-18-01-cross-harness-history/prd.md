# PRD — 跨 harness 会话历史转换层

**优先级**: P1 | **状态**: planning | **来源**: 第二轮审计《跨 harness 上下文迁移考古报告》

## 背景

当前跨后端迁移处于"原型级文本注入"阶段：

| 源 ↓ \ 目标 → | Claude | Codex | DeepSeek(DSH) |
|---|---|---|---|
| Claude | ✅ 原生 resume | ⚠️ 有损文本注入（无长度上限，混入 sidechain） | ⚠️ 仅内存注入 |
| Codex | ⚠️ 仅内存注入（重启失效） | ✅ 原生 thread/resume | ⚠️ 仅内存注入 |
| DSH | ❌ 静默丢历史 | ❌ 静默丢历史 | ⚠️ 运行期内映射 |

三后端会话身份体系（CLI UUID / 客户端 threadId / 服务端 sessionId）互不映射；`sessionOrigin/_origin/.codex-origin` 溯源标记写了没人读；Codex/DSH 会话不进会话列表。

## 目标

1. **统一历史转换层**（Rust）：`session-exporter` 升级为结构化翻译——thinking 块、tool_use/tool_result、附件引用、usage 各自有明确的跨后端映射规则（保留/降级为文本/丢弃，逐项可配置）
2. **长度预算与摘要降级**：注入前估算目标后端上下文窗口；超预算时对最老轮次做摘要压缩（可走一次廉价模型），而不是整段丢弃或顶爆窗口
3. **显式迁移状态 UI**：迁移时聊天区显示"已携带 N 轮历史（thinking/图片已降级）"的系统卡；迁移失败必须报错而非裸发
4. **会话持久化统一**：Codex threadId / DSH sessionId 进会话列表（独立索引文件 + origin 标记真正被读取），重启后可见可恢复
5. **死代码处置**：`reconstructJsonl`/`export_codex_to_claude` 接线修好（thinking signature、usage、permissionMode）或删除

## 设计细化（v2：双通道交接 + 任务态续接）

**架构**：三读取器（Claude JSONL 已有 / Codex 卷宗需逆向 / DSH zstd 复用 profile.rs 解码器与 dsh_events.rs 翻译规则）→ **归一转轮模型** `Turn{role, blocks[Text|Thinking|ToolUse|ToolResult], usage, ts}` + `TaskState{todos, plan, last_in_progress, deliverables}` → 按目标后端渲染。

**双通道交接**（核心：不硬塞上下文）：
- **通道 A 内联**：最近 N 轮在预算内（20-50K tokens）结构化注入首条 prompt（`<conversation_history source="...">`）；text 全留、thinking 丢弃/摘要、工具调用压缩单行摘要
- **通道 B 落盘**：生成 `.tokenicode/handoff/<时间戳>.md` 交接简报 = 任务目标 + 进度（todos/plan 提取）+ **未完成事项清单** + 关键决策与坑 + `git status/diff --stat` 工作区状态 + 逐轮一行摘要；首条 prompt 指令新 harness 先读简报再继续——三个 harness 都能读文件，这是唯一通用能力，重载荷走这里，token 成本极低且用户可审阅

**任务态续接**：Claude todo 块 / DSH todo-write / Codex plan → 统一 TaskState → 简报"未完成事项"；可选首轮自证理解开关。

**UI**：会话卡「换引擎继续」入口；交接进度卡（携带 N 轮/M 轮摘要 + 简报路径）；新会话首条交接回执系统消息；失败显式报错。

**分方向**：DSH→DSH 优先原生 `session.fork`（无损，归 02 任务）；其余走双通道。

**风险**：Codex 卷宗格式需逆向；工作目录必须一致（简报校验 cwd）；图片/附件降级为文字描述；先做规则版摘要（零成本），廉价模型摘要版后置。

## 范围外

- DSH 服务端 resume RPC（不存在，依赖 02 任务的 fork）
- 跨后端文件 checkpoint 延续（依赖各 harness 自身能力）

## 验收标准

- [ ] Claude→Codex、Claude→DSH、Codex→Claude、DSH→Claude 四条路径带完整历史迁移成功（工具/usage 降级有明确标记）
- [ ] 超长会话迁移不顶爆目标窗口（预算内摘要或截断 + 用户提示）
- [ ] 迁移过程有 UI 反馈；任何失败都有可见错误
- [ ] Codex/DSH 会话重启后出现在会话列表且可继续
- [ ] i18n 文案不再承诺与实现不符的"自动迁移"

## 关键文件

`src/lib/session-exporter.ts`、`src/components/chat/InputBar.tsx:1134-1183`、`src-tauri/src/commands/cli_manage.rs:1091-1207`、`src-tauri/src/commands/session.rs`（list_sessions origin 读取）、`src-tauri/src/lib.rs:2007-2097`
