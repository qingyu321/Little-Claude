import { useState } from 'react';
import { useGoalStore } from '../../stores/goalStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';

/**
 * GoalBar — DSH ui-goal port: docked bar above the composer showing the
 * session goal with pause/resume, inline edit and clear.
 */
export function GoalBar() {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const sessionId = useSessionStore((s) => s.selectedSessionId) ?? '';
  const goal = useGoalStore((s) => (sessionId ? s.goals[sessionId] : undefined));
  const togglePause = useGoalStore((s) => s.togglePause);
  const clearGoal = useGoalStore((s) => s.clearGoal);
  const setGoal = useGoalStore((s) => s.setGoal);

  if (!goal) return null;

  const saveEdit = () => {
    if (draft.trim()) setGoal(sessionId, draft);
    setEditing(false);
  };

  return (
    <div className="mb-1.5 flex items-center gap-2 px-3 py-1.5 rounded-lg
      bg-bg-layer-1 border border-border-subtle animate-fade-in"
      title={goal.objective}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5"
        className={`flex-shrink-0 ${goal.paused ? 'text-text-tertiary' : 'text-ongoing'}`}>
        <circle cx="8" cy="8" r="6" />
        <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
      </svg>
      {editing ? (
        <span className="flex-1 inline-flex items-center gap-1 min-w-0">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
              if (e.key === 'Escape') setEditing(false);
            }}
            autoFocus
            className="flex-1 min-w-0 px-1.5 py-0.5 rounded-md text-[11px] outline-none
              bg-bg-layer-2 border border-border-l2 text-text-primary
              focus:border-border-focus"
          />
          <button
            onClick={saveEdit}
            className="flex-shrink-0 px-2 py-0.5 rounded-md text-[10px] font-medium
              bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
          >
            {t('goal.save')}
          </button>
        </span>
      ) : (
        <>
          <span className={`flex-1 truncate text-[11px] ${goal.paused ? 'text-text-tertiary' : 'text-text-secondary'}`}>
            {goal.objective}
          </span>
          <button
            onClick={() => togglePause(sessionId)}
            title={goal.paused ? t('goal.resume') : t('goal.pause')}
            className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center
              text-text-tertiary hover:text-text-primary hover:bg-bg-layer-2 transition-smooth"
          >
            {goal.paused ? (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                <path d="M3 1.5v9l8-4.5z" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
                <rect x="2" y="1" width="3" height="10" rx="1" />
                <rect x="7" y="1" width="3" height="10" rx="1" />
              </svg>
            )}
          </button>
          <button
            onClick={() => { setDraft(goal.objective); setEditing(true); }}
            title={t('goal.edit')}
            className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center
              text-text-tertiary hover:text-text-primary hover:bg-bg-layer-2 transition-smooth"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
              stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
              <path d="M8.5 1.5l2 2L4.5 9.5l-2.8.8.8-2.8z" />
            </svg>
          </button>
          <button
            onClick={() => clearGoal(sessionId)}
            title={t('goal.clear')}
            className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center
              text-text-tertiary hover:text-error hover:bg-bg-layer-2 transition-smooth"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
              stroke="currentColor" strokeWidth="1.2">
              <path d="M2.5 3.5h7M4.5 3.5V2h3v1.5M4 3.5l.4 6h3.2l.4-6" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
