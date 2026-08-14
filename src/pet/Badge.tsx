/**
 * Active-session badge: C{n} for Claude, X{n} for Codex. Click toggles an
 * expanded token panel showing each agent's in/out/cache usage.
 */

import { useState } from "react";
import { usePetStore } from "./petStore";

function fmt(n?: number): string {
  const v = n ?? 0;
  if (v < 1000) return String(v);
  if (v < 100_000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

function AgentRow({
  label,
  className,
  status,
}: {
  label: string;
  className: string;
  status: { active?: number; input?: number; output?: number; cacheRead?: number; cacheCreation?: number };
}) {
  const active = status.active ?? 0;
  if (active === 0) return null;
  const cache = (status.cacheRead ?? 0) + (status.cacheCreation ?? 0);
  return (
    <div className={`pet-token-agent ${className}`}>
      <div className="pet-token-agent-head">
        <span className="pet-badge-item">{label} {active}</span>
        <span className="pet-token-agent-total">
          {fmt((status.input ?? 0) + (status.output ?? 0) + cache)}
        </span>
      </div>
      <div className="pet-token-agent-row">↑ {fmt(status.input)}</div>
      <div className="pet-token-agent-row">↓ {fmt(status.output)}</div>
      <div className="pet-token-agent-row">⇄ {fmt(cache)}</div>
    </div>
  );
}

export function Badge() {
  const status = usePetStore((s) => s.status);
  const [expanded, setExpanded] = useState(false);
  const c = status?.claude.active ?? 0;
  const x = status?.codex.active ?? 0;
  const d = status?.deepseek?.active ?? 0;
  if (c === 0 && x === 0 && d === 0) return null;

  return (
    <div className="pet-badge-wrap">
      <button
        className="pet-badge"
        onClick={() => setExpanded((v) => !v)}
        title="Toggle token panel"
      >
        {c > 0 && <span className="pet-badge-item claude">C{c}</span>}
        {x > 0 && <span className="pet-badge-item codex">X{x}</span>}
        {d > 0 && <span className="pet-badge-item deepseek">D{d}</span>}
      </button>
      {expanded && status && (
        <div className="pet-token-panel">
          <AgentRow label="Claude" className="claude" status={status.claude} />
          <AgentRow label="Codex" className="codex" status={status.codex} />
          <AgentRow label="DeepSeek" className="deepseek" status={status.deepseek} />
        </div>
      )}
    </div>
  );
}
