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

export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

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

// A5: Module-level dedup cache for batchAddMessages — avoids O(n) Map rebuild
// on every assistant message. Keyed by tabId, invalidated when message count changes.
const _batchDedupCache = new Map<string, { len: number; ids: Map<string, number> }>();

/** Drop all per-tab module-level caches when a tab is removed (memory hygiene). */
function _purgeTabCache(tabId: string) {
  _batchDedupCache.delete(tabId);
  useAgentStore.getState().removeCache(tabId);
}

// fix7: draft→real id 改名时迁移 _batchDedupCache 键，不留僵尸条目
export function migrateBatchDedupKey(oldTabId: string, newTabId?: string) {
  const entry = _batchDedupCache.get(oldTabId);
  _batchDedupCache.delete(oldTabId);
  if (entry && newTabId && !_batchDedupCache.has(newTabId)) {
    _batchDedupCache.set(newTabId, entry);
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
        const existingIdx = tab.messages.findIndex((m) => m.id === message.id);
        const messages = existingIdx !== -1
          ? tab.messages.map((m, i) => i === existingIdx ? { ...m, ...message } : m)
          : [...tab.messages, message];
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
        // A5: Reuse cached dedup Map when message count hasn't changed.
        // Only rebuild when messages were added/removed by other operations.
        let existingIds: Map<string, number>;
        const cache = _batchDedupCache.get(tabId);
        if (cache && cache.len === existing.length) {
          existingIds = cache.ids;
        } else {
          existingIds = new Map<string, number>();
          for (let i = 0; i < existing.length; i++) {
            existingIds.set(existing[i].id, i);
          }
          _batchDedupCache.set(tabId, { len: existing.length, ids: existingIds });
        }
        const newMessages: ChatMessage[] = [];
        const updated = [...existing];
        for (const msg of messages) {
          const idx = existingIds.get(msg.id);
          if (idx !== undefined) {
            updated[idx] = { ...updated[idx], ...msg };
          } else {
            newMessages.push(msg);
          }
        }
        return { ...tab, messages: [...updated, ...newMessages] };
      });
      return result ?? {};
    }),

  updateMessage: (tabId, id, updates) =>
    set((state) => {
      const result = updateTab(state.tabs, tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) =>
          m.id === id ? { ...m, ...updates } : m,
        ),
      }));
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
        ...(status === 'completed' ? { activityStatus: { phase: 'completed' as ActivityPhase } }
          : status === 'error' ? { activityStatus: { phase: 'error' as ActivityPhase } }
          : status === 'idle' ? { activityStatus: { phase: 'idle' as ActivityPhase } }
          : {}),
      }));
      // Clear streams when session ends
      const newStreams = (status === 'completed' || status === 'error' || status === 'idle')
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
    _batchDedupCache.delete(tabId); // fix8: 消息清空时顺手删批次去重缓存，防陈旧索引
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
    _batchDedupCache.delete(tabId); // fix8: rewind 截断消息后顺手删批次去重缓存
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
