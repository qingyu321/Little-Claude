/**
 * Utility for managing Claude CLI stream listener cleanup.
 *
 * Multiple components (InputBar, ChatPanel, useStreamProcessor, useRewind)
 * register Tauri event listeners for Claude CLI output streams. These are
 * stored on `window.__claudeUnlisteners` keyed by stdinId so any component
 * can tear them down when a session ends or is replaced.
 */

/** Call and remove the cleanup function for a given stdinId. */
export function cleanupStreamListener(stdinId: string): void {
  if (window.__claudeUnlisteners?.[stdinId]) {
    window.__claudeUnlisteners[stdinId]();
    delete window.__claudeUnlisteners[stdinId];
  }
}

/** Register a cleanup function for a given stdinId, creating the map if needed. */
export function registerStreamListener(stdinId: string, cleanup: () => void): void {
  if (!window.__claudeUnlisteners) {
    window.__claudeUnlisteners = {};
  }
  window.__claudeUnlisteners[stdinId] = cleanup;
}

/** Clear the legacy single-listener reference. */
export function clearLegacyListener(): void {
  if (window.__claudeUnlisten) {
    window.__claudeUnlisten = null;
  }
}
