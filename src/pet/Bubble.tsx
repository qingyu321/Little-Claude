/**
 * Speech bubble shown above the pet. Content comes from the main-window
 * aggregator (already localized); the source dot distinguishes Claude / Codex.
 * A second line shows the active tab's token usage (in/out/cache).
 */

import { usePetStore } from "./petStore";

const SOURCE_COLORS: Record<string, string> = {
  claude: "#C47252",
  codex: "#45B8A8",
  deepseek: "#4D6BFE",
};
const ERROR_BORDER = "rgba(224, 82, 82, 0.55)";

/** Format token counts like the main UI: 1234 → "1.2k". */
function fmt(n?: number): string {
  const v = n ?? 0;
  if (v < 1000) return String(v);
  if (v < 100_000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

export function Bubble() {
  const bubble = usePetStore((s) => s.bubble);
  const visible = usePetStore((s) => s.bubbleVisible);
  const status = usePetStore((s) => s.status);
  if (!bubble || !visible) return null;

  const dot = bubble.source ? SOURCE_COLORS[bubble.source] : "#8A8A8F";
  // Token line: from the bubble source's agent status (fall back to any active).
  const agent =
    bubble.source === "codex" ? status?.codex
      : bubble.source === "deepseek" ? status?.deepseek
        : status?.claude;
  const hasTokens = (agent?.input ?? 0) + (agent?.output ?? 0) + (agent?.cacheRead ?? 0) + (agent?.cacheCreation ?? 0) > 0;

  return (
    <div
      className="pet-bubble"
      style={{ borderColor: bubble.kind === "error" ? ERROR_BORDER : undefined }}
    >
      <div className="pet-bubble-row">
        {bubble.source && (
          <span className="pet-bubble-dot" style={{ background: dot }} />
        )}
        <span className="pet-bubble-text">{bubble.text}</span>
      </div>
      {hasTokens && (
        <div className="pet-token-line">
          ↑{fmt(agent?.input)} · ↓{fmt(agent?.output)}
          {(agent?.cacheRead || 0) + (agent?.cacheCreation || 0) > 0 && (
            <span className="pet-token-cache"> · ⇄{fmt((agent?.cacheRead || 0) + (agent?.cacheCreation || 0))}</span>
          )}
        </div>
      )}
    </div>
  );
}
