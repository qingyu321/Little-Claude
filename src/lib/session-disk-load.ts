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
 */
export async function loadSessionFromDisk(
  sessionId: string,
  sessionPath: string,
  sessionOrigin?: string,
): Promise<void> {
  useChatStore.getState().ensureTab(sessionId);
  const { clearMessages, batchAddMessages, setSessionStatus, setSessionMeta } = useChatStore.getState();
  const agentActions = useAgentStore.getState();
  clearMessages(sessionId);
  agentActions.clearAgents();
  setSessionStatus(sessionId, 'running');
  // TK-329: explicitly clear stdinId when loading from disk — no live process exists yet.
  // Only set the CLI UUID (for resume). Prevents inheriting a stale stdinId
  // from a previous session that might still be alive in the backend.
  setSessionMeta(sessionId, {
    sessionId,
    stdinId: undefined,
    sessionOrigin: sessionOrigin || 'claude',
  });

  try {
    const rawMessages = await bridge.loadSession(sessionPath);
    if (useSessionStore.getState().selectedSessionId !== sessionId) {
      // F7: 加载中途被切走——复位状态，否则该 tab 永久卡在 running
      setSessionStatus(sessionId, 'idle');
      return;
    }
    const { messages, agents, usage } = parseSessionMessages(rawMessages);

    // Restore token/context stats from the JSONL — the Ctx bar and sidebar
    // counters are in-memory (written on result events), so without this a
    // reopened session reads 0% / 0 tokens until the next turn's result.
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
      agentActions.upsertAgent(agent);
    }

    // fix16: 收集完所有消息后一次 batchAddMessages 入库（tool_result 已由
    // session-loader 合并进对应消息），替代逐条 addMessage 的 O(N²) 拷贝
    batchAddMessages(sessionId, messages);

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
