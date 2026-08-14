/**
 * Desktop pet shared types — single source of truth for the pet:status / pet:command
 * event payloads exchanged between the main window (aggregator) and the pet window.
 */

/** Activity phase of a session — mirrors chatStore activityStatus.phase. */
export type PetPhase =
  | "idle"
  | "thinking"
  | "writing"
  | "tool"
  | "awaiting"
  | "error"
  | "completed";

/** Which CLI backend owns a session. */
export type PetAgent = "claude" | "codex" | "deepseek";

/** Aggregated status of one agent (all its sessions merged). */
export interface PetAgentStatus {
  /** Number of active sessions for this agent. */
  active: number;
  /** Highest-priority phase across this agent's sessions. */
  phase: PetPhase;
  /** Tool name when phase === 'tool' / 'awaiting'. */
  toolName?: string;
  /** Detail text (error message etc). */
  statusMessage?: string;
  /** Token usage summed across ALL active sessions of this agent (per-turn). */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** Bubble message content (localized in the main window; pet window renders verbatim). */
export interface PetBubbleMessage {
  /** Monotonic sequence — pet window uses it to detect new bubbles. */
  seq: number;
  /** Timestamp of message generation — pet fades the bubble at ts + ttlMs. */
  ts: number;
  text: string;
  source: PetAgent | null;
  kind: PetPhase;
  ttlMs: number;
  /** Owning tab — dedup identity: two different sessions finishing with the
   *  same text/source/kind must still be distinct reports. */
  tabId?: string;
}

/** Full state snapshot pushed from main window to pet window. */
export interface PetStatusPayload {
  v: 1;
  ts: number;
  /** Total active sessions across all agents. */
  totalActive: number;
  /** Pet display scale (0.5–1.5) — main-window settings, synced to the pet window. */
  scale: number;
  /** Current pet skin id ("default" or an imported pet id). */
  skin: string;
  claude: PetAgentStatus;
  codex: PetAgentStatus;
  /** DeepSeek Harness sessions (dsh backend) — own slot so DSH activity
   *  isn't mislabeled as Claude. */
  deepseek: PetAgentStatus;
  /** Current bubble message, or null when nothing worth showing. */
  message: PetBubbleMessage | null;
}

/** Commands sent from pet window back to the main window. */
export type PetCommand =
  | { type: "focus-main" }
  /** tab: settings tab to open on (e.g. "pet") — optional, keeps old toggle behavior */
  | { type: "open-settings"; tab?: string }
  /** User hid the pet via right-click menu — main window must respect it (don't re-show). */
  | { type: "user-hide" }
  /** Pet window mounted and its status listener is ready — main window re-pushes now. */
  | { type: "request-status" }
  /**
   * Pet clicked with an evolution pair configured — main window switches to the
   * paired skin (pet window plays the FX sequence; the actual swap comes back
   * through pet:status → skin).
   */
  | { type: "toggle-skin" };

/** Localized message templates injected by the main window (via useT / t). */
export interface PetMessageTemplates {
  awaiting: (toolName: string) => string;
  tool: (toolName: string) => string;
  writing: (preview: string) => string;
  thinking: () => string;
  error: (detail: string) => string;
  completed: () => string;
}
