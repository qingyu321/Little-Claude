/**
 * System notifications for pet task completion / errors.
 * Pure transition-detection logic (unit-testable) + thin wrappers over the
 * tauri-plugin-notification JS API. The plugin fails silently when the OS
 * refuses (e.g. a portable exe without a registered AUMID on Windows) — all
 * call sites must never throw.
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { t } from "../i18n";
import { NOTIFY_COOLDOWN_MS } from "./constants";
import type { PetAgent, PetPhase } from "./types";

/** Phases considered "in progress": an active → completed/error transition
 *  counts as one "task finished" event (idle → completed doesn't). */
export const ACTIVE_PHASES: ReadonlySet<PetPhase> = new Set([
  "thinking",
  "writing",
  "tool",
  "awaiting",
]);

export interface NotifyLast {
  phase: PetPhase;
  at: number;
}

/** Pure: active → terminal transition + per-agent cooldown throttle. */
export function shouldNotify(
  prevPhase: PetPhase | undefined,
  curPhase: PetPhase,
  last: NotifyLast | null,
  now: number,
  cooldownMs: number = NOTIFY_COOLDOWN_MS,
): boolean {
  if (curPhase !== "completed" && curPhase !== "error") return false;
  if (!prevPhase || !ACTIVE_PHASES.has(prevPhase)) return false;
  if (last && now - last.at < cooldownMs) return false;
  return true;
}

/** First-use permission request; resolves false when unavailable/denied. */
export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Send a system notification; never throws (OS refusal = silent degrade). */
export async function sendPetNotification(title: string, body: string): Promise<void> {
  try {
    await sendNotification({ title, body });
  } catch (err) {
    console.debug("[pet] notification failed:", err);
  }
}

const AGENT_LABEL: Record<PetAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  deepseek: "DeepSeek",
};

/** Localized notification text. Error body may carry a truncated detail. */
export function buildNotifyText(
  kind: "completed" | "error",
  agent: PetAgent,
  detail = "",
): { title: string; body: string } {
  const label = AGENT_LABEL[agent];
  if (kind === "completed") {
    return {
      title: t("pet.notify.completed"),
      body: t("pet.notify.completedBody", { agent: label }),
    };
  }
  const body = t("pet.notify.errorBody", { agent: label });
  const trimmed = detail.trim().slice(0, 120);
  return { title: t("pet.notify.error"), body: trimmed ? `${body}：${trimmed}` : body };
}
