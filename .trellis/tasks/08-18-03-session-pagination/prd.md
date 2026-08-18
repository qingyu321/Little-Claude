# PRD — 大会话分页加载

**优先级**: P2 | **状态**: planning | **来源**: 第二轮性能审查（候选 4 残留 + #20）

## 背景

打开几十 MB 的历史会话时开销三连击：
1. Rust `load_session` 把 ≤50MiB JSONL 全量解析成 `Vec<Value>`（已 spawn_blocking + 8MiB 行上限，但仍全量）
2. 整个 Vec 序列化过 IPC
3. JS `parseSessionMessages` 再全量解析一遍常驻内存

结果：大会话打开瞬间明显冻结；Virtuoso 只渲染可见项，但解析/内存成本是全量的。

## 目标

1. **Rust 侧游标分页**：`load_session(session_id, cursor?, limit)` 返回"尾部 N 条 + 总数 + 上游标"；按行偏移倒序扫描（JSONL 按行追加，尾部优先）
2. **前端向上滚动按需加载**：Virtuoso `startReached` 触发加载更早消息（带 loading 指示）；消息 id 稳定性保证（不重复/不丢序）
3. **rewind 兼容**：turns 解析/rewindToTurn 需要的全文在 Rust 侧按需处理（truncate_session_history 本来就只吃文件路径，不受影响）
4. **内存护栏**：单 tab 常驻消息超过阈值（如 3000 条）时折叠最老消息为"加载更早"占位

## 验收标准

- [ ] 50MB 会话打开首屏 <1s（当前 >5s）
- [ ] 向上滚动分页流畅，无重复/乱序
- [ ] rewind/搜索/导出功能在分页模式下全部正常
- [ ] 长会话内存占用有上限

## 关键文件

`src-tauri/src/commands/session.rs`（load_session）、`src/lib/session-loader.ts`、`src/lib/session-disk-load.ts`、`src/components/conversations/ConversationList.tsx`、`src/components/chat/ChatPanel.tsx`（Virtuoso）
