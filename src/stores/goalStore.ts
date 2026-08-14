import { create } from 'zustand';

/**
 * Session goal (DSH ui-goal / dsh-goal port) — one editable objective per
 * session with pause/resume/clear, persisted to localStorage. Auto-seeded
 * from the session's first user message.
 */
export interface SessionGoal {
  objective: string;
  paused: boolean;
  updatedAt: number;
}

interface GoalState {
  goals: Record<string, SessionGoal>;
  /** Auto-seed only once per session — from the first user message */
  seedGoal: (sessionId: string, text: string) => void;
  setGoal: (sessionId: string, objective: string) => void;
  togglePause: (sessionId: string) => void;
  clearGoal: (sessionId: string) => void;
  /** Draft-tab promote: move a session's goal under a new id (preserves paused) */
  moveSession: (from: string, to: string) => void;
}

const STORAGE_KEY = 'tokenicode_goals_v1';
const MAX_SEED_CHARS = 80;

function loadGoals(): Record<string, SessionGoal> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, SessionGoal>) : {};
  } catch {
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(goals: Record<string, SessionGoal>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(goals));
    } catch (e) {
      console.warn('[goalStore] save failed:', e);
    }
  }, 300);
}

export const useGoalStore = create<GoalState>((set, get) => ({
  goals: loadGoals(),

  seedGoal: (sessionId, text) => {
    const goals = get().goals;
    if (goals[sessionId]) return; // seeded already
    const objective = text.replace(/\s+/g, ' ').trim().slice(0, MAX_SEED_CHARS);
    if (!objective) return;
    const next = { ...goals, [sessionId]: { objective, paused: false, updatedAt: Date.now() } };
    set({ goals: next });
    scheduleSave(next);
  },

  setGoal: (sessionId, objective) => {
    const next = {
      ...get().goals,
      [sessionId]: {
        objective: objective.trim().slice(0, 200),
        paused: get().goals[sessionId]?.paused ?? false,
        updatedAt: Date.now(),
      },
    };
    set({ goals: next });
    scheduleSave(next);
  },

  togglePause: (sessionId) => {
    const g = get().goals[sessionId];
    if (!g) return;
    const next = {
      ...get().goals,
      [sessionId]: { ...g, paused: !g.paused, updatedAt: Date.now() },
    };
    set({ goals: next });
    scheduleSave(next);
  },

  clearGoal: (sessionId) => {
    const next = { ...get().goals };
    delete next[sessionId];
    set({ goals: next });
    scheduleSave(next);
  },

  moveSession: (from, to) => {
    const goals = get().goals;
    if (!goals[from] || goals[to]) return;
    const next = { ...goals };
    next[to] = goals[from];
    delete next[from];
    set({ goals: next });
    scheduleSave(next);
  },
}));
