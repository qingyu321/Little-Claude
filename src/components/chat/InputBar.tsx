import { useState, useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import type { WheelEvent as ReactWheelEvent } from 'react';
import { useChatStore, useActiveTab, getActiveTabState, generateMessageId } from '../../stores/chatStore';
import {
  useSettingsStore,
  MODEL_OPTIONS,
  mapSessionModeToPermissionMode,
  setSessionModeLocal,
  getContextWindowForModel,
  type ThinkingLevel,
} from '../../stores/settingsStore';
import { bridge, onClaudeStream, onClaudeStderr, onSessionExit, onPermissionRequest, type UnifiedCommand, type PermissionRequest } from '../../lib/tauri-bridge';
import {
  unifiedTurnsFromClaudeJsonl,
  unifiedTurnsFromChatMessages,
  unifiedTurnsFromDsh,
  formatUnifiedForInjection,
  buildHandoffBrief,
} from '../../lib/session-exporter';
import { encodeProjectName } from '../../lib/platform';
import { ModelSelector } from './ModelSelector';
import { ModeSelector } from './ModeSelector';
import { FileUploadChips } from './FileUploadChips';
// Perf: RewindPanel only mounts when opened — lazy-load it out of the
// always-loaded InputBar chunk (the performance batch left this one due to
// parallel-edit conflicts; now safe to do).
const RewindPanel = lazy(() => import('./RewindPanel').then(m => ({ default: m.RewindPanel })));
import { useFileAttachments } from '../../hooks/useFileAttachments';
import { useRewind } from '../../hooks/useRewind';
import { useStreamProcessor, flushStreamBuffer, resolveOwnerTab, classifyError, stopSessionGracefully } from '../../hooks/useStreamProcessor';
import { useAgentStore } from '../../stores/agentStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { useTokenSpeedStore } from '../../stores/tokenSpeedStore';
import { SlashCommandPopover, getFilteredCommandList } from './SlashCommandPopover';
import { useCommandStore } from '../../stores/commandStore';
import { useGoalStore } from '../../stores/goalStore';
import { GoalBar } from './GoalBar';
import { TodoDock } from './TodoDock';
import { cleanupStreamListener, registerStreamListener } from '../../lib/stream-cleanup';
// F2: steer 后端守卫的 toast 提示
import { showToast } from '../shared/Toast';
import { envFingerprint, resolveModelForProvider, resolveModelOrError, resolveThinkingLevelForProvider } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { PROVIDER_PRESETS } from '../../lib/provider-presets';
import { displayDeepSeekModelName } from '../../lib/model-utils';
import { stripAnsi } from '../../lib/strip-ansi';
import { debugLog, debugWarn } from '../../lib/debug-log';
import { usePlanPanelStore } from './ChatPanel';
import { PlanReviewCard } from './PlanReviewCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { TiptapEditor, type TiptapEditorHandle } from './TiptapEditor';
import { open } from '@tauri-apps/plugin-dialog';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
// drag-state import removed — tree drag handled by ChatPanel

/** Format a first-token latency: ≥1s → "1.2s", otherwise "850ms". */
function formatFirstToken(ms: number): string {
  if (!ms || ms < 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Thinking effort level configuration data */
const THINK_LEVELS: { id: ThinkingLevel; labelKey: string }[] = [
  { id: 'off', labelKey: 'think.off' },
  { id: 'low', labelKey: 'think.low' },
  { id: 'medium', labelKey: 'think.medium' },
  { id: 'high', labelKey: 'think.high' },
  { id: 'max', labelKey: 'think.max' },
];

/** Thinking effort level selector dropdown for the toolbar */
function ThinkLevelSelector({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel);
  const setThinkingLevel = useSettingsStore((s) => s.setThinkingLevel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const thinkingSupport = useProviderStore((s) => {
    if (!s.activeProviderId) return 'full';
    const provider = s.providers.find((p) => p.id === s.activeProviderId);
    if (!provider?.preset) return 'unknown';
    return PROVIDER_PRESETS.find((p) => p.id === provider.preset)?.thinkingSupport ?? 'unknown';
  });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isOff = thinkingLevel === 'off';
  const current = THINK_LEVELS.find((l) => l.id === thinkingLevel) || THINK_LEVELS[3];

  return (
    <div ref={ref} className={`relative ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <button
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs
          border transition-smooth cursor-pointer
          ${isOff
            ? 'border-border-subtle bg-bg-secondary/50 text-text-muted hover:text-text-primary hover:bg-bg-secondary'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-500'
          }`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="6" r="4" />
          <path d="M5.5 9.5C5.5 11.5 6 13 8 13s2.5-1.5 2.5-3.5" />
          <path d="M6.5 14h3" />
        </svg>
        <span className="font-medium">{t(current.labelKey)}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          <path d="M1.5 3L4 5.5 6.5 3" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[140px]
          bg-bg-card border border-border-subtle rounded-lg shadow-lg
          py-1 z-50 animate-fade-in">
          {THINK_LEVELS.map((level) => {
            const isActive = level.id === thinkingLevel;
            return (
              <button
                key={level.id}
                onClick={() => { setThinkingLevel(level.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs
                  transition-smooth cursor-pointer
                  ${isActive
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                {t(level.labelKey)}
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                    stroke="currentColor" strokeWidth="1.5" className="ml-auto">
                    <path d="M2.5 6l2.5 2.5 4.5-4.5" />
                  </svg>
                )}
              </button>
            );
          })}
          {thinkingSupport === 'ignored' && (
            <div className="px-3 py-1.5 text-[10px] text-text-tertiary border-t border-border-subtle mt-1">
              {t('think.providerIgnored')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * DeepSeek agent preset selector — sits right of the thinking-level toggle.
 * Mirrors the DeepSeek Harness preset picker: a master on/off switch plus the
 * live agentPreset.list roster (name + description + default badge + check).
 * When enabled, every DSH session is composed under the chosen preset — the
 * profile default is often a bootstrap preset that hides bash/web-search
 * behind a first-durable-tool-call reveal, so `standard` (full coding agent)
 * is the reliable baseline.
 */
interface DshPresetEntry {
  id: string;
  name: string;
  description?: string;
  trust?: string;
  isDefault?: boolean;
}

function AgentPresetSelector({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const enabled = useSettingsStore((s) => s.dshAgentPresetEnabled);
  const presetId = useSettingsStore((s) => s.dshAgentPreset);
  const cliBackend = useSettingsStore((s) => s.cliBackend);
  const setEnabled = useSettingsStore((s) => s.setDshAgentPresetEnabled);
  const setPreset = useSettingsStore((s) => s.setDshAgentPreset);
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<DshPresetEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const loadPresets = useCallback(async () => {
    setLoading(true);
    setLoadErr(false);
    try {
      const r = await bridge.listDshAgentPresets();
      setPresets(r?.presets ?? []);
    } catch {
      setLoadErr(true);
    }
    setLoading(false);
  }, []);

  // Presets are DSH-only — hide the control on claude/codex backends.
  if (cliBackend !== 'deepseek') return null;

  const currentName = presets?.find((p) => p.id === presetId)?.name || presetId;

  return (
    <div ref={ref} className={`relative ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <button
        onClick={() => { if (!open) void loadPresets(); setOpen(!open); }}
        title={t('agentPreset.tooltip')}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs
          border transition-smooth cursor-pointer
          ${!enabled
            ? 'border-border-subtle bg-bg-secondary/50 text-text-muted hover:text-text-primary hover:bg-bg-secondary'
            : 'border-sky-500/30 bg-sky-500/10 text-sky-500'
          }`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </svg>
        <span className="font-medium max-w-[120px] truncate">
          {enabled ? currentName : t('agentPreset.off')}
        </span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          <path d="M1.5 3L4 5.5 6.5 3" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-[300px]
          bg-bg-card border border-border-subtle rounded-lg shadow-lg
          py-1 z-50 animate-fade-in">
          {/* Master switch */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle">
            <span className="text-[11px] font-medium text-text-secondary">
              {t('agentPreset.title')}
            </span>
            <button
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={`relative w-8 h-4.5 rounded-full transition-smooth cursor-pointer ${
                enabled ? 'bg-sky-500' : 'bg-bg-layer-2 border border-border-subtle'
              }`}
            >
              <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                enabled ? 'left-[15px]' : 'left-0.5'
              }`} />
            </button>
          </div>

          {loading ? (
            <div className="px-3 py-2 text-[11px] text-text-tertiary">{t('agentPreset.loading')}</div>
          ) : loadErr ? (
            <div className="px-3 py-2 text-[11px] text-error">{t('agentPreset.loadError')}</div>
          ) : (
            <ul className="max-h-56 overflow-y-auto">
              {(presets ?? []).map((p) => {
                const active = enabled && p.id === presetId;
                return (
                  <li key={p.id}>
                    <button
                      onClick={() => { setPreset(p.id); setOpen(false); }}
                      className={`w-full flex items-start gap-2 px-3 py-1.5 text-left transition-smooth cursor-pointer
                        ${active ? 'bg-accent/10' : 'hover:bg-bg-secondary'}`}
                    >
                      <span className="flex-1 min-w-0">
                        <span className={`block text-xs ${active ? 'text-accent font-medium' : 'text-text-primary'}`}>
                          {p.name}
                          {p.isDefault && (
                            <span className="ml-1.5 text-[9px] px-1 py-px rounded bg-bg-layer-2 text-text-tertiary align-middle">
                              {t('agentPreset.defaultBadge')}
                            </span>
                          )}
                        </span>
                        {p.description ? (
                          <span className="block truncate text-[10px] text-text-tertiary mt-0.5">
                            {p.description}
                          </span>
                        ) : null}
                      </span>
                      {active && (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                          stroke="currentColor" strokeWidth="1.5" className="mt-1 text-accent shrink-0">
                          <path d="M2.5 6l2.5 2.5 4.5-4.5" />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })}
              {presets && presets.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-text-tertiary">
                  {t('agentPreset.empty')}
                </div>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function PlanToggleButton() {
  const t = useT();
  const isOpen = usePlanPanelStore((s) => s.open);
  const toggle = usePlanPanelStore((s) => s.toggle);
  const hasPlanMessages = useActiveTab((t) =>
    t.messages.some((m) => m.type === 'plan_review' || m.type === 'plan' || m.planContent),
  );
  const inPlanMode = useSettingsStore((s) => s.sessionMode) === 'plan';

  // Only show when in plan mode or there are plan-related messages
  if (!inPlanMode && !hasPlanMessages) return null;

  return (
    <button
      onClick={toggle}
      className={`p-1.5 rounded-lg transition-smooth flex items-center gap-1
        ${isOpen
          ? 'bg-accent/10 text-accent'
          : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
        }`}
      title={t('msg.viewPlan')}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M3 4h10M3 8h8M3 12h5" />
      </svg>
      <span className="text-[10px]">Plan</span>
    </button>
  );
}

/* PlanApprovalBar removed — PlanReviewCard (triggered by ExitPlanMode detection)
   is the proper plan approval UI. The fallback bar was too broad: it appeared on
   every completed session in plan/bypass mode, even without a real plan. */

/**
 * Wheel events over the input area never reach the message list: the whole
 * app chain is overflow-hidden and the list is a *sibling* scroller, not an
 * ancestor. Forward the wheel to the Virtuoso scroller so history stays
 * scrollable while typing. The editor itself keeps its wheel when it
 * overflows (multi-line input).
 */
function handleWheelForward(e: ReactWheelEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  const editorEl = target.closest('.ProseMirror');
  if (editorEl && editorEl.scrollHeight > editorEl.clientHeight) return;
  const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
  scroller.scrollTop += e.deltaY;
}

export function InputBar() {
  const t = useT();
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  // Live token speed badge state (per-tab, driven by useStreamProcessor)
  const tokenTabId = selectedSessionId || 'new';
  const tokenSpeedTab = useTokenSpeedStore((s) => s.tabs[tokenTabId]);
  const inputDraft = useActiveTab((t) => t.inputDraft);
  const setInputDraftStore = useChatStore((s) => s.setInputDraft);
  // Local alias for the store-backed draft
  const input = inputDraft;
  const setInput = useCallback((text: string) => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (tid) {
      useChatStore.getState().ensureTab(tid);
      setInputDraftStore(tid, text);
    }
  }, [setInputDraftStore]);
  const textareaRef = useRef<TiptapEditorHandle>(null);
  /** Sync both the Zustand store and the tiptap editor.
   *  Use this for all programmatic input changes (clear, set, etc.).
   *  The editor's onUpdate callback uses setInput directly to avoid circular updates. */
  const setInputSync = useCallback((text: string) => {
    setInput(text);
    textareaRef.current?.setText(text);
  }, [setInput]);

  /** Speech-to-text — enabled via settings toggle. */
  const speechEnabled = useSettingsStore((s) => s.speechEnabled);
  const speech = useSpeechRecognition();
  /** Inject confirmed speech text into the editor, then reset speech state. */
  const confirmSpeechInput = useCallback(() => {
    if (speech.editText) {
      setInputSync(speech.editText);
    }
    speech.confirmInput();
  }, [speech, setInputSync]);

  // Restore input text from store when session switches (restoreFromCache → inputDraft change)
  const prevInputDraftRef = useRef(inputDraft);
  useEffect(() => {
    if (prevInputDraftRef.current !== inputDraft) {
      // Never call setText during IME composition — it destroys the composing state
      if (textareaRef.current?.isComposing()) {
        prevInputDraftRef.current = inputDraft;
        return;
      }
      // Only sync editor if its content actually differs (avoid cursor reset on user typing)
      const current = textareaRef.current?.getText() ?? '';
      if (current !== inputDraft) {
        textareaRef.current?.setText(inputDraft);
      }
    }
    prevInputDraftRef.current = inputDraft;
  }, [inputDraft]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const activityPhase = useActiveTab((t) => t.activityStatus.phase);
  const activityToolName = useActiveTab((t) => t.activityStatus.toolName);
  // Whether the CLI is streaming right now (streamState), independent of the
  // token speed store which only starts counting on the first output token.
  const streamIsStreaming = useChatStore((s) => {
    if (!tokenTabId) return false;
    return s.getStreamState(tokenTabId).isStreaming;
  });
  const addMessage = useChatStore((s) => s.addMessage);
  const setSessionStatus = useChatStore((s) => s.setSessionStatus);
  const setSessionMeta = useChatStore((s) => s.setSessionMeta);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const sessionMode = useSettingsStore((s) => s.sessionMode);

  const handlePlanApprove = useCallback(async () => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    const currentMode = useSettingsStore.getState().sessionMode;
    const tabState = getActiveTabState();
    const meta = tabState.sessionMeta;
    const status = tabState.sessionStatus;

    // If CLI is still alive (e.g., Bypass auto-accepted ExitPlanMode),
    // just dismiss the card — no restart needed.
    if (meta.stdinId && status === 'running') {
      useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
      return;
    }

    // CLI exited after ExitPlanMode (permission denied in stream-json mode).
    // Plan mode: switch to Code mode for execution.
    // Bypass mode: stay in Bypass (no mode switch needed).
    if (currentMode === 'plan') {
      useSettingsStore.getState().setSessionMode('code');
    }

    // Clean up dead CLI process
    if (meta.stdinId) {
      useChatStore.getState().setSessionMeta(tabId, { stdinId: undefined });
      bridge.killSession(meta.stdinId).catch(() => {});
      cleanupStreamListener(meta.stdinId);
    }

    // Restart with --resume <sessionId>
    useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
    // fix14: 仅在输入框为空时写入；非空则直接发送，不动编辑器内容
    const planDraft = getActiveTabState().inputDraft || textareaRef.current?.getText() || '';
    if (!planDraft.trim()) {
      setInputSync('Execute the plan above.');
      requestAnimationFrame(() => {
        handleSubmitRef.current();
      });
    } else {
      handleSubmitRef.current('Execute the plan above.', { preserveDraft: true });
    }
  }, [setInputSync]);

  // Listen for plan-execute events from PlanReviewCard and Enter shortcut
  useEffect(() => {
    const handler = () => handlePlanApprove();
    window.addEventListener('little-claude:plan-execute', handler);
    return () => window.removeEventListener('little-claude:plan-execute', handler);
  }, [handlePlanApprove]);

  // Floating approval cards — unresolved plan_review / question messages
  // are rendered above the input instead of inline in the chat flow.
  const floatingCard = useActiveTab((tab) => {
    for (let i = tab.messages.length - 1; i >= 0; i--) {
      const m = tab.messages[i];
      if ((m.type === 'plan_review' || m.type === 'question' || m.type === 'permission') && !m.resolved) return m;
    }
    return null;
  });

  const { files, setFiles, isProcessing, addFiles, removeFile, clearFiles } = useFileAttachments();

  // Sync files → store.pendingAttachments so tab switch can persist them
  const setPendingAttachmentsStore = useChatStore((s) => s.setPendingAttachments);
  useEffect(() => {
    // fix13: 仅在有新附件时写入——files 清空时不覆写别的 tab 的附件
    // （切 tab 时本 effect 会以空 files 先跑一次，清空目标 tab 的存量附件）
    if (files.length === 0) return;
    const tid = useSessionStore.getState().selectedSessionId;
    if (tid) setPendingAttachmentsStore(tid, files);
  }, [files, setPendingAttachmentsStore]);

  // Restore files from store when tab switches back (pendingAttachments → local files)
  const pendingAttachments = useActiveTab((t) => t.pendingAttachments);
  const prevAttachmentsRef = useRef(pendingAttachments);
  useEffect(() => {
    // Only restore when store value changes externally (e.g. restoreFromCache)
    // and differs from current files
    if (prevAttachmentsRef.current !== pendingAttachments && pendingAttachments !== files) {
      setFiles(pendingAttachments);
    }
    prevAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments, setFiles]); // intentionally exclude `files` to avoid loop

  // Inline file insertion: drop or drag → insert a file chip at cursor
  useEffect(() => {
    const onTreeFileInline = (e: Event) => {
      const fullPath = (e as CustomEvent<string>).detail;
      if (!fullPath || !textareaRef.current) return;

      // Convert to path relative to working directory for readability
      const cwd = useSettingsStore.getState().workingDirectory;
      let displayPath = fullPath;
      if (cwd && fullPath.startsWith(cwd)) {
        displayPath = fullPath.slice(cwd.length).replace(/^[\\/]/, '');
      }

      textareaRef.current.insertFileChip({ fullPath, label: displayPath });
    };
    window.addEventListener('little-claude:tree-file-inline', onTreeFileInline);
    return () => window.removeEventListener('little-claude:tree-file-inline', onTreeFileInline);
  }, []);

  // Drive the token speed window recomputation while streaming (500ms cadence)
  useEffect(() => {
    if (!tokenSpeedTab?.isStreaming) return;
    const id = setInterval(() => useTokenSpeedStore.getState().tick(tokenTabId), 500);
    return () => clearInterval(id);
  }, [tokenTabId, tokenSpeedTab?.isStreaming]);

  // After streaming ends the final average stays pinned on the badge until
  // the next turn's message_start resets it (tokenSpeedStore.reset).

  // Slash command state
  const [slashQuery, setSlashQuery] = useState('');
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashCommands = useCommandStore((s) => s.commands);
  const activePrefix = useCommandStore((s) => s.activePrefix);

  // Focus input when activePrefix is set externally (e.g. from SkillsPanel "Use in Input")
  useEffect(() => {
    if (activePrefix) {
      textareaRef.current?.focus();
    }
  }, [activePrefix]);

  // Rewind state
  const [showRewindPanel, setShowRewindPanel] = useState(false);
  const { showRewind, canRewind } = useRewind();
  // lastEscTime removed — double-Esc rewind disabled (#36/#71)

  // Listen for rewind event from /rewind command
  useEffect(() => {
    const handler = () => {
      if (canRewind) {
        setShowRewindPanel(true);
      } else {
        const tid = useSessionStore.getState().selectedSessionId;
        if (tid) {
          useChatStore.getState().addMessage(tid, {
            id: generateMessageId(), role: 'system', type: 'text',
            content: t('rewind.disabled'), commandType: 'error', timestamp: Date.now(),
          });
        }
      }
    };
    window.addEventListener('little-claude:rewind', handler);
    return () => window.removeEventListener('little-claude:rewind', handler);
  }, [canRewind, t]);

  // U5: 用户消息"编辑重发"回填 —— MessageBubble 的编辑按钮派发此事件。
  // 行为：把该消息文本回填输入框 + 截断到该轮之前 + 聚焦输入框。
  // 截断用 chatStore.rewindToTurn（仅内存层面、不调 CLI rewind），因此
  // 跨后端 / 无检查点场景也能用。重发后走正常提交流程（handleSubmit）。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ messageId: string; text: string }>).detail;
      const tabId = useSessionStore.getState().selectedSessionId;
      if (!tabId || !detail || typeof detail.text !== 'string') return;
      const tab = useChatStore.getState().getTab(tabId);
      // 运行中的会话不允许边跑边截断 —— 需先 Stop
      if (tab && tab.sessionStatus === 'running') return;
      const idx = tab ? tab.messages.findIndex((m) => m.id === detail.messageId) : -1;
      if (idx >= 0) {
        // 截断到该轮之前（含该用户消息本身，文本已回填到输入框）
        useChatStore.getState().rewindToTurn(tabId, idx);
      }
      setInputSync(detail.text);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener('little-claude:edit-user-message', handler);
    return () => window.removeEventListener('little-claude:edit-user-message', handler);
  }, [setInputSync]);

  // U1: 错误可行动卡片"重试" —— 重发最后一条用户消息（正常提交流程）。
  // preserveDraft: 不清空用户正在输入的内容。
  useEffect(() => {
    const handler = () => {
      const tab = getActiveTabState();
      if (tab.sessionStatus === 'running') return;
      const lastUser = [...tab.messages].reverse().find(
        (m) => m.role === 'user' && m.type === 'text' && m.content,
      );
      if (lastUser) void handleSubmitRef.current(lastUser.content, { preserveDraft: true });
    };
    window.addEventListener('little-claude:retry-last-message', handler);
    return () => window.removeEventListener('little-claude:retry-last-message', handler);
  }, []);

  // Double-Esc rewind shortcut disabled (#36 / #71) — rewind feature is hidden in TOKENICODE

  // Drag state (file drop)
  const [isDragging, setIsDragging] = useState(false);

  // Fetch slash commands when working directory or backend changes
  const cliBackend = useSettingsStore((s) => s.cliBackend);
  useEffect(() => {
    useCommandStore.getState().fetchCommands(workingDirectory || undefined, cliBackend);
  }, [workingDirectory, cliBackend]);

  const isRunning = sessionStatus === 'running';
  const isAwaiting = isRunning && activityPhase === 'awaiting';

  // Whether this is a follow-up (session already has a CLI session ID)
  const hasActiveSession = sessionStatus !== 'idle';
  const workingDirectoryLabel = workingDirectory
    ? workingDirectory.split(/[\\/]/).filter(Boolean).pop() || workingDirectory
    : t('input.projectFolder');

  const handlePickWorkingDirectory = useCallback(async () => {
    if (isRunning) return;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('input.selectFolder'),
        defaultPath: workingDirectory || undefined,
      });
      if (typeof selected === 'string' && selected) {
        useSettingsStore.getState().setWorkingDirectory(selected);
      }
    } catch (error) {
      console.warn('[InputBar] failed to pick working directory', error);
    }
  }, [isRunning, t, workingDirectory]);

  // --- Slash command detection ---
  // Relaxed: detect "/" at start of first line, keep popover open even after spaces
  const detectSlashCommand = useCallback((text: string) => {
    const firstLine = text.split('\n')[0];
    if (firstLine.startsWith('/') && !activePrefix) {
      const query = firstLine.slice(1); // strip leading "/"
      setSlashQuery(query);
      setSlashVisible(true);
      setSlashIndex(0);
    } else {
      setSlashVisible(false);
    }
  }, [activePrefix]);

  // Ref to always point to the latest handleSubmit (avoids stale closure)
  // fix14: 类型放开为可传 submitText/preserveDraft（与 handleSubmit 签名对齐）
  const handleSubmitRef = useRef<(text?: string, opts?: { preserveDraft?: boolean }) => void>(() => {});
  // Ref to always point to the latest handleStderrLine (used by retry logic in handleStreamMessage)
  const handleStderrLineRef = useRef<(line: string, sid: string) => void>(() => {});
  /** Last non-empty stderr line — shown to user if process exits without response */
  const lastStderrRef = useRef('');
  /** Tracks ExitPlanMode in current turn for Code mode auto-restart */
  const exitPlanModeSeenRef = useRef(false);
  /** When true, next handleSubmit skips creating user message bubble (Code mode silent restart) */
  const silentRestartRef = useRef(false);

  // Stream processing hook — handles foreground + background stream messages
  const { handleStreamMessage } = useStreamProcessor({
    exitPlanModeSeenRef,
    silentRestartRef,
    handleSubmitRef,
    handleStderrLineRef,
    lastStderrRef,
    setInputSync,
  });

  // --- Immediate command execution ---
  // All built-in commands are handled in the UI layer because they don't work
  // via stdin in stream-json mode (CLI treats them as normal text, not commands).
  const executeImmediateCommand = useCallback(async (cmdName: string, args?: string) => {
    const cmd = cmdName.toLowerCase().replace(/^\//, '');
    const { addMessage } = useChatStore.getState();
    const tabId = useSessionStore.getState().selectedSessionId;

    // Always clear the input box first
    setInputSync('');

    // Helper: resolve model ID to display name
    const modelLabel = (id: string | undefined): string => {
      if (!id) return '—';
      return MODEL_OPTIONS.find((m) => m.id === id)?.label || displayDeepSeekModelName(id);
    };

    // Helper: add a structured command feedback message
    const feedback = (
      commandType: 'mode' | 'info' | 'help' | 'action' | 'error',
      content: string,
      commandData?: Record<string, any>,
    ) => {
      if (!tabId) return;
      addMessage(tabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content,
        commandType,
        commandData,
        timestamp: Date.now(),
      });
    };

    switch (cmd) {
      // --- Mode switching ---
      case 'ask':
        useSettingsStore.getState().setSessionMode('ask');
        feedback('mode', t('cmd.switchedToAsk'), { mode: 'ask', icon: '💬' });
        return;
      case 'plan':
        useSettingsStore.getState().setSessionMode('plan');
        feedback('mode', t('cmd.switchedToPlan'), { mode: 'plan', icon: '📋' });
        return;
      case 'code':
        useSettingsStore.getState().setSessionMode('code');
        feedback('mode', t('cmd.switchedToCode'), { mode: 'code', icon: '⚡' });
        return;
      case 'bypass':
        useSettingsStore.getState().setSessionMode('bypass');
        feedback('mode', t('cmd.switchedToBypass'), { mode: 'bypass', icon: '🔓' });
        return;

      // --- Session management ---
      case 'clear':
        if (tabId) useChatStore.getState().resetTab(tabId);
        return;

      case 'rewind':
        window.dispatchEvent(new CustomEvent('little-claude:rewind'));
        return;

      // /compact is handled in the session stdin commands group below

      // --- Info commands ---
      case 'cost': {
        const meta = getActiveTabState().sessionMeta;
        const hasData = meta.cost != null || meta.duration != null || meta.turns != null
          || meta.inputTokens != null || meta.outputTokens != null;
        const tokenValue = (meta.inputTokens != null || meta.outputTokens != null)
          ? `${(meta.inputTokens ?? 0).toLocaleString()} input / ${(meta.outputTokens ?? 0).toLocaleString()} output`
          : '—';
        feedback('info', hasData ? t('cmd.costTitle') : t('cmd.noSessionData'), {
          command: '/cost',
          title: t('cmd.costTitle'),
          rows: [
            { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
            { label: t('cmd.costAmount'), value: meta.cost != null ? `$${meta.cost.toFixed(4)}` : '—' },
            { label: t('cmd.costDuration'), value: meta.duration != null ? `${(meta.duration / 1000).toFixed(1)}s` : '—' },
            { label: t('cmd.costTurns'), value: meta.turns != null ? String(meta.turns) : '—' },
            { label: t('cmd.costTokens'), value: tokenValue },
          ],
          hasData,
        });
        return;
      }


      case 'usage': {
        const meta = getActiveTabState().sessionMeta;
        const isOfficialProvider = useProviderStore.getState().activeProviderId === null;

        if (isOfficialProvider) {
          // Official Anthropic account: quota data is only available in the CLI REPL TUI.
          // Show local session data + a hint to use the terminal.
          const hasData = meta.cost != null || meta.turns != null
            || meta.inputTokens != null || meta.outputTokens != null;
          const totalInput = meta.totalInputTokens ?? 0;
          const totalOutput = meta.totalOutputTokens ?? 0;
          feedback('info', hasData ? t('cmd.usageTitle') : t('cmd.noSessionData'), {
            command: '/usage',
            title: t('cmd.usageTitle'),
            rows: [
              { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
              { label: t('cmd.costTurns'), value: meta.turns != null ? String(meta.turns) : '—' },
              { label: t('cmd.usageTotalSession'), value: totalInput || totalOutput
                ? `${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out`
                : '—' },
            ],
            hasData,
            hint: t('cmd.usageOfficialHint'),
          });
        } else {
          // Third-party API provider: show detailed token breakdown.
          const hasData = meta.inputTokens != null || meta.outputTokens != null
            || meta.totalInputTokens != null || meta.totalOutputTokens != null;
          const turnInput = meta.inputTokens ?? 0;
          const turnOutput = meta.outputTokens ?? 0;
          const totalInput = meta.totalInputTokens ?? 0;
          const totalOutput = meta.totalOutputTokens ?? 0;
          feedback('info', hasData ? t('cmd.usageTitle') : t('cmd.noSessionData'), {
            command: '/usage',
            title: t('cmd.usageTitle'),
            rows: [
              { label: t('cmd.costModel'), value: modelLabel(meta.model || useSettingsStore.getState().selectedModel) },
              { label: `${t('cmd.usageCurrentTurn')} — ${t('cmd.usageInput')}`, value: turnInput.toLocaleString() },
              { label: `${t('cmd.usageCurrentTurn')} — ${t('cmd.usageOutput')}`, value: turnOutput.toLocaleString() },
              { label: `${t('cmd.usageTotalSession')} — ${t('cmd.usageInput')}`, value: totalInput.toLocaleString() },
              { label: `${t('cmd.usageTotalSession')} — ${t('cmd.usageOutput')}`, value: totalOutput.toLocaleString() },
              { label: t('cmd.usageTotal'), value: (totalInput + totalOutput).toLocaleString() },
              { label: t('cmd.costAmount'), value: meta.cost != null ? `$${meta.cost.toFixed(4)}` : '—' },
            ],
            hasData,
          });
        }
        return;
      }

      case 'help': {
        const cmds = useCommandStore.getState().commands;
        const builtins = cmds.filter((c) => c.category === 'builtin')
          .map((c) => ({ name: c.name, desc: c.description }));
        const customCount = cmds.filter((c) => c.category === 'command').length;
        const skillCount = cmds.filter((c) => c.category === 'skill').length;
        feedback('help', t('cmd.helpTitle'), {
          builtins,
          customCount,
          skillCount,
        });
        return;
      }

      // --- External commands ---
      case 'bug':
        feedback('action', t('cmd.bugReport'), { action: 'bug', url: 'https://github.com/anthropics/claude-code/issues' });
        return;

      // --- UI-handled commands ---

      case 'rename': {
        if (!args) {
          feedback('error', t('cmd.renameNoArgs'));
          return;
        }
        const sessionId = useSessionStore.getState().selectedSessionId;
        if (sessionId) {
          useSessionStore.getState().setCustomPreview(sessionId, args);
          feedback('action', t('cmd.renamed').replace('{name}', args));
        }
        return;
      }

      case 'export': {
        const meta = getActiveTabState().sessionMeta;
        const sessions = useSessionStore.getState().sessions;
        const session = sessions.find((s: any) => s.id === meta.sessionId);
        const sessionPath = session?.path;
        if (!sessionPath) {
          feedback('error', t('cmd.exportNoPath'));
          return;
        }
        // B20: 无参数默认导出到 JSONL 同目录 .md —— 若已存在则追加时间戳去重，
        // 避免静默覆盖用户已有的导出文件；显式传参时按用户意图直接覆盖
        let outputPath = args || sessionPath.replace(/\.jsonl$/, '.md');
        if (!args) {
          try {
            await bridge.getFileSize(outputPath); // 不存在会抛错
            const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
            outputPath = outputPath.replace(/\.md$/, `-${stamp}.md`);
          } catch {
            // 目标文件不存在，使用默认路径
          }
        }
        try {
          await bridge.exportSessionMarkdown(sessionPath, outputPath);
          feedback('action', `${t('export.success')} ${outputPath}`);
        } catch (err) {
          // A10: this callback has no outer try — an unhandled rejection here
          // would leave the user with no feedback at all.
          console.error('Failed to export session:', err);
          feedback('error', t('cmd.exportFailed'));
        }
        return;
      }


      // --- All CLI commands: pass through to active session via stdin ---
      // TOKENICODE is a GUI wrapper — all slash commands are handled by Claude Code CLI.
      default: {
        const stdinId = getActiveTabState().sessionMeta.stdinId;
        if (stdinId && tabId) {
          // Gate: no CLI commands while a turn / compact is in flight. Plain
          // messages queue into the FIFO (addPendingMessage) in that state,
          // but a direct stdin write here would clobber the in-flight card
          // (pendingCommandMsgId) — the previous card then never completes and
          // the compact speed-badge exclusion (isCompactInFlight) breaks.
          const cmdBusy = useChatStore.getState().getTab(tabId)?.sessionStatus === 'running';
          if (cmdBusy) {
            feedback('error', `/${cmd}: ${t('cmd.sessionBusy')}`);
            return;
          }
          // Emit a processing card immediately so user sees feedback
          const processingMsgId = generateMessageId();
          addMessage(tabId, {
            id: processingMsgId,
            role: 'system',
            type: 'text',
            content: '',
            commandType: 'processing',
            commandData: { command: `/${cmd}${args ? ' ' + args : ''}` },
            commandStartTime: Date.now(),
            commandCompleted: false,
            timestamp: Date.now(),
          });
          useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: processingMsgId });
          // /compact's summary request outputs thousands of tokens in 1-3s —
          // keep its "compression speed" out of the tok/s badge
          // (useStreamProcessor.isCompactInFlight matches on command === '/compact').
          if (cmd === 'compact') {
            useTokenSpeedStore.getState().reset(tabId);
          }
          useChatStore.getState().setSessionStatus(tabId, 'running');
          useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
          try {
            await bridge.sendStdin(stdinId, `/${cmd}${args ? ' ' + args : ''}`);
          } catch (err) {
            // A10: surface the failure AND recover the UI — otherwise the
            // processing card stays "running" forever with no error shown.
            console.error('Failed to send slash command:', err);
            useChatStore.getState().updateMessage(tabId, processingMsgId, {
              commandCompleted: true,
              commandData: {
                command: `/${cmd}${args ? ' ' + args : ''}`,
                output: `Failed: ${String(err)}`,
                completedAt: Date.now(),
              },
            });
            useChatStore.getState().setSessionMeta(tabId, { pendingCommandMsgId: undefined });
            useChatStore.getState().setSessionStatus(tabId, 'error');
            feedback('error', `/${cmd}: ${t('cmd.sendFailed')}`);
          }
        } else {
          feedback('error', `/${cmd}: ${t('cmd.noActiveSession')}`, { command: `/${cmd}` });
        }
        return;
      }
    }
  }, [t, workingDirectory]);

  // --- Slash command selection ---
  const handleSlashSelect = useCallback((cmd: UnifiedCommand) => {
    setSlashVisible(false);
    setInputSync('');

    if (cmd.immediate) {
      if (cmd.has_args) {
        // Immediate + has_args: show prefix chip so user can type the argument
        useCommandStore.getState().setActivePrefix(cmd);
        textareaRef.current?.focus();
      } else {
        // Immediate execution: send command via stdin or as first message
        executeImmediateCommand(cmd.name);
      }
    } else {
      // Deferred: set as immutable prefix chip
      useCommandStore.getState().setActivePrefix(cmd);
      textareaRef.current?.focus();
    }
  }, [executeImmediateCommand]);

  // --- Submit ---
  const handleSubmit = useCallback(
    async (submitText?: string, opts?: { preserveDraft?: boolean; forceMode?: 'queue' | 'steer' | 'auto' }) => {
    // Capture tabId at the start of submission
    let tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) {
      if (!workingDirectory) return;
      tabId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      useChatStore.getState().ensureTab(tabId);
      useChatStore.getState().resetTab(tabId);
      useSessionStore.getState().addDraftSession(tabId, workingDirectory);
    }
    useChatStore.getState().ensureTab(tabId);

    // Read input from store directly (not closure) so that async callers
    // like handlePlanApprove (setInput + rAF) always see the latest value.
    // submitText overrides the editor content (H6: auto-send of messages
    // queued while a disk-loaded session was still loading).
    const rawInput =
      submitText ?? (getActiveTabState().inputDraft || textareaRef.current?.getText() || '');
    let text = rawInput.trim();

    // Plan approval shortcut: empty Enter triggers approve & execute flow
    const tabState = getActiveTabState();
    const pendingPlanReview = tabState.messages.find(
      (m: import('../../stores/chatStore').ChatMessage) => m.type === 'plan_review' && !m.resolved,
    );
    if (pendingPlanReview && !text && !useCommandStore.getState().activePrefix) {
      const stdinId = tabState.sessionMeta.stdinId;
      const permData = pendingPlanReview.permissionData;
      if (permData?.requestId && stdinId) {
        try {
          await bridge.respondPermission(
            stdinId,
            permData.requestId,
            true,
            undefined,
            permData.toolUseId,
            permData.input,
          );
        } catch (err) {
          console.error('[TC:plan] Empty-Enter plan approval failed:', err);
          return;
        }
      }
      if (useSettingsStore.getState().sessionMode === 'plan') {
        setSessionModeLocal('code');
      }
      useChatStore.getState().updateMessage(tabId, pendingPlanReview.id, {
        resolved: true,
        interactionState: 'resolved',
      });
      window.dispatchEvent(new CustomEvent('little-claude:plan-execute'));
      return;
    }

    // Prefix mode: prepend the command/skill name
    const prefix = useCommandStore.getState().activePrefix;
    if (prefix) {
      text = text ? `${prefix.name} ${text}` : prefix.name;
      useCommandStore.getState().clearPrefix();
    }

    if (!text) return;

    // DSH goal: seed from the session's first user message (before command
    // interception, so /cmd submissions don't seed goals)
    const hadMessages = getActiveTabState().messages.length > 0;
    if (!hadMessages && !text.startsWith('/')) {
      useGoalStore.getState().seedGoal(tabId, text);
    }

    // Intercept immediate (built-in) commands even when submitted directly
    // (e.g. user types "/help" and presses Enter without using the popover)
    if (text.startsWith('/')) {
      const parts = text.split(/\s+/);
      const cmdPart = parts[0].toLowerCase();
      const restText = parts.slice(1).join(' ').trim();

      // Mode-switching commands: /ask, /plan, /code, /bypass
      // If followed by text, switch mode then submit the text normally
      const modeMap: Record<string, 'ask' | 'plan' | 'code' | 'bypass'> = {
        '/ask': 'ask', '/plan': 'plan', '/code': 'code', '/bypass': 'bypass',
      };
      if (modeMap[cmdPart]) {
        useSettingsStore.getState().setSessionMode(modeMap[cmdPart]);
        if (restText) {
          // Directly apply the mode prefix and continue with submission
          text = `${cmdPart} ${restText}`;
        } else {
          setInputSync('');
          const modeVal = modeMap[cmdPart];
          const modeKey = `cmd.switchedTo${modeVal.charAt(0).toUpperCase() + modeVal.slice(1)}` as any;
          const iconMap: Record<string, string> = { ask: '💬', plan: '📋', code: '⚡' };
          addMessage(tabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: t(modeKey),
            commandType: 'mode',
            commandData: { mode: modeVal, icon: iconMap[modeVal] },
            timestamp: Date.now(),
          });
          return;
        }
      } else {
        // Other immediate commands (e.g. /clear, /help, /compact)
        const cmds = useCommandStore.getState().commands;
        const match = cmds.find(
          (c) => c.immediate && c.name.toLowerCase() === cmdPart
        );
        if (match) {
          setInputSync('');
          executeImmediateCommand(match.name, restText || undefined);
          return;
        }
      }
    }

    // Append file paths if there are attachments
    if (files.length > 0) {
      const filePaths = files.map((f) => f.path).join('\n');
      text = `${text}\n\n${t('input.attachedFiles')}\n${filePaths}`;
    }

    // H6: a flush-triggered send (disk-load completion) must NOT clear what
    // the user is currently typing — preserveDraft keeps the input untouched.
    if (!opts?.preserveDraft) setInputSync('');

    // Silent restart: skip user message bubble (Code mode ExitPlanMode auto-recovery)
    // userMsgId is hoisted to function scope — the busy-Enter queue path below
    // marks the just-added bubble as 排队中 via updateMessage.
    let userMsgId: string | undefined;
    if (silentRestartRef.current) {
      silentRestartRef.current = false;
    } else {
      // Add user message (show original text, not with prefix)
      // T02: DSH fork anchor — the just-finished turn's final-event seq sits
      // on sessionMeta.pendingDshSeq (written by useStreamProcessor from the
      // result's dsh_seq). Stamp it onto THIS user message: "rewind to before
      // this message" means session.fork at that seq. Consume the slot so a
      // later message never reuses a stale anchor. Undefined on claude/codex.
      const pendingDshSeq = getActiveTabState().sessionMeta.pendingDshSeq;
      userMsgId = generateMessageId();
      addMessage(tabId, {
        id: userMsgId,
        role: 'user',
        type: 'text',
        content: rawInput.trim(),
        timestamp: Date.now(),
        dshSeq: pendingDshSeq,
        attachments: files.length > 0
          ? files.map((f) => ({ name: f.name, path: f.path, isImage: f.isImage }))
          : undefined,
      });
      if (pendingDshSeq !== undefined) {
        setSessionMeta(tabId, { pendingDshSeq: undefined });
      }
    }

    clearFiles();

    // Gate: queue follow-up messages while AI is actively processing (#142).
    // Previously only queued when an interaction card was pending, but direct stdin
    // writes during streaming are unreliable — CLI may silently drop them.
    // Now we always queue during running state; messages are flushed FIFO when the
    // current turn completes (result event in useStreamProcessor).
    // H6: queue during the disk-load window too (status 'running' with no
    // stdinId yet) — previously such a submission spawned a SECOND process
    // while loadSession was still appending history, inverting message order
    // and overwriting the fresh 'running' status. The effect below flushes the
    // first queued message once the load finishes.
    const currentTabState = getActiveTabState();
    const currentStatus = currentTabState.sessionStatus;

    if (currentStatus === 'running') {
      // DSH busy-Enter: 'queue' (default) or 'steer' (interrupt & send live).
      // Ctrl/Cmd+Enter flips the preference at submit time (forceMode).
      const pref = useSettingsStore.getState().busyEnter;
      const mode = opts?.forceMode && opts.forceMode !== 'auto' ? opts.forceMode : pref;
      if (mode === 'steer') {
        const meta = getActiveTabState().sessionMeta;
        // steer 是 DSH 专用交互（Rust 端 mode 参数只对 deepseek 后端生效）。
        // claude/codex 后端是 stream-json 输入模式，直接写 stdin 的裸文本
        // 会被 CLI 丢弃——回退为 queue 排队（等待当前轮次结束）。
        if (useSettingsStore.getState().cliBackend === 'deepseek' && meta.stdinId) {
          const steerMsgId = generateMessageId();
          addMessage(tabId, {
            id: steerMsgId,
            role: 'user',
            type: 'text',
            content: text,
            timestamp: Date.now(),
          });
          bridge.sendStdin(meta.stdinId, text, 'steer').catch((err: unknown) => {
            // The bubble is already shown — re-queuing here made the QueueDock
            // display a message the user believes was sent (and it keeps
            // "排队中" forever if the turn never ends). Restore to the draft
            // instead, same semantics as process_exit / spawn failures.
            console.warn('[busy-enter] steer sendStdin failed, restoring to draft:', err);
            const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
            useChatStore.getState().setInputDraft(tabId, draft ? `${draft}\n\n${text}` : text);
            useChatStore.getState().updateMessage(tabId, steerMsgId, { queued: false });
            showToast(t('input.sendFailedRestored'), 'error');
          });
          return;
        }
      }
      useChatStore.getState().addPendingMessage(tabId, text);
      // Honest queue state: this message is NOT sent yet — mark its bubble
      // (added above) with the "排队中" chip so it doesn't look sent.
      if (userMsgId) {
        useChatStore.getState().updateMessage(tabId, userMsgId, { queued: true });
      }
      return;
    }

    const turnStartedAt = Date.now();
    setSessionStatus(tabId, 'running');
    setSessionMeta(tabId, {
      turnStartTime: turnStartedAt,
      turnStartSource: 'user',
      lastProgressAt: turnStartedAt,
      inputTokens: 0,
      outputTokens: 0,
      // A1-defensive: a stale compact-turn marker must never outlive its turn.
      // If it leaked (e.g. a compact whose result never arrived), every later
      // result would be misclassified as a compact turn — dropping the Ctx bar
      // to 0% and discarding the session's token stats.
      compactTurnPending: undefined,
    });
    useChatStore.getState().setActivityStatus(tabId, { phase: 'thinking' });
    lastStderrRef.current = ''; // Clear stale stderr before new turn

    // Initialize agent tracking — clear previous turn's agents (they may be from a
    // different project/session) and create a fresh main agent for this turn.
    useAgentStore.getState().clearAgents();
    useAgentStore.getState().upsertAgent({
      id: 'main',
      parentId: null,
      description: rawInput.trim(),
      phase: 'spawning',
      startTime: Date.now(),
      isMain: true,
    });

    let sessionStdinId: string | undefined;

    try {
      if (!workingDirectory) {
        setSessionStatus(tabId, 'error');
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: t('input.noWorkingDir'),
          timestamp: Date.now(),
        });
        return;
      }

      // Check model mapping before sending — block if provider has no mapping for selected tier
      const modelResolution = resolveModelOrError(selectedModel);
      if (!modelResolution.ok) {
        const msg = t('provider.noModelMapping')
          .replace('{provider}', modelResolution.providerName)
          .replace('{tier}', modelResolution.tier);
        addMessage(tabId, {
          id: generateMessageId(),
          role: 'system',
          type: 'text',
          content: msg,
          timestamp: Date.now(),
        });
        setSessionStatus(tabId, 'error');
        return;
      }

      // Use stdinId (desk-generated) for stdin communication, not CLI's own sessionId.
      // stdinId exists when: (a) a pre-warmed process is waiting, or (b) follow-up in active session.
      const submitTabState = getActiveTabState();
      let stdinId = submitTabState.sessionMeta.stdinId;
      // fix1: 提交时一次性快照 {tabId, stdinId, sessionId}（tabId 即上方捕获值）——
      // 所有 await 之后一律用快照值，不再实时读活动 tab（await 期间可能被切走）
      const snapshotStdinId = stdinId;
      const snapshotSessionId = submitTabState.sessionMeta.sessionId;
      const snapshotSessionOrigin = submitTabState.sessionMeta.sessionOrigin;
      let sentViaStdin = false;

      if (stdinId) {
        // Check if API provider config changed since this process was spawned (TK-303).
        // If so, the pre-warmed process has stale env vars — kill it and spawn fresh.
        const currentFp = envFingerprint();
        const sessionFp = getActiveTabState().sessionMeta.envFingerprint;
        if (currentFp !== sessionFp) {
          console.warn('[LITTLECLAUDE] API provider config changed, killing stale session');
          bridge.killSession(stdinId).catch(() => {});
          cleanupStreamListener(stdinId);
          // F11: kill 重建路径回收 stdinId→tab 映射（旧 id 不再拥有事件路由）
          useSessionStore.getState().unregisterStdinTab(stdinId);
          // Keep sessionId so we attempt resume (preserving context).
          // If the resume fails due to thinking signature mismatch, the
          // stream error handler will auto-retry without resume.
          setSessionMeta(tabId, { stdinId: undefined, envFingerprint: undefined, providerSwitched: true, providerSwitchPendingText: text });
          stdinId = undefined;
        } else {
          const currentMode = useSettingsStore.getState().sessionMode;
          const spawnedMode = getActiveTabState().sessionMeta.snapshotMode;
          if (spawnedMode && currentMode !== spawnedMode) {
            console.warn(`[LITTLECLAUDE] Permission mode changed (${spawnedMode} -> ${currentMode}), killing stale session`);
            bridge.killSession(stdinId).catch(() => {});
            cleanupStreamListener(stdinId);
            useSessionStore.getState().unregisterStdinTab(stdinId); // F11: 回收映射
            setSessionMeta(tabId, { stdinId: undefined, snapshotMode: undefined });
            stdinId = undefined;
          } else {
          const currentContextMode = useSettingsStore.getState().contextWindowMode;
          const spawnedContextMode = getActiveTabState().sessionMeta.snapshotContextWindowMode ?? 'default';
          if (currentContextMode !== spawnedContextMode) {
            console.warn(`[LITTLECLAUDE] Context window mode changed (${spawnedContextMode} -> ${currentContextMode}), killing stale session`);
            bridge.killSession(stdinId).catch(() => {});
            cleanupStreamListener(stdinId);
            useSessionStore.getState().unregisterStdinTab(stdinId); // F11: 回收映射
            setSessionMeta(tabId, { stdinId: undefined, snapshotContextWindowMode: undefined });
            stdinId = undefined;
          } else {
          // Check if model changed since this process was spawned.
          // If so, kill the stale process and fall through to spawn a new one with --resume.
          const currentModel = resolveModelForProvider(selectedModel);
          const spawnedModel = getActiveTabState().sessionMeta.spawnedModel;
          if (spawnedModel && currentModel !== spawnedModel) {
            const oldShort = MODEL_OPTIONS.find((m) => m.id === spawnedModel)?.short ?? displayDeepSeekModelName(spawnedModel);
            const newShort = MODEL_OPTIONS.find((m) => m.id === currentModel)?.short ?? displayDeepSeekModelName(currentModel);
            console.warn(`[LITTLECLAUDE] Model changed (${oldShort} → ${newShort}), killing stale session`);
            bridge.killSession(stdinId).catch(() => {});
            cleanupStreamListener(stdinId);
            useSessionStore.getState().unregisterStdinTab(stdinId); // F11: 回收映射
            // System message already inserted by ModelSelector — no duplicate here.
            // Keep sessionId so we attempt resume (preserving context).
            setSessionMeta(tabId, { stdinId: undefined, spawnedModel: undefined, modelSwitched: true, modelSwitchPendingText: text });
            // fix6: 不再过滤 thinking 消息——保留完整历史；resume 的签名 400
            // 已由流错误处理器的失败重试路径（自动去 resume 重试）覆盖
            stdinId = undefined;
          } else {
          // ===== Send via stdin to existing persistent process (pre-warmed or follow-up) =====
          try {
            await bridge.sendStdin(stdinId, text);
            sentViaStdin = true;
            // Defensive: ensure spawnedModel is always recorded after first successful stdin send
            // fix1: await 之后按捕获的 tabId 读 tab，不再读活动 tab
            if (!useChatStore.getState().getTab(tabId)?.sessionMeta.spawnedModel) {
              setSessionMeta(tabId, { spawnedModel: resolveModelForProvider(selectedModel) });
            }
          } catch (stdinErr) {
            // stdin write failed (broken pipe — process already exited).
            // Clean up dead listeners (P0-5 fix) and fall through to spawn a new process.
            console.warn('[LITTLECLAUDE] sendStdin failed, spawning new process:', stdinErr);
            cleanupStreamListener(stdinId);
            setSessionMeta(tabId, { stdinId: undefined });
            stdinId = undefined;
          }
          }
        }
        }
      }
      }

      if (!sentViaStdin) {
        // ===== No running process: spawn a new persistent stream-json process =====

        // Mode is now passed via --mode CLI arg in startSession, not text prefix.
        // Text prefix (/ask, /plan) caused "Unknown skill" errors in stream-json mode.

        // If we have an existing sessionId (loaded historical session), resume it.
        // Only use it as resume_session_id if it looks like a real CLI session ID (UUID),
        // not a desk-generated ID like "desk_xxx".
        // The tab's own sessionMeta is the binding — comparing tabId (a
        // draft_*/desk_* tab handle) against the CLI UUID wrongly rejected
        // most tabs (only sessions opened from the conversation list matched),
        // so after a rewind (process killed, history truncated) the next
        // message would spawn a fresh context-less session instead of
        // --resume'ing the pre-rewind history.
        // fix1: 用提交时快照（上方可能有 await），不再实时读活动 tab
        const rawSessionId = snapshotSessionId;
        let existingSessionId: string | undefined = rawSessionId
          && !rawSessionId.startsWith('desk_')
          ? rawSessionId
          : undefined;

        // Cross-backend transition: native resume only works within the same backend.
        // Claude session IDs are not valid Codex thread IDs, and vice versa.
        const sessionOrigin = snapshotSessionOrigin; // fix1: 快照值
        // T01: unified handoff pipeline — works for ALL origin backends
        // (claude from disk JSONL, codex/deepseek from memory/DSH log),
        // dual-channel: budgeted inline history + on-disk handoff brief.
        let handoffInfo: { from: string; turnCount: number; briefPath?: string } | undefined;
        {
          const currentBackend = useSettingsStore.getState().cliBackend;
          if (sessionOrigin && sessionOrigin !== currentBackend) {
            try {
              let turns: ReturnType<typeof unifiedTurnsFromChatMessages> = [];
              let todos: { content: string; status: string }[] = [];
              let srcModel: string | undefined;
              if (sessionOrigin === 'claude' && existingSessionId) {
                // Claude → any: read the session JSONL from disk
                const projectDir = encodeProjectName(workingDirectory);
                const jsonlContent = await bridge.exportClaudeToCodex(existingSessionId, projectDir);
                turns = unifiedTurnsFromClaudeJsonl(jsonlContent);
              } else if (sessionOrigin === 'deepseek' && snapshotStdinId) {
                // DSH → any: decode the DSH session log (zstd) via Rust
                const payload = await bridge.readDshSessionTurns(snapshotStdinId);
                const parsed = unifiedTurnsFromDsh(payload);
                turns = parsed.turns;
                todos = parsed.todos;
                srcModel = parsed.model;
              } else {
                // Codex → any (or fallback): in-memory messages
                // fix1: 按捕获的 tabId 读历史（此处之前可能已发生 await）
                const tabMessages = useChatStore.getState().getTab(tabId)?.messages ?? [];
                turns = unifiedTurnsFromChatMessages(tabMessages);
              }
              if (turns.length > 0) {
                // Channel B: handoff brief file (best-effort — the inline
                // history alone still makes the transition usable)
                let briefPath: string | undefined;
                try {
                  const brief = buildHandoffBrief({
                    sourceBackend: sessionOrigin,
                    projectDir: workingDirectory,
                    turns,
                    todos,
                    model: srcModel,
                  });
                  briefPath = await bridge.writeHandoffFile(workingDirectory, brief);
                } catch (briefErr) {
                  debugWarn('session', 'Handoff brief write failed (continuing without it):', briefErr);
                }
                // Channel A: budgeted inline history
                const historyContext = formatUnifiedForInjection(
                  turns, sessionOrigin, workingDirectory,
                );
                const briefRef = briefPath
                  ? `\n[Handoff brief with full task context: ${briefPath} — read it if you need details beyond the history above.]\n`
                  : '';
                text = historyContext + briefRef + text;
                handoffInfo = { from: sessionOrigin, turnCount: turns.length, briefPath };
                debugLog('session', `T01 handoff ${sessionOrigin}→${currentBackend}: ${turns.length} turns, brief=${briefPath ?? 'none'}`);
              }
            } catch (e) {
              // T01: handoff failure must be visible — the old paths failed
              // silently and sent the prompt naked.
              debugWarn('session', 'Cross-backend handoff failed:', e);
              addMessage(tabId, {
                id: generateMessageId(),
                role: 'system',
                type: 'text',
                content: `⚠️ 跨后端历史交接失败（${String(e)}），新会话将以空白上下文开始。`,
                commandType: 'info',
                timestamp: Date.now(),
              });
            }
            // History injected as text — don't use native resume
            existingSessionId = undefined;
          }
        }

        // TK-329 fix: only clean up THIS tab's old stdinId listener, not the global singleton.
        // The old __claudeUnlisten global could kill another tab's active listener.
        // fix1: 用提交时快照的 stdinId（await 之后活动 tab 可能已变）
        const oldStdinId = snapshotStdinId;
        if (oldStdinId) {
          cleanupStreamListener(oldStdinId);
          // Also flush any pending stream buffer for the old session
          flushStreamBuffer(oldStdinId);
        }

        const cwd = workingDirectory;

        // Generate the desk-side session ID FIRST so we can register
        // event listeners BEFORE spawning the process.
        const preGeneratedId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        sessionStdinId = preGeneratedId;

        // Reset guards for the new session
        // fix15: per-tab map 只删当前 tab 的键，不再整体置 false 清掉别的 tab
        {
          const seen = exitPlanModeSeenRef.current;
          if (seen && typeof seen === 'object') {
            delete seen[tabId];
          } else {
            exitPlanModeSeenRef.current = false;
          }
        }

        // TK-329 fix: register stdinId → tabId mapping BEFORE listeners,
        // so events arriving immediately after spawn can be routed correctly.
        // fix1: 一律用捕获的 tabId，不再实时读 selectedSessionId
        const earlyTabId = tabId;
        if (earlyTabId) {
          useSessionStore.getState().registerStdinTab(preGeneratedId, earlyTabId);
          // B3: the auto-compact fired flag is per-tab (sessionMeta) — reset on
          // every spawn (new / resume / restart) so each session process gets
          // its own at-most-one compact. Was a single ref shared by all sessions
          // of the one InputBar instance: one session firing blocked all others.
          useChatStore.getState().setSessionMeta(earlyTabId, { autoCompactFired: false });
        }

        // Register listeners BEFORE starting the session
        const unlisten = await onClaudeStream(
          preGeneratedId,
          (msg: any) => {
            msg.__stdinId = preGeneratedId;
            handleStreamMessage(msg);
          }
        );

        const unlistenStderr = await onClaudeStderr(
          preGeneratedId,
          (line: string) => {
            handleStderrLine(line, preGeneratedId);
          }
        );

        // SDK control protocol: listen for structured permission requests
        const unlistenPermission = await onPermissionRequest(
          preGeneratedId,
          (req: PermissionRequest) => {
            // Background routing: check if this stdinId belongs to a non-active tab
            const reqOwnerTabId = useSessionStore.getState().getTabForStdin(preGeneratedId);
            const reqActiveTabId = useSessionStore.getState().selectedSessionId;
            if (reqOwnerTabId && reqOwnerTabId !== reqActiveTabId) {
              // Route to background cache instead of foreground
              const cache = useChatStore.getState();
              cache.addMessageToCache(reqOwnerTabId, {
                id: generateMessageId(),
                role: 'assistant',
                type: 'permission',
                content: req.description || `${req.tool_name} wants to execute`,
                permissionTool: req.tool_name,
                permissionDescription: req.description || '',
                timestamp: Date.now(),
                interactionState: 'pending',
                permissionData: {
                  requestId: req.request_id,
                  toolName: req.tool_name,
                  input: req.input,
                  description: req.description,
                  toolUseId: req.tool_use_id,
                },
              });
              cache.setActivityInCache(reqOwnerTabId, { phase: 'awaiting' });
              return;
            }
            const { addMessage: addMsg, setActivityStatus: setActivity } = useChatStore.getState();
            const fgTabId = useSessionStore.getState().selectedSessionId;
            if (fgTabId) {
              addMsg(fgTabId, {
                id: generateMessageId(),
                role: 'assistant',
                type: 'permission',
                content: req.description || `${req.tool_name} wants to execute`,
                permissionTool: req.tool_name,
                permissionDescription: req.description || '',
                timestamp: Date.now(),
                interactionState: 'pending',
                permissionData: {
                  requestId: req.request_id,
                  toolName: req.tool_name,
                  input: req.input,
                  description: req.description,
                  toolUseId: req.tool_use_id,
                },
              });
              setActivity(fgTabId, { phase: 'awaiting' });
            }
          }
        );

        // Backup exit detection: if process_exit from stdout stream is missed
        // (e.g., listener was removed), this fires as a safety net.
        const unlistenExit = await onSessionExit(preGeneratedId, () => {
          // Resolve the tab that owns this stdinId
          const exitTabId = useSessionStore.getState().getTabForStdin(preGeneratedId) || tabId;
          const exitTab = useChatStore.getState().getTab(exitTabId);
          if (!exitTab) return;
          // Only act if this is still the active stdinId (avoid stale cleanup)
          if (exitTab.sessionMeta.stdinId === preGeneratedId) {
            useChatStore.getState().setSessionMeta(exitTabId, { stdinId: undefined });
            if (exitTab.sessionStatus === 'running') {
              useChatStore.getState().setSessionStatus(exitTabId, 'idle');
            }
          }
        });

        // Store unlisten per stdinId for multi-session support
        registerStreamListener(preGeneratedId, () => {
          unlisten();
          unlistenStderr();
          unlistenPermission();
          unlistenExit();
        });

        // Spawn persistent process (first message sent via stdin inside Rust)
        // If resuming a historical session, pass resume_session_id so the CLI
        // picks up the existing conversation context.
        // Read sessionMode from store (not closure) so plan-approve → code
        // mode switch is visible even when called via rAF.
        const liveSessionMode = useSettingsStore.getState().sessionMode;
        const liveThinkingSetting = useSettingsStore.getState().thinkingLevel;
        const liveContextWindowMode = useSettingsStore.getState().contextWindowMode;
        const liveThinkingLevel = resolveThinkingLevelForProvider(selectedModel, liveThinkingSetting);
        const liveCliBackend = useSettingsStore.getState().cliBackend || 'claude';
        const liveProviderId = useProviderStore.getState().getActiveIdForBackend(liveCliBackend);
        const liveResolvedModel = resolveModelForProvider(selectedModel);
        const liveContextWindow = getContextWindowForModel(liveResolvedModel, liveContextWindowMode);
        const liveDshPreset = useSettingsStore.getState().dshAgentPresetEnabled
          ? useSettingsStore.getState().dshAgentPreset
          : undefined;
        debugLog('session', 'starting session', { cwd, stdinId: preGeneratedId, mode: liveSessionMode, provider: liveProviderId, backend: liveCliBackend, selectedModel, resolvedModel: liveResolvedModel });
        const session = await bridge.startSession({
          prompt: text,
          cwd,
          model: liveResolvedModel,
          session_id: preGeneratedId,
          resume_session_id: existingSessionId || undefined,
          thinking_level: liveThinkingLevel,
          agent_preset: liveCliBackend === 'deepseek' ? liveDshPreset : undefined,
          session_mode: (liveSessionMode === 'ask' || liveSessionMode === 'plan') ? liveSessionMode : undefined,
          provider_id: liveProviderId || undefined,
          context_window: liveContextWindow,
          permission_mode: mapSessionModeToPermissionMode(liveSessionMode),
          cli_backend: liveCliBackend,
          include_partial_messages: useSettingsStore.getState().includePartialMessages,
        });
        debugLog('session', 'started successfully', { sessionId: session.session_id, pid: session.pid, cli: session.cli_path });

        // Store both: session_id for tracking, stdinId (preGeneratedId) for stdin communication
        setSessionMeta(tabId, {
          sessionId: session.session_id,
          stdinId: preGeneratedId,
          sessionOrigin: liveCliBackend,
          envFingerprint: envFingerprint(),
          snapshotMode: liveSessionMode,
          snapshotModel: selectedModel,
          snapshotThinking: liveThinkingSetting,
          snapshotContextWindowMode: liveContextWindowMode,
          snapshotProviderId: liveProviderId,
          snapshotCliBackend: liveCliBackend,
          spawnedModel: liveResolvedModel,
        });
        // M6: draft-promote race — when the first stream event's real CLI
        // session_id beats this IPC response, chatStore moves the draft tab
        // under the CLI id while we were awaiting, so the write above hit a
        // now-missing draft key and was silently dropped. Re-apply the meta
        // under the tab's current key (stdinId must survive or every
        // follow-up message re-spawns a fresh CLI process). Guarded by an
        // empty-stdinId check so we never clobber a newer session's meta.
        // The target key comes from the stdinToTab reverse lookup, NOT from
        // selectedSessionId — promoteDraft already repointed it to the CLI
        // id; if the user switched to another idle tab in the meantime,
        // selectedSessionId would be that tab and we'd write A's session
        // meta into B (cross-session contamination).
        if (tabId !== session.session_id && !useChatStore.getState().getTab(tabId)) {
          const promotedKey = useSessionStore.getState().getTabForStdin(preGeneratedId);
          const currentTab = promotedKey ? useChatStore.getState().getTab(promotedKey) : undefined;
          if (promotedKey && currentTab && !currentTab.sessionMeta.stdinId) {
            setSessionMeta(promotedKey, {
              sessionId: session.session_id,
              stdinId: preGeneratedId,
              sessionOrigin: liveCliBackend,
              envFingerprint: envFingerprint(),
              snapshotMode: liveSessionMode,
              snapshotModel: selectedModel,
              snapshotThinking: liveThinkingSetting,
              snapshotContextWindowMode: liveContextWindowMode,
              snapshotProviderId: liveProviderId,
              snapshotCliBackend: liveCliBackend,
              spawnedModel: liveResolvedModel,
            });
          }
        }
        // Note: stdinId → tabId mapping already registered before listener setup (TK-329)

        // Track the session and refresh conversation list
        // Skip desk_* IDs — they pollute tracked_sessions.txt (multi-session isolation fix)
        if (!session.session_id.startsWith('desk_')) {
          bridge.trackSession(session.session_id).catch(() => {});
        }
        useSessionStore.getState().fetchSessions();
        // Delayed retry in case JSONL file isn't written yet
        setTimeout(() => useSessionStore.getState().fetchSessions(), 1500);

        // T01: handoff receipt — make the cross-backend transition explicit
        // (what was carried over, where the brief lives).
        if (handoffInfo) {
          // The tab may have been promoted from draft during spawn — resolve
          // the current tab key through the stdin mapping (M6 pattern).
          const receiptTabId =
            useSessionStore.getState().getTabForStdin(preGeneratedId) ?? tabId;
          addMessage(receiptTabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: `🔀 已从 ${handoffInfo.from} 后端交接 ${handoffInfo.turnCount} 轮历史`
              + (handoffInfo.briefPath ? `（完整简报：${handoffInfo.briefPath}）` : '')
              + '。新引擎将基于交接上下文继续。',
            commandType: 'info',
            timestamp: Date.now(),
          });
        }
      }
    } catch (err: any) {
      if (sessionStdinId) {
        cleanupStreamListener(sessionStdinId);
      }
      if (sessionStdinId) {
        useSessionStore.getState().unregisterStdinTab(sessionStdinId);
      }
      setSessionStatus(tabId, 'error');
      // A5: 原始错误经分类器转成友好文案（markdown 渲染含可折叠详情）
      // U1: 带分类 —— MessageBubble 渲染动作按钮（打开设置 / 去安装 / 新建任务 / 重试）
      const spawnFormatted = classifyError(String(err));
      addMessage(tabId, {
        id: generateMessageId(),
        role: 'system',
        type: 'text',
        content: spawnFormatted.text,
        errorCategory: spawnFormatted.category,
        timestamp: Date.now(),
      });
      // Spawn failure — restore queued messages to the draft (same semantics
      // as the exit-path Bug B recovery) instead of stranding them in the
      // pending queue, where nothing will ever drain them.
      const remainingPending = useChatStore.getState().getTab(tabId)?.pendingUserMessages ?? [];
      if (remainingPending.length > 0) {
        const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
        const pendingText = remainingPending.join('\n\n');
        useChatStore.getState().setInputDraft(
          tabId,
          draft ? `${draft}\n\n${pendingText}` : pendingText,
        );
        useChatStore.getState().clearPendingMessages(tabId);
      }
    }
  }, [hasActiveSession, workingDirectory, selectedModel, sessionMode, files, clearFiles]);

  // Keep ref in sync so executeImmediateCommand can call latest handleSubmit
  handleSubmitRef.current = handleSubmit;

  // B15: 取消排队 —— 清空 pending 并回填草稿（与 Stop 的回填语义一致），
  // 用户可随时取消"静默排队"的消息
  const cancelPending = useCallback(() => {
    const tid = useSessionStore.getState().selectedSessionId;
    if (!tid) return;
    const queued = useChatStore.getState().flushPendingMessages(tid);
    if (queued.length > 0) {
      const draft = useChatStore.getState().getTab(tid)?.inputDraft ?? '';
      useChatStore.getState().setInputDraft(tid, [draft, ...queued].filter(Boolean).join('\n\n'));
    }
  }, []);

  // H6: flush the first pending message once a disk-load finishes. During
  // handleLoadSession the tab is 'running' with no stdinId, so submissions
  // queue instead of spawning a second process; the normal FIFO drain only
  // runs on result events (which a plain load never emits) — so when the
  // status leaves 'running' with no live stdin, send the first queued
  // message ourselves. Subsequent queued messages are drained by the usual
  // result-event mechanism once this send starts streaming.
  // Guard on `=== 'completed'` specifically — the ONLY 'completed' state with
  // a non-empty pending list is the load-completion path:
  //   · load done           → 'completed', pending>0  → flush ✓
  //   · user Stop           → 'stopped' (U3, not 'completed' — no flush), and
  //     Stop clears pending back to the draft first anyway
  //   · stream result done  → 'completed', but stdinId is still live
  //   · process exit        → 'idle' — NOT flushed (Bug B restores pending
  //     to the input draft; auto-sending there would bypass the user's
  //     decision to re-send or not)
  //   · load error          → 'error' — stays manual
  const pendingCount = useActiveTab((t) => t.pendingUserMessages.length);
  const pendingMessages = useActiveTab((t) => t.pendingUserMessages);
  const [queueOpen, setQueueOpen] = useState(false);

  /** QueueDock: delete one queued message */
  const removeQueued = useCallback((index: number) => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    const text = useChatStore.getState().getTab(tabId)?.pendingUserMessages[index];
    useChatStore.getState().removePendingMessage(tabId, index);
    // The message leaves the queue without being sent — drop its 排队中 chip.
    if (text !== undefined) useChatStore.getState().clearQueuedFlag(tabId, text);
  }, []);

  /** QueueDock: steer — send one queued message live to the running turn */
  const steerQueued = useCallback((text: string, index: number) => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    const meta = getActiveTabState().sessionMeta;
    if (!meta.stdinId) return;
    // F2: 对齐 handleSubmit 的守卫——steer 仅 deepseek 后端有效；claude/codex
    // 下裸写 stdin 会被 CLI 丢弃（消息从队列消失显示已发送但永远收不到），
    // 其他后端保持排队并 toast 提示。
    if (useSettingsStore.getState().cliBackend !== 'deepseek') {
      showToast(t('input.steerUnsupported'), 'info');
      return;
    }
    useChatStore.getState().removePendingMessage(tabId, index);
    useChatStore.getState().clearQueuedFlag(tabId, text);
    const steerMsgId = generateMessageId();
    addMessage(tabId, {
      id: steerMsgId,
      role: 'user',
      type: 'text',
      content: text,
      timestamp: Date.now(),
    });
    // 必须显式传 'steer'：Rust 端 mode 缺省是 queue，不传的话"插话"实际
    // 会排到当前轮次后面才送达，与按钮语义（中断当前轮次）矛盾。
    bridge.sendStdin(meta.stdinId, text, 'steer').catch((err: unknown) => {
      console.warn('[queue-dock] steer failed, restoring to draft:', err);
      // Re-queuing here put an already-shown (and running) message back into
      // the QueueDock — the user reported it as "已发送还在排队". Restore to
      // the draft instead so the queue window only ever shows unsent messages.
      const draft = useChatStore.getState().getTab(tabId)?.inputDraft ?? '';
      useChatStore.getState().setInputDraft(tabId, draft ? `${draft}\n\n${text}` : text);
      showToast(t('input.sendFailedRestored'), 'error');
    });
  }, [t]);
  const hasLiveStdin = useActiveTab((t) => !!t.sessionMeta.stdinId);
  useEffect(() => {
    if (sessionStatus === 'completed' && !hasLiveStdin && pendingCount > 0) {
      const tid = useSessionStore.getState().selectedSessionId;
      const next = tid ? useChatStore.getState().shiftPendingMessage(tid) : undefined;
      if (next) {
        // preserveDraft: this send must not clear what the user is typing.
        void handleSubmit(next, { preserveDraft: true });
      }
    }
  }, [sessionStatus, hasLiveStdin, pendingCount, handleSubmit]);

  // handleStreamMessage and handleBackgroundStreamMessage are provided by
  // useStreamProcessor hook (see src/hooks/useStreamProcessor.ts).

  // Handle stderr lines — detect permission prompts and other interactive requests
  const handleStderrLine = useCallback((line: string, sid: string) => {
    if (sid) {
      // F4: validate mapping (drops stale entries) before background-routing stderr
      const ownerTabId = resolveOwnerTab(sid);
      const activeTabId = useSessionStore.getState().selectedSessionId;
      if (ownerTabId && ownerTabId !== activeTabId) {
        const clean = stripAnsi(line).trim();
        if (clean) {
          useChatStore.getState().addMessageToCache(ownerTabId, {
            id: generateMessageId(),
            role: 'system',
            type: 'text',
            content: `[stderr] ${clean}`,
            timestamp: Date.now(),
          });
        }
        return;
      }
    }

    // Strip ANSI escape codes so regex matching works on raw text
    const clean = stripAnsi(line).trim();
    debugLog('session', 'stderr:', clean);

    // Track last non-trivial stderr line for error reporting on unexpected exit
    if (clean && !/^\s*$/.test(clean)) {
      lastStderrRef.current = clean;
    }

    const stderrTabId = useSessionStore.getState().selectedSessionId;

    // Detect ExitPlanMode prompt — create plan_review card as fallback (Plan mode only).
    // In Code/Bypass modes the CLI or Rust backend handles this — no UI card needed.
    if (/(?:Exit|Leave)\s+plan\s+mode/i.test(clean)
        && useSettingsStore.getState().sessionMode === 'plan') {
      const stderrTabState = getActiveTabState();
      const existingReview = stderrTabState.messages.find(
        (m: import('../../stores/chatStore').ChatMessage) => m.id === 'plan_review_current' && m.type === 'plan_review',
      );
      if (!existingReview || existingReview.resolved) {
        if (existingReview?.resolved) return;
        let planContent = '';
        for (let i = stderrTabState.messages.length - 1; i >= 0; i--) {
          const m = stderrTabState.messages[i];
          // B9: narrow the any-typed toolInput at runtime — content is only
          // usable as plan text when it is actually a string (a malformed or
          // array-shaped content would otherwise corrupt planContent's type).
          if (m.type === 'tool_use' && m.toolName === 'Write'
              && typeof m.toolInput?.content === 'string' && m.toolInput.content) {
            planContent = m.toolInput.content;
            break;
          }
        }
        if (stderrTabId) {
          useChatStore.getState().addMessage(stderrTabId, {
            id: 'plan_review_current',
            role: 'assistant', type: 'plan_review',
            content: planContent, planContent: planContent,
            resolved: false, timestamp: Date.now(),
          });
          useChatStore.getState().setActivityStatus(stderrTabId, { phase: 'awaiting' });
        }
      }
      return;
    }

    // Permission prompts are now handled via SDK control protocol (P1-03/P1-04).
    // The Rust backend intercepts control_request messages from stdout and emits
    // them as special messages (type: little_claude_permission_request) on the
    // regular claude:stream:{stdinId} channel, which useStreamProcessor handles
    // (foreground + background routing). The claude:permission_request channel
    // is no longer emitted by the backend; onPermissionRequest above is kept
    // for legacy sessions only. Stderr is now purely for diagnostic logging.
  }, []);

  // Keep stderr ref in sync so auto-retry logic in handleStreamMessage can call it
  handleStderrLineRef.current = handleStderrLine;

  // Register global stream handler on mount so pre-warm events (system:init,
  // process_exit) are processed immediately — not deferred until user sends.
  // Without this, a pre-warm process_exit would be silently dropped and stdinId
  // would remain set, causing sendStdin to write to a dead process.
  //
  // IMPORTANT: We intentionally do NOT clear __claudeStreamHandler in the cleanup.
  // During React's effect cycle (cleanup → setup), there's a micro-window where
  // the handler is null. If a Tauri event arrives during this window, it would be
  // silently dropped — causing the "no reply" bug where the CLI generates content
  // but the UI never shows it. The handler uses getState() internally so a stale
  // reference is safe.
  useEffect(() => {
    window.__claudeStreamHandler = handleStreamMessage;
    // Drain any events that were queued while handler was unavailable
    const queue = window.__claudeStreamQueue;
    if (queue && queue.length > 0) {
      console.warn(`[LITTLECLAUDE] draining ${queue.length} queued stream events on handler mount`);
      const pending = queue.splice(0);
      for (const msg of pending) handleStreamMessage(msg);
    }
  }, [handleStreamMessage]);

  // --- Keyboard handler ---
  /** Keyboard handler for the tiptap editor.
   *  Receives a native KeyboardEvent (not React.KeyboardEvent).
   *  Return true to prevent tiptap default handling. */
  const handleKeyDown = (e: KeyboardEvent): boolean | void => {
    // Slash command navigation
    if (slashVisible) {
      const filtered = getFilteredCommandList(slashCommands, slashQuery);
      const count = filtered.length;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((prev) => (prev - 1 + count) % count);
        return true;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((prev) => (prev + 1) % count);
        return true;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.isComposing)) {
        if (filtered[slashIndex]) {
          e.preventDefault();
          handleSlashSelect(filtered[slashIndex]);
          return true;
        }
        // No matching command — close popover, let Enter fall through to submit
        if (e.key === 'Enter') {
          setSlashVisible(false);
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashVisible(false);
        return true;
      }
    }

    // Backspace at position 0 with empty input removes active prefix
    if (e.key === 'Backspace' && activePrefix && (textareaRef.current?.isEmpty() ?? true)) {
      e.preventDefault();
      useCommandStore.getState().clearPrefix();
      return true;
    }

    if (e.key !== 'Enter') return;

    // Skip if IME composition is in progress (e.g. Chinese/Japanese input method
    // confirming a candidate with Enter — should NOT send the message).
    // Only trust browser-native signals: e.isComposing + keyCode 229.
    // Previously also checked TipTap's composingRef, but compositionend can be
    // missed on macOS WebKit (focus change, click outside), leaving composingRef
    // stuck true and permanently blocking Enter. See issue #66.
    if (e.isComposing || e.keyCode === 229) return;

    const keyTabState = getActiveTabState();
    const pendingInteraction = keyTabState.messages.find(
      (m: import('../../stores/chatStore').ChatMessage) => ['permission', 'question', 'plan_review'].includes(m.type) && !m.resolved,
    );
    if (pendingInteraction) {
      const inputText = (keyTabState.inputDraft || '').trim();
      const isEmptyPlanApproval = pendingInteraction.type === 'plan_review' && !inputText;
      if (!isEmptyPlanApproval && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        return true;
      }
    }

    if (e.metaKey || e.ctrlKey) {
      // 计划审批卡打开时 Cmd/Ctrl+Enter 只换行——上面的 pendingInteraction
      // 拦截放行了 isEmptyPlanApproval（plan_review 且无输入），若此处把
      // 空 Ctrl+Enter 送去 handleSubmit，会被当成"批准并执行计划"误触发。
      if (pendingInteraction?.type === 'plan_review') {
        return false;
      }
      // DSH busy-Enter: Ctrl/Cmd+Enter 以翻转的 queue/steer 模式强制提交。
      // 仅 deepseek 后端支持（Rust 端 mode 参数只对 deepseek 生效）；其他
      // 后端 mode 被忽略、强发会绕过 busy 排队直写 stdin（忙时消息被静默
      // 丢弃）——回退为换行（macOS 用户习惯 Cmd+Enter 换行）。
      if (useSettingsStore.getState().cliBackend !== 'deepseek') {
        return false;
      }
      e.preventDefault();
      handleSubmit(undefined, {
        forceMode: useSettingsStore.getState().busyEnter === 'steer' ? 'queue' : 'steer',
      });
      return true;
    } else if (!e.shiftKey) {
      // Plain Enter → send message
      e.preventDefault();
      handleSubmit();
      return true;
    }
    // Shift+Enter → let tiptap handle (inserts hard break / new paragraph)
    return false;
  };

  // --- File handling ---
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      // Reset the input so the same file can be selected again
      e.target.value = '';
    }
  }, [addFiles]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = (e as any).clipboardData?.files as FileList | undefined;
    if (items && items.length > 0) {
      e.preventDefault();
      addFiles(items);
      return true;
    }
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    // Internal file tree drag uses mouse events (not HTML5 drag), so won't reach here.
    // OS file drops are handled by Tauri onDragDropEvent in useFileAttachments.
  }, []);

  return (
    <div
      className="p-4 relative"
      onWheel={handleWheelForward}
    >
      <div className="max-w-3xl mx-auto">
        {/* Rewind Panel — positioned above the input area */}
        {showRewindPanel && (
          <Suspense fallback={null}>
            <RewindPanel key={selectedSessionId || 'new'} onClose={() => setShowRewindPanel(false)} />
          </Suspense>
        )}

        {/* Floating approval card — plan_review, question, or permission awaiting user response */}
        {floatingCard && (
          <div key={`${selectedSessionId || 'new'}-${floatingCard.id}`} className="mb-3 animate-scale-in">
            {floatingCard.type === 'plan_review'
              ? <PlanReviewCard message={floatingCard} floating />
              : floatingCard.type === 'permission'
                ? <PermissionCard message={floatingCard} />
                : <QuestionCard message={floatingCard} floating />}
          </div>
        )}

        {/* File upload chips */}
        {(files.length > 0 || isProcessing) && (
          <div className="mb-2">
            <FileUploadChips files={files} onRemove={removeFile} isProcessing={isProcessing} />
          </div>
        )}

        {/* Active prefix description — shown above textarea when a command is selected */}
        {activePrefix && (
          <div className="mb-1 px-1">
            <span className="text-[10px] text-text-tertiary">{activePrefix.description}</span>
          </div>
        )}

        {/* Status strip above the editor — three modes:
            1. Streaming but no tokens yet → what the agent is doing (cold start,
               thinking, tool run…) so the strip is never empty.
            2. Streaming with tokens → live speed + turn average.
            3. Finished → pinned final average until the next turn. */}
        {(tokenSpeedTab && (tokenSpeedTab.isStreaming
          || (tokenSpeedTab.endedAt && (tokenSpeedTab.turnTokens > 0 || tokenSpeedTab.apiAvg > 0
            || tokenSpeedTab.firstTokenAvgMs != null || tokenSpeedTab.decodeTps != null))))
          || (streamIsStreaming && (tokenSpeedTab?.turnTokens ?? 0) === 0) ? (
          <div className="mb-1 px-1 flex items-center">
            {streamIsStreaming && (tokenSpeedTab?.turnTokens ?? 0) === 0 ? (
              <span className="text-[10px] text-text-tertiary flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 bg-accent animate-pulse-soft rounded-full" />
                {activityPhase === 'thinking' ? t('chat.thinking')
                  : activityPhase === 'writing' ? t('chat.writing')
                  : activityPhase === 'tool' ? `${t('chat.runningTool')}: ${activityToolName || ''}`
                  : activityPhase === 'awaiting' ? t('chat.awaiting')
                  : activityPhase === 'error' ? t('chat.error')
                  : t('chat.coldStarting')}
              </span>
            ) : tokenSpeedTab.isStreaming ? (
              <span className="text-[10px] text-text-tertiary tabular-nums">
                {t('chat.tokenSpeedLive', {
                  speed: String(Math.round(tokenSpeedTab.speed)),
                  avg: String(Math.round(tokenSpeedTab.avg)),
                })}
              </span>
            ) : (
              <span className="text-[10px] text-text-tertiary tabular-nums">
                {tokenSpeedTab.firstTokenAvgMs != null || tokenSpeedTab.decodeTps != null ? (
                  // DeepSeek bottom-layer truth (sessionStats deltas from DSH's
                  // own timing module — not a client-side estimate).
                  <span className="inline-flex items-center gap-1.5">
                    {tokenSpeedTab.firstTokenAvgMs != null && (
                      <span>{t('chat.tokenSpeedDshFirstToken', { firstToken: formatFirstToken(tokenSpeedTab.firstTokenAvgMs) })}</span>
                    )}
                    {tokenSpeedTab.decodeTps != null && tokenSpeedTab.decodeTps > 0 && (
                      <span>{t('chat.tokenSpeedDshDecode', { tps: tokenSpeedTab.decodeTps.toFixed(1) })}</span>
                    )}
                  </span>
                ) : tokenSpeedTab.apiAvg > 0 ? (
                  t('chat.tokenSpeedApiAvg', { avg: String(tokenSpeedTab.apiAvg) })
                ) : (
                  t('chat.tokenSpeedAvg', { avg: String(Math.round(tokenSpeedTab.avg)) })
                )}
              </span>
            )}
          </div>
        ) : null}

        {/* GoalBar — DSH session goal dock above the composer */}
        <GoalBar />

        {/* TodoDock — DSH standing task list: total steps + spinner/checkmark
            per item (todo/write events from the DeepSeek backend) */}
        <TodoDock />

        {/* QueueDock — DSH busy-Enter queue: count bar + expandable items
            with per-message steer (插话) and delete */}
        {pendingCount > 0 && (
          <div className="mb-1.5 rounded-lg
            bg-warning/10 border border-warning/20 animate-fade-in overflow-hidden">
            <div
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none"
              onClick={() => setQueueOpen(!queueOpen)}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.5" className="text-warning flex-shrink-0">
                <rect x="3" y="2" width="6" height="6" rx="1" />
                <path d="M6 8v2M4.5 10h3" />
              </svg>
              <span className="flex-1 text-[11px] text-warning">
                {t('input.pendingQueued', { n: String(pendingCount) })}
              </span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.5"
                className={`text-warning/70 transition-transform duration-150 ${queueOpen ? 'rotate-90' : ''}`}>
                <path d="M3 2l4 3-4 3" />
              </svg>
              <button
                onClick={(e) => { e.stopPropagation(); cancelPending(); }}
                className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium
                  bg-warning/10 text-warning hover:bg-warning/20 transition-smooth"
              >
                {t('input.pendingCancel')}
              </button>
            </div>
            {queueOpen && pendingMessages.length > 0 && (
              <div className="border-t border-warning/15 px-3 py-1.5 space-y-1 max-h-40 overflow-y-auto">
                {pendingMessages.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] group/queue">
                    <span className="flex-1 truncate text-text-secondary">{m}</span>
                    {/* Steer: interrupt the running turn and send this queued message live */}
                    <button
                      onClick={(e) => { e.stopPropagation(); void steerQueued(m, i); }}
                      title={t('input.pendingSteer')}
                      className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center
                        text-text-tertiary hover:text-ongoing hover:bg-bg-layer-2 transition-smooth"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                        <path d="M2 6l8 0M6.5 2.5L10 6l-3.5 3.5" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeQueued(i); }}
                      title={t('input.pendingRemove')}
                      className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center
                        text-text-tertiary hover:text-error hover:bg-bg-layer-2 transition-smooth"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                        stroke="currentColor" strokeWidth="1.5">
                        <path d="M3 3l6 6M9 3l-6 6" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Main input area */}
        <div className="relative">
          <SlashCommandPopover
            query={slashQuery}
            visible={slashVisible}
            selectedIndex={slashIndex}
            onSelect={handleSlashSelect}
            onClose={() => setSlashVisible(false)}
          />
          <div
            className={`flex items-center gap-2 bg-bg-input border rounded-2xl px-4 py-2.5
              focus-within:border-border-focus focus-within:shadow-glow
              transition-smooth group/input
              ${isDragging
                ? 'border-accent bg-accent/5 shadow-glow'
                : 'border-border-subtle'
              }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
          {/* Prefix chip + textarea inline */}
          <div className="flex-1 flex items-start gap-0 min-w-0">
            {activePrefix && (
              <div className="flex-shrink-0 flex items-center h-[24px] mt-[2px]">
                <span className="inline-flex items-center gap-1 px-2 py-0.5
                  bg-accent/10 border border-accent/20 rounded-md
                  text-xs text-accent font-medium font-mono whitespace-nowrap mr-1.5">
                  {activePrefix.name}
                  <button
                    onClick={() => useCommandStore.getState().clearPrefix()}
                    className="hover:text-red-400 transition-smooth ml-0.5"
                  >
                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                      stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 3l6 6M9 3l-6 6" />
                    </svg>
                  </button>
                </span>
              </div>
            )}
            <TiptapEditor
              ref={textareaRef}
              data-chat-input
              onUpdate={(text) => {
                setInput(text);
                detectSlashCommand(text);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={activePrefix
                ? t('input.prefixPlaceholder')
                : isRunning
                  ? t('input.followUp')
                  : t('input.placeholder')}
              className="flex-1 bg-transparent text-sm text-text-primary
                placeholder:text-text-tertiary resize-none outline-none
                leading-normal overflow-y-auto min-w-0 py-0.5"
            />
          </div>
          {/* Shortcut hint — visible when input area is not focused and input is empty */}
          {!input && !activePrefix && !isRunning && (
            <span className="flex-shrink-0 text-[10px] text-text-tertiary/50
              group-focus-within/input:hidden select-none whitespace-nowrap
              self-center mr-1">
              {t('input.shortcutHint')}
            </span>
          )}
          {/* Stop button — visible only while running */}
          {isRunning && (
            <button
              onClick={() => {
                const stopTabId = useSessionStore.getState().selectedSessionId;
                // U3: Stop 语义重做 —— "先中断后杀"，与侧栏右键"停止"共用同一入口：
                //   · claude/codex：先发 control interrupt，2 秒内无 result/process_exit
                //     再 killSession 兜底（markKilledStdin 保留 fix11 stale-exit 语义）
                //   · deepseek：保持直接 kill（kill_session 已映射 session.cancel）
                // 被停止的会话显示 'stopped'（琥珀点 + "已停止"），不再是 completed 绿点。
                // 中断成功时进程保留，输入框可继续对话；排队消息回退到草稿（H6 语义）。
                if (stopTabId) void stopSessionGracefully(stopTabId);
              }}
              className="flex-shrink-0 self-end w-8 h-8 rounded-[12px]
                bg-red-500/15 text-red-500
                flex items-center justify-center
                hover:bg-red-500/25 transition-smooth"
              title={t('input.stop')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16"
                fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="2" />
              </svg>
            </button>
          )}
          <button
            onClick={() => void handleSubmit()}
            disabled={isAwaiting || (!input.trim() && !activePrefix)}
            className={`flex-shrink-0 self-end w-8 h-8 rounded-[12px]
              flex items-center justify-center transition-smooth
              disabled:opacity-30 disabled:cursor-not-allowed
              ${isAwaiting
                ? 'bg-warning/15 text-warning cursor-not-allowed'
                : 'bg-accent hover:bg-accent-hover text-text-inverse hover:shadow-glow cursor-pointer'
              }`}
            title={isAwaiting ? t('input.awaitingInteraction') : undefined}
          >
            <svg width="16" height="16" viewBox="0 0 16 16"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </button>
          </div>
        </div>

        {/* Tool row: upload, mode, model */}
        <div className="flex items-center gap-2 mt-2 px-1">
          {/* Upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 rounded-lg text-text-tertiary
              hover:text-text-primary hover:bg-bg-secondary
              transition-smooth"
            title={t('input.attachFiles')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M14 8.5l-5.5 5.5a3.5 3.5 0 01-5-5l6-6a2.5 2.5 0 013.5 3.5l-6 6a1.5 1.5 0 01-2-2l5.5-5.5" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          <button
            onClick={handlePickWorkingDirectory}
            disabled={isRunning}
            className="inline-flex items-center gap-1.5 max-w-[220px] px-2 py-1 rounded-lg text-xs
              text-text-secondary hover:text-text-primary hover:bg-bg-secondary
              disabled:opacity-40 disabled:cursor-not-allowed transition-smooth"
            title={workingDirectory || t('input.selectFolder')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className="flex-shrink-0">
              <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" />
              <path d="M2.5 4.5v-1h4.4l1.1 1.3" />
            </svg>
            <span className="truncate">{workingDirectoryLabel}</span>
          </button>

          <ModeSelector />

          {/* Think toggle */}
          <ThinkLevelSelector disabled={isRunning} />

          {/* DeepSeek agent preset — mirrors the DSH harness preset picker
              (full-tool baseline by default; the profile default is often a
              bootstrap preset hiding bash/web-search) */}
          <AgentPresetSelector disabled={isRunning} />

          {/* Rewind button */}
          {showRewind && (
            <button
              onClick={() => { if (canRewind) setShowRewindPanel(!showRewindPanel); }}
              disabled={!canRewind}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-smooth
                ${canRewind
                  ? 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary cursor-pointer'
                  : 'text-text-muted cursor-not-allowed opacity-50'
                }`}
              title={canRewind ? `${t('rewind.title')} (Esc×2)` : t('rewind.disabled')}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
                <path d="M2 7a5 5 0 019.33-2.5M12 7a5 5 0 01-9.33 2.5"
                  strokeLinecap="round" />
                <path d="M11 2v3h-3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 12V9h3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[10px]">{t('rewind.title')}</span>
            </button>
          )}

          {/* Speech-to-text mic button */}
          {speechEnabled && speech.isSupported && (
            <div className="relative">
              <button
                onClick={() => {
                  if (speech.phase === 'idle') speech.startListening();
                  else if (speech.phase === 'listening') speech.stopListening();
                }}
                disabled={isRunning}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-smooth cursor-pointer
                  ${speech.phase === 'listening'
                    ? 'text-red-500 bg-red-500/10 border border-red-500/20'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                  } ${isRunning ? 'opacity-40 pointer-events-none' : ''}`}
                title={t('speech.input')}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  className="flex-shrink-0">
                  <rect x="6" y="1" width="4" height="9" rx="2" />
                  <path d="M3 7a5 5 0 0010 0" />
                  <path d="M8 13v2M5 15h6" />
                </svg>
                <span className="text-[10px]">{t('speech.input')}</span>
              </button>

              {/* Floating speech panel */}
              {speech.phase !== 'idle' && (
                <div className="absolute bottom-full left-0 mb-2 w-[320px]
                  bg-bg-card border border-border-subtle rounded-xl shadow-2xl
                  p-4 z-50 animate-fade-in">
                  {/* Listening phase */}
                  {speech.phase === 'listening' && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-[13px] font-medium text-text-primary">
                          {t('speech.listening')}
                        </span>
                      </div>
                      <p className="text-[12px] text-text-secondary leading-relaxed min-h-[2em]">
                        {speech.interimText || speech.finalText || t('speech.tapToStop')}
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={speech.cancel}
                          className="flex-1 px-3 py-1.5 rounded-lg text-[12px]
                            text-text-muted border border-border-subtle
                            hover:bg-bg-secondary transition-smooth"
                        >
                          {t('speech.cancel')}
                        </button>
                        <button
                          onClick={speech.stopListening}
                          className="flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium
                            bg-accent text-white hover:opacity-90 transition-smooth"
                        >
                          {t('speech.confirm')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Confirming phase — show raw transcription, [取消] [确定] */}
                  {speech.phase === 'confirming' && (
                    <div className="space-y-3">
                      <h4 className="text-[12px] font-medium text-text-primary">
                        {t('speech.confirm')}
                      </h4>
                      <p className="text-[13px] text-text-primary leading-relaxed bg-bg-secondary/50
                        rounded-lg p-2.5 max-h-[120px] overflow-y-auto">
                        {speech.finalText}
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={speech.cancel}
                          className="flex-1 px-3 py-1.5 rounded-lg text-[12px]
                            text-text-muted border border-border-subtle
                            hover:bg-bg-secondary transition-smooth"
                        >
                          {t('speech.cancel')}
                        </button>
                        <button
                          onClick={speech.confirm}
                          className="flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium
                            bg-accent text-white hover:opacity-90 transition-smooth"
                        >
                          {t('speech.confirm')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Editing phase — textarea for correction, [取消] [确认输入] */}
                  {speech.phase === 'editing' && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-[12px] font-medium text-text-primary">
                          {t('speech.editTitle')}
                        </h4>
                        <span className="text-[10px] text-text-tertiary">
                          {t('speech.editHint')}
                        </span>
                      </div>
                      <textarea
                        value={speech.editText}
                        onChange={(e) => speech.setEditText(e.target.value)}
                        className="w-full h-[80px] px-2.5 py-2 rounded-lg text-[13px] bg-bg-input
                          border border-border-subtle text-text-primary resize-none
                          outline-none focus:border-border-focus leading-relaxed"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={speech.cancel}
                          className="flex-1 px-3 py-1.5 rounded-lg text-[12px]
                            text-text-muted border border-border-subtle
                            hover:bg-bg-secondary transition-smooth"
                        >
                          {t('speech.cancel')}
                        </button>
                        <button
                          onClick={confirmSpeechInput}
                          className="flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium
                            bg-accent text-white hover:opacity-90 transition-smooth"
                        >
                          {t('speech.confirmInput')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Plan view button */}
          <PlanToggleButton />

          {/* Model selector */}
          <ModelSelector disabled={isRunning} />
        </div>
      </div>
    </div>
  );
}
