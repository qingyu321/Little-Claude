/**
 * Global type extensions for the Window interface.
 * These properties are used for cross-component coordination of
 * Claude CLI stream listeners and message queues.
 */

interface Window {
  /** Map of stdinId → cleanup function for active Claude CLI stream listeners */
  __claudeUnlisteners?: Record<string, () => void>;

  /** Single stream listener cleanup reference (legacy; prefer __claudeUnlisteners) */
  __claudeUnlisten?: (() => void) | null;

  /** Active stream message handler function */
  __claudeStreamHandler?: ((msg: unknown) => void) | undefined;

  /** Queue of messages received before the stream handler was set up */
  __claudeStreamQueue?: unknown[];

  /** High-resolution timestamp (ms) captured at page load for startup timing */
  __LITTLE_CLAUDE_PAGE_START?: number;
}
