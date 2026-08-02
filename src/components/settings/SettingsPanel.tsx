import { useEffect, useState, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { APP_NAME } from '../../lib/edition';
import { APP_VERSION } from '../../lib/version';
import { ChangelogModal } from '../shared/ChangelogModal';
import { isPermissionError, isNetworkError } from './settingsUtils';
import { GeneralTab } from './GeneralTab';
import { ProviderTab } from './ProviderTab';
import { CliTab } from './CliTab';
import { McpTab } from './McpTab';
import { LocalModelsTab } from './LocalModelsTab';
import { VideoAnalysisTab } from './VideoAnalysisTab';
import { SpeechTab } from './SpeechTab';
import { PrerequisitesTab } from './PrerequisitesTab';
import { ModuleManagementTab } from './ModuleManagementTab';
import InterviewHelperTab from './InterviewHelperTab';

type SettingsTab = 'general' | 'provider' | 'videoAnalysis' | 'speech' | 'cli' | 'localModels' | 'mcp' | 'prerequisites' | 'moduleManagement' | 'interviewHelper';

const TAB_ICONS: Record<SettingsTab, React.ReactNode> = {
  general: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  ),
  provider: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 016 0v2" />
      <circle cx="8" cy="11" r="1" fill="currentColor" />
    </svg>
  ),
  videoAnalysis: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3" width="9" height="10" rx="1.5" />
      <path d="M10.5 6.5L14.5 4v8l-4-2.5" />
      <circle cx="6" cy="8" r="1.5" />
    </svg>
  ),
  speech: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="1" width="4" height="9" rx="2" />
      <path d="M3 7a5 5 0 0010 0" />
      <path d="M8 13v2M5 15h6" />
    </svg>
  ),
  cli: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="2" width="14" height="12" rx="2" />
      <path d="M4 6l3 2.5L4 11M9 11h3" />
    </svg>
  ),
  localModels: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M5 6h6M5 9h3" />
      <circle cx="11" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  mcp: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="1" y="3" width="14" height="4" rx="1.5" />
      <rect x="1" y="9" width="14" height="4" rx="1.5" />
      <circle cx="4" cy="5" r="0.75" fill="currentColor" />
      <circle cx="4" cy="11" r="0.75" fill="currentColor" />
    </svg>
  ),
  prerequisites: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4v4l2.5 2.5" />
      <path d="M5 2h6M8 2v2" />
    </svg>
  ),
  moduleManagement: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
      <path d="M5 5h6M5 8h6M5 11h4" />
    </svg>
  ),
  interviewHelper: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1a3 3 0 013 3v4a3 3 0 01-6 0V4a3 3 0 013-3z" />
      <path d="M4 7v1a4 4 0 008 0V7" />
      <path d="M8 12v3M5 15h6" />
    </svg>
  ),
};

const TAB_ITEMS: { id: SettingsTab; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.tab.general' },
  { id: 'provider', labelKey: 'settings.tab.provider' },
  { id: 'videoAnalysis', labelKey: 'settings.tab.videoAnalysis' },
  { id: 'speech', labelKey: 'settings.tab.speech' },
  { id: 'cli', labelKey: 'settings.tab.cli' },
  { id: 'localModels', labelKey: '本地模型' },
  { id: 'mcp', labelKey: 'settings.tab.mcp' },
  { id: 'prerequisites', labelKey: 'settings.tab.prerequisites' },
  { id: 'moduleManagement', labelKey: 'settings.tab.moduleManagement' },
  { id: 'interviewHelper', labelKey: 'settings.tab.interviewHelper' },
];

export function SettingsPanel() {
  const t = useT();
  const toggleSettings = useSettingsStore((s) => s.toggleSettings);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSettings]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) toggleSettings(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-[min(90vw,960px)] max-h-[85vh] min-h-[500px]
        rounded-2xl bg-bg-card border border-border-subtle shadow-2xl
        overflow-hidden animate-fade-in flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4
          border-b border-border-subtle flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">
            {t('settings.title')}
          </h2>
          <button onClick={toggleSettings}
            className="p-1.5 rounded-lg hover:bg-bg-tertiary
              text-text-tertiary transition-smooth">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex flex-1 min-h-0">
          {/* Tab sidebar */}
          <nav className="w-[160px] border-r border-border-subtle px-2 py-4 space-y-1 flex-shrink-0">
            {TAB_ITEMS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-[13px]
                  font-medium transition-smooth text-left whitespace-nowrap
                  ${activeTab === tab.id
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'
                  }`}
              >
                <span className="flex-shrink-0 opacity-70">{TAB_ICONS[tab.id]}</span>
                {t(tab.labelKey)}
                {tab.id === 'cli' && useSettingsStore.getState().cliUpdateAvailable && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                )}
              </button>
            ))}
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {activeTab === 'general' && <GeneralTab />}
            {activeTab === 'provider' && <ProviderTab />}
            {activeTab === 'videoAnalysis' && <VideoAnalysisTab />}
            {activeTab === 'speech' && <SpeechTab />}
            {activeTab === 'cli' && <CliTab />}
            {activeTab === 'localModels' && <LocalModelsTab />}
            {activeTab === 'mcp' && <McpTab />}
            {activeTab === 'prerequisites' && <PrerequisitesTab />}
            {activeTab === 'moduleManagement' && <ModuleManagementTab />}
            {activeTab === 'interviewHelper' && <InterviewHelperTab />}
          </div>
        </div>

        {/* Footer: version + update */}
        <SettingsFooter />
      </div>
    </div>
  );
}

/* ================================================================
   Footer with version + update controls
   ================================================================ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateStatus = 'idle' | 'checking' | 'available' | 'latest' | 'error';

// Primary: GitHub Releases API
const GITHUB_API = 'https://api.github.com/repos/qingyu321/Little-Claude/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/qingyu321/Little-Claude/releases';

// Fallback: Gitee API (disabled — no Gitee mirror yet; uncomment when ready)
// const GITEE_API = 'https://gitee.com/api/v5/repos/qingyu321/Little-Claude/releases/latest';
// const GITEE_RELEASES_URL = 'https://gitee.com/qingyu321/Little-Claude/releases';

function SettingsFooter() {
  const t = useT();
  const [appVersion] = useState(APP_VERSION);
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [latestVersion, setLatestVersion] = useState('');
  const [latestUrl, setLatestUrl] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showChangelog, setShowChangelog] = useState(false);
  const storeUpdateVersion = useSettingsStore((s) => s.updateVersion);

  // Pre-fill from auto-check result
  useEffect(() => {
    if (storeUpdateVersion && status === 'idle') {
      setLatestVersion(storeUpdateVersion);
      setStatus('available');
    }
  }, [storeUpdateVersion]);

  const handleCheck = useCallback(async () => {
    setStatus('checking');
    setErrorMsg('');
    let lastError = '';

    const tryFetch = async (apiUrl: string, releasesUrl: string): Promise<boolean> => {
      try {
        const resp = await fetch(apiUrl, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const tag = data?.tag_name || '';
        if (!tag) throw new Error('No tag_name in response');
        setLatestVersion(tag.replace(/^v/, ''));
        setLatestUrl(data?.html_url || `${releasesUrl}/tag/${tag}`);
        setStatus('available');
        return true;
      } catch (e) {
        lastError = String(e);
        return false;
      }
    };

    // Try GitHub (Gitee fallback disabled — no mirror yet; uncomment when ready)
    const ok = await tryFetch(GITHUB_API, GITHUB_RELEASES_URL);
    if (!ok) {
      // const giteeOk = await tryFetch(GITEE_API, GITEE_RELEASES_URL);
      // if (!giteeOk) {
        setErrorMsg(lastError);
        setStatus('error');
      // }
    }
  }, []);

  const handleOpenRelease = useCallback(() => {
    const url = latestUrl || `${GITHUB_RELEASES_URL}/latest`;
    window.open(url, '_blank');
  }, [latestUrl]);

  return (
    <>
      <div className="flex items-center justify-between px-6 h-10
        border-t border-border-subtle bg-bg-secondary/30 flex-shrink-0">
        {/* Left: version */}
        <span className="text-xs text-text-tertiary flex items-center gap-1.5">
          <svg width="11" height="11" viewBox="0 0 171 171" fill="none" className="flex-shrink-0 opacity-60">
            <path d="M66.79 58.73L40.33 85.19L66.79 111.66L57.53 120.92L21.8 85.19L57.53 49.47Z" fill="currentColor" />
            <path d="M111.5 49.47L147.22 85.19L111.5 120.92L102.24 111.66L128.7 85.19L102.24 58.73Z" fill="currentColor" />
            <path d="M90.01 39.92L102.01 39.92L79.24 129.92L67.24 129.92L79.24 81.92Z" className="fill-accent" />
          </svg>
          {APP_NAME} v{appVersion}
        </span>

        {/* Right: action buttons */}
        <div className="flex items-center gap-2">
          {/* Changelog */}
          <button
            onClick={() => setShowChangelog(true)}
            className="px-2.5 py-1 text-xs font-medium rounded-md
              text-text-muted hover:bg-bg-secondary hover:text-text-primary transition-smooth"
          >
            {t('settings.footer.changelog')}
          </button>

          {/* Update controls — inline in footer */}
          {status === 'idle' && (
            <button
              onClick={handleCheck}
              className="px-2.5 py-1 text-xs font-medium rounded-md
                border border-border-subtle text-text-muted
                hover:bg-bg-secondary hover:text-text-primary transition-smooth"
            >
              {t('settings.footer.checkUpdate')}
            </button>
          )}

          {status === 'checking' && (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <span className="w-3 h-3 border-[1.5px] border-accent/30
                border-t-accent rounded-full animate-spin" />
              {t('update.checking')}
            </span>
          )}

          {status === 'latest' && (
            <span className="text-xs text-green-500 font-medium">
              {t('settings.footer.upToDate')}
            </span>
          )}

          {status === 'available' && (
            <button
              onClick={handleOpenRelease}
              className="px-2.5 py-1 text-xs font-medium rounded-md
                bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
            >
              {t('update.available')} v{latestVersion}
            </button>
          )}

          {status === 'error' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-500" title={errorMsg}>
                {t('update.error')}
              </span>
              {isPermissionError(errorMsg) && (
                <span className="text-[10px] text-amber-500">
                  {t('error.permissionHint')}
                </span>
              )}
              {isNetworkError(errorMsg) && (
                <span className="text-[10px] text-amber-500">
                  {t('network.firewallHint')}
                </span>
              )}
              <button
                onClick={handleCheck}
                className="px-2 py-0.5 text-xs text-text-muted hover:text-text-primary transition-smooth"
              >
                {t('cli.retry')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Changelog modal */}
      {showChangelog && appVersion && (
        <ChangelogModal
          version={appVersion}
          onClose={() => setShowChangelog(false)}
        />
      )}
    </>
  );
}
