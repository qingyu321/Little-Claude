import { bridge } from './tauri-bridge';
import { parseSessionMessages } from './session-loader';
import { useChatStore, generateMessageId } from '../stores/chatStore';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { formatErrorForUser } from '../hooks/useStreamProcessor';

/**
 * fix2: 磁盘加载会话的共享实现（clearMessages → bridge 读取 jsonl → 解析 → 写入）。
 * ConversationList.handleLoadSession 与 App.tsx Ctrl+Tab 缓存未命中回退共用，
 * 避免两处逻辑漂移。
 *
 * T03（大会话分页）: 首屏改用 load_session_tail 只取文件尾部 HISTORY_PAGE_SIZE
 * 条有效 JSONL 行；更早的历史由 ChatPanel 的 startReached 经
 * loadOlderHistoryPages 逐页向上取。
 *
 * T03 兼容性边界（本轮验收范围＝"已加载部分"）:
 *  - rewind: RewindPanel 的回合列表只覆盖已加载消息；对已加载回合的回退照常
 *    工作（truncate_session_history 在 Rust 侧对整文件操作，与加载窗口无关）。
 *    未加载的更早回合本轮不支持回退。
 *  - 搜索: search_sessions 仍全文件扫描（Rust 侧），但跳转到命中回合仅在命中
 *    位于已加载窗口内时生效（见 ConversationSearch 注释）。
 *  - 导出: export_session_markdown/json 在 Rust 侧读取整文件，永远导出完整
 *    历史，不受分页影响。
 */

/** T03: tail-first 页大小——首屏与向上翻页每次解析的 JSONL 行数。 */
export const HISTORY_PAGE_SIZE = 300;

/** T03: 从会话文件全路径提取其所在项目目录名（~/.claude/projects/<dir>/…）。
 *  该目录名已是 CLI 编码形式，Rust 侧 encode_project_name 对其幂等（编码产物
 *  不含 \ : / . 空格），因此直接作为 project_dir 传入即可精确重建同一路径。 */
function deriveProjectDirName(sessionPath: string): string {
  const parts = sessionPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2) return '';
  const dir = parts[parts.length - 2];
  // 防御：路径不以 .../projects/<dir>/<file> 结尾时不走分页
  if (!dir || dir === 'projects' || dir === '.claude') return '';
  return dir;
}

export async function loadSessionFromDisk(
  sessionId: string,
  sessionPath: string,
  sessionOrigin?: string,
): Promise<void> {
  useChatStore.getState().ensureTab(sessionId);
  const { clearMessages, setSessionStatus, setSessionMeta } = useChatStore.getState();
  const agentActions = useAgentStore.getState();
  clearMessages(sessionId);
  agentActions.clearAgents();
  setSessionStatus(sessionId, 'running');
  // TK-329: explicitly clear stdinId when loading from disk — no live process exists yet.
  // Only set the CLI UUID (for resume). Prevents inheriting a stale stdinId
  // from a previous session that might still be alive in the backend.
  // T03: 同时把分页状态全部复位——clearMessages 保留 sessionMeta，旧一次加载
  // 残留的 historyCursor 会让 startReached 拿到过期游标。
  setSessionMeta(sessionId, {
    sessionId,
    stdinId: undefined,
    sessionOrigin: sessionOrigin || 'claude',
    historyCursor: undefined,
    historyHasMore: false,
    historyProjectDir: undefined,
    historyLoadingMore: false,
    historyPrepended: 0,
  });

  try {
    // T03: tail-first 分页加载——50MB 会话首屏也只解析尾部 HISTORY_PAGE_SIZE
    // 条（Rust 侧倒序读 + 逐行解析，跳过坏行），解析结果与 IPC 体积都只与页
    // 大小相关。projectDir 取不到时回退旧的全量 load_session。
    const projectDir = deriveProjectDirName(sessionPath);
    if (projectDir) {
      try {
        const page = await bridge.loadSessionTail(sessionId, projectDir, HISTORY_PAGE_SIZE);
        if (useSessionStore.getState().selectedSessionId !== sessionId) {
          // F7: 加载中途被切走——复位状态，否则该 tab 永久卡在 running
          setSessionStatus(sessionId, 'idle');
          return;
        }
        const { messages, agents, usage } = parseSessionMessages(page.messages);
        applyLoaded(sessionId, messages, agents, usage);
        // T03: 游标/has_more 存入 tab，ChatPanel.startReached 据此向上翻页
        setSessionMeta(sessionId, {
          historyCursor: page.cursor,
          historyHasMore: page.hasMore,
          historyProjectDir: projectDir,
          historyPrepended: 0,
        });
        setSessionStatus(sessionId, 'completed');
        return;
      } catch (tailErr) {
        // T03: 分页通道失败（如文件不在 ~/.claude/projects 树内的极端情况）
        // 降级为全量加载，保证打开行为不回归。
        console.warn('[T03] loadSessionTail failed — falling back to full load:', tailErr);
      }
    }

    const rawMessages = await bridge.loadSession(sessionPath);
    if (useSessionStore.getState().selectedSessionId !== sessionId) {
      // F7: 加载中途被切走——复位状态，否则该 tab 永久卡在 running
      setSessionStatus(sessionId, 'idle');
      return;
    }
    const { messages, agents, usage } = parseSessionMessages(rawMessages);
    applyLoaded(sessionId, messages, agents, usage);
    // 全量加载 = 没有更多历史可翻
    setSessionMeta(sessionId, { historyHasMore: false, historyCursor: undefined });
    setSessionStatus(sessionId, 'completed');
  } catch (err) {
    if (useSessionStore.getState().selectedSessionId !== sessionId) {
      // F7: 同上——出错时切走也要复位，不能留 running
      setSessionStatus(sessionId, 'idle');
      return;
    }
    setSessionStatus(sessionId, 'error');
    useChatStore.getState().addMessage(sessionId, {
      id: generateMessageId(),
      role: 'system',
      type: 'text',
      // A5: 原始错误经分类器转成友好文案（含可折叠的原始详情）
      content: formatErrorForUser(String(err)),
      timestamp: Date.now(),
    });
  }
}

/** T03: 抽取的公共落库步骤（usage 统计恢复 + agents + 一次 batch 入库）。 */
function applyLoaded(
  sessionId: string,
  messages: ReturnType<typeof parseSessionMessages>['messages'],
  agents: ReturnType<typeof parseSessionMessages>['agents'],
  usage: ReturnType<typeof parseSessionMessages>['usage'],
): void {
  const { batchAddMessages, setSessionMeta } = useChatStore.getState();
  // Restore token/context stats from the JSONL — the Ctx bar and sidebar
  // counters are in-memory (written on result events), so without this a
  // reopened session reads 0% / 0 tokens until the next turn's result.
  // T03 note: 分页加载时 usage 由"已加载窗口"重建——最近一次请求的
  // contextTokens 是准的（Ctx 条），累计 totals 只覆盖窗口内回合（已知边界）。
  if (usage) {
    setSessionMeta(sessionId, {
      contextTokens: usage.contextTokens,
      contextInputTokens: usage.contextInputTokens,
      contextCacheReadTokens: usage.contextCacheReadTokens,
      contextCacheCreationTokens: usage.contextCacheCreationTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
    });
  }

  // Apply agents
  for (const agent of agents) {
    useAgentStore.getState().upsertAgent(agent);
  }

  // fix16: 收集完所有消息后一次 batchAddMessages 入库（tool_result 已由
  // session-loader 合并进对应消息），替代逐条 addMessage 的 O(N²) 拷贝
  batchAddMessages(sessionId, messages);
}

/**
 * T03: startReached 触发的向上翻页——取 historyCursor 之前的一页并 prepend。
 *
 * 无重复/无乱序: Rust 侧保证页与页字节区间互不重叠（more 只扫 [0, cursor)），
 * 页内按文件序返回；prependMessages 再按 id 去重兜底。消息 id 来自 JSONL 的
 * uuid/block id，跨页稳定。仅取 messages——更早页重建出的 usage/agents 是过期
 * 值，不能覆盖首屏从最新窗口恢复的统计。
 *
 * @returns 本次 prepend 的消息数；0 表示没有新内容（或已在加载/无更多）。
 */
export async function loadOlderHistoryPages(tabId: string): Promise<number> {
  const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
  const cliSessionId = meta?.sessionId;
  const projectDir = meta?.historyProjectDir;
  if (!cliSessionId || !projectDir) return 0;
  if (!meta?.historyHasMore || typeof meta.historyCursor !== 'number') return 0;
  if (meta.historyLoadingMore) return 0; // 已有翻页在途——startReached 会高频触发

  const { setSessionMeta } = useChatStore.getState();
  setSessionMeta(tabId, { historyLoadingMore: true });
  let cursor = meta.historyCursor;
  let totalPrepended = 0;
  try {
    // 一页可能 0 条可渲染消息（窗口内全是跳过行）：继续向上取——cursor 每次
    // 严格减小，循环必然终止；再加硬上限兜底。
    for (let guard = 0; guard < 8; guard++) {
      const page = await bridge.loadSessionMore(cliSessionId, projectDir, cursor, HISTORY_PAGE_SIZE);
      cursor = page.cursor;
      const { messages } = parseSessionMessages(page.messages);
      if (messages.length > 0) {
        useChatStore.getState().prependMessages(tabId, messages);
        totalPrepended += messages.length;
      }
      setSessionMeta(tabId, { historyCursor: page.cursor, historyHasMore: page.hasMore });
      if (messages.length > 0 || !page.hasMore) break;
      // 切走后不再自动续页（本页数据已入该 tab 缓存，无浪费）
      if (useSessionStore.getState().selectedSessionId !== tabId) break;
    }
  } catch (err) {
    // T03: 翻页失败不能每次滚到顶都重试刷屏——本轮加载停用分页，
    // 重新从列表打开会话会复位。
    console.warn('[T03] loadSessionMore failed — disabling further pagination:', err);
    setSessionMeta(tabId, { historyHasMore: false });
  } finally {
    setSessionMeta(tabId, { historyLoadingMore: false });
  }
  return totalPrepended;
}
