import { useRef, useCallback, useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  useSettingsStore,
  MODEL_OPTIONS,
  ColorTheme,
  BackgroundTheme,
  FontFamily,
  ContextWindowMode,
  type AutoCompactMode,
  getContextWindowForModel,
  getAutoCompactThreshold,
} from '../../stores/settingsStore';
import { useProviderStore } from '../../stores/providerStore';
import { useT } from '../../lib/i18n';
import { displayProviderModelName } from '../../lib/model-utils';
import { friendlyError } from '../../lib/error-format';
import { AiAvatar } from '../shared/AiAvatar';
import { bridge, onWallpaperProgress, type WallpaperInfo } from '../../lib/tauri-bridge';
import { UserAvatar } from '../shared/UserAvatar';
import { AvatarCropModal } from './AvatarCropModal';

const TIER_MAP: Record<string, string> = {
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
};

const COLOR_THEMES: { id: ColorTheme; labelKey: string; preview: string; previewDark: string }[] = [
  {
    id: 'black',
    labelKey: 'settings.black',
    preview: '#333333',
    previewDark: '#D0D0D0',
  },
  {
    id: 'blue',
    labelKey: 'settings.blue',
    preview: '#4E80F7',
    previewDark: '#6B9AFF',
  },
  {
    id: 'orange',
    labelKey: 'settings.orange',
    preview: '#C47252',
    previewDark: '#D4856A',
  },
  {
    id: 'green',
    labelKey: 'settings.green',
    preview: '#57A64B',
    previewDark: '#6DBF62',
  },
];

const BACKGROUND_THEMES: { id: BackgroundTheme; label: string; accent: string; preview: string }[] = [
  {
    id: 'garden',
    label: '花园',
    accent: '#D9857A',
    preview: 'radial-gradient(circle at 15% 90%, #AFCB8C 0 18%, transparent 20%), linear-gradient(135deg, #FFF8EA, #F7D9C6)',
  },
  {
    id: 'sakura',
    label: '粉樱',
    accent: '#C97D98',
    preview: 'radial-gradient(circle at 85% 18%, #F2B7C9 0 20%, transparent 22%), linear-gradient(135deg, #FFF4F7, #F7E6CF)',
  },
  {
    id: 'lake',
    label: '湖蓝',
    accent: '#6D9CB8',
    preview: 'radial-gradient(circle at 15% 85%, #A9CFBF 0 18%, transparent 20%), linear-gradient(135deg, #F3FBF8, #DCEEF4)',
  },
  {
    id: 'dusk',
    label: '暮紫',
    accent: '#9A83B8',
    preview: 'radial-gradient(circle at 82% 18%, #D8B6C9 0 20%, transparent 22%), linear-gradient(135deg, #F7F1FB, #E9DFD1)',
  },
  {
    id: 'ink',
    label: '墨纸',
    accent: '#7E8792',
    preview: 'radial-gradient(circle at 18% 90%, #C4CABA 0 18%, transparent 20%), linear-gradient(135deg, #F8F5EC, #E6E2D5)',
  },
  {
    id: 'vscode',
    label: 'VS Code Dark',
    accent: '#007ACC',
    preview: 'linear-gradient(90deg, #252526 0 24%, #1E1E1E 24% 100%)',
  },
  {
    id: 'minimal',
    label: '纯白简约',
    accent: '#111827',
    preview: 'linear-gradient(90deg, #F7F7F8 0 24%, #FFFFFF 24% 100%)',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 蓝',
    accent: '#87CEFA',
    preview: 'radial-gradient(circle at 90% 10%, rgba(135,206,250,0.15) 0 14%, transparent 16%), linear-gradient(135deg, #F0F8FF, #E8F4FD)',
  },
];

const FONT_FAMILY_OPTIONS: { id: FontFamily; label: string; sample: string }[] = [
  { id: 'microsoft', label: '微软雅黑 UI', sample: '中文 Aa 123' },
  { id: 'system', label: '系统清晰字体', sample: '中文 Aa 123' },
  { id: 'sourceHan', label: '思源黑体 / Noto', sample: '中文 Aa 123' },
  { id: 'lxgw', label: '霞鹜文楷', sample: '中文 Aa 123' },
  { id: 'mono', label: '等宽字体', sample: '中文 Aa 123' },
];

// 回归修复: 选项文案 i18n 化（此前硬编码中文，en 用户看到中文）。
// label/hint 存 key，渲染处经 t() 取文案。
const CONTEXT_WINDOW_OPTIONS: { id: ContextWindowMode; labelKey: string; hintKey: string }[] = [
  { id: 'default', labelKey: 'settings.ctxWindowDefault', hintKey: 'settings.ctxWindowDefaultHint' },
  { id: 'large1m', labelKey: 'settings.ctxWindowLarge1m', hintKey: 'settings.ctxWindowLarge1mHint' },
];

const AUTO_COMPACT_OPTIONS: { id: AutoCompactMode; labelKey: string; hintKey: string }[] = [
  { id: 'auto', labelKey: 'settings.compactAuto', hintKey: 'settings.compactAutoHint' },
  { id: 'pct90', labelKey: 'settings.compactPct90', hintKey: 'settings.compactPct90Hint' },
  { id: 'pct80', labelKey: 'settings.compactPct80', hintKey: 'settings.compactPct80Hint' },
  { id: 'custom', labelKey: 'settings.compactCustom', hintKey: 'settings.compactCustomHint' },
];

/* Mini app preview — simplified chat interface thumbnail */
function ThemePreview({ color }: { color: string }) {
  return (
    <div className="w-full aspect-[5/3] rounded-lg overflow-hidden border border-black/[0.06] bg-[#f5f5f5] dark:bg-[#1a1a1a] dark:border-white/[0.06] flex">
      {/* Sidebar */}
      <div className="w-[22%] border-r border-black/[0.06] dark:border-white/[0.06] p-2 flex flex-col gap-1.5">
        <div className="w-full h-2 rounded-full bg-black/[0.07] dark:bg-white/[0.08]" />
        <div className="w-[80%] h-2 rounded-full" style={{ background: color, opacity: 0.3 }} />
        <div className="w-[60%] h-2 rounded-full bg-black/[0.05] dark:bg-white/[0.06]" />
      </div>
      {/* Main content */}
      <div className="flex-1 flex flex-col p-2.5 gap-2">
        {/* Messages */}
        <div className="flex-1 flex flex-col gap-1.5 justify-center">
          <div className="w-[65%] h-2.5 rounded bg-black/[0.06] dark:bg-white/[0.07]" />
          <div className="w-[45%] h-2.5 rounded bg-black/[0.06] dark:bg-white/[0.07]" />
          <div className="w-[75%] h-2.5 rounded bg-black/[0.04] dark:bg-white/[0.05] self-end" />
        </div>
        {/* Input bar */}
        <div className="flex items-center gap-1">
          <div className="flex-1 h-3.5 rounded bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08]" />
          <div className="w-3.5 h-3.5 rounded flex-shrink-0" style={{ background: color }} />
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function WallpaperSection() {
  const t = useT();
  const wallpaperEnabled = useSettingsStore((s) => s.wallpaperEnabled);
  const wallpaperName = useSettingsStore((s) => s.wallpaperName);
  const wallpaperQuality = useSettingsStore((s) => s.wallpaperQuality);
  const wallpaperOpacity = useSettingsStore((s) => s.wallpaperOpacity);
  const setWallpaperEnabled = useSettingsStore((s) => s.setWallpaperEnabled);
  const setWallpaperName = useSettingsStore((s) => s.setWallpaperName);
  const setWallpaperQuality = useSettingsStore((s) => s.setWallpaperQuality);
  const setWallpaperOpacity = useSettingsStore((s) => s.setWallpaperOpacity);

  const [wallpapers, setWallpapers] = useState<WallpaperInfo[]>([]);
  const [progress, setProgress] = useState<{
    stage: string; message: string; pct: number;
  } | null>(null);
  const [compressing, setCompressing] = useState(false);

  // Load wallpaper list
  const refreshList = useCallback(() => {
    bridge.listWallpapers().then(setWallpapers).catch(() => {});
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // Listen for compression progress
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onWallpaperProgress((ev) => {
      setProgress({ stage: ev.stage, message: ev.message, pct: ev.progress });
      if (ev.stage === 'done') {
        setCompressing(false);
        refreshList();
      }
      if (ev.stage === 'error') {
        setCompressing(false);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [refreshList]);

  const handleUpload = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv'] }],
    });
    if (!selected || typeof selected !== 'string') return;
    setCompressing(true);
    setProgress(null);
    bridge.compressWallpaper(selected, wallpaperQuality).then((info) => {
      setWallpaperName(info.name);
      setWallpaperEnabled(true);
    }).catch((err) => {
      // A5: 原始错误经分类器转成友好文案
      setProgress({ stage: 'error', message: friendlyError(String(err)), pct: 0 });
      setCompressing(false);
    });
  };

  const handleDelete = async (name: string) => {
    await bridge.deleteWallpaper(name);
    if (wallpaperName === name) {
      setWallpaperName('');
      setWallpaperEnabled(false);
    }
    refreshList();
  };

  const selectedInfo = wallpapers.find((w) => w.name === wallpaperName);

  return (
    <div>
      <h3 className="text-[13px] font-medium text-text-primary mb-3">{t('settings.wallpaper.title')}</h3>

      {/* Enable toggle */}
      <label className="flex items-center gap-3 mb-3 cursor-pointer">
        <input
          type="checkbox"
          checked={wallpaperEnabled}
          onChange={(e) => setWallpaperEnabled(e.target.checked)}
          disabled={!wallpaperName}
          className="w-4 h-4 rounded accent-accent"
        />
        <span className="text-[13px] text-text-secondary">
          {wallpaperEnabled ? t('settings.wallpaper.enabled') : t('settings.wallpaper.enable')}
        </span>
      </label>

      {/* Quality selector */}
      <div className="flex items-center gap-3 mb-3">
        <span className="text-[12px] text-text-muted w-14">{t('settings.wallpaper.quality')}</span>
        <div className="inline-flex rounded-md border border-border-subtle overflow-hidden">
          {([
            { id: 'fast' as const, label: t('settings.wallpaper.fast') },
            { id: 'balanced' as const, label: t('settings.wallpaper.balanced') },
            { id: 'quality' as const, label: t('settings.wallpaper.qualityHigh') },
          ]).map((q) => (
            <button
              key={q.id}
              onClick={() => setWallpaperQuality(q.id)}
              className={`py-1 px-2.5 text-[12px] font-medium transition-smooth
                border-r border-border-subtle last:border-r-0
                ${wallpaperQuality === q.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-muted hover:bg-bg-secondary'
                }`}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* Opacity slider */}
      <div className="flex items-center gap-3 mb-3">
        <span className="text-[12px] text-text-muted w-14">
          {t('settings.wallpaper.opacity')}
        </span>
        <input
          type="range"
          min="5"
          max="50"
          value={Math.round(wallpaperOpacity * 100)}
          onChange={(e) => setWallpaperOpacity(Number(e.target.value) / 100)}
          className="flex-1 h-1.5 rounded-full appearance-none bg-bg-tertiary
            accent-accent cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5
            [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-sm"
        />
        <span className="text-[12px] text-text-secondary w-10 text-right tabular-nums">
          {Math.round(wallpaperOpacity * 100)}%
        </span>
      </div>

      {/* Upload button */}
      <button
        onClick={handleUpload}
        disabled={compressing}
        className={`py-2 px-4 rounded-lg text-[13px] font-medium transition-smooth mb-3
          ${compressing
            ? 'bg-bg-tertiary text-text-tertiary cursor-not-allowed'
            : 'bg-accent hover:bg-accent-hover text-text-inverse'
          }`}
      >
        {compressing ? t('settings.wallpaper.compressing') : t('settings.wallpaper.upload')}
      </button>

      {/* Progress */}
      {progress && (
        <div className="mb-3 p-3 rounded-lg bg-bg-secondary border border-border-subtle">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[12px] text-text-secondary">{progress.message}</span>
            <span className="text-[11px] text-text-tertiary">{progress.pct}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                progress.stage === 'error' ? 'bg-error' : 'bg-accent'
              }`}
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Installed wallpapers */}
      {wallpapers.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {wallpapers.map((wp) => (
            <div
              key={wp.name}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] transition-smooth
                ${wallpaperName === wp.name
                  ? 'bg-accent/10 border border-accent/20'
                  : 'bg-bg-secondary border border-border-subtle hover:border-border-default'
                }`}
            >
              <span className="flex-1 text-text-primary truncate font-medium">
                {wp.name}
              </span>
              <span className="text-[11px] text-text-tertiary flex-shrink-0">
                {formatBytes(wp.sizeBytes)}
              </span>
              <span className="text-[11px] text-text-tertiary flex-shrink-0">
                {Math.round(wp.durationSecs)}s
              </span>
              {wallpaperName !== wp.name && (
                <button
                  onClick={() => { setWallpaperName(wp.name); setWallpaperEnabled(true); }}
                  className="px-2 py-0.5 rounded text-[11px] font-medium
                    bg-accent/10 text-accent hover:bg-accent/20 transition-smooth"
                >
                  {t('settings.wallpaper.use')}
                </button>
              )}
              <button
                onClick={() => handleDelete(wp.name)}
                className="p-0.5 rounded text-text-tertiary hover:text-error transition-smooth"
                title={t('settings.wallpaper.delete')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5">
                  <path d="M5 7v5M8 7v5M11 7v5M2 4h12M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6.5 4v-.5h3V4" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Current wallpaper info */}
      {selectedInfo && (
        <div className="mt-2 text-[11px] text-text-tertiary">
          {t('settings.wallpaper.current', {
            name: selectedInfo.name,
            size: formatBytes(selectedInfo.sizeBytes),
            dur: String(Math.round(selectedInfo.durationSecs)),
          })}
        </div>
      )}
    </div>
  );
}

export function GeneralTab() {
  const t = useT();
  const activeProvider = useProviderStore((s) => {
    if (!s.activeProviderId) return null;
    return s.providers.find((p) => p.id === s.activeProviderId) ?? null;
  });
  const theme = useSettingsStore((s) => s.theme);
  const colorTheme = useSettingsStore((s) => s.colorTheme);
  const backgroundTheme = useSettingsStore((s) => s.backgroundTheme);
  const locale = useSettingsStore((s) => s.locale);
  const selectedModel = useSettingsStore((s) => s.selectedModel);
  const contextWindowMode = useSettingsStore((s) => s.contextWindowMode);
  const autoCompactThresholdTokens = useSettingsStore((s) => s.autoCompactThresholdTokens);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const monoFontFollowsInterface = useSettingsStore((s) => s.monoFontFollowsInterface);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setColorTheme = useSettingsStore((s) => s.setColorTheme);
  const setBackgroundTheme = useSettingsStore((s) => s.setBackgroundTheme);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const setSelectedModel = useSettingsStore((s) => s.setSelectedModel);
  const setContextWindowMode = useSettingsStore((s) => s.setContextWindowMode);
  const autoCompactMode = useSettingsStore((s) => s.autoCompactMode);
  const setAutoCompactThresholdTokens = useSettingsStore((s) => s.setAutoCompactThresholdTokens);
  const setAutoCompactMode = useSettingsStore((s) => s.setAutoCompactMode);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setMonoFontFollowsInterface = useSettingsStore((s) => s.setMonoFontFollowsInterface);
  const aiAvatarUrl = useSettingsStore((s) => s.aiAvatarUrl);
  const setAiAvatarUrl = useSettingsStore((s) => s.setAiAvatarUrl);
  const userAvatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const setUserAvatarUrl = useSettingsStore((s) => s.setUserAvatarUrl);
  const userDisplayName = useSettingsStore((s) => s.userDisplayName);
  const setUserDisplayName = useSettingsStore((s) => s.setUserDisplayName);
  const includePartialMessages = useSettingsStore((s) => s.includePartialMessages);
  const setIncludePartialMessages = useSettingsStore((s) => s.setIncludePartialMessages);
  const setOnboardingOpen = useSettingsStore((s) => s.setOnboardingOpen);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userFileInputRef = useRef<HTMLInputElement>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropTarget, setCropTarget] = useState<'ai' | 'user'>('ai');
  const selectedTier = TIER_MAP[selectedModel];
  const selectedMapping = selectedTier
    ? activeProvider?.modelMappings.find((m) => m.tier === selectedTier)
    : undefined;
  const actualModel = selectedMapping?.providerModel || selectedModel;
  const contextWindow = getContextWindowForModel(actualModel, contextWindowMode);
  const compactThreshold = getAutoCompactThreshold(
    actualModel,
    contextWindowMode,
    autoCompactThresholdTokens,
    autoCompactMode,
  );
  const tierMappings = activeProvider?.modelMappings
    .filter((m) => ['opus', 'sonnet', 'haiku'].includes(m.tier) && m.providerModel)
    .map((m) => `${m.tier}=${displayProviderModelName(m.providerModel)}`)
    .join(' / ');

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>, target: 'ai' | 'user') => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCropTarget(target);
    setCropFile(file);
    e.target.value = '';
  }, []);

  return (
    <div className="space-y-6">
      {/* Avatars — AI & User side by side */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">{t('settings.aiAvatar')} / {t('settings.userAvatar')}</h3>
        <div className="flex items-start gap-6">
          {/* AI Avatar */}
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.aiAvatarChange')}
            >
              <AiAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100
                transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <span className="text-[11px] text-text-tertiary">AI</span>
            {aiAvatarUrl && (
              <button
                onClick={() => setAiAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                {t('settings.aiAvatarReset')}
              </button>
            )}
          </div>

          {/* User Avatar + Name */}
          <div className="flex flex-col items-center gap-1.5">
            <button
              onClick={() => userFileInputRef.current?.click()}
              className="group relative cursor-pointer"
              title={t('settings.userAvatarChange')}
            >
              <UserAvatar size="w-14 h-14" rounded="rounded-2xl" />
              <div className="absolute inset-0 rounded-2xl bg-black/40 opacity-0 group-hover:opacity-100
                transition-smooth flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M12 9v4H4V9M8 3v7M5 6l3-3 3 3" />
                </svg>
              </div>
            </button>
            <input
              type="text"
              value={userDisplayName}
              onChange={(e) => setUserDisplayName(e.target.value)}
              placeholder={t('settings.userNamePlaceholder')}
              className="w-24 px-2 py-1 rounded-lg text-[11px] text-center bg-bg-secondary border border-border-subtle
                text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent/50 transition-smooth"
              maxLength={20}
            />
            {userAvatarUrl && (
              <button
                onClick={() => setUserAvatarUrl('')}
                className="text-[11px] text-text-muted hover:text-red-500 transition-smooth"
              >
                {t('settings.userAvatarReset')}
              </button>
            )}
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => handleFileSelect(e, 'ai')} />
          <input ref={userFileInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => handleFileSelect(e, 'user')} />
        </div>
      </div>

      {/* Avatar crop modal */}
      {cropFile && (
        <AvatarCropModal
          imageFile={cropFile}
          onSave={(dataUrl) => {
            if (cropTarget === 'ai') setAiAvatarUrl(dataUrl);
            else setUserAvatarUrl(dataUrl);
            setCropFile(null);
          }}
          onCancel={() => setCropFile(null)}
        />
      )}

      {/* Theme Color — single row of 4 */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">{t('settings.colorTheme')}</h3>
        <div className="grid grid-cols-4 gap-3">
          {COLOR_THEMES.map((ct) => (
            <button
              key={ct.id}
              onClick={() => setColorTheme(ct.id)}
              title={t(ct.labelKey)}
              className={`group relative rounded-xl p-2 transition-smooth text-left
                ${colorTheme === ct.id
                  ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-card bg-accent/[0.03]'
                  : 'hover:scale-[1.02] border border-border-subtle hover:border-black/10 dark:hover:border-white/10'
                }`}
            >
              <ThemePreview color={ct.preview} />
            </button>
          ))}
        </div>
      </div>

      {/* Background Skin */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-3">{t('settings.backgroundSkin')}</h3>
        <div className="grid grid-cols-4 gap-3">
          {BACKGROUND_THEMES.map((bg) => (
            <button
              key={bg.id}
              onClick={() => setBackgroundTheme(bg.id)}
              title={bg.label}
              className={`group relative rounded-xl p-2 transition-smooth text-left
                ${backgroundTheme === bg.id
                  ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-card bg-accent/[0.03]'
                  : 'hover:scale-[1.02] border border-border-subtle hover:border-black/10 dark:hover:border-white/10'
                }`}
            >
              <div className="w-full aspect-[5/3] rounded-lg overflow-hidden border border-black/[0.06] relative"
                style={{ background: bg.preview }}>
                <div className="absolute inset-x-2 top-2 h-2 rounded-full bg-white/45" />
                <div className="absolute left-2 bottom-2 w-10 h-5 rounded-md bg-white/45" />
                <div className="absolute right-2 bottom-2 w-5 h-5 rounded-md"
                  style={{ background: bg.accent }} />
              </div>
              <div className="mt-2 text-center text-[12px] font-medium text-text-muted">
                {bg.label}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Dynamic Wallpaper */}
      <WallpaperSection />

      {/* Settings row */}
      <div className="flex items-start gap-8 flex-wrap">
        {/* Appearance */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.appearance')}</h3>
          <div className="inline-flex rounded-lg border border-border-subtle overflow-hidden">
            {(['light', 'dark', 'system'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setTheme(m)}
                className={`py-1.5 px-3 text-[13px] font-medium transition-smooth
                  border-r border-border-subtle last:border-r-0 whitespace-nowrap
                  ${theme === m
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary'
                  }`}
              >
                {t(`settings.${m}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Language */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.language')}</h3>
          <div className="inline-flex rounded-lg border border-border-subtle overflow-hidden">
            {(['zh', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={`py-1.5 px-3 text-[13px] font-medium transition-smooth
                  border-r border-border-subtle last:border-r-0
                  ${locale === l
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-muted hover:bg-bg-secondary'
                  }`}
              >
                {l === 'zh' ? '中文' : 'EN'}
              </button>
            ))}
          </div>
        </div>

        {/* Font Size */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.fontSize')}</h3>
          <div className="inline-flex items-center rounded-lg border border-border-subtle
            overflow-hidden">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-8 h-8 text-[13px] font-bold text-text-primary
                hover:bg-bg-secondary transition-smooth
                disabled:opacity-30 disabled:cursor-not-allowed
                flex items-center justify-center border-r border-border-subtle"
            >-</button>
            <span className="w-12 text-center text-[13px] font-semibold text-text-primary">
              {fontSize}px
            </span>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 36}
              className="w-8 h-8 text-[13px] font-bold text-text-primary
                hover:bg-bg-secondary transition-smooth
                disabled:opacity-30 disabled:cursor-not-allowed
                flex items-center justify-center border-l border-border-subtle"
            >+</button>
          </div>
        </div>

        {/* Font Family */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.fontFamily')}</h3>
          <select
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value as FontFamily)}
            className="h-8 min-w-40 px-2 rounded-lg bg-bg-secondary border border-border-subtle
              text-[13px] text-text-primary outline-none focus:border-accent/60"
          >
            {FONT_FAMILY_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} · {option.sample}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-text-tertiary">
            {t('settings.fontFamilyHint')}
          </p>
          <button
            onClick={() => setMonoFontFollowsInterface(!monoFontFollowsInterface)}
            className="mt-2 inline-flex items-center gap-2 text-[12px] text-text-secondary
              hover:text-text-primary transition-smooth"
          >
            <span className={`relative w-8 h-4 rounded-full transition-smooth
              ${monoFontFollowsInterface ? 'bg-accent/80' : 'bg-bg-tertiary border border-border-subtle'}`}
            >
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform
                ${monoFontFollowsInterface ? 'translate-x-4' : 'translate-x-0.5'}`}
              />
            </span>
            {t('settings.monoFontFollowsInterface')}
          </button>
        </div>

        {/* Default Model */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.defaultModel')}</h3>
          <div className="flex flex-wrap gap-2">
            {MODEL_OPTIONS.map((model) => (
              <button
                key={model.id}
                onClick={() => setSelectedModel(model.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2
                  rounded-lg text-[13px] font-medium transition-smooth
                  ${selectedModel === model.id
                    ? 'bg-accent/10 text-accent border border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border border-border-subtle'
                  }`}
              >
                {selectedModel === model.id && (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M3 8l4 4 6-7" />
                  </svg>
                )}
                {(() => {
                  if (!activeProvider) return model.short;
                  const tier = TIER_MAP[model.id];
                  const mapping = activeProvider.modelMappings.find((mm) => mm.tier === tier);
                  return mapping?.providerModel ? displayProviderModelName(mapping.providerModel) : model.short;
                })()}
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-text-tertiary leading-relaxed">
            Actual model: <span className="font-mono text-text-muted">{displayProviderModelName(actualModel)}</span>
            {activeProvider && tierMappings && (
              <span className="ml-2">Mappings: {tierMappings}</span>
            )}
          </div>
        </div>

        {/* Context Window */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.contextWindow')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {CONTEXT_WINDOW_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => setContextWindowMode(option.id)}
                className={`text-left px-3 py-2 rounded-lg border transition-smooth
                  ${contextWindowMode === option.id
                    ? 'bg-accent/10 text-accent border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                  }`}
              >
                <div className="text-[13px] font-medium">{t(option.labelKey)}</div>
                <div className="mt-0.5 text-[11px] text-text-tertiary">{t(option.hintKey)}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-text-tertiary leading-relaxed">
            {/* A7: 中英混合说明文案走 i18n */}
            {t('settings.contextWindowSummary', {
              tokens: contextWindow.toLocaleString(),
              threshold: compactThreshold.toLocaleString(),
            })}
          </p>
        </div>

        {/* Auto compact threshold — user-selectable timing policy */}
        <div>
          <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.autoCompactTiming')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {AUTO_COMPACT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => setAutoCompactMode(opt.id)}
                className={`px-2 py-1 rounded-md text-[11px] border transition-smooth
                  ${autoCompactMode === opt.id
                    ? 'bg-accent/10 text-accent border-accent/30'
                    : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                  }`}
                title={t(opt.hintKey)}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
          {autoCompactMode === 'custom' && (
            <div className="flex items-center gap-2 mt-2">
              <input
                type="number"
                min={10}
                max={1000}
                step={10}
                value={Math.round(autoCompactThresholdTokens / 1000)}
                onChange={(e) => setAutoCompactThresholdTokens(Number(e.target.value) * 1000)}
                className="w-28 px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle
                  rounded-lg text-text-primary focus:outline-none focus:border-accent"
              />
              <span className="text-xs text-text-tertiary">K tokens</span>
              <div className="flex flex-wrap gap-1.5">
                {/* Window-relative presets: warning point / CLI-aligned / buffer-only (A7: 文案 i18n) */}
                {[
                  { label: t('settings.compactPresetWarning'), value: contextWindow - 53_000 },
                  { label: t('settings.compactPresetCliAligned'), value: contextWindow - 33_000 },
                  { label: t('settings.compactPresetLimit'), value: contextWindow - 13_000 },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => setAutoCompactThresholdTokens(preset.value)}
                    className={`px-2 py-1 rounded-md text-[11px] border transition-smooth
                      ${Math.round(autoCompactThresholdTokens / 1000) === Math.round(preset.value / 1000)
                        ? 'bg-accent/10 text-accent border-accent/30'
                        : 'text-text-muted hover:bg-bg-secondary border-border-subtle'
                      }`}
                  >
                    {Math.round(preset.value / 1000)}K
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-text-tertiary leading-relaxed">
            {/* A7: 说明文案走 i18n */}
            {t('settings.autoCompactHint')}
          </p>
        </div>
      </div>

      {/* A2: Partial Message Streaming */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-2">{t('settings.streamGranularity')}</h3>
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <button
            role="switch"
            aria-checked={includePartialMessages}
            onClick={() => setIncludePartialMessages(!includePartialMessages)}
            className={`relative w-10 h-5.5 rounded-full transition-smooth
              ${includePartialMessages ? 'bg-accent' : 'bg-bg-tertiary'}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow-sm transition-smooth
                ${includePartialMessages ? 'translate-x-[18px]' : 'translate-x-0'}`}
            />
          </button>
          <div>
            <span className="text-sm text-text-primary">
              --include-partial-messages {includePartialMessages ? t('settings.partialOn') : t('settings.partialOff')}
            </span>
            <p className="text-xs text-text-tertiary mt-0.5">
              {/* A7: 说明文案走 i18n */}
              {t('settings.partialHint')}
            </p>
          </div>
        </label>
      </div>

      {/* 新手教程 */}
      <div>
        <h3 className="text-[13px] font-medium text-text-primary mb-2">
          {t('settings.tutorial.title')}
        </h3>
        <p className="text-xs text-text-tertiary leading-relaxed mb-3">
          {t('settings.tutorial.desc')}
        </p>
        <button
          onClick={() => setOnboardingOpen(true)}
          className="py-2 px-4 rounded-lg text-[13px] font-medium transition-smooth
            bg-accent hover:bg-accent-hover text-text-inverse"
        >
          {t('settings.tutorial.replay')}
        </button>
      </div>
    </div>
  );
}
