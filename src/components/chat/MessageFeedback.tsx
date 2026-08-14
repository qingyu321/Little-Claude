import { useState } from 'react';
import { useFeedbackStore } from '../../stores/feedbackStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';

/**
 * MessageFeedback — DSH ui-message-feedback port: 👍/👎 toggle + optional
 * note, rendered under assistant messages. Persisted per message id.
 */
export function MessageFeedback({ messageId }: { messageId: string }) {
  const t = useT();
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const sessionId = useSessionStore((s) => s.selectedSessionId) ?? '';
  const items = useFeedbackStore((s) => s.items);
  const setRating = useFeedbackStore((s) => s.setRating);
  const setNote = useFeedbackStore((s) => s.setNote);

  const item = items[sessionId]?.[messageId];
  const rating = item?.rating;

  const submitNote = () => {
    setNote(sessionId, messageId, noteText);
    setNoteOpen(false);
    setNoteText('');
  };

  return (
    <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100
      transition-opacity duration-150 select-none">
      <button
        onClick={() => setRating(sessionId, messageId, 'positive')}
        aria-pressed={rating === 'positive'}
        title={t('feedback.positive')}
        className={`w-6 h-6 rounded-md flex items-center justify-center transition-smooth
          ${rating === 'positive'
            ? 'text-success bg-success/10'
            : 'text-text-tertiary hover:text-text-primary hover:bg-bg-layer-2'}`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 14V7M2 7L4 3.5A2 2 0 0 1 5.7 2.8h4.6a1.5 1.5 0 0 1 1.5 1.6l-.6 3.6a1 1 0 0 1-1 .8H10" />
          <path d="M10 7.5l1.2 4.6a1.8 1.8 0 0 1-1.7 2.2H6.5a1.5 1.5 0 0 1-1.5-1.5V7" />
        </svg>
      </button>
      <button
        onClick={() => setRating(sessionId, messageId, 'negative')}
        aria-pressed={rating === 'negative'}
        title={t('feedback.negative')}
        className={`w-6 h-6 rounded-md flex items-center justify-center transition-smooth
          ${rating === 'negative'
            ? 'text-error bg-error/10'
            : 'text-text-tertiary hover:text-text-primary hover:bg-bg-layer-2'}`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v7M14 9l-2 3.5A2 2 0 0 1 10.3 13H5.7a1.5 1.5 0 0 1-1.5-1.6l.6-3.6a1 1 0 0 1 1-.8H6" />
          <path d="M6 8.5L4.8 3.9a1.8 1.8 0 0 1 1.7-2.2h3.5a1.5 1.5 0 0 1 1.5 1.5v5" />
        </svg>
      </button>
      {rating && !noteOpen && (
        <button
          onClick={() => { setNoteText(item?.note ?? ''); setNoteOpen(true); }}
          className="px-1.5 py-0.5 rounded-md text-[10px] text-text-tertiary
            hover:text-text-primary hover:bg-bg-layer-2 transition-smooth"
        >
          {item?.note ? (
            <span className="max-w-[220px] truncate inline-block align-bottom">
              📝 {item.note}
            </span>
          ) : (
            t('feedback.noteAdd')
          )}
        </button>
      )}
      {rating && noteOpen && (
        <span className="inline-flex items-center gap-1">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitNote(); }
              if (e.key === 'Escape') setNoteOpen(false);
            }}
            rows={2}
            autoFocus
            placeholder={t('feedback.notePlaceholder')}
            className="w-56 px-2 py-1 rounded-md text-[11px] resize-none outline-none
              bg-bg-layer-1 border border-border-l2 text-text-primary
              focus:border-border-focus"
          />
          <button
            onClick={submitNote}
            className="px-2 py-1 rounded-md text-[10px] font-medium
              bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
          >
            {t('feedback.noteSave')}
          </button>
          <button
            onClick={() => setNoteOpen(false)}
            className="px-1.5 py-1 rounded-md text-[10px] text-text-tertiary
              hover:text-text-primary hover:bg-bg-layer-2 transition-smooth"
          >
            {t('feedback.noteCancel')}
          </button>
        </span>
      )}
    </div>
  );
}
