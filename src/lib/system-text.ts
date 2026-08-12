/**
 * Detect system-injected content that should not be shown to users.
 *
 * Shared by session-loader (JSONL reload) and useStreamProcessor (live stream)
 * so both paths hide the same content — CLI continuation summaries after
 * /compact, injected <system-reminder> blocks, and raw conversation leaks.
 * Keep this the single source of truth; the two call sites must stay in sync.
 */
export function isSystemText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<')                            // XML tags like <system-reminder>
    || t.startsWith('This session is being continued') // continuation summaries
    || /^Analysis:\s*\n/.test(t)                       // continuation analysis blocks
    || /^Summary:\s*\n/.test(t)                        // continuation summary blocks
    || t.startsWith('In this environment you have access to') // tool definitions
    || t.startsWith('Human:')                          // raw conversation format leaks
    || t.includes('<system-reminder>')                 // embedded system reminders
    || t.includes('</system-reminder>');
}
