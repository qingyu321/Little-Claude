import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../lib/i18n';
import { ONBOARDING_MODULES, type OnboardingModule } from '../../lib/onboarding';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * OnboardingWizard — first-run feature tour.
 *
 * Page 1: the user checks which modules they want to learn about (all
 * selected by default). Page 2: walks through each selected module one by
 * one. The "never again" checkbox (page 1) persists the completed marker for
 * users who bail out early; finishing the full walkthrough persists it too.
 * Mounted only while `onboardingOpen` is true, so internal state resets on
 * every open (including "replay" from Settings → General).
 */
export function OnboardingWizard() {
  const t = useT();
  const setOnboardingCompleted = useSettingsStore((s) => s.setOnboardingCompleted);
  const setOnboardingOpen = useSettingsStore((s) => s.setOnboardingOpen);

  const [page, setPage] = useState<1 | 2>(1);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(ONBOARDING_MODULES.map((m) => m.id)),
  );
  const [neverAgain, setNeverAgain] = useState(false);
  const [index, setIndex] = useState(0);

  const ordered = ONBOARDING_MODULES.filter((m) => selected.has(m.id));
  const current: OnboardingModule | undefined = ordered[index];
  const isLast = index === ordered.length - 1;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = (value: boolean) => {
    setSelected(value
      ? new Set(ONBOARDING_MODULES.map((m) => m.id))
      : new Set());
  };

  /** Close the wizard. `completed` = the full walkthrough was finished. */
  const close = (completed: boolean) => {
    // 完整看完教程，或勾了「以后不再提示」→ 持久化标记，不再自动弹
    if (completed || neverAgain) setOnboardingCompleted(true);
    setOnboardingOpen(false);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-[440px] max-h-[75vh] rounded-2xl bg-bg-card
        border border-border-subtle shadow-lg overflow-hidden
        animate-in fade-in zoom-in-95 duration-200">
        {/* Close (X) — same as skip */}
        <button
          onClick={() => close(false)}
          className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center
            rounded-lg text-text-tertiary hover:text-text-muted hover:bg-bg-tertiary
            transition-smooth cursor-pointer"
          aria-label={t('common.cancel')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round">
            <path d="M2 2l10 10M12 2L2 12" />
          </svg>
        </button>

        {page === 1 ? (
          <>
            {/* Header */}
            <div className="px-6 pt-6 pb-4 text-center">
              <h2 className="text-base font-semibold text-text-primary">
                {t('onboarding.title')}
              </h2>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                {t('onboarding.subtitle')}
              </p>
            </div>

            {/* Module checklist */}
            <div className="px-6">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-text-secondary">
                  {t('onboarding.selectTitle')}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleAll(true)}
                    className="text-[11px] text-accent hover:underline cursor-pointer"
                  >
                    {t('onboarding.selectAll')}
                  </button>
                  <span className="text-[11px] text-text-tertiary">·</span>
                  <button
                    onClick={() => toggleAll(false)}
                    className="text-[11px] text-text-tertiary hover:text-text-muted hover:underline cursor-pointer"
                  >
                    {t('onboarding.clearAll')}
                  </button>
                </div>
              </div>
            </div>
            <div className="px-6 overflow-y-auto max-h-[calc(75vh-250px)] space-y-1.5">
              {ONBOARDING_MODULES.map((m) => (
                <label
                  key={m.id}
                  className="flex items-start gap-2.5 px-3 py-2 rounded-lg
                    hover:bg-bg-tertiary transition-smooth cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    onChange={() => toggle(m.id)}
                    className="w-4 h-4 rounded accent-accent mt-0.5 cursor-pointer"
                  />
                  <span className="text-base leading-none mt-0.5">{m.emoji}</span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-text-primary">
                      {t(m.titleKey)}
                    </span>
                    <span className="block text-[11px] text-text-muted mt-0.5">
                      {t(m.descKey)}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {/* Footer */}
            <div className="px-6 pt-3 pb-5 space-y-3">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={neverAgain}
                  onChange={(e) => setNeverAgain(e.target.checked)}
                  className="w-4 h-4 rounded accent-accent cursor-pointer"
                />
                <span className="text-xs text-text-muted">{t('onboarding.neverAgain')}</span>
              </label>
              <div className="flex items-center justify-between">
                <button
                  onClick={() => close(false)}
                  className="px-4 py-2 rounded-lg text-xs font-medium
                    border border-border-subtle text-text-muted
                    hover:bg-bg-tertiary transition-smooth cursor-pointer"
                >
                  {t('onboarding.skip')}
                </button>
                <button
                  onClick={() => { setIndex(0); setPage(2); }}
                  disabled={ordered.length === 0}
                  className="px-5 py-2 rounded-lg text-xs font-medium
                    bg-accent hover:bg-accent-hover text-text-inverse
                    transition-smooth cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t('onboarding.next')}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Header */}
            <div className="px-6 pt-6 pb-4 text-center">
              <p className="text-[11px] text-text-tertiary mb-1.5">
                {t('onboarding.progress', { current: String(index + 1), total: String(ordered.length) })}
              </p>
              <h2 className="text-base font-semibold text-text-primary">
                {current ? t(current.titleKey) : ''}
              </h2>
            </div>

            {/* Content */}
            <div className="px-8 pb-4">
              {current && (
                <div className="text-center">
                  <div className="text-4xl mb-3">{current.emoji}</div>
                  <p className="text-[13px] text-text-secondary leading-relaxed">
                    {t(current.detailKey)}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 pt-2 pb-5 flex items-center justify-between">
              <button
                onClick={() => (index === 0 ? setPage(1) : setIndex(index - 1))}
                className="px-4 py-2 rounded-lg text-xs font-medium
                  border border-border-subtle text-text-muted
                  hover:bg-bg-tertiary transition-smooth cursor-pointer"
              >
                {t('onboarding.back')}
              </button>
              <button
                onClick={() => {
                  if (isLast) {
                    close(true);
                  } else {
                    setIndex(index + 1);
                  }
                }}
                className="px-5 py-2 rounded-lg text-xs font-medium
                  bg-accent hover:bg-accent-hover text-text-inverse
                  transition-smooth cursor-pointer"
              >
                {isLast ? t('onboarding.start') : t('onboarding.next')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
