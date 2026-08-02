// Record the moment the HTML parser reaches this script.
// Kept in public/ (external file) so the production CSP can stay
// script-src 'self' without an inline-script exception.
window.__LITTLE_CLAUDE_PAGE_START = performance.now();
console.log('[little-claude] page start @ 0ms');
