/**
 * Pet window runtime store (non-persisted, mirrors videoAnalysisRuntimeStore pattern).
 * The pet window is a separate entry; React state here drives the stage/bubble/badge.
 */

import { create } from "zustand";
import type { PetStatusPayload } from "../lib/pet/types";

export interface PetBubbleView {
  seq: number;
  text: string;
  /** 'claude' | 'codex' | null — for the source dot. */
  source: string | null;
  kind: string;
  /** Absolute expiry timestamp (ms) — bubble fades at ts + ttlMs. */
  expiresAt: number;
}

interface PetState {
  status: PetStatusPayload | null;
  bubble: PetBubbleView | null;
  bubbleVisible: boolean;
  menuOpen: boolean;
  /** Right-click menu anchor (CSS px within the window). */
  menuPos: { x: number; y: number } | null;
  /** Whether the window is shown (set by the engine on visibility). */
  visible: boolean;
  scale: number;
  /** Current skin id ("default" or imported). */
  skin: string;

  setStatus: (status: PetStatusPayload | null) => void;
  setBubble: (bubble: PetBubbleView | null) => void;
  setBubbleVisible: (v: boolean) => void;
  setMenuOpen: (v: boolean, pos?: { x: number; y: number }) => void;
  setVisible: (v: boolean) => void;
  setScale: (scale: number) => void;
  setSkin: (skin: string) => void;
}

export const usePetStore = create<PetState>()((set) => ({
  status: null,
  bubble: null,
  bubbleVisible: true,
  menuOpen: false,
  menuPos: null,
  visible: false,
  scale: 1,
  skin: "default",

  setStatus: (status) => set({ status }),
  setBubble: (bubble) => set({ bubble }),
  setBubbleVisible: (bubbleVisible) => set({ bubbleVisible }),
  setMenuOpen: (menuOpen, menuPos) =>
    set(menuOpen ? { menuOpen, menuPos: menuPos ?? null } : { menuOpen: false, menuPos: null }),
  setVisible: (visible) => set({ visible }),
  setScale: (scale) => set({ scale }),
  setSkin: (skin) => set({ skin }),
}));
