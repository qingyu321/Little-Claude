/**
 * Controlled debug logging for Little Claude.
 *
 * In production builds (Vite `import.meta.env.PROD`), debug logs are suppressed
 * to avoid leaking runtime internals to the console. In development, all log
 * channels output normally.
 *
 * Usage:
 *   import { debugLog } from '../lib/debug-log';
 *   debugLog('stream', 'message received', { type: 'text' });
 */

type LogChannel =
  | 'stream'
  | 'route'
  | 'session'
  | 'mimo'
  | 'mimo-perf'
  | 'local-asr'
  | 'sys-audio'
  | 'auto-compact'
  | 'provider'
  | 'file-tree'
  | 'rewind'
  | 'general';

const isProduction: boolean = import.meta.env.PROD;

/** Main debug log function. Silently no-ops in production. */
export function debugLog(channel: LogChannel, ...args: unknown[]): void {
  if (isProduction) return;
  const prefix = `[LITTLECLAUDE:${channel}]`;
  console.log(prefix, ...args);
}

/** Unconditional error log (always outputs, even in production). */
export function debugError(channel: LogChannel, ...args: unknown[]): void {
  const prefix = `[LITTLECLAUDE:${channel}]`;
  console.error(prefix, ...args);
}

/** Unconditional warning log (always outputs, even in production). */
export function debugWarn(channel: LogChannel, ...args: unknown[]): void {
  const prefix = `[LITTLECLAUDE:${channel}]`;
  console.warn(prefix, ...args);
}
