import { useEffect, useState, useCallback, useRef } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { APP_NAME } from '../../lib/edition';
import { APP_VERSION } from '../../lib/version';
import { ChangelogModal } from '../shared/ChangelogModal';
import { isPermissionError, isNetworkError } from './settingsUtils';
import { bridge, onUpdateProgress } from '../../lib/tauri-bridge';
import { friendlyError } from '../../lib/error-format';
import {
  checkForUpdatesNow,
  currentWebVersion,
  getLatestReleaseUrl,
  getLatestVersion,
  recordAppliedWebVersion,
  type UpdateInfo,
} from '../../hooks/useAutoUpdateCheck';
import { relaunch } from '@tauri-apps/plugin-process';
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
import { PetTab } from './PetTab';

type SettingsTab = 'general' | 'provider' | 'videoAnalysis' | 'speech' | 'cli' | 'localModels' | 'mcp' | 'prerequisites' | 'moduleManagement' | 'interviewHelper' | 'pet';

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
  pet: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="8" cy="11" rx="4.5" ry="3.2" />
      <circle cx="5" cy="6.5" r="1.1" />
      <circle cx="11" cy="6.5" r="1.1" />
      <path d="M4.5 5.2L3 2.5M11.5 5.2L13 2.5M8 5.8V3" />
    </svg>
  ),
};

const TAB_ITEMS: { id: SettingsTab; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.tab.general' },
  { id: 'provider', labelKey: 'settings.tab.provider' },
  { id: 'videoAnalysis', labelKey: 'settings.tab.videoAnalysis' },
  { id: 'speech', labelKey: 'settings.tab.speech' },
  { id: 'cli', labelKey: 'settings.tab.cli' },
  { id: 'localModels', labelKey: 'settings.tab.localModels' },
  { id: 'mcp', labelKey: 'settings.tab.mcp' },
  { id: 'prerequisites', labelKey: 'settings.tab.prerequisites' },
  { id: 'moduleManagement', labelKey: 'settings.tab.moduleManagement' },
  { id: 'interviewHelper', labelKey: 'settings.tab.interviewHelper' },
  { id: 'pet', labelKey: 'settings.tab.pet' },
];

export function SettingsPanel() {
  const t = useT();
  const toggleSettings = useSettingsStore((s) => s.toggleSettings);
  const settingsOpenRequest = useSettingsStore((s) => s.settingsOpenRequest);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Pet window "设置" → open on the requested tab (③-2). Covers both mounts
  // (panel closed → request set before toggleSettings opens it) and an already
  // open panel (request changes while mounted → switch tab, don't close).
  // The request is one-shot: consumed here, then cleared.
  useEffect(() => {
    if (settingsOpenRequest?.tab) {
      setActiveTab(settingsOpenRequest.tab as SettingsTab);
      useSettingsStore.getState().setSettingsOpenRequest(null);
    }
  }, [settingsOpenRequest]);

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
            {activeTab === 'pet' && <PetTab />}
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
type DownloadState = 'idle' | 'downloading' | 'done' | 'error';

function SettingsFooter() {
  const t = useT();
  const [appVersion] = useState(APP_VERSION);
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [showChangelog, setShowChangelog] = useState(false);
  const [webVersion, setWebVersion] = useState(currentWebVersion());

  // 热更下载状态
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [progress, setProgress] = useState<{
    downloaded: number;
    total: number | null;
    phase: string;
  }>({ downloaded: 0, total: null, phase: 'download' });
  const [downloadError, setDownloadError] = useState('');
  const unlistenRef = useRef<(() => void) | null>(null);

  const storeUpdateVersion = useSettingsStore((s) => s.updateVersion);

  // Pre-fill from auto-check result
  useEffect(() => {
    if (storeUpdateVersion && status === 'idle') {
      setUpdateInfo(getLatestVersion());
      setStatus('available');
    }
  }, [storeUpdateVersion]);

  // 卸载时清理进度事件监听
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const handleCheck = useCallback(async () => {
    setStatus('checking');
    setErrorMsg('');
    try {
      const { info, outcome } = await checkForUpdatesNow();
      if (outcome === 'updated' && info) {
        setUpdateInfo(info);
        setStatus('available');
      } else if (outcome === 'latest') {
        setUpdateInfo(null);
        setStatus('latest');
      } else {
        setErrorMsg(t('update.checkFailed'));
        setStatus('error');
      }
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setErrorMsg(friendlyError(String(e)));
      setStatus('error');
    }
  }, [t]);

  const handleOpenRelease = useCallback(() => {
    const url = updateInfo?.url || getLatestReleaseUrl();
    window.open(url, '_blank');
  }, [updateInfo]);

  const handleUpdate = useCallback(async () => {
    if (!updateInfo) return;
    setDownloadState('downloading');
    setDownloadError('');
    setProgress({ downloaded: 0, total: null, phase: 'download' });
    try {
      const unlisten = await onUpdateProgress((ev) => {
        if (ev.phase === 'error') {
          setDownloadError(ev.message || t('update.error'));
          setDownloadState('error');
        } else {
          setProgress({ downloaded: ev.downloaded, total: ev.total, phase: ev.phase });
        }
      });
      unlistenRef.current = unlisten;
      await bridge.downloadWebUpdate(updateInfo.zipUrl, updateInfo.sha256, updateInfo.version);
      // Rust 侧切换成功后会 emit done 事件；再显式兜底一次
      setDownloadState('done');
      recordAppliedWebVersion(updateInfo.version);
      setWebVersion(updateInfo.version.replace(/^v/, ''));
    } catch (e) {
      // A5: 原始错误经分类器转成友好文案
      setDownloadError(friendlyError(String(e)));
      setDownloadState('error');
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }, [updateInfo, t]);

  const handleRestart = useCallback(async () => {
    try {
      await relaunch();
    } catch {
      // 重启失败（如纯浏览器预览）→ 回退刷新页面
      window.location.reload();
    }
  }, []);

  const phaseLabel = useCallback(
    (phase: string) => {
      switch (phase) {
        case 'download':
          return t('update.downloading');
        case 'verify':
          return t('update.verifying');
        case 'extract':
          return t('update.extracting');
        case 'switching':
          return t('update.switching');
        default:
          return '';
      }
    },
    [t]
  );

  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

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
          {webVersion && webVersion !== appVersion && (
            <span className="text-accent/90">
              · {t('settings.footer.webVersion')} v{webVersion}
            </span>
          )}
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

          {status === 'available' && downloadState === 'idle' && (
            updateInfo && !updateInfo.rustChanged ? (
              <button
                onClick={handleUpdate}
                className="px-2.5 py-1 text-xs font-medium rounded-md
                  bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
              >
                {t('update.toLatest')} v{updateInfo.version}
              </button>
            ) : (
              <button
                onClick={handleOpenRelease}
                title={updateInfo?.rustChanged ? t('update.engineHint') : undefined}
                className="px-2.5 py-1 text-xs font-medium rounded-md
                  bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
              >
                {t('update.installPackage')}
                {updateInfo && ` v${updateInfo.version}`}
              </button>
            )
          )}

          {downloadState === 'downloading' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">{phaseLabel(progress.phase)}</span>
              <div className="w-28 h-1 bg-bg-secondary rounded-full overflow-hidden">
                <div
                  className={`h-full bg-accent rounded-full transition-all ${
                    pct == null ? 'animate-pulse opacity-50' : ''
                  }`}
                  style={{ width: pct == null ? '100%' : `${pct}%` }}
                />
              </div>
              <span className="text-xs text-text-tertiary tabular-nums">
                {pct == null ? '--' : `${pct}%`}
              </span>
            </div>
          )}

          {downloadState === 'done' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-green-500 font-medium">
                ✓ {t('update.downloadDone')}
              </span>
              <button
                onClick={handleRestart}
                className="px-2.5 py-1 text-xs font-medium rounded-md
                  bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
              >
                {t('update.restartNow')}
              </button>
            </div>
          )}

          {downloadState === 'error' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-500" title={downloadError}>
                {t('update.error')}
              </span>
              <button
                onClick={() => {
                  setDownloadState('idle');
                  handleUpdate();
                }}
                className="px-2 py-0.5 text-xs text-text-muted hover:text-text-primary transition-smooth"
              >
                {t('cli.retry')}
              </button>
            </div>
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
