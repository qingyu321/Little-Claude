declare const __APP_VERSION__: string;

/**
 * App version, injected at build time from package.json (single source of truth,
 * kept in sync with tauri.conf.json by the version bump step).
 */
export const APP_VERSION: string = __APP_VERSION__;
