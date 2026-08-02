import { useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { getLatestReleaseUrl } from '../../hooks/useAutoUpdateCheck';
import { useT } from '../../lib/i18n';

/**
 * Compact update notification in the top bar.
 * - Checks GitHub Releases API (via useAutoUpdateCheck) every 10 min.
 * - When a newer version is found, shows the version badge.
 * - Clicking opens the browser to the GitHub releases page for manual download.
 * - Portable EXE: no installer, no auto-download, no silent updates.
 */
export function UpdateButton() {
  const updateAvailable = useSettingsStore((s) => s.updateAvailable);
  const updateVersion = useSettingsStore((s) => s.updateVersion);
  const t = useT();

  const handleClick = useCallback(() => {
    const url = getLatestReleaseUrl();
    window.open(url, '_blank');
  }, []);

  if (!updateAvailable) return null;

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium
        transition-smooth mr-1
        bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20"
      title={`${t('update.available')} v${updateVersion}`}
    >
      {/* Download/arrow-up icon */}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2v6M3.5 5.5L6 8l2.5-2.5M2 10h8" />
      </svg>
      <span>v{updateVersion}</span>
    </button>
  );
}
