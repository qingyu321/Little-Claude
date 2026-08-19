import { create } from 'zustand';

/**
 * Per-tab token generation speed tracking (tok/s) for the live speed badge
 * above the input bar.
 *
 * Pure side-channel: never touches chatStore or the message stream. Each tab
 * keeps its own sliding window of token events. pushTokens() is call-heavy
 * (every text_delta) so it only mutates the non-reactive window data and never
 * triggers a re-render; tick() — driven by the badge UI every 500ms — is the
 * only path that commits to zustand state.
 */

interface TokenSample {
  t: number; // timestamp (performance.now)
  n: number; // tokens in this delta
}

interface TabSpeedData {
  /** Sliding window samples (non-reactive, mutated in place) */
  samples: TokenSample[];
  /** EMA-smoothed instant speed in tokens/sec (reactive) */
  speed: number;
  /** Tokens accumulated this turn (for the turn average) */
  turnTokens: number;
  /** Timestamp of this turn's first token */
  turnStartAt: number;
  /** Turn-average speed in tokens/sec (reactive, recomputed on tick) — client estimate */
  avg: number;
  /**
   * API-authoritative average in tokens/sec from the `result` event: output
   * tokens (Σ modelUsage, fallback usage.output_tokens) ÷ duration_api_ms
   * (pure API time — local tool waits excluded; fallback duration_ms).
   * Pinned by end(); 0 until/unless the API reports usable data.
   */
  apiAvg: number;
  /**
   * Bottom-layer DSH truth (sessionStats deltas carried on the DSH `result`):
   * average first-token latency over the turn's steps, in ms. Present only
   * for DeepSeek turns — DSH's own number, not a client-side estimate.
   */
  firstTokenAvgMs?: number;
  /** Steps in the turn that carried a recorded first token (DSH truth). */
  firstTokenSteps: number;
  /** Decode throughput in tok/s (DSH truth: Δ output tokens ÷ Δ decode time). */
  decodeTps?: number;
  isStreaming: boolean;
  /** Timestamp when streaming ended — badge lingers to show the final average */
  endedAt?: number;
}

interface TokenSpeedState {
  tabs: Record<string, TabSpeedData>;
  /** Record generated tokens for a tab — auto-starts the window on first token */
  pushTokens: (tabId: string, n: number, now?: number) => void;
  /** Recompute smoothed speed from the sliding window (badge UI drives this) */
  tick: (tabId: string, now?: number) => void;
  /** Streaming finished — pin the final average on the badge. Pass the result
   *  event's usage to pin the API-authoritative average instead of the estimate.
   *  For DeepSeek turns also pass the bottom-layer first-token / decode truth. */
  end: (tabId: string, api?: {
    outputTokens: number;
    durationMs: number;
    firstTokenAvgMs?: number;
    firstTokenSteps?: number;
    decodeTps?: number;
  }) => void;
  /** New turn begins (message_start) — clear the pinned average, start fresh */
  reset: (tabId: string) => void;
}

const WINDOW_MS = 3000; // sliding window
const EMA_ALPHA = 0.35; // smoothing factor for the displayed speed
const DECAY = 0.7;      // per-tick speed decay when no new tokens arrive
/**
 * Lazy GC bound for `tabs`. Tab records are never removed explicitly (session
 * cleanup lives in chatStore/sessionStore), so a long-running app with many
 * drafts and deleted sessions would otherwise grow `tabs` without bound. Every
 * end() trims the map back to this many entries — non-draft records are dropped
 * only when already ended (isStreaming=false), so live sessions and the just-
 * finished one are never evicted.
 */
const MAX_TAB_RECORDS = 100;

function emptyTab(): TabSpeedData {
  return {
    samples: [],
    speed: 0,
    turnTokens: 0,
    turnStartAt: 0,
    avg: 0,
    apiAvg: 0,
    firstTokenAvgMs: undefined,
    firstTokenSteps: 0,
    decodeTps: undefined,
    isStreaming: false,
  };
}

/**
 * Rough token estimate from text length — used when the stream carries no
 * token counts (provider proxy / Codex backends). ~4 ASCII chars or ~1.5 CJK
 * chars per token, per Anthropic's tokenizer behavior.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x2e7f) cjk++;
    else ascii++;
  }
  return Math.max(1, Math.round(ascii / 4 + cjk / 1.5));
}

export const useTokenSpeedStore = create<TokenSpeedState>((set, get) => ({
  tabs: {},

  pushTokens: (tabId, n, now = performance.now()) => {
    if (!tabId || n <= 0) return;
    const tab = get().tabs[tabId];
    // Auto-start on first token of a turn — no explicit start() wiring needed.
    if (!tab || !tab.isStreaming) {
      const fresh = emptyTab();
      fresh.isStreaming = true;
      fresh.turnStartAt = now;
      fresh.turnTokens = n;
      fresh.samples.push({ t: now, n });
      set((s) => ({ tabs: { ...s.tabs, [tabId]: fresh } }));
      return;
    }
    tab.turnTokens += n;
    tab.samples.push({ t: now, n });
    // Prune samples older than the window
    if (tab.samples.length > 1) {
      const cutoff = now - WINDOW_MS;
      let i = 0;
      while (i < tab.samples.length && tab.samples[i].t < cutoff) i++;
      if (i > 0) tab.samples.splice(0, i);
    }
    // No set() — high-frequency path stays render-free.
  },

  tick: (tabId, now = performance.now()) => {
    if (!tabId) return;
    const tab = get().tabs[tabId];
    if (!tab || !tab.isStreaming) return;

    const samples = tab.samples;
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < samples.length && samples[i].t < cutoff) i++;
    if (i > 0) samples.splice(0, i);

    // Instant rate over the window; require ≥2 samples so a single burst
    // doesn't spike the display.
    let inst = 0;
    if (samples.length >= 2) {
      const dt = (samples[samples.length - 1].t - samples[0].t) / 1000;
      if (dt > 0.05) {
        let total = 0;
        for (const s of samples) total += s.n;
        inst = total / dt;
      }
    }
    const smoothed = inst === 0
      ? tab.speed * DECAY
      : tab.speed === 0
        ? inst   // cold start: first value = true instant rate, no attenuation
        : tab.speed * (1 - EMA_ALPHA) + inst * EMA_ALPHA;
    const rounded = Math.round(smoothed * 10) / 10;
    // Turn average: tokens / elapsed since first token of the turn.
    const avg = tab.turnStartAt > 0
      ? Math.round((tab.turnTokens / ((now - tab.turnStartAt) / 1000)) * 10) / 10
      : 0;
    if (rounded !== tab.speed || avg !== tab.avg) {
      set((s) => ({
        tabs: { ...s.tabs, [tabId]: { ...tab, speed: rounded, avg } },
      }));
    }
  },

  end: (tabId, api) => {
    if (!tabId) return;
    let tab = get().tabs[tabId];
    // DSH bottom-layer truth (first-token / decode deltas on the result) can
    // arrive for turns that never streamed a text delta into pushTokens (e.g.
    // very fast turns, or a channel blip) — create a record so the badge can
    // still pin the real numbers instead of vanishing.
    if (!tab) {
      const hasTruth = api?.firstTokenAvgMs != null || api?.decodeTps != null || (api?.outputTokens ?? 0) > 0;
      if (!hasTruth) return;
      tab = emptyTab();
    }
    // Prefer the API's own accounting — output tokens over pure API time
    // (duration_api_ms, excludes local tool execution / permission waits)
    // from the result event. Falls back to the client estimate when the
    // event carries no usable usage data.
    //
    // Skip pinning when this turn streamed zero tokens: /compact summary
    // requests output thousands of tokens in 1-3s (tiny input, no tools)
    // — the streamed deltas are excluded by the caller (compactInFlight),
    // so turnTokens stays 0 and the API average would read 1000+ tok/s of
    // "compression speed", not generation speed.
    let apiAvg = 0;
    if (api && api.outputTokens > 0 && api.durationMs > 0 && tab.turnTokens > 0) {
      apiAvg = Math.round((api.outputTokens / (api.durationMs / 1000)) * 10) / 10;
    }
    set((s) => {
      const next = {
        ...s.tabs,
        // B4: use performance.now() like every other timestamp in this store.
        // The GC sort compares `endedAt ?? turnStartAt` across records — mixing
        // Date.now() epoch (~1.7e12) with performance.now() (~1e6) made the
        // ordering meaningless (ended records sorted after live ones, so the
        // wrong tabs got evicted and live streaming tabs could be dropped).
        [tabId]: {
          ...tab,
          isStreaming: false,
          endedAt: performance.now(),
          apiAvg,
          // Bottom-layer DSH truth (undefined for claude/codex turns).
          firstTokenAvgMs: api?.firstTokenAvgMs,
          firstTokenSteps: api?.firstTokenSteps ?? 0,
          decodeTps: api?.decodeTps,
        },
      };
      // Lazy GC: prune only when over the bound. Eviction pool = draft_ tabs
      // (ephemeral tabs that are discarded wholesale) + already-ended records;
      // oldest endedAt/turnStartAt first. The just-ended tab and any live
      // (streaming) non-draft tabs are never evicted.
      const keys = Object.keys(next);
      if (keys.length > MAX_TAB_RECORDS) {
        const evictable = keys.filter((k) => {
          if (k === tabId) return false;
          const d = next[k];
          return k.startsWith('draft_') || (d && !d.isStreaming);
        });
        evictable.sort((a, b) => {
          const at = next[a].endedAt ?? next[a].turnStartAt ?? 0;
          const bt = next[b].endedAt ?? next[b].turnStartAt ?? 0;
          return at - bt;
        });
        let excess = keys.length - MAX_TAB_RECORDS;
        for (const k of evictable) {
          if (excess <= 0) break;
          delete next[k];
          excess--;
        }
      }
      return { tabs: next };
    });
  },

  reset: (tabId) => {
    if (!tabId) return;
    set((s) => ({ tabs: { ...s.tabs, [tabId]: emptyTab() } }));
  },
}));
