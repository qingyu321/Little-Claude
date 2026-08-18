import { create } from 'zustand';
import { useSessionStore } from './sessionStore';
import { useAgentStore } from './agentStore';
import type { FileAttachment } from '../hooks/useFileAttachments';
// F4: LRU 淘汰泄漏进程回收所需（均为纯 IPC/window 工具，不引入 React）
import { bridge } from '../lib/tauri-bridge';
import { cleanupStreamListener } from '../lib/stream-cleanup';

// --- Types ---

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface MessageAttachment {
  name: string;
  path: string;
  isImage: boolean;
  preview?: string;  // base64 data URL (thumbnail)
}

export type InteractionState = 'pending' | 'sending' | 'resolved' | 'failed' | 'expired';

export interface PermissionRequestData {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  toolUseId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  type: 'text' | 'tool_use' | 'thinking' | 'tool_result' | 'permission' | 'plan' | 'plan_review' | 'question' | 'todo';
  content: string;
  toolName?: string;
  toolInput?: any;
  toolResultContent?: string;      // tool result content merged from tool_result stream events
  isPartial?: boolean;
  timestamp: number;
  // Interactive message fields
  permissionTool?: string;         // tool requesting permission
  permissionDescription?: string;  // what the tool wants to do
  resolved?: boolean;              // whether the user responded
  // SDK control protocol permission data (Phase 2)
  interactionState?: InteractionState;
  interactionError?: string;
  permissionData?: PermissionRequestData;
  planItems?: string[];            // plan steps
  planContent?: string;            // markdown content for plan_review
  // AskUserQuestion fields
  questions?: UserQuestion[];      // question data from AskUserQuestion tool
  // TodoWrite fields
  todoItems?: TodoItem[];          // todo list items
  // File attachments (user-sent images/files)
  attachments?: MessageAttachment[];
  // Command feedback fields (for system messages from slash commands)
  commandType?: 'mode' | 'model-switch' | 'info' | 'help' | 'action' | 'error' | 'processing';
  commandData?: Record<string, any>;
  // Command processing card fields
  commandStartTime?: number;
  commandCompleted?: boolean;
  // Sub-agent nesting depth (0 = main agent, 1+ = inside Task sub-agent)
  subAgentDepth?: number;
  // CLI checkpoint UUID for file restoration (from --replay-user-messages)
  checkpointUuid?: string;
  // T02: DSH fork anchor — the mux seq of the turn that completed BEFORE this
  // user message. Set on the deepseek backend when a user message is added.
  // Rewinding to this turn calls session.fork with atSeq = dshSeq.
  dshSeq?: number;
  // U1: 错误分类命中时写入（值为 ERROR_CATEGORIES 的 i18nKey，如
  // 'error.invalidKey'）。role==='system' 且带此字段的消息由 MessageBubble
  // 渲染成可行动错误卡片（打开设置 / 去安装 / 新建任务 / 重试按钮）。
  errorCategory?: string;
}

export interface SessionMeta {
  model?: string;
  cost?: number;
  duration?: number;
  turns?: number;
  sessionId?: string;
  /** The desk-generated ID used as key in Rust StdinManager for sending follow-up messages */
  stdinId?: string;
  /** Message ID of a pending processing card (for CLI slash commands) */
  pendingCommandMsgId?: string;
  /** Input tokens of the CURRENT turn — semantics-aware full input (last-wins
   *  overwrite on message_start/message_delta, not an accumulation): DeepSeek /
   *  opencode-style usage reports the whole context incl. the cached share, so
   *  summing it like an Anthropic increment double-counted every turn. Result
   *  events overwrite it with the authoritative value. */
  inputTokens?: number;
  /** Gate so a turn's input+cache usage is logged into the cumulative totals
   *  exactly once — set on the first message_start/message_delta that carries
   *  usage, cleared on the next message_start. */
  turnInputLogged?: boolean;
  /** Accumulated output tokens from stream events (message_delta) — per turn, reset each turn */
  outputTokens?: number;
  /** Accumulated cache-read (cache hit) tokens — per turn (OpenAI-compat proxy path) */
  cacheReadTokens?: number;
  /** Accumulated cache-creation (cache miss) tokens — per turn (OpenAI-compat proxy path) */
  cacheCreationTokens?: number;
  /** Full input context of the LAST request — semantics-aware (see
   *  context-tokens.ts): Anthropic-style endpoints sum input + cache-read +
   *  cache-creation; DeepSeek-style endpoints use input alone (already
   *  includes the cached share). B2 fix: authoritative "context used" for the
   *  Ctx bar and auto-compact — input_tokens alone excludes cached content
   *  (95%+ of context in real Anthropic sessions). */
  contextTokens?: number;
  /** Breakdown of the last request's context (raw fields; sums to contextTokens
   *  only under Anthropic semantics — DeepSeek-style input already contains the
   *  cached share). For the Ctx bar tooltip and cache-miss detection. Only set
   *  on result events. */
  contextInputTokens?: number;
  contextCacheReadTokens?: number;
  contextCacheCreationTokens?: number;
  /** DSH-declared context window (from the request/context projection — the
   *  adapter's authoritative capacity). The Ctx bar prefers it over the local
   *  five-tier model-window guess; absent when the adapter declares none. */
  dshContextWindow?: number;
  /** DSH automatic compaction in progress (compaction/start → end). The Ctx
   *  bar shows an animated "compacting" state while set. */
  compactionInProgress?: boolean;
  /** T02: DSH fork anchor awaiting the next user message — the mux seq of
   *  the just-finished turn's final event (result.dsh_seq). InputBar stamps
   *  it onto the next user message as `dshSeq` ("rewind to before that
   *  message" == session.fork at this seq) and clears the slot. Rewind on
   *  the deepseek backend re-seeds it with the fork boundary so a follow-up
   *  message after a rewind keeps a correct anchor. Only ever set for the
   *  deepseek backend; harmless elsewhere. */
  pendingDshSeq?: number;
  /** Last DSH compaction finished: timestamp (Date.now()) + shadowed tokens
   *  (token-meter heuristic estimate). Drives the transient "已压缩 −X" badge;
   *  the next request's usage/projection overwrites contextTokens with the
   *  precise value. */
  compactedAt?: number;
  compactionSavedTokens?: number;
  /** Auto-compact already fired for this session (B3 fix: per-tab flag; used to be
   *  a single ref shared across all sessions of the one InputBar instance). */
  autoCompactFired?: boolean;
  /** A /compact turn is in flight: set when a compact request is sent (auto,
   *  manual, or detected CLI-internal) and consumed by the turn's result. The
   *  compact continuation arrives as an 'assistant' event and clears the
   *  pendingCommandMsgId card slot BEFORE the 'result' — without this flag the
   *  result handler would treat the summary request as a normal turn (A1). */
  compactTurnPending?: boolean;
  /** Cumulative input tokens across ALL turns in this session/task */
  totalInputTokens?: number;
  /** Cumulative output tokens across ALL turns in this session/task */
  totalOutputTokens?: number;
  /** Cumulative cache-read (cache hit) tokens across all turns */
  totalCacheReadTokens?: number;
  /** Cumulative cache-creation (cache miss) tokens across all turns */
  totalCacheCreationTokens?: number;
  /** Timestamp (Date.now()) when the current turn started — used for elapsed timer */
  turnStartTime?: number;
  /** Who started the current turn: 'user' (InputBar submit) or 'auto' (FIFO
   *  drain, provider-switch retry). The ChatPanel scroll-follow effect uses
   *  this to avoid yanking the view back to the bottom when an automatic turn
   *  starts while the user is reading history. */
  turnStartSource?: 'user' | 'auto';
  /** Timestamp of last stream activity — used for stall detection instead of total elapsed */
  lastProgressAt?: number;
  /** JSON fingerprint of the active provider config used when spawning the CLI process.
   *  Compared before sending via stdin to detect stale pre-warm sessions. */
  envFingerprint?: string;
  /** Snapshot of sessionMode at session spawn — per-session isolation (Phase 4) */
  snapshotMode?: import('./settingsStore').SessionMode;
  /** Snapshot of selectedModel at session spawn — per-session isolation (Phase 4) */
  snapshotModel?: string;
  /** Snapshot of thinkingLevel at session spawn — per-session isolation (Phase 4) */
  snapshotThinking?: import('./settingsStore').ThinkingLevel;
  /** Snapshot of context window mode at session spawn. */
  snapshotContextWindowMode?: import('./settingsStore').ContextWindowMode;
  /** Snapshot of active provider ID at session spawn — per-tab provider isolation */
  snapshotProviderId?: string | null;
  /** Snapshot of CLI backend at session spawn — "claude" or "codex" */
  snapshotCliBackend?: string;
  /** Which backend originally created this session — from JSONL _origin field */
  sessionOrigin?: string;
  // T03: paginated history state (tail-first disk loads of huge sessions) —
  // byte cursor of the earliest loaded JSONL line, whether older lines exist,
  // and the project-dir snapshot the load_session_more command needs.
  historyCursor?: number;
  historyHasMore?: boolean;
  historyProjectDir?: string;
  /** T03: a history page fetch is in flight (drives the top loading indicator). */
  historyLoadingMore?: boolean;
  /** T03: how many messages were prepended by paging since the initial load —
   *  ChatPanel derives Virtuoso's firstItemIndex from it so prepends keep the
   *  scroll position (reset to 0 by every fresh loadSessionFromDisk). */
  historyPrepended?: number;
  /** The resolved model name used when spawning the CLI process.
   *  Compared before sending via stdin to detect mid-session model switches. */
  spawnedModel?: string;
  /** Set when API provider config changed mid-session (TK-303).
   *  If resume fails due to thinking signature mismatch, auto-retry without resume. */
  providerSwitched?: boolean;
  /** The user message text to re-send if provider-switch auto-retry triggers. */
  providerSwitchPendingText?: string;
  /** Set when model changed mid-session.
   *  If resume fails due to thinking signature mismatch, auto-retry without resume. */
  modelSwitched?: boolean;
  /** The user message text to re-send if model-switch auto-retry triggers. */
  modelSwitchPendingText?: string;
  /** Rate limit info from CLI rate_limit_event (latest per rateLimitType) */
  rateLimits?: Record<string, {
    rateLimitType: string;
    resetsAt: number;
    isUsingOverage?: boolean;
    overageStatus?: string;
    overageDisabledReason?: string;
  }>;
}

// U3: 'stopped' —— 用户主动 Stop 触发的退出语义（琥珀/灰点 + "已停止"文案），
// 区别于自然完成的 'completed' 绿点。
export type SessionStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped';

export type ActivityPhase = 'idle' | 'thinking' | 'writing' | 'tool' | 'awaiting' | 'completed' | 'error';

export interface ActivityStatus {
  phase: ActivityPhase;
  toolName?: string;  // only when phase === 'tool'
  /** Human-readable status message shown in the ActivityIndicator (error info, reconnecting, etc.) */
  statusMessage?: string;
}

// --- Per-session snapshot (backward compat type — kept for external consumers) ---

export interface SessionSnapshot {
  messages: ChatMessage[];
  partialText: string;
  partialThinking: string;
  sessionStatus: SessionStatus;
  sessionMeta: SessionMeta;
  activityStatus: ActivityStatus;
  inputDraft: string;
  pendingAttachments: FileAttachment[];
  /** User messages queued while AI is actively processing (not yet sent to stdin) */
  pendingUserMessages: string[];
}

// --- Tab session: the ONLY place session data lives ---

export interface TabSession {
  tabId: string;
  messages: ChatMessage[];
  partialText: string;
  partialThinking: string;
  sessionStatus: SessionStatus;
  sessionMeta: SessionMeta;
  activityStatus: ActivityStatus;
  inputDraft: string;
  pendingAttachments: FileAttachment[];
  pendingUserMessages: string[];
}

/** Scroll position of a chat tab at switch-away time — restored when the tab
 *  is shown again so multi-session switching never loses the user's place.
 *  `distanceFromBottom` tells the restorer whether the user was pinned to the
 *  newest output (small distance → re-pin to bottom, new content may have
 *  grown meanwhile) or reading history (large distance → restore scrollTop). */
export interface ScrollAnchor {
  scrollTop: number;
  distanceFromBottom: number;
}

// --- Store State & Actions ---

/** Lightweight streaming state separated from the heavy tabs Map.
 *  Updated at text_delta frequency (10-60 Hz) without copying tabs. */
export interface StreamState {
  partialText: string;
  partialThinking: string;
  isStreaming: boolean;
}

function emptyStream(): StreamState {
  return { partialText: '', partialThinking: '', isStreaming: false };
}

interface ChatState {
  /** All tab data — the ONLY place session data lives */
  tabs: Map<string, TabSession>;
  /** High-frequency streaming state, updated independently from tabs.
   *  Prevents O(n) Map copies on every text_delta event. */
  streams: Map<string, StreamState>;
  /** Per-tab scroll anchors captured at switch-away (kept out of tabs so the
   *  ChatPanel's onScroll handler can write it at scroll frequency without
   *  copying the heavy tab state). */
  scrollAnchors: Record<string, ScrollAnchor>;
  setScrollAnchor: (tabId: string, anchor: ScrollAnchor) => void;

  // --- Tab-level operations (all take tabId) ---
  addMessage: (tabId: string, message: ChatMessage) => void;
  /** Batch-add multiple messages in a single set() call — avoids N re-renders */
  batchAddMessages: (tabId: string, messages: ChatMessage[]) => void;
  /** T03: prepend older-history page to the FRONT in one set() call — dedupes
   *  by id (a re-fetched page never duplicates) and bumps historyPrepended so
   *  Virtuoso's firstItemIndex keeps the scroll position. */
  prependMessages: (tabId: string, messages: ChatMessage[]) => void;
  updateMessage: (tabId: string, id: string, updates: Partial<ChatMessage>) => void;
  updatePartialMessage: (tabId: string, text: string) => void;
  updatePartialThinking: (tabId: string, text: string) => void;
  /** Get current stream state for a tab (replaces reading partialText/partialThinking from tabs) */
  getStreamState: (tabId: string) => StreamState;
  setSessionStatus: (tabId: string, status: SessionStatus) => void;
  setActivityStatus: (tabId: string, status: ActivityStatus) => void;
  /** Clear messages and UI state but PRESERVE sessionMeta (for session reload) */
  clearMessages: (tabId: string) => void;
  /** Full reset: clear everything including sessionMeta (for new session / /clear) */
  resetTab: (tabId: string) => void;
  setSessionMeta: (tabId: string, meta: Partial<SessionMeta>) => void;
  /** Unbind `sessionId` from every tab that references it (used when a session
   *  is deleted from the list — a stale binding would resume a deleted session). */
  clearSessionBinding: (sessionId: string) => void;
  setInputDraft: (tabId: string, text: string) => void;
  setPendingAttachments: (tabId: string, files: FileAttachment[]) => void;
  addPendingMessage: (tabId: string, text: string) => void;
  /** Dequeue the first pending message (FIFO). Returns undefined if empty. */
  shiftPendingMessage: (tabId: string) => string | undefined;
  flushPendingMessages: (tabId: string) => string[];
  clearPendingMessages: (tabId: string) => void;
  /** Remove one queued message by index (QueueDock delete) */
  removePendingMessage: (tabId: string, index: number) => void;
  rewindToTurn: (tabId: string, startMsgIdx: number) => void;
  setInteractionState: (tabId: string, msgId: string, state: InteractionState, error?: string) => void;
  getActiveInteraction: (tabId: string) => ChatMessage | undefined;

  // --- Tab lifecycle ---
  ensureTab: (tabId: string) => void;
  removeTab: (tabId: string) => void;
  getTab: (tabId: string) => TabSession | undefined;

  // --- Backward compat: sessionCache alias + *InCache methods ---
  /** @deprecated Alias for tabs. Kept for gradual migration. */
  sessionCache: Map<string, SessionSnapshot>;
  /** @deprecated Data already lives in tabs. Kept for call sites that save before switching. */
  saveToCache: (tabId: string) => void;
  /** @deprecated Just checks tab existence. Kept for backward compat. */
  restoreFromCache: (tabId: string) => boolean;
  removeFromCache: (tabId: string) => void;
  hasCachedSession: (tabId: string) => boolean;
  /** @deprecated Use addMessage(tabId, message) directly. */
  addMessageToCache: (tabId: string, message: ChatMessage) => void;
  /** @deprecated Use updatePartialMessage(tabId, text) directly. */
  updatePartialInCache: (tabId: string, text: string) => void;
  /** @deprecated Use updatePartialThinking(tabId, thinking) directly. */
  updatePartialThinkingInCache: (tabId: string, thinking: string) => void;
  /** @deprecated Use setSessionStatus(tabId, status) directly. */
  setStatusInCache: (tabId: string, status: SessionStatus) => void;
  /** @deprecated Use setSessionMeta(tabId, meta) directly. */
  setMetaInCache: (tabId: string, meta: Partial<SessionMeta>) => void;
  /** @deprecated Use setActivityStatus(tabId, status) directly. */
  setActivityInCache: (tabId: string, status: ActivityStatus) => void;
  /** @deprecated Use updateMessage(tabId, msgId, updates) directly. */
  updateMessageInCache: (tabId: string, msgId: string, updates: Partial<ChatMessage>) => void;

  /** Highlight a specific message for search result jump blink (user turn number, 1-based). Auto-clears after 2s. */
  highlightMessageIndex: number | null;
  setHighlightMessageIndex: (index: number | null) => void;
}

// --- Helpers ---

let messageCounter = 0;

export function generateMessageId(): string {
  messageCounter += 1;
  return `msg_${Date.now()}_${messageCounter}`;
}

/** Default empty tab for when no tab is selected */
const EMPTY_TAB: TabSession = {
  tabId: '',
  messages: [],
  partialText: '',
  partialThinking: '',
  sessionStatus: 'idle',
  sessionMeta: {},
  activityStatus: { phase: 'idle' },
  inputDraft: '',
  pendingAttachments: [],
  pendingUserMessages: [],
};

function createTab(tabId: string): TabSession {
  return { ...EMPTY_TAB, tabId };
}

/** Maximum number of tabs kept in memory. LRU eviction applies to idle tabs. */
const MAX_CACHE = 8;

/**
 * Immutable Map update helper: get tab, apply updater, return new Map.
 * Returns undefined if tab doesn't exist (caller should return {} to skip).
 */
function updateTab(
  tabs: Map<string, TabSession>,
  tabId: string,
  updater: (tab: TabSession) => TabSession,
): { tabs: Map<string, TabSession>; sessionCache: Map<string, TabSession> } | undefined {
  const tab = tabs.get(tabId);
  if (!tab) return undefined;
  const newTabs = new Map(tabs);
  newTabs.set(tabId, updater(tab));
  return { tabs: newTabs, sessionCache: newTabs };
}

// --- Selector helpers ---

/**
 * React hook: select a field from the active tab.
 * Usage: `useActiveTab(t => t.messages)`
 */
export function useActiveTab<T>(selector: (tab: TabSession) => T): T {
  const tabId = useSessionStore((s) => s.selectedSessionId);
  return useChatStore((state) => {
    const tab = tabId ? state.tabs.get(tabId) : undefined;
    return selector(tab ?? EMPTY_TAB);
  });
}

/**
 * Imperative: get active tab data (for non-React contexts).
 */
export function getActiveTabState(): TabSession {
  const tabId = useSessionStore.getState().selectedSessionId;
  const tab = tabId ? useChatStore.getState().tabs.get(tabId) : undefined;
  return tab ?? EMPTY_TAB;
}

// --- Store ---

// A5→P1: 统一的每 tab 消息 id→index 索引（取代原 len 探测式 _batchDedupCache）。
// updateMessage 等高频路径靠它 O(1) 定点查找，免去对整个 messages 数组的 O(n) 扫描
// （长会话 1000+ 消息、agent 工具密集期每个 tool_result 事件都要碎忙一次）。
//
// P1 一致性维护点（所有会改变 messages 数组内容/顺序的路径都必须同步本索引）：
//   addMessage / batchAddMessages —— 追加时登记新索引（原位更新不改索引）
//   prependMessages        —— 头部插入使全部索引偏移，直接按合并结果整体重建
//   rewindToTurn           —— 截断后删除切口之后的条目
//   clearMessages/resetTab —— 清空/重置时删除整个 tab 的索引
//   _purgeTabCache         —— removeTab/LRU 淘汰/缓存未命中回收时删除
//   migrateBatchDedupKey   —— draft→real id 改名时迁移键
// 所有读取方在用索引前必须校验 messages[idx].id === id；索引缺失/陈旧时走
// O(n) 线性回退并顺手自愈（getMsgIndex 缺失时也会按当前数组惰性重建）——保底不炸。
const _msgIndex = new Map<string, Map<string, number>>();

/** P1: 取某 tab 的 id→index 索引；缺失（首访/被清理后）则按当前数组惰性重建——自愈兜底。 */
function getMsgIndex(tabId: string, messages: ChatMessage[]): Map<string, number> {
  let index = _msgIndex.get(tabId);
  if (!index) {
    index = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) index.set(messages[i].id, i);
    _msgIndex.set(tabId, index);
  }
  return index;
}

/** Drop all per-tab module-level caches when a tab is removed (memory hygiene). */
function _purgeTabCache(tabId: string) {
  _msgIndex.delete(tabId); // P1 一致性维护点：tab 移除 → 索引不能留陈旧条目
  useAgentStore.getState().removeCache(tabId);
}

// fix7: draft→real id 改名时迁移 per-tab 缓存键，不留僵尸条目
// P1: _batchDedupCache 已并入 _msgIndex；导出签名保持不变（useStreamProcessor 的
// promoteDraftIfNeeded 仍按原名调用），内部改为迁移消息索引键。
export function migrateBatchDedupKey(oldTabId: string, newTabId?: string) {
  const entry = _msgIndex.get(oldTabId);
  _msgIndex.delete(oldTabId);
  if (entry && newTabId && !_msgIndex.has(newTabId)) {
    _msgIndex.set(newTabId, entry);
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  tabs: new Map(),
  sessionCache: new Map(),   // alias — always kept in sync with tabs
  streams: new Map(),        // light-weight streaming state, updated without copying tabs
  scrollAnchors: {},
  setScrollAnchor: (tabId, anchor) =>
    set((state) => ({ scrollAnchors: { ...state.scrollAnchors, [tabId]: anchor } })),

  highlightMessageIndex: null,
  setHighlightMessageIndex: (index) => set({ highlightMessageIndex: index }),

  // ------------------------------------------------------------------
  // Tab-level operations
  // ------------------------------------------------------------------

  addMessage: (tabId, message) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        // De-duplicate: if a message with the same ID already exists, update it
        // instead of appending a duplicate. This happens when the CLI re-sends
        // a complete assistant message that was previously delivered partially.
        // P1: 查重走 id→index 索引（O(1)），替代对整个数组的 O(n) findIndex。
        const index = getMsgIndex(tabId, tab.messages);
        let existingIdx = index.get(message.id);
        if (existingIdx === undefined || existingIdx >= tab.messages.length
            || tab.messages[existingIdx].id !== message.id) {
          // P1 保底回退：索引缺失/陈旧 → 线性扫描（原逻辑），命中则自愈索引
          existingIdx = tab.messages.findIndex((m) => m.id === message.id);
          if (existingIdx !== -1) index.set(message.id, existingIdx);
        }
        let messages: ChatMessage[];
        if (existingIdx !== undefined && existingIdx !== -1) {
          messages = tab.messages.slice();
          messages[existingIdx] = { ...messages[existingIdx], ...message };
        } else {
          // P1 一致性维护点：追加时登记索引（位置 = 当前数组尾部）
          index.set(message.id, tab.messages.length);
          messages = [...tab.messages, message];
        }
        return { ...tab, messages };
        // NOTE: partialText/isStreaming are NOT cleared here. Clearing is handled
        // explicitly by clearPartial() in the result/process_exit handlers and
        // in the assistant message handler when a text block supersedes streaming.
      });
      return result ?? {};
    }),

  /** Batch-add multiple messages in a single set() call.
   *  Deduplicates by message ID (update if exists, append if new).
   *  For streaming text that should be cleared when a full assistant text block
   *  arrives, the caller should still clear partialText/isStreaming separately
   *  (or pass clearStreaming: true via batchAddMessagesWithStreamClear). */
  batchAddMessages: (tabId, messages) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        if (messages.length === 0) return tab;
        const existing = tab.messages;
        // A5→P1: 用统一维护的 id→index 索引做去重（各增删路径增量维护，
        // 不再需要 len 探测重建），每条消息 O(1) 查找。
        const index = getMsgIndex(tabId, existing);
        const newMessages: ChatMessage[] = [];
        const updated = [...existing];
        for (const msg of messages) {
          let idx = index.get(msg.id);
          if (idx !== undefined && (idx >= updated.length || updated[idx].id !== msg.id)) {
            // P1 保底回退：索引陈旧 → 单条线性探测并自愈（不影响其余消息）
            idx = updated.findIndex((m) => m.id === msg.id);
            if (idx !== -1) index.set(msg.id, idx);
          }
          if (idx !== undefined && idx !== -1) {
            updated[idx] = { ...updated[idx], ...msg };
          } else {
            newMessages.push(msg);
          }
        }
        // P1 一致性维护点：批量登记追加项的索引（位置 = existing 尾部 + 批内偏移）。
        // 批内同 id 重复保持原语义：都追加（索引最终指向最后一个，与旧缓存重建一致）。
        for (let i = 0; i < newMessages.length; i++) {
          index.set(newMessages[i].id, existing.length + i);
        }
        return { ...tab, messages: [...updated, ...newMessages] };
      });
      return result ?? {};
    }),

  /** T03: see interface. Older-history pages arrive newest-first-within-page
   *  in FILE order (parseSessionMessages output), so they go in front of the
   *  current head as-is. historyPrepended is bumped atomically with messages
   *  so ChatPanel's firstItemIndex never lags a render behind the data. */
  prependMessages: (tabId, messages) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        if (messages.length === 0) return tab;
        const existingIds = new Set<string>();
        for (const m of tab.messages) existingIds.add(m.id);
        const fresh = messages.filter((m) => !existingIds.has(m.id));
        if (fresh.length === 0) return tab;
        // P1 一致性维护点：头部插入使所有既有索引整体偏移 fresh.length。
        // 该路径仅发生在历史分页加载（低频），直接按合并结果整体重建索引
        // （与逐条偏移修正等价，但不会漏项）。
        const merged = [...fresh, ...tab.messages];
        const rebuilt = new Map<string, number>();
        for (let i = 0; i < merged.length; i++) rebuilt.set(merged[i].id, i);
        _msgIndex.set(tabId, rebuilt);
        return {
          ...tab,
          messages: merged,
          sessionMeta: {
            ...tab.sessionMeta,
            historyPrepended: (tab.sessionMeta.historyPrepended ?? 0) + fresh.length,
          },
        };
      });
      return result ?? {};
    }),

  updateMessage: (tabId, id, updates) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        // P1: id→index 定点替换——tool_result 等高频流事件此前每次都对整个
        // messages 数组做 O(n) map（长会话 1000+ 消息、agent 工具密集期主线程
        // 持续碎忙）；现在 O(1) 定位 + 单点替换。
        const index = getMsgIndex(tabId, tab.messages);
        const idx = index.get(id);
        if (idx !== undefined && idx < tab.messages.length && tab.messages[idx].id === id) {
          // 仍返回新数组引用以触发 React 更新，但免去全量 map
          const messages = tab.messages.slice();
          messages[idx] = { ...messages[idx], ...updates };
          return { ...tab, messages };
        }
        // P1 保底回退：索引缺失/陈旧 → 原有 O(n) 扫描（行为与旧实现一致），
        // 命中时顺手自愈索引，下次即走快路径。
        let found = -1;
        const messages = tab.messages.map((m, i) => {
          if (m.id === id) { found = i; return { ...m, ...updates }; }
          return m;
        });
        if (found !== -1) index.set(id, found);
        return { ...tab, messages };
      });
      return result ?? {};
    }),

  updatePartialMessage: (tabId, text) =>
    set((state) => {
      // Regression fix: a deleted tab's late-arriving flush (in-flight rAF
      // after removeTab) must not recreate its streams entry.
      if (!state.tabs.has(tabId)) return {};
      // Update streams — lightweight, no tabs Map copy
      const newStreams = new Map(state.streams);
      const s = newStreams.get(tabId);
      newStreams.set(tabId, {
        partialText: (s?.partialText ?? '') + text,
        partialThinking: s?.partialThinking ?? '',
        isStreaming: true,
      });
      // B12: only copy the tabs Map when the activity phase actually changes.
      // Every flush used to copy it and notify ALL subscribers even though the
      // tab object was identical — at 60Hz flush × every chatStore subscriber
      // that was pure waste (useActiveTab's selector already relies on the tab
      // reference staying stable to skip re-renders).
      const tab = state.tabs.get(tabId);
      if (tab && tab.activityStatus.phase !== 'writing') {
        const newTabs = new Map(state.tabs);
        newTabs.set(tabId, { ...tab, activityStatus: { phase: 'writing' as ActivityPhase } });
        return { streams: newStreams, tabs: newTabs, sessionCache: newTabs };
      }
      return { streams: newStreams };
    }),

  updatePartialThinking: (tabId, text) =>
    set((state) => {
      // Regression fix: same deleted-tab guard as updatePartialMessage.
      if (!state.tabs.has(tabId)) return {};
      const newStreams = new Map(state.streams);
      const s = newStreams.get(tabId);
      newStreams.set(tabId, {
        partialText: s?.partialText ?? '',
        partialThinking: (s?.partialThinking ?? '') + text,
        isStreaming: true,
      });
      // B12: same tabs-copy skip as updatePartialMessage — no-op phase changes
      // must not notify every subscriber.
      const tab = state.tabs.get(tabId);
      if (tab && tab.activityStatus.phase !== 'thinking') {
        const newTabs = new Map(state.tabs);
        newTabs.set(tabId, { ...tab, activityStatus: { phase: 'thinking' as ActivityPhase } });
        return { streams: newStreams, tabs: newTabs, sessionCache: newTabs };
      }
      return { streams: newStreams };
    }),

  getStreamState: (tabId) => {
    const s = get().streams.get(tabId);
    return s ?? emptyStream();
  },

  setSessionStatus: (tabId, status) => {
    // Sync full lifecycle state to sessionStore for the conversation-list
    // status dot (running/completed/error/idle — not just the busy flag, so a
    // finished conversation keeps its dot until the session is active again).
    useSessionStore.getState().setSessionStatus(tabId, status);
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        sessionStatus: status,
        // Sync activity status with session status
        // U3: 'stopped' falls back to an idle phase — the caller (stop flow)
        // writes the "已停止" statusMessage right after.
        ...(status === 'completed' ? { activityStatus: { phase: 'completed' as ActivityPhase } }
          : status === 'error' ? { activityStatus: { phase: 'error' as ActivityPhase } }
          : status === 'idle' ? { activityStatus: { phase: 'idle' as ActivityPhase } }
          : status === 'stopped' ? { activityStatus: { phase: 'idle' as ActivityPhase } }
          : {}),
      }));
      // Clear streams when session ends (U3: 'stopped' is also terminal)
      const newStreams = (status === 'completed' || status === 'error' || status === 'idle' || status === 'stopped')
        ? (() => { const m = new Map(state.streams); m.delete(tabId); return m; })()
        : state.streams;
      return { tabs: result?.tabs ?? state.tabs, sessionCache: result?.sessionCache ?? state.sessionCache, streams: newStreams };
    });
  },

  setActivityStatus: (tabId, status) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        if (tab.activityStatus.phase === status.phase && tab.activityStatus.toolName === status.toolName) return tab;
        return { ...tab, activityStatus: status };
      });
      return result ?? {};
    }),

  clearMessages: (tabId) => {
    _msgIndex.delete(tabId); // P1 一致性维护点：消息清空时删索引，防陈旧条目（fix8 等价物）
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        messages: [],
        sessionStatus: 'idle',
        // Preserve sessionMeta (especially sessionId for resume)
        activityStatus: { phase: 'idle' },
        inputDraft: '',
        pendingAttachments: [],
        pendingUserMessages: [],
      }));
      const newStreams = new Map(state.streams);
      newStreams.delete(tabId);
      return { tabs: result?.tabs ?? state.tabs, sessionCache: result?.sessionCache ?? state.sessionCache, streams: newStreams };
    });
  },

  resetTab: (tabId) => {
    // B5: also drop the per-tab agent snapshot — otherwise the next
    // restoreFromCache for this tab resurrects a stale agent tree (e.g. a
    // deleted session's sub-agents appearing in the freshly cleared tab).
    useAgentStore.getState().removeCache(tabId);
    // P1 一致性维护点：/clear 复用同一 tabId 且消息清空 → 索引一并删除
    // （旧实现在此路径漏删 _batchDedupCache，靠 len 探测兜底；统一索引必须显式删）
    _msgIndex.delete(tabId);
    return set((state) => {
      const result = updateTab(state.tabs, tabId, () => createTab(tabId));
      const newStreams = new Map(state.streams);
      newStreams.delete(tabId);
      // /clear reuses the same tabId — a stale anchor would restore an old
      // scroll position (and detach follow) on the freshly cleared session.
      const newAnchors = { ...state.scrollAnchors };
      delete newAnchors[tabId];
      return { tabs: result?.tabs ?? state.tabs, sessionCache: result?.sessionCache ?? state.sessionCache, streams: newStreams, scrollAnchors: newAnchors };
    });
  },

  setSessionMeta: (tabId, meta) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        sessionMeta: { ...tab.sessionMeta, ...meta },
      }));
      return result ?? {};
    }),

  clearSessionBinding: (sessionId) =>
    set((state) => {
      let changed = false;
      const tabs = new Map(state.tabs);
      for (const [tabId, tab] of tabs) {
        if (tab.sessionMeta.sessionId === sessionId) {
          tabs.set(tabId, {
            ...tab,
            sessionMeta: { ...tab.sessionMeta, sessionId: undefined },
          });
          changed = true;
        }
      }
      return changed ? { tabs } : {};
    }),

  setInputDraft: (tabId, text) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        inputDraft: text,
      }));
      return result ?? {};
    }),

  setPendingAttachments: (tabId, files) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        pendingAttachments: files,
      }));
      return result ?? {};
    }),

  addPendingMessage: (tabId, text) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        pendingUserMessages: [...tab.pendingUserMessages, text],
      }));
      return result ?? {};
    }),

  shiftPendingMessage: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab || tab.pendingUserMessages.length === 0) return undefined;
    const first = tab.pendingUserMessages[0];
    set((state) => {
      const r = updateTab(state.tabs, tabId, (t) => ({
        ...t,
        pendingUserMessages: t.pendingUserMessages.slice(1),
      }));
      return r ?? {};
    });
    return first;
  },

  flushPendingMessages: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return [];
    const msgs = tab.pendingUserMessages;
    set((state) => {
      const r = updateTab(state.tabs, tabId, (t) => ({
        ...t,
        pendingUserMessages: [],
      }));
      return r ?? {};
    });
    return msgs;
  },

  clearPendingMessages: (tabId) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        pendingUserMessages: [],
      }));
      return result ?? {};
    }),

  removePendingMessage: (tabId, index) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        pendingUserMessages: tab.pendingUserMessages.filter((_, i) => i !== index),
      }));
      return result ?? {};
    }),

  rewindToTurn: (tabId, startMsgIdx) => {
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => {
        // Guard against invalid index — if out of bounds, keep messages intact
        if (startMsgIdx < 0 || startMsgIdx > tab.messages.length) {
          console.warn('[chatStore] rewindToTurn: invalid index', startMsgIdx, 'total:', tab.messages.length);
          return {
            ...tab,
            partialText: '',
            partialThinking: '',
            activityStatus: { phase: 'idle' as ActivityPhase },
          };
        }
        // P1 一致性维护点：截断后删除切口之后的索引条目
        // （Map 迭代期间 delete 是规范允许的；索引缺失则留给 getMsgIndex 惰性重建）
        const index = _msgIndex.get(tabId);
        if (index) {
          for (const [msgId, idx] of index) {
            if (idx >= startMsgIdx) index.delete(msgId);
          }
        }
        return {
          ...tab,
          messages: tab.messages.slice(0, startMsgIdx),
          partialText: '',
          partialThinking: '',
          // Keep sessionMeta (sessionId needed for resume), reset transient state
          activityStatus: { phase: 'idle' as ActivityPhase },
        };
      });
      return result ?? {};
    });
  },

  setInteractionState: (tabId, msgId, interactionState, error) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) =>
          m.id === msgId ? {
            ...m,
            interactionState,
            interactionError: error,
            resolved: interactionState === 'resolved',
          } : m,
        ),
      }));
      return result ?? {};
    }),

  getActiveInteraction: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return undefined;
    // Return the last message with an active (pending) interaction
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if ((m.type === 'permission' || m.type === 'question') && m.interactionState === 'pending') {
        return m;
      }
    }
    return undefined;
  },

  // ------------------------------------------------------------------
  // Tab lifecycle
  // ------------------------------------------------------------------

  ensureTab: (tabId) => {
    if (get().tabs.has(tabId)) return;
    const newTabs = new Map(get().tabs);
    newTabs.set(tabId, createTab(tabId));
    // LRU eviction — keep at most MAX_CACHE tabs
    // Never evict tabs that are actively streaming — their disk JSONL may have
    // been compacted, so the tab is the only source of full history (#32 fix)
    const evicted: string[] = [];
    // F4: 收集被淘汰 tab 的存活 CLI 进程 stdinId（淘汰后统一 kill）
    const evictedStdinIds: string[] = [];
    if (newTabs.size > MAX_CACHE) {
      const keysIter = newTabs.keys();
      while (newTabs.size > MAX_CACHE) {
        const oldest = keysIter.next().value;
        if (oldest === undefined) break;
        if (oldest === tabId) continue; // don't evict the tab we're creating
        // fix2: LRU 淘汰跳过当前选中 tab（用户正在看的会话不能被逐出内存）
        if (oldest === useSessionStore.getState().selectedSessionId) continue;
        const entry = newTabs.get(oldest);
        // B2: TabSession.isStreaming was removed (dead field) — the real
        // streaming flag lives in the streams Map (StreamState.isStreaming).
        if (get().streams.get(oldest)?.isStreaming || entry?.sessionStatus === 'running') continue; // protect active
        // F4: 非 running/streaming 但仍持有 stdinId（prewarm/空闲遗留进程）
        if (entry?.sessionMeta.stdinId) evictedStdinIds.push(entry.sessionMeta.stdinId);
        newTabs.delete(oldest);
        evicted.push(oldest);
      }
      // If all candidates are streaming, allow cache to exceed MAX_CACHE
    }
    // F4: 淘汰路径不能泄漏存活进程——kill + 回收事件监听与 stdinId→tab 映射
    for (const sid of evictedStdinIds) {
      bridge.killSession(sid).catch(() => {});
      cleanupStreamListener(sid);
      useSessionStore.getState().unregisterStdinTab(sid);
    }
    // Regression fix: evicted tabs' stream entries (partialText up to hundreds
    // of KB) must not linger — removeTab deletes streams; the LRU path didn't.
    let newStreams = get().streams;
    let newAnchors = get().scrollAnchors;
    if (evicted.length > 0) {
      newStreams = new Map(newStreams);
      for (const k of evicted) {
        newStreams.delete(k);
        // Scroll anchors of evicted tabs must not resurrect a stale view if
        // the same tabId ever comes back.
        if (newAnchors[k]) {
          const a = { ...newAnchors };
          delete a[k];
          newAnchors = a;
        }
        // Memory hygiene: same purge as removeTab — the evicted tab's
        // agent snapshot + batch-dedup index must not linger forever
        // (LRU eviction used to skip _purgeTabCache, leaking per-tab
        // AgentNode maps on heavy tab churn).
        _purgeTabCache(k);
      }
    }
    set({ tabs: newTabs, sessionCache: newTabs, streams: newStreams, scrollAnchors: newAnchors });
  },

  removeTab: (tabId) => {
    const newTabs = new Map(get().tabs);
    newTabs.delete(tabId);
    // B12: also drop the streams entry — a deleted session's partialText
    // (potentially a large string) used to linger in memory forever.
    const newStreams = new Map(get().streams);
    newStreams.delete(tabId);
    // Same for the scroll anchor — a deleted session must not restore a view.
    const newAnchors = { ...get().scrollAnchors };
    delete newAnchors[tabId];
    set({ tabs: newTabs, sessionCache: newTabs, streams: newStreams, scrollAnchors: newAnchors });
    _purgeTabCache(tabId);
  },

  getTab: (tabId) => get().tabs.get(tabId),

  // ------------------------------------------------------------------
  // Backward compat: sessionCache + *InCache methods
  // ------------------------------------------------------------------

  saveToCache: (tabId) => {
    // In v2, data already lives in tabs. This is effectively a no-op.
    // However, we still ensure the tab exists (some call sites save before switching
    // and may not have called ensureTab yet).
    get().ensureTab(tabId);
    // fix2: delete+set 刷新 Map 插入序，让淘汰反映真正最近使用（真 LRU）
    const tab = get().tabs.get(tabId);
    if (tab) {
      const newTabs = new Map(get().tabs);
      newTabs.delete(tabId);
      newTabs.set(tabId, tab);
      set({ tabs: newTabs, sessionCache: newTabs });
    }
  },

  restoreFromCache: (tabId) => {
    const tab = get().tabs.get(tabId);
    if (!tab) return false;
    // #27/#30 safety net: if tab has zero messages but this is a persisted session
    // (has a disk path), treat as cache miss so the caller falls back to disk load.
    // Streaming state lives in the `streams` Map (TabSession.isStreaming is never
    // set true — it was a dead check); a live stream must keep the tab alive or
    // the first buffered events get dropped with the tab.
    const stream = get().streams.get(tabId);
    if (
      tab.messages.length === 0 &&
      !stream?.isStreaming &&
      !tab.partialText &&
      !stream?.partialText
    ) {
      const session = useSessionStore.getState().sessions.find((s) => s.id === tabId);
      if (session?.path) {
        const newTabs = new Map(get().tabs);
        newTabs.delete(tabId);
        set({ tabs: newTabs, sessionCache: newTabs });
        _purgeTabCache(tabId);
        return false;
      }
    }
    // TK-329: Validate stdinId ownership — prevent cross-tab contamination
    if (tab.sessionMeta.stdinId) {
      const ownerTab = useSessionStore.getState().getTabForStdin(tab.sessionMeta.stdinId);
      if (ownerTab && ownerTab !== tabId) {
        // Fix: strip stdinId that belongs to another tab
        set((state) => {
          const result = updateTab(state.tabs, tabId, (t) => ({
            ...t,
            sessionMeta: { ...t.sessionMeta, stdinId: undefined },
          }));
          return result ?? {};
        });
      }
    }
    // Sync full lifecycle state to sessionStore for the sidebar indicator (FI-1
    // fix) — the conversation list renders running/completed/error dots.
    useSessionStore.getState().setSessionStatus(tabId, tab.sessionStatus);
    // fix2: 命中恢复即访问——delete+set 刷新插入序（真 LRU）；重读最新 tab，
    // 避免覆盖上面的 stdinId 归属清理
    const freshTab = get().tabs.get(tabId);
    if (freshTab) {
      const newTabs = new Map(get().tabs);
      newTabs.delete(tabId);
      newTabs.set(tabId, freshTab);
      set({ tabs: newTabs, sessionCache: newTabs });
    }
    return true;
  },

  removeFromCache: (tabId) => {
    get().removeTab(tabId);
  },

  hasCachedSession: (tabId) => get().tabs.has(tabId),

  // *InCache methods — delegate directly to tab-level methods

  addMessageToCache: (tabId, message) => {
    // #27/#30 fix: skip if no tab entry — creating a tab with only this single
    // message risks losing real history if the entry was LRU-evicted.
    if (!get().tabs.has(tabId)) return;
    get().addMessage(tabId, message);
  },

  updatePartialInCache: (tabId, text) => {
    if (!get().tabs.has(tabId)) return;
    get().updatePartialMessage(tabId, text);
  },

  updatePartialThinkingInCache: (tabId, thinking) => {
    if (!get().tabs.has(tabId)) return;
    get().updatePartialThinking(tabId, thinking);
  },

  setStatusInCache: (tabId, status) => {
    // Always sync running state indicator, even without a tab
    useSessionStore.getState().setSessionRunning(tabId, status === 'running');
    if (!get().tabs.has(tabId)) return;
    get().setSessionStatus(tabId, status);
  },

  setMetaInCache: (tabId, meta) => {
    if (!get().tabs.has(tabId)) return;
    get().setSessionMeta(tabId, meta);
  },

  setActivityInCache: (tabId, status) => {
    if (!get().tabs.has(tabId)) return;
    get().setActivityStatus(tabId, status);
  },

  updateMessageInCache: (tabId, msgId, updates) => {
    if (!get().tabs.has(tabId)) return;
    get().updateMessage(tabId, msgId, updates);
  },
}));
