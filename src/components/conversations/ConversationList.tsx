import { useEffect, useMemo, useCallback, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { useAgentStore } from '../../stores/agentStore';
import { bridge, SessionListItem } from '../../lib/tauri-bridge';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { useT } from '../../lib/i18n';
import { showToast } from '../shared/Toast';
import { cleanupStreamListener } from '../../lib/stream-cleanup';
// fix2/fix16: 磁盘加载共享实现（内部批量入库）
import { loadSessionFromDisk } from '../../lib/session-disk-load';
import { SessionGroup } from './SessionGroup';
import { SessionItem } from './SessionItem';
import { SessionContextMenu, ProjectContextMenu } from './SessionContextMenu';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { ConversationSearch } from './ConversationSearch';

// --- Path utilities ---

let _cachedHomeDir: string | null = null;
bridge.getHomeDir().then((h) => { _cachedHomeDir = h; }).catch(() => {});

function isWindowsAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p);
}

function resolveProjectPath(raw: string): string {
  if (raw.startsWith('/') || isWindowsAbsolutePath(raw)) return raw;
  if (raw.startsWith('~/') || raw === '~') {
    if (_cachedHomeDir) return raw.replace('~', _cachedHomeDir);
    return raw;
  }
  if (/^[A-Za-z]-/.test(raw)) {
    const drive = raw[0];
    const rest = raw.slice(2);
    return `${drive}:\\${rest.replace(/-/g, '\\')}`;
  }
  return raw.replace(/-/g, '/');
}

function normalizeProjectKey(raw: string): string {
  const unix = raw.match(/^\/(?:Users|home)\/[^/]+(\/.*)/);
  if (unix) return '~' + unix[1];
  const win = raw.match(/^[A-Za-z]:[/\\]Users[/\\][^/\\]+([/\\].*)/i);
  if (win) return '~' + win[1];
  return raw;
}

/** Extract display label from a project key.
 *  When `parentHint` is true (duplicate names), appends parent folder:
 *  "A (Desktop)" vs "A (坚果云)" */
function projectLabel(project: string, parentHint?: boolean): string {
  const parts = project.replace(/^~[\\/]/, '').split(/[\\/]/);
  const name = parts[parts.length - 1] || project;
  if (parentHint && parts.length >= 2) {
    return `${name} (${parts[parts.length - 2]})`;
  }
  return name;
}

// --- Context menu types ---

interface ContextMenuState {
  x: number;
  y: number;
  session: SessionListItem;
}

interface ProjectMenuState {
  x: number;
  y: number;
  project: string;
}

// --- Main component ---

export function ConversationList() {
  const t = useT();

  // Store subscriptions
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const fetchError = useSessionStore((s) => s.fetchError);
  const searchQuery = useSessionStore((s) => s.searchQuery);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const setSearchQuery = useSessionStore((s) => s.setSearchQuery);
  const selectedId = useSessionStore((s) => s.selectedSessionId);
  const setSelected = useSessionStore((s) => s.setSelectedSession);
  const customPreviews = useSessionStore((s) => s.customPreviews);
  const setCustomPreview = useSessionStore((s) => s.setCustomPreview);
  const runningSessions = useSessionStore((s) => s.runningSessions);
  const sessionStatuses = useSessionStore((s) => s.sessionStatuses);
  const contentSearchResults = useSessionStore((s) => s.contentSearchResults);
  const isContentSearching = useSessionStore((s) => s.isContentSearching);
  const searchError = useSessionStore((s) => s.searchError);
  const searchSessionContent = useSessionStore((s) => s.searchSessionContent);
  const clearContentSearch = useSessionStore((s) => s.clearContentSearch);

  // Context menus
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<SessionListItem | null>(null);
  const [deleteAllTarget, setDeleteAllTarget] = useState<{
    projectKey: string;
    count: number;
  } | null>(null);

  // Shift+click multi-select: track last clicked index
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Smart collapse (Phase 2)
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());
  const [manualCollapsed, setManualCollapsed] = useState<Set<string>>(new Set());

  // Pinned & archived (Phase 3)
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(() => {
    try {
      const data = localStorage.getItem('tokenicode_pinned_sessions');
      return new Set(data ? JSON.parse(data) : []);
    } catch { return new Set(); }
  });
  const [archivedSessions, setArchivedSessions] = useState<Set<string>>(() => {
    try {
      const data = localStorage.getItem('tokenicode_archived_sessions');
      return new Set(data ? JSON.parse(data) : []);
    } catch { return new Set(); }
  });
  const [showArchived, setShowArchived] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Multi-select
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ESC to cancel multi-select
  useEffect(() => {
    if (!multiSelect) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMultiSelect(false);
        setSelectedIds(new Set());
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [multiSelect]);

  // Persist pinned/archived — localStorage only (portable EXE, no disk writes)
  const persistPinned = useCallback((next: Set<string>) => {
    setPinnedSessions(next);
    localStorage.setItem('tokenicode_pinned_sessions', JSON.stringify([...next]));
  }, []);

  const persistArchived = useCallback((next: Set<string>) => {
    setArchivedSessions(next);
    localStorage.setItem('tokenicode_archived_sessions', JSON.stringify([...next]));
  }, []);

  // Load pinned/archived from localStorage on init
  useEffect(() => {
    try {
      const pinned = JSON.parse(localStorage.getItem('tokenicode_pinned_sessions') || '[]');
      if (pinned.length) setPinnedSessions(new Set(pinned));
    } catch {}
    try {
      const archived = JSON.parse(localStorage.getItem('tokenicode_archived_sessions') || '[]');
      if (archived.length) setArchivedSessions(new Set(archived));
    } catch {}
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchSessions().then(() => {
      const currentSelected = useSessionStore.getState().selectedSessionId;
      if (!currentSelected) {
        const lastId = useSessionStore.getState().getLastSessionId();
        if (lastId) {
          const sessions = useSessionStore.getState().sessions;
          const match = sessions.find((s) => s.id === lastId);
          if (match) {
            handleLoadSession(match);
          }
        }
      }
    });
    // fix22: 轮询 30s→300s（sessions:changed 事件已覆盖即时刷新）
    const interval = setInterval(fetchSessions, 300000);
    return () => clearInterval(interval);
  }, []);

  // Listen for sessions:changed event for instant refresh
  useEffect(() => {
    // fix9: cancelled 标志 + 卸载竞态防护——resolve 时若已卸载立即注销
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen('sessions:changed', () => {
      fetchSessions();
    }).then((fn) => {
      if (cancelled) { fn(); return; }
      unlisten = fn;
    }).catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, [fetchSessions]);

  // Debounce content search: 300ms after searchQuery changes, ≥2 chars
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      clearContentSearch();
      return;
    }
    const timer = setTimeout(() => {
      searchSessionContent(searchQuery.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchSessionContent, clearContentSearch]);

  // Display name resolver
  const displayName = useCallback((session: SessionListItem) => {
    return customPreviews[session.id] || session.preview || '';
  }, [customPreviews]);

  // Filtered sessions (search + archive)
  const filtered = useMemo(() => {
    let result = sessions;

    // Archive filter: OFF = hide archived, ON = show ONLY archived
    if (showArchived) {
      result = result.filter((s) => archivedSessions.has(s.id));
    } else {
      result = result.filter((s) => !archivedSessions.has(s.id));
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          displayName(s).toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q)
      );
    }

    return result;
  }, [sessions, searchQuery, displayName, showArchived, archivedSessions]);

  // Group by project
  const projectGroups = useMemo(() => {
    const map = new Map<string, SessionListItem[]>();
    for (const s of filtered) {
      const raw = s.project || s.projectDir;
      const key = normalizeProjectKey(raw);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    for (const items of map.values()) {
      items.sort((a, b) => b.modifiedAt - a.modifiedAt);
    }
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      const ta = a[1][0]?.modifiedAt || 0;
      const tb = b[1][0]?.modifiedAt || 0;
      return tb - ta;
    });
    return entries;
  }, [filtered]);

  // Content-only matches: sessions hit by content search but NOT by metadata filter
  const contentOnlyMatches = useMemo(() => {
    if (!searchQuery.trim() || contentSearchResults.size === 0) return [];
    const metadataIds = new Set(filtered.map((s) => s.id));
    return sessions.filter((s) => {
      if (metadataIds.has(s.id)) return false;
      if (!contentSearchResults.has(s.id)) return false;
      // Respect archive filter
      if (showArchived) return archivedSessions.has(s.id);
      return !archivedSessions.has(s.id);
    });
  }, [sessions, filtered, contentSearchResults, searchQuery, showArchived, archivedSessions]);

  // P1: precomputed base-name counts — the duplicate-folder disambiguation
  // used to re-filter the whole projectGroups array for every project on
  // every render (O(N²) per render with N projects).
  const baseNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [project] of projectGroups) {
      const base = projectLabel(project);
      counts.set(base, (counts.get(base) || 0) + 1);
    }
    return counts;
  }, [projectGroups]);

  // Smart expand: expand if contains selected, or manually expanded
  const isExpanded = useCallback((key: string) => {
    if (manualCollapsed.has(key)) return false;
    if (manualExpanded.has(key)) return true;
    // Default: expand if contains selected session
    if (!selectedId) return true; // expand all if nothing selected
    const raw = sessions.find((s) => s.id === selectedId);
    if (!raw) return false;
    const selectedKey = normalizeProjectKey(raw.project || raw.projectDir);
    return selectedKey === key;
  }, [manualCollapsed, manualExpanded, selectedId, sessions]);

  const toggleCollapse = useCallback((project: string) => {
    const expanded = isExpanded(project);
    if (expanded) {
      // Collapse it
      setManualCollapsed((prev) => { const next = new Set(prev); next.add(project); return next; });
      setManualExpanded((prev) => { const next = new Set(prev); next.delete(project); return next; });
    } else {
      // Expand it
      setManualExpanded((prev) => { const next = new Set(prev); next.add(project); return next; });
      setManualCollapsed((prev) => { const next = new Set(prev); next.delete(project); return next; });
    }
  }, [isExpanded]);

  // --- Session loading (slim version using session-loader) ---
  const handleLoadSession = useCallback(async (session: SessionListItem) => {
    const { path: sessionPath, id: sessionId, project: projectOrDir } = session;
    const currentTabId = selectedId;
    if (currentTabId === sessionId) return;

    // Save current to cache
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }

    // Close file preview
    useFileStore.getState().closePreview();

    // Switch selection
    setSelected(sessionId);

    // Try cache first
    const restored = useChatStore.getState().restoreFromCache(sessionId);
    if (restored) {
      useAgentStore.getState().restoreFromCache(sessionId);
      if (projectOrDir) {
        useSettingsStore.getState().setWorkingDirectory(resolveProjectPath(projectOrDir));
      }
      return;
    }

    // Draft sessions
    if (!sessionPath) {
      useChatStore.getState().ensureTab(sessionId);
      useChatStore.getState().resetTab(sessionId);
      useAgentStore.getState().clearAgents();
      return;
    }

    // Load from disk
    useSettingsStore.getState().setWorkingDirectory(resolveProjectPath(projectOrDir));
    // fix2/fix16: 磁盘加载抽成共享函数（与 App.tsx Ctrl+Tab 回退一致），
    // 内部一次 batchAddMessages 入库，替代逐条 addMessage 的 O(N²)
    await loadSessionFromDisk(sessionId, sessionPath, session.origin || 'claude');
  }, [selectedId, setSelected, t]);

  // --- Delete handlers ---
  const executeDelete = useCallback(async (sessionId: string, sessionPath: string) => {
    try {
      // H5: kill a still-running CLI process before deleting — otherwise the
      // orphaned process keeps running (and the AI keeps writing files /
      // running commands) with no tab left to route its stream to, silently.
      // F5: 判定放宽为"tab 存在 sessionMeta.stdinId 即 kill"——prewarm 进程
      // 从不处于 running 状态，旧的 isSessionRunning 条件永远不杀它们。
      const stdinId = useChatStore.getState().getTab(sessionId)?.sessionMeta.stdinId;
      if (stdinId) {
        // Await the kill before deleting the session file — on Windows the
        // CLI process may still hold the JSONL open (no FILE_SHARE_DELETE),
        // and removing it mid-kill throws a sharing violation. kill_session
        // internally awaits process termination.
        await bridge.killSession(stdinId).catch(() => {});
        cleanupStreamListener(stdinId);
        useSessionStore.getState().unregisterStdinTab(stdinId);
        useChatStore.getState().setSessionMeta(sessionId, { stdinId: undefined });
      }
      if (useSessionStore.getState().isSessionRunning(sessionId)) {
        useSessionStore.getState().setSessionRunning(sessionId, false);
        // H5 (background tab): the listener was removed above, so the killed
        // process's exit event will never arrive to settle the tab — without
        // this the tab stays 'running' forever with a dead stdinId and a
        // queued pending list nobody drains.
        useChatStore.getState().setSessionStatus(sessionId, 'idle');
        useChatStore.getState().clearPendingMessages(sessionId);
      }
      if (sessionPath) {
        await bridge.deleteSession(sessionId, sessionPath);
      } else {
        useSessionStore.getState().removeDraft(sessionId);
        // fix18: draft 被移除时清空全局 pre-warm 事件队列（其中的事件已无归属）
        window.__claudeStreamQueue = undefined;
      }
      // fix17: 删除成功后清理该会话残留的状态条目（customPreviews 同步落盘）
      useSessionStore.getState().cleanupDeletedSession(sessionId);
      if (selectedId === sessionId) {
        setSelected(null);
        useChatStore.getState().resetTab(sessionId);
      }
      // Unbind this sessionId from EVERY tab (a draft tab that ran this
      // session keeps sessionMeta.sessionId — without this it would try to
      // `--resume` the just-deleted session and error out on the next message).
      useChatStore.getState().clearSessionBinding(sessionId);
      useChatStore.getState().removeFromCache(sessionId);
      fetchSessions();
    } catch (err) {
      console.error('Failed to delete session:', err);
      // A10: silent failure — the session still exists on disk and the list
      // shows it as deleted. Surface the error so the user can retry.
      showToast(t('conv.deleteFailed'), 'error');
    }
  }, [selectedId, setSelected, fetchSessions, t]);

  // Single delete → confirm dialog
  const handleDeleteSingle = useCallback((session: SessionListItem) => {
    setDeleteTarget(session);
  }, []);

  // Delete all in project → confirm dialog
  const handleDeleteAllInProject = useCallback((projectKey: string) => {
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const projectSessions = allSessions.filter((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    if (projectSessions.length === 0) return;
    setDeleteAllTarget({ projectKey, count: projectSessions.length });
  }, []);

  const confirmDeleteAll = useCallback(async () => {
    if (!deleteAllTarget) return;
    const suffix = deleteAllTarget.projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const projectSessions = allSessions.filter((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    for (const session of projectSessions) {
      await executeDelete(session.id, session.path);
    }
    setDeleteAllTarget(null);
    fetchSessions();
  }, [deleteAllTarget, executeDelete, fetchSessions]);

  // --- Context menu handlers ---
  const handleContextMenu = useCallback((e: React.MouseEvent, session: SessionListItem) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }, []);

  const handleProjectContextMenu = useCallback((e: React.MouseEvent, project: string) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu({ x: e.clientX, y: e.clientY, project });
  }, []);

  const handleRevealInFinder = useCallback((session: SessionListItem) => {
    if (session.path) bridge.revealInFinder(session.path).catch(() => {});
  }, []);

  const handleExportMarkdown = useCallback(async (session: SessionListItem) => {
    if (!session.path) return;
    const outputPath = await save({
      defaultPath: `${session.id}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (outputPath) {
      bridge.exportSessionMarkdown(session.path, outputPath)
        // B20: 导出成功给反馈（与顶栏 ExportMenu 一致）
        .then(() => showToast(`${t('export.success')} ${outputPath.split(/[\\/]/).pop()}`, 'success'))
        .catch((err) => {
          console.error('Failed to export session:', err);
          showToast(t('conv.exportFailed'), 'error');
        });
    }
  }, [t]);

  const handleNewSessionInProject = useCallback((projectKey: string) => {
    const suffix = projectKey.replace(/^~/, '');
    const allSessions = useSessionStore.getState().sessions;
    const match = allSessions.find((s) => {
      const raw = s.project || s.projectDir;
      return raw.endsWith(suffix);
    });
    const realPath = match ? (match.project || match.projectDir) : resolveProjectPath(projectKey);
    useSettingsStore.getState().setWorkingDirectory(realPath);
    const currentTabId = useSessionStore.getState().selectedSessionId;
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }
    const newDraftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useChatStore.getState().ensureTab(newDraftId);
    useChatStore.getState().resetTab(newDraftId);
    useSessionStore.getState().addDraftSession(newDraftId, realPath);
  }, []);

  // Pin / Archive handlers
  const handleTogglePin = useCallback((session: SessionListItem) => {
    const next = new Set(pinnedSessions);
    if (next.has(session.id)) next.delete(session.id);
    else next.add(session.id);
    persistPinned(next);
  }, [pinnedSessions, persistPinned]);

  const handleToggleArchive = useCallback((session: SessionListItem) => {
    const next = new Set(archivedSessions);
    if (next.has(session.id)) next.delete(session.id);
    else next.add(session.id);
    persistArchived(next);
  }, [archivedSessions, persistArchived]);

  // Build flat list of visible session IDs for shift+click range selection
  const flatSessionIds = useMemo(() => {
    const ids: string[] = [];
    for (const [project, items] of projectGroups) {
      if (isExpanded(project)) {
        for (const s of items) ids.push(s.id);
      }
    }
    return ids;
  }, [projectGroups, isExpanded]);

  // Multi-select handlers (with shift+click range support)
  const handleToggleCheck = useCallback((sessionId: string, shiftKey?: boolean) => {
    // Auto-enter multiSelect mode if not already in it
    if (!multiSelect) {
      setMultiSelect(true);
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);

      // Shift+click: range select
      if (shiftKey && lastClickedIndex !== null) {
        const currentIndex = flatSessionIds.indexOf(sessionId);
        if (currentIndex !== -1) {
          const start = Math.min(lastClickedIndex, currentIndex);
          const end = Math.max(lastClickedIndex, currentIndex);
          for (let i = start; i <= end; i++) {
            next.add(flatSessionIds[i]);
          }
          setLastClickedIndex(currentIndex);
          return next;
        }
      }

      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);

      setLastClickedIndex(flatSessionIds.indexOf(sessionId));
      return next;
    });
  }, [flatSessionIds, lastClickedIndex, multiSelect]);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteAllTarget({
      projectKey: '__batch__',
      count: selectedIds.size,
    });
  }, [selectedIds]);

  const confirmBatchDelete = useCallback(async () => {
    const allSessions = useSessionStore.getState().sessions;
    for (const id of selectedIds) {
      const session = allSessions.find((s) => s.id === id);
      if (session) await executeDelete(session.id, session.path);
    }
    setSelectedIds(new Set());
    setMultiSelect(false);
    setDeleteAllTarget(null);
    fetchSessions();
  }, [selectedIds, executeDelete, fetchSessions]);

  const handleBatchArchive = useCallback(() => {
    const next = new Set(archivedSessions);
    for (const id of selectedIds) next.add(id);
    persistArchived(next);
    setSelectedIds(new Set());
    setMultiSelect(false);
  }, [selectedIds, archivedSessions, persistArchived]);

  const handleRename = useCallback((sessionId: string, newName: string) => {
    setCustomPreview(sessionId, newName);
  }, [setCustomPreview]);

  // Rename from context menu — trigger inline edit in SessionItem
  const handleRenameFromMenu = useCallback((session: SessionListItem) => {
    setRenamingSessionId(session.id);
  }, []);

  const handleRenameDone = useCallback(() => {
    setRenamingSessionId(null);
  }, []);

  const handleSelectMode = useCallback((_project: string) => {
    setMultiSelect(true);
    setSelectedIds(new Set());
  }, []);

  return (
    <div className="flex flex-col gap-1 px-3">
      {/* Search + Filters */}
      <div className="px-1 mb-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 rounded-xl
            bg-bg-secondary border border-border-subtle
            focus-within:border-border-focus transition-smooth">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5"
              className="text-text-tertiary flex-shrink-0">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('conv.search')}
              className="flex-1 bg-transparent text-xs text-text-primary
                placeholder:text-text-tertiary outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="flex-shrink-0 p-0.5 rounded text-text-tertiary
                  hover:text-text-primary transition-smooth">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            )}
          </div>

          {/* Advanced search button */}
          <button
            onClick={() => setSearchOpen(true)}
            className="flex-shrink-0 p-2 rounded-lg transition-smooth
              text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
            title={t('conv.openSearch')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6.5" cy="6.5" r="5" />
              <path d="M14 14l-2.5-2.5" />
              <path d="M3.5 6.5h6M6.5 3.5v6" />
            </svg>
          </button>

          {/* Archive toggle */}
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`flex-shrink-0 p-2 rounded-lg transition-smooth
              ${showArchived
                ? 'bg-accent/10 text-accent'
                : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
              }`}
            title={t('conv.showArchived')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="2" width="14" height="3" rx="1" />
              <path d="M2 5v7a1 1 0 001 1h10a1 1 0 001-1V5" />
              <path d="M6 8h4" />
            </svg>
          </button>

          {/* Refresh — L4: 刷新入口移到搜索栏旁，不再藏在列表最底部 */}
          <button
            onClick={() => fetchSessions()}
            className="flex-shrink-0 p-2 rounded-lg transition-smooth
              text-text-tertiary hover:bg-bg-secondary hover:text-text-primary"
            title={t('conv.refresh')}
          >
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M1 6a5 5 0 019-2M11 6a5 5 0 01-9 2" />
              <path d="M10 1v3h-3M2 11V8h3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Loading */}
      {isLoading && sessions.length === 0 && (
        <div className="flex items-center justify-center py-6">
          <div className="w-5 h-5 border-2 border-accent/30
            border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {/* Fetch failed — error row + retry (A6: 不能静默变成空列表) */}
      {fetchError && !isLoading && (
        <div className="mx-1 mb-1 px-3 py-2 rounded-lg
          bg-error/10 border border-error/20
          flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" className="text-error flex-shrink-0">
            <circle cx="6" cy="6" r="5" />
            <path d="M6 4v2.5M6 8v.5" />
          </svg>
          <span className="flex-1 min-w-0 text-[11px] text-error truncate"
            title={fetchError}>
            {t('conv.loadFailed')}
          </span>
          <button
            onClick={() => fetchSessions()}
            className="flex-shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium
              bg-error/10 text-error hover:bg-error/20 transition-smooth"
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* Project groups — detect duplicate folder names for disambiguation */}
      {projectGroups.map(([project, items]) => {
        const baseName = projectLabel(project);
        const isDuplicate = (baseNameCounts.get(baseName) || 0) > 1;
        return (
        <SessionGroup
          key={project}
          projectKey={project}
          projectLabel={projectLabel(project, isDuplicate)}
          projectPath={project}
          sessions={items}
          isExpanded={isExpanded(project)}
          selectedId={selectedId}
          sessionStatuses={sessionStatuses}
          pinnedSessions={pinnedSessions}
          archivedSessions={archivedSessions}
          customPreviews={customPreviews}
          multiSelect={multiSelect}
          selectedIds={selectedIds}
          onToggleCollapse={toggleCollapse}
          onContextMenu={handleContextMenu}
          onDelete={handleDeleteSingle}
          onProjectContextMenu={handleProjectContextMenu}
          onLoadSession={handleLoadSession}
          onRename={handleRename}
          onNewSession={handleNewSessionInProject}
          onToggleCheck={handleToggleCheck}
          renamingSessionId={renamingSessionId}
          onRenameDone={handleRenameDone}
        />
        );
      })}

      {/* Content matches section (async, appears after metadata results) */}
      {searchQuery.trim() && contentOnlyMatches.length > 0 && (
        <div className="mt-3 mb-1">
          <div className="flex items-center gap-2 px-3 py-1">
            <div className="flex-1 h-px bg-border-subtle" />
            <span className="text-[10px] text-text-tertiary font-medium uppercase tracking-wider">
              {t('conv.contentMatches')} ({contentOnlyMatches.length})
            </span>
            <div className="flex-1 h-px bg-border-subtle" />
          </div>
          {contentOnlyMatches.map((session) => {
            const result = contentSearchResults.get(session.id);
            return (
              <SessionItem
                key={session.id}
                session={session}
                isSelected={selectedId === session.id}
                sessionStatus={sessionStatuses.get(session.id)}
                isPinned={pinnedSessions.has(session.id)}
                isArchived={archivedSessions.has(session.id)}
                displayName={displayName(session)}
                contentSnippet={result?.user_snippets?.[0] || result?.assistant_snippets?.[0]}
                matchCount={(result?.user_match_count || 0) + (result?.assistant_match_count || 0)}
                searchQuery={searchQuery}
                multiSelect={multiSelect}
                isChecked={selectedIds.has(session.id)}
                onSelect={handleLoadSession}
                onContextMenu={handleContextMenu}
                onRename={handleRename}
                onDelete={handleDeleteSingle}
                onToggleCheck={handleToggleCheck}
                triggerRename={renamingSessionId === session.id}
                onRenameDone={handleRenameDone}
              />
            );
          })}
        </div>
      )}

      {/* Content search loading spinner */}
      {searchQuery.trim() && isContentSearching && (
        <div className="flex items-center justify-center gap-1.5 py-3 text-text-tertiary">
          <div className="w-3 h-3 border-[1.5px] border-text-tertiary/20
            border-t-text-tertiary/60 rounded-full animate-spin" />
          <span className="text-[10px]">{t('conv.searchingContent')}</span>
        </div>
      )}

      {/* Content search failure — distinguish from 'no results' (U2) */}
      {searchQuery.trim() && !isContentSearching && searchError && (
        <div className="text-center py-3 px-4">
          <span className="text-[11px] text-error">{t('conv.searchFailed')}</span>
        </div>
      )}

      {/* Empty state — fetchError 时由上方错误行接管，不再显示误导性的"暂无任务" */}
      {/* searchError 时同样由错误行接管，避免"错误 + 无结果"同时显示（U2） */}
      {!isLoading && !fetchError && !searchError && filtered.length === 0 && contentOnlyMatches.length === 0 && !isContentSearching && (
        <div className="text-center py-8 px-4">
          <div className="text-text-tertiary text-xs">
            {searchQuery ? t('conv.noMatch') : t('conv.noConv')}
          </div>
        </div>
      )}

      {/* Refresh button */}
      <button
        onClick={fetchSessions}
        className="mx-2 mt-2 py-1.5 rounded-lg text-[12px]
          text-text-muted hover:text-text-primary
          hover:bg-bg-secondary transition-smooth"
      >
        {t('conv.refresh')}
      </button>

      {/* Multi-select floating toolbar — sticky at bottom of scroll container */}
      {multiSelect && (
        <div className="sticky bottom-0 mx-1 mt-2 p-2 rounded-xl
          bg-bg-card/95 backdrop-blur-sm border border-border-subtle shadow-lg
          flex items-center gap-2 animate-fade-in z-10">
          <span className="text-xs text-text-muted flex-1">
            {t('conv.selected').replace('{n}', String(selectedIds.size))}
          </span>
          <button
            onClick={handleBatchArchive}
            disabled={selectedIds.size === 0}
            className="px-2 py-1 text-xs rounded-lg bg-bg-tertiary text-text-primary
              hover:bg-accent/10 hover:text-accent transition-smooth
              disabled:opacity-30"
          >
            {t('conv.archive')}
          </button>
          <button
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0}
            className="px-2 py-1 text-xs rounded-lg bg-error/10 text-error
              hover:bg-error/20 transition-smooth
              disabled:opacity-30"
          >
            {t('conv.delete')}
          </button>
          <button
            onClick={() => { setMultiSelect(false); setSelectedIds(new Set()); }}
            className="px-2 py-1 text-xs rounded-lg bg-bg-tertiary text-text-muted
              hover:text-text-primary transition-smooth"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      {/* Session context menu */}
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          session={contextMenu.session}
          onRename={handleRenameFromMenu}
          onRevealInFinder={handleRevealInFinder}
          onExport={handleExportMarkdown}
          onDelete={handleDeleteSingle}
          onPin={handleTogglePin}
          onArchive={handleToggleArchive}
          isPinned={pinnedSessions.has(contextMenu.session.id)}
          isArchived={archivedSessions.has(contextMenu.session.id)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Project context menu */}
      {projectMenu && (
        <ProjectContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          project={projectMenu.project}
          onNewSession={handleNewSessionInProject}
          onDeleteAll={handleDeleteAllInProject}
          onSelectMode={handleSelectMode}
          onClose={() => setProjectMenu(null)}
        />
      )}

      {/* Delete single confirm dialog */}
      {deleteTarget && (
        <ConfirmDialog
          open={true}
          title={t('conv.delete')}
          // B19: 运行中的会话删除会终止进程，确认文案必须明确提示
          message={
            t('conv.deleteConfirm') +
            (runningSessions.has(deleteTarget.id) ? `\n${t('conv.deleteRunningWarning')}` : '')
          }
          detail={displayName(deleteTarget) || deleteTarget.preview}
          variant="danger"
          confirmLabel={t('conv.delete')}
          onConfirm={() => {
            executeDelete(deleteTarget.id, deleteTarget.path);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Delete all confirm dialog */}
      {deleteAllTarget && (
        <ConfirmDialog
          open={true}
          title={t('conv.deleteAll')}
          message={
            deleteAllTarget.projectKey === '__batch__'
              ? t('conv.deleteAllConfirm')
                  .replace('{count}', String(deleteAllTarget.count))
                  .replace('{project}', t('conv.selected').replace('{n}', String(deleteAllTarget.count)))
              : t('conv.deleteAllConfirm')
                  .replace('{count}', String(deleteAllTarget.count))
                  .replace('{project}', projectLabel(deleteAllTarget.projectKey))
          }
          detail={t('conv.deleteAllConfirmDetail')}
          variant="danger"
          confirmLabel={t('conv.delete')}
          onConfirm={deleteAllTarget.projectKey === '__batch__' ? confirmBatchDelete : confirmDeleteAll}
          onCancel={() => setDeleteAllTarget(null)}
        />
      )}

      {/* Conversation Search Panel */}
      <ConversationSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
