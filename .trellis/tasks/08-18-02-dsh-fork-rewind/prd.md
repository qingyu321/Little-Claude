# PRD — DSH fork 式会话回滚集成

**优先级**: P2 | **状态**: planning | **来源**: 《DSH 回滚能力调查报告》

## 背景

- Little Claude 的 rewind 三件套（`--replay-user-messages` checkpoint + `rewind_files` + JSONL 截断）全部是 Claude CLI 私有机制；DSH/Codex 后端下 rewind 只有前端内存截断一半能用（`build_rewind_message` 返回空串静默 no-op）
- DSH 无文件快照层、日志 append-only、无 truncate RPC；唯一可用的会话级回退是 **`session.fork {sessionId, atSeq?}`**——在已完成 turn 边界复制事件建新会话，原会话保留
- DSH turn 事件自带 mux `seq`（dsh_events.rs translator 已消费），具备 turn→seq 映射条件

## 目标

1. **turn→seq 映射**：dsh_events translator 为每个 turn 记录"最后事件 seq"，随 result 事件带给前端（存 Turn 结构）
2. **`dsh_fork_session` Tauri command**：调 `session.fork`，成功后切换 tab→DSH 会话映射（insert_deepseek_session）+ mux 路由 + translator 迁移；前端 RewindPanel 的 deepseek 分支改走 fork（跳过 rewindFiles/truncateSessionHistory）
3. **代码回滚替代方案**（可选子任务）：
   - 方案 A：项目是 git repo 时，每 turn 前自动打轻量 commit（复用 run_git_command 白名单），回滚 = reset
   - 方案 B：自建文件快照层——DSH turn 的 deliverables 数据给出本轮产生文件清单，仅快照这些文件
4. **UI 诚实化**：RewindPanel 按后端显示能力矩阵（DSH：仅会话分叉，文件不回滚——明确提示）

## 范围外

- goal round 回滚（DSH 不支持，仅 pause/complete）
- 子代理改动回滚（无解，仅 interrupt）

## 验收标准

- [ ] DSH 会话可选任意已完成轮次 fork，新会话继续对话、原会话保留
- [ ] fork 边界校验（OPEN_TURN 错误有友好提示）
- [ ] RewindPanel 对 DSH 后端的能力边界有明确文案
- [ ] （方案 A/B 至少一个）代码改动可回退且有测试

## 关键文件

`src/hooks/useRewind.ts`、`src/lib/turns.ts`、`src-tauri/src/backends/dsh_events.rs`、`src-tauri/src/commands/dsh_service.rs`（unary）、`src-tauri/src/commands/session.rs`（deepseek 分支）、DSH 侧证据：dsh-host-apiproxy UNARY_ROUTES / SessionStore.fork
