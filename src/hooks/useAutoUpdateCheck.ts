import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const APP_VERSION = '1.1.0'; // synced with tauri.conf.json

// Primary: GitHub Releases API
const GITHUB_API = 'https://api.github.com/repos/qingyu321/Little-Claude/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/qingyu321/Little-Claude/releases';

// Fallback: Gitee API (disabled — no Gitee mirror yet; uncomment when ready)
// const GITEE_API = 'https://gitee.com/api/v5/repos/qingyu321/Little-Claude/releases/latest';
// const GITEE_RELEASES_URL = 'https://gitee.com/qingyu321/Little-Claude/releases';

/** Cached latest version info from the most recent successful check. */
let _cachedLatest: { version: string; url: string } | null = null;

export function getLatestVersion(): { version: string; url: string } | null {
  return _cachedLatest;
}

/** Compare two semver-like version strings. Returns true if `latest > current`. */
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, '').split('.').map(Number).concat(0, 0, 0).slice(0, 3);
  const [l0, l1, l2] = parse(latest);
  const [c0, c1, c2] = parse(current);
  if (l0 !== c0) return l0 > c0;
  if (l1 !== c1) return l1 > c1;
  return l2 > c2;
}

/**
 * Fetch latest release from a GitHub-compatible API endpoint.
 * Returns { tagName, htmlUrl } or null on failure.
 */
async function fetchLatest(apiUrl: string, releasesUrl: string): Promise<{ version: string; url: string } | null> {
  try {
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const tagName: string = data?.tag_name || '';
    if (!tagName) return null;
    return {
      version: tagName,
      url: data?.html_url || `${releasesUrl}/tag/${tagName}`,
    };
  } catch {
    return null;
  }
}

async function doCheck(): Promise<void> {
  // Try GitHub first
  const result = await fetchLatest(GITHUB_API, GITHUB_RELEASES_URL);

  // Gitee fallback disabled (no mirror yet — uncomment when ready)
  // if (!result) {
  //   result = await fetchLatest(GITEE_API, GITEE_RELEASES_URL);
  // }

  if (result && isNewer(result.version, APP_VERSION)) {
    _cachedLatest = result;
    useSettingsStore.getState().setUpdateAvailable(true, result.version.replace(/^v/, ''));
  } else if (result) {
    _cachedLatest = null;
    useSettingsStore.getState().setUpdateAvailable(false);
  }
  // If both failed, keep previous cached result and don't clear the UI
}

/** URL to the latest release (for manual download). */
export function getLatestReleaseUrl(): string {
  return _cachedLatest?.url || GITHUB_RELEASES_URL + '/latest';
}

/**
 * Checks GitHub Releases for updates on startup (5s delay) and then every 10 minutes.
 * Falls back to Gitee API if GitHub is unreachable.
 * When an update is found, the UpdateButton shows the new version.
 * Clicking opens the browser to the releases page for manual download.
 * No auto-download, no installer, no restart — just a notification.
 */
export function useAutoUpdateCheck(): void {
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;

    // Initial check after 5s
    const startupTimer = setTimeout(doCheck, 5000);

    // Periodic check every 10 minutes
    const intervalTimer = setInterval(doCheck, CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
    };
  }, []);
}
