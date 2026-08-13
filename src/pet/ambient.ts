/**
 * Engine-level state ambience — skin-agnostic overlay effects that make the
 * pet's current state visible even when the spritesheet only defines an idle
 * row (imported skins fall back to idle for every other state).
 *
 * Drawn between the pet sprite and the FX hooks, in logical frame units
 * (the engine's setTransform already accounts for dpr × scale).
 */

import type { PetStateKey } from "./petEngine";

export type AmbientKind =
  | "dots" // thinking … (sheet skins)
  | "cursor" // writing — blinking caret
  | "scan" // tool/review — scan line
  | "confetti" // completed — celebration (3s)
  | "tear" // failed — blush + tear (sheet skins)
  | "zzz" // sleeping — floating Z z (sheet skins)
  | "hearts"; // idle — occasional floating heart

export interface AmbientSpec {
  kind: AmbientKind;
  /** Infinity = lasts as long as the state; otherwise ms from state entry. */
  until: number;
}

/** State → ambient on entry (via applyStatus / playAction). */
export const AMBIENT_MAP: Partial<Record<PetStateKey, AmbientSpec>> = {
  waiting: { kind: "dots", until: Infinity },
  running: { kind: "cursor", until: Infinity },
  review: { kind: "scan", until: Infinity },
  // jump is a transient (~780ms); the 3s celebration outlives it via `until`.
  jump: { kind: "confetti", until: 3000 },
  failed: { kind: "tear", until: 3000 },
  sleep: { kind: "zzz", until: Infinity },
};

/**
 * Kinds that animate on wall-clock time and therefore require a redraw every
 * frame while active (the rest are frame-index driven and work fine with the
 * variable-rate renderer).
 */
export const AMBIENT_TIME_DRIVEN: ReadonlySet<AmbientKind> = new Set([
  "confetti",
  "scan",
  "cursor",
  "hearts",
]);

const CONFETTI_COLORS = ["#F97316", "#FBBF24", "#34D399", "#60A5FA", "#F472B6", "#A78BFA"];

/** Active ambient state (engine-owned, survives engine rebuilds via queue). */
export interface AmbientState {
  kind: AmbientKind;
  /** Entry timestamp (ms) — hearts/confetti derive progress from it. */
  start: number;
  /** Expiry timestamp (ms); Infinity = tied to the state. */
  until: number;
}

/**
 * Draw the state ambience above the pet.
 * @param dedupeProcedural true for the procedural default skin — its
 *   poseFor() already draws "···" / "Z z" / tear, so those are skipped to
 *   avoid double-drawing.
 */
export function drawAmbient(
  ctx: CanvasRenderingContext2D,
  ambient: AmbientState,
  _state: PetStateKey,
  frame: number,
  now: number,
  w: number,
  h: number,
  dedupeProcedural: boolean,
): void {
  if (now > ambient.until) return;
  const sf = w / 96;
  switch (ambient.kind) {
    case "dots": {
      if (dedupeProcedural) break;
      const y = h * 0.24;
      const act = Math.floor(frame / 2) % 3;
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = i === act ? "rgba(43,43,43,0.85)" : "rgba(43,43,43,0.22)";
        ctx.beginPath();
        ctx.arc(w / 2 + (i - 1) * 8 * sf, y, 2.2 * sf, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "cursor": {
      if (now % 500 < 250) {
        ctx.strokeStyle = "rgba(43,43,43,0.8)";
        ctx.lineWidth = 2 * sf;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(w * 0.62, h * 0.24);
        ctx.lineTo(w * 0.62, h * 0.24 + 10 * sf);
        ctx.stroke();
      }
      break;
    }
    case "scan": {
      const prog = (now / 1200) % 1;
      const y = h * 0.12 + prog * h * 0.68;
      for (let i = 2; i >= 0; i--) {
        const yy = y - i * 12 * sf;
        ctx.fillStyle = `rgba(96, 165, 250, ${0.3 - i * 0.08})`;
        ctx.fillRect(w * 0.08, yy, w * 0.84, 4 * sf);
      }
      break;
    }
    case "confetti": {
      // Deterministic pseudo-random particles: each has its own duration +
      // phase derived from its index, so the rain looks organic but stable.
      const N = 26;
      for (let i = 0; i < N; i++) {
        const seed = (i * 2654435761) >>> 0;
        const dur = 1600 + (seed % 1500);
        const prog = ((now / dur) + (seed % 1000) / 1000) % 1;
        const xBase = (((seed >>> 5) % 1000) / 1000) * w;
        const x = (xBase + Math.sin(now / 400 + i) * 10 * sf) % w;
        const y = prog * h * 0.72;
        ctx.fillStyle = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        ctx.globalAlpha = 1 - prog * 0.8;
        ctx.fillRect(x, y, 2.4 * sf, 6 * sf);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case "tear": {
      if (dedupeProcedural) break;
      const cheekY = h * 0.44;
      ctx.fillStyle = "rgba(242, 169, 162, 0.5)";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(w / 2 + side * w * 0.16, cheekY, 5 * sf, 3.4 * sf, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const pulse = 0.55 + Math.sin(now / 300) * 0.25;
      ctx.fillStyle = `rgba(127, 184, 232, ${pulse})`;
      ctx.beginPath();
      ctx.arc(w / 2 - w * 0.16, cheekY + 8 * sf, 2.6 * sf, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "zzz": {
      if (dedupeProcedural) break;
      const bob = Math.sin((frame / 6) * Math.PI * 2) * 2;
      ctx.fillStyle = "rgba(43,43,43,0.7)";
      ctx.font = `${12 * sf}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("Z", w * 0.66, h * 0.28 + bob * sf);
      ctx.fillText("z", w * 0.74, h * 0.36 + bob * sf);
      ctx.textAlign = "left";
      break;
    }
    case "hearts": {
      const el = (now - ambient.start) / 1200;
      if (el < 0 || el > 1) break;
      const x = w / 2 + Math.sin(now / 300) * 14 * sf + el * 10 * sf;
      const y = h * 0.34 - el * 34 * sf;
      ctx.globalAlpha = 1 - el;
      ctx.fillStyle = "#F472B6";
      ctx.font = `${11 * sf}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("♥", x, y);
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
      break;
    }
  }
}
