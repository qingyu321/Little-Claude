import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSkillStore } from '../../stores/skillStore';
import { useFileStore } from '../../stores/fileStore';
import { useCommandStore } from '../../stores/commandStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useVideoAnalysisRuntimeStore } from '../../stores/videoAnalysisRuntimeStore';
import { openUrl } from '@tauri-apps/plugin-opener';
import { bridge, onSkillRuntimeDownloadProgress } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import type {
  SkillInfo,
  SkillRuntimeStatus,
  SkillTranslation,
  SkillTranslationConfig,
} from '../../lib/tauri-bridge';
import {
  loadSkillTranslationConfig,
  loadSkillTranslationConfigAsync,
  saveSkillTranslationConfig,
} from '../../lib/skill-translation-storage';

type TranslationMap = Record<string, { name: string; description: string }>;

const TRANSLATION_CACHE_KEY = 'tokenicode-skill-translations-v1';

function loadTranslationCache(): TranslationMap {
  try {
    const raw = localStorage.getItem(TRANSLATION_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveTranslationCache(translations: TranslationMap) {
  try {
    localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(translations));
  } catch {
    // Cache is best-effort only.
  }
}

export function SkillsPanel() {
  const t = useT();
  const skills = useSkillStore((s) => s.skills);
  const isLoading = useSkillStore((s) => s.isLoading);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);
  const deleteSkill = useSkillStore((s) => s.deleteSkill);
  const toggleEnabled = useSkillStore((s) => s.toggleEnabled);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const selectFile = useFileStore((s) => s.selectFile);
  const selectedFile = useFileStore((s) => s.selectedFile);

  const [searchQuery, setSearchQuery] = useState('');
  const [showTranslations, setShowTranslations] = useState(false);
  const [translations, setTranslations] = useState<TranslationMap>(() => loadTranslationCache());
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationConfigOpen, setTranslationConfigOpen] = useState(false);
  const [translationConfig, setTranslationConfig] = useState<SkillTranslationConfig>(() => loadSkillTranslationConfig());
  const searchRef = useRef<HTMLInputElement>(null);

  // Decrypt the stored apiKey in the background — useState initializers
  // cannot await, so the initial value may hold a "TENC1:" blob briefly.
  useEffect(() => {
    let cancelled = false;
    void loadSkillTranslationConfigAsync().then((cfg) => {
      if (!cancelled) setTranslationConfig(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // video-analysis runtime env prompt (body is bundled; heavy deps optional)
  const [runtimeStatus, setRuntimeStatus] = useState<SkillRuntimeStatus | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeProgress, setRuntimeProgress] = useState<{
    percent: number;
    message: string;
    downloaded?: number;
    total?: number;
  } | null>(null);
  const [runtimeForceShow, setRuntimeForceShow] = useState(false);
  const [runtimeManualOpen, setRuntimeManualOpen] = useState(false);
  const [runtimeCopied, setRuntimeCopied] = useState(false);

  // Context menu (triggered by "..." button)
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    skill: SkillInfo;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const refreshRuntimeStatus = useCallback(async () => {
    try {
      const status = await bridge.getVideoAnalysisRuntimeStatus();
      setRuntimeStatus(status);
      setRuntimeError(null);
    } catch (e) {
      setRuntimeError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Fetch skills on mount and when working directory changes
  useEffect(() => {
    fetchSkills(workingDirectory || undefined);
    refreshRuntimeStatus();
  }, [workingDirectory, fetchSkills, refreshRuntimeStatus]);

  // Listen for real runtime download progress events
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onSkillRuntimeDownloadProgress((event) => {
      setRuntimeProgress({
        percent: event.percent,
        message: event.message,
        downloaded: event.downloaded,
        total: event.total,
      });
      // Sync progress to shared store so VideoAnalysisTab stays in sync.
      const shared = useVideoAnalysisRuntimeStore.getState();
      shared.setProgress({
        percent: event.percent,
        message: event.message,
        downloaded: event.downloaded,
        total: event.total,
      });
      if (!shared.installing) shared.setInstalling(true);
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {
      // non-fatal if event channel unavailable
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const handleDownloadRuntime = useCallback(async () => {
    const shared = useVideoAnalysisRuntimeStore.getState();
    if (shared.installing) return; // Guard: already installing from another entry point
    shared.setInstalling(true);
    shared.setInstallPhase('installing');
    setRuntimeLoading(true);
    setRuntimeError(null);
    setRuntimeManualOpen(false);
    setRuntimeProgress({ percent: 0, message: t('skills.runtimeDownloading') });
    shared.setProgress({ percent: 0, message: t('skills.runtimeDownloading') });
    try {
      const status = await bridge.downloadVideoAnalysisRuntime();
      setRuntimeStatus(status);
      setRuntimeForceShow(false);
      setRuntimeProgress({ percent: 100, message: status.message });
      shared.setStatus(status.status as 'body-only' | 'need-download' | 'ready' | 'unknown');
      shared.setProgress({ percent: 100, message: status.message });
      shared.setInstallPhase('done');
      await fetchSkills(workingDirectory || undefined);
    } catch (e) {
      setRuntimeError(e instanceof Error ? e.message : String(e));
      shared.setError(e instanceof Error ? e.message : String(e));
      shared.setInstallPhase('error');
    } finally {
      setRuntimeLoading(false);
      shared.setInstalling(false);
    }
  }, [fetchSkills, t, workingDirectory]);

  const handleDismissRuntime = useCallback(async () => {
    try {
      await bridge.dismissVideoAnalysisRuntimePrompt();
      setRuntimeForceShow(false);
      setRuntimeManualOpen(false);
      await refreshRuntimeStatus();
    } catch (e) {
      setRuntimeError(e instanceof Error ? e.message : String(e));
    }
  }, [refreshRuntimeStatus]);

  const handleCopyPipCmd = useCallback(async () => {
    const cmd = runtimeStatus?.pipInstallCmd;
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setRuntimeCopied(true);
      window.setTimeout(() => setRuntimeCopied(false), 1500);
    } catch {
      setRuntimeError('复制失败，请手动选择命令文本');
    }
  }, [runtimeStatus?.pipInstallCmd]);

  const handleOpenSkillDir = useCallback(async () => {
    try {
      await bridge.openVideoAnalysisSkillDir();
    } catch (e) {
      setRuntimeError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleOpenUrl = useCallback(async (url?: string | null) => {
    if (!url) return;
    try {
      await openUrl(url);
    } catch (e) {
      setRuntimeError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  // Close context menu on Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [contextMenu]);

  const getVisibleSkillText = useCallback((skill: SkillInfo) => {
    const translated = showTranslations ? translations[skill.path] : undefined;
    return {
      name: translated?.name || skill.name,
      description: translated?.description || skill.description,
    };
  }, [showTranslations, translations]);

  // Filter skills by search query
  const filteredSkills = skills.filter((s) => {
    const visible = getVisibleSkillText(s);
    const q = searchQuery.toLowerCase();
    return visible.name.toLowerCase().includes(q) ||
      visible.description.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q);
  });
  const sortByName = (a: SkillInfo, b: SkillInfo) =>
    a.name.localeCompare(b.name, 'zh-Hans-CN');

  // Group skills by scope
  const globalSkills = filteredSkills.filter((s) => s.scope === 'global').sort(sortByName);
  const projectSkills = filteredSkills.filter((s) => s.scope === 'project').sort(sortByName);

  const handleSelect = useCallback((skill: SkillInfo) => {
    selectFile(skill.path);
  }, [selectFile]);

  const handleOpenMenu = useCallback((e: React.MouseEvent, skill: SkillInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 220; // approximate height of 5 menu items
    let x = rect.left;
    let y = rect.bottom + 4;
    // Keep menu within viewport horizontally
    if (x + menuWidth > window.innerWidth) {
      x = rect.right - menuWidth;
    }
    // Keep menu within viewport vertically
    if (y + menuHeight > window.innerHeight) {
      y = rect.top - menuHeight - 4;
    }
    setContextMenu({ x, y, skill });
  }, []);

  const handleUseInInput = useCallback((skill: SkillInfo) => {
    setContextMenu(null);
    useCommandStore.getState().setActivePrefix({
      name: `/${skill.name}`,
      description: skill.description,
      source: skill.scope,
      category: 'skill' as const,
      has_args: true,
      path: skill.path,
      immediate: false,
    });
  }, []);

  const handleEdit = useCallback((skill: SkillInfo) => {
    setContextMenu(null);
    selectFile(skill.path);
  }, [selectFile]);

  const handleDuplicate = useCallback(async (skill: SkillInfo) => {
    setContextMenu(null);
    try {
      const content = await bridge.readSkill(skill.path, workingDirectory || null);
      const copyName = `${skill.name}-copy`;
      // Derive new path: replace the skill directory name
      const parentDir = skill.path.replace(/\/[^/]+\/SKILL\.md$/, '');
      const newPath = `${parentDir}/${copyName}/SKILL.md`;
      await bridge.writeSkill(newPath, content, workingDirectory || null);
      await fetchSkills(workingDirectory || undefined);
    } catch (e) {
      console.error('Failed to duplicate skill:', e);
    }
  }, [fetchSkills, workingDirectory]);

  const handleRevealInFinder = useCallback((skill: SkillInfo) => {
    setContextMenu(null);
    bridge.revealInFinder(skill.path);
  }, []);

  const handleDelete = useCallback(async (skill: SkillInfo) => {
    setContextMenu(null);
    if (confirm(t('skills.confirmDelete'))) {
      await deleteSkill(skill);
    }
  }, [deleteSkill, t]);

  const handleToggleTranslations = useCallback(async () => {
    if (showTranslations) {
      setShowTranslations(false);
      setTranslationError(null);
      return;
    }

    setShowTranslations(true);
    setTranslationError(null);
    const config = {
      ...translationConfig,
      baseUrl: translationConfig.baseUrl.trim(),
      apiKey: translationConfig.apiKey.trim(),
      model: translationConfig.model.trim(),
      proxyUrl: translationConfig.proxyUrl?.trim() || undefined,
    };
    if (!config.baseUrl || !config.apiKey || !config.model) {
      const urlInProxy = !config.baseUrl && config.proxyUrl?.startsWith('http');
      setTranslationError(urlInProxy
        ? 'Base URL 为空。你可能把 API 地址填到了 Proxy URL，代理栏一般留空。'
        : '请先配置技能翻译 API');
      setTranslationConfigOpen(true);
      return;
    }
    const missing = skills.filter((skill) => !translations[skill.path]);
    if (missing.length === 0) return;

    setIsTranslating(true);
    try {
      const result = await bridge.translateSkillMetadata(missing.map((skill) => ({
        key: skill.path,
        name: skill.name,
        description: skill.description,
      })), null, config);
      const next = { ...translations };
      result.forEach((item: SkillTranslation) => {
        if (!item.key) return;
        next[item.key] = {
          name: item.name || missing.find((skill) => skill.path === item.key)?.name || '',
          description: item.description || missing.find((skill) => skill.path === item.key)?.description || '',
        };
      });
      setTranslations(next);
      saveTranslationCache(next);
    } catch (e) {
      setTranslationError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsTranslating(false);
    }
  }, [showTranslations, skills, translations, translationConfig]);

  const updateTranslationConfig = useCallback((patch: Partial<SkillTranslationConfig>) => {
    setTranslationConfig((current) => {
      const next = { ...current, ...patch };
      void saveSkillTranslationConfig(next);
      return next;
    });
  }, []);

  // Skill count
  const totalCount = filteredSkills.length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2
        border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="text-accent flex-shrink-0">
            <path d="M8 1L1 4.5l7 3.5 7-3.5L8 1zM1 11.5l7 3.5 7-3.5M1 8l7 3.5L15 8" />
          </svg>
          <span className="text-[13px] font-medium text-text-primary">
            {t('skills.title')}
          </span>
          <span className="text-xs text-text-muted flex-shrink-0">
            {totalCount}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleToggleTranslations}
            disabled={isTranslating}
            className={`px-1.5 py-1 rounded-lg text-[11px] font-medium
              transition-smooth ${showTranslations
                ? 'bg-accent/10 text-accent'
                : 'text-text-tertiary hover:bg-bg-secondary'
              } disabled:opacity-60`}
            title="翻译技能"
          >
            {isTranslating ? '...' : '译'}
          </button>
          <button
            onClick={() => setTranslationConfigOpen((open) => !open)}
            className={`p-1.5 rounded-lg transition-smooth
              ${translationConfigOpen
                ? 'bg-accent/10 text-accent'
                : 'text-text-tertiary hover:bg-bg-secondary'
              }`}
            title="配置技能翻译 API"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <circle cx="8" cy="8" r="2" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l-1.41 1.41" />
            </svg>
          </button>
          <button
            onClick={() => fetchSkills(workingDirectory || undefined)}
            className="p-1.5 rounded-lg hover:bg-bg-secondary
              text-text-tertiary transition-smooth"
            title={t('skills.refresh')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M1 6a5 5 0 019-2M11 6a5 5 0 01-9 2" />
              <path d="M10 1v3h-3M2 11V8h3" />
            </svg>
          </button>
        </div>
      </div>

      {translationConfigOpen && (
        <div className="px-2 py-2 border-b border-border-subtle bg-bg-secondary/30">
          <div className="mb-2 text-[10px] text-text-tertiary leading-relaxed">
            技能翻译 API 独立配置。DeepSeek/CC Switch 的接口地址填在 Base URL，Proxy URL 仅用于网络代理。
          </div>
          <div className="grid grid-cols-2 gap-1.5 mb-1.5">
            <button
              onClick={() => updateTranslationConfig({ apiFormat: 'anthropic' })}
              className={`py-1 rounded-lg text-[11px] transition-smooth
                ${translationConfig.apiFormat === 'anthropic'
                  ? 'bg-accent/10 text-accent'
                  : 'bg-bg-primary text-text-muted hover:text-text-primary'
                }`}
            >
              Anthropic
            </button>
            <button
              onClick={() => updateTranslationConfig({ apiFormat: 'openai' })}
              className={`py-1 rounded-lg text-[11px] transition-smooth
                ${translationConfig.apiFormat === 'openai'
                  ? 'bg-accent/10 text-accent'
                  : 'bg-bg-primary text-text-muted hover:text-text-primary'
                }`}
            >
              OpenAI
            </button>
          </div>
          <label className="block mb-1 text-[10px] text-text-tertiary">Base URL</label>
          <input
            type="text"
            value={translationConfig.baseUrl}
            onChange={(e) => updateTranslationConfig({ baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com"
            className="w-full mb-1.5 px-2 py-1.5 text-xs bg-bg-input
              border border-border-subtle rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none focus:border-border-focus"
          />
          <p className="mb-1.5 text-[10px] text-text-tertiary leading-relaxed">
            DeepSeek 官网写法可直接填 https://api.deepseek.com；如果你的服务要求 /v1，也可以填完整 /v1 地址。
          </p>
          <label className="block mb-1 text-[10px] text-text-tertiary">API Key</label>
          <input
            type="password"
            value={translationConfig.apiKey}
            onChange={(e) => updateTranslationConfig({ apiKey: e.target.value })}
            placeholder="API Key"
            className="w-full mb-1.5 px-2 py-1.5 text-xs bg-bg-input
              border border-border-subtle rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none focus:border-border-focus"
          />
          <label className="block mb-1 text-[10px] text-text-tertiary">Model</label>
          <input
            type="text"
            value={translationConfig.model}
            onChange={(e) => updateTranslationConfig({ model: e.target.value })}
            placeholder="Model, e.g. deepseek-v4-flash"
            className="w-full mb-1.5 px-2 py-1.5 text-xs bg-bg-input
              border border-border-subtle rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none focus:border-border-focus"
          />
          <label className="block mb-1 text-[10px] text-text-tertiary">Proxy URL（可选，通常留空）</label>
          <input
            type="text"
            value={translationConfig.proxyUrl || ''}
            onChange={(e) => updateTranslationConfig({ proxyUrl: e.target.value })}
            placeholder="http://127.0.0.1:7890"
            className="w-full px-2 py-1.5 text-xs bg-bg-input
              border border-border-subtle rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none focus:border-border-focus"
          />
          <p className="mt-1 text-[10px] text-text-tertiary leading-relaxed">
            Proxy URL 只填 Clash 等网络代理地址，不是 API 地址；不需要代理时请留空。
          </p>
        </div>
      )}

      {/* video-analysis runtime prompt */}
      {(() => {
        if (!runtimeStatus) return null;
        const skillReady = runtimeStatus.skillInstalled;
        const runtimeReady = skillReady && runtimeStatus.runtimeInstalled;
        const showDownloadPrompt =
          skillReady &&
          !runtimeStatus.runtimeInstalled &&
          (!runtimeStatus.dismissed || runtimeForceShow || runtimeLoading);
        const showDismissedHint =
          skillReady &&
          !runtimeStatus.runtimeInstalled &&
          runtimeStatus.dismissed &&
          !runtimeForceShow &&
          !runtimeLoading;
        const pct = Math.max(0, Math.min(100, runtimeProgress?.percent ?? 0));
        return (
          <div className="px-2 py-2 border-b border-border-subtle bg-bg-secondary/20">
            <div className="flex items-start gap-2">
              <div className="mt-0.5 flex-shrink-0 text-accent">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="3" width="12" height="10" rx="1.5" />
                  <path d="M6 6.5l4 2.5-4 2.5V6.5z" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-text-primary">
                  {t('skills.runtimeTitle')}
                </div>
                <p className="mt-0.5 text-[11px] text-text-muted leading-relaxed">
                  {skillReady
                    ? t('skills.runtimeBodyInstalled')
                    : runtimeStatus.message || t('skills.runtimeNeedDownload')}
                </p>
                {runtimeReady ? (
                  <p className="mt-1 text-[11px] text-emerald-500">
                    {t('skills.runtimeReady')}
                  </p>
                ) : showDownloadPrompt ? (
                  <>
                    <p className="mt-1 text-[11px] text-text-secondary leading-relaxed">
                      {t('skills.runtimeNeedDownload')}
                    </p>
                    {runtimeStatus.missing?.length > 0 && (
                      <p className="mt-0.5 text-[10px] text-text-tertiary">
                        {t('skills.runtimeMissing').replace(
                          '{items}',
                          runtimeStatus.missing.join(', '),
                        )}
                      </p>
                    )}
                    <p className="mt-1 text-[10px] text-text-tertiary leading-relaxed">
                      {t('skills.runtimeMirrorHint')}
                    </p>

                    {/* Download progress bar */}
                    {(runtimeLoading || runtimeProgress) && (
                      <div className="mt-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-text-tertiary line-clamp-1 flex-1 min-w-0 pr-2">
                            {runtimeProgress?.message || t('skills.runtimeDownloading')}
                          </span>
                          <span className="text-[10px] text-text-secondary tabular-nums flex-shrink-0">
                            {t('skills.runtimeProgress').replace('{percent}', String(pct))}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden border border-border-subtle/60">
                          <div
                            className="h-full bg-accent transition-all duration-300 ease-out"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {runtimeProgress?.total != null &&
                          runtimeProgress.total > 0 &&
                          runtimeProgress.downloaded != null && (
                            <p className="mt-0.5 text-[10px] text-text-tertiary tabular-nums">
                              {(runtimeProgress.downloaded / 1048576).toFixed(1)} /{' '}
                              {(runtimeProgress.total / 1048576).toFixed(1)} MB
                            </p>
                          )}
                      </div>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={handleDownloadRuntime}
                        disabled={runtimeLoading || !skillReady}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium
                          bg-accent text-white hover:opacity-90 transition-smooth
                          disabled:opacity-60"
                      >
                        {runtimeLoading ? t('skills.runtimeDownloading') : t('skills.runtimeDownload')}
                      </button>
                      <button
                        onClick={() => setRuntimeManualOpen((v) => !v)}
                        disabled={runtimeLoading}
                        className="px-2.5 py-1 rounded-lg text-[11px]
                          text-text-secondary border border-border-subtle
                          hover:bg-bg-secondary transition-smooth
                          disabled:opacity-60"
                      >
                        {runtimeManualOpen
                          ? t('skills.runtimeHideManual')
                          : t('skills.runtimeManual')}
                      </button>
                      <button
                        onClick={handleDismissRuntime}
                        disabled={runtimeLoading}
                        className="px-2.5 py-1 rounded-lg text-[11px]
                          text-text-muted hover:bg-bg-secondary transition-smooth
                          disabled:opacity-60"
                      >
                        {t('skills.runtimeLater')}
                      </button>
                    </div>

                    {/* Manual install with China pip mirrors */}
                    {runtimeManualOpen && !runtimeLoading && (
                      <div className="mt-2 rounded-lg border border-border-subtle bg-bg-primary/40 p-2 space-y-2">
                        <div className="text-[11px] font-medium text-text-primary">
                          {t('skills.runtimeManualTitle')}
                        </div>

                        <div>
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[10px] text-text-tertiary">
                              {t('skills.runtimePipCmd')}
                            </span>
                            <button
                              onClick={handleCopyPipCmd}
                              className="text-[10px] text-accent hover:underline"
                            >
                              {runtimeCopied
                                ? t('skills.runtimeCopied')
                                : t('skills.runtimeCopy')}
                            </button>
                          </div>
                          <pre className="text-[10px] leading-relaxed text-text-secondary
                            whitespace-pre-wrap break-all bg-bg-tertiary/50 rounded-md px-2 py-1.5
                            border border-border-subtle/50">
                            {runtimeStatus.pipInstallCmd ||
                              `python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn -r requirements.txt`}
                          </pre>
                          <p className="mt-1 text-[10px] text-text-tertiary">
                            {t('skills.runtimePipFallback')}
                            {': '}
                            <code className="text-text-secondary">
                              -i {runtimeStatus.pipMirrorFallback || 'https://mirrors.aliyun.com/pypi/simple'}
                            </code>
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          <button
                            onClick={handleOpenSkillDir}
                            className="px-2 py-0.5 rounded text-[10px]
                              text-text-secondary border border-border-subtle
                              hover:bg-bg-secondary transition-smooth"
                          >
                            {t('skills.runtimeOpenDir')}
                          </button>
                          <button
                            onClick={() => handleOpenUrl(runtimeStatus.downloadUrl)}
                            className="px-2 py-0.5 rounded text-[10px]
                              text-text-secondary border border-border-subtle
                              hover:bg-bg-secondary transition-smooth"
                          >
                            {t('skills.runtimeOpenFfmpeg')}
                          </button>
                          <button
                            onClick={() => handleOpenUrl(runtimeStatus.modelMirror)}
                            className="px-2 py-0.5 rounded text-[10px]
                              text-text-secondary border border-border-subtle
                              hover:bg-bg-secondary transition-smooth"
                          >
                            {t('skills.runtimeOpenModel')}
                          </button>
                        </div>

                        {runtimeStatus.manualGuide && (
                          <pre className="text-[10px] leading-relaxed text-text-tertiary
                            whitespace-pre-wrap break-all max-h-36 overflow-y-auto">
                            {runtimeStatus.manualGuide}
                          </pre>
                        )}
                      </div>
                    )}
                  </>
                ) : showDismissedHint ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-text-tertiary">
                      {t('skills.runtimeNeedDownload')}
                    </span>
                    <button
                      onClick={() => {
                        setRuntimeForceShow(true);
                        setRuntimeManualOpen(false);
                      }}
                      className="text-[11px] text-accent hover:underline"
                    >
                      {t('skills.runtimeDownload')}
                    </button>
                    <button
                      onClick={() => {
                        setRuntimeForceShow(true);
                        setRuntimeManualOpen(true);
                      }}
                      className="text-[11px] text-text-muted hover:underline"
                    >
                      {t('skills.runtimeManual')}
                    </button>
                  </div>
                ) : null}
                {runtimeError && (
                  <p className="mt-1 text-[10px] text-error whitespace-pre-wrap break-all line-clamp-6">
                    {runtimeError}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Search bar */}
      <div className="px-2 py-1.5 border-b border-border-subtle">
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3 3" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('skills.search')}
            className="w-full pl-7 pr-7 py-1 text-xs bg-bg-secondary/50
              border border-border-subtle rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none
              focus:border-border-focus focus:bg-bg-input
              transition-smooth"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2
                p-0.5 rounded text-text-tertiary hover:text-text-primary
                transition-smooth"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          )}
        </div>
        {translationError && (
          <p className="mt-1 px-1 text-[10px] text-error line-clamp-2">
            {translationError}
          </p>
        )}
      </div>

      {/* Skills list */}
      <div className="flex-1 overflow-y-auto py-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent/30
              border-t-accent rounded-full animate-spin" />
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8
            text-text-tertiary text-xs gap-2">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none"
              stroke="currentColor" strokeWidth="1.2"
              className="text-text-tertiary/40">
              <path d="M16 4L4 10l12 6 12-6L16 4zM4 22l12 6 12-6M4 16l12 6 12-6" />
            </svg>
            <p className="text-xs text-text-tertiary leading-relaxed">
              {searchQuery ? t('skills.noMatch') : t('skills.empty')}
            </p>
          </div>
        ) : (
          <>
            {projectSkills.length > 0 && (
              <SkillGroup
                label={t('skills.project')}
                skills={projectSkills}
                selectedFile={selectedFile}
                onSelect={handleSelect}
                onOpenMenu={handleOpenMenu}
                onToggleEnabled={toggleEnabled}
                showTranslations={showTranslations}
                translations={translations}
                t={t}
              />
            )}
            {globalSkills.length > 0 && (
              <SkillGroup
                label={t('skills.global')}
                skills={globalSkills}
                selectedFile={selectedFile}
                onSelect={handleSelect}
                onOpenMenu={handleOpenMenu}
                onToggleEnabled={toggleEnabled}
                showTranslations={showTranslations}
                translations={translations}
                t={t}
              />
            )}
          </>
        )}
      </div>

      {/* Context menu — rendered via portal to escape overflow-hidden + backdrop-filter ancestors */}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[180px] py-1 rounded-xl border border-border-subtle
            bg-bg-card shadow-lg animate-fade-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {/* Use in Input */}
          <button
            onClick={() => handleUseInInput(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <path d="M12 9v4H4V5h4" />
              <path d="M8 8l6-6M10 2h4v4" />
            </svg>
            {t('skills.useInInput')}
          </button>

          {/* Edit */}
          <button
            onClick={() => handleEdit(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <path d="M11.5 1.5l3 3L5 14H2v-3l9.5-9.5z" />
            </svg>
            {t('skills.edit')}
          </button>

          {/* Duplicate */}
          <button
            onClick={() => handleDuplicate(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <rect x="5" y="5" width="9" height="9" rx="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
            </svg>
            {t('skills.duplicate')}
          </button>

          {/* Reveal in Finder */}
          <button
            onClick={() => handleRevealInFinder(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-primary
              hover:bg-bg-secondary transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary flex-shrink-0">
              <path d="M2 4h5l2 2h5v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
            </svg>
            {t('skills.revealInFinder')}
          </button>

          <div className="my-1 border-t border-border-subtle" />

          {/* Delete */}
          <button
            onClick={() => handleDelete(contextMenu.skill)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-error
              hover:bg-error/10 transition-smooth text-left"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round"
              className="flex-shrink-0">
              <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z" />
            </svg>
            {t('skills.delete')}
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

/* Collapsible skill group */
function SkillGroup({
  label,
  skills,
  selectedFile,
  onSelect,
  onOpenMenu,
  onToggleEnabled,
  showTranslations,
  translations,
  t,
}: {
  label: string;
  skills: SkillInfo[];
  selectedFile: string | null;
  onSelect: (skill: SkillInfo) => void;
  onOpenMenu: (e: React.MouseEvent, skill: SkillInfo) => void;
  onToggleEnabled: (skill: SkillInfo) => void;
  showTranslations: boolean;
  translations: TranslationMap;
  t: (key: string) => string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-1">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-1.5
          hover:bg-bg-secondary/50 rounded-lg transition-smooth"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5"
          className={`text-text-tertiary transition-transform
            ${collapsed ? '' : 'rotate-90'}`}>
          <path d="M3 1l4 4-4 4" />
        </svg>
        <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider flex-1 text-left">
          {label}
        </span>
        <span className="text-xs text-text-tertiary flex-shrink-0">
          {skills.length}
        </span>
      </button>

      {!collapsed && skills.map((skill) => (
        <SkillCard
          key={skill.path}
          skill={skill}
          isSelected={selectedFile === skill.path}
          onSelect={onSelect}
          onOpenMenu={onOpenMenu}
          onToggleEnabled={onToggleEnabled}
          showTranslations={showTranslations}
          translations={translations}
          t={t}
        />
      ))}
    </div>
  );
}

/* Skill card — richer display with tools, metadata, toggle */
function SkillCard({
  skill,
  isSelected,
  onSelect,
  onOpenMenu,
  onToggleEnabled,
  showTranslations,
  translations,
  t,
}: {
  skill: SkillInfo;
  isSelected: boolean;
  onSelect: (skill: SkillInfo) => void;
  onOpenMenu: (e: React.MouseEvent, skill: SkillInfo) => void;
  onToggleEnabled: (skill: SkillInfo) => void;
  showTranslations: boolean;
  translations: TranslationMap;
  t: (key: string) => string;
}) {
  const isDisabled = skill.disable_model_invocation === true;
  const translated = showTranslations ? translations[skill.path] : undefined;
  const displayName = translated?.name || skill.name;
  const displayDescription = translated?.description || skill.description;

  return (
    <div
      onClick={() => onSelect(skill)}
      onContextMenu={(e) => onOpenMenu(e, skill)}
      className={`mx-1.5 mb-1 px-2.5 py-2 rounded-lg cursor-pointer
        transition-smooth group border
        ${isDisabled ? 'opacity-50' : ''}
        ${isSelected
          ? 'bg-accent/10 border-accent/30'
          : 'border-transparent hover:bg-bg-secondary hover:border-border-subtle'
        }`}
    >
      {/* Row 1: Name + scope badge + actions */}
      <div className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
          className="flex-shrink-0 text-text-tertiary">
          <path d="M6 1l5 5-5 5-5-5z" />
        </svg>
        <span className={`text-[13px] truncate flex-1 ${
          isSelected ? 'text-accent' : 'text-text-primary'
        }`}>
          {displayName}
        </span>
        <span className={`flex-shrink-0 w-3.5 h-3.5 rounded text-[8px]
          font-bold flex items-center justify-center
          ${skill.scope === 'global' ? 'bg-blue-500/20 text-blue-400' : 'bg-green-500/20 text-green-400'}`}>
          {skill.scope === 'global' ? 'G' : 'P'}
        </span>

        {/* Toggle switch */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleEnabled(skill); }}
          className="flex-shrink-0 ml-1"
          title={isDisabled ? t('skills.enable') : t('skills.disable')}
        >
          <div className={`w-6 h-3.5 rounded-full transition-colors relative
            ${isDisabled ? 'bg-text-tertiary/30' : 'bg-accent'}`}>
            <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm
              transition-transform ${isDisabled ? 'left-0.5' : 'left-[11px]'}`} />
          </div>
        </button>

        {/* "..." menu button */}
        <button
          onClick={(e) => onOpenMenu(e, skill)}
          className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100
            hover:bg-bg-secondary transition-smooth text-text-tertiary"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="4" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="12" cy="8" r="1.5" />
          </svg>
        </button>
      </div>

      {/* Row 2: Description (1-2 lines, truncated) */}
      <p className="text-xs text-text-muted mt-1 line-clamp-2 leading-relaxed pl-5">
        {displayDescription}
      </p>

      {/* Row 3: Allowed tools as tag badges */}
      {skill.allowed_tools && skill.allowed_tools.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 pl-5">
          {skill.allowed_tools.map((tool) => (
            <span
              key={tool}
              className="px-1.5 py-0.5 text-[9px] rounded-md
                bg-accent/10 text-accent font-medium"
            >
              {tool}
            </span>
          ))}
        </div>
      )}

      {/* Row 4: Metadata (model, context, version) */}
      {(skill.model || skill.context || skill.version) && (
        <div className="flex items-center gap-2 mt-1 pl-5 text-[9px] text-text-tertiary">
          {skill.model && (
            <span>{t('skills.model')}: {skill.model}</span>
          )}
          {skill.context && (
            <span>{t('skills.context')}: {skill.context}</span>
          )}
          {skill.version && (
            <span>{t('skills.version')}: {skill.version}</span>
          )}
        </div>
      )}
    </div>
  );
}
