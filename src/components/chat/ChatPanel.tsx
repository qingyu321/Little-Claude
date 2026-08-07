import { useRef, useEffect, useLayoutEffect, useState, useMemo, useCallback, memo } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { create } from 'zustand';
import { useChatStore, useActiveTab, generateMessageId, type ChatMessage, type SessionMeta } from '../../stores/chatStore';
import { MessageBubble } from './MessageBubble';
import { showToast } from '../shared/Toast';
import { ToolGroup } from './ToolGroup';
import { InputBar } from './InputBar';
import { ExportMenu } from '../conversations/ExportMenu';
import { UpdateButton } from '../shared/UpdateButton';
import {
  useSettingsStore,
  MODEL_OPTIONS,
  mapSessionModeToPermissionMode,
  getContextWindowForModel,
  getAutoCompactThreshold,
} from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useFileStore } from '../../stores/fileStore';
import { useAgentStore } from '../../stores/agentStore';
import { AgentPanel } from '../agents/AgentPanel';
import { bridge, onClaudeStream, onClaudeStderr } from '../../lib/tauri-bridge';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { envFingerprint, resolveModelForProvider, resolveThinkingLevelForProvider } from '../../lib/api-provider';
import { useProviderStore } from '../../stores/providerStore';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { registerStreamListener } from '../../lib/stream-cleanup';
import { SetupWizard } from '../setup/SetupWizard';
import { AiAvatar } from '../shared/AiAvatar';
import { displayDeepSeekModelName } from '../../lib/model-utils';
import { parseTurns, type Turn } from '../../lib/turns';
import { ConfirmDialog } from '../shared/ConfirmDialog';

/** Shared plan panel toggle — used by ChatPanel (panel) and InputBar (button) */
export const usePlanPanelStore = create<{
  open: boolean;
  toggle: () => void;
  close: () => void;
}>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

/** Resizable right-side plan panel */
function PlanPanel({ planMessages, onClose }: {
  planMessages: ChatMessage[];
  onClose: () => void;
}) {
  const t = useT();
  const [width, setWidth] = useState(420);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const widthRef = useRef(width);
  widthRef.current = width;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = widthRef.current;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging left edge → moving left = wider
      const delta = startX.current - ev.clientX;
      const newWidth = Math.max(280, Math.min(800, startW.current + delta));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <div
      className="absolute right-3 top-3 bottom-3 z-20
        bg-bg-card/80 backdrop-blur-xl border border-white/10 rounded-2xl
        shadow-2xl shadow-black/20
        flex flex-col overflow-hidden"
      style={{ width }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize
          hover:bg-accent/20 active:bg-accent/30 transition-colors z-10"
        onMouseDown={handleMouseDown}
      />
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5
        border-b border-border-subtle bg-accent/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-accent">
            <path d="M2 3.5h10M2 7h8M2 10.5h5" />
          </svg>
          <span className="text-xs font-semibold text-text-primary">
            {t('msg.planTitle')}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-bg-tertiary text-text-tertiary
            transition-smooth cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {planMessages.length === 0 ? (
          <p className="text-xs text-text-muted text-center py-4">
            {t('msg.noPlan')}
          </p>
        ) : (
          planMessages.map((planMsg) => (
            <div key={planMsg.id} className="text-sm leading-relaxed">
              <MarkdownRenderer content={planMsg.planContent || planMsg.content || ''} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Map raw model ID to friendly display name */
function getModelDisplayName(modelId: string): string {
  const option = MODEL_OPTIONS.find((m) => modelId.includes(m.id));
  return option?.short || displayDeepSeekModelName(modelId);
}


/** Format token count: "3.2k" for >=1000, raw number for <1000 */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format elapsed seconds into "Xm Ys" or "Xs" */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/** Cycling typewriter text for thinking phase — like Claude Code website "Built for > coders" */
const THINKING_WORD_COUNT = 17;
const TYPING_SPEED = 80;      // ms per character (typing)
const DELETING_SPEED = 40;    // ms per character (deleting)
const PAUSE_DURATION = 2500;  // ms to hold full word
const TRANSITION_DELAY = 300; // ms between delete and next word

/** Fisher-Yates shuffle, always starts with index 0 ("思考中"/"Thinking") */
function shuffledOrder(count: number): number[] {
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = arr.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(Math.random() * i); // skip index 0
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function CyclingThinkingText() {
  const t = useT();
  const [order, setOrder] = useState(() => shuffledOrder(THINKING_WORD_COUNT));
  const [cursor, setCursor] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'pausing' | 'deleting' | 'waiting'>('typing');

  const wordIndex = order[cursor];
  const fullWord = t(`chat.thinkingCycle.${wordIndex}`);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (phase === 'typing') {
      if (displayText.length < fullWord.length) {
        timer = setTimeout(() => {
          setDisplayText(fullWord.slice(0, displayText.length + 1));
        }, TYPING_SPEED);
      } else {
        timer = setTimeout(() => setPhase('pausing'), 0);
      }
    } else if (phase === 'pausing') {
      timer = setTimeout(() => setPhase('deleting'), PAUSE_DURATION);
    } else if (phase === 'deleting') {
      if (displayText.length > 0) {
        timer = setTimeout(() => {
          setDisplayText(displayText.slice(0, -1));
        }, DELETING_SPEED);
      } else {
        const nextCursor = cursor + 1;
        if (nextCursor >= THINKING_WORD_COUNT) {
          // Reshuffle when all words shown
          setOrder(shuffledOrder(THINKING_WORD_COUNT));
          setCursor(0);
        } else {
          setCursor(nextCursor);
        }
        setPhase('waiting');
      }
    } else if (phase === 'waiting') {
      timer = setTimeout(() => {
        setDisplayText('');
        setPhase('typing');
      }, TRANSITION_DELAY);
    }

    return () => clearTimeout(timer);
  }, [displayText, phase, fullWord, cursor]);

  return (
    <span className="inline-flex items-baseline">
      <span>{displayText}</span>
      <span className="text-text-tertiary">...</span>
    </span>
  );
}

/**
 * Returns a localized thinking stage label based on actual thinking output length.
 * Mimics the Claude CLI's progressive "Thinking… / Thinking more… / Almost done…" status
 * which is based on thinking content volume, not wall-clock time.
 */
function getThinkingStage(thinkingLen: number, t: (k: string) => string): string | null {
  if (thinkingLen < 300) return null;            // Keep CyclingThinkingText for early thinking
  if (thinkingLen < 1500) return t('chat.thinkingMore');
  if (thinkingLen < 4000) return t('chat.almostDone');
  return t('chat.stillThinking');
}

/**
 * Sleeping "z Z Z" animation — small z → medium Z → large Z, cascading sizes.
 * Sizes are simulated with transform scale inside a fixed-height container:
 * the previous font-size steps (10/14/18px) grew the row height and pushed
 * the "thinking" line above up and down. Scale transforms never affect layout,
 * so the indicator height stays constant through the whole cycle.
 */
function SleepingZzz() {
  const [step, setStep] = useState(0); // 0=rest, 1=small z, 2=+medium Z, 3=+large Z

  useEffect(() => {
    if (step >= 3) {
      // All three visible briefly, then reset
      const id = setTimeout(() => setStep(0), 600);
      return () => clearTimeout(id);
    }
    // Phase in each letter
    const id = setTimeout(() => setStep(step + 1), step === 0 ? 200 : 350);
    return () => clearTimeout(id);
  }, [step]);

  return (
    <span className="relative inline-flex items-end h-[18px] w-8 ml-1 text-sm
      text-accent/60 select-none">
      {step >= 1 && (
        <span className="absolute left-0 bottom-0 scale-[0.6] opacity-70
          animate-in fade-in duration-200">
          z
        </span>
      )}
      {step >= 2 && (
        <span className="absolute left-2.5 bottom-0 scale-[0.85] opacity-85 font-medium
          animate-in fade-in duration-200">
          Z
        </span>
      )}
      {step >= 3 && (
        <span className="absolute left-5 bottom-0 scale-100 font-bold
          animate-in fade-in duration-200">
          Z
        </span>
      )}
    </span>
  );
}

/** Activity indicator with elapsed time and token count */
function ActivityIndicator({ activityStatus, sessionMeta, thinkingLength }: {
  activityStatus: { phase: string; toolName?: string; statusMessage?: string };
  sessionMeta: {
    turnStartTime?: number;
    outputTokens?: number;
    inputTokens?: number;
    lastProgressAt?: number;
    spawnedModel?: string;
    snapshotModel?: string;
    snapshotContextWindowMode?: import('../../stores/settingsStore').ContextWindowMode;
  };
  /** Current thinking text length — used to derive the thinking stage label */
  thinkingLength: number;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const phaseText = activityStatus.phase === 'thinking' ? t('chat.thinking')
    : activityStatus.phase === 'writing' ? t('chat.writing')
    : activityStatus.phase === 'tool' ? `${t('chat.runningTool')}: ${activityStatus.toolName || ''}`
    : activityStatus.phase === 'awaiting' ? t('chat.awaiting')
    : activityStatus.phase === 'error' ? t('chat.error')
    : t('chat.running');

  const elapsed = sessionMeta.turnStartTime ? formatElapsed(now - sessionMeta.turnStartTime) : null;
  const tokens = sessionMeta.outputTokens ? formatTokens(sessionMeta.outputTokens) : null;
  const statsText = elapsed
    ? tokens ? `(${elapsed} · ↓ ${tokens})` : `(${elapsed})`
    : null;

  // Context pressure warning: threshold depends on model context window size
  // 1M models (claude-opus-4-6-1m, mimo-v2-pro[1m]) → warn at 600K; others at 120K (60% of 200K)
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const resolvedModel = sessionMeta.spawnedModel
    || sessionMeta.snapshotModel
    || resolveModelForProvider(selectedModel);
  const contextWindow = getContextWindowForModel(
    resolvedModel,
    sessionMeta.snapshotContextWindowMode ?? contextWindowMode,
  );
  const inputTokens = sessionMeta.inputTokens || 0;
  const contextWarning = inputTokens > contextWindow * 0.6;

  // Stall detection: 120s of silence (no stream activity), not total elapsed time.
  const stallWarning = !!sessionMeta.lastProgressAt
    && !!elapsed
    && (now - sessionMeta.lastProgressAt) > 120_000;

  const isThinking = activityStatus.phase === 'thinking';
  const isError = activityStatus.phase === 'error';
  const thinkingStage = isThinking ? getThinkingStage(thinkingLength, t) : null;

  return (
    <div className="py-1">
      {/* Line 1: main status — typewriter animation (thinking) or phase text + elapsed/tokens */}
      <div className="flex items-center gap-1.5">
        <span className={`text-sm font-medium leading-none text-accent
          ${isThinking ? '' : isError ? 'text-red-400' : 'animate-pulse-soft'}`}>/</span>
        <span className={`text-sm ${isError ? 'text-red-400' : 'text-text-muted'}`}>
          {isThinking ? <CyclingThinkingText /> : (
            activityStatus.statusMessage || phaseText
          )}
          {statsText && (
            <span className={`ml-1.5 ${stallWarning ? 'text-red-400' : 'text-text-tertiary'}`}>{statsText}</span>
          )}
        </span>
        {/* API error / reconnection status message */}
        {activityStatus.statusMessage && !isThinking && (
          <span className="text-xs text-red-400 ml-1 flex items-center gap-1">
            <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
            </svg>
            {activityStatus.statusMessage}
          </span>
        )}
        {stallWarning && (
          <span className="text-xs text-red-400 ml-2 flex items-center gap-1">
            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
            </svg>
            {t('chat.stallWarning')}
          </span>
        )}
        {contextWarning && !stallWarning && (
          <span className="text-xs text-amber-500 ml-2 flex items-center gap-1"
                title={t('chat.tokenWarning')}>
            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
            {t('chat.tokenWarning')}
          </span>
        )}
      </div>
      {/* Line 2: thinking stage indicator — appears after 300 chars below the typewriter line */}
      {thinkingStage && (
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-sm font-medium leading-none text-accent invisible">/</span>
          <span className="text-xs text-accent/70">{thinkingStage}</span>
          <SleepingZzz />
        </div>
      )}
    </div>
  );
}

/** Dropdown to switch between Claude CLI and Codex CLI from the chat header. */
function CliBackendToggle() {
  const t = useT();
  const cliBackend = useSettingsStore((s) => s.cliBackend);
  const setCliBackend = useSettingsStore((s) => s.setCliBackend);
  const [open, setOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<'claude' | 'codex' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const label = (b: string) => b === 'codex' ? 'Codex' : 'Claude';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded
          transition-smooth hover:bg-bg-tertiary cursor-pointer
          ${cliBackend === 'codex'
            ? 'text-accent bg-accent/10'
            : 'text-text-tertiary'}`}
        title={t('conv.convert')}
      >
        <span>{label(cliBackend)}</span>
        <svg
          className={`w-2.5 h-2.5 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[150px]
          bg-bg-card border border-border-subtle rounded-xl shadow-lg
          py-1 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
          {(['claude', 'codex'] as const).map((b) => {
            const isCurrent = cliBackend === b;
            return (
              <button
                key={b}
                disabled={isCurrent}
                onClick={() => { if (!isCurrent) { setConfirmTarget(b); setOpen(false); } }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between
                  transition-smooth cursor-pointer
                  ${isCurrent
                    ? 'text-accent bg-accent/5 opacity-50 cursor-default'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                <span>{t('conv.convertTo', { target: label(b) })}</span>
                {isCurrent && (
                  <span className="text-[10px] opacity-60">{t('conv.convertCurrent')}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Confirm dialog for backend switch */}
      <ConfirmDialog
        open={confirmTarget !== null}
        title={t('conv.backendSwitchTitle', { target: confirmTarget ? label(confirmTarget) : '' })}
        message={t('conv.backendSwitchMessage', {
          source: label(cliBackend),
          target: confirmTarget ? label(confirmTarget) : '',
        })}
        confirmLabel={t('conv.backendSwitchBtn')}
        variant="default"
        onConfirm={() => {
          if (confirmTarget) setCliBackend(confirmTarget);
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

/** Dropdown to switch the current session's backend (with confirmation). */
function ConvertBackendButton() {
  const t = useT();
  const cliBackend = useSettingsStore((s) => s.cliBackend);
  const setCliBackend = useSettingsStore((s) => s.setCliBackend);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<'claude' | 'codex' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [dropdownOpen]);

  const label = (b: string) => b === 'codex' ? 'Codex' : 'Claude';

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded
          transition-smooth hover:bg-bg-tertiary text-text-tertiary cursor-pointer"
        title={t('conv.convert')}
      >
        <span>+</span>
        <span>{t('conv.convert')}</span>
        <svg
          className={`w-2.5 h-2.5 transition-transform duration-150 ${dropdownOpen ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {dropdownOpen && (
        <div className="absolute top-full left-0 mt-1 min-w-[150px]
          bg-bg-card border border-border-subtle rounded-xl shadow-lg
          py-1 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
          {(['claude', 'codex'] as const).map((target) => {
            const isCurrent = cliBackend === target;
            return (
              <button
                key={target}
                disabled={isCurrent}
                onClick={() => { if (!isCurrent) setConfirmTarget(target); }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between
                  transition-smooth cursor-pointer
                  ${isCurrent
                    ? 'text-accent bg-accent/5 opacity-50 cursor-default'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                <span>{t('conv.convertTo', { target: label(target) })}</span>
                {isCurrent && (
                  <span className="text-[10px] opacity-60">{t('conv.convertCurrent')}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={confirmTarget !== null}
        title={t('conv.backendSwitchTitle', { target: confirmTarget ? label(confirmTarget) : '' })}
        message={t('conv.backendSwitchMessage', {
          source: label(cliBackend),
          target: confirmTarget ? label(confirmTarget) : '',
        })}
        confirmLabel={t('conv.backendSwitchBtn')}
        variant="default"
        onConfirm={() => {
          if (confirmTarget) setCliBackend(confirmTarget);
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

function ContextMeter({ sessionMeta, tabId, sessionStatus }: {
  sessionMeta: SessionMeta;
  tabId: string | null;
  sessionStatus?: string;
}) {
  const t = useT();
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const autoCompactThresholdTokens = useSettingsStore((s) => s.autoCompactThresholdTokens);
  const [isCompacting, setIsCompacting] = useState(false);
  const modelForContext = sessionMeta.spawnedModel
    || sessionMeta.snapshotModel
    || sessionMeta.model
    || resolveModelForProvider(selectedModel);
  const effectiveContextMode = sessionMeta.snapshotContextWindowMode ?? contextWindowMode;
  const contextWindow = getContextWindowForModel(modelForContext, effectiveContextMode);
  const compactThreshold = getAutoCompactThreshold(modelForContext, effectiveContextMode, autoCompactThresholdTokens);
  const used = Math.min(contextWindow, Math.max(0,
    (sessionMeta.inputTokens ?? 0) + (sessionMeta.outputTokens ?? 0),
  ));
  const available = Math.max(0, contextWindow - used);
  const percent = Math.min(100, Math.round((used / contextWindow) * 100));
  const thresholdPercent = Math.min(100, Math.round((compactThreshold / contextWindow) * 100));
  const isBusy = sessionStatus === 'running';
  const canCompact = Boolean(tabId && sessionMeta.stdinId && !isBusy && !isCompacting);

  const handleCompact = async () => {
    if (!tabId || !sessionMeta.stdinId || isBusy) return;
    setIsCompacting(true);
    const processingMsgId = generateMessageId();
    const store = useChatStore.getState();
    store.addMessage(tabId, {
      id: processingMsgId,
      role: 'system',
      type: 'text',
      content: '',
      commandType: 'processing',
      commandData: { command: '/compact' },
      commandStartTime: Date.now(),
      commandCompleted: false,
      timestamp: Date.now(),
    });
    store.setSessionMeta(tabId, { pendingCommandMsgId: processingMsgId });
    store.setSessionStatus(tabId, 'running');
    store.setActivityStatus(tabId, { phase: 'thinking' });
    try {
      await bridge.sendStdin(sessionMeta.stdinId, '/compact');
    } catch (e) {
      store.setSessionMeta(tabId, { pendingCommandMsgId: undefined });
      store.setSessionStatus(tabId, 'error');
      console.warn('[LITTLECLAUDE] manual compact failed:', e);
      // A10: the UI recovers state but the user never learns the compact
      // didn't happen — surface it.
      showToast(t('chat.compactFailed'), 'error');
    } finally {
      setIsCompacting(false);
    }
  };

  return (
    <div className="hidden md:flex items-center gap-2 ml-2 px-2 py-1 rounded-lg
      bg-bg-secondary/60 border border-border-subtle text-[10px] text-text-tertiary"
      title={`Actual model: ${displayDeepSeekModelName(modelForContext)}; context used ${used.toLocaleString()} / ${contextWindow.toLocaleString()}; available ${available.toLocaleString()}; auto compact at ${compactThreshold.toLocaleString()}`}>
      <span className="font-medium text-text-muted">Ctx</span>
      <div className="w-20 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={`h-full rounded-full ${percent >= thresholdPercent ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={percent >= thresholdPercent ? 'text-warning' : 'text-text-tertiary'}>
        {percent}%
      </span>
      <span>{formatTokens(available)} free</span>
      <button
        onClick={handleCompact}
        disabled={!canCompact}
        className="px-1.5 py-0.5 rounded bg-bg-tertiary hover:bg-bg-hover
          text-text-muted hover:text-text-primary disabled:opacity-40 disabled:hover:bg-bg-tertiary"
        title={canCompact ? 'Compact context now' : 'Compact is available after a live session is idle'}
      >
        Compact
      </button>
    </div>
  );
}

function ConversationTimeline({ turns, activeTurnId, showScrollBtn, onJumpTurn, onJumpBottom }: {
  turns: Turn[];
  activeTurnId?: string;
  showScrollBtn: boolean;
  onJumpTurn: (turn: Turn) => void;
  onJumpBottom: () => void;
}) {
  const t = useT();
  if (turns.length === 0) return null;

  return (
    <div className="hidden lg:flex absolute right-3 top-24 bottom-28 z-10
      flex-col items-center gap-2 pointer-events-none">
      <div className="flex-1 min-h-0 px-1 py-2 rounded-full
        bg-bg-card/80 backdrop-blur border border-border-subtle shadow-lg
        overflow-y-auto scrollbar-none pointer-events-auto">
        <div className="flex flex-col items-center gap-1.5">
          {turns.map((turn) => {
            const active = activeTurnId === turn.userMessageId;
            return (
              <button
                key={turn.userMessageId}
                onClick={() => onJumpTurn(turn)}
                className={`group relative w-7 h-7 rounded-full text-[10px]
                  flex items-center justify-center border transition-smooth
                  ${active
                    ? 'bg-accent text-text-inverse border-accent shadow-md'
                    : 'bg-bg-secondary/70 text-text-tertiary border-border-subtle hover:text-text-primary hover:bg-bg-tertiary'
                  }`}
                title={`${t('chat.turn')} ${turn.index}: ${turn.userContent}`}
              >
                {turn.index > 99 ? '99+' : turn.index}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={onJumpBottom}
        className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1.5
          rounded-full border border-border-subtle bg-bg-card/90 backdrop-blur
          shadow-lg text-xs transition-smooth
          ${showScrollBtn
            ? 'text-accent hover:bg-accent/10'
            : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
          }`}
        title={t('chat.scrollToBottom')}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M7 2v10M3 8l4 4 4-4" />
        </svg>
        <span>{t('chat.latest')}</span>
      </button>
    </div>
  );
}

/** Max real distance (px) from the bottom that still counts as "at bottom"
 *  when a deferred detach expires. Virtuoso reports atBottom asynchronously
 *  and transiently flips it to false while the Footer height is still being
 *  measured (a few px short of the true bottom). Verifying the real scroll
 *  position against this threshold separates that measurement lag from a
 *  genuine user scroll-up. */
const DETACH_DISTANCE_PX = 64;

/** Streaming indicator — memo'd so it only re-renders when streaming content actually changes,
 *  not when unrelated message list or session state causes ChatPanel to re-render. */
const StreamingIndicator = memo(function StreamingIndicator({
  isStreaming,
  partialThinking,
  partialText,
  messages,
  t,
}: {
  isStreaming: boolean;
  partialThinking: string;
  partialText: string;
  messages: ChatMessage[];
  t: (key: string) => string;
}) {
  const thinkingPreRef = useRef<HTMLPreElement>(null);

  // Auto-scroll thinking <pre> to bottom as new content streams in
  useEffect(() => {
    const el = thinkingPreRef.current;
    if (el && partialThinking) {
      el.scrollTop = el.scrollHeight;
    }
  }, [partialThinking]);

  if (!isStreaming) return null;
  if (!partialThinking && !partialText) return null;

  // Hide streaming text while an unresolved question is pending
  const hasPendingQuestion = messages.some(
    (m) => m.type === 'question' && !m.resolved
      && m.interactionState !== 'resolved' && m.interactionState !== 'sending',
  );

  // Check if there's already an assistant text in this turn
  let showStreamAvatar = true;
  if (!hasPendingQuestion && partialText) {
    for (let j = messages.length - 1; j >= 0; j--) {
      if (messages[j].role === 'user') break;
      if (messages[j].role === 'assistant' && messages[j].type === 'text') {
        showStreamAvatar = false;
        break;
      }
    }
  }

  return (
    <>
      {partialThinking && (
        <div className="ml-11 mt-1">
          <details open className="group">
            <summary className="flex items-center gap-1.5 py-1
              cursor-pointer text-[11px] text-text-tertiary list-none select-none">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.5"
                className="transition-transform duration-150 group-open:rotate-90">
                <path d="M3 2l4 3-4 3" />
              </svg>
              {t('msg.thinking')}
              <span className="inline-block w-1.5 h-3 bg-text-tertiary ml-0.5
                animate-pulse-soft rounded-sm" />
            </summary>
            <pre ref={thinkingPreRef} className="ml-5 mt-0.5 text-[11px] text-text-tertiary
              whitespace-pre-wrap max-h-48 overflow-y-auto
              font-mono leading-relaxed">
              {partialThinking}
            </pre>
          </details>
        </div>
      )}
      {partialText && !hasPendingQuestion && (
        <div className="flex gap-3 mt-2">
          {showStreamAvatar ? (
            <div className="w-8 h-8 rounded-[10px] bg-accent
              flex items-center justify-center flex-shrink-0 text-text-inverse
              text-xs font-bold shadow-md mt-0.5">C</div>
          ) : (
            <div className="w-8 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed">
            <MarkdownRenderer content={partialText} />
            <span className="inline-block w-2 h-5 bg-accent ml-0.5
              animate-pulse-soft rounded-sm shadow-[0_0_8px_var(--color-accent-glow)]" />
          </div>
        </div>
      )}
    </>
  );
});

/**
 * Virtuoso Footer rendered as a STABLE module-level component. It sources its
 * own data from the stores instead of receiving ChatPanel props, so the
 * `components` object can be memoized once. This matters: an inline
 * `Footer: () => …` creates a new component type on every ChatPanel render,
 * and react-virtuoso remounts the Footer on a type change — wiping the
 * timer state inside CyclingThinkingText / SleepingZzz. During fast streaming
 * (a re-render per token) that reset every frame, so the typewriter never
 * finished a word and showed only "…". Re-renders of a stable component keep
 * state; only remounts lose it.
 */
function ChatFooter() {
  const t = useT();
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const messages = useActiveTab((tb) => tb.messages);
  const sessionStatus = useActiveTab((tb) => tb.sessionStatus);
  const sessionMeta = useActiveTab((tb) => tb.sessionMeta);
  const activityStatus = useActiveTab((tb) => tb.activityStatus);
  const isStreaming = useChatStore((s) =>
    selectedSessionId ? s.getStreamState(selectedSessionId).isStreaming : false);
  const partialText = useChatStore((s) =>
    selectedSessionId ? s.getStreamState(selectedSessionId).partialText : '');
  const partialThinking = useChatStore((s) =>
    selectedSessionId ? s.getStreamState(selectedSessionId).partialThinking : '');

  // Thinking volume for the progressive stage labels + SleepingZzz (need
  // >= 300). Max of the live partial (thinking_delta providers) and every
  // thinking bubble in the current turn (proxies that deliver thinking as
  // complete messages with no deltas). Max-over-turn escalates monotonically.
  const thinkingLength = useMemo(() => {
    let len = partialThinking.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') break;
      if (messages[i].type === 'thinking') {
        const c = messages[i].content;
        if (typeof c === 'string' && c.length > len) len = c.length;
      }
    }
    return len;
  }, [messages, partialThinking]);

  return (
    <div className="px-20">
      <StreamingIndicator
        isStreaming={isStreaming}
        partialThinking={partialThinking}
        partialText={partialText}
        messages={messages}
        t={t}
      />
      {(sessionStatus === 'running' || activityStatus.phase === 'awaiting') && (
        <ActivityIndicator
          activityStatus={activityStatus}
          sessionMeta={sessionMeta}
          thinkingLength={thinkingLength}
        />
      )}
    </div>
  );
}

export function ChatPanel() {
  const t = useT();
  const messages = useActiveTab((t) => t.messages);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const sessionMeta = useActiveTab((t) => t.sessionMeta);
  const sidebarOpen = useSettingsStore((s) => s.sidebarOpen);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const toggleSecondaryPanel = useSettingsStore((s) => s.toggleSecondaryPanel);
  const agentPanelOpen = useSettingsStore((s) => s.agentPanelOpen);
  const toggleAgentPanel = useSettingsStore((s) => s.toggleAgentPanel);
  const sessionMode = useSettingsStore((s) => s.sessionMode);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const directoryMissing = useFileStore((s) => s.directoryMissing);
  const cliBackendForProvider = useSettingsStore((s) => s.cliBackend) || 'claude';
  const activeProvider = useProviderStore((s) => {
    const id = s.activeProviderPerBackend[cliBackendForProvider] ?? null;
    if (!id) return null;
    return s.providers.find((p) => p.id === id) ?? null;
  });
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const isFilePreviewMode = !!useFileStore((s) => s.selectedFile);

  // Streaming state from lightweight streams Map (not tabs Map) — avoids full tabs copy on every token
  // Split into three primitive selectors so Zustand's Object.is comparison works correctly
  // (returning an object literal would create a new reference every render → infinite loop)
  const isStreaming = useChatStore((s) => {
    if (!selectedSessionId) return false;
    return s.getStreamState(selectedSessionId).isStreaming;
  });
  const partialText = useChatStore((s) => {
    if (!selectedSessionId) return '';
    return s.getStreamState(selectedSessionId).partialText;
  });
  const partialThinking = useChatStore((s) => {
    if (!selectedSessionId) return '';
    return s.getStreamState(selectedSessionId).partialThinking;
  });

  // Stable Virtuoso components object — see ChatFooter. Memoized once so
  // react-virtuoso never remounts the Footer (which would reset the timer
  // state in CyclingThinkingText / SleepingZzz on every streaming re-render).
  const virtuosoComponents = useMemo(() => ({ Footer: ChatFooter }), []);

  // Agent activity for floating button badge
  const agents = useAgentStore((s) => s.agents);
  const activeAgentCount = useMemo(
    () => Array.from(agents.values()).filter(
      (a) => a.phase !== 'completed' && a.phase !== 'error'
    ).length,
    [agents],
  );
  const totalAgentCount = agents.size;

  const showPlanPanel = usePlanPanelStore((s) => s.open);
  const closePlanPanel = usePlanPanelStore((s) => s.close);


  // Listen for internal file tree drag-drop (mouse-based, not HTML5 drag-and-drop)
  // HTML5 drag events don't work in Tauri because dragDropEnabled: true intercepts them.
  // Listen for file-chip click → open file in secondary panel's file browser
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const filePath = (e as CustomEvent<string>).detail;
      if (!filePath) return;
      // Open secondary panel to files tab and select the file
      useSettingsStore.getState().setSecondaryTab('files');
      useFileStore.getState().selectFile(filePath);
    };
    window.addEventListener('little-claude:open-file', onOpenFile);
    return () => window.removeEventListener('little-claude:open-file', onOpenFile);
  }, []);

  // --- Tool grouping: group 3+ consecutive tool_use messages ---
  type DisplayItem =
    | { kind: 'message'; msg: ChatMessage; idx: number }
    | { kind: 'tool_group'; msgs: ChatMessage[]; startIdx: number };

  const displayItems = useMemo<DisplayItem[]>(() => {
    const items: DisplayItem[] = [];
    let i = 0;
    while (i < messages.length) {
      // Detect runs of consecutive tool_use messages
      if (messages[i].type === 'tool_use') {
        let j = i;
        while (j < messages.length && messages[j].type === 'tool_use') j++;
        const runLength = j - i;
        if (runLength >= 3) {
          items.push({ kind: 'tool_group', msgs: messages.slice(i, j), startIdx: i });
          i = j;
          continue;
        }
      }
      items.push({ kind: 'message', msg: messages[i], idx: i });
      i++;
    }
    return items;
  }, [messages]);

  // Collect plan review messages from the session (created by ExitPlanMode)
  const planMessages = useMemo(
    () => messages.filter((m) => m.type === 'plan_review' || m.type === 'plan' || m.planContent),
    [messages],
  );

  // Find the path of the currently selected session for export
  const currentSessionPath = sessions.find(
    (s) => s.id === selectedSessionId
  )?.path;

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Wraps the Virtuoso list; used to reach the real scroller element
  // ([data-testid="virtuoso-scroller"]) for synchronous distance-to-bottom
  // checks when a deferred detach expires.
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Current "at bottom" state as reported by Virtuoso. Starts null (unknown):
  // a session restore mounts Virtuoso with the view at the TOP, but the mount
  // report (atBottom=false) only arrives in a passive effect AFTER this
  // component's layout effects — an eager `true` here would yank a restored
  // session to the bottom on the first data insert.
  const [atBottom, setAtBottom] = useState<boolean | null>(null);

  // Whether the user has actively scrolled away from the bottom. A ref (not
  // state): written synchronously by wheel/touch events so the follow effect
  // below stops pinning within one frame, without waiting for a re-render.
  const userScrolledAwayRef = useRef(false);

  // The single "pin to bottom" primitive. Operates on the scroller's real DOM
  // (scrollHeight always includes the streaming Footer, even while Virtuoso
  // is still measuring it), so there is no measurement lag to drift against.
  // Short-circuits when already at the bottom (≤2px) to avoid churning scroll
  // events on every token.
  const pinToBottom = useCallback(() => {
    const scroller = chatAreaRef.current?.querySelector<HTMLElement>('[data-testid="virtuoso-scroller"]');
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, []);

  // Deferred "user left the bottom". Virtuoso reports atBottom asynchronously
  // and transiently flips it to false when items are appended mid-stream
  // (question/permission cards, plan reviews) before re-measuring. Detaching
  // the follow on that transient flip is what kills auto-tracking when a
  // prompt pops up. So a "left the bottom" only becomes real if it persists
  // past the re-measure window; returning to the bottom cancels it.
  const pendingDetachRef = useRef<number | null>(null);

  // Mirror of the current tab's live streaming content. The deferred detach
  // runs outside React renders, so it can't read the store reactively — this
  // ref distinguishes "content grew" (Footer height change while streaming)
  // from "user scrolled up", which is exactly the gap that lost tracking on
  // fast streams.
  const streamStateRef = useRef({ partialText: '', partialThinking: '', isStreaming: false });
  streamStateRef.current = { partialText, partialThinking, isStreaming };

  // When the stream ends, the answer "pops" into the list in the same commit
  // the streaming Footer collapses (clearPartial + final message insert).
  // Virtuoso re-measures asynchronously and transiently reports atBottom=false
  // in between — with no partial content left (isStreaming already false) the
  // deferred detach below would read the resulting distance as "user scrolled
  // up" and kill tracking exactly when the answer appears. Two guards fix it:
  //   · re-pin once Virtuoso has measured the final message into the list
  //   · let the pending-detach verification know the stream just ended
  const streamEndedAtRef = useRef(0);
  const prevStreamingRef = useRef(false);
  const lastStreamTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastStreamTabRef.current !== null && lastStreamTabRef.current !== selectedSessionId) {
      // Tab switched mid-stream — don't read the new tab's (non-)streaming
      // state as this tab's stream ending, and don't yank the new view.
      lastStreamTabRef.current = selectedSessionId;
      prevStreamingRef.current = isStreaming;
      // Drop the previous tab's stream-end timestamp: its 1.5s detach
      // protection must not leak into the new tab (it would suppress a
      // legitimate detach and yank the new view back to the bottom).
      streamEndedAtRef.current = 0;
      return;
    }
    lastStreamTabRef.current = selectedSessionId;
    if (prevStreamingRef.current && !isStreaming) {
      streamEndedAtRef.current = Date.now();
      prevStreamingRef.current = false;
      // Re-pin once Virtuoso has measured the final message; a one-shot
      // scroll now would land at the pre-measure bottom (mid-history on long
      // answers). Skipped if the user scrolled away meanwhile.
      const id = window.setTimeout(() => {
        if (!userScrolledAwayRef.current) {
          pinToBottom();
        }
      }, 200);
      return () => clearTimeout(id);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, selectedSessionId]);

  useEffect(() => {
    return () => {
      if (pendingDetachRef.current !== null) {
        clearTimeout(pendingDetachRef.current);
        pendingDetachRef.current = null;
      }
      if (jumpTimerRef.current !== null) {
        clearTimeout(jumpTimerRef.current);
        jumpTimerRef.current = null;
      }
    };
  }, []);

  // Streaming text renders in the Virtuoso Footer (StreamingIndicator), which
  // sits outside followOutput's scope — Virtuoso only follows when the data
  // array changes.
  //
  // Pin to the bottom the moment a NEW TURN is submitted. turnStartTime is set
  // by InputBar before the CLI even starts, so this fires immediately on send,
  // not on the first token (previously the view sat mid-history until output
  // arrived). Only react to turnStartTime changes within the same tab —
  // switching tabs must not yank the view.
  const lastTurnStartRef = useRef<{ tabId: string; ts: number } | undefined>(undefined);
  useEffect(() => {
    const cur = { tabId: selectedSessionId ?? '', ts: sessionMeta.turnStartTime ?? 0 };
    const prev = lastTurnStartRef.current;
    lastTurnStartRef.current = cur;
    if (!prev || prev.tabId !== cur.tabId || prev.ts === cur.ts) return;
    if (!cur.ts) return; // Turn ended (turnStartTime cleared) — don't yank the view
    userScrolledAwayRef.current = false;
    pinToBottom();
    // Second pin once Virtuoso has measured the new Footer: the
    // ActivityIndicator appears in the same commit as the turn start, but its
    // height lands asynchronously (ResizeObserver), so the one-shot scroll
    // above targets the pre-measure bottom and leaves the indicator just
    // below the fold until the first delta. Re-pin after measurement settles
    // — unless the user has deliberately scrolled away in the meantime.
    const id = window.setTimeout(() => {
      if (!userScrolledAwayRef.current) {
        pinToBottom();
      }
    }, 120);
    return () => clearTimeout(id);
  }, [selectedSessionId, sessionMeta.turnStartTime]);

  // While streaming and the user hasn't scrolled up, keep the view pinned to
  // the newest output as the partial text/thinking grows. Repeated rAF scrolls
  // also cover the Footer's async height measurement lag (a one-shot scroll
  // lands at the pre-Footer bottom, which reads as "jumping to the middle").
  // atBottom isn't used as a gate because Virtuoso reports it asynchronously —
  // userScrolledAwayRef is updated synchronously on wheel instead, so leaving
  // the bottom stops the pinning immediately.
  //
  // Data-array insertions are handled by the displayItems layout effect below
  // (followOutput is disabled), so this effect stays scoped to the streaming
  // Footer only. Widening the deps to messages/sessionStatus/activityStatus
  // made both this rAF scroll and followOutput fire on every insertion — a
  // smooth animation racing a per-frame auto scroll that showed up as
  // high-frequency up/down jitter while streaming.
  useEffect(() => {
    if (!isStreaming || userScrolledAwayRef.current) return;
    const id = requestAnimationFrame(pinToBottom);
    return () => cancelAnimationFrame(id);
  }, [isStreaming, partialText, partialThinking, pinToBottom]);

  // Data-array insertions (message landing, tool results, question cards)
  // used to be followed by Virtuoso's built-in followOutput — now disabled
  // because it scrolls to the LAST item's bottom (excluding the streaming
  // Footer) and raced the rAF true-bottom pin above into up/down jitter
  // while streaming (SIZE_INCREASED triggers a delayed follow 100ms after
  // every Footer height change). Take over that duty here, pinned to the
  // same true bottom. Only pin while the user is still at the bottom:
  // atBottom is Virtuoso's async report (null until first mount report),
  // userScrolledAwayRef covers the synchronous wheel window.
  const lastTabForFollowRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (lastTabForFollowRef.current !== selectedSessionId) {
      // Tab switch — never yank the new view (same principle as the
      // turnStart effect). Reset to "unknown" and let Virtuoso's real
      // reports (scroll events from the pin below, user wheel) restore it.
      lastTabForFollowRef.current = selectedSessionId;
      setAtBottom(null);
      // Reset per-tab scroll state synchronously (before any passive effect
      // re-runs): userScrolledAwayRef from the previous tab would silence
      // the rAF follow effect for a streaming tab switched back to; a
      // pendingDetach timer armed in the previous tab would fire against
      // the new tab's scroller and misjudge it as "user scrolled up".
      userScrolledAwayRef.current = false;
      if (pendingDetachRef.current !== null) {
        clearTimeout(pendingDetachRef.current);
        pendingDetachRef.current = null;
      }
      return;
    }
    if (atBottom !== true || userScrolledAwayRef.current) return;
    pinToBottom();
  }, [displayItems, atBottom, pinToBottom, selectedSessionId]);
  const [activeTurnId, setActiveTurnId] = useState<string | undefined>();
  const turns = useMemo(() => parseTurns(messages), [messages]);

  // Map each turn's user message ID → index in displayItems (for turn navigation).
  // Single pass over displayItems: build id → index once, then turn lookups
  // are O(1). The previous version ran findIndex per turn —
  // O(turns × displayItems), quadratic in message count. Each displayItem
  // message appears exactly once, so keying by msg.id keeps the old
  // findIndex semantics (kind === 'message' match) identical.
  const turnIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < displayItems.length; i++) {
      const item = displayItems[i];
      if (item.kind === 'message') map.set(item.msg.id, i);
    }
    return map;
  }, [displayItems]);

  // Search result jump highlight
  const highlightMessageIndex = useChatStore((s) => s.highlightMessageIndex);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  useEffect(() => {
    if (highlightMessageIndex == null || highlightMessageIndex < 0 || highlightMessageIndex >= messages.length) return;
    const targetMsg = messages[highlightMessageIndex];
    if (!targetMsg) return;

    setHighlightedMessageId(targetMsg.id);

    // Deliberate navigation — detach from follow so streaming can't yank back
    userScrolledAwayRef.current = true;

    // Scroll to target via Virtuoso scrollToIndex
    const idx = displayItems.findIndex((item) => item.kind === 'message' && item.msg.id === targetMsg.id);
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
    }

    // Clear highlight after 2 seconds
    const timer = setTimeout(() => {
      setHighlightedMessageId(null);
      useChatStore.getState().setHighlightMessageIndex(null);
    }, 2000);

    return () => clearTimeout(timer);
  }, [highlightMessageIndex, messages, displayItems]);

  // (setMessageNode removed — Virtuoso manages DOM nodes via computeItemKey)

  // Track visible range for active turn detection
  const handleRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    if (turns.length === 0) {
      setActiveTurnId(undefined);
      return;
    }
    // Find the last turn whose user message is at or before startIndex
    for (let i = turns.length - 1; i >= 0; i--) {
      const turnIdx = turnIndexMap.get(turns[i].userMessageId);
      if (turnIdx !== undefined && turnIdx <= range.startIndex) {
        setActiveTurnId((prev) => (prev === turns[i].userMessageId ? prev : turns[i].userMessageId));
        return;
      }
    }
  }, [turns, turnIndexMap]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setAtBottom(atBottom);
    // Covers non-wheel scrolls (drag bar, keyboard, touch): back at the
    // bottom → resume following; left the bottom → detach.
    if (atBottom) {
      // Back at the bottom — resume following and cancel any pending detach.
      userScrolledAwayRef.current = false;
      if (pendingDetachRef.current !== null) {
        clearTimeout(pendingDetachRef.current);
        pendingDetachRef.current = null;
      }
    } else {
      // Left the bottom — but not necessarily by the user: appending a big
      // item (question/permission card) or the Footer's async height
      // measurement makes Virtuoso transiently report atBottom=false before
      // it settles. Only detach if the state persists past the re-measure
      // window AND the real scroll position confirms it: right after submit
      // the ActivityIndicator renders in the same commit but its height only
      // reaches Virtuoso after the ResizeObserver fires, so a stale false
      // here — with no delta yet to re-pin (isStreaming still false) — would
      // detach follow before the first token even arrives on slow providers.
      if (pendingDetachRef.current !== null) {
        clearTimeout(pendingDetachRef.current);
      }
      pendingDetachRef.current = window.setTimeout(() => {
        pendingDetachRef.current = null;
        const scroller = chatAreaRef.current?.querySelector('[data-testid="virtuoso-scroller"]');
        if (scroller) {
          const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          if (distance <= DETACH_DISTANCE_PX) return; // measurement lag, not a real scroll-up
          // Live content is still growing (Footer height change mid-stream):
          // Virtuoso transiently reports atBottom=false while re-measuring,
          // and a big delta batch can land past DETACH_DISTANCE_PX. That's
          // growth, not the user scrolling up — wheel scroll-ups detach
          // synchronously in onWheel, so don't detach here while content is
          // actively streaming in.
          const live = streamStateRef.current;
          if (live.isStreaming && (live.partialText || live.partialThinking)) return;
          // Stream just ended: the answer popped into the list and the Footer
          // collapsed in the same commit — the transient atBottom=false here
          // is growth, not a user scroll-up (real scroll-ups detach
          // synchronously in onWheel). Give the re-pin above time to land.
          if (Date.now() - streamEndedAtRef.current < 1500) return;
        }
        userScrolledAwayRef.current = true;
      }, 200);
    }
    setShowScrollBtn(!atBottom);
  }, []);

  // Guards the "jump to latest" re-pin: async height measurements (Footer
  // ResizeObserver, image loads) can grow the total height right after the
  // jump, leaving the viewport short of the true bottom — Virtuoso then
  // reports atBottom=false and the button pops back ("bounces up"). The
  // delayed re-pin lands the view once measurements settle.
  const jumpTimerRef = useRef<number | null>(null);

  const scrollToBottom = useCallback(() => {
    // Explicit "jump to latest" — resume following.
    userScrolledAwayRef.current = false;
    // Scroll the container to its true bottom — scrollToIndex(last item)
    // stops at the last item's start, leaving the streaming Footer below the
    // viewport (looks like jumping to the middle). pinToBottom targets the
    // real DOM bottom (streaming Footer included) with no measurement lag.
    pinToBottom();
    setShowScrollBtn(false);
    setActiveTurnId(turns[turns.length - 1]?.userMessageId);
    if (jumpTimerRef.current !== null) clearTimeout(jumpTimerRef.current);
    // Re-pin once height measurements settle (see comment above) — unless
    // the user scrolled away meanwhile.
    jumpTimerRef.current = window.setTimeout(() => {
      jumpTimerRef.current = null;
      if (!userScrolledAwayRef.current) {
        pinToBottom();
      }
    }, 200);
  }, [turns]);

  const jumpToTurn = useCallback((turn: Turn) => {
    // Jumping to an old turn is deliberate history reading — detach so the
    // follow effect can't yank the view back.
    userScrolledAwayRef.current = true;
    const idx = turnIndexMap.get(turn.userMessageId);
    if (idx === undefined) return;
    virtuosoRef.current?.scrollToIndex({ index: idx, align: 'start', behavior: 'smooth' });
    setActiveTurnId(turn.userMessageId);
  }, [turnIndexMap]);

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar — with extra top padding for macOS traffic lights */}
      <div
        className="flex items-center h-[68px] pt-[20px] px-5 border-b border-border-subtle
        flex-shrink-0 bg-bg-chat cursor-default">
        {/* Show sidebar toggle when sidebar is not visible:
            either user closed it, or it's hidden by file preview mode */}
        {(!sidebarOpen || isFilePreviewMode) && (
          <button onClick={toggleSidebar}
            className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary
              transition-smooth mr-3" title={t('chat.showSidebar')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
        )}
        {/* Left: model name + project hint */}
        <div className="flex items-center gap-3 pointer-events-none">
          {sessionMeta.model && (
            <span className="text-sm font-medium text-text-muted">
              {getModelDisplayName(sessionMeta.model)}
            </span>
          )}
          {workingDirectory && (
            <span className="text-[10px] text-text-tertiary truncate max-w-[160px]"
              title={workingDirectory}>
              {workingDirectory.split(/[\\/]/).pop()}
            </span>
          )}
        </div>

        {/* Integrated status: Agent + API route — left-aligned with color dots */}
        <div className="relative flex items-center gap-3 ml-3">
          {/* Agent status — clickable dot + label → opens AgentPanel */}
          <button onClick={toggleAgentPanel}
            className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded-lg
              transition-smooth text-[9px]
              ${agentPanelOpen ? 'bg-accent/10' : 'hover:bg-bg-secondary/50'}`}
            title={t('agents.toggle')}>
            <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 transition-smooth
              ${activeAgentCount > 0
                ? 'bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.5)] animate-pulse-soft'
                : totalAgentCount > 0
                  ? 'bg-success'
                  : 'bg-text-tertiary/30'}`} />
            <span className={`${activeAgentCount > 0 ? 'text-amber-400' : totalAgentCount > 0 ? 'text-success' : 'text-text-tertiary'}`}>
              Agent{totalAgentCount > 1 ? ` (${totalAgentCount})` : ''}
            </span>
          </button>

          {/* API route status — dot + label */}
          <div className="flex items-center gap-1.5 text-[9px]">
            <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 transition-smooth
              ${sessionStatus === 'running'
                ? 'bg-success shadow-[0_0_6px_var(--color-accent-glow)] animate-pulse-soft'
                : sessionStatus === 'error'
                  ? 'bg-error'
                  : 'bg-text-tertiary/30'}`} />
            <span className="text-text-tertiary">
              {activeProvider ? (activeProvider.name || 'Custom') : 'CLI'}
            </span>
          </div>

          {/* Current session mode indicator */}
          <div className={`flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded
            ${sessionMode === 'bypass'
              ? 'text-warning/80'
              : 'text-text-tertiary'}`}>
            <span>{t(`mode.${sessionMode}`)}</span>
          </div>

          {/* CLI Backend toggle */}
          <CliBackendToggle />

          {/* Cross-backend session conversion */}
          <ConvertBackendButton />

          {/* Floating agent panel popover — anchored to agent button */}
          {agentPanelOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={toggleAgentPanel} />
              <div className="absolute left-0 top-full mt-2 z-50
                w-72 max-h-80 rounded-xl border border-border-subtle
                bg-bg-primary shadow-lg overflow-y-auto">
                <AgentPanel />
              </div>
            </>
          )}
        </div>

        {/* Spacer + right-side actions */}
        <div className="ml-auto flex items-center" />
        <ContextMeter
          sessionMeta={sessionMeta}
          tabId={selectedSessionId}
          sessionStatus={sessionStatus}
        />
        <UpdateButton />
        <ExportMenu sessionPath={currentSessionPath} />
        <button onClick={toggleSecondaryPanel}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary
            transition-smooth" title={t('chat.toggleFiles')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <path d="M10 2v12" />
          </svg>
        </button>
      </div>

      <div className="flex flex-1 min-h-0 relative">
      {/* Main chat area */}
      <div ref={chatAreaRef} className="flex flex-col flex-1 min-w-0">
      {!workingDirectory && messages.length === 0 && !isStreaming ? (
        <div className="flex-1 flex items-center justify-center px-5">
          <WelcomeScreen />
        </div>
      ) : messages.length === 0 && !isStreaming ? (
        <div className="flex-1 flex items-center justify-center px-5">
          <EmptyReadyState />
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          className="flex-1 chat-scroll-container"
          data={displayItems}
          // Disabled on purpose — see the displayItems layout effect above.
          // Built-in follow scrolls to the LAST item's bottom (no streaming
          // Footer) and races the rAF true-bottom pin into up/down jitter.
          followOutput={() => false}
          atBottomStateChange={handleAtBottomStateChange}
          rangeChanged={handleRangeChanged}
          onWheel={(e) => {
            // Scroll up (deltaY < 0) → detach from follow immediately, before
            // Virtuoso's async atBottomStateChange re-render can lag behind
            // the pinning rAF loop.
            if (e.deltaY < 0) userScrolledAwayRef.current = true;
          }}
          computeItemKey={(_, item) =>
            item.kind === 'tool_group' ? `tg_${item.msgs[0].id}` : item.msg.id
          }
          itemContent={(index, item) => {
            // Determine spacing based on item type and previous item
            const isCompact =
              item.kind === 'tool_group' ||
              (item.kind === 'message' &&
                ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'].includes(
                  item.msg.type,
                ));
            const prevItem = index > 0 ? displayItems[index - 1] : null;
            const prevIsCompact =
              prevItem != null &&
              (prevItem.kind === 'tool_group' ||
                (prevItem.kind === 'message' &&
                  ['tool_use', 'tool_result', 'thinking', 'todo', 'plan', 'plan_review'].includes(
                    prevItem.msg.type,
                  )));
            const spacing =
              index === 0
                ? 'mt-4'
                : isCompact && prevIsCompact
                  ? 'mt-0.5'
                  : isCompact || prevIsCompact
                    ? 'mt-2'
                    : 'mt-5';

            if (item.kind === 'tool_group') {
              return (
                <div key={`tg_${item.msgs[0].id}`} className={`${spacing} chat-message-item px-20`}>
                  <ToolGroup messages={item.msgs} />
                </div>
              );
            }

            const msg = item.msg;
            const idx = item.idx;
            let isFirstInGroup = true;
            if (msg.role === 'assistant' && msg.type === 'text') {
              for (let j = idx - 1; j >= 0; j--) {
                const prev = messages[j];
                if (prev.role === 'user') break;
                if (prev.role === 'assistant' && prev.type === 'text') {
                  isFirstInGroup = false;
                  break;
                }
              }
            }
            const sidePadding = msg.role === 'user'
              ? 'pl-20 pr-20'
              : 'pl-5 pr-20';
            return (
              <div key={msg.id} className={`${spacing} chat-message-item ${sidePadding}`}>
                <MessageBubble
                  message={msg}
                  isFirstInGroup={isFirstInGroup}
                  isHighlighted={highlightedMessageId === msg.id}
                />
              </div>
            );
          }}
          components={virtuosoComponents}
        />
      )}
      {/* end Virtuoso / empty-state block */}

      {!showPlanPanel && (
        <ConversationTimeline
          turns={turns}
          activeTurnId={activeTurnId}
          showScrollBtn={showScrollBtn}
          onJumpTurn={jumpToTurn}
          onJumpBottom={scrollToBottom}
        />
      )}

      {/* Scroll to bottom FAB */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10
            inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-card border border-border-subtle
            shadow-md hover:shadow-lg justify-center
            text-text-muted hover:text-text-primary transition-smooth
            cursor-pointer opacity-80 hover:opacity-100"
          title={t('chat.scrollToBottom')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M7 2v10M3 8l4 4 4-4" />
          </svg>
          <span className="text-xs">{t('chat.latest')}</span>
        </button>
      )}

      {/* Directory missing banner */}
      {workingDirectory && directoryMissing && (
        <div className="mx-4 mb-3 px-4 py-3 rounded-xl bg-status-warning/10 border border-status-warning/30
          flex items-center gap-3 text-sm text-text-secondary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.5" className="flex-shrink-0 text-status-warning">
            <path d="M8 1.5L1.5 13h13L8 1.5z" strokeLinejoin="round" />
            <path d="M8 6v3" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
          <span className="flex-1">{t('project.directoryMissing')}</span>
          <button
            onClick={async () => {
              const selected = await open({ directory: true, multiple: false, title: t('project.selectFolder') });
              if (selected) {
                const path = selected as string;
                useSettingsStore.getState().setWorkingDirectory(path);
                // 报告B5: re-selecting the SAME directory does not retrigger
                // the workingDirectory effect — force a reload so a directory
                // recreated on disk recovers (clears directoryMissing, which
                // then re-establishes the watcher in App.tsx).
                if (path === useSettingsStore.getState().workingDirectory) {
                  useFileStore.getState().loadTree(path);
                }
              }
            }}
            className="px-3 py-1 rounded-lg text-xs font-medium
              bg-status-warning/20 hover:bg-status-warning/30
              text-status-warning transition-smooth"
          >
            {t('project.reselect')}
          </button>
        </div>
      )}

      {/* Input — only show when a project folder is selected and exists */}
      {workingDirectory && !directoryMissing && <InputBar />}
      </div>{/* end main chat area */}

      {/* Right-side plan panel (resizable) */}
      {showPlanPanel && (
        <PlanPanel
          planMessages={planMessages}
          onClose={closePlanPanel}
        />
      )}
      </div>{/* end flex row */}
    </div>
  );
}

/** Start a new draft conversation for the given folder and pre-warm the CLI process */
async function startDraftSession(folderPath: string) {
  useSettingsStore.getState().setWorkingDirectory(folderPath);
  const currentTab = useSessionStore.getState().selectedSessionId;
  if (currentTab) useChatStore.getState().resetTab(currentTab);

  // Reuse existing draft tab if one is already selected, otherwise create a new one
  const currentTabId = useSessionStore.getState().selectedSessionId;
  const currentSession = useSessionStore.getState().sessions.find(
    (s) => s.id === currentTabId,
  );
  let draftId: string;
  if (currentSession && currentSession.path === '') {
    // Reuse the existing draft — just update its project info
    draftId = currentSession.id;
    useSessionStore.getState().updateDraftProject(draftId, folderPath);
  } else {
    // No draft selected — create a new one
    draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().addDraftSession(draftId, folderPath);
  }

  // Pre-warm: spawn CLI process in background so first message is fast.
  // Send empty prompt — Rust will skip the NDJSON send.
  const preWarmId = `desk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Register stream listeners before spawning
    const unlisten = await onClaudeStream(preWarmId, (msg: any) => {
      // Tag message with stdinId so the handler can route to correct session
      msg.__stdinId = preWarmId;
      // Forward to InputBar's handler via a global — will be overridden when InputBar mounts
      const handler = window.__claudeStreamHandler;
      if (handler) {
        // Replay any events that arrived while handler was briefly null (React effect cycle)
        const queue = window.__claudeStreamQueue;
        if (queue && queue.length > 0) {
          console.warn(`[LITTLECLAUDE] replaying ${queue.length} queued pre-warm events`);
          const pending = queue.splice(0);
          for (const queued of pending) handler(queued);
        }
        handler(msg);
      } else {
        // Handler not yet available (InputBar not mounted or React effect cycle) — queue the event
        if (!window.__claudeStreamQueue) window.__claudeStreamQueue = [];
        window.__claudeStreamQueue.push(msg);
        console.warn('[LITTLECLAUDE] pre-warm event queued (handler not ready):', msg.type);
      }
    });
    const unlistenStderr = await onClaudeStderr(preWarmId, (line: string) => {
      // Log pre-warm stderr for debugging (errors here explain why CLI may fail)
      console.warn('[LITTLECLAUDE] pre-warm stderr:', line);
    });

    // Store unlisten per stdinId for multi-session support
    registerStreamListener(preWarmId, () => {
      unlisten();
      unlistenStderr();
    });

    const selectedModel = useSettingsStore.getState().selectedModel;
    const sessionMode = useSettingsStore.getState().sessionMode;
    const thinkingSetting = useSettingsStore.getState().thinkingLevel;
    const contextWindowMode = useSettingsStore.getState().contextWindowMode;
    const liveCliBackend = useSettingsStore.getState().cliBackend || 'claude';
    const providerId = useProviderStore.getState().getActiveIdForBackend(liveCliBackend);
    const resolvedModel = resolveModelForProvider(selectedModel);
    const session = await bridge.startSession({
      prompt: '',  // empty = pre-warm, no message sent
      cwd: folderPath,
      model: resolvedModel,
      session_id: preWarmId,
      thinking_level: resolveThinkingLevelForProvider(
        selectedModel,
        thinkingSetting,
      ),
      provider_id: providerId || undefined,
      context_window: getContextWindowForModel(resolvedModel, contextWindowMode),
      permission_mode: mapSessionModeToPermissionMode(sessionMode),
      cli_backend: liveCliBackend,
    });

    // Store stdinId so InputBar can send the first message via stdin
    useChatStore.getState().ensureTab(draftId);
    useChatStore.getState().setSessionMeta(draftId, {
      sessionId: session.session_id,
      stdinId: preWarmId,
      envFingerprint: envFingerprint(),
      snapshotMode: sessionMode,
      snapshotModel: selectedModel,
      snapshotThinking: thinkingSetting,
      snapshotContextWindowMode: contextWindowMode,
      snapshotProviderId: providerId,
      snapshotCliBackend: liveCliBackend,
      spawnedModel: resolvedModel,
    });

    // Register stdinId → tabId mapping for background stream routing
    useSessionStore.getState().registerStdinTab(preWarmId, draftId);

    // Skip desk_* IDs — they pollute tracked_sessions.txt (multi-session isolation fix)
    if (!session.session_id.startsWith('desk_')) {
      bridge.trackSession(session.session_id).catch(() => {});
    }
  } catch {
    // Pre-warm failed — InputBar will spawn on first message instead
  }
}

/** Welcome screen shown when no project folder is selected */
function WelcomeScreen() {
  const t = useT();
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);
  const recentProjects = useFileStore((s) => s.recentProjects);
  const fetchProjects = useFileStore((s) => s.fetchRecentProjects);

  useEffect(() => { fetchProjects(); }, []);

  const handlePickFolder = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('project.selectFolder'),
    });
    if (selected) {
      startDraftSession(selected as string);
    }
  }, [t]);

  // Show SetupWizard if setup has not been completed
  if (!setupCompleted) {
    return <SetupWizard />;
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-20 h-20" rounded="rounded-3xl" className="mb-6 shadow-glow" />
      <h2 className="text-xl font-semibold text-accent mb-2">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed mb-6">
        {t('welcome.subtitle')}
      </p>

      {/* Primary action: new chat with folder picker */}
      <button
        onClick={handlePickFolder}
        className="px-6 py-3 rounded-[20px] text-sm font-medium
          bg-accent hover:bg-accent-hover text-text-inverse
          hover:shadow-glow transition-smooth
          flex items-center gap-2 mb-8"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4h4l2 2h6v7H2V4z" />
        </svg>
        {t('welcome.newChat')}
      </button>

      {/* Recent projects */}
      {recentProjects.length > 0 && (
        <div className="w-full max-w-sm">
          <div className="text-[11px] font-medium text-text-tertiary uppercase
            tracking-wider mb-3">
            {t('welcome.recentProjects')}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {recentProjects.slice(0, 6).map((project) => (
              <button
                key={project.path}
                onClick={() => startDraftSession(project.path)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5
                  rounded-lg border border-border-subtle text-xs
                  text-text-muted hover:border-accent hover:text-accent
                  hover:bg-accent/5 transition-smooth"
                title={project.shortPath}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5"
                  className="flex-shrink-0 text-text-tertiary">
                  <path d="M2 4h4l2 2h6v7H2V4z" />
                </svg>
                {project.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Empty state shown when project is selected but no messages yet */
function EmptyReadyState() {
  const t = useT();
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {/* App icon — customizable AI avatar */}
      <AiAvatar size="w-16 h-16" rounded="rounded-2xl" className="mb-5 shadow-glow" />
      <h2 className="text-lg font-semibold text-accent mb-1">
        {t('chat.welcome')}
      </h2>
      <p className="text-sm text-text-muted max-w-sm leading-relaxed">
        {t('chat.welcomeWithProject')}
      </p>
      {workingDirectory && (
        <p className="text-xs text-text-tertiary mt-2 truncate max-w-xs">
          {workingDirectory}
        </p>
      )}
    </div>
  );
}
