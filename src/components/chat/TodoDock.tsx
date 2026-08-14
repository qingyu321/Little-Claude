import { useState } from 'react';
import { useTodoStore, TodoStatus } from '../../stores/todoStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';

/**
 * TodoDock — DSH ui-conversation TodoDock port: the model's standing task list
 * (todo/write) docked above the composer. Header shows per-status counts
 * (`N 完成 · N 进行中 · N 待办`, zero segments omitted); rows show the status
 * glyph: pending = hollow circle, in_progress = spinning ring, completed = check.
 */
export function TodoDock() {
  const t = useT();
  const [open, setOpen] = useState(true);
  const sessionId = useSessionStore((s) => s.selectedSessionId) ?? '';
  const items = useTodoStore((s) => (sessionId ? s.todos[sessionId] : undefined));

  if (!items || items.length === 0) return null;

  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;

  const countSegments = [
    counts.completed > 0 ? `${counts.completed} ${t('todo.completed')}` : null,
    counts.in_progress > 0 ? `${counts.in_progress} ${t('todo.inProgress')}` : null,
    counts.pending > 0 ? `${counts.pending} ${t('todo.pending')}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mb-1.5 rounded-lg bg-bg-layer-1 border border-border-subtle animate-fade-in overflow-hidden">
      {/* Header — collapsed by default in DSH; counts always visible */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none"
        onClick={() => setOpen(!open)}
        title={open ? t('todo.collapse') : t('todo.expand')}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="text-ongoing flex-shrink-0">
          <rect x="2" y="3" width="10" height="10" rx="2" />
          <path d="M5.5 8l2 2 3.5-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="flex-1 text-[11px] text-text-secondary truncate">
          {t('todo.title')} {items.length}
        </span>
        <span className="text-[10px] text-text-tertiary tabular-nums shrink-0">
          {countSegments}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`text-text-tertiary transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          <path d="M3 2l4 3-4 3" />
        </svg>
      </div>

      {/* Rows — pending ○ / in_progress ◐ spinning / completed ✓ */}
      {open && (
        <ul className="px-3 pb-1.5 max-h-44 overflow-y-auto">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-2 py-0.5 min-w-0">
              <StatusGlyph status={it.status} />
              <span className={`flex-1 truncate text-[11px] ${
                it.status === 'completed'
                  ? 'text-text-tertiary line-through'
                  : it.status === 'in_progress'
                    ? 'text-text-primary'
                    : 'text-text-secondary'
              }`}>
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
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
        <circle cx="8" cy="8" r="7" className="fill-ongoing/15 stroke-ongoing" strokeWidth="1.2" />
        <path d="M5 8.2l2 2 4-4.4" stroke="currentColor" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round" className="text-ongoing" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
        <circle cx="8" cy="8" r="6.5" className="stroke-text-tertiary/40" strokeWidth="1.5" />
        <circle cx="8" cy="8" r="6.5" className="stroke-ongoing animate-spin"
          strokeWidth="1.5" strokeLinecap="round"
          strokeDasharray="24 18" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <circle cx="8" cy="8" r="6.5" className="stroke-text-tertiary/50" strokeWidth="1.2" />
    </svg>
  );
}
