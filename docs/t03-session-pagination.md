# T03 大会话分页加载（tail-first pagination）

## 问题

打开几十 MB 的历史会话存在三连击开销：

1. Rust `load_session` 全量解析 JSONL → `Vec<Value>`（50 MiB 上限 + 8 MiB 行上限，spawn_blocking）；
2. 全量结果整体过 IPC；
3. 前端 `parseSessionMessages` 再全量解析一遍。

大会话打开瞬间冻结 UI。

## 方案

首屏只加载文件**尾部**一页（默认 300 条有效行），更早的历史在用户向上滚动时按字节游标逐页加载。

```
打开会话 ──► load_session_tail(session_id, project_dir, limit=300)
              └─ 倒序扫描 JSONL，解析尾部 300 条有效行
              └─ 返回 { messages, totalLines, cursor, hasMore }
                    cursor = 已加载部分最早一行的字节偏移

滚到顶部 ──► load_session_more(session_id, project_dir, cursor, limit=300)
              └─ 只扫描 [0, cursor) 区间，取其中最后 300 条有效行
              └─ 返回同样结构（新 cursor = 本页最早行偏移）
```

### 性能验收口径（50 MB 会话）

- 首屏解析/序列化/IPC 的消息数 = min(300, 文件有效行数)，与文件总大小**无关**；
- Rust 侧倒序读取按 512 KiB 块回溯，命中 300 条即停（典型会话行均几 KB～几十 KB，实际读取量通常在个位数 MB 以内）；
- `totalLines` 为全文件字节扫描数 `\n`（无 JSON 解析，~50 MB 仅几十 ms，spawn_blocking 内执行，不占 UI 线程）；
- 对比旧路径：解析量、IPC 体积、前端再解析量都从 O(全文件) 降为 O(页大小)。

### 无重复 / 无乱序保证

- **字节区间互不重叠**：每次调用只消费严格小于其 `region_end` 的字节；返回的
  `cursor` 是已加载最早行的**起始偏移**，下一页扫描区间 `[0, cursor)` 恰好停在
  上一页最早行的前一字节——页与页无缝衔接，不重叠、不漏行。
- **跳过行的处理**：解析失败行、空行、超过 8 MiB 的行与 `load_session` 语义一致
  地跳过（不计入页内条数，但扫描会跨过它们继续找更早的有效行）。`hasMore` 仅在
  扫描真正抵达文件头后才变 false——若前缀只剩无效行，前端最多多取一次空页即止
  （cursor 严格递减，必然终止；前端另有 8 次循环硬上限）。
- **顺序**：页内按文件序（旧→新）返回；前端 prepend 到消息数组头部，整体顺序保持文件序。
- **id 稳定**：消息 id 来自 JSONL 的 `uuid` / tool_use block id（跨页、跨次解析稳定），
  `chatStore.prependMessages` 再按 id 去重兜底，任何情况下不产生重复条目。
- **滚动位置**：Virtuoso `firstItemIndex` 从大基数（1,000,000）开始，每次 prepend
  按新增 display item 数递减（react-virtuoso 官方 prepend 模式）——已渲染条目的
  虚拟索引不变，视口停在原处，不跳顶。`followOutput` 维持原有 neverFollow + 手动
  pin 逻辑，不受分页影响；初始定位沿用既有 pinToBottom（tail 页就是最新消息）。
- **边界情况**：无换行的单行文件、文件末尾无换行、`region_end == 0`、rewind 截断
  导致的过期游标（more 端对 cursor 做 `min(file_len)` 钳制）均有处理与单元测试覆盖
  （`src-tauri/src/commands/session.rs` 末尾 `t03_pagination_tests`）。

### 兼容性边界（本轮验收范围 = 已加载部分）

| 功能 | 分页会话下的行为 |
|------|------------------|
| rewind | RewindPanel 回合列表只覆盖已加载消息；对已加载回合的回退照常工作（`truncate_session_history` 在 Rust 侧对整文件操作，与加载窗口无关）。未加载的更早回合本轮不支持回退。 |
| 搜索 | `search_sessions` 仍全文件扫描；跳转到命中回合仅在命中位于已加载窗口内时生效（见 ConversationSearch 注释）。用户可向上翻页加载后再跳转。 |
| 导出 | `export_session_markdown/json` 在 Rust 侧读取整文件，永远导出完整历史，不受分页影响。 |
| usage 统计 | 首屏从"最新窗口"重建：最近请求的 contextTokens 准确（Ctx 条）；累计 totals 仅覆盖窗口内回合（已知边界，注释于 session-disk-load.ts）。 |

## 修改清单

### Rust（src-tauri/）
- `src/commands/session.rs`：`load_session_tail` / `load_session_more` 两个命令 +
  共享倒序读页 `read_jsonl_page_backward`、路径校验 `resolve_claude_session_path`
  （UUID-like + `encode_project_name`，与 truncate_session_history 同一套）、
  行数统计 `count_jsonl_lines`、`SessionPage` 返回结构（camelCase）。
  未改动 `load_session` 本体。
- `src/lib.rs`：invoke_handler 在 `load_session` 之后注册两个新命令。

### 前端（src/）
- `lib/tauri-bridge.ts`：`loadSessionTail` / `loadSessionMore`（紧随 `loadSession`）+ `SessionPageResult` 类型。
- `lib/session-disk-load.ts`：`loadSessionFromDisk` 改为 tail-first（`HISTORY_PAGE_SIZE = 300`），
  projectDir 从会话文件路径推导（目录名即编码形式，`encode_project_name` 对其幂等）；
  失败自动降级全量加载。新增 `loadOlderHistoryPages(tabId)` 供向上翻页。
- `stores/chatStore.ts`：`SessionMeta` 新增 `historyCursor / historyHasMore /
  historyProjectDir / historyLoadingMore / historyPrepended`；新增 `prependMessages`
  （头部插入 + id 去重 + 原子递增 historyPrepended）。
- `components/chat/ChatPanel.tsx`：Virtuoso 增加 `firstItemIndex` / `startReached`；
  顶部轻量加载指示 `ChatHistoryHeader`（稳定模块级组件，同 ChatFooter 模式）。
- `components/conversations/ConversationSearch.tsx`：仅注释说明分页对回合跳转的限制（加载路径本身复用 loadSessionFromDisk）。
- `lib/i18n.ts`：`chat.loadingEarlier`（zh/en）。
