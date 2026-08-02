import { createPortal } from 'react-dom';
import { useInterviewStore } from '../../stores/interviewStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';

/**
 * 面试模式 — 确认进入弹窗
 * 从侧边栏点击「面试」后弹出，说明模式行为与费用边界，确认后进入。
 */
export function InterviewConfirmModal() {
  const t = useT();
  const open = useInterviewStore((s) => s.confirmOpen);
  const closeConfirm = useInterviewStore((s) => s.closeConfirm);
  const enterInterview = useInterviewStore((s) => s.enterInterview);
  const setSecondaryTab = useSettingsStore((s) => s.setSecondaryTab);
  const toggleSecondaryPanel = useSettingsStore((s) => s.toggleSecondaryPanel);

  if (!open) return null;

  const handleEnter = () => {
    enterInterview();
    // 确保右侧面板打开并切到面试页
    if (!useSettingsStore.getState().secondaryPanelOpen) toggleSecondaryPanel();
    setSecondaryTab('interview');
  };

  const points = [
    {
      key: 'asr',
      icon: 'M8 1a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3zM4 7v1a4 4 0 0 0 8 0V7M8 12v3M5 15h6',
      color: 'text-success',
      bg: 'bg-success/12',
      textKey: 'interview.confirm.point.asr',
    },
    {
      key: 'agent',
      icon: 'M8 1.5l1.8 4.2 4.7.4-3.5 3 .9 4.6L8 11.3l-3.9 2.4.9-4.6-3.5-3 4.7-.4L8 1.5z',
      color: 'text-warning',
      bg: 'bg-warning/12',
      textKey: 'interview.confirm.point.agent',
    },
    {
      key: 'mic',
      icon: 'M8 15V3M4.5 6.5L8 3l3.5 3.5',
      color: 'text-accent',
      bg: 'bg-accent/12',
      textKey: 'interview.confirm.point.mic',
    },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 backdrop-blur-[2px]"
      onClick={closeConfirm}
    >
      <div
        className="bg-bg-card border border-border-subtle rounded-2xl shadow-2xl
          w-[400px] max-w-[calc(100vw-32px)] overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — 脉冲麦克风视觉锚点 */}
        <div className="relative px-6 pt-7 pb-5 text-center overflow-hidden">
          {/* 背景脉冲环 */}
          <div className="absolute left-1/2 top-7 -translate-x-1/2 flex items-center justify-center pointer-events-none">
            <span className="absolute w-24 h-24 rounded-full bg-accent/8 animate-ping-slow" />
            <span className="absolute w-16 h-16 rounded-full bg-accent/10 animate-ping-slow [animation-delay:300ms]" />
          </div>
          <div className="relative inline-flex items-center justify-center w-14 h-14
            rounded-2xl bg-accent/15 text-accent mb-3">
            <svg width="26" height="26" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
              strokeLinejoin="round">
              <path d="M8 1a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" />
              <path d="M4 7v1a4 4 0 0 0 8 0V7" />
              <path d="M8 12v3M5 15h6" />
            </svg>
          </div>
          <h2 className="relative text-lg font-bold text-text-primary tracking-tight">
            {t('interview.confirm.title')}
          </h2>
          <p className="relative text-xs text-text-muted mt-1">
            {t('interview.confirm.subtitle')}
          </p>
        </div>

        {/* 说明 */}
        <div className="px-6 pb-2">
          <p className="text-[13px] leading-relaxed text-text-secondary">
            {t('interview.confirm.desc')}
          </p>
        </div>

        {/* 三条要点 */}
        <div className="px-6 py-3 space-y-2.5">
          {points.map((p) => (
            <div key={p.key} className="flex items-start gap-3">
              <span className={`flex-shrink-0 w-7 h-7 rounded-lg ${p.bg} ${p.color}
                flex items-center justify-center mt-px`}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
                  strokeLinejoin="round">
                  <path d={p.icon} />
                </svg>
              </span>
              <span className="text-xs leading-relaxed text-text-secondary pt-1">
                {t(p.textKey)}
              </span>
            </div>
          ))}
        </div>

        {/* 操作按钮 */}
        <div className="px-6 pb-6 pt-3 flex gap-2.5">
          <button
            onClick={closeConfirm}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium
              bg-bg-secondary text-text-muted hover:bg-bg-tertiary
              hover:text-text-primary transition-smooth cursor-pointer"
          >
            {t('interview.confirm.cancel')}
          </button>
          <button
            onClick={handleEnter}
            className="flex-[1.4] py-2.5 rounded-xl text-sm font-semibold
              bg-accent hover:bg-accent-hover text-text-inverse
              hover:shadow-glow transition-smooth cursor-pointer
              flex items-center justify-center gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 1a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" />
              <path d="M4 7v1a4 4 0 0 0 8 0V7M8 12v3" />
            </svg>
            {t('interview.confirm.enter')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
