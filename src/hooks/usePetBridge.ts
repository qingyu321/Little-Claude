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
import {
  buildNotifyText,
  ensureNotifyPermission,
  sendPetNotification,
  shouldNotify,
  type NotifyLast,
} from "../lib/pet/notify";
import type {
  PetAgent,
  PetBubbleMessage,
  PetMessageTemplates,
  PetPhase,
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

// The completion/error report stays in the aggregation loop for many cycles
// (the tab keeps its terminal status). PetApp resets the bubble expiry on
// every NEW seq — a fresh seq per cycle would keep the report visible
// forever. Reuse the previous seq for identical reports; a null message in
// between resets the key so the NEXT completion re-reports with a new seq.
let lastBubbleKey: string | null = null;
let lastBubbleSeq = 0;

function toPayload(computed: PetStatusComputed, scale: number, skin: string): PetStatusPayload {
  let message: PetBubbleMessage | null = null;
  if (computed.message) {
    const key = `${computed.message.kind}${computed.message.source}${computed.message.text}${computed.message.tabId ?? ''}`;
    if (key === lastBubbleKey) {
      message = { seq: lastBubbleSeq, ...computed.message };
    } else {
      lastBubbleKey = key;
      lastBubbleSeq = ++petSeq;
      message = { seq: lastBubbleSeq, ...computed.message };
    }
  } else {
    lastBubbleKey = null;
  }
  return { v: 1, scale, skin, ...computed, message };
}

export function usePetBridge() {
  useEffect(() => {
    let petShown = false;
    let timer: number | undefined;
    let lastJson: string | null = null;
    // Notification state: per-agent phase of the last pushed payload (an
    // active → completed/error transition is the notify trigger), per-agent
    // cooldown, and a one-shot permission check.
    let prevPhase: Partial<Record<PetAgent, PetPhase>> = {};
    const lastNotify: Partial<Record<PetAgent, NotifyLast>> = {};
    let permChecked = false;

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
      // Dedup key excludes `ts` (Date.now() — changes every tick) AND the
      // message `ts` (the report's ts is also Date.now()-based; without
      // stripping it, a persistent completion report re-emits every cycle,
      // and each emit carries a new seq → PetApp never lets the expiry clear
      // it). Include scale + skin so slider/skin changes re-emit even when
      // session state is unchanged.
      const json = JSON.stringify({
        scale: settings.petScale,
        skin: settings.petSkin,
        claude: computed.claude,
        codex: computed.codex,
        deepseek: computed.deepseek,
        message: computed.message ? { ...computed.message, ts: 0 } : computed.message,
      });
      if (json === lastJson) return;
      lastJson = json;

      // System notification on active → completed/error transitions. Per-agent
      // cooldown + petNotify toggle; the 200ms trailing throttle debounces
      // bursty store updates, and the transition check makes it idempotent.
      const now = Date.now();
      for (const agent of ["claude", "codex"] as const) {
        const cur = computed[agent].phase;
        const prev = prevPhase[agent];
        prevPhase[agent] = cur; // always track, even when notifications are off
        if (!settings.petNotify || !shouldNotify(prev, cur, lastNotify[agent] ?? null, now)) {
          continue;
        }
        lastNotify[agent] = { phase: cur, at: now };
        if (!permChecked) {
          permChecked = true;
          void ensureNotifyPermission();
        }
        // shouldNotify guarantees cur is completed/error here.
        const kind = cur === "error" ? "error" : "completed";
        const { title, body } = buildNotifyText(kind, agent, computed[agent].statusMessage ?? "");
        void sendPetNotification(title, body);
      }

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

    // B3b: same async-registration race as useFileAttachments — the unlisten
    // may resolve after unmount; release it immediately in that case, and
    // swallow registration errors instead of an unhandled rejection.
    const unsubCmdRef: { current: (() => void) | null } = { current: null };
    let unmounted = false;
    onPetCommand((cmd) => {
      switch (cmd.type) {
        case "focus-main":
          void focusMainWindow();
          break;
        case "open-settings": {
          const st = useSettingsStore.getState();
          if (cmd.tab) {
            // Pet requested a specific settings tab (③-2): land on that tab.
            // If the panel is already open, only switch tabs — never toggle-close it.
            st.setSettingsOpenRequest({ tab: cmd.tab });
            if (!st.settingsOpen) st.toggleSettings();
          } else {
            st.toggleSettings(); // no tab → original toggle semantics
          }
          break;
        }
        case "user-hide":
          petShown = false; // respect right-click hide; don't re-show on next push
          // ③-1: persist the hide so the pet stays off across restarts too.
          // The settingsStore subscribe → hidePetWindow() path is a one-way
          // hide (no event back), so this can't loop.
          useSettingsStore.getState().setPetEnabled(false);
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
      if (unmounted) {
        un(); // unmounted while registering — release immediately
      } else {
        unsubCmdRef.current = un;
      }
    }).catch((err) => {
      console.error('[petBridge] onPetCommand registration failed:', err);
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
    // pet window can decide its first frame + visibility. When disabled, hide
    // explicitly — a belt-and-braces guard against the window having been
    // shown by anything before this effect runs (e.g. a platform quirk where
    // the initial visible(false) didn't stick).
    if (useSettingsStore.getState().petEnabled) {
      showPet();
    } else {
      void hidePetWindow();
    }
    push();

    return () => {
      unmounted = true;
      if (timer) clearTimeout(timer);
      unsubSession();
      unsubChat();
      unsubEnable();
      unsubCmdRef.current?.();
      unsubCmdRef.current = null;
    };
  }, []);
}
