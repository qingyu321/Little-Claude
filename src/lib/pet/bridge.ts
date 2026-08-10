/**
 * Pet window IPC bridge (main window side).
 * Thin wrapper over @tauri-apps/api events + window handles, mirroring the
 * tauri-bridge.ts convention (single source of truth for native calls).
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PET_COMMAND_EVENT, PET_STATUS_EVENT } from "./constants";
import type { PetCommand, PetStatusPayload } from "./types";

/** Push an aggregated status snapshot to the pet window. Fails silently when
 *  the pet window isn't around yet (e.g. hidden before first status). */
export async function emitPetStatus(payload: PetStatusPayload): Promise<void> {
  try {
    await emit(PET_STATUS_EVENT, payload);
  } catch {
    // pet window may not exist yet — nothing to surface.
  }
}

/** Subscribe to commands from the pet window. Returns an unlisten function. */
export async function onPetCommand(
  cb: (cmd: PetCommand) => void,
): Promise<UnlistenFn> {
  return listen<PetCommand>(PET_COMMAND_EVENT, (e) => cb(e.payload));
}

async function getPetWindow(): Promise<WebviewWindow | null> {
  return WebviewWindow.getByLabel("pet");
}

export async function showPetWindow(): Promise<void> {
  const pet = await getPetWindow();
  if (!pet) return;
  // No setFocus: window config has focus:false so showing never steals focus
  // from the main window (bad UX at startup / while using settings).
  await pet.show();
}

export async function hidePetWindow(): Promise<void> {
  const pet = await getPetWindow();
  if (!pet) return;
  await pet.hide();
}

export async function focusMainWindow(): Promise<void> {
  const main = await WebviewWindow.getByLabel("main");
  if (!main) return;
  await main.setFocus();
}

/** Pet window → main window: send a user command (focus-main / open-settings / user-hide). */
export async function emitPetCommand(cmd: PetCommand): Promise<void> {
  try {
    await emit(PET_COMMAND_EVENT, cmd);
  } catch {
    // Main window may be gone — nothing to surface.
  }
}

/** Hide the current (pet) window. */
export async function hideCurrentWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}
