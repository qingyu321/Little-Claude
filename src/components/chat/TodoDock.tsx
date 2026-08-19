import { useState } from 'react';
import { useTodoStore, TodoStatus } from '../../stores/todoStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';

/**
 * TodoDock — 1:1 port of the DeepSeek Harness `conversation.input.dock` TodoDock
 * (dsh-client-ui-conversation). The model's standing task list docked above the
 * composer:
 *   - header = lead checklist icon + title (`todo.title`, NO count) +
 *     `.progress` counts (done → active → pending, zero segments omitted,
 *     `\u2009·\u2009` narrow-space separators) + chevron.
 *   - chevron is OPPOSITE to the semantics: collapsed shows UP, expanded shows
 *     DOWN (icon-up when folded).
 *   - collapsed by default; rows only render when expanded.
 *   - completed = ring + filled check (green) — text is NOT struck through;
 *     in_progress = single ring with gradient + whole-SVG 1s linear spin
 *     (business blue); pending = dashed ring (caption grey).
 */

// DSH IconChecklistOutline14 (primitives index.js) — 14×14 artboard.
function CheckListIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
      <path d="M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z" fill="currentColor" />
      <path d="M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z" fill="currentColor" />
      <path fill="currentColor" d="M4.64512 10.336C4.64512 9.23243 3.74569 8.333 2.64212 8.333C1.53855 8.333 0.639128 9.23243 0.639128 10.336C0.639128 11.4396 1.53855 12.339 2.64212 12.339C3.74569 12.339 4.64512 11.4396 4.64512 10.336ZM2.64212 9.91297C2.33045 9.91297 2.0776 10.0244 2.0776 10.336C2.0776 10.6477 2.33045 10.7591 2.64212 10.7591C2.95379 10.7591 3.20664 10.6477 3.20664 10.336C3.20664 10.0244 2.95379 9.91297 2.64212 9.91297Z" />
      <path fill="currentColor" d="M4.64531 3.6123C4.64531 2.50873 3.74589 1.6093 2.64232 1.6093C1.53875 1.6093 0.639328 2.50873 0.639328 3.6123C0.639328 4.71587 1.53875 5.6153 2.64232 5.6153C3.74589 5.6153 4.64531 4.71587 4.64531 3.6123ZM2.64232 3.18917C2.33065 3.18917 2.0778 3.30061 2.0778 3.6123C2.0778 3.92396 2.33065 4.0354 2.64232 4.0354C2.95399 4.0354 3.20684 3.92396 3.20684 3.6123C3.20684 3.30061 2.95399 3.18917 2.64232 3.18917Z" />
    </svg>
  );
}

export function TodoDock() {
  const t = useT();
  // DSH: `useState(true)` is a `collapsed` flag — collapsed by default.
  const [collapsed, setCollapsed] = useState(true);
  const sessionId = useSessionStore((s) => s.selectedSessionId) ?? '';
  const items = useTodoStore((s) => (sessionId ? s.todos[sessionId] : undefined));

  if (!items || items.length === 0) return null;

  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;

  // DSH `progressLabel`: done → active → pending, zero segments omitted,
  // narrow-space `\u2009·\u2009` separators.
  const countSegments = [
    counts.completed > 0 ? `${counts.completed} ${t('todo.completed')}` : null,
    counts.in_progress > 0 ? `${counts.in_progress} ${t('todo.inProgress')}` : null,
    counts.pending > 0 ? `${counts.pending} ${t('todo.pending')}` : null,
  ].filter(Boolean).join('\u2009·\u2009');

  const open = !collapsed;

  return (
    <div
      data-testid="todo-panel"
      aria-label={t('todo.title')}
      className="mb-1.5 rounded-xl bg-bg-layer-1 border border-border-subtle animate-fade-in overflow-hidden"
    >
      {/* Header button — title WITHOUT count; counts in the progress segment;
          chevron opposite to semantics (up when folded). */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 cursor-pointer select-none text-left
          hover:bg-bg-layer-2 transition-smooth"
        title={open ? t('todo.collapse') : t('todo.expand')}
      >
        <span className="text-text-tertiary flex-none grid place-items-center">
          <CheckListIcon />
        </span>
        <span className="flex-none text-[13px] font-medium text-text-primary truncate">
          {t('todo.title')}
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-text-tertiary truncate">
          {countSegments}
        </span>
        <span className="text-text-tertiary flex-none grid place-items-center">
          <svg width="10" height="10" viewBox="0 0 14 14" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            {collapsed
              ? <path d="M3 10.5L7 6.5l4 4" />
              : <path d="M3 3.5L7 7.5l4-4" />}
          </svg>
        </span>
      </button>

      {open && (
        <ul className="flex flex-col gap-2 max-h-[180px] px-3 pb-2 pt-0.5 overflow-y-auto">
          {items.map((it, i) => (
            <li key={i} data-status={it.status}
              className="flex items-center gap-2.5 min-w-0 text-[13px] leading-5 text-text-secondary">
              <span className="w-4 h-4 flex-none grid place-items-center">
                <StatusGlyph status={it.status} />
              </span>
              <span className="flex-1 truncate min-w-0">
                {it.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusGlyph({ status }: { status: TodoStatus }) {
  if (status === 'completed') {
    // DSH CompletedGlyph: ring (stroke) + filled check, success-green.
    // NO strikethrough on the text — the green ring+check distinguishes it.
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden
        className="flex-shrink-0 text-success">
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
        <path
          fill="currentColor"
          d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        />
      </svg>
    );
  }
  if (status === 'in_progress') {
    // DSH ProgressGlyph: single ring with a currentColor→transparent gradient,
    // the whole SVG rotates 1s linear infinite (business blue).
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden
        className="flex-shrink-0 text-ongoing animate-spin">
        <defs>
          <linearGradient id="dshTodoProgressGrad" x1="2.5" y1="12" x2="10.5" y2="3.5"
            gradientUnits="userSpaceOnUse">
            <stop stopColor="currentColor" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="7" cy="7" r="6.4" stroke="url(#dshTodoProgressGrad)" strokeWidth="1.2" />
      </svg>
    );
  }
  // DSH PendingGlyph: dashed hollow ring (caption grey).
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden
      className="flex-shrink-0 text-text-tertiary">
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  );
}
