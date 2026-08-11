/**
 * Onboarding tutorial module catalog.
 *
 * The wizard lists these modules for the user to check, then walks through
 * each selected one. Text lives in i18n (`onboarding.mod.<id>.title/desc/detail`)
 * so it can be localized; this file only carries identity + icon.
 */
export interface OnboardingModule {
  id: string;
  emoji: string;
  titleKey: string;
  descKey: string;
  detailKey: string;
}

export const ONBOARDING_MODULES: OnboardingModule[] = [
  {
    id: 'sessions',
    emoji: '💬',
    titleKey: 'onboarding.mod.sessions.title',
    descKey: 'onboarding.mod.sessions.desc',
    detailKey: 'onboarding.mod.sessions.detail',
  },
  {
    id: 'input',
    emoji: '⌨️',
    titleKey: 'onboarding.mod.input.title',
    descKey: 'onboarding.mod.input.desc',
    detailKey: 'onboarding.mod.input.detail',
  },
  {
    id: 'slash',
    emoji: '⚡',
    titleKey: 'onboarding.mod.slash.title',
    descKey: 'onboarding.mod.slash.desc',
    detailKey: 'onboarding.mod.slash.detail',
  },
  {
    id: 'mode',
    emoji: '🧭',
    titleKey: 'onboarding.mod.mode.title',
    descKey: 'onboarding.mod.mode.desc',
    detailKey: 'onboarding.mod.mode.detail',
  },
  {
    id: 'model',
    emoji: '🧠',
    titleKey: 'onboarding.mod.model.title',
    descKey: 'onboarding.mod.model.desc',
    detailKey: 'onboarding.mod.model.detail',
  },
  {
    id: 'rewind',
    emoji: '⏪',
    titleKey: 'onboarding.mod.rewind.title',
    descKey: 'onboarding.mod.rewind.desc',
    detailKey: 'onboarding.mod.rewind.detail',
  },
  {
    id: 'plan',
    emoji: '📋',
    titleKey: 'onboarding.mod.plan.title',
    descKey: 'onboarding.mod.plan.desc',
    detailKey: 'onboarding.mod.plan.detail',
  },
  {
    id: 'agent',
    emoji: '🤖',
    titleKey: 'onboarding.mod.agent.title',
    descKey: 'onboarding.mod.agent.desc',
    detailKey: 'onboarding.mod.agent.detail',
  },
  {
    id: 'files',
    emoji: '📁',
    titleKey: 'onboarding.mod.files.title',
    descKey: 'onboarding.mod.files.desc',
    detailKey: 'onboarding.mod.files.detail',
  },
  {
    id: 'webpreview',
    emoji: '🌐',
    titleKey: 'onboarding.mod.webpreview.title',
    descKey: 'onboarding.mod.webpreview.desc',
    detailKey: 'onboarding.mod.webpreview.detail',
  },
  {
    id: 'skills',
    emoji: '🧩',
    titleKey: 'onboarding.mod.skills.title',
    descKey: 'onboarding.mod.skills.desc',
    detailKey: 'onboarding.mod.skills.detail',
  },
  {
    id: 'interview',
    emoji: '🎤',
    titleKey: 'onboarding.mod.interview.title',
    descKey: 'onboarding.mod.interview.desc',
    detailKey: 'onboarding.mod.interview.detail',
  },
  {
    id: 'palette',
    emoji: '⌘',
    titleKey: 'onboarding.mod.palette.title',
    descKey: 'onboarding.mod.palette.desc',
    detailKey: 'onboarding.mod.palette.detail',
  },
  {
    id: 'settings',
    emoji: '⚙️',
    titleKey: 'onboarding.mod.settings.title',
    descKey: 'onboarding.mod.settings.desc',
    detailKey: 'onboarding.mod.settings.detail',
  },
  {
    id: 'pet',
    emoji: '🐾',
    titleKey: 'onboarding.mod.pet.title',
    descKey: 'onboarding.mod.pet.desc',
    detailKey: 'onboarding.mod.pet.detail',
  },
];
