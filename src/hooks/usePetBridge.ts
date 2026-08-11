/**
 * Main-window side aggregation bridge for the desktop pet.
 * Subscribes to the session/chat/settings stores (out-of-band, no React renders),
 * throttles, dedups by JSON, and emits a pet:status payload the pet window renders.
 * Also handles pet:command back-channel (focus main / open settings / user-hide).
 */

import { useEffect } from "react";
import { useChatStore } from "../stores/chatStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { t } from "../lib/i18n";
import { computePetStatus, type PetStatusComputed } from "../lib/pet/aggregate";
import {
  emitPetStatus,
  focusMainWindow,
  hidePetWindow,
  onPetCommand,
  showPetWindow,
} from "../lib/pet/bridge";
import { PET_THROTTLE_MS, EVOLUTION_PAIRS } from "../lib/pet/constants";
import type {
  PetBubbleMessage,
  PetMessageTemplates,
  PetStatusPayload,
} from "../lib/pet/types";

/** Monotonic bubble sequence — pet window uses it to detect new bubbles. */
let petSeq = 0;

/** Escape `$` so t()'s String.replace param interpolation can't mangle text. */
const esc = (s: string): string => s.replace(/\$/g, "$$");

/** Build localized message templates. Read via non-reactive t() at call time so
 *  locale changes are picked up without re-subscribing. */
function buildTemplates(): PetMessageTemplates {
  return {
    awaiting: (toolName) => t("pet.phase.awaiting", { toolName: esc(toolName) }),
    tool: (toolName) => t("pet.phase.tool", { toolName: esc(toolName) }),
    writing: (preview) => preview,
    thinking: () => t("pet.phase.thinking"),
    error: (detail) => t("pet.phase.error", { detail: esc(detail) }),
    completed: () => t("pet.phase.completed"),
  };
}

function toPayload(computed: PetStatusComputed, scale: number, skin: string): PetStatusPayload {
  const message: PetBubbleMessage | null = computed.message
    ? { seq: ++petSeq, ...computed.message }
    : null;
  return { v: 1, scale, skin, ...computed, message };
}

export function usePetBridge() {
  useEffect(() => {
    let petShown = false;
    let timer: number | undefined;
    let lastJson: string | null = null;
    let unsubCmd: (() => void) | null = null;

    const showPet = () => {
      if (petShown) return;
      petShown = true;
      void showPetWindow();
    };
    const hidePet = () => {
      petShown = false;
      void hidePetWindow();
    };

    const push = () => {
      const settings = useSettingsStore.getState();
      if (!settings.petEnabled) {
        // Reset so re-enabling the toggle emits a fresh payload.
        lastJson = null;
        return;
      }
      const computed = computePetStatus({
        tabs: useChatStore.getState().tabs,
        streams: useChatStore.getState().streams,
        runningSessions: useSessionStore.getState().runningSessions,
        defaultBackend: settings.cliBackend,
        templates: buildTemplates(),
        now: Date.now(),
      });
      // Dedup key excludes `ts` (Date.now() — changes every tick); include scale
      // + skin so slider/skin changes re-emit even when session state is unchanged.
      const json = JSON.stringify({
        scale: settings.petScale,
        skin: settings.petSkin,
        claude: computed.claude,
        codex: computed.codex,
        message: computed.message,
      });
      if (json === lastJson) return;
      lastJson = json;
      void emitPetStatus(toPayload(computed, settings.petScale, settings.petSkin));
    };

    // Trailing throttle: coalesce bursts of store updates into ≤1 emit / 200ms.
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        push();
      }, PET_THROTTLE_MS);
    };

    onPetCommand((cmd) => {
      switch (cmd.type) {
        case "focus-main":
          void focusMainWindow();
          break;
        case "open-settings":
          useSettingsStore.getState().toggleSettings();
          break;
        case "user-hide":
          petShown = false; // respect right-click hide; don't re-show on next push
          break;
        case "request-status":
          // Pet window just came up. Bypass dedup (our initial push may have been
          // lost before its listener was ready) so it always gets a snapshot.
          lastJson = null;
          push();
          break;
        case "toggle-skin": {
          // Evolution click: swap to the paired skin (if any). The skin change
          // flows back via pet:status → pet window hot-swaps appearance.
          const st = useSettingsStore.getState();
          const next = EVOLUTION_PAIRS[st.petSkin];
          if (next && next !== st.petSkin) {
            st.setPetSkin(next);
            schedule();
          }
          break;
        }
      }
    }).then((un) => {
      unsubCmd = un;
    });

    // Basic store subscription (zustand v5 vanilla): fires on every state change,
    // schedule() + JSON dedup make the actual emit cheap.
    const unsubSession = useSessionStore.subscribe(() => schedule());
    const unsubChat = useChatStore.subscribe(() => schedule());
    const unsubEnable = useSettingsStore.subscribe((state, prev) => {
      if (state.petEnabled !== prev.petEnabled) {
        if (state.petEnabled) {
          petShown = false; // allow show again
          showPet();
          schedule();
        } else {
          hidePet();
        }
      }
    });

    // Initial state: show if already enabled, and push the first snapshot so the
    // pet window can decide its first frame + visibility.
    if (useSettingsStore.getState().petEnabled) showPet();
    push();

    return () => {
      if (timer) clearTimeout(timer);
      unsubSession();
      unsubChat();
      unsubEnable();
      unsubCmd?.();
    };
  }, []);
}
