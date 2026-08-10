/**
 * Pure aggregation of session state → pet status payload.
 * Consumes minimal snapshots of chatStore/sessionStore so it stays unit-testable
 * without pulling the stores (or i18n) in.
 */

import { PET_BUBBLE_TTL_COMPLETED_MS, PET_BUBBLE_TTL_MS } from "./constants";
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

const WRITING_PREVIEW_LEN = 60;

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
}

export function computePetStatus(input: PetAggregateInput): PetStatusComputed {
  const claude = emptyAgentStatus();
  const codex = emptyAgentStatus();
  let best: Candidate | null = null;
  let bestTok: {
    agent: PetAgent;
    phase: PetPhase;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  } | null = null;

  for (const [tabId, tab] of input.tabs) {
    const stream = input.streams.get(tabId);
    const active = input.runningSessions.has(tabId) || Boolean(stream?.isStreaming);
    if (!active) continue;

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
    if (phase !== "idle" && (!best || PHASE_PRIORITY[phase] > PHASE_PRIORITY[best.phase])) {
      best = {
        phase,
        toolName: tab.activityStatus?.toolName,
        statusMessage: tab.activityStatus?.statusMessage,
        partialText: stream?.partialText ?? "",
        agent,
      };
    }

    // Token display: use the highest-priority active tab's per-turn usage.
    // Ties keep the first-seen (deterministic since Map iterates in order).
    if (phase !== "idle" && (!bestTok || PHASE_PRIORITY[phase] > PHASE_PRIORITY[bestTok.phase])) {
      bestTok = {
        agent,
        phase,
        input: tab.sessionMeta?.inputTokens ?? 0,
        output: tab.sessionMeta?.outputTokens ?? 0,
        cacheRead: tab.sessionMeta?.cacheReadTokens ?? 0,
        cacheCreation: tab.sessionMeta?.cacheCreationTokens ?? 0,
      };
    }
  }

  // Attach the highest-priority active tab's tokens to the matching agent.
  if (bestTok) {
    const acc = bestTok.agent === "codex" ? codex : claude;
    acc.input = bestTok.input;
    acc.output = bestTok.output;
    acc.cacheRead = bestTok.cacheRead;
    acc.cacheCreation = bestTok.cacheCreation;
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
  const ttlMs =
    best.phase === "completed" ? PET_BUBBLE_TTL_COMPLETED_MS : PET_BUBBLE_TTL_MS;

  let text: string;
  switch (best.phase) {
    case "awaiting":
      text = t.awaiting(best.toolName ?? "");
      break;
    case "tool":
      text = t.tool(best.toolName ?? "");
      break;
    case "writing": {
      const preview = best.partialText.trim();
      if (!preview) return null; // nothing worth previewing yet
      text = t.writing(truncate(preview, WRITING_PREVIEW_LEN));
      break;
    }
    case "thinking":
      text = t.thinking();
      break;
    case "error":
      text = t.error(best.statusMessage ?? "");
      break;
    case "completed":
      text = t.completed();
      break;
    default:
      return null;
  }

  return { ts: now, text, source: best.agent, kind: best.phase, ttlMs };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
