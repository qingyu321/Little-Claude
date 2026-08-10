/**
 * Pet window position persistence + monitor clamping (pure, unit-testable).
 * The pet window writes localStorage directly (same WebView2 profile + origin
 * as the main window), so no IPC is needed for position memory.
 */

import { PET_EDGE_MARGIN, PET_POSITION_KEY } from "./constants";

export interface PetPosition {
  /** Physical pixels (Tauri window coordinates). */
  x: number;
  y: number;
  /** Display scale factor at save time — for DPI-aware restore. */
  scaleFactor: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Physical-pixel monitor rect (Tauri currentMonitor() shape). */
export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function loadPetPosition(): PetPosition | null {
  try {
    const raw = localStorage.getItem(PET_POSITION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PetPosition>;
    if (
      typeof p.x !== "number" ||
      typeof p.y !== "number" ||
      typeof p.scaleFactor !== "number"
    ) {
      return null;
    }
    return { x: p.x, y: p.y, scaleFactor: p.scaleFactor };
  } catch {
    return null;
  }
}

export function savePetPosition(x: number, y: number, scaleFactor: number): void {
  try {
    const value: PetPosition = { x, y, scaleFactor };
    localStorage.setItem(PET_POSITION_KEY, JSON.stringify(value));
  } catch {
    // localStorage unavailable (private mode etc) — position memory is best-effort.
  }
}

/**
 * Clamp a window position so the pet stays fully visible on the monitor
 * (with a small edge margin). Returns the clamped position in physical px.
 */
export function clampToMonitor(
  pos: { x: number; y: number },
  win: Size,
  monitor: MonitorRect,
): { x: number; y: number } {
  const minX = monitor.x + PET_EDGE_MARGIN;
  const minY = monitor.y + PET_EDGE_MARGIN;
  const maxX = monitor.x + monitor.width - win.width - PET_EDGE_MARGIN;
  const maxY = monitor.y + monitor.height - win.height - PET_EDGE_MARGIN;
  return {
    x: Math.min(Math.max(pos.x, minX), Math.max(maxX, minX)),
    y: Math.min(Math.max(pos.y, minY), Math.max(maxY, minY)),
  };
}
