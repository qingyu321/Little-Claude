/** Desktop pet event channels + shared tuning constants. */

/** Main window → pet window: aggregated session status. */
export const PET_STATUS_EVENT = "pet:status";

/** Pet window → main window: user commands (focus main, open settings…). */
export const PET_COMMAND_EVENT = "pet:command";

/** Trailing throttle for store → payload aggregation (ms). */
export const PET_THROTTLE_MS = 200;

/** localStorage key for the pet window position (physical px + scale factor). */
export const PET_POSITION_KEY = "tokenicode_pet_window_v1";

/** Fallback window size when no saved position exists. */
export const PET_DEFAULT_SIZE = { width: 240, height: 320 };

/** Keep the pet fully visible: margin from monitor edges (physical px). */
export const PET_EDGE_MARGIN = 8;

/** Bubble TTL for short-lived states (ms). */
export const PET_BUBBLE_TTL_MS = 5000;
export const PET_BUBBLE_TTL_COMPLETED_MS = 3000;

/** Idle (no state change) duration before the pet falls asleep (ms). */
export const PET_SLEEP_AFTER_MS = 60_000;

/**
 * Evolution pairs: skin id → the skin it transforms into when clicked.
 * Used by both windows — the pet window plays the FX sequence (golden tassel
 * aura + flash) and the main window performs the actual settings skin swap.
 * Keys must match imported pet bundle ids (pet.json `name` slug).
 */
export const EVOLUTION_PAIRS: Record<string, string> = {
  miaomiao: "wudoukumao", // 喵喵 → 武斗酷猫
  wudoukumao: "miaomiao", // 武斗酷猫 → 喵喵（退化）
};

/**
 * Forward evolution edges (as opposed to reversing). Skins listed here
 * trigger the gold-aura evolve sequence; the reverse direction plays
 * roar + green-flash de-evolve.
 */
export const EVOLUTION_FORWARD: Record<string, string> = {
  miaomiao: "wudoukumao",
};
