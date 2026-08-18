/**
 * useRewind — orchestration hook for the Rewind feature.
 * Manages turn parsing, kill-process, message truncation, code restore,
 * and summarization. Uses CLI native checkpoint system for file restoration.
 *
 * 5 actions after selecting a turn:
 *   1. Restore code and conversation — revert both
 *   2. Restore conversation only — keep code, rewind messages
 *   3. Restore code only — keep conversation, revert files
 *   4. Summarize from here — compress messages after selected point
 *   5. Cancel
 */
import { useMemo, useCallback } from 'react';
import { useChatStore, useActiveTab, getActiveTabState, generateMessageId } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { cleanupStreamListener, clearLegacyListener } from '../lib/stream-cleanup';
import { useSettingsStore } from '../stores/settingsStore';
import { bridge } from '../lib/tauri-bridge';
import { parseTurns, type Turn } from '../lib/turns';
import { t } from '../lib/i18n';
import { debugLog } from '../lib/debug-log';
import { showToast } from '../components/shared/Toast';

export type RewindAction = 'restore_all' | 'restore_conversation' | 'restore_code' | 'summarize';

/**
 * Restore files to a CLI checkpoint via bridge.rewindFiles().
 * Returns true if files were restored, false if no checkpoint available.
 * B3d: session context (stdinId/sessionId/cwd) is captured ONCE by the caller
 * and passed in — re-reading the active tab inside an await would target a
 * different session if the user switched tabs mid-restore.
 */
async function restoreFilesViaCheckpoint(
  turn: Turn,
  stdinId: string,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  if (!turn.checkpointUuid) return false;
  if (!sessionId || !cwd) return false;

  try {
    // Primary: SDK control protocol via stdin (fast, in-process)
    // Fallback: spawn new CLI process (slow, full initialization)
    await bridge.rewindFiles(stdinId || '', turn.checkpointUuid, sessionId, cwd);
    return true;
  } catch (err) {
    console.error('[rewind] rewindFiles failed:', err);
    // A10: distinguish "no checkpoint" (silent — the UI already shows its own
    // hint) from "checkpoint exists but the restore call failed" — the user
    // must know their files were NOT rolled back.
    showToast(t('rewind.restoreFailed'), 'error');
    return false;
  }
}

export function useRewind() {
  const messages = useActiveTab((t) => t.messages);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);

  const turns = useMemo(() => parseTurns(messages), [messages]);

  /** Button visible as long as there are user messages */
  const showRewind = turns.length >= 1;
  /** Button enabled when there is at least 1 turn and not running */
  const canRewind = turns.length >= 1 && sessionStatus !== 'running';

  /** Kill the current CLI process and clean up listeners */
  const killProcess = useCallback(async () => {
    const state = getActiveTabState();
    const stdinId = state.sessionMeta.stdinId;
    if (stdinId) {
      await bridge.killSession(stdinId).catch(() => {});
      cleanupStreamListener(stdinId);
      clearLegacyListener();
    }
  }, []);

  /** Reset session state after rewind.
   *  Clears stdinId (the dead process link) always. sessionId (the CLI UUID)
   *  is KEPT by default — executeRewind truncates the CLI session JSONL to
   *  the rewind point first, so the next message `--resume`s the pre-rewind
   *  history instead of starting a fresh, context-less session. Only when
   *  truncation failed (or history is fully cleared) does the caller pass
   *  clearSessionId=true to fall back to a fresh session. */
  const resetSession = useCallback((clearSessionId = false) => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (!tid) return;
    useChatStore.getState().setSessionStatus(tid, 'idle');
    useChatStore.getState().setSessionMeta(tid, clearSessionId
      ? { stdinId: undefined, sessionId: undefined }
      : { stdinId: undefined });
  }, []);

  /** Save rewound state to tab cache */
  const saveToTab = useCallback(() => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (tabId) {
      useChatStore.getState().saveToCache(tabId);
    }
  }, []);

  /**
   * T02: DSH fork-style rewind (deepseek backend).
   *
   * DSH has no checkpoint layer and no JSONL truncation — the only
   * session-level rollback is `session.fork`, which copies events up to a
   * completed-turn boundary into a new child session (source kept on the
   * server, files untouched). `turn.dshSeq` is the mux seq of the turn that
   * completed BEFORE the selected turn (stamped on the turn's user message),
   * so forking at it keeps exactly the turns before the selection.
   *
   * On success the backend migrates the tab's DSH mapping / mux route /
   * translator / seq watermark to the child (same stdinId keeps streaming),
   * so here we only truncate the local memory view — no process kill, no
   * listener churn. Summarize forks too, keeping the backend context in sync
   * with the truncated UI.
   */
  const executeDshForkRewind = useCallback(async (
    tid: string,
    turn: Turn,
    action: RewindAction,
    state: ReturnType<typeof getActiveTabState>,
  ) => {
    if (action === 'restore_code') {
      // Defensive: the panel disables it for DSH (no checkpoint layer).
      showToast(t('rewind.dsh.noFileRollback'), 'error');
      return;
    }
    const stdinId = state.sessionMeta.stdinId;
    if (!stdinId) {
      showToast(t('rewind.dsh.noSession'), 'error');
      return;
    }
    if (turn.dshSeq === undefined || turn.dshSeq <= 0) {
      // First turn (nothing completed before it) or a turn whose predecessor
      // never produced a turn/end anchor (killed mid-turn, disk-loaded
      // history) — DSH cannot cut there.
      showToast(t('rewind.dsh.forkUnavailable'), 'error');
      return;
    }
    const atSeq = turn.dshSeq;
    let newSid = '';
    try {
      newSid = await bridge.dshForkSession(stdinId, atSeq);
    } catch (err) {
      console.error('[useRewind] dshForkSession failed:', err);
      const raw = String(err);
      // fork-unavailable: atSeq landed inside a still-open turn (or the
      // session has no completed turn) — surface the dedicated hint.
      const friendly = /fork-unavailable|not completed the turn|no completed turn/i.test(raw)
        ? t('rewind.dsh.forkUnavailable')
        : t('rewind.dsh.forkFailed').replace('{err}', raw);
      showToast(friendly, 'error');
      return;
    }
    debugLog('rewind', 'DSH fork ok', { stdinId, atSeq, newSid, turn: turn.index });

    // Grab the original prompt BEFORE truncating (restored to the input box).
    const originalUserText = state.messages[turn.startMsgIdx]?.content || '';

    // Local memory truncation — reuses the claude-path primitive.
    useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
    useChatStore.getState().setInputDraft(tid, originalUserText);
    // The child session's last completed turn ends exactly at the fork
    // boundary — re-seed the anchor so a next user message sent BEFORE the
    // child's first result still carries a correct fork point.
    useChatStore.getState().setSessionMeta(tid, { pendingDshSeq: atSeq });
    useChatStore.getState().setSessionStatus(tid, 'idle');

    // Transcript action card (same pattern as the claude path); summarize
    // additionally compresses the discarded turns into a summary block.
    let content = t('rewind.dsh.success');
    if (action === 'summarize') {
      const summaryParts: string[] = [];
      for (const m of state.messages.slice(turn.startMsgIdx)) {
        if (m.role === 'user' && m.content) {
          summaryParts.push(`**User:** ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`);
        } else if (m.role === 'assistant' && m.type === 'text' && m.content) {
          summaryParts.push(`**Claude:** ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`);
        } else if (m.type === 'tool_use' && m.toolName) {
          const fp = m.toolInput?.file_path || m.toolInput?.command || '';
          summaryParts.push(`**${m.toolName}:** ${String(fp).slice(0, 100)}`);
        }
      }
      const summaryHeader = t('rewind.summaryTitle')
        .replace('{from}', String(turn.index))
        .replace('{to}', String(turns.length));
      content = `**${summaryHeader}**\n\n${summaryParts.join('\n\n')}\n\n${t('rewind.dsh.success')}`;
    }
    useChatStore.getState().addMessage(tid, {
      id: generateMessageId(),
      role: 'system',
      type: 'text',
      content,
      commandType: 'action',
      commandData: { action: 'rewind', turnIndex: turn.index, mode: `dsh_fork:${action}` },
      timestamp: Date.now(),
    });
    showToast(t('rewind.dsh.success'), 'success');
  }, [turns.length]);

  /**
   * Execute rewind with a specific action.
   * All actions restore the user's original input text to the input box.
   */
  const executeRewind = useCallback(async (turn: Turn, action: RewindAction = 'restore_conversation') => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (!tid) return;
    const state = getActiveTabState();

    // Guard: validate turn index
    if (turn.startMsgIdx < 0 || turn.startMsgIdx > state.messages.length) {
      console.error('[useRewind] Invalid turn startMsgIdx:', turn.startMsgIdx);
      return;
    }

    // T02: deepseek backend — fork-style rewind (see executeDshForkRewind).
    // Prefer the session's own origin over the global setting (survives a
    // backend switch mid-app); fresh tabs fall back to cliBackend. Claude /
    // codex keep the legacy checkpoint path below, completely untouched.
    const sessionBackend = state.sessionMeta.sessionOrigin
      || state.sessionMeta.snapshotCliBackend
      || useSettingsStore.getState().cliBackend;
    if (sessionBackend === 'deepseek') {
      await executeDshForkRewind(tid, turn, action, state);
      saveToTab();
      return;
    }

    // For file-restore actions, send rewind via stdin BEFORE killing the process
    // (SDK control protocol is fast and needs the process alive). B3d: capture
    // stdinId/sessionId/cwd ONCE here and pass them through — the earlier
    // implementation re-read the active tab inside restoreFilesViaCheckpoint,
    // so switching tabs mid-restore targeted the wrong session.
    const needsFileRestore = action === 'restore_all' || action === 'restore_code';
    const restoreStdinId = state.sessionMeta.stdinId;
    const restoreSessionId = state.sessionMeta.sessionId;
    const restoreCwd = useSettingsStore.getState().workingDirectory;
    let fileRestoreOk = false;
    if (needsFileRestore && turn.checkpointUuid) {
      try {
        fileRestoreOk = await restoreFilesViaCheckpoint(
          turn,
          restoreStdinId || '',
          restoreSessionId || '',
          restoreCwd || '',
        );
      } catch { /* handled below */ }
    }

    // Kill CLI process after file restore (or immediately for non-file actions)
    try {
      await killProcess();
    } catch (err) {
      console.warn('[useRewind] Failed to kill process:', err);
    }

    // Truncate the CLI session JSONL to the rewind point so the next message
    // --resume's ONLY the pre-rewind history (real CLI context: previous tool
    // results, code state — not the rewind-discarded turns). Truncation
    // failures fall back to the old behavior: clear sessionId and start fresh.
    // restore_code keeps the full conversation, so the JSONL is untouched and
    // resume brings back the complete history (which is its intended semantic).
    let clearSessionId = false;
    const rewindSessionId = state.sessionMeta.sessionId;
    const rewindCwd = useSettingsStore.getState().workingDirectory;
    if (action !== 'restore_code' && rewindSessionId && !rewindSessionId.startsWith('desk_') && rewindCwd) {
      try {
        const kept = await bridge.truncateSessionHistory(rewindSessionId, rewindCwd, turn.index);
        if (kept === null) {
          // Rewound to turn 1: the file was deleted, nothing to resume.
          clearSessionId = true;
        }
        debugLog('rewind', 'truncated CLI session history', { keptLines: kept, turn: turn.index });
      } catch (err) {
        console.warn('[useRewind] truncateSessionHistory failed — falling back to fresh session:', err);
        clearSessionId = true;
      }
    }

    // Grab original text before truncating
    const originalUserText = state.messages[turn.startMsgIdx]?.content || '';

    try {
      switch (action) {
        case 'restore_all': {
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession(clearSessionId);
          useChatStore.getState().setInputDraft(tid, originalUserText);

          const successMsg = fileRestoreOk
            ? t('rewind.successAll').replace('{n}', String(turn.index))
            : t('rewind.successAllNoFiles').replace('{n}', String(turn.index));
          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: successMsg,
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'restore_all' },
            timestamp: Date.now(),
          });
          break;
        }

        case 'restore_conversation': {
          // Only restore conversation (keep code as-is) — instant, no CLI call
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession(clearSessionId);
          useChatStore.getState().setInputDraft(tid, originalUserText);

          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: t('rewind.success').replace('{n}', String(turn.index)),
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'restore_conversation' },
            timestamp: Date.now(),
          });
          break;
        }

        case 'restore_code': {
          // Don't truncate messages — keep full conversation; sessionId kept
          // so the next message resumes the complete (untruncated) history.
          resetSession();
          useChatStore.getState().setInputDraft(tid, originalUserText);

          const codeMsg = fileRestoreOk
            ? t('rewind.successCode').replace('{n}', String(turn.index))
            : t('rewind.codeRestoreFailed');
          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: codeMsg,
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'restore_code' },
            timestamp: Date.now(),
          });
          break;
        }

        case 'summarize': {
          // Compress messages from this turn onwards into a summary.
          // Messages before the selected turn stay intact (full detail).
          const msgsToSummarize = state.messages.slice(turn.startMsgIdx);
          const summaryParts: string[] = [];

          for (const m of msgsToSummarize) {
            if (m.role === 'user' && m.content) {
              summaryParts.push(`**User:** ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`);
            } else if (m.role === 'assistant' && m.type === 'text' && m.content) {
              summaryParts.push(`**Claude:** ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`);
            } else if (m.type === 'tool_use' && m.toolName) {
              const fp = m.toolInput?.file_path || m.toolInput?.command || '';
              summaryParts.push(`**${m.toolName}:** ${String(fp).slice(0, 100)}`);
            }
          }

          // Truncate to selected point
          useChatStore.getState().rewindToTurn(tid, turn.startMsgIdx);
          resetSession(clearSessionId);

          // Add summary as a system message (preserves context without full messages)
          const totalTurns = turns.length;
          const summaryHeader = t('rewind.summaryTitle')
            .replace('{from}', String(turn.index))
            .replace('{to}', String(totalTurns));
          const summaryContent = `**${summaryHeader}**\n\n${summaryParts.join('\n\n')}`;

          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: summaryContent,
            commandType: 'action',
            commandData: { action: 'rewind', turnIndex: turn.index, mode: 'summarize' },
            timestamp: Date.now(),
          });
          break;
        }
      }
    } catch (err) {
      console.error('[useRewind] executeRewind failed:', err);
      // A10: rewindToTurn already truncated the conversation — the user needs
      // to know the operation didn't fully succeed, not just see it vanish.
      showToast(t('rewind.failed'), 'error');
      // Ensure we're in a recoverable state even if rewind failed
      resetSession();
    }

    // Save to cache
    saveToTab();
  }, [killProcess, resetSession, saveToTab, turns.length, executeDshForkRewind]);

  return { turns, showRewind, canRewind, executeRewind };
}
