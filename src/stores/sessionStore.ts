import { create } from 'zustand';
import { bridge, SessionListItem, ContentSearchResult } from '../lib/tauri-bridge';
import { encodeProjectName } from '../lib/platform';

/** Full lifecycle state for the conversation-list status dot. The legacy
 *  runningSessions Set stays as the "is it busy" projection (pet panel,
 *  delete warnings); sessionStatuses carries the complete state so a
 *  finished conversation (text reply end) still shows a dot. */
export type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

// Persist custom session names in localStorage as fast cache,
// and sync to disk via Tauri backend for durability.
const CUSTOM_PREVIEWS_KEY = 'tokenicode_custom_previews';
const LAST_SESSION_KEY = 'tokenicode_last_session';
const STDIN_TO_TAB_KEY = 'tokenicode_stdinToTab';

function loadCustomPreviewsSync(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_PREVIEWS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCustomPreviewsLocal(map: Record<string, string>) {
  localStorage.setItem(CUSTOM_PREVIEWS_KEY, JSON.stringify(map));
}

/** Persist the last active session ID so app restart can auto-restore */
function saveLastSessionId(id: string | null) {
  if (id && !id.startsWith('draft_')) {
    sessionStorage.setItem(LAST_SESSION_KEY, id);
  }
}

function loadLastSessionId(): string | null {
  return sessionStorage.getItem(LAST_SESSION_KEY);
}

/** Persist stdinToTab across page refreshes using sessionStorage.
 *  sessionStorage survives same-window refreshes but clears on app restart,
 *  which is exactly the right scope for process-lifetime mappings. */
function loadStdinToTabSync(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(STDIN_TO_TAB_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveStdinToTab(map: Record<string, string>) {
  sessionStorage.setItem(STDIN_TO_TAB_KEY, JSON.stringify(map));
}

interface SessionState {
  sessions: SessionListItem[];
  isLoading: boolean;
  /** fetchSessions 失败时的原始错误信息（非 null 表示列表加载失败） */
  fetchError: string | null;
  searchQuery: string;
  selectedSessionId: string | null;
  /** Previously selected session ID, for Ctrl+Tab quick switch */
  previousSessionId: string | null;
  /** Custom display names keyed by session ID, persisted to disk */
  customPreviews: Record<string, string>;
  /** Track which sessions are actively running (streaming/working) */
  runningSessions: Set<string>;
  /** Full per-session lifecycle state (running/completed/error/idle) for the
   *  conversation-list status dot — kept in sync with runningSessions. */
  sessionStatuses: Map<string, SessionStatus>;
  /** Map stdinId → tabId so stream events can be routed to the correct session */
  stdinToTab: Record<string, string>;
  /** Content search results keyed by session ID */
  contentSearchResults: Map<string, ContentSearchResult>;
  isContentSearching: boolean;
  contentSearchQuery: string;
  /** U2: non-null when the last content search failed — lets the UI
   *  distinguish 'no results' from 'search failed'. */
  searchError: string | null;

  fetchSessions: () => Promise<void>;
  setSearchQuery: (query: string) => void;
  setSelectedSession: (id: string | null) => void;
  /** Insert a temporary "draft" session at the top of the list */
  addDraftSession: (id: string, projectPath: string) => void;
  /** Update an existing draft session's project path (e.g. after folder selection) */
  updateDraftProject: (id: string, projectPath: string) => void;
  /** Set a custom display name for a session */
  setCustomPreview: (sessionId: string, name: string) => void;
  /** Get the display name for a session (custom > preview > fallback) */
  getDisplayName: (session: SessionListItem) => string;
  /** Mark a session as running (actively streaming/working) */
  setSessionRunning: (sessionId: string, running: boolean) => void;
  /** Record a session's full lifecycle state; keeps runningSessions in sync. */
  setSessionStatus: (sessionId: string, status: SessionStatus) => void;
  /** Check if a session is currently running */
  isSessionRunning: (sessionId: string) => boolean;
  /** Register a stdinId → tabId mapping (persisted to sessionStorage) */
  registerStdinTab: (stdinId: string, tabId: string) => void;
  /** Remove a stdinId mapping on process exit (cleans sessionStorage too) */
  unregisterStdinTab: (stdinId: string) => void;
  /** Look up which tabId owns a given stdinId */
  getTabForStdin: (stdinId: string) => string | undefined;
  /** Remove a draft session from the local list (no disk deletion needed) */
  removeDraft: (draftId: string) => void;
  /** fix17: 会话删除成功后清理残留状态（customPreviews/sessionStatuses/runningSessions） */
  cleanupDeletedSession: (sessionId: string) => void;
  /** Promote a draft session to a real session ID (when CLI returns the actual UUID).
   *  Updates session id, selectedSessionId, stdinToTab mapping, and runningSessions. */
  promoteDraft: (oldDraftId: string, newRealId: string) => void;
  /** Switch to the previously selected session (Ctrl+Tab) */
  switchToPrevious: () => void;
  /** Load custom previews from backend (called once on init) */
  loadCustomPreviewsFromDisk: () => Promise<void>;
  /** Get the last active session ID from localStorage (for app restart recovery) */
  getLastSessionId: () => string | null;
  /** Search session content via backend */
  searchSessionContent: (query: string) => Promise<void>;
  /** Clear content search results */
  clearContentSearch: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  isLoading: false,
  fetchError: null,
  searchQuery: '',
  selectedSessionId: null,
  previousSessionId: null,
  customPreviews: loadCustomPreviewsSync(),
  runningSessions: new Set<string>(),
  sessionStatuses: new Map(),
  stdinToTab: loadStdinToTabSync(),
  contentSearchResults: new Map<string, ContentSearchResult>(),
  isContentSearching: false,
  contentSearchQuery: '',
  searchError: null,

  fetchSessions: async () => {
    const isFirstLoad = get().sessions.length === 0;
    if (isFirstLoad) set({ isLoading: true });
    try {
      // 面试助手生成的 desk_interview_* 会话不进会话列表（临时问答，非用户对话）
      const diskSessions = (await bridge.listSessions()).filter(
        (s) => !s.id.startsWith('desk_interview_'),
      );
      // Preserve draft sessions (path === '') that haven't been written to disk yet
      const drafts = get().sessions.filter(
        (s) => s.path === '' && !diskSessions.some((d) => d.id === s.id),
      );
      set({ sessions: [...drafts, ...diskSessions], isLoading: false, fetchError: null });
    } catch (err) {
      // A6: 静默吞错会让用户看到误导性的空列表 —— 记录错误信息，
      // 由 ConversationList 渲染错误行 + 重试按钮
      set({ isLoading: false, fetchError: String(err) });
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSelectedSession: (id) => {
    saveLastSessionId(id);
    set((state) => ({
      selectedSessionId: id,
      previousSessionId: state.selectedSessionId !== id ? state.selectedSessionId : state.previousSessionId,
    }));
  },

  addDraftSession: (id, projectPath) => set((state) => {
    const projectDir = encodeProjectName(projectPath);
    const draft: SessionListItem = {
      id,
      path: '',
      project: projectPath,
      projectDir,
      modifiedAt: Date.now(),
      preview: '',
    };
    return {
      sessions: [draft, ...state.sessions],
      selectedSessionId: id,
    };
  }),

  updateDraftProject: (id, projectPath) => set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === id
        ? { ...s, project: projectPath, projectDir: encodeProjectName(projectPath), modifiedAt: Date.now() }
        : s,
    ),
  })),

  setCustomPreview: (sessionId, name) => {
    const updated = { ...get().customPreviews, [sessionId]: name };
    saveCustomPreviewsLocal(updated);
    set({ customPreviews: updated });
  },

  getDisplayName: (session) => {
    const custom = get().customPreviews[session.id];
    return custom || session.preview || '';
  },

  setSessionRunning: (sessionId, running) => set((state) => {
    const next = new Set(state.runningSessions);
    if (running) next.add(sessionId);
    else next.delete(sessionId);
    // Legacy boolean path (pet panel / delete flow): a false has no status to
    // report, so drop the full-state entry too rather than guess.
    const statuses = new Map(state.sessionStatuses);
    if (running) statuses.set(sessionId, 'running');
    else statuses.delete(sessionId);
    return { runningSessions: next, sessionStatuses: statuses };
  }),

  setSessionStatus: (sessionId, status) => set((state) => {
    const statuses = new Map(state.sessionStatuses);
    statuses.set(sessionId, status);
    // Keep the legacy busy projection in lockstep (pet panel, delete warnings).
    const next = new Set(state.runningSessions);
    if (status === 'running') next.add(sessionId);
    else next.delete(sessionId);
    return { sessionStatuses: statuses, runningSessions: next };
  }),

  isSessionRunning: (sessionId) => get().runningSessions.has(sessionId),

  registerStdinTab: (stdinId, tabId) => {
    const next = { ...get().stdinToTab, [stdinId]: tabId };
    saveStdinToTab(next);
    set({ stdinToTab: next });
  },

  unregisterStdinTab: (stdinId) => {
    const { [stdinId]: _, ...rest } = get().stdinToTab;
    saveStdinToTab(rest);
    set({ stdinToTab: rest });
  },

  getTabForStdin: (stdinId) => get().stdinToTab[stdinId],

  removeDraft: (draftId) => set((state) => ({
    sessions: state.sessions.filter((s) => s.id !== draftId),
  })),

  // fix17: 删除成功后清理该会话残留的状态条目，防内存/界面泄漏
  cleanupDeletedSession: (sessionId) => {
    // customPreviews 持久化 —— 同步落盘（localStorage）
    const previews = { ...get().customPreviews };
    if (previews[sessionId]) {
      delete previews[sessionId];
      saveCustomPreviewsLocal(previews);
    }
    set((state) => {
      const runningSessions = new Set(state.runningSessions);
      runningSessions.delete(sessionId);
      const sessionStatuses = new Map(state.sessionStatuses);
      sessionStatuses.delete(sessionId);
      const contentSearchResults = new Map(state.contentSearchResults);
      contentSearchResults.delete(sessionId);
      return { customPreviews: previews, runningSessions, sessionStatuses, contentSearchResults };
    });
  },

  promoteDraft: (oldDraftId, newRealId) => {
    saveLastSessionId(newRealId);
    set((state) => {
    // 1) Rename session in the list
    const sessions = state.sessions.map((s) =>
      s.id === oldDraftId ? { ...s, id: newRealId } : s,
    );

    // 2) Update selectedSessionId if it was the draft
    const selectedSessionId = state.selectedSessionId === oldDraftId
      ? newRealId
      : state.selectedSessionId;

    // 3) Migrate runningSessions
    const runningSessions = new Set(state.runningSessions);
    if (runningSessions.has(oldDraftId)) {
      runningSessions.delete(oldDraftId);
      runningSessions.add(newRealId);
    }

    // 3b) Migrate the full lifecycle state alongside the busy flag
    const sessionStatuses = new Map(state.sessionStatuses);
    if (sessionStatuses.has(oldDraftId)) {
      sessionStatuses.set(newRealId, sessionStatuses.get(oldDraftId)!);
      sessionStatuses.delete(oldDraftId);
    }

    // 4) Migrate stdinToTab entries that pointed to oldDraftId
    const stdinToTab = { ...state.stdinToTab };
    for (const [k, v] of Object.entries(stdinToTab)) {
      if (v === oldDraftId) stdinToTab[k] = newRealId;
    }

    // 5) Migrate previousSessionId if it was the draft
    const previousSessionId = state.previousSessionId === oldDraftId
      ? newRealId
      : state.previousSessionId;

    // 6) Migrate customPreviews if the old draft had a custom name
    const customPreviews = { ...state.customPreviews };
    if (customPreviews[oldDraftId]) {
      customPreviews[newRealId] = customPreviews[oldDraftId];
      delete customPreviews[oldDraftId];
      saveCustomPreviewsLocal(customPreviews);
    }

    // 7) B5: content-search results keyed by the old draft id would
    //    otherwise linger as dead data after promotion.
    const contentSearchResults = new Map(state.contentSearchResults);
    if (contentSearchResults.has(oldDraftId)) {
      const v = contentSearchResults.get(oldDraftId)!;
      contentSearchResults.delete(oldDraftId);
      contentSearchResults.set(newRealId, v);
    }

    saveStdinToTab(stdinToTab);
    return { sessions, selectedSessionId, previousSessionId, runningSessions, sessionStatuses, stdinToTab, customPreviews, contentSearchResults };
  });
  },

  switchToPrevious: () => {
    const { previousSessionId, selectedSessionId, sessions } = get();
    if (!previousSessionId || previousSessionId === selectedSessionId) return;
    // Verify the previous session still exists
    const exists = sessions.some((s) => s.id === previousSessionId);
    if (!exists) return;
    set({
      selectedSessionId: previousSessionId,
      previousSessionId: selectedSessionId,
    });
  },

  loadCustomPreviewsFromDisk: async () => {
    // localStorage only — no disk I/O (portable EXE)
    const localPreviews = loadCustomPreviewsSync();
    set({ customPreviews: localPreviews });
  },

  getLastSessionId: () => loadLastSessionId(),

  searchSessionContent: async (query: string, roleFilter?: string | null) => {
    set({ isContentSearching: true, contentSearchQuery: query, searchError: null });
    try {
      const results = await bridge.searchSessions(query, roleFilter);
      // Stale check: discard if query has changed while awaiting
      if (get().contentSearchQuery !== query) return;
      const map = new Map<string, ContentSearchResult>();
      for (const r of results) {
        map.set(r.session_id, r);
      }
      set({ contentSearchResults: map, isContentSearching: false });
    } catch (e) {
      // U2: a failed search used to look identical to an empty result set.
      console.error('[sessionStore] searchSessionContent failed:', e);
      set({ isContentSearching: false, searchError: String(e) });
    }
  },

  clearContentSearch: () => {
    set({
      contentSearchResults: new Map<string, ContentSearchResult>(),
      isContentSearching: false,
      contentSearchQuery: '',
      searchError: null,
    });
  },
}));
