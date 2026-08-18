import { useCallback, type MutableRefObject } from 'react';
import { useChatStore, generateMessageId, migrateBatchDedupKey, type ChatMessage } from '../stores/chatStore';
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
import { useTodoStore } from '../stores/todoStore';
import { useGoalStore } from '../stores/goalStore';
import { useFeedbackStore } from '../stores/feedbackStore';
import { useFileStore } from '../stores/fileStore';
import { useTokenSpeedStore, estimateTokensFromText } from '../stores/tokenSpeedStore';
import { bridge, onClaudeStream, onClaudeStderr } from '../lib/tauri-bridge';
import { envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../lib/api-provider';
import { useProviderStore } from '../stores/providerStore';
import { t } from '../lib/i18n';
import { cleanupStreamListener, registerStreamListener, clearLegacyListener } from '../lib/stream-cleanup';
import { isSystemText } from '../lib/system-text';
import { normalizeCacheCreation, semanticContextTokens } from '../lib/context-tokens';
import { showToast } from '../components/shared/Toast';

// --- Error classification for user-facing messages ---
// Each pattern maps to a friendly i18n key. Matched errors show the friendly
// message as primary text with raw error in a collapsible details block.
// Unmatched errors get a generic fallback + raw details.
const ERROR_CATEGORIES: ReadonlyArray<{ pattern: RegExp; i18nKey: string }> = [
  // G1: dsh 缺失友好错误 —— 放在靠前位置，优先于通用的 cliNotInstalled 规则，
  // 引导新用户去 设置→CLI 管理 安装 dsh 或切换到 Claude/Codex 后端。
  { pattern: /dsh.*not found|DeepSeek Harness|@deepseek-ai[/\\]dsh/i, i18nKey: 'error.dshNotInstalled' },
  // Expired/stale interaction first: a permission/question card answered after
  // its TTL ("Unknown or expired permission request") must explain itself
  // instead of falling through to the generic fallback.
  { pattern: /expired|过期|失效|unknown.*permission.*request/i, i18nKey: 'error.requestExpired' },
  // Chinese patterns included: DeepSeek / DSH endpoints report errors in
  // Chinese; English-only matching sent all of them to the generic fallback.
  { pattern: /40[13]|unauthorized|invalid.*key|api.key.*invalid|密钥.*(无效|错误)|认证失败|鉴权失败|未授权/i, i18nKey: 'error.invalidKey' },
  { pattern: /429|rate.limit|too.many.request|限流|频率.*(高|快)|请求过多|并发/i, i18nKey: 'error.rateLimit' },
  { pattern: /quota|insufficient.*balance|credit|billing|余额|额度|欠费|配额/i, i18nKey: 'error.quotaExceeded' },
  { pattern: /model.*not.found|invalid.*model|not_found.*model|模型不存在|无效.*模型|找不到模型/i, i18nKey: 'error.modelNotFound' },
  { pattern: /timeout|timed?.out|ECONNREFUSED|ECONNRESET|ENOTFOUND|超时/i, i18nKey: 'error.networkError' },
  { pattern: /network|fetch.failed|dns|网络(错误|异常)?|连接失败|无法连接|连接断开/i, i18nKey: 'error.networkError' },
  { pattern: /permission.denied|operation.not.permitted|access.denied|forbidden|权限不足|拒绝访问/i, i18nKey: 'error.permissionDenied' },
  { pattern: /overloaded|capacity|503|service.unavailable|过载|繁忙|拥挤|负载过高|服务不可用/i, i18nKey: 'error.serviceUnavailable' },
  { pattern: /not.installed|command.not.found|未安装|找不到命令/i, i18nKey: 'error.cliNotInstalled' },
  { pattern: /token.*limit|context.*length|too.long|上下文.*(超|过长)|超出.*长度|长度限制/i, i18nKey: 'error.tokenLimit' },
];

// U1: 错误类别 —— 分类器命中的 i18nKey。写入 ChatMessage.errorCategory 后，
// MessageBubble 依此渲染动作按钮（打开服务商设置 / 去安装 / 新建任务 / 重试）。
export type ErrorCategory =
  | 'error.dshNotInstalled' | 'error.requestExpired' | 'error.invalidKey'
  | 'error.rateLimit' | 'error.quotaExceeded' | 'error.modelNotFound'
  | 'error.networkError' | 'error.permissionDenied' | 'error.serviceUnavailable'
  | 'error.cliNotInstalled' | 'error.tokenLimit';

export interface FormattedError {
  /** 友好文案 + 可折叠详情块 —— 与旧 formatErrorForUser 的字符串输出完全一致 */
  text: string;
  /** U1: 分类命中时为对应 i18nKey；未命中（generic fallback）为 undefined */
  category?: ErrorCategory;
}

/** U1: 分类 + 格式化。聊天流调用点用 {text, category} 组装可行动错误卡片。 */
export function classifyError(raw: string): FormattedError {
  if (!raw || raw.length < 10) return { text: raw };
  const match = ERROR_CATEGORIES.find((c) => c.pattern.test(raw));
  const friendly = match ? t(match.i18nKey) : t('error.genericFallback');
  const text = `${friendly}\n\n<details>\n<summary>${t('error.showDetails')}</summary>\n\n\`\`\`\n${raw}\n\`\`\`\n\n</details>`;
  return { text, category: match ? (match.i18nKey as ErrorCategory) : undefined };
}

export function formatErrorForUser(raw: string): string {
  // U1: 保留字符串返回 —— friendlyError 等纯文本调用点无需改动
  return classifyError(raw).text;
}

// --- Streaming text buffer (timer-throttled + interval fallback, per-stdinId) ---
// Coalesces rapid text_delta / thinking_delta events into a single state update
// per ~50ms (fix23: was rAF ~60fps), preventing JS main thread starvation from
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

// fix11: Stop/kill 主动杀掉的 stdinId 集合。旧进程迟到的 process_exit 一律按
// stale 处理（不覆盖 completed 状态、不误发"任务完成"通知）。条目在
// process_exit 消费时移除。
// F11: 从 Set 改为带时间戳的 Map —— kill 后永无 process_exit 到达的进程
// （如崩溃/已被系统回收）条目由 flush interval 定期清扫（>5 分钟），
// 集合不会无限增长。
const _killedStdinIds = new Map<string, number>();
const KILLED_STDIN_TTL_MS = 5 * 60 * 1000;

/** fix11: 主动杀进程前登记 stdinId（Stop 按钮等调用）。 */
export function markKilledStdin(stdinId: string) {
  _killedStdinIds.set(stdinId, Date.now());
}

// U3: 用户主动 Stop（先中断后杀）登记的 stdinId 集合。标记有效期间到达的
// result/process_exit 保持 'stopped' 语义：不回退成 completed/error/idle、
// 不误发"任务完成"通知、不给被中断的回合补错误消息。
// 有效窗口 STOPPED_STDIN_TTL_MS（2s 中断等待 + result 送达余量），过期条目
// 由 flush interval 顺手清扫（同 _killedStdinIds 的回收方式）。
const _stoppedStdinIds = new Map<string, number>();
const STOPPED_STDIN_TTL_MS = 10 * 1000;

/** U3: 登记用户主动停止（Stop 按钮 / 侧栏右键"停止"共用）。 */
export function markStoppedStdin(stdinId: string) {
  _stoppedStdinIds.set(stdinId, Date.now());
}

/** U3: 停止标记是否仍在有效窗口内（不消费）。 */
export function isStoppedStdinActive(stdinId: string): boolean {
  const at = _stoppedStdinIds.get(stdinId);
  return at !== undefined && Date.now() - at < STOPPED_STDIN_TTL_MS;
}

/** U3: 消费停止标记（result/exit 已到达）。过期标记按不存在处理。 */
export function consumeStoppedStdin(stdinId: string): boolean {
  const at = _stoppedStdinIds.get(stdinId);
  _stoppedStdinIds.delete(stdinId);
  return at !== undefined && Date.now() - at < STOPPED_STDIN_TTL_MS;
}

// U2: 通知点击跳回 —— 对齐 App.tsx Ctrl+Tab 的切换路径：
// 保存当前 tab → setSelectedSession → 内存缓存恢复，未命中则磁盘加载回退。
// session-disk-load 反向依赖本模块（formatErrorForUser），用动态 import 破环。
function jumpToSession(targetId: string) {
  const sessStore = useSessionStore.getState();
  const currentId = sessStore.selectedSessionId;
  if (currentId === targetId) return;
  if (currentId) {
    useChatStore.getState().saveToCache(currentId);
    useAgentStore.getState().saveToCache(currentId);
  }
  sessStore.setSelectedSession(targetId);
  const restored = useChatStore.getState().restoreFromCache(targetId);
  const entry = sessStore.sessions.find((s) => s.id === targetId);
  if (restored) {
    useAgentStore.getState().restoreFromCache(targetId);
  } else if (entry?.path) {
    void import('../lib/session-disk-load').then(({ loadSessionFromDisk }) =>
      loadSessionFromDisk(targetId, entry.path, entry.origin || 'claude'),
    );
  } else {
    // draft / 未知会话 —— 与 Ctrl+Tab 的 never-opened 分支一致
    useChatStore.getState().ensureTab(targetId);
    useChatStore.getState().resetTab(targetId);
    useAgentStore.getState().clearAgents();
  }
  // 恢复工作目录（与 Ctrl+Tab 路径相同的解析规则）
  const projectPath = entry?.project || entry?.projectDir;
  if (projectPath) {
    let resolved = projectPath;
    if (!projectPath.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(projectPath)
        && !projectPath.startsWith('~/')) {
      if (/^[A-Za-z]-/.test(projectPath)) {
        const drive = projectPath[0];
        resolved = `${drive}:\\${projectPath.slice(2).replace(/-/g, '\\')}`;
      } else {
        resolved = projectPath.replace(/-/g, '/');
      }
    }
    useSettingsStore.getState().setWorkingDirectory(resolved);
  }
}

// U2: 带"点击跳回"的系统通知 —— onclick 聚焦主窗口并选中对应会话
// （stdinId→tab 的路由在上游已完成，这里直接拿 tabId）。
function showNotificationWithJump(tabId: string, body: string) {
  if (!('Notification' in window)) return;
  const spawn = () => {
    try {
      const n = new Notification('Little Claude', { body });
      n.onclick = () => {
        window.focus();
        jumpToSession(tabId);
        n.close();
      };
    } catch {
      // 某些平台/策略下 Notification 构造会抛异常 —— 通知失败不影响主流程
    }
  };
  if (Notification.permission === 'granted') {
    spawn();
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') spawn();
    }).catch(() => {});
  }
}

// U3: 优雅停止 —— Stop 语义从"直接 kill"改为"先中断后杀"：
//   · claude 后端：send_control_request interrupt（SDK control 协议）
//   · codex 后端：Rust 端把 interrupt 路由成 turn/interrupt（build_interrupt_message）
//   · deepseek 后端：保持直接 kill（kill_session 已映射 session.cancel）
// claude/codex 中断后 2 秒内无 result/process_exit → kill 兜底（markKilledStdin
// 保证 fix11 的 stale-exit 语义不变）。中断成功则进程保留，可直接继续对话。
// InputBar 的 Stop 按钮与侧栏右键"停止"（U4）共用此入口。
export async function stopSessionGracefully(tabId: string): Promise<void> {
  const chat = useChatStore.getState();
  const tab = chat.getTab(tabId);
  const sid = tab?.sessionMeta.stdinId;

  // 立即切 'stopped'（sessionStore 同步侧栏琥珀点）+ 活动指示文案
  chat.setSessionStatus(tabId, 'stopped');
  chat.setActivityStatus(tabId, { phase: 'idle', statusMessage: t('session.stopped') });

  // H6 语义保留：排队中的消息回退到输入草稿，由用户决定重发或丢弃
  const queued = chat.flushPendingMessages(tabId);
  if (queued.length > 0) {
    const draft = chat.getTab(tabId)?.inputDraft ?? '';
    chat.setInputDraft(tabId, [draft, ...queued].filter(Boolean).join('\n\n'));
  }

  if (!sid) return;

  const killNow = async () => {
    // 清 stdinId 防止后续消息写进死进程
    useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
    // fix11: 登记被杀 stdinId —— 迟到的 process_exit 按 stale 处理，
    // 不把 stopped 回滚成 idle、不误发"任务完成"通知
    markKilledStdin(sid);
    await bridge.killSession(sid).catch(() => {});
    // 安全网：process_exit 未到时 3s 后强制回收监听器
    setTimeout(() => { cleanupStreamListener(sid); }, 3000);
  };

  // 后端以会话 spawn 时的快照为准（用户可能中途切了后端设置）
  const backend = tab?.sessionMeta.snapshotCliBackend || useSettingsStore.getState().cliBackend;
  markStoppedStdin(sid);
  if (backend === 'deepseek') {
    // deepseek: kill_session ≙ session.cancel —— 保持直接 kill
    await killNow();
    return;
  }
  // claude/codex: 先发 control interrupt
  try {
    await bridge.interruptSession(sid);
  } catch {
    // 中断发送失败（管道已断等）—— 直接走 kill 兜底
    await killNow();
    return;
  }
  // 2 秒内没有 result/process_exit（停止标记仍有效）→ kill 兜底。
  // 中断成功时标记被 result/exit 处理器消费，进程保留给后续回合。
  // kill 兜底后标记保留不消费：与 kill 竞态的迟到 result 仍能凭标记保持
  // 'stopped' 语义（process_exit 走 fix11 killed 分支早退），过期由清扫回收。
  const startedAt = Date.now();
  const poll = setInterval(() => {
    if (!isStoppedStdinActive(sid)) { clearInterval(poll); return; }
    const cur = useChatStore.getState().getTab(tabId)?.sessionMeta.stdinId;
    if (cur !== sid) { clearInterval(poll); return; } // process_exit 已清理
    if (Date.now() - startedAt >= 2000) {
      clearInterval(poll);
      if (isStoppedStdinActive(sid)) void killNow();
    }
  }, 150);
}

function _ensureFlushInterval() {
  if (_flushIntervalId) return;
  _flushIntervalId = setInterval(() => {
    for (const [stdinId, buf] of _streamBuffers) {
      if (buf.text || buf.thinking) {
        _doFlush(stdinId, buf);
      } else if (!buf.raf && !buf.timer) {
        // B3: idle buffer with no pending flush. A session whose stream
        // ended without process_exit (kill / webview reload / emit-failure
        // bail-out) used to keep its entry forever — and the interval only
        // self-stops when _streamBuffers.size === 0, so one orphaned entry
        // made it poll 500ms forever. A slow live stream can briefly lose
        // its throttled-state here (the entry is recreated on the next
        // chunk), which is acceptable — the A7 threshold re-arms after 8KiB.
        _streamBuffers.delete(stdinId);
      }
    }
    // F11: 顺手清扫 _killedStdinIds 中 >5 分钟的条目（kill 后进程迟到
    // exit 永不消费的兜底回收）
    {
      const sweepNow = Date.now();
      for (const [id, killedAt] of _killedStdinIds) {
        if (sweepNow - killedAt > KILLED_STDIN_TTL_MS) _killedStdinIds.delete(id);
      }
    }
    // U3: 顺手清扫过期的停止标记（中断后 result 永不送达的兜底回收）
    {
      const u3SweepNow = Date.now();
      for (const [id, markedAt] of _stoppedStdinIds) {
        if (u3SweepNow - markedAt > STOPPED_STDIN_TTL_MS) _stoppedStdinIds.delete(id);
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

// fix23: 前 8KiB 不再用 rAF（~60fps）重渲 markdown，改 ~50ms 定时器节流
const PRETHROTTLE_FLUSH_MS = 50;

function _scheduleStreamFlush(stdinId: string) {
  const buf = _getBuffer(stdinId);
  // Start the interval fallback on first buffer activity
  _ensureFlushInterval();
  if (!buf.throttled) {
    // fix23: 复用 timer 槽位（raf 槽保留给 flushStreamBuffer 的取消逻辑）
    if (buf.timer) return;
    buf.timer = window.setTimeout(() => {
      buf.timer = 0;
      _doFlush(stdinId, buf);
    }, PRETHROTTLE_FLUSH_MS);
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
// F15: 'Bash' 移除——结构变更已有 watcher 覆盖，Bash 每次 tool_result 都
// 触发 refreshTree，放大整树重扫。
const FILE_MUTATING_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'BatchTool',
]);

// A3: Module-level constant — avoids 50-120 Set allocations/second during streaming.
// Previously created inside handleStreamMessage on every event.
const KNOWN_STREAM_TYPES = new Set([
  'little_claude_permission_request', 'stream_event', 'system', 'assistant',
  'user', 'human', 'tool_result', 'tool_use_summary', 'result', 'process_exit',
  'content_block_delta', 'rate_limit_event',
  // DSH context alignment (service-mode projections + compaction lifecycle)
  'context_update', 'compaction_start', 'compaction_summary', 'compaction_end',
]);

/**
 * DSH context-pressure projection (`context_update`) — the token-meter's
 * authoritative occupancy: `projectedTokens` = last usage anchor + surface
 * delta re-estimate (host pushes it on usage / request/context events; the
 * client fixture lacks it, so fall back to `pressureTokens`). Only
 * contextTokens + dshContextWindow are written — the projection has no
 * breakdown, so writing contextInputTokens/contextCache* here would trip the
 * Ctx bar's cache-miss red dot (cachedShare would read 0). Shared by the
 * foreground and background handlers.
 */
function applyDshContextUpdate(tabId: string, msg: any) {
  const projected = msg.projected_tokens ?? msg.pressure_tokens;
  if (typeof projected !== 'number' || projected <= 0) return;
  const store = useChatStore.getState();
  const updates: Parameters<typeof store.setSessionMeta>[1] = {
    contextTokens: projected,
  };
  if (typeof msg.context_window === 'number') {
    updates.dshContextWindow = msg.context_window;
  }
  store.setSessionMeta(tabId, updates);
}

/**
 * DSH compaction lifecycle (`compaction_start|summary|end`). The projection
 * is NOT pushed on compaction (compaction produces no usage), so without
 * these the Ctx bar would freeze at the pre-compact ≈100% until the next
 * request. `compaction/summary` only fires on the success path; its
 * shadowed_token_count is the token-meter heuristic estimate of the replaced
 * range → drop the bar immediately (next request corrects to the precise
 * value). Shared by the foreground and background handlers.
 */
function applyDshCompaction(tabId: string, msg: any) {
  const store = useChatStore.getState();
  switch (msg.type) {
    case 'compaction_start':
      store.setSessionMeta(tabId, { compactionInProgress: true });
      break;
    case 'compaction_summary': {
      const shadowed = typeof msg.shadowed_token_count === 'number'
        ? msg.shadowed_token_count
        : 0;
      if (shadowed > 0) {
        const meta = store.getTab(tabId)?.sessionMeta ?? {};
        const old = meta.contextTokens ?? meta.inputTokens ?? 0;
        store.setSessionMeta(tabId, {
          contextTokens: Math.max(0, old - shadowed),
          compactionSavedTokens: shadowed,
          compactedAt: Date.now(),
        });
      }
      break;
    }
    case 'compaction_end':
      store.setSessionMeta(tabId, { compactionInProgress: false });
      if (msg.error) {
        showToast(t('chat.compactFailed'), 'error');
      }
      break;
  }
}

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

// B11: tool_use inputs carry full file contents (Write content, Edit
// old/new strings, ExitPlanMode plans). capToolResult covers the RESULTS;
// the inputs were uncapped — an agent session writing large files would hold
// megabytes per message in RAM for the whole session, re-injected on every
// reload. Truncate the big text fields only; structural fields (paths,
// commands, questions, todos) stay intact. The diff renderer already limits
// displayed lines, so truncation doesn't change the interaction.
const MAX_TOOL_INPUT_FIELD_CHARS = 64 * 1024; // 64 KiB per text field
const TOOL_INPUT_TRUNCATED_MARKER = '\n…（已截断）';

function capToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  let out: Record<string, unknown> | null = null;
  for (const key of ['content', 'old_string', 'new_string', 'plan'] as const) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > MAX_TOOL_INPUT_FIELD_CHARS) {
      if (!out) out = { ...(input as Record<string, unknown>) };
      out[key] = v.slice(0, MAX_TOOL_INPUT_FIELD_CHARS) + TOOL_INPUT_TRUNCATED_MARKER;
    }
  }
  return out ?? input;
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
  silentRestartRef: MutableRefObject<boolean>;
  /** fix14: 支持传 submitText/preserveDraft——非空输入框直接发送，不覆写编辑器 */
  handleSubmitRef: MutableRefObject<(text?: string, opts?: { preserveDraft?: boolean }) => void>;
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
 * True while a /compact slash command is in flight (auto-compact or manual).
 * The compact summary request outputs thousands of tokens in 1-3 seconds
 * (tiny input, no tools) — counted into the tok/s badge it reads 1000+ tok/s,
 * which is compression speed, not generation speed. The push/end paths skip
 * it, so the badge never shows that number. Identified via the pending
 * processing card's command: any message-id bound in pendingCommandMsgId
 * whose commandData.command is '/compact'.
 */
function isCompactInFlight(tabId: string): boolean {
  const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
  // A1: the continuation clears the card before the result — the in-flight
  // marker keeps the summary request's speed out of the tok/s badge too.
  if (meta?.compactTurnPending === true) return true;
  const pendingId = meta?.pendingCommandMsgId;
  if (!pendingId) return false;
  const cmdMsg = (useChatStore.getState().getTab(tabId)?.messages ?? [])
    .find((m) => m.id === pendingId);
  return cmdMsg?.commandData?.command === '/compact';
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
type StreamUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
};

/** B1/B2 fix: the FULL input context of a request. With prompt caching enabled
 * (the default), 95%+ of the context sits in cache_read_input_tokens — comparing
 * input_tokens alone against the compact threshold made auto-compact effectively
 * never fire (real data: input_tokens=6, cache_read=85163).
 * Semantics-aware: DeepSeek/OpenAI-compatible endpoints already include the
 * cached share in input_tokens (see context-tokens.ts), so summing all three
 * there double-counts. */
function fullInputContextTokens(usage: StreamUsage | undefined): number {
  return semanticContextTokens(fullInputContextBreakdown(usage));
}

/** Split a request's full input context into its billable parts — new input,
 *  cache hit, cache write. contextTokens = sum of the three; the breakdown
 *  feeds the Ctx bar tooltip and cache-miss detection (a large input with
 *  ~0 cache hit means the gateway re-sent the whole history). */
function fullInputContextBreakdown(usage: StreamUsage | undefined): {
  input: number;
  cacheRead: number;
  cacheCreation: number;
} {
  const u = usage || {};
  const cc = u.cache_creation || {};
  // Same normalization as profile.rs: the CLI writes the SAME cache-creation
  // value at the top level AND inside usage.cache_creation (ephemeral_*);
  // summing them double-counts (inflated Ctx bar + premature auto-compact).
  return {
    input: u.input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreation: normalizeCacheCreation(
      u.cache_creation_input_tokens,
      cc.ephemeral_1h_input_tokens,
      cc.ephemeral_5m_input_tokens,
    ),
  };
}

function persistTurnUsage(
  sessionId: string,
  messageId: string,
  usage: StreamUsage | undefined,
  model: string,
): void {
  if (!sessionId || !messageId) return;
  const u = usage || {};
  const cacheCreation = u.cache_creation || {};
  const cacheCreationTokens = normalizeCacheCreation(
    u.cache_creation_input_tokens,
    cacheCreation.ephemeral_1h_input_tokens,
    cacheCreation.ephemeral_5m_input_tokens,
  );
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

// --- Auto-compact timeout (B4 fix) ---
// The old fixed 15s timeout was shorter than a real large-context compact
// (summarizing 160K+ tokens routinely takes 30-90s), so every genuine compact
// was falsely reported as "timed out". Now activity-aware: lastProgressAt is
// updated by every stream event (throttled 1.5s), so as long as the CLI keeps
// streaming we keep waiting; only declare timeout after >60s of silence or an
// absolute 10-minute cap.
const COMPACT_CHECK_MS = 30_000;
const COMPACT_STALL_MS = 60_000;
const COMPACT_MAX_MS = 600_000;
/** Regression fix: after a timeout the session stays 'running' on purpose
 *  (the compact may still be silently working). If it never completes, this
 *  grace period releases the session so the user can keep going. */
const COMPACT_GRACE_MS = 90_000;

export function scheduleCompactTimeoutCheck(tabId: string, compactMsgId: string, startedAt: number): void {
  setTimeout(() => {
    const tab = useChatStore.getState().getTab(tabId);
    const meta = tab?.sessionMeta ?? {};
    // Card already completed normally (assistant/result arrival) — stop watching.
    if (meta.pendingCommandMsgId !== compactMsgId) return;
    const now = Date.now();
    const lastAt = meta.lastProgressAt ?? startedAt;
    if (now - lastAt <= COMPACT_STALL_MS && now - startedAt <= COMPACT_MAX_MS) {
      scheduleCompactTimeoutCheck(tabId, compactMsgId, startedAt); // still active
      return;
    }
    useChatStore.getState().updateMessage(tabId, compactMsgId, {
      commandCompleted: true,
      commandData: {
        ...(tab?.messages ?? []).find((m) => m.id === compactMsgId)?.commandData,
        output: 'Compact timed out',
        completedAt: Date.now(),
      },
    });
    useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
    // B4: deliberately do NOT flip the session to 'idle' here. With thinking
    // off, a large compact can run silently >60s (no stream events at all) —
    // the CLI may still be working. Marking idle would let the user send
    // messages that silently queue on the CLI and let a manual Compact click
    // double-fire. compactTurnPending is also kept: if the compact IS still
    // running, its eventual result is still recognized as a compact turn
    // (excluded from stats, no re-trigger); if the process died instead, the
    // process_exit handler cleans up.
    // Regression fix: but a compact that NEVER completes would leave the
    // session stuck 'running' forever — the pending-message FIFO only drains
    // on a result, /commands are gated, the indicator spins. After one grace
    // period with no progress, release the session so the user can continue
    // (any late result still lands correctly; it just isn't a compact turn).
    const stuckSince = useChatStore.getState().getTab(tabId)?.sessionMeta.lastProgressAt ?? startedAt;
    setTimeout(() => {
      const graceTab = useChatStore.getState().getTab(tabId);
      const graceMeta = graceTab?.sessionMeta ?? {};
      const stillStuck = graceTab?.sessionStatus === 'running'
        && !graceMeta.pendingCommandMsgId
        && (graceMeta.lastProgressAt ?? startedAt) <= stuckSince;
      if (stillStuck) {
        useChatStore.getState().setSessionStatus(tabId, 'idle');
        useChatStore.getState().setSessionMeta(tabId, { compactTurnPending: undefined });
      }
    }, COMPACT_GRACE_MS);
  }, COMPACT_CHECK_MS);
}

/** B1/B3/B5 fix: shared auto-compact trigger for foreground AND background
 * result handlers. Compares the FULL last-request context (input + cache)
 * against the threshold, fires at most once per session (per-tab flag in
 * sessionMeta, no longer a ref shared across all sessions). Returns true if
 * compact was fired — caller must then skip the FIFO pending-message drain. */
/** True if the current turn (messages after the most recent user message)
 *  still has a pending tool execution, unanswered question, or pending
 *  permission — i.e. the CLI is executing and NOT sitting idle at its prompt.
 *
 *  Shared by the auto-compact idle check and the running-status keep-alive:
 *  a `result success` fires for EVERY assistant message, including turns that
 *  ENDED in tool_use — the tool then executes (possibly for minutes) while
 *  the CLI keeps listening on stdin. B2: only tool_use WITHIN the current
 *  turn counts — an interrupted turn (Stop/ESC) leaves a tool_use without a
 *  result in history forever; scanning all messages would flag the session
 *  never-idle and silently disable auto-compact (and keep the running green
 *  dot lit) for the rest of the session.
 *  Regression fixes: AskUserQuestion is stored as type 'question' (not
 *  tool_use) and the turn's result arrives BEFORE the user answers — an
 *  unanswered question must count as busy too. And `=== undefined` (not
 *  falsy) so a tool that legitimately returned an empty result ('') doesn't
 *  stall one round. */
export function hasPendingToolUseInTurn(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') break; // current turn starts here
    if (m.type === 'tool_use' && m.toolResultContent === undefined) return true;
    // A FAILED question answer is terminal — the CLI is not waiting on it
    // anymore; counting it as pending would keep the session 'running'
    // forever (green dot + queued input) with no way to resolve.
    if ((m.type === 'question' && !m.resolved && m.interactionState !== 'failed')
        || (m.type === 'permission' && m.interactionState === 'pending')) return true;
  }
  return false;
}

function tryFireAutoCompact(
  tabId: string,
  msg: { subtype?: string; usage?: StreamUsage },
): boolean {
  if (msg.subtype !== 'success') return false;
  const meta = useChatStore.getState().getTab(tabId)?.sessionMeta;
  const stdinId = meta?.stdinId;
  if (!stdinId || meta?.autoCompactFired) return false;
  // Never race a manual command's processing card (its pending slot owns the
  // stdin right now; a second write would clobber the card and break the
  // tok/s badge exclusion). A1: compactTurnPending covers the window after the
  // continuation cleared the card but before its result arrived.
  if (meta?.pendingCommandMsgId || meta?.compactTurnPending) return false;

  // Idle-only trigger: the CLI must be sitting at its input prompt before we
  // write /compact (see hasPendingToolUseInTurn for the full rationale).
  const messages = useChatStore.getState().getTab(tabId)?.messages ?? [];
  if (hasPendingToolUseInTurn(messages)) return false;

  const model = meta?.spawnedModel || meta?.snapshotModel || useSettingsStore.getState().selectedModel;
  const mode = meta?.snapshotContextWindowMode ?? useSettingsStore.getState().contextWindowMode;
  const settings = useSettingsStore.getState();
  const threshold = getAutoCompactThreshold(
    model,
    mode,
    settings.autoCompactThresholdTokens,
    settings.autoCompactMode,
  );
  // Align the trigger metric with the CLI's own SDK logic (binary-verified:
  // r = input + cacheCreation + cacheRead + output vs threshold). The
  // threshold already reserves OUTPUT_RESERVATION_TOKENS for the reply, so
  // counting output here matches its math — not counting it would leave the
  // reservation double-reserved and compact ~one reply too late.
  const contextTokens = fullInputContextTokens(msg.usage) + (msg.usage?.output_tokens ?? 0);
  if (contextTokens <= threshold) return false;

  const store = useChatStore.getState();
  store.setSessionMeta(tabId, { autoCompactFired: true, compactTurnPending: true });
  debugLog('auto-compact', 'triggered:', { contextTokens, threshold });
  const compactMsgId = generateMessageId();
  store.addMessage(tabId, {
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
  // Register pendingCommandMsgId so the result/assistant handler marks it completed.
  store.setSessionMeta(tabId, { pendingCommandMsgId: compactMsgId });
  store.setSessionStatus(tabId, 'running');
  store.setActivityStatus(tabId, { phase: 'thinking' });
  // Clear any leftover turn accounting — the compact summary's deltas are
  // excluded from the tok/s badge (isCompactInFlight), so turnTokens must
  // start from 0 for the badge to stay hidden during and after compaction.
  useTokenSpeedStore.getState().reset(tabId);
  bridge.sendStdin(stdinId, '/compact').catch((err) => {
    console.error('[LITTLECLAUDE] Auto-compact failed:', err);
    // Fail loudly, not silently (A10): mark the card completed with the error
    // and recover the UI — otherwise the card spins forever and the session
    // stays 'running' until the timeout check fires a misleading "timed out".
    useChatStore.getState().updateMessage(tabId, compactMsgId, {
      commandCompleted: true,
      commandData: {
        command: '/compact',
        output: `Auto-compact failed: ${String(err)}`,
        completedAt: Date.now(),
      },
    });
    // B1: a failed send must not leave the per-session fired flag set — the
    // session would then never auto-compact again until the next spawn.
    useChatStore.getState().setSessionMeta(tabId, {
      pendingCommandMsgId: undefined,
      autoCompactFired: false,
      compactTurnPending: undefined,
    });
    const curStatus = useChatStore.getState().getTab(tabId)?.sessionStatus;
    if (curStatus === 'running') {
      useChatStore.getState().setSessionStatus(tabId, 'idle');
    }
  });
  scheduleCompactTimeoutCheck(tabId, compactMsgId, Date.now());
  return true;
}

/**
 * F1: Shared "capture CLI sessionId + promote draft" logic. Previously this ran
 * ONLY in the foreground handleStreamMessage — sending the first message then
 * switching tabs immediately left the draft un-promoted forever: a ghost draft
 * lingered in the session list while the disk session duplicate, once opened,
 * had two processes writing the same JSONL. The background entry point now
 * calls this too, so the promotion happens wherever the first session_id lands.
 */
function promoteDraftIfNeeded(tabId: string, cliSessionId: string | undefined): void {
  if (!cliSessionId) return;
  const currentId = useChatStore.getState().getTab(tabId)?.sessionMeta.sessionId;
  if (currentId === cliSessionId) return;
  useChatStore.getState().setSessionMeta(tabId, { sessionId: cliSessionId });
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
    // fix7: 随改名迁移其余 per-tab 键（streams/scrollAnchors/
    // tokenSpeedStore.tabs/_batchDedupCache），不留 draft_* 僵尸条目
    {
      const csNow = useChatStore.getState();
      const promotedStreams = new Map(csNow.streams);
      if (promotedStreams.has(tabId)) {
        const streamState = promotedStreams.get(tabId)!;
        promotedStreams.delete(tabId);
        promotedStreams.set(cliSessionId, streamState);
      }
      const promotedAnchors = { ...csNow.scrollAnchors };
      if (tabId in promotedAnchors) {
        promotedAnchors[cliSessionId] = promotedAnchors[tabId];
        delete promotedAnchors[tabId];
      }
      useChatStore.setState({ streams: promotedStreams, scrollAnchors: promotedAnchors });
      const speedTabs = useTokenSpeedStore.getState().tabs;
      if (speedTabs[tabId]) {
        const nextSpeedTabs = { ...speedTabs };
        nextSpeedTabs[cliSessionId] = nextSpeedTabs[tabId];
        delete nextSpeedTabs[tabId];
        useTokenSpeedStore.setState({ tabs: nextSpeedTabs });
      }
      migrateBatchDedupKey(tabId, cliSessionId);
    }
    useSessionStore.getState().promoteDraft(tabId, cliSessionId);
    // DSH panels key by sessionId: goal/todo/feedback seeded under the
    // draft tab id must move to the promoted id or they silently vanish
    // (GoalBar never shows, TodoDock loses the first plan, feedback
    // entries become unreachable).
    useGoalStore.getState().moveSession(tabId, cliSessionId);
    useTodoStore.getState().moveSession(tabId, cliSessionId);
    useFeedbackStore.getState().moveSession(tabId, cliSessionId);
  }

  useSessionStore.getState().fetchSessions();
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

    // F1: 与前台一致地捕获 CLI sessionId 并升级 draft —— 否则"发完首条消息
    // 立即切 tab"时 draft 永不升级（ghost draft + 磁盘重复项双写 JSONL）。
    promoteDraftIfNeeded(tabId, msg.session_id || msg.sessionId);

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
          // Skip the tok/s badge while /compact is in flight — the summary
          // output is compression speed (1000+ tok/s), not generation speed.
          if (!isCompactInFlight(tabId) && tokenCount > 0) {
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

        // Track tokens in background sessions (per-turn + cumulative total).
        // Skipped while a /compact card is pending — the summary request's
        // usage is compression overhead, not dialogue. Same semantics-aware
        // last-wins input handling as the foreground path (DeepSeek-style
        // message_start reports the FULL input incl. cached share; opencode's
        // tail usage arrives on the final message_delta — log each turn's
        // input exactly once via the turnInputLogged gate).
        if (evt.type === 'message_start' && !isCompactInFlight(tabId)) {
          const bgTab = store.getTab(tabId);
          if (evt.message?.usage?.input_tokens) {
            const full = semanticContextTokens({
              input: evt.message.usage.input_tokens,
              cacheRead: evt.message.usage.cache_read_input_tokens || 0,
              cacheCreation: evt.message.usage.cache_creation_input_tokens || 0,
            });
            const cacheRead = evt.message.usage.cache_read_input_tokens || 0;
            const cacheCreation = evt.message.usage.cache_creation_input_tokens || 0;
            store.setSessionMeta(tabId, {
              inputTokens: full,
              totalInputTokens: (bgTab?.sessionMeta.totalInputTokens || 0) + full,
              cacheReadTokens: cacheRead,
              totalCacheReadTokens: (bgTab?.sessionMeta.totalCacheReadTokens || 0) + cacheRead,
              cacheCreationTokens: cacheCreation,
              totalCacheCreationTokens: (bgTab?.sessionMeta.totalCacheCreationTokens || 0) + cacheCreation,
              // Live Ctx bar (same as foreground): surface this request's full
              // context now instead of freezing on the previous turn's value.
              contextTokens: full,
              contextInputTokens: evt.message.usage.input_tokens,
              contextCacheReadTokens: cacheRead,
              contextCacheCreationTokens: cacheCreation,
              turnInputLogged: true,
            });
          } else {
            store.setSessionMeta(tabId, { turnInputLogged: undefined });
          }
        }
        if (evt.type === 'message_delta' && evt.usage?.output_tokens
            && !isCompactInFlight(tabId)) {
          const bgTab = store.getTab(tabId);
          const u = evt.usage;
          const deltaOut = u.output_tokens || 0;
          const updates: Parameters<typeof store.setSessionMeta>[1] = {
            outputTokens: (bgTab?.sessionMeta.outputTokens || 0) + deltaOut,
            totalOutputTokens: (bgTab?.sessionMeta.totalOutputTokens || 0) + deltaOut,
          };
          // DSH backend: per-step requests — accumulate every step's input
          // (no single-request gate), Ctx bar stays last-wins.
          const bgIsDsh = useSettingsStore.getState().cliBackend === 'deepseek';
          if (u.input_tokens && (bgIsDsh || !bgTab?.sessionMeta.turnInputLogged)) {
            const full = semanticContextTokens({
              input: u.input_tokens,
              cacheRead: u.cache_read_input_tokens || 0,
              cacheCreation: u.cache_creation_input_tokens || 0,
            });
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreation = u.cache_creation_input_tokens || 0;
            updates.inputTokens = full;
            updates.totalInputTokens = (bgTab?.sessionMeta.totalInputTokens || 0) + full;
            updates.cacheReadTokens = cacheRead;
            updates.totalCacheReadTokens = (bgTab?.sessionMeta.totalCacheReadTokens || 0) + cacheRead;
            updates.cacheCreationTokens = cacheCreation;
            updates.totalCacheCreationTokens = (bgTab?.sessionMeta.totalCacheCreationTokens || 0) + cacheCreation;
            // Same live-Ctx-bar treatment as message_start (see above).
            updates.contextTokens = full;
            updates.contextInputTokens = u.input_tokens;
            updates.contextCacheReadTokens = cacheRead;
            updates.contextCacheCreationTokens = cacheCreation;
            if (!bgIsDsh) {
              updates.turnInputLogged = true;
            }
          }
          store.setSessionMeta(tabId, updates);
          // NOTE: Usage persistence for the proxy path happens in Rust
          // (anthropic_proxy → usage_log). Accumulation above is runtime display.
        }
        // DSH todo plan (background tabs): mirror the foreground handling so a
        // background tab's TodoDock stays current and the plan survives the
        // tab switch back (turn/start clears the standing plan).
        if (evt.type === 'todo_update' && Array.isArray(evt.todos)) {
          useTodoStore.getState().update(tabId, evt.todos);
        }
        if (evt.type === 'turn_start') {
          useTodoStore.getState().clear(tabId);
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
        // A1: same compact-turn flagging as the foreground path — the
        // continuation clears the card before the 'result' arrives.
        const bgPendingCmd = store.getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        if (bgPendingCmd) {
          const bgPendingCmdData = (store.getTab(tabId)?.messages ?? [])
            .find((m) => m.id === bgPendingCmd)?.commandData;
          if (bgPendingCmdData?.command === '/compact') {
            store.setSessionMeta(tabId, { pendingCommandMsgId: undefined, compactTurnPending: true });
          } else {
            store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
          }
          store.updateMessage(tabId, bgPendingCmd, {
            commandCompleted: true,
            commandData: {
              ...bgPendingCmdData,
              completedAt: Date.now(),
            },
          });
        }
        // Skip text blocks when AskUserQuestion is present — the
        // interactive question UI makes them redundant.
        const bgHasAskUserQuestion = content.some(
          (b: any) => b.type === 'tool_use' && b.name === 'AskUserQuestion',
        );
        // M7: materialize thinking blocks to the background transcript too —
        // the foreground path dedups against re-delivery; without the same
        // handling here, a session that thought while backgrounded shows NO
        // thinking bubbles after switching back (only a reload would).
        const bgThinkingBlocks = content.filter(
          (b: any) => b.type === 'thinking' && b.thinking,
        );
        for (const tblock of bgThinkingBlocks) {
          const thinkingText: string = tblock.thinking;
          const bgMsgs = store.getTab(tabId)?.messages ?? [];
          let lastThinking: ChatMessage | undefined;
          for (let i = bgMsgs.length - 1; i >= 0; i--) {
            if (bgMsgs[i].role === 'user') break; // stay within this turn
            if (bgMsgs[i].type === 'thinking') { lastThinking = bgMsgs[i]; break; }
          }
          if (lastThinking && lastThinking.content === thinkingText) continue;
          if (lastThinking && thinkingText.startsWith(lastThinking.content)) {
            store.updateMessage(tabId, lastThinking.id, { content: thinkingText });
            continue;
          }
          if (lastThinking && lastThinking.content.startsWith(thinkingText)) continue;
          store.addMessage(tabId, {
            id: generateMessageId(),
            role: 'assistant',
            type: 'thinking',
            content: thinkingText,
            timestamp: Date.now(),
          });
        }

        // Collect and batch-add all new messages in a single set()
        const bgNewMessages: ChatMessage[] = [];
        for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
          const block = content[blockIdx];
          if (block.type === 'text') {
            if (bgHasAskUserQuestion) continue;
            // C2: same system-text filter as the foreground path — background
            // tabs must not cache /compact continuation summaries either.
            if (isSystemText(block.text || '')) {
              // A1: CLI-internal compaction detection (see foreground path).
              if (/^This session is being continued/i.test((block.text || '').trimStart())
                  // Regression fix: Task subagent streams share the process —
                  // exclude them (see foreground path).
                  && !msg.parent_tool_use_id
                  && !store.getTab(tabId)?.sessionMeta.pendingCommandMsgId) {
                store.setSessionMeta(tabId, { compactTurnPending: true });
              }
              continue;
            }
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
              // fix5: 对齐前台——哨兵 id + 先精确后模糊（任意未决问题卡）查重
              const bgQuestionId = block.id || 'ask_question_current';
              const bgSnap = store.getTab(tabId);
              const bgExisting = bgSnap?.messages.find(
                (m) => m.id === bgQuestionId && m.type === 'question',
              ) || bgSnap?.messages.find(
                (m) => m.type === 'question' && !m.resolved && m.toolName === 'AskUserQuestion',
              );
              if (bgExisting) {
                // fix5: 已存在（可能由 control_request 路径创建并带 permissionData）——
                // 只补 awaiting 状态，不新建卡片
                if (!bgExisting.resolved) {
                  store.setActivityStatus(tabId, { phase: 'awaiting' });
                }
                break;
              }

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
                toolInput: capToolInput(block.input), timestamp: Date.now(),
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
                toolInput: capToolInput(block.input), timestamp: Date.now(),
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
              // No `&& resultText` gate — empty results must still resolve the
              // tool_use or the pending-tool check keeps the session running.
              if (block.tool_use_id) {
                store.updateMessage(tabId, block.tool_use_id, { toolResultContent: capToolResult(resultText) });
              }
            }
          }
        }
        // M7: mirror the foreground checkpoint storage — a background user
        // message without checkpointUuid leaves every turn checkpoint-less,
        // which disables Rewind file restore for backgrounded sessions.
        {
          const isToolResult = Array.isArray(userContent)
            && userContent.some((b: any) => b.type === 'tool_result');
          if (msg.uuid && !isToolResult) {
            const bgMsgs = store.getTab(tabId)?.messages ?? [];
            for (let i = bgMsgs.length - 1; i >= 0; i--) {
              if (bgMsgs[i].role === 'user') {
                store.updateMessage(tabId, bgMsgs[i].id, { checkpointUuid: msg.uuid });
                break;
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
        // Keep the sidebar's green dot lit while the turn's tools are still
        // executing: a result success ending in tool_use means the CLI is busy
        // running that tool (possibly for minutes) — same idle semantic as
        // hasPendingToolUseInTurn. The dot then extinguishes on the result of
        // a turn that actually finished (or on exit/error).
        const bgHasPendingTool = hasPendingToolUseInTurn(store.getTab(tabId)?.messages ?? []);
        // U3: 用户主动停止 —— 被中断回合的 result 到达时保持 'stopped' 语义
        const bgStopStdinId = msg.__stdinId as string | undefined;
        const bgStopped = !!bgStopStdinId && consumeStoppedStdin(bgStopStdinId);
        if (bgStopped) {
          store.setSessionStatus(tabId, 'stopped');
          store.setActivityStatus(tabId, { phase: 'idle', statusMessage: t('session.stopped') });
        } else if (msg.subtype !== 'success' || !bgHasPendingTool) {
          store.setSessionStatus(tabId, msg.subtype === 'success' ? 'completed' : 'error');
        }
        // U2: 后台完成通知 —— 窗口失焦时弹，点击聚焦并跳回对应会话
        if (msg.subtype === 'success' && !bgStopped && !document.hasFocus()) {
          showNotificationWithJump(tabId, t('notification.chatComplete'));
        }
        // T02: DSH fork anchor — the deepseek translator stamps the result
        // with the mux seq of the turn's FINAL event (dsh_seq). Park it on
        // the tab's sessionMeta; InputBar copies it onto the next user
        // message as its session.fork rewind point. Non-DSH results never
        // carry dsh_seq, so this is deepseek-only by construction.
        if (typeof msg.dsh_seq === 'number' && msg.dsh_seq > 0) {
          store.setSessionMeta(tabId, { pendingDshSeq: msg.dsh_seq });
        }
        // Capture the compact-turn flag BEFORE the pending slot is cleared
        // below (same rule as the foreground path): the compact summary
        // request's usage is compression overhead, not dialogue — excluded
        // from the session's conversation token stats.
        const bgPendingCmd = store.getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        // A1: same as foreground — honor compactTurnPending (the continuation
        // may already have cleared the card slot before this result).
        const bgMetaCompactPending = store.getTab(tabId)?.sessionMeta.compactTurnPending === true;
        const bgWasCompact = bgMetaCompactPending
          || (!!bgPendingCmd
            && (store.getTab(tabId)?.messages ?? [])
              .find((m) => m.id === bgPendingCmd)?.commandData?.command === '/compact');
        if (bgMetaCompactPending) {
          store.setSessionMeta(tabId, { compactTurnPending: undefined });
        }
        if (msg.subtype !== 'success' && bgWasCompact) {
          // B1: same as foreground — a failed compact turn must not leave the
          // per-session fired flag set, or auto-compact dies until next spawn.
          store.setSessionMeta(tabId, { autoCompactFired: false });
        }
        // B10: complete a pending slash-command card on the background path —
        // same as the foreground result case, so /compact etc. don't hang.
        {
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
        // Compact summary turns never touch the conversation token stats
        // (same rule as the foreground path — the card shows its cost).
        if (!bgWasCompact) {
          const bgTab = store.getTab(tabId);
          const prevMeta = bgTab?.sessionMeta;
          const resultOutput = msg.usage?.output_tokens || 0;
          const streamedOutput = prevMeta?.outputTokens || 0;
          const bd = fullInputContextBreakdown(msg.usage);
          // E1: same semantics-aware drift correction as the foreground path —
          // streamedInput is the semantic FULL input, so the raw input_tokens
          // field must not be subtracted from it (negative on every Anthropic
          // turn); when the stream never logged this turn (no usage on
          // message_start/delta), log the authoritative value in full. Clamps
          // keep usage-less failed results from draining the totals.
          const resultFull = semanticContextTokens(bd);
          const streamedLogged = prevMeta?.turnInputLogged === true;
          const streamedInput = prevMeta?.inputTokens || 0;
          const streamedCacheRead = prevMeta?.cacheReadTokens || 0;
          const streamedCacheCreation = prevMeta?.cacheCreationTokens || 0;
          // DSH backend: same rule as the foreground path — per-step usage was
          // accumulated live from message_delta; the result's usage is the
          // turn SUM and must not be added again (Ctx bar stays last-wins).
          const bgIsDshResult = useSettingsStore.getState().cliBackend === 'deepseek';
          store.setSessionMeta(tabId, {
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            turns: msg.num_turns,
            ...(bgIsDshResult
              ? {
                  inputTokens: prevMeta?.inputTokens,
                  outputTokens: prevMeta?.outputTokens,
                  cacheReadTokens: prevMeta?.cacheReadTokens,
                  cacheCreationTokens: prevMeta?.cacheCreationTokens,
                }
              : {
                  inputTokens: resultFull,
                  outputTokens: resultOutput,
                  totalInputTokens: (prevMeta?.totalInputTokens || 0)
                    + (streamedLogged ? Math.max(0, resultFull - streamedInput) : resultFull),
                  totalOutputTokens: (prevMeta?.totalOutputTokens || 0)
                    + Math.max(0, resultOutput - streamedOutput),
                  totalCacheReadTokens: (prevMeta?.totalCacheReadTokens || 0)
                    + (streamedLogged ? Math.max(0, bd.cacheRead - streamedCacheRead) : bd.cacheRead),
                  totalCacheCreationTokens: (prevMeta?.totalCacheCreationTokens || 0)
                    + (streamedLogged ? Math.max(0, bd.cacheCreation - streamedCacheCreation) : bd.cacheCreation),
                  cacheReadTokens: bd.cacheRead,
                  cacheCreationTokens: bd.cacheCreation,
                  // B2/E2: full last-request context (incl. cached), same as foreground.
                  // Usage-less results keep the streamed value instead of blanking.
                  ...(resultFull > 0 ? {
                    contextTokens: resultFull,
                    // Breakdown for the Ctx bar tooltip + cache-miss detection
                    contextInputTokens: bd.input,
                    contextCacheReadTokens: bd.cacheRead,
                    contextCacheCreationTokens: bd.cacheCreation,
                  } : {}),
                }),
            turnStartTime: undefined,
            lastProgressAt: undefined,
            // Turn finished — the per-turn input gate resets with it (the next
            // message_start re-arms logging for the fresh turn).
            turnInputLogged: undefined,
          });
          // F3: runtime learning — same evidence rule as the foreground path
          // (success turn with >900K of context ⇒ real window is ≥1M).
          const bgLearnedModel = prevMeta?.model || prevMeta?.spawnedModel || prevMeta?.snapshotModel;
          if (msg.subtype === 'success' && resultFull > 900_000 && bgLearnedModel) {
            const settings = useSettingsStore.getState();
            if (!settings.learned1mModels[bgLearnedModel]) {
              settings.learnModel1m(bgLearnedModel);
              showToast(t('ctx.learned1m'), 'info');
            }
          }
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
        } else {
          // Same reset as the foreground path — a background /compact must
          // also drop the Ctx bar to 0 instead of keeping the pre-compact
          // value until the next normal turn refreshes it.
          store.setSessionMeta(tabId, {
            contextTokens: 0,
            contextInputTokens: 0,
            contextCacheReadTokens: 0,
            contextCacheCreationTokens: 0,
          });
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
        // F9: 对齐前台——失败回合且无可显示结果文本时补系统错误消息，
        // 否则后台会话的失败完全静默（只剩红点，用户不知道为什么）
        if (msg.subtype !== 'success') {
          const bgResultText = (typeof msg.result === 'string' && msg.result)
            || (typeof msg.content === 'string' && msg.content)
            || '';
          // U3: 用户主动停止的回合不补错误消息（中断是预期结果）
          if (!bgResultText && !bgStopped) {
            const bgErrField: any = msg.error;
            const bgResField: any = msg.result;
            const bgRawErr =
              (typeof bgErrField === 'string' && bgErrField)
              || bgErrField?.message
              || (typeof bgResField === 'object' && bgResField !== null && bgResField?.message)
              || (typeof bgResField === 'object' && bgResField !== null && bgResField?.reason)
              || 'Unknown error';
            // U1: 带分类 —— MessageBubble 渲染动作按钮
            const bgFormatted = classifyError(String(bgRawErr));
            store.addMessage(tabId, {
              id: generateMessageId(),
              role: 'system',
              type: 'text',
              content: bgFormatted.text,
              errorCategory: bgFormatted.category,
              timestamp: Date.now(),
            });
          }
          // U2: 后台错误通知 —— 点击聚焦窗口并跳回对应会话（窗口失焦时才弹，
          // 与完成通知的门控一致；后台成功通知沿用完成路径，不重复弹）
          if (!bgStopped && !document.hasFocus()) {
            showNotificationWithJump(tabId, t('notification.chatError'));
          }
        }
        // B5: background tabs also auto-compact (previously foreground-only, so
        // a long session left running in a background tab could hit the context
        // limit with no warning). Same trigger logic as foreground.
        // A1: never re-trigger on a compact turn's own result (double compact).
        const bgCompacted = !bgWasCompact && tryFireAutoCompact(tabId, msg);
        // FIFO drain for background tabs (#142/#70): same logic as foreground.
        if (!bgCompacted) {
          const bgDrainTab = store.getTab(tabId);
          // fix4: 同前台——先读 stdinId，可用才出队，缺失时消息留在队列
          const bgFlushStdinId = bgDrainTab?.sessionMeta.stdinId;
          const bgNextMsg = bgFlushStdinId ? store.shiftPendingMessage(tabId) : undefined;
          if (bgNextMsg && bgFlushStdinId) {
            store.setSessionStatus(tabId, 'running');
            store.setSessionMeta(tabId, { turnStartTime: Date.now(), turnStartSource: 'auto', lastProgressAt: Date.now(), inputTokens: 0, outputTokens: 0, compactTurnPending: undefined });
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
            // D2: DSH 后端后台 tab 同样不走 LLM 标题——首条用户消息截断作标题。
            if (bgTab?.sessionMeta.sessionOrigin === 'deepseek') {
              if (bgUserMsgs.length >= 3) {
                const firstUser = bgUserMsgs[0]?.content?.trim();
                if (firstUser) {
                  useSessionStore.getState().setCustomPreview(tabId, firstUser.slice(0, 40));
                }
              }
            } else {
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
        }
        break;
      }
      // DSH context alignment (background tabs): same treatment as foreground —
      // projections and compaction land in the per-tab sessionMeta cache while
      // the tab is away, so the Ctx bar is correct on switch-back.
      case 'context_update':
      case 'compaction_start':
      case 'compaction_summary':
      case 'compaction_end': {
        if (msg.type === 'context_update') {
          applyDshContextUpdate(tabId, msg);
        } else {
          applyDshCompaction(tabId, msg);
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
        // fix11: 与前台一致——被 Stop/kill 杀掉的进程，迟到 exit 按 stale 处理
        if (bgStdinId && _killedStdinIds.has(bgStdinId)) {
          _killedStdinIds.delete(bgStdinId);
          flushStreamBuffer(bgStdinId);
          cleanupStreamListener(bgStdinId);
          useSessionStore.getState().unregisterStdinTab(bgStdinId);
          break;
        }
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
        // U3: 用户主动停止的后台会话（中断后进程自行退出）保持 'stopped' 语义
        const bgExitStopped = !!bgStdinId && consumeStoppedStdin(bgStdinId);
        store.setSessionStatus(tabId, bgExitStopped ? 'stopped' : 'idle');
        if (bgExitStopped) {
          store.setActivityStatus(tabId, { phase: 'idle', statusMessage: t('session.stopped') });
        }
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
          // A1: no result will ever consume compactTurnPending after the
          // process died — clear it so the next turn isn't misclassified.
          // (Same regression fix as foreground: reset the fired flag when a
          // compact was interrupted mid-run.)
          if (store.getTab(tabId)?.sessionMeta.compactTurnPending) {
            store.setSessionMeta(tabId, { compactTurnPending: undefined, autoCompactFired: false });
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
          // U1: 带分类 —— MessageBubble 渲染动作按钮
          const bgSysFormatted = classifyError(msg.message || msg.error || 'System error');
          store.addMessage(tabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: bgSysFormatted.text,
            errorCategory: bgSysFormatted.category,
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

    // Capture the CLI's own session ID from stream events (used for --resume).
    // F1: sessionId 捕获 + draft 升级抽成共享函数，后台路径同样执行。
    promoteDraftIfNeeded(tabId, msg.session_id || msg.sessionId);

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
          // Skip the tok/s badge while /compact is in flight — the summary
          // output is compression speed (1000+ tok/s), not generation speed.
          if (!isCompactInFlight(tabId) && tokenCount > 0) {
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

        // TodoDock (DSH todo/write): whole-list replacement for the standing
        // plan — render per-item status (spinner / checkmark) above the composer.
        if (evt.type === 'todo_update' && Array.isArray(evt.todos)) {
          useTodoStore.getState().update(tabId, evt.todos);
        }
        // DSH lifetime rule: turn/start clears the standing plan (latest
        // todo/write with no later turn/start).
        if (evt.type === 'turn_start') {
          useTodoStore.getState().clear(tabId);
        }

        // New assistant turn begins — reset the token speed badge so the
        // pinned average clears before this turn's tokens start counting.
        if (evt.type === 'message_start') {
          useTokenSpeedStore.getState().reset(tabId);
        }

        // Track input tokens from message_start (per-turn + cumulative total).
        // Skipped while a /compact card is pending — the summary request's
        // usage is compression overhead, not dialogue.
        if (evt.type === 'message_start' && !isCompactInFlight(tabId)) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          if (evt.message?.usage?.input_tokens) {
            // DeepSeek-style usage reports the FULL input incl. the cached
            // share on message_start — it is the turn's whole context, so it
            // OVERWRITES the per-turn counter and is logged into the totals
            // exactly once (turnInputLogged gate), instead of being summed like
            // an Anthropic increment (that summed the full context every turn
            // and the bar inflated N-fold before each result corrected it).
            const full = semanticContextTokens({
              input: evt.message.usage.input_tokens,
              cacheRead: evt.message.usage.cache_read_input_tokens || 0,
              cacheCreation: evt.message.usage.cache_creation_input_tokens || 0,
            });
            const cacheRead = evt.message.usage.cache_read_input_tokens || 0;
            const cacheCreation = evt.message.usage.cache_creation_input_tokens || 0;
            setSessionMeta({
              inputTokens: full,
              totalInputTokens: (meta.totalInputTokens || 0) + full,
              cacheReadTokens: cacheRead,
              totalCacheReadTokens: (meta.totalCacheReadTokens || 0) + cacheRead,
              cacheCreationTokens: cacheCreation,
              totalCacheCreationTokens: (meta.totalCacheCreationTokens || 0) + cacheCreation,
              // Live Ctx bar: this usage IS the request's full context — surface
              // it on message_start instead of freezing the bar on the previous
              // turn's value until the result event arrives.
              contextTokens: full,
              contextInputTokens: evt.message.usage.input_tokens,
              contextCacheReadTokens: cacheRead,
              contextCacheCreationTokens: cacheCreation,
              turnInputLogged: true,
            });
          } else {
            // Anthropic-style message_start carries no usable usage — reset the
            // gate so the final message_delta (opencode tail usage) can log
            // this turn's input instead. A fresh message_start always means a
            // fresh turn, so a stale gate from an interrupted turn is cleared.
            setSessionMeta({ turnInputLogged: undefined });
          }
        }

        // Track output tokens from message_delta (per-turn + cumulative total)
        if (evt.type === 'message_delta' && evt.usage?.output_tokens
            && !isCompactInFlight(tabId)) {
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const u = evt.usage;
          const deltaOut = u.output_tokens || 0;
          const updates: Parameters<typeof setSessionMeta>[0] = {
            outputTokens: (meta.outputTokens || 0) + deltaOut,
            totalOutputTokens: (meta.totalOutputTokens || 0) + deltaOut,
          };
          // DSH backend: every step is an INDEPENDENT API request and DSH
          // emits one usage message_delta per step — accumulate each step's
          // input into the totals (no turnInputLogged gate, which is designed
          // for single-request turns and would drop all but the first step).
          // Ctx bar stays last-wins (current request's full context).
          const isDsh = useSettingsStore.getState().cliBackend === 'deepseek';
          if (u.input_tokens && (isDsh || !meta.turnInputLogged)) {
            const full = semanticContextTokens({
              input: u.input_tokens,
              cacheRead: u.cache_read_input_tokens || 0,
              cacheCreation: u.cache_creation_input_tokens || 0,
            });
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreation = u.cache_creation_input_tokens || 0;
            updates.inputTokens = full;
            updates.totalInputTokens = (meta.totalInputTokens || 0) + full;
            updates.cacheReadTokens = cacheRead;
            updates.totalCacheReadTokens = (meta.totalCacheReadTokens || 0) + cacheRead;
            updates.cacheCreationTokens = cacheCreation;
            updates.totalCacheCreationTokens = (meta.totalCacheCreationTokens || 0) + cacheCreation;
            // Same live-Ctx-bar treatment as message_start — the tail usage is
            // this request's full context, surface it now, not at result.
            updates.contextTokens = full;
            updates.contextInputTokens = u.input_tokens;
            updates.contextCacheReadTokens = cacheRead;
            updates.contextCacheCreationTokens = cacheCreation;
            if (!isDsh) {
              updates.turnInputLogged = true;
            }
          }
          setSessionMeta(updates);
          // NOTE: Usage persistence for the OpenAI-compat proxy path now happens
          // in Rust (anthropic_proxy writes the authoritative usage directly to
          // usage_log). The CLI drops message_delta fields it doesn't know, so
          // relying on this stream to persist would double-count or miss. The
          // accumulation above only feeds the live per-turn runtime display.
        }
        break;
      }

      case 'system':
        if (msg.subtype === 'init') {
          setSessionMeta({ model: msg.model });
        } else if (msg.subtype === 'error') {
          // FI-3: Surface system-level errors instead of silently dropping them
          const rawError = msg.message || msg.error || 'System error';
          // U1: 带分类 —— MessageBubble 渲染动作按钮
          const sysFormatted = classifyError(rawError);
          addMessage({
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: sysFormatted.text,
            errorCategory: sysFormatted.category,
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
          const pendingCmdData = (useChatStore.getState().getTab(tabId)?.messages ?? [])
            .find((m) => m.id === pendingCmd)?.commandData;
          // A1: a /compact continuation arrives as an 'assistant' event BEFORE
          // the 'result'. The card completes here and the pending slot clears —
          // the result handler's wasCompactTurn check (which reads that slot)
          // would then miss the turn and pollute token stats / re-fire
          // auto-compact. Flag it so the result still recognizes the turn.
          if (pendingCmdData?.command === '/compact') {
            useChatStore.getState().setSessionMeta(tabId, {
              pendingCommandMsgId: undefined,
              compactTurnPending: true,
            });
          } else {
            useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
          }
          useChatStore.getState().updateMessage(tabId, pendingCmd, {
            commandCompleted: true,
            commandData: {
              ...pendingCmdData,
              completedAt: Date.now(),
            },
          });
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
            // C2: hide system-injected content in the live stream too, matching
            // session-loader's reload behavior (isSystemText). Without this, a
            // /compact continuation summary renders as a normal assistant
            // message in the live session but disappears after reload.
            if (isSystemText(block.text || '')) {
              // A1: CLI-internal compaction (CLAUDE_CODE_AUTO_COMPACT_WINDOW
              // injected at spawn) streams a continuation with NO pending card.
              // Flag the turn so its result is excluded from token stats and
              // never re-fires auto-compact. Matches only the explicit
              // continuation marker — other isSystemText matches (tool
              // definitions, reminders) are not compact turns.
              if (/^This session is being continued/i.test((block.text || '').trimStart())
                  // Regression fix: a Task subagent runs INSIDE the same CLI
                  // process — its own internal compact must not flag the MAIN
                  // session's turn (the flag is only consumed by main results).
                  && !msg.parent_tool_use_id
                  && !useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId) {
                useChatStore.getState().setSessionMeta(tabId, { compactTurnPending: true });
              }
              continue;
            }
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
                toolInput: capToolInput(block.input),
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
                toolInput: capToolInput(block.input),
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
              // No `&& resultText` gate: a tool that legitimately returned an
              // EMPTY result must still be marked resolved (toolResultContent
              // = '' ≠ undefined), or the pending-tool idle check keeps the
              // session 'running' forever and the input queue deadlocks.
              if (tuId) {
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
              // No `&& resultText` gate — empty results must still resolve the
              // tool_use (see the sibling path above).
              if (block.tool_use_id) {
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

        // T02: DSH fork anchor — the deepseek translator stamps the result
        // with the mux seq of the turn's FINAL event (dsh_seq). Park it on
        // the tab's sessionMeta; InputBar copies it onto the next user
        // message as its session.fork rewind point. Non-DSH results never
        // carry dsh_seq, so this is deepseek-only by construction.
        if (typeof msg.dsh_seq === 'number' && msg.dsh_seq > 0) {
          setSessionMeta({ pendingDshSeq: msg.dsh_seq });
        }

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
                  turnStartSource: 'auto',
                  lastProgressAt: retryTurnStartedAt,
                  inputTokens: 0,
                  outputTokens: 0,
                  // A1-defensive: stale compact markers never outlive their turn.
                  compactTurnPending: undefined,
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
                // H4: register the retry process to the tab that OWNED the
                // failed message (outer `tabId`), not the currently selected
                // tab — re-reading selectedSessionId here would route the
                // whole retry stream into whichever conversation the user
                // switched to during the async startSession. (No cache sync
                // needed: restoreFromCache no longer overwrites sessionMeta —
                // the live tabs map is the single source of truth.)
                useSessionStore.getState().registerStdinTab(retryId, tabId);
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
          // fix14: 仅在输入框为空时写入；非空则直接发送，不动编辑器内容
          const resumeDraft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
          if (!resumeDraft.trim()) {
            setInputSync('Continue.');
            requestAnimationFrame(() => handleSubmitRef.current());
          } else {
            handleSubmitRef.current('Continue.', { preserveDraft: true });
          }
          break;
        }
        // H2: turn over without auto-restart — drop this tab's flag slot.
        delete _getExitPlanMap(exitPlanModeSeenRef)[tabId];

        // Mark pending processing card (CLI slash command) as completed
        const pendingCmdMsgId = useChatStore.getState().getTab(tabId)?.sessionMeta.pendingCommandMsgId;
        // Capture the compact-turn flag BEFORE the pending slot is cleared
        // below: a card bound to '/compact' means this result is the compact
        // summary request. Its usage is compression overhead, not dialogue —
        // it must not pollute the session's conversation token stats (the card
        // itself already displays the cost summary).
        // A1: the assistant continuation clears the pending slot BEFORE this
        // result arrives — also honor compactTurnPending (set on send or on
        // continuation detection), else the summary turn would be counted as a
        // normal turn and re-trigger auto-compact (double compact).
        const metaCompactTurnPending = useChatStore.getState().getTab(tabId)?.sessionMeta.compactTurnPending === true;
        const wasCompactTurn = metaCompactTurnPending
          || (!!pendingCmdMsgId
            && (useChatStore.getState().getTab(tabId)?.messages ?? [])
              .find((m) => m.id === pendingCmdMsgId)?.commandData?.command === '/compact');
        if (metaCompactTurnPending) {
          // Consume the in-flight marker now that its result has arrived.
          useChatStore.getState().setSessionMeta(tabId, { compactTurnPending: undefined });
        }
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
        if (resultDisplayText && !pendingCmdMsgId && !isSystemText(resultDisplayText)) {
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

        // A failed turn with no displayable result text (DSH turn/end errors
        // carry objects, not strings) used to fail SILENTLY — the tab just
        // flipped to a red dot and the user had no idea why. Surface the
        // error detail as a classified system message.
        // U3: 用户主动停止触发的中断 result 不补错误消息（中断是预期结果）
        if (msg.subtype !== 'success' && !resultDisplayText
            && !(msgStdinId && isStoppedStdinActive(msgStdinId))) {
          const errField: any = msg.error;
          const resField: any = msg.result;
          const rawErr =
            (typeof errField === 'string' && errField)
            || errField?.message
            || (typeof resField === 'object' && resField !== null && resField?.message)
            || (typeof resField === 'object' && resField !== null && resField?.reason)
            || 'Unknown error';
          // U1: 带分类 —— MessageBubble 渲染动作按钮
          const fgFormatted = classifyError(String(rawErr));
          addMessage({
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: fgFormatted.text,
            errorCategory: fgFormatted.category,
            timestamp: Date.now(),
          });
        }

        // Keep the sidebar's green dot lit while the turn's tools are still
        // executing: a result success ending in tool_use means the CLI is busy
        // running that tool (possibly for minutes) — same idle semantic as
        // hasPendingToolUseInTurn. The dot then extinguishes on the result of
        // a turn that actually finished (or on exit/error).
        const fgHasPendingTool = hasPendingToolUseInTurn(
          useChatStore.getState().getTab(tabId)?.messages ?? [],
        );
        // U3: 用户主动停止 —— 被中断回合的 result 到达时消费停止标记，
        // 保持 'stopped' 语义（琥珀点），不覆盖成 completed/error
        const fgStopped = !!msgStdinId && consumeStoppedStdin(msgStdinId);
        if (fgStopped) {
          setSessionStatus('stopped');
          setActivityStatus({ phase: 'idle', statusMessage: t('session.stopped') });
        } else if (msg.subtype !== 'success' || !fgHasPendingTool) {
          setSessionStatus(
            msg.subtype === 'success' ? 'completed' : 'error'
          );
        }
        // Sync error status to ActivityIndicator for real-time user feedback
        if (msg.subtype !== 'success' && !fgStopped) {
          setActivityStatus({ phase: 'error', statusMessage: t('chat.error') });
        }
        if (msg.subtype !== 'success') {
          // B1: a failed compact turn must not leave the per-session fired
          // flag set — the session would then never auto-compact again until
          // the next spawn (a long session would keep growing unchecked).
          if (wasCompactTurn) {
            setSessionMeta({ autoCompactFired: false });
          }
        }
        // Compact summary turns never touch the conversation token stats —
        // the /compact card already shows its cost; counting it here would
        // inflate totalInputTokens/totalOutputTokens and overwrite contextTokens
        // (the summary request's small context is not the session's context).
        if (!wasCompactTurn) {
          // Correct cumulative totals for any drift between streaming
          // accumulation and the authoritative result values.
          const meta = useChatStore.getState().getTab(tabId)?.sessionMeta ?? {};
          const resultOutput = msg.usage?.output_tokens || 0;
          const streamedOutput = meta.outputTokens || 0;
          const bd = fullInputContextBreakdown(msg.usage);
          // E1: the drift correction must use the SAME semantics-aware metric as
          // the streaming path. streamedInput holds the semantic FULL input
          // (input + cache for Anthropic-style endpoints), while the raw
          // input_tokens field is only the uncached remainder — subtracting raw
          // from full was negative on every Anthropic turn, deflating the
          // sidebar's cumulative input counter toward zero (DeepSeek-style
          // input already includes the cached share, so the mismatch hid there).
          // The turnInputLogged gate tells us whether the stream logged this
          // turn at all: logged → correct drift; not logged (no usage on
          // message_start/delta) → log the authoritative value in full. The
          // max(0, …) clamps keep a usage-less failed result from writing
          // negative deltas that would drain the totals.
          const resultFull = semanticContextTokens(bd);
          const streamedLogged = meta.turnInputLogged === true;
          const streamedInput = meta.inputTokens || 0;
          const streamedCacheRead = meta.cacheReadTokens || 0;
          const streamedCacheCreation = meta.cacheCreationTokens || 0;
          // DSH backend: every step's usage was already accumulated live from
          // message_delta events (each step is an independent request), and
          // the result's usage is the turn SUM — adding it again would
          // double-count, and the Ctx bar must stay last-wins (the current
          // request's context), not the turn sum.
          const isDshResult = useSettingsStore.getState().cliBackend === 'deepseek';
          const baseMeta = {
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
            turns: msg.num_turns,
            turnStartTime: undefined,
            lastProgressAt: undefined,
            // Turn finished — the per-turn input gate resets with it (the next
            // message_start re-arms logging for the fresh turn).
            turnInputLogged: undefined,
          };
          setSessionMeta({
            ...baseMeta,
            ...(isDshResult
              ? {
                  // Keep the live per-step values; nothing to correct at result.
                  inputTokens: meta.inputTokens,
                  outputTokens: meta.outputTokens,
                  cacheReadTokens: meta.cacheReadTokens,
                  cacheCreationTokens: meta.cacheCreationTokens,
                }
              : {
                  inputTokens: resultFull,
                  outputTokens: resultOutput,
                  totalInputTokens: (meta.totalInputTokens || 0)
                    + (streamedLogged ? Math.max(0, resultFull - streamedInput) : resultFull),
                  totalOutputTokens: (meta.totalOutputTokens || 0)
                    + Math.max(0, resultOutput - streamedOutput),
                  totalCacheReadTokens: (meta.totalCacheReadTokens || 0)
                    + (streamedLogged ? Math.max(0, bd.cacheRead - streamedCacheRead) : bd.cacheRead),
                  totalCacheCreationTokens: (meta.totalCacheCreationTokens || 0)
                    + (streamedLogged ? Math.max(0, bd.cacheCreation - streamedCacheCreation) : bd.cacheCreation),
                  cacheReadTokens: bd.cacheRead,
                  cacheCreationTokens: bd.cacheCreation,
                  // B2/E2: full last-request context (incl. cached) for the Ctx bar —
                  // input_tokens alone undercounts by the cache-read share. When the
                  // result carries no usable usage (CLI writes zero/missing), keep
                  // the streamed value instead of blanking the bar.
                  ...(resultFull > 0 ? {
                    contextTokens: resultFull,
                    // Breakdown for the Ctx bar tooltip + cache-miss detection
                    contextInputTokens: bd.input,
                    contextCacheReadTokens: bd.cacheRead,
                    contextCacheCreationTokens: bd.cacheCreation,
                  } : {}),
                }),
          });
          // F3: runtime learning — a success turn whose context exceeded 900K
          // proves the model's real window is ≥1M (a 200K-class model would
          // have been rejected by the API long before that point). Record it
          // so the next spawn declares 1M automatically — the fallback for
          // models the LiteLLM table doesn't know. The fired-once
          // autoCompactFired flag means a long session can grow past 200K
          // post-compact, so this evidence actually arrives.
          const learnedModel = meta.model || meta.spawnedModel || meta.snapshotModel;
          if (msg.subtype === 'success' && resultFull > 900_000 && learnedModel) {
            const settings = useSettingsStore.getState();
            if (!settings.learned1mModels[learnedModel]) {
              settings.learnModel1m(learnedModel);
              showToast(t('ctx.learned1m'), 'info');
            }
          }
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
        } else {
          // /compact rewrote the context — the Ctx bar must drop now, not
          // keep the pre-compact ≈100% until the next normal turn refreshes
          // it (the compact summary's own small context is compression
          // overhead, not the session's context — see comment above).
          setSessionMeta({
            contextTokens: 0,
            contextInputTokens: 0,
            contextCacheReadTokens: 0,
            contextCacheCreationTokens: 0,
          });
        }
        agentActions.completeAll(
          msg.subtype === 'success' ? 'completed' : 'error'
        );
        // Completion system notification: when the main window is unfocused
        // (task finished while user is elsewhere), notify. Mirrors the
        // process-exit notification path. Only on success — errors are noisy.
        // U2: 通知点击 → window.focus() + 选中对应会话
        if (msg.subtype === 'success' && !fgStopped && !document.hasFocus()) {
          showNotificationWithJump(tabId, t('notification.chatComplete'));
        }
        useSessionStore.getState().fetchSessions();
        setTimeout(() => useSessionStore.getState().fetchSessions(), 1000);

        // --- AI Title Generation (TK-001): on 3rd successful turn, generate a title ---
        if (msg.subtype === 'success') {
          const fgTabMeta = useChatStore.getState().getTab(tabId)?.sessionMeta;
          const sessionId = fgTabMeta?.sessionId;
          if (sessionId) {
            const customPreviews = useSessionStore.getState().customPreviews;
            if (!customPreviews[sessionId]) {
              const currentMessages = (useChatStore.getState().getTab(tabId)?.messages ?? []);
              const userTextMsgs = currentMessages.filter(
                (m) => m.role === 'user' && m.type === 'text' && m.content,
              );
              // D2: DSH 后端会话不走 LLM 标题（generate_session_title 依赖 claude
              // 一次性进程，纯 DSH 用户没装 claude CLI 时会静默失败）——直接取
              // 首条用户消息前 40 字符作标题。claude/codex 保持现有 LLM 路径。
              if (fgTabMeta?.sessionOrigin === 'deepseek') {
                if (userTextMsgs.length >= 3) {
                  const firstUser = userTextMsgs[0]?.content?.trim();
                  if (firstUser) {
                    useSessionStore.getState().setCustomPreview(sessionId, firstUser.slice(0, 40));
                  }
                }
              } else if (userTextMsgs.length >= 3) {
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
        // Fires at most once per session (per-tab flag) to avoid infinite loops.
        // B1/B3/B4 fixes live in tryFireAutoCompact (full-context comparison,
        // per-tab fired flag, activity-aware timeout).
        // A1: never re-trigger on a compact turn's own result — the summary
        // request's input ≈ the pre-compact context, still over the threshold;
        // firing here would double-compact after manual / CLI-internal compacts.
        if (!wasCompactTurn && tryFireAutoCompact(tabId, msg)) {
          break; // Skip pending message flush — compact takes priority
        }

        // F12: 失败回合命中限流/额度类错误时跳过 FIFO drain——继续发射排队
        // 消息只会连环 429；toast 提示（rateLimits.resetsAt 有值时给倒计时）。
        // 排队消息留在队列，用户稍后手动触发或新回合成功时自然恢复 drain。
        let fgRateLimited = false;
        if (msg.subtype !== 'success') {
          const rlErrField: any = msg.error;
          const rlResField: any = msg.result;
          const rlErrText = String(
            (typeof rlErrField === 'string' && rlErrField)
            || rlErrField?.message
            || (typeof rlResField === 'string' && rlResField)
            || (typeof rlResField === 'object' && rlResField !== null && rlResField?.message)
            || (typeof rlResField === 'object' && rlResField !== null && rlResField?.reason)
            || '',
          );
          fgRateLimited = /429|rate.?limit|too.many.request|quota|insufficient.*balance|余额|额度|限流|配额/i.test(rlErrText);
        }
        if (fgRateLimited) {
          const rlLimits = Object.values(useChatStore.getState().getTab(tabId)?.sessionMeta.rateLimits ?? {});
          const rlNow = Date.now();
          const rlFutureResets = rlLimits
            .map((l) => l?.resetsAt)
            .filter((v): v is number => typeof v === 'number' && v > rlNow);
          if (rlFutureResets.length > 0) {
            const rlSecs = Math.max(0, Math.round((Math.min(...rlFutureResets) - rlNow) / 1000));
            const rlCountdown = `${String(Math.floor(rlSecs / 60)).padStart(2, '0')}:${String(rlSecs % 60).padStart(2, '0')}`;
            showToast(t('chat.rateLimitedCountdown').replace('{time}', rlCountdown), 'info');
          } else {
            showToast(t('chat.rateLimited'), 'info');
          }
          break;
        }

        // FIFO drain: dequeue ONE pending message and send it (#142/#70).
        // When this turn completes, the next result event will dequeue the next one.
        // Previously all pending messages were joined and sent at once, which could
        // overwhelm the CLI. Sequential turn-by-turn processing is safer.
        {
          const drainTab = useChatStore.getState().getTab(tabId);
          // fix4: 先读 stdinId，可用才出队——否则 stdinId 缺失时排队消息凭空消失
          const flushStdinId = drainTab?.sessionMeta.stdinId;
          const nextMsg = flushStdinId ? useChatStore.getState().shiftPendingMessage(tabId) : undefined;
          if (nextMsg && flushStdinId) {
            const nextTurnStartedAt = Date.now();
            setSessionStatus('running');
            setSessionMeta({
              turnStartTime: nextTurnStartedAt,
              turnStartSource: 'auto',
              lastProgressAt: nextTurnStartedAt,
              inputTokens: 0,
              outputTokens: 0,
              // A1-defensive: stale compact markers never outlive their turn
              // (see InputBar send — same rationale).
              compactTurnPending: undefined,
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

      // DSH context alignment: live occupancy (context_update projection) and
      // the compaction lifecycle. The projection pushes on usage / request/
      // context — so the Ctx bar refreshes mid-turn instead of freezing on the
      // previous turn's result; compaction events drop it immediately.
      case 'context_update':
      case 'compaction_start':
      case 'compaction_summary':
      case 'compaction_end': {
        if (msg.type === 'context_update') {
          applyDshContextUpdate(tabId, msg);
        } else {
          applyDshCompaction(tabId, msg);
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
        // fix11: Stop/kill 杀掉的进程，其迟到 exit 一律按 stale 处理——
        // 不回滚 completed→idle，也不弹"任务完成"通知
        if (exitStdinId && _killedStdinIds.has(exitStdinId)) {
          _killedStdinIds.delete(exitStdinId);
          debugLog('session', 'process_exit from killed process treated as stale', { stdinId: exitStdinId });
          flushStreamBuffer(exitStdinId);
          cleanupStreamListener(exitStdinId);
          useSessionStore.getState().unregisterStdinTab(exitStdinId);
          break;
        }
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
        // A1: a dead process means no result will ever consume compactTurnPending —
        // clear it so the next turn's result isn't misclassified as a compact turn.
        // Regression fix: also reset the fired flag when a compact was interrupted
        // mid-run (Stop/kill/rewind) — the spawn-time reset covers fresh starts,
        // not a process that died while a compact was in flight.
        if (useChatStore.getState().getTab(tabId)?.sessionMeta.compactTurnPending) {
          useChatStore.getState().setSessionMeta(tabId, {
            compactTurnPending: undefined,
            autoCompactFired: false,
          });
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
              // U1: 带分类 —— MessageBubble 渲染动作按钮
              const exitFormatted = classifyError(`CLI error: ${stderr}${hint}`);
              addMessage({
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: exitFormatted.text,
                errorCategory: exitFormatted.category,
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

        // U3: 用户主动停止后进程自行退出（中断使 CLI 直接退出、或 deepseek
        // kill≙cancel）——保持 'stopped' 语义，不回退成 idle。_killedStdinIds
        // 里的 kill 退出已在上方按 stale 早退；这里覆盖"未被 kill 的主动停止"。
        // 用 exitingStdinId（含 sessionMeta 回退），与 markStoppedStdin 的键一致。
        const exitStopped = !!exitingStdinId && consumeStoppedStdin(exitingStdinId);
        setSessionStatus(exitStopped ? 'stopped' : 'idle');
        if (exitStopped) {
          setActivityStatus({ phase: 'idle', statusMessage: t('session.stopped') });
        }
        // B6: a process exit (interrupt, error, or kill) may arrive without a
        // final assistant message — clear any residual partial text so the UI
        // never shows a frozen half-bubble from the dead session.
        {
          const newStreams = new Map(useChatStore.getState().streams);
          newStreams.set(tabId, { partialText: '', partialThinking: '', isStreaming: false });
          useChatStore.setState({ streams: newStreams });
        }
        // F10: 通知区分成败——仅当退出前状态为 completed 或已有过 assistant
        // 回复才弹"任务完成"；error/启动失败退出一律不弹（此前一律弹成功通知）
        // U2: 通知点击 → window.focus() + 选中对应会话；U3: 主动停止不弹完成通知
        const exitHadReply = exitMsgs.some(
          (m: ChatMessage) => m.role === 'assistant' && (m.type === 'text' || m.type === 'tool_use'),
        );
        if ((exitStatus === 'completed' || exitHadReply) && !exitStopped && !document.hasFocus()) {
          showNotificationWithJump(tabId, t('notification.chatComplete'));
        }

        setSessionMeta({ stdinId: undefined, lastProgressAt: undefined });
        // Session exited — stop any live token speed badge.
        useTokenSpeedStore.getState().end(tabId);
        // Drop the per-tab progress throttle entry (session is over) — the
        // background branch already does this; without it the module-level
        // map grows one entry per foreground session, forever.
        _lastProgressThrottle.delete(tabId);
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
  }, [handleBackgroundStreamMessage, exitPlanModeSeenRef, silentRestartRef, handleSubmitRef, handleStderrLineRef, setInputSync]);

  return { handleStreamMessage, handleBackgroundStreamMessage };
}
