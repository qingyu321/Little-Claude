import { create } from 'zustand';

/**
 * Session todo plan (DSH dsh-tool-todo port) — the model's whole task list,
 * replaced wholesale on each `todo/write` event and cleared at `turn/start`
 * (DSH standing-plan lifetime rule: latest todo/write with no later turn/start).
 *
 * In-memory only: the plan is a live per-session view, replayable from the
 * stream on reconnect; persisting it would show stale steps after restart.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

interface TodoState {
  /** sessionId → current standing plan (ordered as the model wrote it) */
  todos: Record<string, TodoItem[]>;
  /** Replace the whole list (DSH todo/write is whole-list only) */
  update: (sessionId: string, items: TodoItem[]) => void;
  /** Clear on turn/start (new turn → previous plan is no longer standing) */
  clear: (sessionId: string) => void;
  /** Draft-tab promote: move a session's plan under a new id */
  moveSession: (from: string, to: string) => void;
}

export const useTodoStore = create<TodoState>((set) => ({
  todos: {},

  update: (sessionId, items) =>
    set((s) => ({ todos: { ...s.todos, [sessionId]: items } })),

  clear: (sessionId) =>
    set((s) => {
      if (!s.todos[sessionId]) return s;
      const next = { ...s.todos };
      delete next[sessionId];
      return { todos: next };
    }),

  moveSession: (from, to) =>
    set((s) => {
      if (!s.todos[from] || s.todos[to]) return s;
      const next = { ...s.todos };
      next[to] = s.todos[from];
      delete next[from];
      return { todos: next };
    }),
}));
