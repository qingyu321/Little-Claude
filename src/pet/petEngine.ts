/**
 * Desktop pet animation engine — pure state machine + frame stepping + canvas render.
 *
 * Split into pure functions (resolvePetState / stepFrame — unit-testable without
 * DOM) and a DOM-touching engine class that owns the rAF loop.
 *
 * Rendering: if a real spritesheet image is loaded it draws the atlas frame;
 * otherwise it falls back to a procedural canvas pet (license-safe default).
 */

import { PHASE_PRIORITY } from "../lib/pet/aggregate";
import type { PetStatusPayload } from "../lib/pet/types";
import { drawProceduralPet } from "./procedural";

/** Sprite rows of a Codex-style spritesheet (8×9 grid) + a procedural sleep row. */
export type PetStateKey =
  | "idle"
  | "run"
  | "wave"
  | "jump"
  | "failed"
  | "waiting"
  | "running"
  | "review"
  | "sleep";

export interface PetStateCfg {
  row: number;
  frames: number;
  /** ms per frame. */
  duration: number;
  loop: boolean;
}

export interface PetSheetConfig {
  name: string;
  /** Empty string → procedural drawing (no spritesheet shipped). */
  sprite: string;
  frame: { w: number; h: number; cols: number };
  states: Record<PetStateKey, PetStateCfg>;
}

/** Map a session phase to an animation state. */
export const STATE_MAPPING: Record<string, PetStateKey> = {
  idle: "idle",
  thinking: "waiting",
  writing: "running",
  tool: "review",
  awaiting: "wave",
  error: "failed",
  completed: "jump",
};

/** Transient states play once, then fall back. Loop states fall back to themselves. */
export const TRANSIENT_FALLBACK: Record<PetStateKey, PetStateKey> = {
  wave: "idle",
  jump: "idle",
  failed: "idle",
  idle: "idle",
  run: "run",
  waiting: "waiting",
  running: "running",
  review: "review",
  sleep: "sleep",
};

/** Pick the single best animation state for an aggregated status payload. */
export function resolvePetState(payload: PetStatusPayload): PetStateKey {
  const a = payload.claude.phase;
  const b = payload.codex.phase;
  const best = PHASE_PRIORITY[a] >= PHASE_PRIORITY[b] ? a : b;
  return STATE_MAPPING[best] ?? "idle";
}

export interface PetFrameState {
  state: PetStateKey;
  frame: number;
  /** Accumulated ms within the current frame. */
  accum: number;
  /** Continuous ms spent in idle — drives the idle→sleep transition. */
  idleMs: number;
}

export function initialFrameState(): PetFrameState {
  return { state: "idle", frame: 0, accum: 0, idleMs: 0 };
}

/**
 * Advance the animation by dt ms. Pure — tests use this with fixed dt.
 * Sleep transition: after `sleepAfterMs` of continuous idle, drop to 'sleep'.
 */
export function stepFrame(
  fs: PetFrameState,
  dt: number,
  states: Record<PetStateKey, PetStateCfg>,
  sleepAfterMs: number,
): PetFrameState {
  let st = states[fs.state];
  let { state, frame, accum } = fs;
  accum += dt;
  const idleMs = state === "idle" ? fs.idleMs + dt : 0;

  if (state === "idle" && sleepAfterMs > 0 && idleMs >= sleepAfterMs) {
    // Only fall asleep if the skin actually defines a sleep row; otherwise
    // stay in idle (an imported pet.json may omit it).
    if (states.sleep) {
      return { state: "sleep", frame: 0, accum: 0, idleMs: 0 };
    }
  }

  if (!st) {
    // Skin is missing this state (e.g. a transient the imported pet.json
    // doesn't define). Fall back to idle so we never deref undefined.
    st = states.idle;
    state = "idle";
    frame = 0;
    accum = 0;
    return { state, frame, accum, idleMs };
  }

  if (st.loop) {
    const period = st.duration * st.frames;
    frame = Math.floor(accum / st.duration) % st.frames;
    accum = accum % period;
  } else {
    // Transient: one frame per duration, then fall back.
    while (accum >= st.duration && frame < st.frames - 1) {
      frame += 1;
      accum -= st.duration;
    }
    if (frame >= st.frames - 1 && accum >= st.duration) {
      state = TRANSIENT_FALLBACK[state];
      frame = 0;
      accum = 0;
    }
  }
  return { state, frame, accum, idleMs };
}

export interface EngineOptions {
  sleepAfterMs: number;
  onStateChange?: (state: PetStateKey) => void;
}

/**
 * Canvas-owning engine. Owns the rAF loop and the current frame state.
 * `applyStatus` is called from React on each pet:status payload.
 */
export class PetEngine {
  private raf = 0;
  private lastNow = 0;
  private frameState: PetFrameState = initialFrameState();
  private sheet: HTMLImageElement | null = null;
  private opts: EngineOptions;

  constructor(
    private canvas: HTMLCanvasElement,
    private config: PetSheetConfig,
    private scale: number,
    opts?: Partial<EngineOptions>,
  ) {
    this.opts = { sleepAfterMs: 60_000, ...opts };
    this.syncBackingSize();
    if (config.sprite) this.loadSheet(config.sprite);
  }

  private loadSheet(src: string) {
    const img = new Image();
    img.onload = () => {
      this.sheet = img;
    };
    img.src = src;
  }

  /** Called when a new status arrives. Returns true if the state changed. */
  applyStatus(payload: PetStatusPayload): boolean {
    const next = resolvePetState(payload);
    if (next === this.frameState.state) return false;
    this.frameState = { state: next, frame: 0, accum: 0, idleMs: 0 };
    this.opts.onStateChange?.(next);
    return true;
  }

  setScale(scale: number) {
    if (scale === this.scale) return;
    this.scale = scale;
    this.syncBackingSize();
  }

  /** Play a one-shot transient animation (e.g. click → jump/wave). Falls back
   *  automatically via TRANSIENT_FALLBACK; overridden by the next applyStatus. */
  playAction(state: PetStateKey) {
    const cfg = this.config.states[state];
    if (cfg && !cfg.loop) {
      this.frameState = { state, frame: 0, accum: 0, idleMs: 0 };
      this.opts.onStateChange?.(state);
    }
  }

  private syncBackingSize() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.config.frame;
    this.canvas.width = Math.round(w * this.scale * dpr);
    this.canvas.height = Math.round(h * this.scale * dpr);
    this.canvas.style.width = `${Math.round(w * this.scale)}px`;
    this.canvas.style.height = `${Math.round(h * this.scale)}px`;
    const ctx = this.canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, 0, 0);
  }

  start() {
    this.lastNow = 0;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number) => {
    if (this.lastNow) {
      const dt = Math.min(now - this.lastNow, 100); // clamp long gaps (hidden window etc.)
      this.frameState = stepFrame(
        this.frameState,
        dt,
        this.config.states,
        this.opts.sleepAfterMs,
      );
      this.draw();
    }
    this.lastNow = now;
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = this.config.frame;
    ctx.clearRect(0, 0, w, h);

    // Guard: an imported pet.json may omit a state (e.g. `sleep`). Fall back to
    // the idle row so the renderer never dereferences an undefined state.
    let st = this.config.states[this.frameState.state];
    if (!st) {
      st = this.config.states.idle;
      this.frameState = { state: "idle", frame: 0, accum: 0, idleMs: this.frameState.idleMs };
      if (!st) return; // no idle either — nothing to draw
    }
    if (this.sheet) {
      const f = this.config.frame;
      const sx = (this.frameState.frame % f.cols) * f.w;
      const sy = st.row * f.h;
      ctx.drawImage(this.sheet, sx, sy, f.w, f.h, 0, 0, w, h);
    } else {
      drawProceduralPet(ctx, this.frameState.state, this.frameState.frame, st, w, h);
    }
  }
}
