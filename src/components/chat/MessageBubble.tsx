import { memo, useState, useCallback, type ReactNode } from 'react';
import { type ChatMessage, useChatStore } from '../../stores/chatStore';
import { useFileStore } from '../../stores/fileStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAgentStore } from '../../stores/agentStore';
import { useLightboxStore } from '../shared/ImageLightbox';
import { useT } from '../../lib/i18n';
import { isPathInsideWorkspace } from '../../lib/path-safety';
import { getCachedThumbnail } from '../../hooks/useFileAttachments';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { CommandProcessingCard } from './CommandProcessingCard';
import { PlanReviewCard } from './PlanReviewCard';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';
import { AiAvatar } from '../shared/AiAvatar';
import { UserAvatar } from '../shared/UserAvatar';
import { MessageFeedback } from './MessageFeedback';

interface Props {
  message: ChatMessage;
  isFirstInGroup?: boolean;
  isHighlighted?: boolean;
}

/** Guard against raw content-block objects ({text, type}) being rendered as
 *  JSX children — causes Minified React error #31. */
function safeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}

/** Custom equality check — only re-render when fields that affect visual output change.
 *  Avoids re-rendering every message bubble when the parent ChatPanel re-renders
 *  due to unrelated state changes (streams, session, etc.).
 *  Every field read by the bubble or its child cards must be listed here, or
 *  updates to it will not re-render (e.g. command completion state). */
function arePropsEqual(prev: Props, next: Props): boolean {
  if (prev.isFirstInGroup !== next.isFirstInGroup) return false;
  if (prev.isHighlighted !== next.isHighlighted) return false;
  const a = prev.message, b = next.message;
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.type === b.type &&
    a.content === b.content &&
    a.resolved === b.resolved &&
    a.interactionState === b.interactionState &&
    a.interactionError === b.interactionError &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.toolResultContent === b.toolResultContent &&
    a.commandType === b.commandType &&
    a.commandCompleted === b.commandCompleted &&
    a.commandData === b.commandData &&
    a.commandStartTime === b.commandStartTime &&
    a.timestamp === b.timestamp &&
    a.permissionData === b.permissionData &&
    a.permissionTool === b.permissionTool &&
    a.questions === b.questions &&
    a.todoItems === b.todoItems &&
    a.attachments === b.attachments &&
    a.planContent === b.planContent &&
    a.isPartial === b.isPartial &&
    // U1: errorCategory drives the action-button row of error cards
    a.errorCategory === b.errorCategory
  );
}

export const MessageBubble = memo(function MessageBubble({ message, isFirstInGroup = true, isHighlighted = false }: Props) {
  if (message.role === 'user') return <UserMsg message={message} isHighlighted={isHighlighted} />;
  if (message.role === 'system' && message.commandType === 'processing') return <CommandProcessingCard message={message} />;
  if (message.role === 'system' && message.commandType) return <CommandFeedbackMsg message={message} />;
  // U1: 带 errorCategory 的 system 错误消息 → 可行动错误卡片（动作按钮）
  if (message.role === 'system' && message.errorCategory) return <ErrorMsg message={message} />;
  // Unresolved question/plan_review cards are rendered as floating overlays
  // above the InputBar. Only show them inline once resolved.
  if (message.type === 'question' && !message.resolved) return null;
  if (message.type === 'question') return <QuestionCard message={message} />;
  if (message.type === 'todo') return <TodoMsg message={message} />;
  if (message.type === 'plan_review' && !message.resolved) return null;
  if (message.type === 'plan_review') return <PlanReviewCard message={message} />;
  if (message.type === 'tool_use') return <ToolUseMsg message={message} />;
  if (message.type === 'thinking') return <ThinkingMsg message={message} />;
  if (message.type === 'tool_result') return <ToolResultMsg message={message} />;
  // Unresolved permission cards are rendered as floating overlays above InputBar
  if (message.type === 'permission' && !message.resolved && message.interactionState !== 'resolved') return null;
  if (message.type === 'permission') return <PermissionCard message={message} />;
  if (message.type === 'plan') return <PlanMsg message={message} />;
  return <AssistantMsg message={message} isFirstInGroup={isFirstInGroup} />;
}, arePropsEqual);

/* ================================================================
   UserMsg — bubble on the right, avatar on the right side of bubble
   ================================================================ */
/** Collapse threshold: messages longer than this are collapsed by default */
const USER_MSG_COLLAPSE_LINES = 12;

/** Extract file extension from a filename */
function getFileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Detect file paths in inline code — same regexes as MarkdownRenderer */
const FILE_PATH_RE = /^(?:\/|\.\/|\.\.\/|[a-zA-Z]:[/\\]|src\/|lib\/|components\/|stores\/|hooks\/|utils\/|tests\/|__tests__\/)[\w.@/-]+\.\w{1,10}$/;
const KNOWN_EXT_RE = /^[\w][\w.-]*\.(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|json|jsonl|toml|yaml|yml|py|pyi|rs|go|html|htm|css|scss|sass|less|vue|svelte|sh|bash|zsh|fish|env|conf|cfg|ini|xml|sql|graphql|gql|proto|lock|log|txt|csv|rb|php|java|kt|swift|c|cpp|h|hpp|cs|r|lua|zig|ex|exs|erl|ml|mli|tf|hcl|dockerfile|makefile)$/i;

/** Render a single backtick-inner segment: file path → clickable chip, else → inline code */
function renderCodeSegment(inner: string, key: number): ReactNode {
  if (FILE_PATH_RE.test(inner) || KNOWN_EXT_RE.test(inner)) {
    const wd = useSettingsStore.getState().workingDirectory || '';
    const resolved = inner.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(inner)
      ? inner
      : wd ? `${wd.replace(/\/$/, '')}/${inner}` : inner;
    const fileName = inner.split(/[\\/]/).pop() || inner;
    // Security: out-of-workspace paths must not become clickable chips —
    // a single click would read arbitrary local files into the preview
    // (e.g. C:\\Users\\...\\.ssh\\config from untrusted model output).
    // isPathInsideWorkspace folds `..` in relative paths and never passes
    // when no working directory is configured.
    const inWorkspace = isPathInsideWorkspace(resolved, wd);
    if (!inWorkspace) return <code key={key}>{inner}</code>;
    return (
      <button
        key={key}
        onClick={(e) => { e.stopPropagation(); useFileStore.getState().selectFile(resolved); }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5
          bg-bg-layer-1 border border-border-l2 rounded-md
          text-xs font-medium cursor-pointer
          hover:bg-bg-layer-2 hover:border-border-l3
          transition-all duration-150 select-none
          align-baseline leading-normal whitespace-nowrap inline-block"
        title={resolved}
      >
        <span className="text-[10px]">📄</span>
        <span className="max-w-[180px] truncate">{fileName}</span>
      </button>
    );
  }
  return (
    <code key={key} className="px-1.5 py-0.5 mx-0.5 rounded-md text-[13px]
      bg-white/15 border border-white/20 font-mono">
      {inner}
    </code>
  );
}

/** Parse backtick-wrapped segments in user text into styled inline code elements.
 *  Handles both single ` and triple ``` (renders as single-line code).
 *  File paths inside backticks become clickable chips. */
function renderUserContent(text: string): ReactNode {
  // Split on backtick patterns: ```...``` or `...`
  const parts = text.split(/(```[^`]*```|`[^`\n]+`)/g);
  if (parts.length === 1) return text; // no backticks found, return plain string

  return parts.map((part, i) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3).trim();
      if (!inner) return part;
      return renderCodeSegment(inner, i);
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      const inner = part.slice(1, -1);
      if (!inner) return part;
      return renderCodeSegment(inner, i);
    }
    return part;
  });
}

function UserMsg({ message, isHighlighted = false }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const attachments = message.attachments;
  const content = safeContent(message.content);
  const lines = content.split('\n');
  const isLong = lines.length > USER_MSG_COLLAPSE_LINES || content.length > 600;
  const displayContent = (!expanded && isLong)
    ? lines.slice(0, USER_MSG_COLLAPSE_LINES).join('\n')
    : content;

  // U5: 运行中的会话不提供编辑重发（截断会与进行中的回合冲突，需先 Stop）
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessionStatus = useSessionStore((s) =>
    selectedSessionId ? s.sessionStatuses.get(selectedSessionId) : undefined);
  const canEditResend = message.type === 'text' && sessionStatus !== 'running';

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  // U5: 编辑重发 —— 派发给 InputBar：回填输入框 + rewindToTurn 内存截断到该轮
  // 之前 + 聚焦；重发后走正常提交流程（见 InputBar 的 edit-user-message 监听）
  const handleEditResend = useCallback(() => {
    window.dispatchEvent(new CustomEvent('little-claude:edit-user-message', {
      detail: { messageId: message.id, text: content },
    }));
  }, [message.id, content]);

  return (
    <div className="flex justify-end gap-2.5 group/user relative">
      {/* Hover 操作区：编辑重发（U5）+ 复制 */}
      <div className="absolute -top-2 right-1 z-10 flex items-center gap-1
        opacity-0 group-hover/user:opacity-100 transition-smooth">
        {canEditResend && (
          <button
            onClick={handleEditResend}
            title={t('msg.editAndResend')}
            aria-label={t('msg.editAndResend')}
            className="p-1 rounded-md
              bg-bg-tertiary/80 text-text-muted hover:text-text-primary
              hover:bg-bg-tertiary border border-border-subtle
              transition-smooth cursor-pointer"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
            </svg>
          </button>
        )}
        <button
          onClick={handleCopy}
          className="px-1.5 py-0.5 rounded-md text-[10px] font-medium
            bg-bg-tertiary/80 text-text-muted hover:text-text-primary
            hover:bg-bg-tertiary border border-border-subtle
            transition-smooth cursor-pointer"
        >
          {copied ? t('msg.copied') : t('msg.copyText')}
        </button>
      </div>
      <div className={`message-content max-w-[75%] px-3.5 py-2.5 rounded-2xl rounded-br-md
        bg-bg-user-msg text-text-primary
        text-sm leading-relaxed shadow-sm whitespace-pre-wrap
        ${isHighlighted ? 'search-highlight-blink' : ''}`}>
        {renderUserContent(displayContent)}
        {!expanded && isLong && (
          <span className="text-text-tertiary">…</span>
        )}
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="block mt-1.5 text-xs text-text-tertiary hover:text-text-primary
              transition-smooth"
          >
            {expanded ? '▲ 收起' : '▼ 展开全部'}
          </button>
        )}
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {attachments.map((att, i) => (
              <button
                key={i}
                onClick={() => {
                  if (att.isImage) {
                    useLightboxStore.getState().openFile(att.path, att.name);
                  } else {
                    useFileStore.getState().selectFile(att.path);
                  }
                }}
                className="inline-flex items-center gap-2 px-2.5 py-1.5
                  bg-bg-layer-1 hover:bg-bg-layer-2 rounded-lg border border-border-l2
                  transition-smooth cursor-pointer text-left"
              >
                {att.isImage && getCachedThumbnail(att.path) ? (
                  <img src={getCachedThumbnail(att.path)} alt="" className="w-8 h-8 rounded object-cover" />
                ) : (
                  <span className="flex items-center justify-center w-8 h-8 rounded
                    bg-bg-layer-1 text-[10px] font-mono font-semibold uppercase opacity-80">
                    {getFileExt(att.name) || (
                      <svg width="14" height="14" viewBox="0 0 12 12" fill="none"
                        stroke="currentColor" strokeWidth="1.2">
                        <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
                        <path d="M7 1v3h3" />
                      </svg>
                    )}
                  </span>
                )}
                <span className="text-xs truncate max-w-[180px]">{att.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <UserAvatar size="w-8 h-8 text-xs" className="mt-0.5" />
    </div>
  );
}

/* ================================================================
   U1: ErrorMsg — 可行动错误卡片
   useStreamProcessor.classifyError 命中分类时写入 errorCategory
   （值为 ERROR_CATEGORIES 的 i18nKey），这里按类别渲染 1-2 个动作按钮：
     invalidKey / quotaExceeded      → 打开服务商设置（SettingsPanel provider tab）
     cliNotInstalled / dshNotInstalled → 去安装（SettingsPanel cli tab）
     tokenLimit                      → 新建任务（新建 draft 会话）
     networkError / rateLimit / serviceUnavailable → 重试（重发最后一条用户消息）
   ================================================================ */
type ErrorActionKind = 'openProvider' | 'openCli' | 'newTask' | 'retry';

const ERROR_ACTIONS: Record<string, { labelKey: string; kind: ErrorActionKind }[]> = {
  'error.invalidKey': [{ labelKey: 'error.action.openProviderSettings', kind: 'openProvider' }],
  'error.quotaExceeded': [{ labelKey: 'error.action.openProviderSettings', kind: 'openProvider' }],
  'error.cliNotInstalled': [{ labelKey: 'error.action.installCli', kind: 'openCli' }],
  'error.dshNotInstalled': [{ labelKey: 'error.action.installCli', kind: 'openCli' }],
  'error.tokenLimit': [{ labelKey: 'error.action.newTask', kind: 'newTask' }],
  'error.networkError': [{ labelKey: 'error.action.retry', kind: 'retry' }],
  'error.rateLimit': [{ labelKey: 'error.action.retry', kind: 'retry' }],
  'error.serviceUnavailable': [{ labelKey: 'error.action.retry', kind: 'retry' }],
};

/** U1: 打开设置面板指定 tab —— 复用 settingsStore.settingsOpenRequest 现有机制 */
function openSettingsTab(tab: string) {
  const st = useSettingsStore.getState();
  st.setSettingsOpenRequest({ tab });
  if (!st.settingsOpen) st.toggleSettings();
}

/** U1: 新建 draft 会话 —— 与 Sidebar"新任务"同路径 */
function startNewDraftSession() {
  const wd = useSettingsStore.getState().workingDirectory;
  if (!wd) return;
  const currentTabId = useSessionStore.getState().selectedSessionId;
  if (currentTabId) {
    useChatStore.getState().saveToCache(currentTabId);
    useAgentStore.getState().saveToCache(currentTabId);
  }
  const newDraftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  useChatStore.getState().ensureTab(newDraftId);
  useChatStore.getState().resetTab(newDraftId);
  useSessionStore.getState().addDraftSession(newDraftId, wd);
}

function runErrorAction(kind: ErrorActionKind) {
  switch (kind) {
    case 'openProvider':
      openSettingsTab('provider');
      break;
    case 'openCli':
      openSettingsTab('cli');
      break;
    case 'newTask':
      startNewDraftSession();
      break;
    case 'retry':
      // InputBar 监听该事件 → 重发最后一条用户消息（正常提交流程）
      window.dispatchEvent(new CustomEvent('little-claude:retry-last-message'));
      break;
  }
}

function ErrorMsg({ message }: Props) {
  const t = useT();
  const actions = message.errorCategory ? ERROR_ACTIONS[message.errorCategory] : undefined;
  return (
    <div className="flex gap-3">
      <AiAvatar size="w-8 h-8" className="mt-0.5" />
      <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed message-content">
        <MarkdownRenderer content={safeContent(message.content)} />
        {/* U1: 动作按钮行 —— 文案指引落地为可点击按钮 */}
        {actions && actions.length > 0 && (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {actions.map((a) => (
              <button
                key={a.kind}
                onClick={() => runErrorAction(a.kind)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                  text-xs font-medium cursor-pointer transition-smooth
                  bg-accent/10 text-accent border border-accent/25
                  hover:bg-accent/20"
              >
                {t(a.labelKey)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================
   CommandFeedbackMsg — rich UI for slash command results
   Renders mode switches, info cards, help lists, action feedback
   ================================================================ */
function CommandFeedbackMsg({ message }: Props) {
  const t = useT();
  const cType = message.commandType;
  const data = message.commandData || {};

  // --- Mode switch: animated pill with icon ---
  if (cType === 'mode') {
    const modeColors: Record<string, string> = {
      ask: 'from-blue-500/15 to-blue-400/5 border-blue-400/30 text-blue-400',
      plan: 'from-amber-500/15 to-amber-400/5 border-amber-400/30 text-amber-400',
      code: 'from-emerald-500/15 to-emerald-400/5 border-emerald-400/30 text-emerald-400',
    };
    const colorClass = modeColors[data.mode] || modeColors.code;
    return (
      <div className="flex justify-center my-2 animate-fade-in">
        <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full
          bg-gradient-to-r ${colorClass} border
          shadow-sm transition-all duration-300`}>
          <span className="text-base">{data.icon}</span>
          <span className="text-xs font-medium">{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // --- Model switch: centered pill ---
  if (cType === 'model-switch') {
    return (
      <div className="flex justify-center my-2 animate-fade-in">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full
          border border-border-subtle text-text-tertiary text-[11px]">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0 opacity-60">
            <path d="M4 6l4-4 4 4M4 10l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {safeContent(message.content)}
        </div>
      </div>
    );
  }

  // --- Info card: structured key-value table or preformatted text ---
  if (cType === 'info') {
    const rows: Array<{ label: string; value: string }> = data.rows || [];

    // Preformatted output (e.g. CLI command results)
    if (data.preformatted) {
      return (
        <div className="ml-11 my-1 animate-fade-in">
          <div className="rounded-lg border border-border-subtle
            bg-bg-secondary/50 overflow-hidden max-w-md">
            <div className="flex items-center gap-2 px-3 py-1.5
              border-b border-border-subtle/50 bg-bg-tertiary/30">
              <span className="text-[10px] font-mono text-text-tertiary">{data.command}</span>
            </div>
            <pre className="px-3 py-2 text-[11px] font-mono text-text-primary
              whitespace-pre-wrap break-words overflow-x-auto max-h-60 overflow-y-auto">
              {safeContent(message.content)}
            </pre>
          </div>
        </div>
      );
    }

    return (
      <div className="ml-11 my-1 animate-fade-in">
        {/* L9: info 命令结果卡片加左侧强调边框，与普通系统消息区分 */}
        <div className="inline-block rounded-lg border border-border-subtle border-l-2 border-l-accent/50
          bg-bg-secondary/50 overflow-hidden max-w-xs">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5
            border-b border-border-subtle/50 bg-bg-tertiary/30">
            <span className="text-xs font-semibold text-text-primary">
              {data.title || safeContent(message.content)}
            </span>
          </div>
          {/* Rows */}
          {rows.length > 0 ? (
            <div className="divide-y divide-border-subtle/30">
              {rows.map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-4 px-3 py-1.5">
                  <span className="text-[11px] text-text-tertiary">{row.label}</span>
                  <span className={`text-[11px] font-mono font-medium
                    ${row.value === '—' ? 'text-text-tertiary/50' : 'text-text-primary'}`}>
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 text-[11px] text-text-tertiary italic">
              {t('cmd.noSessionData')}
            </div>
          )}
          {/* Hint */}
          {data.hint && (
            <div className="px-3 py-1.5 border-t border-border-subtle/50
              text-[10px] text-text-tertiary/70">
              {data.hint}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Help: formatted command list ---
  if (cType === 'help') {
    const builtins: Array<{ name: string; desc: string }> = data.builtins || [];
    return (
      <div className="ml-11 my-1 animate-fade-in">
        {/* L9: help 命令结果卡片加左侧强调边框，与普通系统消息区分 */}
        <div className="rounded-lg border border-border-subtle border-l-2 border-l-accent/50
          bg-bg-secondary/50 overflow-hidden max-w-md">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5
            border-b border-border-subtle/50 bg-bg-tertiary/30">
            <span className="text-xs">📖</span>
            <span className="text-xs font-semibold text-text-primary">
              {safeContent(message.content)}
            </span>
          </div>
          {/* Built-in commands */}
          <div className="p-2 space-y-0.5">
            {builtins.map((cmd, i) => (
              <div key={i} className="flex items-baseline gap-2 px-1.5 py-0.5
                rounded hover:bg-bg-tertiary/40 transition-colors">
                <code className="text-[11px] font-mono text-accent font-medium w-20 flex-shrink-0">
                  {cmd.name}
                </code>
                <span className="text-[11px] text-text-muted truncate">
                  {cmd.desc}
                </span>
              </div>
            ))}
          </div>
          {/* Footer stats */}
          <div className="flex items-center gap-3 px-3 py-1.5
            border-t border-border-subtle/50 text-[10px] text-text-tertiary">
            <span>{t('cmd.helpCustom')}: {data.customCount ?? 0}</span>
            <span>•</span>
            <span>{t('cmd.helpSkills')}: {data.skillCount ?? 0}</span>
          </div>
        </div>
      </div>
    );
  }

  // --- Action feedback: inline with icon/spinner ---
  if (cType === 'action') {
    return (
      <div className="flex justify-center my-1.5 animate-fade-in">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
          bg-bg-secondary/60 border border-border-subtle text-[11px] text-text-muted">
          {data.loading ? (
            <span className="w-3 h-3 border-2 border-accent/30 border-t-accent
              rounded-full animate-spin" />
          ) : (
            <span className="text-sm">✓</span>
          )}
          <span>{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // --- Error feedback ---
  if (cType === 'error') {
    return (
      <div className="flex justify-center my-1.5 animate-fade-in">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg
          bg-red-500/5 border border-red-500/20 text-[11px] text-red-400">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
            <circle cx="6" cy="6" r="5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          <span>{safeContent(message.content)}</span>
        </div>
      </div>
    );
  }

  // Fallback: render as plain text
  return (
    <div className="flex justify-center my-1 animate-fade-in">
      <span className="text-[11px] text-text-tertiary">{safeContent(message.content)}</span>
    </div>
  );
}

/* ================================================================
   AssistantMsg — markdown with avatar (uses shared MarkdownRenderer)
   ================================================================ */
function AssistantMsg({ message, isFirstInGroup = true }: Props) {
  return (
    <div className="flex gap-3">
      {/* Avatar: show only for the first message in a consecutive group */}
      {isFirstInGroup ? (
        <AiAvatar size="w-8 h-8" className="mt-0.5" />
      ) : (
        <div className="w-8 flex-shrink-0" />
      )}
      {/* group 类必须在此容器上：MessageFeedback 用 group-hover 显隐，
          若祖先链上无 group，按钮永远 opacity-0（功能不可见）。 */}
      <div className="flex-1 min-w-0 text-base text-text-primary leading-relaxed message-content group">
        <MarkdownRenderer content={safeContent(message.content)} />
        {/* DSH message feedback — 👍/👎 + note, hover-revealed under assistant text */}
        <MessageFeedback messageId={message.id} />
      </div>
    </div>
  );
}

/* ================================================================
   ToolUseMsg — inline collapsible, no card
   Enhanced display for Edit/Write/Read with diff stats, file icons
   ================================================================ */

/** Compute line diff stats from Edit tool input (common prefix/suffix algorithm) */
function computeEditDiff(input: any): { added: number; removed: number } | null {
  // B9: runtime narrowing — toolInput is any-typed; only strings can be split.
  if (typeof input?.old_string !== 'string' || typeof input?.new_string !== 'string') return null;
  const oldLines: string[] = input.old_string.split('\n');
  const newLines: string[] = input.new_string.split('\n');

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length
         && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (from remaining after prefix)
  let suffixLen = 0;
  while (suffixLen < oldLines.length - prefixLen
         && suffixLen < newLines.length - prefixLen
         && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  return {
    added: Math.max(0, newLines.length - prefixLen - suffixLen),
    removed: Math.max(0, oldLines.length - prefixLen - suffixLen),
  };
}

/** Compute lines for Write tool input */
function computeWriteLines(input: any): number | null {
  // B9: runtime narrowing — only string content can be split.
  if (typeof input?.content !== 'string' || !input.content) return null;
  return input.content.split('\n').length;
}

/** Get short filename from path */
function shortPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || filePath;
}

/** Tool icon mini SVG */
function ToolIcon({ name, ongoing = false }: { name: string; ongoing?: boolean }) {
  const iconClass = ongoing ? 'text-ongoing flex-shrink-0' : 'text-text-tertiary flex-shrink-0';
  switch (name) {
    case 'Bash':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className={iconClass}>
          <rect x="1" y="2" width="10" height="8" rx="1.5" />
          <path d="M3.5 5.5L5 7l-1.5 1.5M6.5 8.5h2" />
        </svg>
      );
    case 'Read':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className={iconClass}>
          <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
          <path d="M7 1v3h3M4 6.5h4M4 8.5h2" />
        </svg>
      );
    case 'Write':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-accent/70 flex-shrink-0">
          <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
          <path d="M7 1v3h3" />
          <path d="M5 7l1.5-1.5L8 7M6.5 5.5v4" strokeLinecap="round" />
        </svg>
      );
    case 'Edit':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className="text-accent/70 flex-shrink-0">
          <path d="M8.5 1.5l2 2-6.5 6.5H2V8L8.5 1.5z" />
          <path d="M7 3l2 2" />
        </svg>
      );
    case 'Glob':
    case 'Grep':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className={iconClass}>
          <circle cx="5.5" cy="5.5" r="3" />
          <path d="M8 8l2.5 2.5" />
        </svg>
      );
    case 'Task':
    case 'Agent':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className={iconClass}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5v5M3.5 6h5" />
        </svg>
      );
    case 'WebFetch':
    case 'WebSearch':
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className={iconClass}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M1.5 6h9M6 1.5c-1.5 1.5-2 3-2 4.5s.5 3 2 4.5M6 1.5c1.5 1.5 2 3 2 4.5s-.5 3-2 4.5" />
        </svg>
      );
    default:
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.2" className={iconClass}>
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
          <path d="M4.5 5l1.5 1.5L7.5 5" />
        </svg>
      );
  }
}

function getToolLabel(name: string, t: (key: string) => string): string {
  switch (name) {
    case 'Bash': return t('msg.terminal');
    case 'Read': return t('msg.readFile');
    case 'Write': return t('msg.writeFile');
    case 'Edit': return t('msg.editFile');
    case 'Glob': case 'Grep': return t('msg.search');
    case 'Task': case 'Agent': return t('msg.subAgent');
    case 'TodoWrite': return t('msg.todo');
    case 'WebFetch': case 'WebSearch': return t('msg.webFetch');
    case 'ExitPlanMode': case 'EnterPlanMode': return t('msg.planLabel');
    default: return name;
  }
}

export const ToolUseMsg = memo(function ToolUseMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const sessionStatus = useSessionStore((s) =>
    selectedSessionId ? s.sessionStatuses.get(selectedSessionId) : undefined);
  const toolName = message.toolName || 'Tool';
  const label = getToolLabel(toolName, t);
  const input = message.toolInput;

  // Compute diff stats for Edit tool
  const editDiff = toolName === 'Edit' ? computeEditDiff(input) : null;
  // Compute line count for Write tool
  const writeLines = toolName === 'Write' ? computeWriteLines(input) : null;

  // Build preview content based on tool type
  const renderPreview = () => {
    if (toolName === 'Bash' && input?.command) {
      return (
        <span className="text-[11px] text-text-tertiary truncate
          font-mono max-w-[350px] bg-bg-secondary/60 px-1.5 py-0.5 rounded">
          {input.command.length > 80 ? input.command.slice(0, 80) + '…' : input.command}
        </span>
      );
    }

    if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && input?.file_path) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              // Security: the file_path comes from model output (tool_use.input)
              // and may be injected/untrusted. Only open files that resolve
              // inside the current working directory — never ~/.ssh etc.
              const wd = useSettingsStore.getState().workingDirectory || '';
              if (isPathInsideWorkspace(input.file_path, wd)) {
                useFileStore.getState().selectFile(input.file_path);
              } else {
                console.warn(
                  '[MessageBubble] refusing out-of-workspace file_path:',
                  input.file_path,
                );
              }
            }}
            className="text-[11px] text-accent/70 hover:text-accent font-mono
              truncate max-w-[280px] hover:underline cursor-pointer transition-smooth"
            title={input.file_path}
          >
            {shortPath(input.file_path)}
          </button>
          {/* Diff stats for Edit */}
          {editDiff && (
            <span className="inline-flex items-center gap-1 ml-0.5">
              <span className="text-[10px] font-mono text-success">+{editDiff.added}</span>
              <span className="text-[10px] font-mono text-error">-{editDiff.removed}</span>
            </span>
          )}
          {/* Line count for Write */}
          {writeLines !== null && (
            <span className="text-[10px] font-mono text-success ml-0.5">
              +{writeLines} lines
            </span>
          )}
        </span>
      );
    }

    if ((toolName === 'Glob' || toolName === 'Grep') && input?.pattern) {
      return (
        <span className="text-[11px] text-text-tertiary truncate
          font-mono max-w-[300px]">
          {input.pattern}
        </span>
      );
    }

    if ((toolName === 'Task' || toolName === 'Agent') && input?.description) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          {input.description}
        </span>
      );
    }

    if (toolName === 'TeamCreate' && (input?.team_name || input?.name)) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          Team: {input.team_name || input.name}
        </span>
      );
    }

    if (toolName === 'TaskCreate' && (input?.subject || input?.description)) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          {input.subject || input.description}
        </span>
      );
    }

    if (toolName === 'SendMessage' && input?.recipient) {
      return (
        <span className="text-[11px] text-text-tertiary truncate max-w-[300px] italic">
          &rarr; {input.recipient}
        </span>
      );
    }

    if ((toolName === 'WebFetch' || toolName === 'WebSearch') && (input?.url || input?.query)) {
      const display = input.url || input.query;
      return (
        <span className="text-[11px] text-accent/70 truncate max-w-[300px] font-mono">
          {display}
        </span>
      );
    }

    return null;
  };

  // Determine if input has meaningful content (not empty {} or null)
  const hasInput = input && typeof input === 'object'
    ? Object.keys(input).length > 0
    : !!input;

  // Whether there's a result to show
  const resultContent = typeof message.toolResultContent === 'string'
    ? message.toolResultContent
    : message.toolResultContent ? JSON.stringify(message.toolResultContent) : '';
  const hasResult = resultContent.length > 0;

  // DSH --dsh-state-ongoing: tool call in flight while session is running
  const isOngoing = sessionStatus === 'running' && !hasResult;

  // Render the expanded detail section
  /** Render a side-by-side diff view for Edit tool old_string → new_string */
  const renderEditDiff = () => {
    if (!input?.old_string && !input?.new_string) return null;
    const oldLines = (input.old_string || '').split('\n');
    const newLines = (input.new_string || '').split('\n');

    return (
      <div key="diff" className="rounded-lg border border-border-subtle overflow-hidden
        max-h-48 overflow-y-auto">
        {/* Removed lines */}
        {oldLines.length > 0 && oldLines[0] !== '' && (
          <div>
            {oldLines.map((line: string, i: number) => (
              <div key={`old-${i}`}
                className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
                  bg-red-500/8 dark:bg-red-500/10">
                <span className="flex-shrink-0 w-8 text-right pr-2 text-red-400/60
                  select-none border-r border-red-500/10">
                  {i + 1}
                </span>
                <span className="flex-shrink-0 w-5 text-center text-red-400 select-none">−</span>
                <span className="text-red-600 dark:text-red-400 whitespace-pre-wrap break-all
                  flex-1 px-1">{line}</span>
              </div>
            ))}
          </div>
        )}
        {/* Added lines */}
        {newLines.length > 0 && newLines[0] !== '' && (
          <div>
            {newLines.map((line: string, i: number) => (
              <div key={`new-${i}`}
                className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
                  bg-blue-500/8 dark:bg-blue-500/10">
                <span className="flex-shrink-0 w-8 text-right pr-2 text-blue-400/60
                  select-none border-r border-blue-500/10">
                  {i + 1}
                </span>
                <span className="flex-shrink-0 w-5 text-center text-blue-400 select-none">+</span>
                <span className="text-blue-600 dark:text-blue-400 whitespace-pre-wrap break-all
                  flex-1 px-1">{line}</span>
              </div>
            ))}
          </div>
        )}
        {/* File path */}
        {input.file_path && (
          <div className="px-2 py-1 border-t border-border-subtle/50
            text-[10px] text-text-tertiary font-mono truncate">
            {input.file_path}
          </div>
        )}
      </div>
    );
  };

  /** Render a Write tool diff — all lines shown as additions (blue) */
  const renderWriteDiff = () => {
    if (!input?.content) return null;
    const allLines = input.content.split('\n');
    const maxDisplay = 20;
    const displayLines = allLines.slice(0, maxDisplay);
    const remaining = allLines.length - maxDisplay;

    return (
      <div key="write-diff" className="rounded-lg border border-border-subtle overflow-hidden
        max-h-48 overflow-y-auto">
        {displayLines.map((line: string, i: number) => (
          <div key={i}
            className="flex items-start gap-0 text-[11px] font-mono leading-relaxed
              bg-blue-500/8 dark:bg-blue-500/10">
            <span className="flex-shrink-0 w-8 text-right pr-2 text-blue-400/60
              select-none border-r border-blue-500/10">
              {i + 1}
            </span>
            <span className="flex-shrink-0 w-5 text-center text-blue-400 select-none">+</span>
            <span className="text-blue-600 dark:text-blue-400 whitespace-pre-wrap break-all
              flex-1 px-1">{line}</span>
          </div>
        ))}
        {remaining > 0 && (
          <div className="px-2 py-1 text-[10px] text-text-tertiary font-mono
            bg-blue-500/5 border-t border-blue-500/10">
            ... +{remaining} more lines
          </div>
        )}
        {input.file_path && (
          <div className="px-2 py-1 border-t border-border-subtle/50
            text-[10px] text-text-tertiary font-mono truncate">
            {input.file_path}
          </div>
        )}
      </div>
    );
  };

  const renderExpandedContent = () => {
    const sections: React.ReactNode[] = [];

    // Show tool input (if meaningful)
    if (hasInput) {
      if (toolName === 'Bash' && input?.command) {
        sections.push(
          <div key="cmd" className="flex items-start gap-1.5">
            <span className="text-text-tertiary/60 text-[11px] font-mono select-none">$</span>
            <pre className="text-[11px] text-text-muted font-mono whitespace-pre-wrap break-all">
              {input.command}
            </pre>
          </div>
        );
      } else if (toolName === 'Edit' && (input?.old_string || input?.new_string)) {
        const diffView = renderEditDiff();
        if (diffView) sections.push(diffView);
      } else if (toolName === 'Write' && input?.content) {
        const writeDiffView = renderWriteDiff();
        if (writeDiffView) sections.push(writeDiffView);
      } else {
        sections.push(
          <pre key="input" className="text-[11px] text-text-tertiary
            overflow-x-auto font-mono leading-relaxed
            max-h-32 overflow-y-auto whitespace-pre-wrap">
            {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
          </pre>
        );
      }
    }

    // Show result content
    if (hasResult) {
      if (hasInput) {
        // Divider between input and result
        sections.push(
          <div key="divider" className="border-t border-border-subtle/50 my-1" />
        );
      }
      sections.push(
        <pre key="result" className="text-[11px] text-text-tertiary
          overflow-x-auto font-mono leading-relaxed
          max-h-48 overflow-y-auto whitespace-pre-wrap">
          {resultContent}
        </pre>
      );
    }

    return sections.length > 0 ? sections : null;
  };

  // Determine if expand makes sense
  const canExpand = hasInput || hasResult;
  const depth = message.subAgentDepth ?? 0;

  return (
    <div className={`message-content ${depth > 0 ? 'ml-16 pl-3 border-l-2 border-accent/15' : 'ml-11'}`}>
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        className={`flex items-center gap-1.5 py-1 text-left group
          ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {canExpand ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className={`flex-shrink-0 text-text-tertiary transition-transform
              duration-150 ${expanded ? 'rotate-90' : ''}`}>
            <path d="M3 2l4 3-4 3" />
          </svg>
        ) : (
          <span className="w-[10px] flex-shrink-0" />
        )}
        <ToolIcon name={toolName} ongoing={isOngoing} />
        <span className={`text-xs font-medium ${isOngoing ? 'text-ongoing' : 'text-text-muted'}`}>
          {label}
        </span>
        {isOngoing && (
          <span className="w-1.5 h-1.5 rounded-full bg-ongoing animate-pulse-soft flex-shrink-0" />
        )}
        {renderPreview()}
        {/* Show a small result indicator when collapsed with result */}
        {!expanded && hasResult && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-success flex-shrink-0 ml-0.5">
            <path d="M2.5 6l2.5 2.5 4.5-4.5" />
          </svg>
        )}
      </button>
      {expanded && (
        <div className="ml-5 mt-0.5">
          {renderExpandedContent()}
        </div>
      )}
    </div>
  );
});

/* ================================================================
   ToolResultMsg — inline result
   ================================================================ */
function ToolResultMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const content = safeContent(message.content);
  const depth = message.subAgentDepth ?? 0;

  // Show a short one-line preview on the same line as the "Result" label
  const preview = content.length > 0
    ? content.split('\n')[0].slice(0, 60) + (content.length > 60 ? '…' : '')
    : '';

  return (
    <div className={`message-content ${depth > 0 ? 'ml-16 pl-3 border-l-2 border-accent/15' : 'ml-11'}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-0.5 cursor-pointer group"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="text-success flex-shrink-0">
          <path d="M2.5 6l2.5 2.5 4.5-4.5" />
        </svg>
        <span className="text-[11px] text-text-tertiary">{t('msg.result')}</span>
        {!expanded && preview && (
          <span className="text-[11px] text-text-tertiary/60 font-mono truncate max-w-[300px]">
            {preview}
          </span>
        )}
      </button>
      {expanded && content && (
        <pre className="ml-5 mt-0.5 text-[11px] text-text-tertiary
          overflow-x-auto font-mono leading-relaxed
          max-h-48 overflow-y-auto whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}

/* ================================================================
   ThinkingMsg — minimal collapsible
   ================================================================ */
function ThinkingMsg({ message }: Props) {
  const t = useT();
  return (
    <div className="ml-11 message-content">
      <details className="group">
        <summary className="flex items-center gap-1.5 py-1
          cursor-pointer text-[11px] text-text-tertiary list-none select-none">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="transition-transform duration-150 group-open:rotate-90">
            <path d="M3 2l4 3-4 3" />
          </svg>
          {t('msg.thinking')}
        </summary>
        <div className="ml-5 mt-0.5 thinking-fade rounded-md overflow-hidden">
          <pre className="text-[11px] text-text-tertiary
            whitespace-pre-wrap max-h-48 overflow-y-auto
            font-mono leading-relaxed">
            {safeContent(message.content)}
          </pre>
        </div>
      </details>
    </div>
  );
}

/* PermissionMsg — extracted to PermissionCard.tsx */

/* ================================================================
   PlanMsg — inline collapsible list (no card)
   ================================================================ */
function PlanMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const items = message.planItems || (typeof message.content === 'string' ? message.content.split('\n').filter(Boolean) : []);

  return (
    <div className="ml-11">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-1 cursor-pointer"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span className="text-xs font-medium text-text-muted">
          {t('msg.planTitle')}
        </span>
        <span className="text-[11px] text-text-tertiary">
          ({items.length} {t('msg.planSteps')})
        </span>
      </button>
      {expanded && (
        <div className="ml-5 mt-0.5 space-y-0.5">
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px] text-text-muted">
              <span className="flex-shrink-0 text-text-tertiary font-mono w-4 text-right">
                {i + 1}.
              </span>
              <span className="leading-relaxed">
                {item.replace(/^[\d]+\.\s*/, '').replace(/^[-•]\s*/, '')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   TodoMsg — tree-style with indent connector lines (Claude Code style)
   ================================================================ */
function TodoMsg({ message }: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const items = Array.isArray(message.todoItems) ? message.todoItems : [];
  const completedCount = items.filter((i) => i.status === 'completed').length;
  const inProgressItem = items.find((i) => i.status === 'in_progress');

  return (
    <div className="ml-11">
      {/* Header — collapsible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 py-1 cursor-pointer text-left"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`flex-shrink-0 text-text-tertiary transition-transform
            duration-150 ${expanded ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
        <span className="text-xs font-bold text-text-primary">{t('msg.todo')}</span>
        <span className="text-[10px] text-text-tertiary">
          {completedCount}/{items.length}
        </span>
        {inProgressItem && (
          <span className="text-[10px] text-accent italic ml-1 truncate max-w-[200px]">
            {inProgressItem.activeForm || inProgressItem.content}
          </span>
        )}
      </button>
      {/* Tree-style checklist with connector lines */}
      {expanded && (
        <div className="ml-[7px] mt-0.5">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <div key={i} className="flex items-stretch">
                {/* Connector line column */}
                <div className="flex flex-col items-center w-4 flex-shrink-0">
                  {/* Horizontal branch + vertical trunk */}
                  <div className="flex items-center h-5">
                    <div className={`w-px h-full ${isLast ? 'h-1/2 self-start' : ''}`}
                      style={{
                        background: 'var(--color-border)',
                        height: isLast ? '50%' : '100%',
                        alignSelf: isLast ? 'flex-start' : undefined,
                      }}
                    />
                    <div className="w-2 h-px" style={{ background: 'var(--color-border)' }} />
                  </div>
                  {/* Continuing trunk below (hidden for last item) */}
                  {!isLast && (
                    <div className="w-px flex-1" style={{ background: 'var(--color-border)' }} />
                  )}
                </div>
                {/* Status icon + text */}
                <div className="flex items-center gap-1.5 py-0.5 min-h-[20px]">
                  {item.status === 'completed' ? (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
                      className="flex-shrink-0">
                      <rect x="0.5" y="0.5" width="11" height="11" rx="2"
                        fill="var(--color-success)" fillOpacity="0.15"
                        stroke="var(--color-success)" strokeWidth="1" />
                      <path d="M3 6l2 2 4-4" stroke="var(--color-success)"
                        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  ) : item.status === 'in_progress' ? (
                    <span className="w-[11px] h-[11px] flex items-center justify-center flex-shrink-0">
                      <span className="w-2.5 h-2.5 rounded-full border-2 border-accent
                        bg-accent/20 animate-pulse-soft" />
                    </span>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
                      className="flex-shrink-0">
                      <rect x="0.5" y="0.5" width="11" height="11" rx="2"
                        fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1"
                        strokeOpacity="0.4" />
                    </svg>
                  )}
                  <span className={`text-[11px] leading-tight
                    ${item.status === 'completed'
                      ? 'text-text-tertiary line-through'
                      : item.status === 'in_progress'
                        ? 'text-text-primary font-medium'
                        : 'text-text-muted'
                    }`}>
                    {item.content}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* PlanReviewMsg — extracted to PlanReviewCard.tsx */

/* QuestionMsg — extracted to QuestionCard.tsx */
