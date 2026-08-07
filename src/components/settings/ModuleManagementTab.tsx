import { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useInterviewStore } from '../../stores/interviewStore';
import { useT } from '../../lib/i18n';

/** 单个模块开关卡片 */
function ModuleCard({
  icon,
  titleKey,
  descKey,
  enabled,
  onToggle,
  disableConfirm,
}: {
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  /** If true, show confirmation before disabling (e.g. interview in progress) */
  disableConfirm?: boolean;
}) {
  const t = useT();
  const [showConfirm, setShowConfirm] = useState(false);

  const handleToggle = () => {
    if (enabled && disableConfirm) {
      setShowConfirm(true);
      return;
    }
    onToggle(!enabled);
  };

  return (
    <>
      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 max-w-xl">
        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex items-center gap-3 min-w-0">
            <span className="flex-shrink-0 w-8 h-8 rounded-lg bg-bg-secondary border border-border-subtle
              flex items-center justify-center text-text-muted">
              {icon}
            </span>
            <div className="min-w-0">
              <span className="text-[13px] font-medium text-text-primary block truncate">
                {t(titleKey)}
              </span>
              <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                {t(descKey)}
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleToggle}
            className={`relative inline-flex h-5 w-9 items-center rounded-full
              transition-smooth flex-shrink-0 ml-3
              ${enabled ? 'bg-accent' : 'bg-bg-tertiary'}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
                transition-smooth ${enabled ? 'translate-x-4.5' : 'translate-x-0.5'}`}
            />
          </button>
        </label>
      </div>

      {/* 面试进行中的二次确认 */}
      {showConfirm && (
        <ConfirmPopup
          title={t('settings.module.interviewActive')}
          onConfirm={() => {
            const interview = useInterviewStore.getState();
            if (interview.active) interview.exitInterview();
            onToggle(false);
            setShowConfirm(false);
          }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );
}

/** 小型确认弹窗（面试关闭时） */
function ConfirmPopup({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/30"
      onClick={onCancel}>
      <div
        className="bg-bg-card border border-border-subtle rounded-xl p-4
          shadow-lg max-w-[280px] w-full mx-4 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13px] text-text-primary leading-relaxed mb-4">{title}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
              text-text-muted hover:bg-bg-tertiary transition-smooth cursor-pointer"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded-lg bg-error/15
              text-error hover:bg-error/25 transition-smooth cursor-pointer font-medium"
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 模块管理 — 设置标签页
 *
 * 提供预览、技能、面试三个模块的显隐开关（2026-08-03 恢复面试卡片——
 * 曾被移除导致只剩两个；i18n 文案与面试进行中二次确认逻辑保留）。
 */
export function ModuleManagementTab() {
  const t = useT();
  const previewVisible = useSettingsStore((s) => s.previewSidebarVisible);
  const skillsVisible = useSettingsStore((s) => s.skillsSidebarVisible);
  const interviewVisible = useSettingsStore((s) => s.interviewSidebarVisible);
  const setPreviewVisible = useSettingsStore((s) => s.setPreviewSidebarVisible);
  const setSkillsVisible = useSettingsStore((s) => s.setSkillsSidebarVisible);
  const setInterviewVisible = useSettingsStore((s) => s.setInterviewSidebarVisible);
  const interviewActive = useInterviewStore((s) => s.active);

  return (
    <div className="space-y-5">
      {/* 标题 */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.module.title')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('settings.module.desc')}
        </p>
      </div>

      {/* 预览 */}
      <ModuleCard
        icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M2 4h12v8H2zM5 14h6" />
          </svg>
        }
        titleKey="settings.module.preview"
        descKey="settings.module.previewDesc"
        enabled={previewVisible}
        onToggle={setPreviewVisible}
      />

      {/* 技能 */}
      <ModuleCard
        icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M8 1L1 4.5l7 3.5 7-3.5L8 1zM1 11.5l7 3.5 7-3.5M1 8l7 3.5L15 8" />
          </svg>
        }
        titleKey="settings.module.skills"
        descKey="settings.module.skillsDesc"
        enabled={skillsVisible}
        onToggle={setSkillsVisible}
      />

      {/* 面试（恢复：旧版模块管理的第三张卡片；面试进行中关闭需二次确认） */}
      <ModuleCard
        icon={
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="M8 1a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3zM4 7v1a4 4 0 0 0 8 0V7M8 12v3M5 15h6" />
          </svg>
        }
        titleKey="settings.module.interview"
        descKey="settings.module.interviewDesc"
        enabled={interviewVisible}
        onToggle={setInterviewVisible}
        disableConfirm={interviewActive}
      />
    </div>
  );
}
