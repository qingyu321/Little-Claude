import { create } from 'zustand';

/**
 * Message feedback (DSH ui-message-feedback port) — per-message rating +
 * optional note, persisted to localStorage (mirrored to disk by the existing
 * localStorage disk-persistence layer). Keyed by message id, which survives
 * session reloads (session-loader preserves uuid).
 */
export interface FeedbackItem {
  rating: 'positive' | 'negative';
  note?: string;
}

interface FeedbackState {
  /** sessionId → messageId → item */
  items: Record<string, Record<string, FeedbackItem>>;
  setRating: (sessionId: string, messageId: string, rating: 'positive' | 'negative') => void;
  clearRating: (sessionId: string, messageId: string) => void;
  setNote: (sessionId: string, messageId: string, note: string) => void;
  /** Draft-tab promote: move a session's feedback under a new id */
  moveSession: (from: string, to: string) => void;
}

const STORAGE_KEY = 'tokenicode_feedback_v1';

function loadItems(): Record<string, Record<string, FeedbackItem>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Record<string, FeedbackItem>>) : {};
  } catch (e) {
    console.warn('[feedbackStore] load failed:', e);
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(items: Record<string, Record<string, FeedbackItem>>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      console.warn('[feedbackStore] save failed:', e);
    }
  }, 300);
}

export const useFeedbackStore = create<FeedbackState>((set, get) => ({
  items: loadItems(),

  setRating: (sessionId, messageId, rating) => {
    const items = { ...get().items };
    const session = { ...(items[sessionId] ?? {}) };
    const prev = session[messageId];
    // DSH toggle semantics: same rating again clears it — including any
    // attached note (the old code kept `{rating, note}` which was a no-op:
    // rating unchanged, button stayed highlighted, click did nothing).
    if (prev?.rating === rating) {
      delete session[messageId];
    } else {
      session[messageId] = { rating, note: prev?.note };
    }
    if (Object.keys(session).length === 0) delete items[sessionId];
    else items[sessionId] = session;
    set({ items });
    scheduleSave(items);
  },

  clearRating: (sessionId, messageId) => {
    const items = { ...get().items };
    const session = { ...(items[sessionId] ?? {}) };
    delete session[messageId];
    if (Object.keys(session).length === 0) delete items[sessionId];
    else items[sessionId] = session;
    set({ items });
    scheduleSave(items);
  },

  setNote: (sessionId, messageId, note) => {
    const items = { ...get().items };
    const session = { ...(items[sessionId] ?? {}) };
    const prev = session[messageId];
    if (!prev) return; // note requires a rating first (DSH semantics)
    const trimmed = note.trim();
    if (trimmed) session[messageId] = { ...prev, note: trimmed };
    else session[messageId] = { rating: prev.rating }; // empty note = clear
    items[sessionId] = session;
    set({ items });
    scheduleSave(items);
  },

  moveSession: (from, to) => {
    const items = { ...get().items };
    if (!items[from] || items[to]) return;
    items[to] = items[from];
    delete items[from];
    set({ items });
    scheduleSave(items);
  },
}));
