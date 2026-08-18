import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import type { Locale } from '../stores/settingsStore';
import { modKey, fileManagerName, fileManagerNameEn } from './platform';

// --- Translation dictionary ---

import { zhDict } from './i18n-dict-zh';

// Locale-split dictionaries: zh loads eagerly (default locale); en is
// lazy-loaded on first switch to English, then cached. Until en arrives,
// t() transparently falls back to zh values instead of raw keys.
let enDict: Record<string, string> | null = null;
let enLoading: Promise<void> | null = null;

export function ensureEnLoaded(): Promise<void> {
  if (enDict) return Promise.resolve();
  if (!enLoading) {
    enLoading = import('./i18n-dict-en')
      .then((m) => { enDict = m.enDict; })
      .catch(() => { enDict = {}; });
  }
  return enLoading;
}

const messages: Record<Locale, Record<string, string>> = {
  zh: zhDict,
  get en() {
    return enDict ?? zhDict;
  },
};


// --- Platform-aware placeholder substitution ---

function resolvePlatformPlaceholders(text: string): string {
  if (!text.includes('{')) return text;
  return text
    .replace(/\{mod\}/g, modKey())
    .replace(/\{fileManager\}/g, fileManagerName())
    .replace(/\{fileManagerEn\}/g, fileManagerNameEn());
}

// --- Non-reactive t() for use outside components ---

// A8: hoisted placeholder regex — the per-call `new RegExp` in t()/useT()
// allocated a fresh matcher for every placeholder on every call (hot path in
// list/bubble rendering). A single /g regex is safe because String.replace
// with a global regex resets lastIndex internally per call.
const PLACEHOLDER_RE = /\{(\w+)\}/g;

export function t(key: string, params?: Record<string, string>): string {
  const locale = useSettingsStore.getState().locale;
  // Lazy en: kick off the load on first English lookup (non-reactive callers
  // just see zh fallback values until it arrives).
  if (locale === 'en' && !enDict) void ensureEnLoaded();
  const raw = messages[locale]?.[key] || messages['en'][key] || key;
  let result = resolvePlatformPlaceholders(raw);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(PLACEHOLDER_RE, (match, name) => (name === k ? v : match));
    }
  }
  return result;
}

// --- Reactive hook for use inside React components ---

export function useT() {
  const locale = useSettingsStore((s) => s.locale);
  // Lazy en dict: re-render once when the English dictionary finishes
  // loading so components switch from zh fallback to real en strings.
  const [enReady, setEnReady] = useState(() => locale !== 'en' || enDict !== null);
  useEffect(() => {
    if (locale === 'en' && !enDict) {
      let alive = true;
      ensureEnLoaded().then(() => {
        if (alive) setEnReady(true);
      });
      return () => {
        alive = false;
      };
    }
    setEnReady(true);
    return undefined;
  }, [locale]);
  // useMemo keeps the t closure reference-stable across renders (it only
  // changes when the locale does). Previously a fresh closure was created on
  // every render, which defeated useMemo/useCallback memoization keyed on t —
  // e.g. MarkdownRenderer's components object was rebuilt on every render.
  return useMemo(
    () => (key: string, params?: Record<string, string>): string => {
      const raw = messages[locale]?.[key] || messages['en'][key] || key;
      let result = resolvePlatformPlaceholders(raw);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          result = result.replace(PLACEHOLDER_RE, (match, name) => (name === k ? v : match));
        }
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, enReady],
  );
}
