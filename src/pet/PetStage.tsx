/**
 * Pet canvas stage — owns the engine, wires store → engine, and handles
 * pointer drag / click / right-click interactions with DPI-aware positioning.
 */

import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PET_SLEEP_AFTER_MS } from "../lib/pet/constants";
import { savePetPosition } from "../lib/pet/position";
import { PetEngine, type PetSheetConfig, type PetStateKey } from "./petEngine";
import { usePetStore } from "./petStore";

const ACTION_CYCLE: PetStateKey[] = ["jump", "wave"];
const DRAG_THRESHOLD_PX = 4;
const CLICK_RESET_MS = 260;

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

  const scale = usePetStore((s) => s.scale);

  // Create engine + wire store/document subscriptions.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new PetEngine(canvas, config, scale, {
      sleepAfterMs: PET_SLEEP_AFTER_MS,
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
          const act = ACTION_CYCLE[actionIdx.current % ACTION_CYCLE.length];
          actionIdx.current += 1;
          engineRef.current?.playAction(act);
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
