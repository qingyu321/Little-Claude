/**
 * Pet canvas stage — owns the engine, wires store → engine, and handles
 * pointer drag / click / right-click interactions with DPI-aware positioning.
 */

import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitPetCommand } from "../lib/pet/bridge";
import {
  EVOLUTION_FORWARD,
  EVOLUTION_PAIRS,
  PET_SLEEP_AFTER_MS,
} from "../lib/pet/constants";
import { savePetPosition } from "../lib/pet/position";
import { PetEngine, type PetSheetConfig, type PetStateKey } from "./petEngine";
import { usePetStore } from "./petStore";

const ACTION_CYCLE: PetStateKey[] = ["jump", "wave"];
const DRAG_THRESHOLD_PX = 4;
const CLICK_RESET_MS = 260;

/** One entry of the FX queue: evolution aura / de-evolve aura / roar. */
interface PetFxItem {
  type: "evolve" | "devolve" | "roar";
  start: number;
  dur: number;
  /** Whether the skin-swap command was already sent (send once at flash peak). */
  swapSent?: boolean;
}

/** Golden tassel: 5 gold beads with comet trails orbiting the pet.
 *  Coordinates are logical frame units (w/h), scaled from the 96×96 demo baseline. */
function drawEvolutionAura(
  ctx: CanvasRenderingContext2D,
  el: number,
  dir: 1 | -1,
  alpha: number,
  w: number,
  h: number,
) {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w * 0.46;
  const ry = h * 0.42;
  const N = 5;
  const TRAIL = 10;
  const TSTEP = 0.13;
  const sf = w / 96;
  const base = dir * el * Math.PI * 2 * 3.2; // 全程转 3.2 圈
  for (let k = 0; k < N; k++) {
    const k0 = (k * 2 * Math.PI) / N;
    // 拖尾：金珠后方的尾迹点（角度递减 = 被甩在身后）
    for (let i = 1; i <= TRAIL; i++) {
      const th = base + k0 - i * TSTEP;
      const x = cx + Math.cos(th) * rx;
      const y = cy + Math.sin(th) * ry;
      const fade = (1 - i / TRAIL) * alpha;
      const size = (2.9 * (1 - i / TRAIL) + 0.8) * sf;
      ctx.fillStyle = `rgba(255, ${200 - i * 11}, 40, ${0.85 * fade})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    // 头部金珠 + 白心
    const th0 = base + k0;
    const x0 = cx + Math.cos(th0) * rx;
    const y0 = cy + Math.sin(th0) * ry;
    ctx.fillStyle = `rgba(255, 214, 60, ${0.95 * alpha})`;
    ctx.beginPath();
    ctx.arc(x0, y0, 3.4 * sf, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 250, 220, ${0.9 * alpha})`;
    ctx.beginPath();
    ctx.arc(x0, y0, 1.5 * sf, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Roar flame: orange pixel blocks (programmatic FX, no sheet frames needed). */
function drawRoarFlame(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  const G = w / 24; // 21 格火焰 ≈ 0.875w 宽
  const yStart = Math.round((0.46 * h) / G);
  const phase = Math.floor(t / 90) % 4;
  const cols = ["#FBBF24", "#F97316", "#C2410C", "#B91C1C"];
  for (let i = 0; i < 21; i++) {
    const hh = 2 + ((i * 3 + phase * 2) % 4);
    ctx.fillStyle = cols[i % 4];
    for (let y = yStart; y < yStart + hh; y++) ctx.fillRect(i * G, y * G, G, G);
  }
}

export function PetStage({ config }: { config: PetSheetConfig }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<PetEngine | null>(null);
  const dragRef = useRef<{
    wx: number;
    wy: number;
    sx: number;
    sy: number;
    sf: number;
    moved: boolean;
  } | null>(null);
  const rafMove = useRef(0);
  const lastMove = useRef({ x: 0, y: 0 });
  const clickTimer = useRef<number | undefined>(undefined);
  const clickCount = useRef(0);
  const actionIdx = useRef(0);
  /** FX queue survives engine rebuilds (skin hot-swap recreates the engine). */
  const fxQueueRef = useRef<PetFxItem[]>([]);

  const scale = usePetStore((s) => s.scale);

  // Create engine + wire store/document subscriptions.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new PetEngine(canvas, config, scale, {
      sleepAfterMs: PET_SLEEP_AFTER_MS,
      fxHooks: {
        beforeDraw: (ctx, tMs) => {
          const fx = fxQueueRef.current[0];
          if (!fx) return;
          const el = (tMs - fx.start) / fx.dur;
          const { w: fw, h: fh } = config.frame;
          if (fx.type === "roar" && el < 0.6) {
            // 咆哮：抖动 + 膨胀
            const ph = Math.floor(el * 30) % 4;
            const k = [1.12, 0.95, 1.08, 1.0][ph];
            ctx.translate(fw / 2, fh / 2);
            ctx.scale(k, k);
            ctx.translate(-fw / 2, -fh / 2);
            ctx.translate((Math.floor(el * 40) % 3) - 1, (Math.floor(el * 37) % 3) - 1);
          } else if (fx.type === "evolve" || fx.type === "devolve") {
            // 缩小宠物，给金色流苏留出环绕空间
            ctx.translate(fw / 2, fh / 2);
            ctx.scale(0.84, 0.84);
            ctx.translate(-fw / 2, -fh / 2);
          }
        },
        afterDraw: (ctx, tMs) => {
          const fx = fxQueueRef.current[0];
          if (!fx) return;
          const el = (tMs - fx.start) / fx.dur;
          const { w: fw, h: fh } = config.frame;
          if (fx.type === "evolve" || fx.type === "devolve") {
            const dir: 1 | -1 = fx.type === "evolve" ? 1 : -1;
            // 闪光峰值发一次皮肤切换（切换经 pet:status 回流，此处只管发）
            if (el >= 0.5 && !fx.swapSent) {
              fx.swapSent = true;
              void emitPetCommand({ type: "toggle-skin" });
            }
            // 金色流苏（头亮尾淡）
            let auraA = 1;
            if (el < 0.35) auraA = Math.min(1, el / 0.2);
            else if (el > 0.55) auraA = Math.max(0, 1 - (el - 0.55) / 0.45);
            if (auraA > 0.03) drawEvolutionAura(ctx, el, dir, auraA, fw, fh);
            // 白闪（进化）/ 绿闪（退化）：0.4-0.62 正弦脉冲
            if (el >= 0.4 && el <= 0.62) {
              const fa = Math.sin(((el - 0.4) / 0.22) * Math.PI);
              ctx.globalAlpha = fa * 0.92;
              ctx.fillStyle = fx.type === "evolve" ? "#ffffff" : "#4ade80";
              ctx.fillRect(0, 0, fw, fh);
              ctx.globalAlpha = 1;
            }
          } else if (fx.type === "roar" && el >= 0.6) {
            drawRoarFlame(ctx, tMs - fx.start, fw, fh);
          }
          if (el >= 1) {
            fxQueueRef.current.shift();
            const next = fxQueueRef.current[0];
            if (next) next.start = tMs;
          }
        },
      },
    });
    engineRef.current = engine;
    engine.start();

    // If a status snapshot already arrived before this component mounted,
    // apply it so the pet isn't stuck in the initial idle pose.
    const initialStatus = usePetStore.getState().status;
    if (initialStatus) engine.applyStatus(initialStatus);

    usePetStore.getState().setVisible(!document.hidden);

    const onVis = () => {
      const hidden = document.hidden;
      if (hidden) engine.stop();
      else engine.start();
      usePetStore.getState().setVisible(!hidden);
    };
    document.addEventListener("visibilitychange", onVis);

    const unsubStatus = usePetStore.subscribe((state, prev) => {
      if (state.status !== prev.status && state.status) {
        engine.applyStatus(state.status);
        // Completion / error transition → play a one-shot celebratory / fail
        // animation (jump / failed). Detect a phase going FROM an active phase
        // TO completed/error across either agent.
        const prevPhase = prev.status?.claude.phase ?? "idle";
        const curPhase = state.status.claude.phase ?? "idle";
        const prevCodex = prev.status?.codex.phase ?? "idle";
        const curCodex = state.status.codex.phase ?? "idle";
        const activePhases = ["thinking", "writing", "tool", "awaiting"];
        if (
          (activePhases.includes(prevPhase) && curPhase === "completed") ||
          (activePhases.includes(prevCodex) && curCodex === "completed")
        ) {
          engine.playAction("jump");
        } else if (
          (activePhases.includes(prevPhase) && curPhase === "error") ||
          (activePhases.includes(prevCodex) && curCodex === "error")
        ) {
          engine.playAction("failed");
        }
      }
    });

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      unsubStatus();
      engine.stop();
      engineRef.current = null;
    };
  }, [config]);

  // Scale changes → engine backing size (window resize handled in PetApp).
  useEffect(() => {
    engineRef.current?.setScale(scale);
  }, [scale]);

  const onPointerDown = async (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    dragRef.current = {
      wx: pos.x,
      wy: pos.y,
      sx: e.screenX,
      sy: e.screenY,
      sf: await win.scaleFactor(),
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.screenX - d.sx) + Math.abs(e.screenY - d.sy) > DRAG_THRESHOLD_PX) {
      d.moved = true;
    }
    lastMove.current = { x: e.screenX, y: e.screenY };
    if (rafMove.current) return;
    rafMove.current = requestAnimationFrame(() => {
      rafMove.current = 0;
      const dd = dragRef.current;
      if (!dd) return;
      void getCurrentWindow().setPosition(
        new PhysicalPosition(
          Math.round(dd.wx + (lastMove.current.x - dd.sx) * dd.sf),
          Math.round(dd.wy + (lastMove.current.y - dd.sy) * dd.sf),
        ),
      );
    });
  };

  const onPointerUp = async (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (rafMove.current) {
      cancelAnimationFrame(rafMove.current);
      rafMove.current = 0;
    }
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be released — ignore
    }

    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    savePetPosition(pos.x, pos.y, await win.scaleFactor());

    if (!d.moved) {
      // Click vs double-click: defer single-click action until the window closes.
      clickCount.current += 1;
      if (clickCount.current >= 2) {
        clickCount.current = 0;
        if (clickTimer.current) {
          clearTimeout(clickTimer.current);
          clickTimer.current = undefined;
        }
        usePetStore.getState().setBubbleVisible(!usePetStore.getState().bubbleVisible);
      } else {
        if (clickTimer.current) clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          clickTimer.current = undefined;
          clickCount.current = 0;
          const skin = usePetStore.getState().skin;
          const target = EVOLUTION_PAIRS[skin];
          if (target) {
            // 进化对存在：播特效序列，闪光峰值发 toggle-skin 切换皮肤。
            // 正向进化（流苏顺转 + 白闪）；反向退化（咆哮 + 流苏逆转 + 绿闪）。
            const now = performance.now();
            if (EVOLUTION_FORWARD[skin]) {
              fxQueueRef.current = [{ type: "evolve", start: now, dur: 1400 }];
            } else {
              fxQueueRef.current = [
                { type: "roar", start: now, dur: 650 },
                { type: "devolve", start: now + 650, dur: 1200 },
              ];
            }
          } else {
            const act = ACTION_CYCLE[actionIdx.current % ACTION_CYCLE.length];
            actionIdx.current += 1;
            engineRef.current?.playAction(act);
          }
        }, CLICK_RESET_MS);
      }
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    usePetStore.getState().setMenuOpen(true, { x: e.clientX, y: e.clientY });
  };

  return (
    <canvas
      ref={canvasRef}
      className="pet-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
    />
  );
}
