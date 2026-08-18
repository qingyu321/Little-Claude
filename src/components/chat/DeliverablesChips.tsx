import { useMemo } from 'react';
import { type ChatMessage } from '../../stores/chatStore';
import { useFileStore } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { isPathInsideWorkspace } from '../../lib/path-safety';
import { useT } from '../../lib/i18n';

/**
 * Collect produced files for one assistant turn (DSH ui-deliverables port):
 * paths from successful Edit/Write tool calls — read/delete/failed calls
 * produce nothing, matching DSH's render-intent-driven extraction.
 */
export function collectTurnDeliverables(
  messages: ChatMessage[],
  userIdx: number,
): string[] {
  const paths: string[] = [];
  for (let j = userIdx - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role === 'user') break;
    if (m.type === 'tool_use') {
      const name = m.toolName;
      if (name === 'Edit' || name === 'Write') {
        const result = m.toolResultContent;
        // Failed tool results begin with "Error:" — failed calls produce nothing
        const failed = typeof result === 'string' && result.startsWith('Error');
        const input = m.toolInput as { file_path?: string } | undefined;
        if (!failed && input?.file_path && !paths.includes(input.file_path)) {
          paths.push(input.file_path);
        }
      }
    }
  }
  return paths;
}

/** Turn-tail chips: "产物" + clickable file paths (≤6, DSH SHOWN_LIMIT) */
export function DeliverablesChips({ paths }: { paths: string[] }) {
  const t = useT();
  const shown = useMemo(() => paths.slice(0, 6), [paths]);
  const hidden = paths.length - shown.length;

  if (paths.length === 0) return null;

  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] text-text-tertiary select-none">
        {t('deliverables.label')}
      </span>
      {shown.map((p) => {
        const name = p.split(/[\\/]/).pop() || p;
        // Paths come from Edit/Write tool input (model output) — only paths
        // that resolve inside the working directory are clickable.
        const wd = useSettingsStore.getState().workingDirectory || '';
        const safe = isPathInsideWorkspace(p, wd);
        if (!safe) {
          return (
            <span
              key={p}
              title={p}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
                bg-bg-layer-1 border border-border-l2
                text-[10px] font-mono text-text-tertiary
                max-w-[220px]"
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.2" className="flex-shrink-0">
                <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
                <path d="M7 1v3h3" />
              </svg>
              <span className="truncate">{name}</span>
            </span>
          );
        }
        return (
          <button
            key={p}
            onClick={() => useFileStore.getState().selectFile(p)}
            title={p}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md
              bg-bg-layer-1 border border-border-l2
              text-[10px] font-mono text-text-secondary
              hover:bg-bg-layer-2 hover:border-border-l3 hover:text-text-primary
              transition-smooth cursor-pointer max-w-[220px]"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
              stroke="currentColor" strokeWidth="1.2" className="flex-shrink-0">
              <path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z" />
              <path d="M7 1v3h3" />
            </svg>
            <span className="truncate">{name}</span>
          </button>
        );
      })}
      {hidden > 0 && (
        <span className="text-[10px] text-text-tertiary select-none">
          + {hidden} {t('deliverables.more')}
        </span>
      )}
    </div>
  );
}
