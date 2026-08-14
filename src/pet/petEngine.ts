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
import {
  AMBIENT_MAP,
  AMBIENT_TIME_DRIVEN,
  drawAmbient,
  type AmbientKind,
  type AmbientState,
} from "./ambient";
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
  const c = payload.deepseek?.phase ?? "idle"; // deepseek slot added 2026-08-14
  let best = PHASE_PRIORITY[a] >= PHASE_PRIORITY[b] ? a : b;
  if (PHASE_PRIORITY[c] > PHASE_PRIORITY[best]) best = c;
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
 * Variable-rate redraw decision (pure — unit-testable).
 * Redraw when: continuous mode (FX active), a time-driven ambient is live,
 * or the animation frame/state actually changed. Idle frames (150ms) only
 * repaint ~7×/s instead of 60×/s.
 */
export function shouldDrawFrame(
  prev: PetFrameState,
  next: PetFrameState,
  continuous: boolean,
  ambientTimeDriven: boolean,
): boolean {
  return continuous || ambientTimeDriven || prev.state !== next.state || prev.frame !== next.frame;
}

/**
 * Whether the rAF loop should fully stop (sleep power saving). Decoupled from
 * the pure stepFrame: it only reads the resulting state + continuous flag.
 */
export function shouldPauseRender(next: PetFrameState, continuous: boolean): boolean {
  return next.state === "sleep" && !continuous;
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
  /**
   * Frame-level FX hooks for overlay effects (evolution auras, roar flames,
   * camera shake). `beforeDraw` runs before the pet sprite (apply transforms);
   * `afterDraw` runs after it (draw overlays). Each hook is wrapped in
   * save()/restore() so transforms never leak into the next frame.
   */
  fxHooks?: {
    beforeDraw?: (ctx: CanvasRenderingContext2D, tMs: number) => void;
    afterDraw?: (ctx: CanvasRenderingContext2D, tMs: number) => void;
  };
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

  /** Continuous (every-frame) rendering — active while an FX queue runs. */
  private continuous = false;
  /** start()/stop() master switch (window visibility). */
  private running = false;
  /** Sleep power-saving pause: rAF fully stopped until an input wakes us. */
  private sleepPaused = false;
  /** Force one redraw (resume / scale change — backing store was cleared). */
  private forceDraw = false;
  /** Active ambient overlay (state ambience), or null. */
  private ambient: AmbientState | null = null;
  /** Next idle-heart schedule time (ms). */
  private nextHeartAt = 0;
  /** OffscreenCanvas cache for procedural frames, keyed by dev-pixel size. */
  private procCache = new Map<string, CanvasImageSource>();

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
    this.setAmbientForState(next);
    this.opts.onStateChange?.(next);
    this.resumeIfPaused();
    return true;
  }

  setScale(scale: number) {
    if (scale === this.scale) return;
    this.scale = scale;
    this.syncBackingSize();
    // Backing store was reset by the resize — force a repaint.
    this.forceDraw = true;
    this.resumeIfPaused();
  }

  /** Play a one-shot transient animation (e.g. click → jump/wave). Falls back
   *  automatically via TRANSIENT_FALLBACK; overridden by the next applyStatus. */
  playAction(state: PetStateKey) {
    const cfg = this.config.states[state];
    if (cfg && !cfg.loop) {
      this.frameState = { state, frame: 0, accum: 0, idleMs: 0 };
      this.setAmbientForState(state);
      this.opts.onStateChange?.(state);
      this.resumeIfPaused();
    }
  }

  /** Toggle continuous rendering (FX queue non-empty). Wakes a paused loop. */
  setContinuous(v: boolean) {
    if (this.continuous === v) return;
    this.continuous = v;
    if (v) {
      this.forceDraw = true;
      this.resumeIfPaused();
    }
  }

  /** Input wake-up: pointer down on the pet resumes a sleep-paused loop. */
  wake() {
    this.resumeIfPaused();
  }

  /** True while the pet is asleep (used to skip idle random actions). */
  isSleeping(): boolean {
    return this.sleepPaused || this.frameState.state === "sleep";
  }

  private setAmbientForState(state: PetStateKey) {
    const spec = AMBIENT_MAP[state];
    this.ambient = spec
      ? { kind: spec.kind, start: performance.now(), until: spec.until === Infinity ? Infinity : performance.now() + spec.until }
      : null;
  }

  private setAmbient(kind: AmbientKind, dur: number) {
    this.ambient = {
      kind,
      start: performance.now(),
      until: dur === Infinity ? Infinity : performance.now() + dur,
    };
  }

  /** Idle occasionally floats a heart (8–15s random). */
  private maybeScheduleHearts(now: number) {
    if (this.frameState.state !== "idle" || now < this.nextHeartAt) return;
    this.nextHeartAt = now + 8000 + Math.random() * 7000;
    this.ambient = { kind: "hearts", start: now, until: now + 1200 };
  }

  private resumeIfPaused() {
    if (!this.sleepPaused) return;
    this.sleepPaused = false;
    this.lastNow = 0;
    this.forceDraw = true;
    if (this.running) this.raf = requestAnimationFrame(this.tick);
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
    this.running = true;
    this.lastNow = 0;
    this.sleepPaused = false;
    this.forceDraw = true;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (now: number) => {
    if (this.lastNow) {
      const dt = Math.min(now - this.lastNow, 100); // clamp long gaps (hidden window etc.)
      const prev = this.frameState;
      this.frameState = stepFrame(
        prev,
        dt,
        this.config.states,
        this.opts.sleepAfterMs,
      );
      if (this.frameState.state !== prev.state && this.frameState.state === "sleep") {
        this.setAmbient("zzz", Infinity);
      }
      this.maybeScheduleHearts(now);
      const ambientDriven =
        this.ambient !== null &&
        this.ambient.until > now &&
        AMBIENT_TIME_DRIVEN.has(this.ambient.kind);
      if (
        this.forceDraw ||
        shouldDrawFrame(prev, this.frameState, this.continuous, ambientDriven)
      ) {
        this.forceDraw = false;
        this.draw(now);
      }
      if (shouldPauseRender(this.frameState, this.continuous)) {
        // Sleep power saving: fully stop the rAF loop. Any input (status
        // change, click, FX) resumes it via resumeIfPaused().
        this.sleepPaused = true;
        this.lastNow = now;
        return;
      }
    }
    this.lastNow = now;
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(now: number) {
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
    ctx.save();
    if (this.frameState.state === "idle") {
      // Idle breathing sway — frame-index driven, adds no extra redraws.
      const sway = Math.sin((this.frameState.frame / 16) * Math.PI * 2) * 6 * (w / 96);
      ctx.translate(sway, 0);
    }
    this.opts.fxHooks?.beforeDraw?.(ctx, now);
    if (this.sheet) {
      const f = this.config.frame;
      const sx = (this.frameState.frame % f.cols) * f.w;
      const sy = st.row * f.h;
      ctx.drawImage(this.sheet, sx, sy, f.w, f.h, 0, 0, w, h);
    } else {
      this.drawProceduralCached(ctx, st, w, h);
    }
    ctx.restore();
    // State ambience (skin-agnostic; procedural skin skips its duplicates).
    if (this.ambient) {
      drawAmbient(
        ctx,
        this.ambient,
        this.frameState.state,
        this.frameState.frame,
        now,
        w,
        h,
        !this.config.sprite,
      );
    }
    ctx.save();
    this.opts.fxHooks?.afterDraw?.(ctx, now);
    ctx.restore();
  }

  /**
   * Procedural frames are cached to OffscreenCanvas per (state, frame, device
   * size) — a 192×208 pet with ~30 canvas ops only re-renders when the
   * animation frame actually changes. The cache key includes the device-pixel
   * size, so scale/dpr changes invalidate automatically (drawImage maps 1:1
   * under the current dpr·scale transform).
   */
  private drawProceduralCached(
    ctx: CanvasRenderingContext2D,
    st: PetStateCfg,
    w: number,
    h: number,
  ) {
    const state = this.frameState.state;
    const frame = this.frameState.frame;
    if (typeof OffscreenCanvas === "undefined") {
      drawProceduralPet(ctx, state, frame, st, w, h);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const devW = Math.round(w * this.scale * dpr);
    const devH = Math.round(h * this.scale * dpr);
    const key = `${state}:${frame}:${devW}x${devH}`;
    let c = this.procCache.get(key);
    if (!c) {
      c = new OffscreenCanvas(devW, devH);
      const g = c.getContext("2d");
      if (g) {
        g.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, 0, 0);
        drawProceduralPet(g, state, frame, st, w, h);
      }
      if (this.procCache.size > 128) this.procCache.clear();
      this.procCache.set(key, c);
    }
    ctx.drawImage(c, 0, 0, w, h);
  }
}
