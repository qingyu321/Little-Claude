import { useState, lazy, Suspense } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore, MODEL_OPTIONS } from '../../stores/settingsStore';
import { useChatStore, useActiveTab } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useT } from '../../lib/i18n';
import { useAgentStore } from '../../stores/agentStore';
import { useInterviewStore } from '../../stores/interviewStore';
import { IS_ALPHA } from '../../lib/edition';
import { displayDeepSeekModelName } from '../../lib/model-utils';

// P2: App chunk 再拆分——会话列表子树（ConversationList + SessionGroup/SessionItem/
// SessionContextMenu/ConversationSearch）整体移出 App chunk；ProfileStatsModal
// 仅在点头像打开资料时加载。两者均为低频/按需场景，与 App.tsx 的 lazy 模式一致。
const ConversationList = lazy(() => import('../conversations/ConversationList').then(m => ({ default: m.ConversationList })));
const ProfileStatsModal = lazy(() => import('../profile/ProfileStatsModal').then(m => ({ default: m.ProfileStatsModal })));

/** Map raw model ID to friendly display name */
function getModelDisplayName(modelId: string): string {
  const option = MODEL_OPTIONS.find((m) => modelId.includes(m.id));
  return option?.short || displayDeepSeekModelName(modelId);
}

/** Format token count: 1234 → "1.2k", 123456 → "123k", 1234567 → "1.2M" */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

export function Sidebar() {
  const [profileOpen, setProfileOpen] = useState(false);
  const backgroundTheme = useSettingsStore((s) => s.backgroundTheme);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const toggleSettings = useSettingsStore((s) => s.toggleSettings);
  const setSecondaryTab = useSettingsStore((s) => s.setSecondaryTab);
  const updateAvailable = useSettingsStore((s) => s.updateAvailable);
  const cliUpdateAvailable = useSettingsStore((s) => s.cliUpdateAvailable);
  const sessionMeta = useActiveTab((t) => t.sessionMeta);
  const sessionStatus = useActiveTab((t) => t.sessionStatus);
  const interviewActive = useInterviewStore((s) => s.active);
  const previewSidebarVisible = useSettingsStore((s) => s.previewSidebarVisible);
  const skillsSidebarVisible = useSettingsStore((s) => s.skillsSidebarVisible);
  const interviewSidebarVisible = useSettingsStore((s) => s.interviewSidebarVisible);
  const t = useT();
  const activeTab = useSettingsStore((s) => s.secondaryPanelTab);

  /** DSH nav-item three states: hover layer-1, active layer-3 (bluish-100/800) */
  const navItemClass = (tab: string) =>
    `w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-smooth ${
      activeTab === tab
        ? 'bg-bg-layer-3 text-text-primary'
        : 'text-text-muted hover:bg-bg-layer-1 hover:text-text-primary'
    }`;

  const startProjectDraft = (folderPath: string) => {
    useSettingsStore.getState().setWorkingDirectory(folderPath);

    const currentTabId = useSessionStore.getState().selectedSessionId;
    if (currentTabId) {
      useChatStore.getState().saveToCache(currentTabId);
      useAgentStore.getState().saveToCache(currentTabId);
    }

    const newDraftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useChatStore.getState().ensureTab(newDraftId);
    useChatStore.getState().resetTab(newDraftId);
    useSessionStore.getState().addDraftSession(newDraftId, folderPath);
  };

  const addExistingProject = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t('sidebar.addProjectTitle'),
    });
    if (typeof selected === 'string') {
      startProjectDraft(selected);
    }
  };

  // Window dragging handled via CSS -webkit-app-region: drag on the top strip

  return (
    <div className="flex flex-col h-full pt-8 pb-4">
      {/* Logo area */}
      <div
        className="flex items-center justify-between mb-6 px-5 cursor-default">
        <div className="flex items-center">
          {IS_ALPHA ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setProfileOpen(true)}
                className="rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/40"
                title={t('sidebar.profile')}
              >
                <img
                  src="/app-icon.png"
                  alt="Little Claude"
                  className="w-8 h-8 rounded-full shadow-sm object-cover"
                />
              </button>
              {backgroundTheme === 'deepseek' ? (
                <span className="text-[15px] font-bold tracking-tight"
                  style={{
                    background: 'linear-gradient(135deg, #4176E6, #5686FE)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}>
                  {t('sidebar.deepseekEasterEgg')}
                </span>
              ) : (
                <span className="text-[15px] font-bold tracking-tight text-text-primary">
                  Little Claude
                </span>
              )}
              <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase
                bg-accent/15 text-accent leading-none">
                alpha
              </span>
            </div>
          ) : (
            /* Text logo — Little Claude brand + avatar */
            <div className="flex items-center gap-2">
              <button
                onClick={() => setProfileOpen(true)}
                className="rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/40"
                title={t('sidebar.profile')}
              >
                <img
                  src="/app-icon.png"
                  alt="Little Claude"
                  className="w-8 h-8 rounded-full shadow-sm object-cover"
                />
              </button>
              {backgroundTheme === 'deepseek' ? (
                <span className="text-[16px] font-bold tracking-tight"
                  style={{
                    background: 'linear-gradient(135deg, #87CEFA, #F0F8FF)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}>
                  {t('sidebar.deepseekEasterEgg')}
                </span>
              ) : (
                <span className="text-[16px] font-bold tracking-tight text-text-primary">
                  Little Claude
                </span>
              )}
            </div>
          )}
        </div>
        <button onClick={toggleSidebar}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary
            transition-smooth" title={t('sidebar.hide')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <path d="M10 4L6 8L10 12" />
          </svg>
        </button>
      </div>

      {/* New Chat — navigate to WelcomeScreen where user picks a folder */}
      <div className="px-3">
      <button onClick={() => {
        const workingDirectory = useSettingsStore.getState().workingDirectory;
        if (!workingDirectory) {
          useSessionStore.getState().setSelectedSession(null);
          return;
        }
        startProjectDraft(workingDirectory);
      }}
        className="w-full py-2.5 px-4 rounded-[22px] text-sm font-medium
          bg-accent hover:bg-accent-hover text-text-inverse
          hover:shadow-glow transition-smooth mb-2
          flex items-center justify-center gap-2">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t('sidebar.newChat')}
      </button>
      <button
        onClick={addExistingProject}
        className="w-full py-2.5 px-4 rounded-[18px] text-sm font-medium
          border border-border-subtle bg-bg-secondary text-text-primary
          hover:bg-bg-tertiary hover:border-border-default
          transition-smooth mb-4 flex items-center justify-center gap-2"
        title={t('sidebar.addProjectTitle')}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          strokeLinejoin="round">
          <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
          <path d="M11 8v3M9.5 9.5h3" />
        </svg>
        {t('sidebar.addProject')}
      </button>

      {/* Current Session — compressed single-line card */}
      {sessionMeta.sessionId && (
        <div className="px-3 py-2 rounded-xl bg-bg-secondary border border-border-subtle mb-3
          flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 transition-smooth
            ${sessionStatus === 'running'
              ? 'bg-success shadow-[0_0_8px_var(--color-accent-glow)] animate-pulse-soft'
              : sessionStatus === 'completed' ? 'bg-success'
              : sessionStatus === 'error' ? 'bg-error'
              : sessionStatus === 'stopped' ? 'bg-warning' // U3: 主动停止琥珀点
              : 'bg-text-tertiary'}`} />
          <span className="text-xs font-medium text-text-primary truncate">
            {sessionMeta.model ? getModelDisplayName(sessionMeta.model) : 'DeepSeek'}
          </span>
          {(sessionMeta.totalInputTokens || sessionMeta.totalOutputTokens
            || sessionMeta.inputTokens || sessionMeta.outputTokens) ? (
            <span className="text-[10px] text-text-tertiary font-mono flex items-center gap-1 ml-auto flex-shrink-0">
              <span>↑{formatTokenCount(sessionMeta.totalInputTokens || sessionMeta.inputTokens || 0)}</span>
              <span>↓{formatTokenCount(sessionMeta.totalOutputTokens || sessionMeta.outputTokens || 0)}</span>
            </span>
          ) : (
            // U3: stopped 显示本地化"已停止"文案，其余状态沿用原英文显示
            <span className="text-[10px] text-text-tertiary capitalize ml-auto flex-shrink-0">
              {sessionStatus === 'stopped' ? t('session.stopped') : sessionStatus}
            </span>
          )}
        </div>
      )}
      </div>

      {/* Conversation History */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 -mr-1.5 pr-1.5">
        {/* P2: 懒加载分块——列表数据来自本地磁盘，分块加载在毫秒级，不影响体验 */}
        <Suspense fallback={null}>
          <ConversationList />
        </Suspense>
      </div>

      {/* Footer */}
      <div className="pt-3 mt-3 border-t border-border-subtle px-3">
        {interviewSidebarVisible && (
        <button onClick={() => {
          const { active, openConfirm } = useInterviewStore.getState();
          if (active) {
            // 已在面试中 → 直接切回面试面板
            if (!useSettingsStore.getState().secondaryPanelOpen) {
              useSettingsStore.getState().toggleSecondaryPanel();
            }
            setSecondaryTab('interview');
          } else {
            openConfirm();
          }
        }}
          className={`${navItemClass('interview')}
            ${interviewActive
              ? '!bg-red-500/10 !text-red-500 hover:!bg-red-500/15'
              : ''}`}>
          <div className="relative flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M8 1a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" />
              <path d="M4 7v1a4 4 0 0 0 8 0V7" />
              <path d="M8 12v3M5 15h6" />
            </svg>
            {interviewActive && (
              <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-red-500
                border-[1.5px] border-bg-sidebar animate-pulse-soft" />
            )}
          </div>
          {t('panel.interview')}
        </button>
        )}
        {previewSidebarVisible && (
        <button onClick={() => setSecondaryTab('preview')}
          className={navItemClass('preview')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M2 4h12v8H2zM5 14h6" />
          </svg>
          {t('panel.preview')}
        </button>
        )}
        {skillsSidebarVisible && (
        <button onClick={() => setSecondaryTab('skills')}
          className={navItemClass('skills')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M8 1L1 4.5l7 3.5 7-3.5L8 1zM1 11.5l7 3.5 7-3.5M1 8l7 3.5L15 8" />
          </svg>
          {t('panel.skills')}
        </button>
        )}
        <button onClick={toggleSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl
            text-sm text-text-muted hover:bg-bg-secondary hover:text-text-primary
            transition-smooth">
          <div className="relative">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="2" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
            </svg>
            {(updateAvailable || cliUpdateAvailable) && (
              <span className={`absolute -top-1 -right-1.5 w-2 h-2 rounded-full
                border-[1.5px] border-bg-sidebar ${cliUpdateAvailable ? 'bg-red-500' : 'bg-green-500'}`} />
            )}
          </div>
          {t('settings.title')}
        </button>
      </div>
      {/* P2: 懒加载 + 仅在打开时挂载——组件本身在 !open 时 return null 且只在
          open 时拉取统计（loadStats），条件挂载行为完全等价 */}
      {profileOpen && (
        <Suspense fallback={null}>
          <ProfileStatsModal open={profileOpen} onClose={() => setProfileOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
