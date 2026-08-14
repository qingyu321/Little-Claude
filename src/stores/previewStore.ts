import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** L2: cap persisted preview history — unbounded growth wrote the whole
 *  array to localStorage on every navigation. */
const HISTORY_LIMIT = 50;

export type PreviewCommand =
  | { type: 'open'; url: string }
  | { type: 'refresh' }
  | { type: 'back' }
  | { type: 'forward' };

interface PreviewState {
  url: string;
  history: string[];
  historyIndex: number;
  reloadToken: number;
  lastSnapshot: PreviewSnapshot | null;

  openUrl: (url: string) => void;
  refresh: () => void;
  back: () => void;
  forward: () => void;
  setSnapshot: (snapshot: PreviewSnapshot) => void;
}

export interface PreviewSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  viewport: {
    width: number;
    height: number;
  };
  readableText?: string;
  note?: string;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Only http/https may be previewed. file:/data:/about: URLs are rejected:
  // combined with a sandboxed iframe they could load local files or embed
  // attacker-controlled content into the WebView.
  if (/^(https?:)/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

/** True when a URL (possibly from persisted history) is safe to load in the preview iframe. */
export function isSafePreviewUrl(url: string): boolean {
  return /^(https?:)/i.test(url) || url === 'about:blank';
}

export const usePreviewStore = create<PreviewState>()(
  persist(
    (set, get) => ({
      url: 'about:blank',
      history: [],
      historyIndex: -1,
      reloadToken: 0,
      lastSnapshot: null,

      openUrl: (input) => {
        const url = normalizeUrl(input);
        if (!url) return;
        const state = get();
        const base = state.history.slice(0, state.historyIndex + 1);
        let history = base[base.length - 1] === url ? base : [...base, url];
        if (history.length > HISTORY_LIMIT) {
          history = history.slice(history.length - HISTORY_LIMIT);
        }
        set({
          url,
          history,
          historyIndex: history.length - 1,
          reloadToken: state.reloadToken + 1,
        });
      },

      refresh: () => set((state) => ({ reloadToken: state.reloadToken + 1 })),

      back: () => {
        const state = get();
        if (state.historyIndex <= 0) return;
        const historyIndex = state.historyIndex - 1;
        set({
          historyIndex,
          url: state.history[historyIndex],
          reloadToken: state.reloadToken + 1,
        });
      },

      forward: () => {
        const state = get();
        if (state.historyIndex >= state.history.length - 1) return;
        const historyIndex = state.historyIndex + 1;
        set({
          historyIndex,
          url: state.history[historyIndex],
          reloadToken: state.reloadToken + 1,
        });
      },

      setSnapshot: (snapshot) => set({ lastSnapshot: snapshot }),
    }),
    {
      name: 'tokenicode-preview-store-v1',
      partialize: (state) => ({
        url: state.url,
        history: state.history,
        historyIndex: state.historyIndex,
        lastSnapshot: state.lastSnapshot,
      }),
    },
  ),
);
