import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../lib/i18n';
import { bridge, type ContentSearchResult } from '../../lib/tauri-bridge';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { useAgentStore } from '../../stores/agentStore';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { parseSessionMessages } from '../../lib/session-loader';
import { showToast } from '../shared/Toast';
import { friendlyError } from '../../lib/error-format';
import { t } from '../../lib/i18n';

type SearchMode = 'questions-only' | 'questions-first' | 'all';
type DateFilter = 'all' | 'today' | '3days' | 'week' | 'month';
type BackendFilter = 'all' | 'claude' | 'codex';

interface ConversationSearchProps {
  open: boolean;
  onClose: () => void;
}

/** Extract display label from a project path. */
function projectLabel(project: string): string {
  const parts = project.replace(/^~[\\/]/, '').split(/[\\/]/);
  return parts[parts.length - 1] || project;
}

/** Format a timestamp into a readable date string. (A7: 日期文案走 i18n) */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const dayOfWeek = now.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = todayStart - daysToMonday * 86400000;

  if (ms >= todayStart) return t('conv.today');
  if (ms >= yesterdayStart) return t('conv.yesterday');
  if (ms >= weekStart) return t('conv.thisWeek');

  const month = d.getMonth() + 1;
  const day = d.getDate();
  return t('search.dateMonthDay', { month: String(month), day: String(day) });
}

/** Get cutoff timestamp for date filter. */
function getDateCutoff(filter: DateFilter): number {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  switch (filter) {
    case 'today': return todayStart;
    case '3days': return todayStart - 3 * 86400000;
    case 'week': {
      const dayOfWeek = now.getDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      return todayStart - daysToMonday * 86400000;
    }
    case 'month': return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    default: return 0;
  }
}

/** Highlight query matches in text using <mark> tags. */
function highlightText(text: string, query: string): React.ReactNode[] {
  if (!query) return [text];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let last = 0;
  let idx = lower.indexOf(q, last);
  let key = 0;
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(<mark key={key++} className="bg-accent/20 text-accent rounded-sm px-0.5">{text.slice(idx, idx + q.length)}</mark>);
    last = idx + q.length;
    idx = lower.indexOf(q, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Flatten all visible result items (user + assistant) into a navigable list. */
interface FlatItem {
  result: ContentSearchResult;
  type: 'user' | 'assistant';
}

export function ConversationSearch({ open, onClose }: ConversationSearchProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('questions-first');
  const [results, setResults] = useState<ContentSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // A6: 搜索失败与"无结果"严格区分 —— 失败显示错误行 + 可重试
  const [searchFailed, setSearchFailed] = useState(false);
  const [showReplies, setShowReplies] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [showFilters, setShowFilters] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [backendFilter, setBackendFilter] = useState<BackendFilter>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  // Focus input on open, reset state on close
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setQuery('');
      setResults([]);
      setFocusedIdx(-1);
      setShowFilters(false);
      setDateFilter('all');
      setProjectFilter('all');
      setBackendFilter('all');
      setSearchFailed(false);
    }
  }, [open]);

  // Close filter dropdown on outside click
  useEffect(() => {
    if (!showFilters) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowFilters(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFilters]);

  // Perform search
  const doSearch = useCallback(async (q: string, m: SearchMode) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const roleFilter = m === 'questions-only' ? 'user' : null;
      const r = await bridge.searchSessions(q, roleFilter);
      setResults(r);
      setSearchFailed(false);
    } catch (err) {
      // A6: 失败不能伪装成"无结果" —— 置失败态，UI 提供重试入口
      console.error('Content search failed:', err);
      setResults([]);
      setSearchFailed(true);
    }
    setSearching(false);
  }, []);

  // Debounced search on query/mode change
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => doSearch(query, mode), 300);
    return () => clearTimeout(timer);
  }, [query, mode, doSearch]);

  // Available projects from current results (for filter dropdown)
  const availableProjects = useMemo(() => {
    const names = new Set<string>();
    for (const r of results) {
      names.add(projectLabel(r.project || r.project_dir));
    }
    return Array.from(names).sort();
  }, [results]);

  // Apply filters to results
  const filtered = useMemo(() => {
    let list = results;
    if (dateFilter !== 'all') {
      const cutoff = getDateCutoff(dateFilter);
      list = list.filter(r => r.modified_at >= cutoff);
    }
    if (projectFilter !== 'all') {
      list = list.filter(r => projectLabel(r.project || r.project_dir) === projectFilter);
    }
    if (backendFilter !== 'all') {
      list = list.filter(r => r.origin === backendFilter);
    }
    return list;
  }, [results, dateFilter, projectFilter, backendFilter]);

  // Group filtered results by project
  const grouped = useMemo(() => {
    const map = new Map<string, ContentSearchResult[]>();
    for (const r of filtered) {
      const key = r.project || r.project_dir;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    for (const items of map.values()) {
      items.sort((a, b) => b.modified_at - a.modified_at);
    }
    const entries = Array.from(map.entries());
    entries.sort((a, b) => (b[1][0]?.modified_at || 0) - (a[1][0]?.modified_at || 0));
    return entries;
  }, [filtered]);

  // Build flat navigable list
  const { flatItems, flatIds } = useMemo(() => {
    const items: FlatItem[] = [];
    const ids: string[] = [];
    for (const [, groupItems] of grouped) {
      for (const r of groupItems) {
        if (r.user_snippets.length > 0) {
          items.push({ result: r, type: 'user' });
          ids.push(`user-${r.session_id}`);
        }
      }
      if (mode !== 'questions-only') {
        for (const r of groupItems) {
          if (r.user_snippets.length === 0 && r.assistant_snippets.length > 0) {
            items.push({ result: r, type: 'assistant' });
            ids.push(`assistant-${r.session_id}`);
          }
        }
      }
    }
    return { flatItems: items, flatIds: ids };
  }, [grouped, mode]);

  // Total counts
  const totals = useMemo(() => {
    let user = 0, assistant = 0;
    for (const r of filtered) {
      user += r.user_match_count;
      assistant += r.assistant_match_count;
    }
    return { user, assistant, total: user + assistant };
  }, [filtered]);

  // Load session and navigate to it
  const handleJump = useCallback(async (session: ContentSearchResult) => {
    const sessionId = session.session_id;
    const { selectedSessionId } = useSessionStore.getState();

    // Determine target turn number (1-based user message count)
    const turnNumber: number | null =
      session.user_match_indices?.[0] ||
      session.assistant_match_indices?.[0] ||
      null;

    if (selectedSessionId && selectedSessionId !== sessionId) {
      useChatStore.getState().saveToCache(selectedSessionId);
      useAgentStore.getState().saveToCache(selectedSessionId);
    }

    useFileStore.getState().closePreview();
    useSessionStore.getState().setSelectedSession(sessionId);

    // Helper: find the message index for a given user turn number (1-based)
    const applyHighlight = (turn: number) => {
      const tab = useChatStore.getState().getTab(sessionId);
      if (!tab) return;
      // Find the Nth user message (turn is 1-based)
      let userCount = 0;
      for (let i = 0; i < tab.messages.length; i++) {
        if (tab.messages[i].role === 'user') {
          userCount++;
          if (userCount === turn) {
            useChatStore.getState().setHighlightMessageIndex(i);
            return;
          }
        }
      }
    };

    // Try cache first
    const restored = useChatStore.getState().restoreFromCache(sessionId);
    if (restored) {
      useAgentStore.getState().restoreFromCache(sessionId);
      if (turnNumber != null) {
        applyHighlight(turnNumber);
        setTimeout(() => onClose(), 150); // delay so ChatPanel can render + scroll
      } else {
        onClose();
      }
      return;
    }

    // Find session metadata for path
    const sessions = useSessionStore.getState().sessions;
    const meta = sessions.find(s => s.id === sessionId);
    if (!meta?.path) {
      onClose();
      return;
    }

    // Load from disk
    useChatStore.getState().ensureTab(sessionId);
    useSettingsStore.getState().setWorkingDirectory(session.project);
    const { clearMessages, addMessage, setSessionStatus, setSessionMeta } = useChatStore.getState();
    const agentActions = useAgentStore.getState();
    clearMessages(sessionId);
    agentActions.clearAgents();
    setSessionStatus(sessionId, 'running');
    setSessionMeta(sessionId, {
      sessionId,
      stdinId: undefined,
      sessionOrigin: session.origin || 'claude',
    });

    try {
      const rawMessages = await bridge.loadSession(meta.path);
      if (useSessionStore.getState().selectedSessionId !== sessionId) return;
      const { messages, agents } = parseSessionMessages(rawMessages);

      for (const agent of agents) {
        agentActions.upsertAgent(agent);
      }

      for (const msg of messages) {
        addMessage(sessionId, msg);
      }

      setSessionStatus(sessionId, 'idle');

      // Apply highlight after all messages are loaded
      if (turnNumber != null) {
        applyHighlight(turnNumber);
        setTimeout(() => onClose(), 150); // delay so ChatPanel can render + scroll
      } else {
        onClose();
      }
    } catch (err) {
      // A6: 跳转失败不再静默关闭 —— 保留错误信息并提示
      setSessionStatus(sessionId, 'idle');
      showToast(friendlyError(String(err)), 'error');
      onClose();
    }
  }, [onClose]);

  // Jump to focused item
  const jumpToFocused = useCallback(() => {
    if (focusedIdx >= 0 && focusedIdx < flatItems.length) {
      handleJump(flatItems[focusedIdx].result);
    }
  }, [focusedIdx, flatItems, handleJump]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIdx < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-nav-id="${flatIds[focusedIdx]}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIdx, flatIds]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showFilters) { setShowFilters(false); return; }
        onClose();
        return;
      }
      if (flatItems.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIdx(prev => Math.min(prev + 1, flatItems.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIdx(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        jumpToFocused();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, flatItems, jumpToFocused, showFilters]);

  if (!open) return null;

  const hasResults = filtered.length > 0;
  const queryShort = query.trim().length > 0 && query.trim().length < 2;
  const hasActiveFilters = dateFilter !== 'all' || projectFilter !== 'all' || backendFilter !== 'all';

  const DATE_OPTIONS: { key: DateFilter; label: string }[] = [
    { key: 'all', label: t('search.filterDateAll') },
    { key: 'today', label: t('search.filterDateToday') },
    { key: '3days', label: t('search.filterDate3days') },
    { key: 'week', label: t('search.filterDateWeek') },
    { key: 'month', label: t('search.filterDateMonth') },
  ];

  const BACKEND_OPTIONS: { key: BackendFilter; label: string }[] = [
    { key: 'all', label: t('search.filterBackendAll') },
    { key: 'claude', label: 'Claude' },
    { key: 'codex', label: 'Codex' },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[10vh] bg-black/40"
      onClick={onClose}>
      <div className="bg-bg-card border border-border-subtle rounded-2xl shadow-2xl
        w-full max-w-2xl max-h-[80vh] flex flex-col mx-4 animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">{t('search.title')}</h2>
          <div className="flex items-center gap-1">
            {/* Keyboard hint */}
            <span className="text-[10px] text-text-tertiary mr-1 hidden sm:inline">
              ↑↓ {t('search.jumpTo')} · Esc
            </span>
            <button onClick={onClose}
              className="p-1 rounded-lg hover:bg-bg-secondary text-text-tertiary hover:text-text-primary transition-smooth cursor-pointer">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search bar + filters */}
        <div className="px-5 py-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl
              bg-bg-secondary border border-border-subtle
              focus-within:border-border-focus transition-smooth">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.5"
                className="text-text-tertiary flex-shrink-0">
                <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setFocusedIdx(-1); }}
                placeholder={t('search.placeholder')}
                className="flex-1 bg-transparent text-sm text-text-primary
                  placeholder:text-text-tertiary outline-none"
              />
              {query && (
                <button onClick={() => setQuery('')}
                  className="p-0.5 rounded text-text-tertiary hover:text-text-primary transition-smooth cursor-pointer">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              )}
            </div>

            {/* Filter toggle */}
            <div ref={filterRef} className="relative">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`flex-shrink-0 p-2 rounded-lg transition-smooth cursor-pointer
                  ${hasActiveFilters
                    ? 'bg-accent/10 text-accent'
                    : showFilters
                      ? 'bg-bg-secondary text-text-primary'
                      : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
                  }`}
                title={t('search.filters')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M1 3h5l4 10h5" />
                  <circle cx="4" cy="3" r="1.5" />
                  <circle cx="12" cy="13" r="1.5" />
                </svg>
              </button>

              {/* Filter dropdown */}
              {showFilters && (
                <div className="absolute top-full right-0 mt-1 min-w-[200px]
                  bg-bg-card border border-border-subtle rounded-xl shadow-lg
                  py-2 px-3 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                  {/* Date filter */}
                  <label className="text-[10px] text-text-tertiary mb-1.5 block">{t('search.filterDate')}</label>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {DATE_OPTIONS.map(({ key, label }) => (
                      <button key={key}
                        onClick={() => setDateFilter(key)}
                        className={`px-2 py-0.5 rounded text-[10px] transition-smooth cursor-pointer
                          ${dateFilter === key
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-muted hover:bg-bg-secondary'
                          }`}
                      >{label}</button>
                    ))}
                  </div>

                  {/* Project filter */}
                  <label className="text-[10px] text-text-tertiary mb-1.5 block">{t('search.filterProject')}</label>
                  <div className="flex flex-wrap gap-1 mb-3 max-h-[80px] overflow-y-auto">
                    <button
                      onClick={() => setProjectFilter('all')}
                      className={`px-2 py-0.5 rounded text-[10px] transition-smooth cursor-pointer
                        ${projectFilter === 'all'
                          ? 'bg-accent/10 text-accent'
                          : 'text-text-muted hover:bg-bg-secondary'
                        }`}
                    >{t('search.filterProjectAll')}</button>
                    {availableProjects.map(p => (
                      <button key={p}
                        onClick={() => setProjectFilter(p)}
                        className={`px-2 py-0.5 rounded text-[10px] transition-smooth cursor-pointer truncate max-w-[140px]
                          ${projectFilter === p
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-muted hover:bg-bg-secondary'
                          }`}
                      >{p}</button>
                    ))}
                  </div>

                  {/* Backend filter */}
                  <label className="text-[10px] text-text-tertiary mb-1.5 block">{t('search.filterBackend')}</label>
                  <div className="flex flex-wrap gap-1">
                    {BACKEND_OPTIONS.map(({ key, label }) => (
                      <button key={key}
                        onClick={() => setBackendFilter(key)}
                        className={`px-2 py-0.5 rounded text-[10px] transition-smooth cursor-pointer
                          ${backendFilter === key
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-muted hover:bg-bg-secondary'
                          }`}
                      >{label}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center gap-1 mt-2">
            {([
              { key: 'questions-only' as SearchMode, label: t('search.modeQuestionsOnly') },
              { key: 'questions-first' as SearchMode, label: t('search.modeQuestionsFirst') },
              { key: 'all' as SearchMode, label: t('search.modeAll') },
            ]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => { setMode(key); setFocusedIdx(-1); }}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-smooth cursor-pointer
                  ${mode === key
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary'
                  }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Results summary */}
        {hasResults && (
          <div className="px-5 pb-1 flex items-center gap-2">
            <p className="text-[11px] text-text-tertiary">
              {t('search.resultsSummary', {
                total: String(totals.total),
                user: String(totals.user),
                assistant: String(totals.assistant),
              })}
            </p>
            {hasActiveFilters && (
              <span className="text-[10px] text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                {t('search.filtered')}
              </span>
            )}
          </div>
        )}

        {/* Results area */}
        <div ref={listRef} className="flex-1 overflow-y-auto px-5 pb-4">
          {/* Searching spinner */}
          {searching && (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          )}

          {/* Search failed — A6: 与"无结果"严格区分，提供重试 */}
          {!searching && query.trim().length >= 2 && searchFailed && (
            <div className="flex flex-col items-center justify-center py-10 text-text-tertiary gap-2">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.5" className="mb-1 opacity-40">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <p className="text-xs text-error">{t('search.searchFailed')}</p>
              <button
                onClick={() => doSearch(query, mode)}
                className="px-3 py-1 rounded-md text-[11px] font-medium
                  bg-error/10 text-error hover:bg-error/20 transition-smooth cursor-pointer"
              >
                {t('common.retry')}
              </button>
            </div>
          )}

          {/* No results */}
          {!searching && query.trim().length >= 2 && !hasResults && !searchFailed && (
            <div className="flex flex-col items-center justify-center py-10 text-text-tertiary">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-40">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <p className="text-xs">{t('search.noResults')}</p>
            </div>
          )}

          {/* Too short query hint */}
          {queryShort && !searching && (
            <div className="flex justify-center py-10">
              <p className="text-xs text-text-tertiary">{t('search.inputHint')}</p>
            </div>
          )}

          {/* Grouped results */}
          {hasResults && grouped.map(([project, items]) => {
            const pLabel = projectLabel(project);
            const hasUserItems = items.filter(r => r.user_snippets.length > 0);
            const assistantOnlyItems = mode === 'questions-only'
              ? []
              : items.filter(r => r.user_snippets.length === 0 && r.assistant_snippets.length > 0);

            return (
              <div key={project} className="mb-3">
                {/* Project header */}
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[11px] font-semibold text-text-secondary truncate">
                    {pLabel}
                  </span>
                  <span className="text-[10px] text-text-tertiary flex-shrink-0">
                    {items.length} {t('conv.sessions')}
                  </span>
                </div>

                {/* User questions */}
                {hasUserItems.map((r) => {
                  const navId = `user-${r.session_id}`;
                  const isFocused = flatIds.indexOf(navId) === focusedIdx;
                  return (
                    <div key={r.session_id}
                      data-nav-id={navId}
                      className={`group mb-1.5 pl-3 border-l-2 rounded-r-md
                        transition-smooth cursor-pointer
                        ${isFocused
                          ? 'border-accent bg-accent/5'
                          : 'border-accent/30 hover:border-accent/60'
                        }`}
                      onClick={() => handleJump(r)}>
                      <div className="flex items-center gap-1.5 mb-0.5 pt-0.5">
                        <span className="text-[10px] text-text-tertiary">
                          {formatDate(r.modified_at)}
                        </span>
                        <span className="text-[10px] text-text-tertiary">·</span>
                        <span className="text-[10px] text-text-muted truncate">{r.preview || r.session_id.slice(0, 8)}</span>
                      </div>
                      {r.user_snippets.slice(0, 2).map((s, si) => (
                        <p key={si} className="text-xs text-text-primary leading-relaxed mb-0.5 line-clamp-2 pr-2">
                          {highlightText(s, query)}
                        </p>
                      ))}
                      <div className="flex items-center justify-between pb-0.5">
                        <span className="text-[10px] text-text-tertiary">
                          {t('search.nMatches', { n: String(r.user_match_count) })}
                        </span>
                        <span className="text-[10px] text-accent opacity-0 group-hover:opacity-100
                          transition-smooth pr-2">
                          {t('search.jumpTo')} →
                        </span>
                      </div>
                    </div>
                  );
                })}

                {/* Agent replies */}
                {assistantOnlyItems.length > 0 && (
                  <div className="mt-1">
                    <button
                      onClick={() => setShowReplies(!showReplies)}
                      className="flex items-center gap-1 text-[10px] text-text-tertiary
                        hover:text-text-muted transition-smooth cursor-pointer mb-1">
                      <svg
                        className={`w-2.5 h-2.5 transition-transform ${showReplies ? 'rotate-90' : ''}`}
                        viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M3 1l4 4-4 4" />
                      </svg>
                      <span>🤖 {t('search.agentReplies')} ({assistantOnlyItems.length})</span>
                    </button>
                    {showReplies && assistantOnlyItems.map((r) => {
                      const navId = `assistant-${r.session_id}`;
                      const isFocused = flatIds.indexOf(navId) === focusedIdx;
                      return (
                        <div key={r.session_id}
                          data-nav-id={navId}
                          className={`group mb-1 pl-3 border-l-2 rounded-r-md
                            transition-smooth cursor-pointer opacity-80
                            ${isFocused
                              ? 'border-accent bg-accent/5 opacity-100'
                              : 'border-border-subtle hover:border-border-focus'
                            }`}
                          onClick={() => handleJump(r)}>
                          <div className="flex items-center gap-1.5 mb-0.5 pt-0.5">
                            <span className="text-[10px] text-text-tertiary">
                              {formatDate(r.modified_at)}
                            </span>
                            <span className="text-[10px] text-text-muted truncate">{r.preview || r.session_id.slice(0, 8)}</span>
                          </div>
                          {r.assistant_snippets.slice(0, 2).map((s, si) => (
                            <p key={si} className="text-[11px] text-text-muted leading-relaxed mb-0.5 line-clamp-2 pr-2">
                              {highlightText(s, query)}
                            </p>
                          ))}
                          <div className="flex items-center justify-between pb-0.5">
                            <span className="text-[10px] text-text-tertiary">
                              {t('search.nMatches', { n: String(r.assistant_match_count) })}
                            </span>
                            <span className="text-[10px] text-accent opacity-0 group-hover:opacity-100
                              transition-smooth pr-2">
                              {t('search.jumpTo')} →
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
