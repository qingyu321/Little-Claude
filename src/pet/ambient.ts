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
      // 白色圆点 + 深描边，浮在头顶上方留白区（深色身体上不淡化）
      const y = h * 0.12;
      const act = Math.floor(frame / 2) % 3;
      for (let i = 0; i < 3; i++) {
        const on = i === act;
        ctx.fillStyle = on ? "#fff" : "rgba(255,255,255,0.4)";
        ctx.strokeStyle = "rgba(15,30,60,0.85)";
        ctx.lineWidth = 1.2 * sf;
        ctx.beginPath();
        ctx.arc(w / 2 + (i - 1) * 8 * sf, y, 2.6 * sf, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
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
      // 单条扫描光带（细亮线 + 柔光晕），语义清晰
      const prog = (now / 1200) % 1;
      const y = h * 0.08 + prog * h * 0.6;
      ctx.fillStyle = "rgba(96, 165, 250, 0.16)";
      ctx.fillRect(w * 0.08, y - 14 * sf, w * 0.84, 28 * sf);
      ctx.fillStyle = "rgba(191, 219, 254, 0.95)";
      ctx.fillRect(w * 0.08, y - 0.8 * sf, w * 0.84, 1.6 * sf);
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
      // 白色描边 Z z，浮在右上角头顶留白区（深色身体上不淡化）
      const bob = Math.sin((frame / 6) * Math.PI * 2) * 2;
      ctx.font = `bold ${12 * sf}px sans-serif`;
      ctx.textAlign = "center";
      ctx.lineWidth = 2.5 * sf;
      ctx.strokeStyle = "rgba(15,30,60,0.9)";
      ctx.fillStyle = "#fff";
      ctx.strokeText("Z", w * 0.74, h * 0.09 + bob * sf);
      ctx.fillText("Z", w * 0.74, h * 0.09 + bob * sf);
      ctx.strokeText("z", w * 0.84, h * 0.16 + bob * sf);
      ctx.fillText("z", w * 0.84, h * 0.16 + bob * sf);
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
