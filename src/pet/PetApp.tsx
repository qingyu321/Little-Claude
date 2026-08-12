/**
 * Pet window root — orchestrates config load, main-window status subscription,
 * window auto-sizing (pet × scale, bottom-anchored), position restore, bubble
 * expiry, and the right-click menu.
 */

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";
import { emitPetCommand, hideCurrentWindow } from "../lib/pet/bridge";
import { PET_STATUS_EVENT } from "../lib/pet/constants";
import { clampToMonitor, loadPetPosition } from "../lib/pet/position";
import type { PetStatusPayload } from "../lib/pet/types";
import { Badge } from "./Badge";
import { Bubble } from "./Bubble";
import { PetStage } from "./PetStage";
import type { PetSheetConfig } from "./petEngine";
import { usePetStore } from "./petStore";
import "./pet.css";

/** Vertical space reserved above the pet for the bubble (logical px). */
const BUBBLE_SPACE = 96;
const SIDE_PAD = 8;
/** Context-menu geometry (logical px) — used for both window-width flooring
 *  and menu clamping so the 4-item menu is always fully visible. */
const MENU_W = 158; // min-width 150 + panel padding 8
const MENU_ITEM_H = 31; // item ≈ 7px padding ×2 + ~17px line
const MENU_H = 4 * MENU_ITEM_H + 12; // 4 items + panel padding 8 + breathing room
/** Floor the window width so a right-click menu can never be clipped,
 *  even at the smallest pet scale / narrowest imported skin. */
const MIN_WINDOW_W = MENU_W + 16 + 16; // menu + side margins + slack

function targetPhysicalSize(config: PetSheetConfig, scale: number) {
  const sf = window.devicePixelRatio || 1;
  return {
    width: Math.round(Math.max(config.frame.w * scale + SIDE_PAD * 2, MIN_WINDOW_W) * sf),
    height: Math.round((config.frame.h * scale + BUBBLE_SPACE + SIDE_PAD) * sf),
    sf,
  };
}

/** Load a pet config by skin id. Built-in "default" comes from public/pets;
 *  imported pets are read back through the Rust `read_imported_pet` command
 *  (pet.json + spritesheet.webp) so the pet window can render them without
 *  a public/ URL. Returns null if the skin can't be loaded. */
async function loadPetConfig(skin: string): Promise<PetSheetConfig | null> {
  try {
    if (skin === "default") {
      const resp = await fetch("/pets/default/pet.json");
      if (!resp.ok) throw new Error(`pet.json ${resp.status}`);
      const cfg = (await resp.json()) as PetSheetConfig;
      // Built-in default is procedural (sprite === "") — leave as-is.
      return cfg;
    }
    // Imported skin: read pet.json (plain text) + spritesheet (base64 → data URL).
    const jsonText = await invoke<string>("read_imported_pet", { petId: skin, fileName: "pet.json" });
    const cfg = JSON.parse(jsonText) as PetSheetConfig;
    // Spritesheet is optional — procedural skins (imported pet.json only) fall
    // back to the procedural renderer when the webp is missing.
    try {
      const b64 = await invoke<string>("read_imported_pet", { petId: skin, fileName: "spritesheet.webp" });
      return { ...cfg, sprite: `data:image/webp;base64,${b64}` };
    } catch {
      return { ...cfg, sprite: "" };
    }
  } catch (err) {
    console.error(`[pet] failed to load skin "${skin}":`, err);
    return null;
  }
}

export function PetApp() {
  const [config, setConfig] = useState<PetSheetConfig | null>(null);
  const skin = usePetStore((s) => s.skin);
  const bubble = usePetStore((s) => s.bubble);
  const menuOpen = usePetStore((s) => s.menuOpen);
  const menuPos = usePetStore((s) => s.menuPos);
  const scale = usePetStore((s) => s.scale);

  /** Seq of the last bubble that expired — same-seq re-emits are ignored so a
   *  completion report can't resurrect after its TTL (see the listener). */
  const expiredSeqRef = useRef(0);

  // Load pet config for the current skin. Re-runs when `skin` changes → hot-swap.
  useEffect(() => {
    let cancelled = false;
    void loadPetConfig(skin).then((cfg) => {
      if (!cancelled && cfg) setConfig(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [skin]);

  // Subscribe to main-window status (independent of config load) + request a
  // fresh snapshot once our listener is ready (in case the startup emit arrived
  // before this window's React mounted).
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void listen<PetStatusPayload>(PET_STATUS_EVENT, (e) => {
      const st = usePetStore.getState();
      st.setStatus(e.payload);
      st.setScale(e.payload.scale);
      if (e.payload.skin && e.payload.skin !== usePetStore.getState().skin) {
        usePetStore.getState().setSkin(e.payload.skin);
      }
      const msg = e.payload.message;
      if (msg) {
        // A completion report whose seq we already showed AND let expire must
        // not come back to life: the main window keeps re-emitting the same
        // report (same seq) whenever ANY payload field changes (scale slider,
        // another session's tokens). `!prev` can't tell "never shown" from
        // "shown and expired" — track the expired seq explicitly.
        if (msg.seq === expiredSeqRef.current) return;
        const prev = st.bubble;
        if (!prev || prev.seq !== msg.seq) {
          st.setBubble({
            seq: msg.seq,
            text: msg.text,
            source: msg.source,
            kind: msg.kind,
            expiresAt: msg.ts + msg.ttlMs,
          });
        }
      } else {
        st.setBubble(null);
      }
    }).then((u) => {
      unlisten = u;
      void emitPetCommand({ type: "request-status" });
    });

    return () => {
      unlisten?.();
    };
  }, []);

  // Restore saved position once config is known.
  useEffect(() => {
    if (!config) return;

    const win = getCurrentWindow();
    const saved = loadPetPosition();
    void (async () => {
      if (!saved) return;
      const mon = await currentMonitor();
      const sz = targetPhysicalSize(config, scale);
      if (mon) {
        const clamped = clampToMonitor(
          { x: saved.x, y: saved.y },
          { width: sz.width, height: sz.height },
          { x: mon.position.x, y: mon.position.y, width: mon.size.width, height: mon.size.height },
        );
        await win.setPosition(new PhysicalPosition(clamped.x, clamped.y));
      } else {
        await win.setPosition(new PhysicalPosition(saved.x, saved.y));
      }
    })();
  }, [config]);

  // Auto-size window to fit pet × scale, keeping the bottom edge anchored.
  useEffect(() => {
    if (!config) return;
    const win = getCurrentWindow();
    const sz = targetPhysicalSize(config, scale);
    void (async () => {
      const old = await win.outerSize();
      await win.setSize(new PhysicalSize(sz.width, sz.height));
      const pos = await win.outerPosition();
      await win.setPosition(new PhysicalPosition(pos.x, pos.y + (old.height - sz.height)));
    })();
  }, [config, scale]);

  // Bubble expiry: clear after expiresAt.
  useEffect(() => {
    if (!bubble) return;
    const delay = bubble.expiresAt - Date.now();
    const clear = () => {
      const st = usePetStore.getState();
      if (st.bubble && st.bubble.seq === bubble.seq) {
        expiredSeqRef.current = bubble.seq; // same-seq re-emits stay ignored
        st.setBubble(null);
      }
    };
    if (delay <= 0) {
      clear();
      return;
    }
    const timer = setTimeout(clear, delay + 60);
    return () => clearTimeout(timer);
  }, [bubble]);

  const closeMenu = () => usePetStore.getState().setMenuOpen(false);

  const menuItems = [
    {
      label: t("pet.menu.toggleBubble"),
      action: () => {
        const st = usePetStore.getState();
        st.setBubbleVisible(!st.bubbleVisible);
        closeMenu();
      },
    },
    {
      label: t("pet.menu.focusMain"),
      action: () => {
        void emitPetCommand({ type: "focus-main" });
        closeMenu();
      },
    },
    {
      label: t("pet.menu.hidePet"),
      action: () => {
        void emitPetCommand({ type: "user-hide" });
        void hideCurrentWindow();
        usePetStore.getState().setVisible(false);
        closeMenu();
      },
    },
    {
      label: t("pet.menu.openSettings"),
      action: () => {
        void emitPetCommand({ type: "open-settings" });
        closeMenu();
      },
    },
  ];

  return (
    <div className="pet-root">
      {menuOpen && <div className="pet-menu-backdrop" onClick={closeMenu} />}
      <Bubble />
      {config && <PetStage config={config} />}
      <Badge />
      {menuOpen && menuPos && (
        <div
          className="pet-menu"
          style={{
            // Clamp BOTH edges: without the lower bound, a window narrower
            // than the menu (small petScale / narrow skin) puts left into
            // negative space and .pet-root's overflow:hidden clips the menu.
            left: Math.max(8, Math.min(menuPos.x, window.innerWidth - MENU_W - 8)),
            top: Math.max(8, Math.min(menuPos.y, window.innerHeight - MENU_H)),
          }}
        >
          {menuItems.map((it) => (
            <button key={it.label} className="pet-menu-item" onClick={it.action}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
