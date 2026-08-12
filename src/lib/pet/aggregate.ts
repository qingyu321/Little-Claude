/**
 * Pure aggregation of session state → pet status payload.
 * Consumes minimal snapshots of chatStore/sessionStore so it stays unit-testable
 * without pulling the stores (or i18n) in.
 */

import { PET_BUBBLE_TTL_COMPLETED_MS } from "./constants";
import type {
  PetAgent,
  PetAgentStatus,
  PetBubbleMessage,
  PetMessageTemplates,
  PetPhase,
} from "./types";

/** Higher wins when merging phases across sessions of the same agent. */
export const PHASE_PRIORITY: Record<PetPhase, number> = {
  awaiting: 10,
  writing: 9,
  tool: 8,
  thinking: 7,
  error: 6,
  completed: 5,
  idle: 1,
};

/** Structural subset of chatStore.TabSession — no store import needed. */
export interface PetTabLike {
  sessionStatus: string;
  activityStatus: { phase: PetPhase; toolName?: string; statusMessage?: string };
  sessionMeta: {
    snapshotCliBackend?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

export interface PetAggregateInput {
  tabs: ReadonlyMap<string, PetTabLike>;
  streams: ReadonlyMap<string, { partialText: string; isStreaming: boolean }>;
  runningSessions: ReadonlySet<string>;
  defaultBackend: PetAgent;
  templates: PetMessageTemplates;
  /** Clock injection for deterministic tests. */
  now: number;
}

/** Bubble content without the sequence number — the hook assigns seq. */
export type PetBubbleContent = Omit<PetBubbleMessage, "seq"> | null;

export interface PetStatusComputed {
  ts: number;
  totalActive: number;
  claude: PetAgentStatus;
  codex: PetAgentStatus;
  message: PetBubbleContent;
}

function emptyAgentStatus(): PetAgentStatus {
  return { active: 0, phase: "idle" };
}

/**
 * Merge one active tab into the per-agent accumulator.
 * Returns the candidate (tab-level info) if it beats the current best bubble candidate.
 */
interface Candidate {
  phase: PetPhase;
  toolName?: string;
  statusMessage?: string;
  partialText: string;
  agent: PetAgent;
  /** Owning tab — the main window keys bubble identity on it so two sessions
   *  finishing back-to-back produce distinct reports instead of deduping. */
  tabId: string;
}

export function computePetStatus(input: PetAggregateInput): PetStatusComputed {
  const claude = emptyAgentStatus();
  const codex = emptyAgentStatus();
  let best: Candidate | null = null;

  for (const [tabId, tab] of input.tabs) {
    const stream = input.streams.get(tabId);
    const active = input.runningSessions.has(tabId) || Boolean(stream?.isStreaming);

    // Completion/error REPORT: the session already left the active set (the
    // 200ms aggregation cycle after exit), so it can never win the bubble
    // candidate via the active branch below — the report would be invisible.
    // Surface it here while the tab still carries the terminal status.
    // NOTE: live phases (thinking/tool/writing/awaiting) intentionally do NOT
    // produce bubbles anymore — they flicker by faster than anyone can read
    // them. The pet reports completion only (see buildBubbleContent).
    if (!active) {
      const ph: PetPhase =
        tab.sessionStatus === "error"
          ? "error"
          : tab.sessionStatus === "completed"
            ? "completed"
            : "idle";
      // `>=` (not `>`) on equal priority: with persistent reports the FIRST
      // finished session must not own the bubble forever — a later-finished
      // task replaces an older one at the same priority. tabs iterates in
      // insertion order, so later completions naturally come later.
      if (ph !== "idle" && (!best || PHASE_PRIORITY[ph] >= PHASE_PRIORITY[best.phase])) {
        // Same agent attribution as the active branch — a codex session's
        // report must show the codex dot, not the default backend's.
        const rawBackend = tab.sessionMeta?.snapshotCliBackend;
        const agent: PetAgent =
          rawBackend === "claude" || rawBackend === "codex" ? rawBackend : input.defaultBackend;
        best = {
          phase: ph,
          toolName: undefined,
          statusMessage: tab.activityStatus?.statusMessage,
          partialText: "",
          agent,
          tabId,
        };
      }
      continue;
    }

    const phase: PetPhase = tab.activityStatus?.phase ?? "idle";
    const rawBackend = tab.sessionMeta?.snapshotCliBackend;
    const agent: PetAgent =
      rawBackend === "claude" || rawBackend === "codex" ? rawBackend : input.defaultBackend;

    const acc = agent === "codex" ? codex : claude;
    acc.active += 1;
    if (PHASE_PRIORITY[phase] > PHASE_PRIORITY[acc.phase]) {
      acc.phase = phase;
      acc.toolName = tab.activityStatus?.toolName;
      acc.statusMessage = tab.activityStatus?.statusMessage;
    }

    // Bubble candidate: track the single highest-priority active tab overall.
    // `>=` on equal priority: with persistent reports a later-finished task
    // must supersede an earlier one (see the terminal branch above).
    if (phase !== "idle" && (!best || PHASE_PRIORITY[phase] >= PHASE_PRIORITY[best.phase])) {
      best = {
        phase,
        toolName: tab.activityStatus?.toolName,
        statusMessage: tab.activityStatus?.statusMessage,
        partialText: stream?.partialText ?? "",
        agent,
        tabId,
      };
    }

    // Token display: SUM every active tab's per-turn usage per agent — the
    // pet shows the total tokens burned across ALL running tasks of that
    // backend, not just the highest-priority tab's.
    if (phase !== "idle") {
      const acc = agent === "codex" ? codex : claude;
      acc.input = (acc.input ?? 0) + (tab.sessionMeta?.inputTokens ?? 0);
      acc.output = (acc.output ?? 0) + (tab.sessionMeta?.outputTokens ?? 0);
      acc.cacheRead = (acc.cacheRead ?? 0) + (tab.sessionMeta?.cacheReadTokens ?? 0);
      acc.cacheCreation = (acc.cacheCreation ?? 0) + (tab.sessionMeta?.cacheCreationTokens ?? 0);
    }
  }

  return {
    ts: input.now,
    totalActive: claude.active + codex.active,
    claude,
    codex,
    message: buildBubbleContent(best, input.templates, input.now),
  };
}

function buildBubbleContent(
  best: Candidate | null,
  t: PetMessageTemplates,
  now: number,
): PetBubbleContent {
  if (!best) return null;
  // Only terminal phases produce a bubble — live-phase bubbles (thinking /
  // tool / writing / awaiting) flashed by faster than they could be read and
  // just added noise on top of the badge + pet animation. The pet reports
  // the outcome, not the play-by-play.
  if (best.phase !== "completed" && best.phase !== "error") return null;

  const ttlMs = PET_BUBBLE_TTL_COMPLETED_MS;
  const text =
    best.phase === "error" ? t.error(best.statusMessage ?? "") : t.completed();

  return { ts: now, text, source: best.agent, kind: best.phase, ttlMs, tabId: best.tabId };
}
