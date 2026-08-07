import { useCallback, type MutableRefObject } from 'react';
import { useChatStore, generateMessageId, type ChatMessage } from '../stores/chatStore';
import {
  useSettingsStore,
  mapSessionModeToPermissionMode,
  getEffectiveMode,
  getContextWindowForModel,
  getAutoCompactThreshold,
} from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { debugLog } from '../lib/debug-log';
import { useAgentStore, resolveAgentId, getAgentDepth, updatePhaseInSnapshot } from '../stores/agentStore';
import { useFileStore } from '../stores/fileStore';
import { useTokenSpeedStore, estimateTokensFromText } from '../stores/tokenSpeedStore';
import { bridge, onClaudeStream, onClaudeStderr } from '../lib/tauri-bridge';
import { envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../lib/api-provider';
import { useProviderStore } from '../stores/providerStore';
import { t } from '../lib/i18n';
import { cleanupStreamListener, registerStreamListener, clearLegacyListener } from '../lib/stream-cleanup';

// --- Error classification for user-facing messages ---
// Each pattern maps to a friendly i18n key. Matched errors show the friendly
// message as primary text with raw error in a collapsible details block.
// Unmatched errors get a generic fallback + raw details.
const ERROR_CATEGORIES: ReadonlyArray<{ pattern: RegExp; i18nKey: string }> = [
  { pattern: /40[13]|unauthorized|invalid.*key|api.key.*invalid/i, i18nKey: 'error.invalidKey' },
  { pattern: /429|rate.limit|too.many.request/i, i18nKey: 'error.rateLimit' },
  { pattern: /quota|insufficient.*balance|credit|billing/i, i18nKey: 'error.quotaExceeded' },
  { pattern: /model.*not.found|invalid.*model|not_found.*model/i, i18nKey: 'error.modelNotFound' },
  { pattern: /timeout|timed?.out|ECONNREFUSED|ECONNRESET|ENOTFOUND/i, i18nKey: 'error.networkError' },
  { pattern: /network|fetch.failed|dns/i, i18nKey: 'error.networkError' },
  { pattern: /permission.denied|operation.not.permitted|access.denied|forbidden/i, i18nKey: 'error.permissionDenied' },
  { pattern: /overloaded|capacity|503|service.unavailable/i, i18nKey: 'error.serviceUnavailable' },
  { pattern: /not.installed|command.not.found/i, i18nKey: 'error.cliNotInstalled' },
  { pattern: /token.*limit|context.*length|too.long/i, i18nKey: 'error.tokenLimit' },
];

export function formatErrorForUser(raw: string): string {
  if (!raw || raw.length < 10) return raw;
  const match = ERROR_CATEGORIES.find((c) => c.pattern.test(raw));
  const friendly = match ? t(match.i18nKey) : t('error.genericFallback');
  return `${friendly}\n\n<details>\n<summary>${t('error.showDetails')}</summary>\n\n\`\`\`\n${raw}\n\`\`\`\n\n</details>`;
}

// --- Streaming text buffer (rAF-throttled + interval fallback, per-stdinId) ---
// Coalesces rapid text_delta / thinking_delta events into a single state update
// per animation frame (~60/s), preventing JS main thread starvation from
// excessive React re-renders when the message list is large.
//
// CRITICAL: rAF alone is unreliable — heavy React re-renders can block the
// rendering pipeline, preventing rAF callbacks from firing. A 200ms setInterval
// fallback ensures buffered text is always flushed even when rAF is starved.
//
// TK-329 fix: each session gets its own buffer to prevent cross-contamination
// when multiple sessions stream concurrently.
interface _StreamBuffer {
  text: string;
  thinking: string;
  raf: number;
  /** setTimeout id while in throttled mode (0 when none) */
  timer: number;
  /** Total bytes streamed this turn — crossing THROTTLE_BYTES switches the
   *  flush cadence from per-frame rAF to a 150ms timer (A7). */
  totalBytes: number;
  throttled: boolean;
}
const _streamBuffers = new Map<string, _StreamBuffer>();

// A7: Beyond this many streamed bytes (text + thinking) in one turn, flushing
// every frame re-renders the whole Markdown partial per frame, which chokes
// the main thread on long answers. Drop to THROTTLE_MS flushes instead.
const THROTTLE_BYTES = 8 * 1024;
const THROTTLE_MS = 150;

// Interval fallback: flush any stuck buffers every 500ms (A7: was 200ms).
// A longer interval reduces the per-flush full-list layout cost — rAF covers the
// common path (~60fps when the rendering pipeline is healthy), so the fallback
// only matters when rAF is starved (heavy re-renders).
let _flushIntervalId: ReturnType<typeof setInterval> | null = null;

// A4: Throttle lastProgressAt updates to ~1.5s to reduce setSessionMeta calls
// from 50-120/s to ~1/s during streaming (per-tab throttle).
const _lastProgressThrottle = new Map<string, number>();

function _ensureFlushInterval() {
  if (_flushIntervalId) return;
  _flushIntervalId = setInterval(() => {
    for (const [stdinId, buf] of _streamBuffers) {
      if (buf.text || buf.thinking) {
        _doFlush(stdinId, buf);
      }
    }
    // Stop interval when no active buffers remain
    if (_streamBuffers.size === 0 && _flushIntervalId) {
      clearInterval(_flushIntervalId);
      _flushIntervalId = null;
    }
  }, 500);
}

function _getBuffer(stdinId: string): _StreamBuffer {
  let buf = _streamBuffers.get(stdinId);
  if (!buf) {
    buf = { text: '', thinking: '', raf: 0, timer: 0, totalBytes: 0, throttled: false };
    _streamBuffers.set(stdinId, buf);
  }
  return buf;
}

/**
 * F4/F5: Resolve the owning tab for a stdinId, repairing stale or missing
 * stdinToTab mappings. Truth sources, in order:
 *  1. stdinToTab (sessionStore) — the fast path;
 *  2. a live chatStore tab whose sessionMeta.stdinId claims this stream
 *     (authoritative: set at spawn time, cleared on process_exit).
 *
 * A mapping that points to a nonexistent tab (abandoned draft, stale
 * sessionStorage entry) is dropped so the stream falls back to the active
 * tab instead of being silently background-routed forever — the "frozen UI
 * while the agent keeps running" failure mode.
 */
export function resolveOwnerTab(stdinId: string | undefined): string | undefined {
  if (!stdinId) return undefined;
  const ss = useSessionStore.getState();
  const mapped = ss.getTabForStdin(stdinId);
  if (mapped) {
    const known = !!useChatStore.getState().getTab(mapped)
      || ss.selectedSessionId === mapped
      || ss.sessions.some((s) => s.id === mapped);
    if (known) return mapped;
    console.warn('[LITTLECLAUDE:route] stale stdinToTab mapping dropped:', stdinId, '→', mapped);
    ss.unregisterStdinTab(stdinId);
  }
  // Repair: a live tab still claiming this stdinId via sessionMeta
  for (const [id, tab] of useChatStore.getState().tabs) {
    if (tab.sessionMeta.stdinId === stdinId) {
      ss.registerStdinTab(stdinId, id); // self-heal the mapping
      return id;
    }
  }
  return undefined;
}

/** Core flush logic — shared by rAF callback and interval fallback. */
function _doFlush(stdinId: string, buf: _StreamBuffer) {
  if (!buf.text && !buf.thinking) return;

  // A7: count bytes before consumption — once a turn streams past 8KiB, the
  // flush cadence drops to THROTTLE_MS so long answers don't re-render the
  // full Markdown partial every frame.
  buf.totalBytes += buf.text.length + buf.thinking.length;
  if (buf.totalBytes > THROTTLE_BYTES) {
    buf.throttled = true;
  }

  const tabId = resolveOwnerTab(stdinId);
  if (!tabId) {
    // No live owner for this stream (session torn down). Drop the buffer
    // rather than falling back to selectedSessionId: a stale session's
    // trailing tokens would otherwise contaminate the foreground tab (TK-329).
    console.warn('[stream-flush] stdinId has no live owner, dropping buffered text:', stdinId);
    // Remove the orphaned buffer entirely so the map cannot grow without
    // bound when streams never resolve to a live tab.
    _streamBuffers.delete(stdinId);
    return;
  }

  const store = useChatStore.getState();
  if (buf.text) {
    store.updatePartialMessage(tabId, buf.text);
    buf.text = '';
  }
  if (buf.thinking) {
    store.updatePartialThinking(tabId, buf.thinking);
    buf.thinking = '';
  }
}

function _scheduleStreamFlush(stdinId: string) {
  const buf = _getBuffer(stdinId);
  // Start the interval fallback on first buffer activity
  _ensureFlushInterval();
  if (!buf.throttled) {
    if (buf.raf) return;
    buf.raf = requestAnimationFrame(() => {
      buf.raf = 0;
      _doFlush(stdinId, buf);
    });
  } else {
    // A7: throttled mode — one pending timer per buffer, 150ms cadence.
    if (buf.timer) return;
    buf.timer = window.setTimeout(() => {
      buf.timer = 0;
      _doFlush(stdinId, buf);
    }, THROTTLE_MS);
  }
}

/** Flush any buffered streaming text immediately (call before clearPartial).
 *  If stdinId is provided, flush only that session's buffer.
 *  If omitted, flush ALL buffers (backward compat). */
export function flushStreamBuffer(stdinId?: string) {
  const ids = stdinId ? [stdinId] : Array.from(_streamBuffers.keys());

  for (const id of ids) {
    const buf = _streamBuffers.get(id);
    if (!buf) continue;

    if (buf.raf) {
      cancelAnimationFrame(buf.raf);
      buf.raf = 0;
    }
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = 0;
    }
    _doFlush(id, buf);
  }

  // Clean up buffers and stop interval when all cleared
  if (!stdinId) {
    _streamBuffers.clear();
  } else {
    _streamBuffers.delete(stdinId);
  }
  if (_streamBuffers.size === 0 && _flushIntervalId) {
    clearInterval(_flushIntervalId);
    _flushIntervalId = null;
  }
}

// --- File tree auto-refresh on file-mutating tool completions ---
// Tools that may create/modify/delete files in the working directory.
const FILE_MUTATING_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'Bash', 'BatchTool',
]);

// A3: Module-level constant — avoids 50-120 Set allocations/second during streaming.
// Previously created inside handleStreamMessage on every event.
const KNOWN_STREAM_TYPES = new Set([
  'little_claude_permission_request', 'stream_event', 'system', 'assistant',
  'user', 'human', 'tool_result', 'tool_use_summary', 'result', 'process_exit',
  'content_block_delta', 'rate_limit_event',
]);

// Debounce tree refresh to batch rapid tool completions (e.g. parallel agents).
let _fileRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleFileTreeRefresh() {
  if (_fileRefreshTimer) return; // already scheduled
  _fileRefreshTimer = setTimeout(() => {
    _fileRefreshTimer = null;
    useFileStore.getState().refreshTree();
  }, 300);
}

/**
 * If the tool_result's parent tool_use was a file-mutating tool,
 * schedule a debounced file tree refresh.
 */
// 报告B9: cap tool-result content kept in memory. Tool results routinely
// embed multi-MB payloads (file dumps, base64 image data); the store used to
// hold every byte in RAM for the whole session. Truncated content renders
// with a marker at the end. Message COUNT is intentionally uncapped — rewind
// and session export depend on the full array (they index by position).
const MAX_TOOL_RESULT_CHARS = 256 * 1024; // 256 KiB per tool result
const TOOL_RESULT_TRUNCATED_MARKER = '\n\n… (内容过长，已截断显示)';

function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + TOOL_RESULT_TRUNCATED_MARKER;
}

function _maybeRefreshFileTree(tabId: string, toolUseId?: string, toolName?: string) {
  // Fast path: tool_name available directly on the message
  if (toolName && FILE_MUTATING_TOOLS.has(toolName)) {
    _scheduleFileTreeRefresh();
    return;
  }
  // Fallback: look up parent tool_use message
  if (toolUseId) {
    const messages = useChatStore.getState().getTab(tabId)?.messages ?? [];
    const parent = messages.find((m) => m.id === toolUseId);
    if (parent?.toolName && FILE_MUTATING_TOOLS.has(parent.toolName)) {
      _scheduleFileTreeRefresh();
    }
  }
}

// H2: per-tab ExitPlanMode tracking.
// The ref is created by InputBar as a plain boolean (useRef(false)) and reset
// to `false` on every new session spawn. We lazily upgrade it to a
// Record<string, boolean> keyed by tabId on first touch, treating any
// non-object value (e.g. the InputBar reset `current = false`) as an empty
// map. Keying by tabId prevents a BACKGROUND tab's ExitPlanMode from
// triggering the FOREGROUND tab's silent auto-restart ("Continue." resubmit).
function _getExitPlanMap(ref: MutableRefObject<Record<string, boolean> | boolean>): Record<string, boolean> {
  if (typeof ref.current !== 'object' || ref.current === null) {
    ref.current = {};
  }
  return ref.current;
}

/**
 * Configuration refs and callbacks that the stream processor needs
 * from the parent InputBar component.
 */
export interface StreamProcessorConfig {
  /** H2: per-tab ExitPlanMode-seen flags (tabId → true), lazily upgraded from
   *  the boolean created in InputBar. Union type keeps InputBar's
   *  `useRef(false)` / `current = false` reset compiling unchanged. */
  exitPlanModeSeenRef: MutableRefObject<Record<string, boolean> | boolean>;
  autoCompactFiredRef: MutableRefObject<boolean>;
  silentRestartRef: MutableRefObject<boolean>;
  handleSubmitRef: MutableRefObject<() => void>;
  handleStderrLineRef: MutableRefObject<(line: string, sid: string) => void>;
  /** Last stderr error line — displayed to user if process exits without response */
  lastStderrRef: MutableRefObject<string>;
  setInputSync: (text: string) => void;
}

/**
 * Resolve the API-authoritative speed pair from a `result` event for the
 * tok/s badge. Numerator: Σ modelUsage[*].outputTokens — cumulative across
 * every API turn of the run, so multi-turn tool loops stay accurate; falls
 * back to result.usage.output_tokens (equal when num_turns === 1).
 * Denominator: duration_api_ms — pure API time, excludes local tool
 * execution and permission waits; falls back to wall-clock duration_ms.
 */
function resolveApiSpeed(msg: any): { outputTokens: number; durationMs: number } {
  let modelOut = 0;
  const modelUsage = msg?.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    for (const key of Object.keys(modelUsage)) {
      modelOut += modelUsage[key]?.outputTokens || 0;
    }
  }
  const outputTokens = modelOut > 0 ? modelOut : (msg?.usage?.output_tokens || 0);
  const durationMs = (typeof msg?.duration_api_ms === 'number' && msg.duration_api_ms > 0)
    ? msg.duration_api_ms
    : (msg?.duration_ms || 0);
  return { outputTokens, durationMs };
}

/**
 * Persist authoritative per-turn token counts to Little Claude's usage log.
 *
 * The Claude CLI sometimes writes zero/missing usage values to its JSONL session
 * files (e.g. output_tokens=0), which makes get_profile_stats under-report.
 * The live NDJSON stream carries the correct values, but they are only held
 * in-memory (Zustand). This function writes them to an append-only log that
 * get_profile_stats also reads — the durability layer that makes stats correct.
 *
 * message_id uses msg.uuid, which is the same value the JSONL stores as
 * value.uuid (the dedup fallback key in get_profile_stats).
 */
function persistTurnUsage(
  sessionId: string,
  messageId: string,
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } | undefined,
  model: string,
): void {
  if (!sessionId || !messageId) return;
  const u = usage || {};
  const cacheCreation = u.cache_creation || {};
  const cacheCreationTokens =
    (u.cache_creation_input_tokens || 0) +
    (cacheCreation.ephemeral_1h_input_tokens || 0) +
    (cacheCreation.ephemeral_5m_input_tokens || 0);
  bridge.appendUsageRecord({
    session_id: sessionId,
    message_id: messageId,
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_creation_tokens: cacheCreationTokens,
    model: model || '',
    timestamp: new Date().toISOString(),
  }).catch((err) => {
    // Non-fatal: a failed log write must never break the user's turn.
    console.warn('[LITTLECLAUDE] append_usage_record failed:', err);
  });
}

/**
 * useStreamProcessor — extracts stream message handling from InputBar.
 *
 * Returns handleStreamMessage (foreground) and handleBackgroundStreamMessage
 * (background tab routing) as stable callbacks.
 */
export function useStreamProcessor(config: StreamProcessorConfig) {
  const {
    exitPlanModeSeenRef,
    autoCompactFiredRef,
    silentRestartRef,
    handleSubmitRef,
    handleStderrLineRef,
    lastStderrRef,
    setInputSync,
  } = config;

  /**
   * Handle stream messages for a background (non-active) tab — route to cache.
   */
  const handleBackgroundStreamMessage = useCallback((msg: any, tabId: string) => {
    const store = useChatStore.getState();

    // Update lastProgressAt for stall detection on background tabs — throttled
    // to 1.5s like the foreground path (A4). Every event used to call
    // setSessionMeta, each one copying the tabs Map and notifying all
    // subscribers; with multiple tabs streaming at 10-60Hz that saturated the
    // main thread.
    const now = Date.now();
    const lastPt = _lastProgressThrottle.get(tabId) || 0;
    if (now - lastPt > 1500) {
      _lastProgressThrottle.set(tabId, now);
      store.setSessionMeta(tabId, { lastProgressAt: now });
    }

    switch (msg.type) {
      case 'little_claude_permission_request': {
        // ExitPlanMode: auto-approve in non-plan modes; add plan_review card in plan mode
        if (msg.tool_name === 'ExitPlanMode') {
          const bgMeta = store.getTab(tabId)?.sessionMeta;
          if (getEffectiveMode(bgMeta) !== 'plan') {
            const stdinId = msg.__stdinId;
            if (stdinId) {
              bridge.respondPermission(stdinId, msg.request_id, true, undefined, msg.tool_use_id, msg.input);
            }
            return;
          }
          const bgTab = store.getTab(tabId);
          const bgExisting = bgTab?.messages.find((m) => m.id === 'plan_review_current' && !m.resolved);
          if (!bgExisting) {
            let bgPlanContent = '';
            if (bgTab) {
              for (let i = bgTab.messages.length - 1; i >= 0; i--) {
                if (bgTab.messages[i].role === 'assistant' && bgTab.messages[i].type === 'text' && bgTab.messages[i].content) {
                  bgPlanContent = bgTab.messages[i].content;
                  break;
                }
              }
            }
            store.addMessage(tabId, {
              id: 'plan_review_current',
              role: 'assistant', type: 'plan_review',
              content: bgPlanContent, planContent: bgPlanContent,
              resolved: false, timestamp: Date.now(),
              permissionData: {
                requestId: msg.request_id,
                toolName: msg.tool_name,
                input: msg.input,
                toolUseId: msg.tool_use_id,
              },
            });
          } else {
            store.updateMessage(tabId, 'plan_review_current', {
              permissionData: {
                requestId: msg.request_id,
                toolName: msg.tool_name,
                input: msg.input,
                toolUseId: msg.tool_use_id,
              },
            });
          }
          store.setActivityStatus(tabId, { phase: 'awaiting' });
          return;
        }
        // AskUserQuestion: add question card to tab
        if (msg.tool_name === 'AskUserQuestion') {
          const bgTab = store.getTab(tabId);
          const questionId = msg.tool_use_id || 'ask_question_current';
          const existing = bgTab?.messages.find((m) => m.id === questionId && m.type === 'question')
            || bgTab?.messages.find((m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion');
          if (existing) {
            store.updateMessage(tabId, existing.id, {
              permissionData: {
                requestId: msg.request_id,
                toolName: msg.tool_name,
                input: msg.input,
                toolUseId: msg.tool_use_id,
              },
              toolInput: msg.input,
            });
            return;
          }
          const questions = msg.input?.questions;
          store.addMessage(tabId, {
            id: questionId,
            role: 'assistant', type: 'question',
            content: '', toolName: 'AskUserQuestion',
            toolInput: msg.input,
            questions: Array.isArray(questions) ? questions : [],
            resolved: false, timestamp: Date.now(),
            permissionData: {
              requestId: msg.request_id,
              toolName: msg.tool_name,
              input: msg.input,
              toolUseId: msg.tool_use_id,
            },
          });
          store.setActivityStatus(tabId, { phase: 'awaiting' });
          return;
        }
        // Regular permission: add permission card to tab
        const bgTab = store.getTab(tabId);
        const existingPerm = bgTab?.messages.find(
          (m) => m.type === 'permission'
            && m.permissionData?.requestId === msg.request_id
            && m.interactionState !== 'failed'
        );
        if (existingPerm) return;
        store.addMessage(tabId, {
          id: generateMessageId(),
          role: 'assistant', type: 'permission',
          content: msg.description || `${msg.tool_name} wants to execute`,
          permissionTool: msg.tool_name,
          permissionDescription: msg.description || '',
          timestamp: Date.now(),
          interactionState: 'pending',
          permissionData: {
            requestId: msg.request_id,
            toolName: msg.tool_name,
            input: msg.input,
            description: msg.description,
            toolUseId: msg.tool_use_id,
          },
        });
        store.setActivityStatus(tabId, { phase: 'awaiting' });
        break;
      }
      case 'stream_event': {
        const evt = msg.event;
        if (!evt) break;
        // A4: resolve which agent this event belongs to against the tab's
        // cached snapshot — the live `agents` map belongs to the active tab.
        const bgAgentStore = useAgentStore.getState();
        const bgAgentId = resolveAgentId(msg.parent_tool_use_id, bgAgentStore.agentCache.get(tabId) ?? new Map());
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          // Live token speed (background tabs): same accounting as the
          // foreground path so switching tabs keeps an accurate rate.
          const rawTokens = (evt.delta as { delta_tokens?: number }).delta_tokens;
          const tokenCount = typeof rawTokens === 'number' && rawTokens > 0
            ? rawTokens
            : estimateTokensFromText(text);
          if (tokenCount > 0) {
            useTokenSpeedStore.getState().pushTokens(tabId, tokenCount);
          }
          const stdinId = msg.__stdinId;
          if (text && stdinId) {
            // 报告B2: background tabs used to write the store on every
            // text_delta (10-60Hz), each copying the streams + tabs Maps.
            // Route through the same buffer machinery as the foreground path
            // (rAF cadence; 150ms timer after 8KiB, A7). _doFlush resolves the
            // owner tab itself, so background tabs get identical throttling.
            const buf = _getBuffer(stdinId);
            buf.text += text;
            _scheduleStreamFlush(stdinId);
            // A4: mirror the writing phase into the cached snapshot so the
            // agent tree is up-to-date when the user switches back.
            bgAgentStore.updateAgentsForTab(tabId, (agents) => {
              updatePhaseInSnapshot(agents, bgAgentId, 'writing');
            });
          }
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          // A4: background tabs don't render partial thinking, but the phase
          // matters — the sub-agent is reasoning, not writing.
          if (evt.delta.thinking) {
            bgAgentStore.updateAgentsForTab(tabId, (agents) => {
              updatePhaseInSnapshot(agents, bgAgentId, 'thinking');
            });
          }
        }
        // A4: register sub-agents as soon as their tool_use starts streaming
        // (mirrors the foreground path) so the cached snapshot gains the node
        // and later events resolve to it instead of 'main'.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'Task' || evt.content_block?.name === 'Agent')) {
          const cbId = evt.content_block.id || `task_${Date.now()}`;
          bgAgentStore.updateAgentsForTab(tabId, (agents) => {
            if (!agents.has(cbId)) {
              agents.set(cbId, {
                id: cbId,
                parentId: bgAgentId,
                description: '',
                phase: 'spawning',
                startTime: Date.now(),
                isMain: false,
              });
            }
          });
        }
        // Agent Team tools (TaskCreate, SendMessage): register as visible agents.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'TaskCreate' || evt.content_block?.name === 'SendMessage')) {
          const cbId = evt.content_block.id || `team_${Date.now()}`;
          bgAgentStore.updateAgentsForTab(tabId, (agents) => {
            if (!agents.has(cbId)) {
              agents.set(cbId, {
                id: cbId,
                parentId: bgAgentId,
                description: '',
                phase: 'tool',
                startTime: Date.now(),
                isMain: false,
              });
            }
          });
        }
        // Early detection: create plan_review card for background tab (Plan mode only).
        // Bypass auto-approves via Rust backend — no UI card needed.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && evt.content_block?.name === 'ExitPlanMode'
            && getEffectiveMode(store.getTab(tabId)?.sessionMeta) === 'plan') {
          const bgTab = store.getTab(tabId);
          const bgExisting = bgTab?.messages.find((m) => m.id === 'plan_review_current');
          if (!bgExisting || !bgExisting.resolved) {
            let bgPlanContent = '';
            if (bgTab) {
              for (let i = bgTab.messages.length - 1; i >= 0; i--) {
                const m = bgTab.messages[i];
                // B9: runtime narrowing of the any-typed toolInput — only a
                // string content is usable as plan text.
                if (m.type === 'tool_use' && m.toolName === 'Write'
                    && typeof m.toolInput?.content === 'string' && m.toolInput.content) {
                  bgPlanContent = m.toolInput.content;
                  break;
                }
              }
            }
            store.addMessage(tabId, {
              id: 'plan_review_current',
              role: 'assistant', type: 'plan_review',
              content: bgPlanContent, planContent: bgPlanContent,
              resolved: false, timestamp: Date.now(),
            });
            store.setActivityStatus(tabId, { phase: 'awaiting' });
          }
        }
        // New assistant turn begins (background tab) — reset the speed badge too
        if (evt.type === 'message_start') {
          useTokenSpeedStore.getState().reset(tabId);
        }

        // Track tokens in background sessions (per-turn + cumulative total)
        if (evt.type === 'message_start' && evt.message?.usage?.input_tokens) {
          const bgTab = store.getTab(tabId);
          const delta = evt.message.usage.input_tokens;
          store.setSessionMeta(tabId, {
            inputTokens: (bgTab?.sessionMeta.inputTokens || 0) + delta,
            totalInputTokens: (bgTab?.sessionMeta.totalInputTokens || 0) + delta,
          });
        }
        if (evt.type === 'message_delta' && evt.usage?.output_tokens) {
          const bgTab = store.getTab(tabId);
          const delta = evt.usage.output_tokens;
          store.setSessionMeta(tabId, {
            outputTokens: (bgTab?.sessionMeta.outputTokens || 0) + delta,
            totalOutputTokens: (bgTab?.sessionMeta.totalOutputTokens || 0) + delta,
          });
        }
        break;
      }
      case 'assistant': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;
        // Selectively clear streaming state — only wipe partialText if a text
        // block is present (which supersedes streaming text). Otherwise, preserve
        // it to avoid intermediate thinking-only messages destroying streaming
        // text or emptying partialThinking (the fill/empty jitter + detach
        // trigger that affects the foreground path).
        const bgHasTextBlock = content.some((b: any) => b.type === 'text' && b.text);
        if (bgHasTextBlock) {
          // 报告B2 复查: flush the buffered tail BEFORE clearing, mirroring
          // the foreground clearPartial() (flush then reset). Without this, a
          // rAF/interval flush landing after the reset re-appends the tail
          // into partialText — a ghost partial bubble on the background tab;
          // if it lands after `result`, the flush even recreates the streams
          // entry with isStreaming:true.
          flushStreamBuffer(msg.__stdinId);
          const newStreams = new Map(store.streams);
          newStreams.set(tabId, {
            partialText: '',
            partialThinking: '',
            isStreaming: false,
          });
          useChatStore.setState({ streams: newStreams });
        }
        // B10: background tabs never reached the foreground pendingCmd
        // completion at the assistant case — a slash command processing card
        // started on a background tab stayed "running" forever. Mark it
        // completed here, mirroring the foreground assistant case.
        const bgPendingCmd = store.getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (bgPendingCmd) {
          store.updateMessage(tabId, bgPendingCmd, {
            commandCompleted: true,
            commandData: {
              ...(store.getTab(tabId)?.messages ?? []).find((m) => m.id === bgPendingCmd)?.commandData,
              completedAt: Date.now(),
            },
          });
          store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }
        // Skip text blocks when AskUserQuestion is present — the
        // interactive question UI makes them redundant.
        const bgHasAskUserQuestion = content.some(
          (b: any) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
        );
        // Collect and batch-add all new messages in a single set()
        const bgNewMessages: ChatMessage[] = [];
        for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
          const block = content[blockIdx];
          if (block.type === 'text') {
            if (bgHasAskUserQuestion) continue;
            const textId = msg.uuid ? `${msg.uuid}_text_${blockIdx}` : generateMessageId();
            bgNewMessages.push({
              id: textId,
              role: 'assistant', type: 'text',
              content: block.text, timestamp: Date.now(),
            });
          } else if (block.type === 'tool_use') {
            // A4: enrich the cached snapshot with the tool_use description —
            // the stream_event start only registered an empty stub.
            if (block.name === 'Task' || block.name === 'Agent'
                || block.name === 'TaskCreate' || block.name === 'SendMessage') {
              const bgDesc = block.input?.description || block.input?.prompt
                || block.input?.subject || block.input?.recipient || '';
              if (bgDesc) {
                useAgentStore.getState().updateAgentsForTab(tabId, (agents) => {
                  const node = agents.get(block.id || '');
                  if (node && node.description !== bgDesc) {
                    agents.set(node.id, { ...node, description: bgDesc });
                  }
                });
              }
            }
            // Code mode: suppress EnterPlanMode/ExitPlanMode (transparent to user)
            if (getEffectiveMode(store.getTab(tabId)?.sessionMeta) === 'code'
                && (block.name === 'EnterPlanMode' || block.name === 'ExitPlanMode')) {
              // H2: record in THIS tab's slot — never the shared flag, so a
              // background session's ExitPlanMode can't auto-restart the
              // foreground tab's conversation.
              if (block.name === 'ExitPlanMode') _getExitPlanMap(exitPlanModeSeenRef)[tabId] = true;
              continue;
            }
            if (block.name === 'AskUserQuestion') {
              const questions = block.input?.questions;
              const bgQuestionId = block.id || generateMessageId();
              // Guard: skip if question already exists in background tab (resolved or not)
              const bgSnap = store.getTab(tabId);
              const bgExisting = bgSnap?.messages.find(
                (m) => m.id === bgQuestionId && m.type === 'question',
              );
              if (bgExisting) break;

              bgNewMessages.push({
                id: bgQuestionId,
                role: 'assistant', type: 'question',
                content: '', toolName: block.name,
                toolInput: block.input,
                questions: Array.isArray(questions) ? questions : [],
                resolved: false, timestamp: Date.now(),
              });
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              bgNewMessages.push({
                id: block.id || generateMessageId(),
                role: 'assistant', type: 'todo',
                content: '', toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                timestamp: Date.now(),
              });
            } else if (block.name === 'ExitPlanMode') {
              // Show as regular tool_use in plan/bypass modes
              bgNewMessages.push({
                id: block.id || generateMessageId(),
                role: 'assistant', type: 'tool_use',
                content: '', toolName: block.name,
                toolInput: block.input, timestamp: Date.now(),
              });
              // Only create plan_review card in Plan mode.
              // Bypass auto-approves via Rust backend — no UI card needed.
              if (getEffectiveMode(store.getTab(tabId)?.sessionMeta) === 'plan') {
                const bgSnap2 = store.getTab(tabId);
                let bgPlanContent = '';
                if (bgSnap2) {
                  for (let i = bgSnap2.messages.length - 1; i >= 0; i--) {
                    const m = bgSnap2.messages[i];
                    if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                      bgPlanContent = m.toolInput.content;
                      break;
                    }
                  }
                }
                const bgToolExists = block.id && bgSnap2?.messages.some(
                  (m) => m.id === block.id && m.toolName === 'ExitPlanMode',
                );
                const bgResolvedReview = bgSnap2?.messages.find(
                  (m) => m.type === 'plan_review' && m.resolved,
                );
                if (!(bgToolExists && bgResolvedReview)) {
                  bgNewMessages.push({
                    id: 'plan_review_current',
                    role: 'assistant', type: 'plan_review',
                    content: bgPlanContent, planContent: bgPlanContent,
                    resolved: false, timestamp: Date.now(),
                  });
                  store.setActivityStatus(tabId, { phase: 'awaiting' });
                }
              }
            } else {
              bgNewMessages.push({
                id: block.id || generateMessageId(),
                role: 'assistant', type: 'tool_use',
                content: '', toolName: block.name,
                toolInput: block.input, timestamp: Date.now(),
              });
            }
          }
        }
        if (bgNewMessages.length > 0) {
          store.batchAddMessages(tabId, bgNewMessages);
        }
        break;
      }
      case 'user':
      case 'human': {
        const userContent = msg.message?.content;
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              const resultText = Array.isArray(block.content)
                ? block.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
                : typeof block.content === 'string' ? block.content : '';
              if (block.tool_use_id && resultText) {
                store.updateMessage(tabId, block.tool_use_id, { toolResultContent: capToolResult(resultText) });
              }
            }
          }
        }
        break;
      }
      case 'tool_result': {
        const resultContent = Array.isArray(msg.content)
          ? msg.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
          : typeof msg.content === 'string' ? msg.content : msg.output || '';
        if (msg.tool_use_id) {
          // Backfill AskUserQuestion type/questions in background tab
          const bgTab = store.getTab(tabId);
          const parentMsg = bgTab?.messages.find((m) => m.id === msg.tool_use_id);
          const bgUpdates: Partial<ChatMessage> = { toolResultContent: capToolResult(resultContent) };
          if (parentMsg?.toolName === 'AskUserQuestion') {
            if (parentMsg.type !== 'question') {
              bgUpdates.type = 'question';
              bgUpdates.resolved = false;
            }
            if (!parentMsg.questions || parentMsg.questions.length === 0) {
              const qs = parentMsg.toolInput?.questions;
              if (Array.isArray(qs) && qs.length > 0) {
                bgUpdates.questions = qs;
              }
            }
          }
          store.updateMessage(tabId, msg.tool_use_id, bgUpdates);
          // Auto-refresh file tree when file-mutating tools complete
          _maybeRefreshFileTree(tabId, msg.tool_use_id, msg.tool_name);
        }
        break;
      }
      case 'result': {
        store.setSessionStatus(tabId, msg.subtype === 'success' ? 'completed' : 'error');
        // B10: complete a pending slash-command card on the background path —
        // same as the foreground result case, so /compact etc. don't hang.
        {
          const bgPendingCmd = store.getTab(tabId)?.sessionMeta.pendingCommandMsgId;
          if (bgPendingCmd) {
            const resultOutput = typeof msg.result === 'string' ? msg.result : '';
            store.updateMessage(tabId, bgPendingCmd, {
              commandCompleted: true,
              commandData: {
                ...(store.getTab(tabId)?.messages ?? []).find((m) => m.id === bgPendingCmd)?.commandData,
                output: resultOutput,
                completedAt: Date.now(),
              },
            });
            store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
          }
        }
        {
          const bgTab = store.getTab(tabId);
          const prevMeta = bgTab?.sessionMeta;
          const resultInput = msg.usage?.input_tokens || 0;
          const resultOutput = msg.usage?.output_tokens || 0;
          const streamedInput = prevMeta?.inputTokens || 0;
          const streamedOutput = prevMeta?.outputTokens || 0;
          store.setSessionMeta(tabId, {
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            turns: msg.num_turns,
            inputTokens: resultInput,
            outputTokens: resultOutput,
            totalInputTokens: (prevMeta?.totalInputTokens || 0) + (resultInput - streamedInput),
            totalOutputTokens: (prevMeta?.totalOutputTokens || 0) + (resultOutput - streamedOutput),
            turnStartTime: undefined,
            lastProgressAt: undefined,
          });
          // Turn finished — pin the API-authoritative average on the speed
          // badge (pure API time — local tool waits excluded).
          useTokenSpeedStore.getState().end(tabId, resolveApiSpeed(msg));
          // TK-FIX: persist authoritative token counts to Little Claude's usage log so
          // get_profile_stats reads correct values even when the Claude CLI writes
          // zero/missing usage to its JSONL. msg.uuid matches the JSONL value.uuid
          // dedup key used by get_profile_stats.
          persistTurnUsage(
            prevMeta?.sessionId || '',
            msg.uuid || '',
            msg.usage,
            prevMeta?.model || '',
          );
        }
        if (typeof msg.result === 'string' && msg.result) {
          // Only add if not already delivered via 'assistant' event
          const bgTab = store.getTab(tabId);
          const bgIsDuplicate = bgTab?.messages.some(
            (m) => m.role === 'assistant' && m.type === 'text'
              && m.content === msg.result,
          );
          if (!bgIsDuplicate) {
            store.addMessage(tabId, {
              id: msg.uuid || generateMessageId(),
              role: 'assistant', type: 'text',
              content: msg.result, timestamp: Date.now(),
            });
          }
        }
        // FIFO drain for background tabs (#142/#70): same logic as foreground.
        {
          const bgDrainTab = store.getTab(tabId);
          const bgNextMsg = store.shiftPendingMessage(tabId);
          const bgFlushStdinId = bgDrainTab?.sessionMeta.stdinId;
          if (bgNextMsg && bgFlushStdinId) {
            store.setSessionStatus(tabId, 'running');
            store.setSessionMeta(tabId, { turnStartTime: Date.now(), lastProgressAt: Date.now(), inputTokens: 0, outputTokens: 0 });
            store.setActivityStatus(tabId, { phase: 'thinking' });
            bridge.sendStdin(bgFlushStdinId, bgNextMsg).catch((err) => {
              console.error('[TC:bg] Failed to send pending message:', err);
              const bgRemaining = store.getTab(tabId)?.pendingUserMessages ?? [];
              const bgAllFailed = [bgNextMsg, ...bgRemaining];
              const bgDraft = store.getTab(tabId)?.inputDraft ?? '';
              const bgFailedText = bgAllFailed.join('\n\n');
              store.setInputDraft(tabId, bgDraft ? `${bgDraft}\n\n${bgFailedText}` : bgFailedText);
              store.clearPendingMessages(tabId);
              store.setSessionStatus(tabId, 'error');
            });
          }
        }

        useSessionStore.getState().fetchSessions();

        // AI Title Generation for background tabs (same 3rd-turn logic)
        if (msg.subtype === 'success') {
          const customPreviews = useSessionStore.getState().customPreviews;
          if (!customPreviews[tabId]) {
            const bgTab = store.getTab(tabId);
            const bgUserMsgs = bgTab?.messages.filter(
              (m) => m.role === 'user' && m.type === 'text' && m.content,
            ) || [];
            const bgAssistantMsgs = bgTab?.messages.filter(
              (m) => m.role === 'assistant' && m.type === 'text' && m.content,
            ) || [];
            if (bgUserMsgs.length >= 3 && bgAssistantMsgs.length >= 3) {
              const userMsg = bgUserMsgs.map((m) => m.content).join('\n').slice(0, 500);
              const assistantMsg = bgAssistantMsgs.map((m) => m.content).join('\n').slice(0, 500);
              bridge.generateSessionTitle(userMsg, assistantMsg,
                useProviderStore.getState().getActiveIdForBackend(
                  useSettingsStore.getState().cliBackend || 'claude') || undefined)
                .then((title) => {
                  if (title) {
                    useSessionStore.getState().setCustomPreview(tabId, title);
                  }
                })
                .catch((e) => {
                  // Silently ignore SKIP errors (e.g. no haiku mapping for provider)
                  if (!String(e).includes('SKIP:')) console.warn('Title gen failed:', e);
                });
            }
          }
        }
        break;
      }
      case 'rate_limit_event': {
        const bgRli = msg.rate_limit_info;
        if (bgRli && bgRli.rateLimitType) {
          const bgTab = store.getTab(tabId);
          const prevLimits = bgTab?.sessionMeta?.rateLimits || {};
          store.setSessionMeta(tabId, {
            rateLimits: {
              ...prevLimits,
              [bgRli.rateLimitType]: {
                rateLimitType: bgRli.rateLimitType,
                resetsAt: bgRli.resetsAt,
                isUsingOverage: bgRli.isUsingOverage,
                overageStatus: bgRli.overageStatus,
                overageDisabledReason: bgRli.overageDisabledReason,
              },
            },
          });
        }
        break;
      }
      case 'process_exit': {
        // H1: stale-exit ownership guard — same hazard as the foreground
        // branch: a background tab whose process was killed and replaced may
        // still deliver the OLD process's process_exit late (after the new
        // stdinId is in sessionMeta). Guard before touching any tab state.
        const bgStdinId = msg.__stdinId as string | undefined;
        const bgCurTab = store.getTab(tabId);
        const bgCurStdinId = bgCurTab?.sessionMeta.stdinId;
        const bgIsStaleExit = !!bgStdinId
          && bgStdinId !== bgCurStdinId
          && (bgCurStdinId !== undefined || bgCurTab?.sessionStatus === 'running');
        if (bgIsStaleExit) {
          // Old-process cleanup ONLY — leave the replacement session's status,
          // stdinId, pending messages and draft untouched.
          flushStreamBuffer(bgStdinId);
          cleanupStreamListener(bgStdinId);
          useSessionStore.getState().unregisterStdinTab(bgStdinId);
          break;
        }

        // Flush any remaining stream buffer before cleanup (#64)
        flushStreamBuffer(msg.__stdinId);

        // P0-5: Clean up Tauri event listeners for background tab.
        // __claudeUnlisteners is keyed by stdinId (desk_xxx), NOT tabId (session uuid).
        // Use msg.__stdinId (tagged by the listener closure) to find the correct entry.
        if (bgStdinId) {
          cleanupStreamListener(bgStdinId);
        }
        store.setSessionStatus(tabId, 'idle');
        store.setSessionMeta(tabId, { stdinId: undefined });
        // B10: a background process exit never ran the foreground pendingCmd
        // cleanup — clear any stuck processing card (e.g. /compact killed
        // mid-run) so it can't stay "running" forever.
        {
          const bgExitPendingCmd = store.getTab(tabId)?.sessionMeta.pendingCommandMsgId;
          if (bgExitPendingCmd) {
            store.updateMessage(tabId, bgExitPendingCmd, { commandCompleted: true });
            store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
          }
        }
        // B6: same residual-partial cleanup for background tabs — an exited
        // background session must not leave a frozen partial bubble behind.
        {
          const newStreams = new Map(store.streams);
          newStreams.set(tabId, { partialText: '', partialThinking: '', isStreaming: false });
          useChatStore.setState({ streams: newStreams });
        }
        // Clean up stdinToTab mapping to prevent memory leak
        if (bgStdinId) {
          useSessionStore.getState().unregisterStdinTab(bgStdinId);
        }
        // Drop the per-tab progress throttle entry (session is over)
        _lastProgressThrottle.delete(tabId);
        // A4: mark any still-running agents in the cached snapshot as
        // completed so the tree isn't stale when the user switches back.
        useAgentStore.getState().updateAgentsForTab(tabId, (agents) => {
          for (const [, agent] of agents) {
            if (agent.phase !== 'completed' && agent.phase !== 'error') {
              agents.set(agent.id, { ...agent, phase: 'completed', endTime: Date.now(), currentTool: undefined });
            }
          }
        });
        // Restore pending messages to input draft (#142/#70)
        const bgExitPending = store.getTab(tabId)?.pendingUserMessages ?? [];
        if (bgExitPending.length > 0) {
          const bgExitDraft = store.getTab(tabId)?.inputDraft ?? '';
          const bgPendingText = bgExitPending.join('\n\n');
          store.setInputDraft(tabId, bgExitDraft ? `${bgExitDraft}\n\n${bgPendingText}` : bgPendingText);
          store.clearPendingMessages(tabId);
        }
        // H2: process is gone — drop this tab's ExitPlanMode-seen slot.
        delete _getExitPlanMap(exitPlanModeSeenRef)[tabId];
        useSessionStore.getState().fetchSessions();
        break;
      }
      case 'system':
        if (msg.subtype === 'init') {
          store.setSessionMeta(tabId, { model: msg.model });
        } else if (msg.subtype === 'error') {
          // FI-3: Surface system errors in background tabs too
          store.addMessage(tabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: formatErrorForUser(msg.message || msg.error || 'System error'),
            timestamp: Date.now(),
          });
        }
        break;
    }
  }, [exitPlanModeSeenRef]);

  /**
   * Handle stream messages for the foreground (active) tab.
   */
  const handleStreamMessage = useCallback((msg: any) => {
    if (!msg || !msg.type) return;

    try { // P1-4: error boundary — prevent uncaught exceptions from crashing the stream pipeline

    // Diagnostic: log first message and unrecognized types
    if (msg.type === 'system' || msg.type === 'process_exit') {
      debugLog('stream', msg.type, msg.subtype || '', msg.__stdinId || '');
    }
    if (!KNOWN_STREAM_TYPES.has(msg.type)) {
      console.warn('[LITTLECLAUDE:stream] unhandled message type:', msg.type, msg);
    }

    // --- Background routing: detect if this stream belongs to a non-active tab ---
    // MUST run before little_claude_permission_request and all other handlers
    // to prevent messages from background sessions leaking into the active tab.
    const msgStdinId = msg.__stdinId;
    // F4: resolve + validate the owner (drops stale mappings, self-heals from
    // sessionMeta) so a dead mapping can't silently background-route a live
    // session's entire stream — the "frozen UI" failure mode.
    const ownerTabId = resolveOwnerTab(msgStdinId);
    const activeTabId = useSessionStore.getState().selectedSessionId;
    const isBackground = ownerTabId && ownerTabId !== activeTabId;

    // If stream belongs to a background tab, route key events to cache and return
    if (isBackground) {
      // Diagnostic: log background routing for non-trivial message types
      if (msg.type !== 'stream_event') {
        debugLog('route', 'background:', msg.type, 'owner:', ownerTabId, 'active:', activeTabId);
      }
      handleBackgroundStreamMessage(msg, ownerTabId);
      return;
    }

    // Resolve tabId once for all foreground store calls
    const tabId = ownerTabId || activeTabId;
    if (!tabId) return;

    // A4: Throttle lastProgressAt to at most once per 1.5s per tab.
    // Previously called on every foreground event (50-120/s during streaming),
    // each triggering a tabs Map copy + Zustand subscriber notification.
    const now = Date.now();
    const lastPt = _lastProgressThrottle.get(tabId) || 0;
    if (now - lastPt > 1500) {
      _lastProgressThrottle.set(tabId, now);
      useChatStore.getState().setSessionMeta(tabId, { lastProgressAt: now });
    }

    // --- SDK Permission Request (routed through stream channel for reliability) ---
    if (msg.type === 'little_claude_permission_request') {

      // ExitPlanMode: only show PlanReviewCard in Plan mode.
      // In other modes, auto-approve so the CLI continues without blocking.
      if (msg.tool_name === 'ExitPlanMode') {
        const tabState = useChatStore.getState().getTab(tabId);
        if (getEffectiveMode(tabState?.sessionMeta) !== 'plan') {
          // Auto-approve: CLI doesn't need user confirmation outside Plan mode
          const stdinId = tabState?.sessionMeta.stdinId;
          if (stdinId) {
            bridge.respondPermission(stdinId, msg.request_id, true, undefined, msg.tool_use_id, msg.input);
          }
          return;
        }
        const chatStore = useChatStore.getState();
        const messages = tabState?.messages ?? [];
        const permData = {
          requestId: msg.request_id,
          toolName: msg.tool_name,
          input: msg.input,
          description: msg.description,
          toolUseId: msg.tool_use_id,
        };
        const planReview = messages.find((m) => m.id === 'plan_review_current' && !m.resolved);
        if (planReview) {
          chatStore.updateMessage(tabId, 'plan_review_current', { permissionData: permData });
        } else {
          // PlanReviewCard not yet created — create one with permission data
          let planContent = '';
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant' && messages[i].type === 'text' && messages[i].content) {
              planContent = messages[i].content;
              break;
            }
          }
          chatStore.addMessage(tabId, {
            id: 'plan_review_current',
            role: 'assistant',
            type: 'plan_review',
            content: planContent,
            planContent: planContent,
            resolved: false,
            permissionData: permData,
            timestamp: Date.now(),
          });
          chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
        }
        return;
      }

      // AskUserQuestion: create QuestionCard instead of PermissionCard.
      // User answers are sent back via respondPermission(updatedInput) — NOT sendStdin.
      if (msg.tool_name === 'AskUserQuestion') {
        const chatStore = useChatStore.getState();
        const messages = chatStore.getTab(tabId)?.messages ?? [];
        const questionId = msg.tool_use_id || 'ask_question_current';
        // Search by exact ID first, then fall back to any unresolved AskUserQuestion.
        // This handles the race condition where the assistant message arrives first
        // with block.id (e.g. "toolu_01abc") and the control_request arrives later
        // with a different or missing tool_use_id.
        const existing = messages.find((m) => m.id === questionId && m.type === 'question')
          || messages.find((m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion');
        if (existing) {
          // Patch permissionData so QuestionCard uses respondPermission (SDK path)
          // instead of sendStdin (legacy path). Always update — even if permissionData
          // exists — because a new control_request supersedes a stale one.
          chatStore.updateMessage(tabId, existing.id, {
            permissionData: {
              requestId: msg.request_id,
              toolName: msg.tool_name,
              input: msg.input,
              toolUseId: msg.tool_use_id,
            },
            toolInput: msg.input,
          });
          return;
        }
        const questions = msg.input?.questions;
        chatStore.addMessage(tabId, {
          id: questionId,
          role: 'assistant',
          type: 'question',
          content: '',
          toolName: 'AskUserQuestion',
          toolInput: msg.input,
          questions: Array.isArray(questions) ? questions : [],
          resolved: false,
          timestamp: Date.now(),
          // Attach permission data so QuestionCard uses respondPermission instead of sendStdin
          permissionData: {
            requestId: msg.request_id,
            toolName: msg.tool_name,
            input: msg.input,
            toolUseId: msg.tool_use_id,
          },
        });
        chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
        return;
      }

      // Dedup: skip if we already have a non-failed PermissionCard for this request_id
      const chatStore = useChatStore.getState();
      const messages = chatStore.getTab(tabId)?.messages ?? [];
      const existingPerm = messages.find(
        (m) => m.type === 'permission'
          && m.permissionData?.requestId === msg.request_id
          && m.interactionState !== 'failed'
      );
      if (existingPerm) {
        return;
      }
      chatStore.addMessage(tabId, {
        id: generateMessageId(),
        role: 'assistant',
        type: 'permission',
        content: msg.description || `${msg.tool_name} wants to execute`,
        permissionTool: msg.tool_name,
        permissionDescription: msg.description || '',
        timestamp: Date.now(),
        interactionState: 'pending',
        permissionData: {
          requestId: msg.request_id,
          toolName: msg.tool_name,
          input: msg.input,
          description: msg.description,
          toolUseId: msg.tool_use_id,
        },
      });
      chatStore.setActivityStatus(tabId, { phase: 'awaiting' });
      return;
    }

    const cs = useChatStore.getState();
    const addMessage = (message: ChatMessage) => cs.addMessage(tabId, message);
    const setSessionStatus = (status: import('../stores/chatStore').SessionStatus) => cs.setSessionStatus(tabId, status);
    const setSessionMeta = (meta: Partial<import('../stores/chatStore').SessionMeta>) => cs.setSessionMeta(tabId, meta);
    const setActivityStatus = (status: import('../stores/chatStore').ActivityStatus) => cs.setActivityStatus(tabId, status);
    const agentActions = useAgentStore.getState();
    const agentId = resolveAgentId(msg.parent_tool_use_id, agentActions.agents);
    const agentDepth = getAgentDepth(agentId, agentActions.agents);

    // Capture the CLI's own session ID from stream events (used for --resume)
    const cliSessionId = msg.session_id || msg.sessionId;
    if (cliSessionId) {
      const currentId = useChatStore.getState().getTab(tabId)?.sessionMeta.sessionId;
      if (currentId !== cliSessionId) {
        setSessionMeta({ sessionId: cliSessionId });
        bridge.trackSession(cliSessionId).catch(() => {});

        // Promote draft tab to real session ID so it merges with disk session
        if (tabId.startsWith('draft_')) {
          // Migrate tab data under old draft key to new real key
          const chatState = useChatStore.getState();
          const tabData = chatState.getTab(tabId);
          if (tabData) {
            const newTabs = new Map(chatState.tabs);
            newTabs.set(cliSessionId, { ...tabData, tabId: cliSessionId });
            newTabs.delete(tabId);
            useChatStore.setState({ tabs: newTabs, sessionCache: newTabs });
          }
          useSessionStore.getState().promoteDraft(tabId, cliSessionId);
        }

        useSessionStore.getState().fetchSessions();
      }
    }

    // Helper: clear accumulated partial text (it will be replaced by the full message)
    const clearPartial = () => {
      // L1: flush ONLY this tab's stream buffer. The no-arg flushStreamBuffer()
      // previously wiped every session's buffer, clobbering concurrently
      // streaming tabs' partial text. Prefer the message's own stdinId, then
      // fall back to the tab's current stdinId; skip entirely if neither is
      // available (the buffer is drained by the interval fallback anyway).
      const flushId = msgStdinId || useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
      if (flushId) flushStreamBuffer(flushId);
      // Clear streams (lightweight — no tabs Map copy needed)
      const newStreams = new Map(useChatStore.getState().streams);
      newStreams.set(tabId, { partialText: '', partialThinking: '', isStreaming: false });
      useChatStore.setState({ streams: newStreams });
    };

    switch (msg.type) {
      // --- stream_event: wrapper for real-time streaming events from --include-partial-messages ---
      case 'stream_event': {
        const evt = msg.event;
        if (!evt) break;

        // Diagnostic: log tool_use starts for debugging plan mode flow
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
          debugLog('stream', 'tool_use start:', evt.content_block.name);
        }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text || '';
          // Live token speed: prefer the CLI's delta_tokens, fall back to a
          // text-length estimate (provider proxy / Codex streams carry none).
          const rawTokens = (evt.delta as { delta_tokens?: number }).delta_tokens;
          const tokenCount = typeof rawTokens === 'number' && rawTokens > 0
            ? rawTokens
            : estimateTokensFromText(text);
          if (tokenCount > 0) {
            useTokenSpeedStore.getState().pushTokens(tabId, tokenCount);
          }
          if (text && msgStdinId) {
            // Buffer text and flush via rAF to avoid excessive re-renders
            // TK-329: per-stdinId buffer prevents cross-session contamination
            const buf = _getBuffer(msgStdinId);
            buf.text += text;
            _scheduleStreamFlush(msgStdinId);
            agentActions.updatePhase(agentId, 'writing');
          }
        } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
          const thinkingText = evt.delta.thinking || '';
          if (thinkingText && msgStdinId) {
            const buf = _getBuffer(msgStdinId);
            buf.thinking += thinkingText;
            _scheduleStreamFlush(msgStdinId);
            agentActions.updatePhase(agentId, 'thinking');
          } else {
            setActivityStatus({ phase: 'thinking' });
            agentActions.updatePhase(agentId, 'thinking');
          }
        }

        // Early agent creation: register sub-agent as soon as Agent/Task tool_use
        // starts streaming, so subsequent events resolve to the correct agent.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'Task' || evt.content_block?.name === 'Agent')) {
          agentActions.upsertAgent({
            id: evt.content_block.id || `task_${Date.now()}`,
            parentId: agentId,
            description: '',
            phase: 'spawning',
            startTime: Date.now(),
            isMain: false,
          });
        }
        // Agent Team tools (TaskCreate, SendMessage): register as visible agents
        // so the agent panel shows team activity. These run in separate CLI processes
        // so we won't get real-time progress, but visibility is the goal.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && (evt.content_block?.name === 'TaskCreate' || evt.content_block?.name === 'SendMessage')) {
          agentActions.upsertAgent({
            id: evt.content_block.id || `team_${Date.now()}`,
            parentId: agentId,
            description: '',
            phase: 'tool',
            startTime: Date.now(),
            isMain: false,
          });
        }
        // Early detection: create plan_review card ONLY in explicit Plan mode.
        // In Code mode the CLI handles ExitPlanMode natively.
        // In Bypass mode the Rust backend auto-approves — no UI card needed.
        if (evt.type === 'content_block_start'
            && evt.content_block?.type === 'tool_use'
            && evt.content_block?.name === 'ExitPlanMode'
            && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
          const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

          // Guard: if plan_review_current already exists and was resolved,
          // this is a replay after plan approval — don't create a new card.
          const existingReview = currentMessages.find((m) => m.id === 'plan_review_current');
          if (!existingReview || !existingReview.resolved) {
            let planContent = '';
            for (let i = currentMessages.length - 1; i >= 0; i--) {
              const m = currentMessages[i];
              if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                planContent = m.toolInput.content;
                break;
              }
            }

            addMessage({
              id: 'plan_review_current',
              role: 'assistant',
              type: 'plan_review',
              content: planContent,
              planContent: planContent,
              resolved: false,
              timestamp: Date.now(),
            });
            setActivityStatus({ phase: 'awaiting' });
          }
        }

        // New assistant turn begins — reset the token speed badge so the
        // pinned average clears before this turn's tokens start counting.
        if (evt.type === 'message_start') {
          useTokenSpeedStore.getState().reset(tabId);
        }

        // Track input tokens from message_start (per-turn + cumulative total)
        if (evt.type === 'message_start' && evt.message?.usage?.input_tokens) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const delta = evt.message.usage.input_tokens;
          setSessionMeta({
            inputTokens: (meta.inputTokens || 0) + delta,
            totalInputTokens: (meta.totalInputTokens || 0) + delta,
          });
        }

        // Track output tokens from message_delta (per-turn + cumulative total)
        if (evt.type === 'message_delta' && evt.usage?.output_tokens) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const delta = evt.usage.output_tokens;
          setSessionMeta({
            outputTokens: (meta.outputTokens || 0) + delta,
            totalOutputTokens: (meta.totalOutputTokens || 0) + delta,
          });
        }
        break;
      }

      case 'system':
        if (msg.subtype === 'init') {
          setSessionMeta({ model: msg.model });
        } else if (msg.subtype === 'error') {
          // FI-3: Surface system-level errors instead of silently dropping them
          const rawError = msg.message || msg.error || 'System error';
          addMessage({
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: formatErrorForUser(rawError),
            timestamp: Date.now(),
          });
          // Sync error status to ActivityIndicator so user sees real-time feedback
          setActivityStatus({ phase: 'error', statusMessage: t('chat.connectionLost') });
        } else {
          // FI-3: Log unknown subtypes so we know what we're missing
          console.warn('[LITTLECLAUDE] Unhandled system subtype:', msg.subtype, msg);
        }
        break;

      case 'assistant': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) break;

        // With --include-partial-messages, intermediate assistant messages arrive
        // frequently. We must NOT aggressively wipe streaming text state when the
        // message only contains a thinking block (no text block yet).
        const hasTextBlock = content.some((b: any) => b.type === 'text' && b.text);

        // Thinking blocks carried by this message. Materialized to the
        // transcript below (deduped) — deliberately NOT gated on stop_reason:
        // providers differ in how they deliver thinking. Anthropic-native
        // streams emit thinking_delta + partial messages (stop_reason=null);
        // OpenAI-compatible proxies (e.g. DeepSeek) deliver each thinking
        // block as its own COMPLETE assistant message with no streaming
        // deltas. Gating on stop_reason made thinking vanish for the latter.
        const thinkingBlocks = content.filter(
          (b: any) => b.type === 'thinking' && b.thinking,
        );

        if (hasTextBlock) {
          // Full clear — the text block supersedes streaming partial text.
          // Applies to intermediate messages too: the formal text message is
          // updated in place (uuid-keyed dedup), so leaving partialText up
          // would render the same text twice (list message + Footer). Safe
          // for partialThinking as well — thinking blocks precede text
          // blocks, so text means thinking is over.
          clearPartial();
        }
        // NOTE: partialThinking (the live Footer "thinking" panel) is driven
        // ONLY by thinking_delta streaming events. We deliberately do NOT set
        // it from these message blocks: doing so made the panel flash on/off
        // as discrete thinking messages arrived and were then superseded by
        // text. Thinking reaches the transcript via the ThinkingMsg bubbles
        // materialized below — those persist instead of flashing, and match
        // what session-loader reconstructs on reload (one bubble per block).

        // If there's a pending slash command processing card, mark it as
        // completed now — the assistant response means the CLI has responded.
        // Some commands (e.g. /compact) may not emit a 'result' event.
        const pendingCmd = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (pendingCmd) {
          useChatStore.getState().updateMessage(tabId, pendingCmd, {
            commandCompleted: true,
            commandData: {
              ...(useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmd)?.commandData,
              completedAt: Date.now(),
            },
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // If this message contains AskUserQuestion, skip text blocks —
        // the interactive question UI makes them redundant and avoids
        // showing raw question descriptions alongside the rich UI.
        const hasAskUserQuestion = content.some(
          (b: any) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
        );

        // Collect all new messages and batch-add in a single set() call
        const newMessages: ChatMessage[] = [];

        // Materialize thinking blocks to the transcript. Runs for EVERY
        // assistant message (partial or final) so thinking is recorded
        // regardless of how the provider signals completion. Deduped against
        // re-delivery: with --include-partial-messages a thinking block is
        // re-emitted as it grows, each time under a FRESH uuid — pushing per
        // message would spawn duplicate "thinking" bubbles (the original
        // flicker). So we match the most recent ThinkingMsg in THIS turn by
        // content prefix:
        //   · identical content      → exact re-delivery, skip
        //   · new extends previous   → same block grew, update in place
        //   · previous extends new   → stale/shorter re-delivery, skip
        //   · otherwise              → genuinely new thought, add a bubble
        // Added via addMessage (immediate) BEFORE the batch loop so thinking
        // bubbles precede this message's text/tool_use — matching the order
        // session-loader produces on reload (one collapsed bubble per block).
        for (const tblock of thinkingBlocks) {
          const thinkingText: string = tblock.thinking;
          const curMsgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
          let lastThinking: ChatMessage | undefined;
          for (let i = curMsgs.length - 1; i >= 0; i--) {
            if (curMsgs[i].role === 'user') break; // stay within this turn
            if (curMsgs[i].type === 'thinking') { lastThinking = curMsgs[i]; break; }
          }
          if (lastThinking && lastThinking.content === thinkingText) continue;
          if (lastThinking && thinkingText.startsWith(lastThinking.content)) {
            // Same block, grown — update the existing bubble in place.
            useChatStore.getState().updateMessage(tabId, lastThinking.id, { content: thinkingText });
            continue;
          }
          if (lastThinking && lastThinking.content.startsWith(thinkingText)) continue;
          addMessage({
            id: generateMessageId(),
            role: 'assistant',
            type: 'thinking',
            content: thinkingText,
            subAgentDepth: agentDepth,
            timestamp: Date.now(),
          });
        }

        for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
          const block = content[blockIdx];
          if (block.type === 'text') {
            if (hasAskUserQuestion) continue;
            setActivityStatus({ phase: 'writing' });
            agentActions.updatePhase(agentId, 'writing');
            // Use msg.uuid + block index as stable ID so re-delivered
            // messages de-duplicate correctly in the store.
            const textId = msg.uuid ? `${msg.uuid}_text_${blockIdx}` : generateMessageId();
            newMessages.push({
              id: textId,
              role: 'assistant',
              type: 'text',
              content: block.text,
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          } else if (block.type === 'tool_use') {
            // Code mode: EnterPlanMode/ExitPlanMode are transparent — CLI handles internally.
            // Don't show tool cards; track ExitPlanMode for auto-restart if CLI exits.
            if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
                && (block.name === 'EnterPlanMode' || block.name === 'ExitPlanMode')) {
              // H2: per-tab slot (see _getExitPlanMap) — the restart check
              // reads only THIS tab's flag.
              if (block.name === 'ExitPlanMode') _getExitPlanMap(exitPlanModeSeenRef)[tabId] = true;
              continue;
            }
            setActivityStatus({ phase: 'tool', toolName: block.name });
            if (block.name === 'Task' || block.name === 'Agent') {
              agentActions.upsertAgent({
                id: block.id || generateMessageId(),
                parentId: agentId,
                description: block.input?.description || block.input?.prompt || '',
                phase: 'spawning',
                startTime: Date.now(),
                isMain: false,
              });
            } else if (block.name === 'TaskCreate' || block.name === 'SendMessage') {
              // Agent Team tasks/messages: register as visible agents in the tree.
              // These run in separate CLI processes so we won't get progress events,
              // but showing them makes the team activity visible in the agent panel.
              agentActions.upsertAgent({
                id: block.id || `team_${Date.now()}`,
                parentId: agentId,
                description: block.input?.subject || block.input?.description || block.input?.recipient || '',
                phase: 'tool',
                startTime: Date.now(),
                isMain: false,
              });
            } else {
              agentActions.updatePhase(agentId, 'tool', block.name);
            }

            if (block.name === 'AskUserQuestion') {
              // Use a stable sentinel ID so re-delivered blocks de-duplicate
              // instead of creating duplicate question cards (TK-103).
              const questionId = block.id || 'ask_question_current';

              // Guard: skip if question already exists (resolved or not).
              // Search by exact ID first, then by any AskUserQuestion card —
              // the control_request handler may have already created one with
              // a different ID (e.g. 'ask_question_current' vs 'toolu_01abc').
              const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
              const existingQuestion = currentMessages.find(
                (m) => m.id === questionId && m.type === 'question',
              ) || currentMessages.find(
                (m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion',
              );
              if (existingQuestion) {
                // Already exists — just ensure awaiting state if unresolved
                if (!existingQuestion.resolved) {
                  setActivityStatus({ phase: 'awaiting' });
                }
                break;
              }

              const questions = block.input?.questions;
              newMessages.push({
                id: questionId,
                role: 'assistant',
                type: 'question',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                questions: Array.isArray(questions) ? questions : [],
                resolved: false,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });
              // Mark as awaiting user input (consistent with ExitPlanMode)
              setActivityStatus({ phase: 'awaiting' });
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              newMessages.push({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'todo',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });
            } else if (block.name === 'ExitPlanMode') {
              // Show ExitPlanMode as a collapsible tool_use (like other tools)
              newMessages.push({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });

              // Only create plan_review card in Plan mode.
              // In Code mode the CLI handles ExitPlanMode natively.
              // In Bypass mode the Rust backend auto-approves — no UI card needed.
              if (getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'plan') {
                const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);

                // Guard: skip if already approved (replay)
                const toolAlreadyExisted = block.id && currentMessages.some(
                  (m) => m.id === block.id && m.toolName === 'ExitPlanMode',
                );
                const existingReview = currentMessages.find(
                  (m) => m.type === 'plan_review' && m.resolved,
                );
                if (!(toolAlreadyExisted && existingReview)) {
                  let planContent = '';
                  for (let i = currentMessages.length - 1; i >= 0; i--) {
                    const m = currentMessages[i];
                    if (m.type === 'tool_use' && m.toolName === 'Write' && m.toolInput?.content) {
                      planContent = m.toolInput.content;
                      break;
                    }
                  }

                  newMessages.push({
                    id: 'plan_review_current',
                    role: 'assistant',
                    type: 'plan_review',
                    content: planContent,
                    planContent: planContent,
                    resolved: false,
                    timestamp: Date.now(),
                  });
                  setActivityStatus({ phase: 'awaiting' });
                }
              }
            } else {
              newMessages.push({
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                subAgentDepth: agentDepth,
                timestamp: Date.now(),
              });

            }
          } else if (block.type === 'thinking') {
            // Thinking blocks are materialized to the transcript ABOVE the
            // block loop (deduped by content prefix, one bubble per block).
            // Here we only advance the agent phase. DON'T override
            // activityStatus: if text is currently streaming the phase should
            // remain 'writing' — the streaming events (thinking_delta,
            // text_delta) are the source of truth for activity phase.
            agentActions.updatePhase(agentId, 'thinking');
          }
        }

        // Batch-commit all new messages in a single set()
        if (newMessages.length > 0) {
          useChatStore.getState().batchAddMessages(tabId, newMessages);
        }

        // NOTE: No save/restore hack needed here. addMessage no longer clears
        // partialText/isStreaming as a side effect (TK-322 fix), so intermediate
        // assistant messages with only thinking/tool_use blocks won't wipe
        // streaming text state.
        break;
      }

      case 'user':
      case 'human': {
        // Store CLI checkpoint UUID on the most recent user message (for rewind).
        // Only store from genuine user-input messages, NOT tool-result messages.
        // Tool-result user messages have content with tool_result blocks and their
        // UUIDs don't match the file-history-snapshot messageId used by --rewind-files.
        {
          const content = msg.message?.content;
          const isToolResult = Array.isArray(content)
            && content.some((b: any) => b.type === 'tool_result');
          if (msg.uuid && !isToolResult) {
            const allMsgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
            for (let i = allMsgs.length - 1; i >= 0; i--) {
              if (allMsgs[i].role === 'user') {
                debugLog('stream', 'Storing checkpointUuid:', msg.uuid, 'on msg:', allMsgs[i].id);
                useChatStore.getState().updateMessage(tabId, allMsgs[i].id, { checkpointUuid: msg.uuid });
                break;
              }
            }
          }
        }

        const userContent = msg.message?.content;
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              const resultText = Array.isArray(block.content)
                ? block.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
                : typeof block.content === 'string'
                  ? block.content
                  : '';
              const tuId = block.tool_use_id;
              if (tuId && resultText) {
                const msgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
                const parent = msgs.find((m) => m.id === tuId);
                if (parent) {
                  useChatStore.getState().updateMessage(tabId, tuId, { toolResultContent: capToolResult(resultText) });
                }
              }
            }
          }
        }
        if (msg.tool_use_result) {
          const tur = msg.tool_use_result;
          const resultText = typeof tur === 'string' ? tur
            : typeof tur.stdout === 'string' ? tur.stdout
            : typeof tur.content === 'string' ? tur.content
            : Array.isArray(tur.content) ? tur.content.map((b: any) => typeof b.text === 'string' ? b.text : '').join('')
            : typeof tur.content === 'object' && tur.content?.text ? String(tur.content.text)
            : '';
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.tool_use_id && resultText) {
                const msgs = useChatStore.getState().getTab(tabId)?.messages ?? [];
                const parent = msgs.find((m) => m.id === block.tool_use_id);
                if (parent) {
                  useChatStore.getState().updateMessage(tabId, block.tool_use_id, { toolResultContent: capToolResult(resultText) });
                }
              }
            }
          }
        }
        break;
      }

      case 'tool_result': {
        const resultContent = Array.isArray(msg.content)
          ? msg.content.map((b: any) => typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '').join('')
          : typeof msg.content === 'string'
            ? msg.content
            : msg.output || '';

        const toolUseId = msg.tool_use_id;
        // Auto-refresh file tree when file-mutating tools complete
        _maybeRefreshFileTree(tabId, toolUseId, msg.tool_name);

        if (toolUseId) {
          // Complete Agent Team sub-agents when their tool result arrives.
          // Runs BEFORE the parentMsg lookup below: the tool_use message almost
          // always exists (same id), so the lookup's break would otherwise skip
          // this completion and leave the sub-agent stuck on 'tool' forever.
          if (agentActions.agents.has(toolUseId)) {
            agentActions.completeAgent(toolUseId, 'completed');
          }
          const currentMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
          const parentMsg = currentMessages.find((m) => m.id === toolUseId);
          if (parentMsg) {
            const updates: Partial<ChatMessage> = { toolResultContent: capToolResult(resultContent) };

            // Backfill: if parent is AskUserQuestion created with empty questions
            // (due to streaming), or was mis-typed as tool_use, fix it now.
            if (parentMsg.toolName === 'AskUserQuestion') {
              if (parentMsg.type !== 'question') {
                updates.type = 'question';
                updates.resolved = false;
              }
              if (!parentMsg.questions || parentMsg.questions.length === 0) {
                // Try to extract questions from toolInput (may have been populated
                // by a later assistant message with complete content)
                const qs = parentMsg.toolInput?.questions;
                if (Array.isArray(qs) && qs.length > 0) {
                  updates.questions = qs;
                }
              }
            }

            useChatStore.getState().updateMessage(tabId, toolUseId, updates);
            break;
          }
        }
        addMessage({
          id: msg.uuid || generateMessageId(),
          role: 'assistant',
          type: 'tool_result',
          // 报告B9 复查: this orphan-result fallback path wrote `content`
          // uncapped — the 6th write site (not a toolResultContent field, so
          // the original sweep missed it). Cap it like the 5 main sites.
          content: capToolResult(resultContent),
          toolName: msg.tool_name,
          subAgentDepth: agentDepth,
          timestamp: Date.now(),
        });
        break;
      }

      case 'tool_use_summary':
        break;

      case 'result': {

        // Sub-agent results carry parent_tool_use_id — they must NOT terminate the
        // main session. Only the main agent's result (no parent_tool_use_id) ends the
        // session. Without this guard, the first parallel sub-agent to complete would
        // call setSessionStatus('completed') and freeze the UI mid-run.
        if (msg.parent_tool_use_id) {
          // Only complete the sub-agent if it was actually registered. Falling
          // back to 'main' (via resolveAgentId) could green-light the main agent
          // while it is still working.
          if (agentActions.agents.has(msg.parent_tool_use_id)) {
            agentActions.completeAgent(
              msg.parent_tool_use_id,
              msg.subtype === 'success' ? 'completed' : 'error',
            );
          }
          break;
        }

        // Clear any remaining partial text before marking turn complete
        clearPartial();

        // --- TK-303: Auto-retry on thinking signature error after provider/model switch ---
        // When user switches API provider or model mid-conversation, we attempt to resume
        // the session. If the new provider/model rejects the old thinking block signatures,
        // we automatically retry without resume to preserve UX continuity.
        if (msg.subtype !== 'success') {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          // Build a combined error string from all possible error fields
          const errorText = [msg.result, msg.error, msg.content]
            .filter(Boolean)
            .map(String)
            .join(' ');
          const isThinkingSignatureError = /invalid.*signature.*thinking|thinking.*invalid.*signature/i.test(errorText);

          const switchedFlag = meta.providerSwitched || meta.modelSwitched;
          const pendingText = meta.providerSwitchPendingText || meta.modelSwitchPendingText;
          // Find last user message as fallback retry text when no pendingText is set
          const lastUserMsg = !pendingText
            ? [...(useChatStore.getState().getTab(tabId)?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content
            : undefined;
          const retryCandidate = pendingText || (typeof lastUserMsg === 'string' ? lastUserMsg : undefined);
          if (isThinkingSignatureError && retryCandidate) {
            const switchType = switchedFlag
              ? meta.modelSwitched
                ? t('chat.switchTypeModel')
                : t('chat.switchTypeProvider')
              : t('chat.switchTypeSession');
            console.warn(`[LITTLECLAUDE] Thinking signature error after ${switchType} switch — auto-retrying without resume`);
            const retryText = retryCandidate;

            // Kill the current (failed) process
            const failedStdinId = meta.stdinId;
              if (failedStdinId) {
                bridge.killSession(failedStdinId).catch(() => {});
                cleanupStreamListener(failedStdinId);
              }

            // Clear sessionId (abandon resume) and switch flags
            setSessionMeta({
              sessionId: undefined,
              stdinId: undefined,
              providerSwitched: false,
              providerSwitchPendingText: undefined,
              modelSwitched: false,
              modelSwitchPendingText: undefined,
            });

            // Show system notice
            addMessage({
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: t('chat.switchNotice', { type: switchType }),
              commandType: 'info',
              timestamp: Date.now(),
            });

            // Sync reconnection status to ActivityIndicator
            setActivityStatus({ phase: 'thinking', statusMessage: t('chat.reconnecting') });

            // Re-send: spawn a fresh process without resume_session_id
            (async () => {
              // P0-5: Declare retryId outside try so catch can clean up listeners on failure
              const retryId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              try {
                const cwd = useSettingsStore.getState().workingDirectory;
                if (!cwd) return;
                const selectedModel = useSettingsStore.getState().selectedModel;
                const sessionMode = useSettingsStore.getState().sessionMode;

                const retryTurnStartedAt = Date.now();
                setSessionStatus('running');
                setSessionMeta({
                  turnStartTime: retryTurnStartedAt,
                  lastProgressAt: retryTurnStartedAt,
                  inputTokens: 0,
                  outputTokens: 0,
                });
                setActivityStatus({ phase: 'thinking' });
                agentActions.clearAgents();
                agentActions.upsertAgent({
                  id: 'main', parentId: null,
                  description: retryText.slice(0, 100),
                  phase: 'spawning', startTime: Date.now(), isMain: true,
                });
                const retryUnlisten = await onClaudeStream(retryId, (m: any) => {
                  m.__stdinId = retryId;
                  handleStreamMessage(m);
                });
                const retryUnlistenStderr = await onClaudeStderr(retryId, (line: string) => {
                  handleStderrLineRef.current(line, retryId);
                });
                registerStreamListener(retryId, () => { retryUnlisten(); retryUnlistenStderr(); });
                window.__claudeUnlisten = window.__claudeUnlisteners![retryId];

                const retryResolvedModel = resolveModelForProvider(selectedModel);
                const retryContextWindowMode = useSettingsStore.getState().contextWindowMode;
                const retryCliBackend = useSettingsStore.getState().cliBackend || 'claude';
                const retryProviderId = useProviderStore.getState().getActiveIdForBackend(retryCliBackend);
                const session = await bridge.startSession({
                  prompt: retryText,
                  cwd,
                  model: retryResolvedModel,
                  session_id: retryId,
                  // No resume_session_id — fresh start to avoid thinking signature issue
                  thinking_level: resolveThinkingLevelForProvider(
                    selectedModel,
                    useSettingsStore.getState().thinkingLevel,
                  ),
                  session_mode: (sessionMode === 'ask' || sessionMode === 'plan') ? sessionMode : undefined,
                  provider_id: retryProviderId || undefined,
                  context_window: getContextWindowForModel(retryResolvedModel, retryContextWindowMode),
                  permission_mode: mapSessionModeToPermissionMode(sessionMode),
                  cli_backend: retryCliBackend,
                  include_partial_messages: useSettingsStore.getState().includePartialMessages,
                });

                setSessionMeta({
                  sessionId: session.session_id,
                  stdinId: retryId,
                  envFingerprint: envFingerprint(),
                  snapshotContextWindowMode: retryContextWindowMode,
                  spawnedModel: retryResolvedModel,
                  snapshotProviderId: retryProviderId,
                  snapshotCliBackend: retryCliBackend,
                });
                const tabId = useSessionStore.getState().selectedSessionId;
                if (tabId) useSessionStore.getState().registerStdinTab(retryId, tabId);
                bridge.trackSession(session.session_id).catch(() => {});
              } catch (retryErr) {
                console.error('[LITTLECLAUDE] Provider-switch auto-retry failed:', retryErr);
                // P0-5: Clean up the retry listeners on failure
                cleanupStreamListener(retryId);
                setSessionStatus('error');
                setActivityStatus({ phase: 'error', statusMessage: t('chat.connectionLost') });
                addMessage({
                  id: generateMessageId(),
                  role: 'system', type: 'text',
                  content: t('chat.retryFailed', { err: String(retryErr) }),
                  timestamp: Date.now(),
                });
              }
            })();
            break; // Exit the result case — retry flow takes over
          }
        }

        // Code mode: Auto-restart when ExitPlanMode caused CLI exit.
        // In stream-json mode, ExitPlanMode is treated as a permission denial,
        // causing the CLI to exit. Silently restart with --resume to continue.
        // H2: read only THIS tab's flag — a background tab's ExitPlanMode must
        // never trigger a silent "Continue." resubmit (extra billable turn) in
        // the foreground conversation.
        if (_getExitPlanMap(exitPlanModeSeenRef)[tabId]
            && getEffectiveMode(useChatStore.getState().getTab(tabId)?.sessionMeta) === 'code'
            && msg.subtype !== 'success') {
          delete _getExitPlanMap(exitPlanModeSeenRef)[tabId];
          debugLog('session', 'Code mode ExitPlanMode exit detected — auto-restarting with --resume');
          // Clean up dead process
          const oldStdinId = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
            if (oldStdinId) {
              useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
              bridge.killSession(oldStdinId).catch(() => {});
              cleanupStreamListener(oldStdinId);
            }
          // Silently restart — no user message bubble
          silentRestartRef.current = true;
          // Sync restart status to ActivityIndicator
          setActivityStatus({ phase: 'thinking', statusMessage: t('chat.retrying') });
          setInputSync('Continue.');
          requestAnimationFrame(() => handleSubmitRef.current());
          break;
        }
        // H2: turn over without auto-restart — drop this tab's flag slot.
        delete _getExitPlanMap(exitPlanModeSeenRef)[tabId];

        // Mark pending processing card (CLI slash command) as completed
        const pendingCmdMsgId = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (pendingCmdMsgId) {
          const resultOutput = typeof msg.result === 'string' ? msg.result : '';
          useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
            commandCompleted: true,
            commandData: {
              ...(useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmdMsgId)?.commandData,
              output: resultOutput,
              completedAt: Date.now(),
            },
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // Extract result text for display (e.g., slash command output)
        let resultDisplayText = '';
        if (typeof msg.result === 'string' && msg.result) {
          resultDisplayText = msg.result;
        } else if (typeof msg.content === 'string' && msg.content) {
          resultDisplayText = msg.content;
        }

        // If we have cost metadata AND a pending slash command (e.g., /compact, /cost),
        // inject cost summary into the processing card instead of creating a separate message.
        if (msg.total_cost_usd != null && pendingCmdMsgId) {
          const cost = msg.total_cost_usd?.toFixed(4) ?? '—';
          const duration = msg.duration_ms
            ? `${(msg.duration_ms / 1000).toFixed(1)}s`
            : '—';
          const turns = msg.num_turns ?? '—';
          const input = msg.usage?.input_tokens
            ? msg.usage.input_tokens.toLocaleString()
            : '';
          const output = msg.usage?.output_tokens
            ? msg.usage.output_tokens.toLocaleString()
            : '';
          const cmdMsg = (useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === pendingCmdMsgId);
          if (cmdMsg) {
            useChatStore.getState().updateMessage(tabId, pendingCmdMsgId, {
              commandData: {
                ...cmdMsg.commandData,
                costSummary: { cost, duration, turns, input, output },
              },
            });
          }
          // If there's also explicit result text, still add it as a message
          if (!resultDisplayText) resultDisplayText = '';
        }

        // Only add result text if it wasn't already delivered via an
        // 'assistant' event (which is the normal case for stream-json output)
        // AND there's no pending command card (which already displays the output).
        if (resultDisplayText && !pendingCmdMsgId) {
          const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
          const isDuplicate = currentMessages.some(
            (m) => m.role === 'assistant' && m.type === 'text'
              && m.content === resultDisplayText,
          );
          if (!isDuplicate) {
            addMessage({
              id: msg.uuid || generateMessageId(),
              role: 'assistant',
              type: 'text',
              content: resultDisplayText,
              subAgentDepth: agentDepth,
              timestamp: Date.now(),
            });
          }
        }

        setSessionStatus(
          msg.subtype === 'success' ? 'completed' : 'error'
        );
        // Sync error status to ActivityIndicator for real-time user feedback
        if (msg.subtype !== 'success') {
          setActivityStatus({ phase: 'error', statusMessage: t('chat.error') });
        }
        {
          // Correct cumulative totals for any drift between streaming
          // accumulation and the authoritative result values.
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const resultInput = msg.usage?.input_tokens || 0;
          const resultOutput = msg.usage?.output_tokens || 0;
          const streamedInput = meta.inputTokens || 0;
          const streamedOutput = meta.outputTokens || 0;
          setSessionMeta({
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            turns: msg.num_turns,
            inputTokens: resultInput,
            outputTokens: resultOutput,
            totalInputTokens: (meta.totalInputTokens || 0) + (resultInput - streamedInput),
            totalOutputTokens: (meta.totalOutputTokens || 0) + (resultOutput - streamedOutput),
            turnStartTime: undefined,
            lastProgressAt: undefined,
          });
          // Turn finished — pin the API-authoritative average on the speed
          // badge (pure API time — local tool waits excluded).
          useTokenSpeedStore.getState().end(tabId, resolveApiSpeed(msg));
          // TK-FIX: persist authoritative token counts to Little Claude's usage log
          // so get_profile_stats reads correct values even when the Claude CLI
          // writes zero/missing usage to its JSONL.
          persistTurnUsage(
            meta.sessionId || '',
            msg.uuid || '',
            msg.usage,
            meta.model || '',
          );
        }
        agentActions.completeAll(
          msg.subtype === 'success' ? 'completed' : 'error'
        );
        useSessionStore.getState().fetchSessions();
        setTimeout(() => useSessionStore.getState().fetchSessions(), 1000);

        // --- AI Title Generation (TK-001): on 3rd successful turn, generate a title ---
        if (msg.subtype === 'success') {
          const sessionId = useChatStore.getState().getTab(tabId)?.sessionMeta.sessionId;
          if (sessionId) {
            const customPreviews = useSessionStore.getState().customPreviews;
            if (!customPreviews[sessionId]) {
              const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
              const userTextMsgs = currentMessages.filter(
                (m) => m.role === 'user' && m.type === 'text' && m.content,
              );
              if (userTextMsgs.length >= 3) {
                const assistantTextMsgs = currentMessages.filter(
                  (m) => m.role === 'assistant' && m.type === 'text' && m.content,
                );
                if (assistantTextMsgs.length >= 3) {
                  const userMsg = userTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
                  const assistantMsg = assistantTextMsgs.map((m) => m.content).join('\n').slice(0, 500);
                  bridge.generateSessionTitle(userMsg, assistantMsg,
                    useProviderStore.getState().getActiveIdForBackend(
                      useSettingsStore.getState().cliBackend || 'claude') || undefined)
                    .then((title) => {
                      if (title) {
                        useSessionStore.getState().setCustomPreview(sessionId, title);
                      }
                    })
                    .catch((e) => {
                      if (!String(e).includes('SKIP:')) console.warn('Title gen failed:', e);
                    });
                }
              }
            }
          }
        }

        // --- Auto-compact: threshold follows the declared context window.
        // Default 200K models compact at 160K; declared 1M models compact at 800K.
        // Fires at most once per session to avoid infinite loops.
        const resultInputTokens = msg.usage?.input_tokens || 0;
        const compactMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
        const compactStdinId = compactMeta?.stdinId;
        const compactModel = compactMeta?.spawnedModel || compactMeta?.snapshotModel || useSettingsStore.getState().selectedModel;
        const compactMode = compactMeta?.snapshotContextWindowMode ?? useSettingsStore.getState().contextWindowMode;
        const autoCompactThreshold = getAutoCompactThreshold(
          compactModel,
          compactMode,
          useSettingsStore.getState().autoCompactThresholdTokens,
        );
        if (resultInputTokens > autoCompactThreshold && !autoCompactFiredRef.current && compactStdinId && msg.subtype === 'success') {
          autoCompactFiredRef.current = true;
          debugLog('auto-compact', 'triggered:', { inputTokens: resultInputTokens, threshold: autoCompactThreshold });
          const compactMsgId = generateMessageId();
          addMessage({
            id: compactMsgId,
            role: 'system',
            type: 'text',
            content: t('chat.autoCompacting'),
            commandType: 'processing',
            commandData: { command: '/compact' },
            commandStartTime: Date.now(),
            commandCompleted: false,
            timestamp: Date.now(),
          });
          // FI-4: Register pendingCommandMsgId so result handler can mark it completed
          setSessionMeta({ pendingCommandMsgId: compactMsgId });
          setSessionStatus('running');
          setActivityStatus({ phase: 'thinking' });
          bridge.sendStdin(compactStdinId, '/compact').catch((err) => {
            console.error('[LITTLECLAUDE] Auto-compact failed:', err);
          });
          // FI-4: Timeout fallback — if compact doesn't complete within 90s, auto-complete
          setTimeout(() => {
            const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
            if (meta.pendingCommandMsgId === compactMsgId) {
              useChatStore.getState().updateMessage(tabId, compactMsgId, {
                commandCompleted: true,
                commandData: {
                  ...(useChatStore.getState().getTab(tabId)?.messages ?? []).find((m) => m.id === compactMsgId)?.commandData,
                  output: 'Compact timed out',
                  completedAt: Date.now(),
                },
              });
              useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
              if (useChatStore.getState().getTab(tabId)?.sessionStatus === 'running') {
                useChatStore.getState().setSessionStatus(tabId, 'idle');
              }
            }
          }, 15_000); // Bug C fix (#27): reduced from 90s to 15s
          break; // Skip pending message flush — compact takes priority
        }

        // FIFO drain: dequeue ONE pending message and send it (#142/#70).
        // When this turn completes, the next result event will dequeue the next one.
        // Previously all pending messages were joined and sent at once, which could
        // overwhelm the CLI. Sequential turn-by-turn processing is safer.
        {
          const drainTab = useChatStore.getState().getTab(tabId);
          const nextMsg = useChatStore.getState().shiftPendingMessage(tabId);
          const flushStdinId = drainTab?.sessionMeta.stdinId;
          if (nextMsg && flushStdinId) {
            const nextTurnStartedAt = Date.now();
            setSessionStatus('running');
            setSessionMeta({
              turnStartTime: nextTurnStartedAt,
              lastProgressAt: nextTurnStartedAt,
              inputTokens: 0,
              outputTokens: 0,
            });
            setActivityStatus({ phase: 'thinking' });
            agentActions.clearAgents();
            agentActions.upsertAgent({
              id: 'main',
              parentId: null,
              description: nextMsg.slice(0, 100),
              phase: 'spawning',
              startTime: Date.now(),
              isMain: true,
            });
            bridge.sendStdin(flushStdinId, nextMsg).catch((err) => {
              console.error('[TC] Failed to send pending message:', err);
              // Restore failed message + remaining queue to input draft
              const remaining = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
              const allFailed = [nextMsg, ...remaining];
              const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
              const failedText = allFailed.join('\n\n');
              useChatStore.getState().setInputDraft(tabId, draft ? `${draft}\n\n${failedText}` : failedText);
              useChatStore.getState().clearPendingMessages(tabId);
              setSessionStatus('error');
            });
          }
        }

        break;
      }

      case 'rate_limit_event': {
        const rli = msg.rate_limit_info;
        if (rli && rli.rateLimitType) {
          const prev = useChatStore.getState().getTab(tabId)?.sessionMeta.rateLimits || {};
          setSessionMeta({
            rateLimits: {
              ...prev,
              [rli.rateLimitType]: {
                rateLimitType: rli.rateLimitType,
                resetsAt: rli.resetsAt,
                isUsingOverage: rli.isUsingOverage,
                overageStatus: rli.overageStatus,
                overageDisabledReason: rli.overageDisabledReason,
              },
            },
          });
        }
        break;
      }

      case 'process_exit': {
        // H1: stale-exit ownership guard. When a tab's old process is killed
        // and immediately replaced (Stop → resend, envFingerprint / mode /
        // model change auto-kill-rebuild), the OLD process's process_exit can
        // arrive LATE (Windows reaps the process tree slowly) — after the new
        // stdinId is already written to sessionMeta. Treating that late event
        // as the current process's exit would set the NEW session idle, clear
        // its stdinId (later stream events never restore it), and roll pending
        // messages back into the draft. Same guard pattern as InputBar's
        // onSessionExit safety net ("Only act if this is still the active
        // stdinId (avoid stale cleanup)").
        const exitStdinId = msg.__stdinId as string | undefined;
        const exitCurTab = useChatStore.getState().getTab(tabId);
        const exitCurStdinId = exitCurTab?.sessionMeta.stdinId;
        // Stale when the event names a stdinId that differs from the tab's
        // current one. If the tab's stdinId was already cleared, only the Stop
        // flow (status 'completed') is a genuine exit; a cleared stdinId while
        // still 'running' means an in-flight kill-rebuild whose full cleanup
        // would clobber the replacement process.
        const isStaleExit = !!exitStdinId
          && exitStdinId !== exitCurStdinId
          && (exitCurStdinId !== undefined || exitCurTab?.sessionStatus === 'running');
        if (isStaleExit) {
          // Old-process cleanup ONLY: its event listeners, stdinId→tab mapping
          // and stream buffer. Do NOT touch sessionStatus / sessionMeta.stdinId
          // / pendingUserMessages / inputDraft / streams — they belong to the
          // replacement process.
          debugLog('session', 'stale process_exit ignored (stdinId mismatch)', { old: exitStdinId, current: exitCurStdinId });
          flushStreamBuffer(exitStdinId);
          cleanupStreamListener(exitStdinId);
          useSessionStore.getState().unregisterStdinTab(exitStdinId);
          break;
        }

        // The CLI process has exited — clear the stdin handle but keep sessionId for resume
        clearPartial();
        debugLog('session', 'process_exit received', { stdinId: msg.__stdinId });

        // Bug C fix (#27): Clear stuck pendingCommandMsgId (e.g., /compact without result)
        const exitPendingCmd = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (exitPendingCmd) {
          useChatStore.getState().updateMessage(tabId, exitPendingCmd, { commandCompleted: true });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
        }

        // If the session was running and no assistant messages were received,
        // the process failed at startup. Show the last stderr error to the user.
        const exitTabData = useChatStore.getState().getTab(tabId);
        const exitStatus = exitTabData?.sessionStatus;
        const exitMsgs = exitTabData?.messages ?? [];
        if (exitStatus === 'running') {
          const hasAssistantReply = exitMsgs.some(
            (m: ChatMessage) => m.role === 'assistant' && (m.type === 'text' || m.type === 'tool_use'),
          );
          if (!hasAssistantReply) {
            // Sync error status to ActivityIndicator for real-time feedback
            setActivityStatus({ phase: 'error', statusMessage: t('chat.connectionLost') });
            if (lastStderrRef.current) {
              // Detect macOS TCC permission errors and provide actionable guidance
              const stderr = lastStderrRef.current;
              const isTccError = /unexpected|operation not permitted|permission denied/i.test(stderr);
              const cwd = useSettingsStore.getState().workingDirectory || '';
              const isProtectedDir = /\/(Desktop|Downloads|Documents)\//i.test(cwd);
              const hint = isTccError && isProtectedDir
                ? '\n\n此目录可能受 macOS 隐私保护限制。请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中授权，或选择其他目录。'
                : '';
              addMessage({
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: formatErrorForUser(`CLI error: ${stderr}${hint}`),
                timestamp: Date.now(),
              });
            } else {
              // No stderr captured — CLI exited silently. Show a generic error
              // so the user knows something went wrong (previously this was silent).
              addMessage({
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: t('error.cliExitedSilently'),
                timestamp: Date.now(),
              });
            }
          }
        }

        // P0-5: Clean up Tauri event listeners for this session to prevent leaks
        const exitingStdinId = msg.__stdinId || useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
        if (exitingStdinId) {
          cleanupStreamListener(exitingStdinId);
        }
        clearLegacyListener();

        {
          const exitMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
          for (const m of exitMessages) {
            if (['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved) {
              useChatStore.getState().updateMessage(tabId, m.id, {
                interactionState: 'failed',
                interactionError: 'CLI process exited',
              });
            }
          }
        }

        setSessionStatus('idle');
        // B6: a process exit (interrupt, error, or kill) may arrive without a
        // final assistant message — clear any residual partial text so the UI
        // never shows a frozen half-bubble from the dead session.
        {
          const newStreams = new Map(useChatStore.getState().streams);
          newStreams.set(tabId, { partialText: '', partialThinking: '', isStreaming: false });
          useChatStore.setState({ streams: newStreams });
        }
        if (!document.hasFocus() && 'Notification' in window) {
          if (Notification.permission === 'granted') {
            new Notification('Little Claude', { body: t('notification.chatComplete') });
          } else if (Notification.permission === 'default') {
            Notification.requestPermission().then((perm) => {
              if (perm === 'granted') {
                new Notification('Little Claude', { body: t('notification.chatComplete') });
              }
            }).catch(() => {});
          }
        }

        setSessionMeta({ stdinId: undefined, lastProgressAt: undefined });
        // Session exited — stop any live token speed badge.
        useTokenSpeedStore.getState().end(tabId);
        // H2: process is gone — drop this tab's ExitPlanMode-seen slot so the
        // per-tab map cannot grow across session restarts.
        delete _getExitPlanMap(exitPlanModeSeenRef)[tabId];
        // Clean up stdinId → tabId mapping to prevent memory leak
        if (exitingStdinId) {
          useSessionStore.getState().unregisterStdinTab(exitingStdinId);
        }
        // Bug B fix (#28): Don't discard pending messages — restore to input draft
        const remainingPending = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
        if (remainingPending.length > 0) {
          const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
          const pendingText = remainingPending.join('\n\n');
          useChatStore.getState().setInputDraft(tabId,
            draft ? `${draft}\n\n${pendingText}` : pendingText
          );
          useChatStore.getState().clearPendingMessages(tabId);
        }

        agentActions.completeAll();
        useSessionStore.getState().fetchSessions();
        break;
      }

      default:
        // Fallback: handle content_block_delta at top level (without stream_event wrapper)
        if (msg.type === 'content_block_delta') {
          const text = msg.delta?.text || '';
          if (text && msgStdinId) {
            const buf = _getBuffer(msgStdinId);
            buf.text += text;
            _scheduleStreamFlush(msgStdinId);
          }
        }
        break;
    }

    } catch (err) {
      // P1-4: catch-all for unexpected errors in stream message processing
      console.error('[LITTLECLAUDE] handleStreamMessage error:', err, 'msg:', msg?.type, msg?.subtype);
      // L2: write the error into the tab that OWNS this stream — a background
      // session's processing error must not appear inside the foreground
      // conversation. resolveOwnerTab handles stdinId→tab (with self-healing);
      // fall back to the selected tab only when no owner resolves.
      const errTabId = resolveOwnerTab(msg?.__stdinId) || useSessionStore.getState().selectedSessionId;
      if (errTabId) {
        useChatStore.getState().addMessage(errTabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: formatErrorForUser(`Internal error processing stream message: ${err}`),
          timestamp: Date.now(),
        });
      }
    }
  }, [handleBackgroundStreamMessage, exitPlanModeSeenRef, autoCompactFiredRef, silentRestartRef, handleSubmitRef, handleStderrLineRef, setInputSync]);

  return { handleStreamMessage, handleBackgroundStreamMessage };
}
