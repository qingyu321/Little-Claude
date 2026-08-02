import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO,
  normalizeDeepSeekModelName,
} from '../lib/model-utils';
import { decryptStoredApiKeys, encryptApiKey } from '../lib/encrypted-storage';

// --- Types ---

export type Theme = 'light' | 'dark' | 'system';
export type ColorTheme = 'black' | 'blue' | 'orange' | 'green';
export type BackgroundTheme = 'garden' | 'sakura' | 'lake' | 'dusk' | 'ink' | 'vscode' | 'minimal' | 'deepseek';
export type WallpaperQuality = 'fast' | 'balanced' | 'quality';
export type SecondaryPanelTab = 'files' | 'preview' | 'skills' | 'plugins' | 'interview';
export type ModelId = 'claude-opus-4-6' | 'claude-opus-4-6-1m' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
export type SessionMode = 'code' | 'ask' | 'plan' | 'bypass';
export type FontFamily = 'system' | 'microsoft' | 'sourceHan' | 'lxgw' | 'mono';
/** CLI permission mode for the SDK control protocol */
export type CliPermissionMode = 'acceptEdits' | 'default' | 'plan' | 'bypassPermissions';
export type Locale = 'zh' | 'en';

/** Map frontend session mode to CLI permission mode */
export function mapSessionModeToPermissionMode(mode: SessionMode): CliPermissionMode {
  switch (mode) {
    case 'code': return 'acceptEdits';
    case 'ask': return 'default';
    case 'plan': return 'plan';
    case 'bypass': return 'bypassPermissions';
  }
}
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
export type ContextWindowMode = 'default' | 'large1m';

function defaultAutoCompactThreshold(mode: ContextWindowMode): number {
  return mode === 'large1m' ? 800_000 : 160_000;
}

function clampAutoCompactThreshold(tokens: number): number {
  if (!Number.isFinite(tokens)) return 160_000;
  return Math.max(10_000, Math.min(1_000_000, Math.round(tokens)));
}

// 报告B10: avatar images are base64 data URLs (hundreds of KB). They used to
// be in the persist partialize, so ANY settings change re-serialized the full
// images to localStorage. They now live under their own key, written only when
// the avatar actually changes, and merged back on hydration.
const AVATARS_STORAGE_KEY = 'tokenicode_avatars_v1';

function saveAvatars(ai: string, user: string) {
  try {
    localStorage.setItem(AVATARS_STORAGE_KEY, JSON.stringify({ aiAvatarUrl: ai, userAvatarUrl: user }));
  } catch (e) {
    console.error('[settingsStore] avatar save failed:', e);
  }
}

function loadAvatars(): { aiAvatarUrl: string; userAvatarUrl: string } | null {
  try {
    const raw = localStorage.getItem(AVATARS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    // One-time migration from the legacy settings blob.
    const legacy = localStorage.getItem('tokenicode-settings');
    if (legacy) {
      const parsed = JSON.parse(legacy);
      const ai = parsed?.state?.aiAvatarUrl ?? '';
      const user = parsed?.state?.userAvatarUrl ?? '';
      if (ai || user) {
        saveAvatars(ai, user);
        return { aiAvatarUrl: ai, userAvatarUrl: user };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// --- Model options (display mapping) ---

export const MODEL_OPTIONS: { id: ModelId; label: string; short: string }[] = [
  { id: 'claude-opus-4-6', label: 'Opus', short: 'Opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet', short: 'Sonnet' },
];

function migrateModelSelection(model: unknown): ModelId | undefined {
  if (typeof model !== 'string') return undefined;

  // Direct Claude model ID checks (must come first since normalizeDeepSeekModelName
  // no longer maps Claude tier names to DeepSeek)
  if (model === 'claude-opus-4-6') return 'claude-opus-4-6';
  if (model === 'claude-sonnet-4-6') return 'claude-sonnet-4-6';
  if (model === 'claude-opus-4-6-1m') return 'claude-opus-4-6';
  if (model === 'claude-haiku-4-5-20251001' || model === 'claude-haiku-4-5') return 'claude-sonnet-4-6';

  // Legacy DeepSeek model names → Claude tier IDs
  const normalized = normalizeDeepSeekModelName(model);
  if (normalized === DEEPSEEK_V4_PRO) return 'claude-opus-4-6';
  if (normalized === DEEPSEEK_V4_FLASH) return 'claude-sonnet-4-6';

  return undefined;
}

// --- Store State & Actions ---

interface SettingsState {
  theme: Theme;
  colorTheme: ColorTheme;
  backgroundTheme: BackgroundTheme;
  sidebarOpen: boolean;
  secondaryPanelOpen: boolean;
  secondaryPanelTab: SecondaryPanelTab;
  secondaryPanelWidth: number;
  settingsOpen: boolean;
  workingDirectory: string;
  selectedModel: string;
  sessionMode: SessionMode;
  locale: Locale;
  /** Global UI font size in px (default 18) */
  fontSize: number;
  /** Global UI font family preset */
  fontFamily: FontFamily;
  /** Whether mono-styled UI labels should follow the selected interface font */
  monoFontFollowsInterface: boolean;
  /** Sidebar width in px (default 280) */
  sidebarWidth: number;
  /** Whether the CLI setup wizard has been completed or skipped */
  setupCompleted: boolean;
  /** Thinking effort level: off disables, low/medium/high/max set effort */
  thinkingLevel: ThinkingLevel;
  /** Declares that the selected/provider model supports a 1M context window. */
  contextWindowMode: ContextWindowMode;
  /** User-adjustable auto compact threshold in tokens. */
  autoCompactThresholdTokens: number;
  /** Whether a newer version is available (set by auto-check on startup) */
  updateAvailable: boolean;
  /** Whether a newer CLI version is available */
  cliUpdateAvailable: boolean;
  /** Latest CLI version string (for display) */
  cliLatestVersion: string;
  /** Whether a newer Codex CLI version is available */
  codexUpdateAvailable: boolean;
  /** Latest Codex CLI version string (for display) */
  codexLatestVersion: string;
  /** Version string of the available update */
  updateVersion: string;
  /** Whether the update has been downloaded and is ready for restart (transient, not persisted) */
  updateDownloaded: boolean;
  /** Last app version the user has seen the changelog for */
  lastSeenVersion: string;
  /** Custom AI avatar image (data URL or empty string for default </> icon) */
  aiAvatarUrl: string;
  /** Custom user avatar image (data URL or empty string for default initials) */
  userAvatarUrl: string;
  /** User display name shown next to messages */
  userDisplayName: string;
  /** Whether to show dotfiles (hidden files) in the file tree */
  showHiddenFiles: boolean;
  /**
   * Default multimodal (vision) model for video-analysis skill.
   * Complete when baseUrl + model + (apiKey OR apiKeyEnv) are set.
   */
  videoAnalysisBaseUrl: string;
  videoAnalysisApiKey: string;
  /** Env var name for the key (either this or videoAnalysisApiKey is enough). */
  videoAnalysisApiKeyEnv: string;
  /** S3: Encrypted videoAnalysisApiKey for localStorage persistence. Managed by setVideoAnalysisApiKey. */
  _enc_videoAnalysisApiKey: string;
  videoAnalysisModel: string;
  /** Enable local acceleration pipeline (scene-detect, pHash dedup, grid-stitch, VAD, etc.) */
  videoAnalysisAccelEnabled: boolean;
  /** faster-whisper ASR model size. Default "small". */
  videoAnalysisAsrModel: string;
  /** Enable speech-to-text input (mic button in InputBar). */
  speechEnabled: boolean;
  /** Speech recognition language code. Default 'zh'. */
  speechLanguage: string;
  /** Prefer offline whisper model over Web Speech API when available. */
  speechUseOfflineModel: boolean;
  /** Enable dynamic wallpaper (video background). */
  wallpaperEnabled: boolean;
  /** Selected wallpaper name (file name without .mp4). */
  wallpaperName: string;
  /** Compression quality preset: fast / balanced / quality. */
  wallpaperQuality: WallpaperQuality;
  /** Wallpaper overlay opacity (0.05–0.50). Default 0.18. */
  wallpaperOpacity: number;
  /** Active CLI backend: "claude" (default) or "codex". Independent of API provider. */
  cliBackend: 'claude' | 'codex';
  /** 模块管理 — 侧边栏预览按钮显隐 */
  previewSidebarVisible: boolean;
  /** 模块管理 — 侧边栏技能按钮显隐 */
  skillsSidebarVisible: boolean;
  /** 面试助手 — mimo 多模态模型名称 */
  interviewMimoModel: string;
  /** 面试助手 — mimo API Base URL */
  interviewMimoBaseUrl: string;
  /** 面试助手 — mimo API Key (明文) */
  interviewMimoApiKey: string;
  /** 面试助手 — mimo API Key 环境变量名 (优先于明文) */
  interviewMimoApiKeyEnv: string;
  /** S3: Encrypted interviewMimoApiKey for localStorage persistence. Managed by setInterviewMimoApiKey. */
  _enc_interviewMimoApiKey: string;
  /** B1: Interview provider preset: "mimo" | "openai" | "custom" */
  interviewPreset: 'mimo' | 'openai' | 'custom';
  /** B1: ASR model name (empty for single-hop providers) */
  interviewAsrModel: string;
  /** B1: Single-hop mode — audio + prompt in one API call, no separate ASR */
  interviewIsSingleHop: boolean;
  /** B1: Custom answer system prompt */
  interviewAnswerPrompt: string;
  /** B1: Answer max_tokens */
  interviewMaxTokens: number;
  /** B1: Answer temperature */
  interviewTemperature: number;
  /** Phase 4: ASR backend mode — mimo API / local sherpa-onnx / hybrid comparison */
  interviewAsrBackend: 'mimo' | 'local' | 'hybrid';
  /** A2: Include --include-partial-messages flag (default true).
   *  Disabling reduces stream event volume 10-50× for low-CPU/iGPU machines. */
  includePartialMessages: boolean;

  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setColorTheme: (colorTheme: ColorTheme) => void;
  setBackgroundTheme: (backgroundTheme: BackgroundTheme) => void;
  /** Whether the floating agent panel is open */
  agentPanelOpen: boolean;

  toggleSidebar: () => void;
  toggleSecondaryPanel: () => void;
  toggleAgentPanel: () => void;
  setSecondaryTab: (tab: SecondaryPanelTab) => void;
  setSecondaryPanelWidth: (width: number) => void;
  toggleSettings: () => void;
  setWorkingDirectory: (dir: string) => void;
  setSelectedModel: (model: string) => void;
  setSessionMode: (mode: SessionMode) => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: FontFamily) => void;
  setMonoFontFollowsInterface: (enabled: boolean) => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setSidebarWidth: (width: number) => void;
  setSetupCompleted: (completed: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setContextWindowMode: (mode: ContextWindowMode) => void;
  setCliBackend: (backend: 'claude' | 'codex') => void;
  setAutoCompactThresholdTokens: (tokens: number) => void;
  setPreviewSidebarVisible: (v: boolean) => void;
  setSkillsSidebarVisible: (v: boolean) => void;
  setInterviewMimoModel: (model: string) => void;
  setInterviewMimoBaseUrl: (url: string) => void;
  setInterviewMimoApiKey: (key: string) => void;
  setInterviewMimoApiKeyEnv: (env: string) => void;
  setInterviewPreset: (preset: 'mimo' | 'openai' | 'custom') => void;
  setInterviewAsrModel: (model: string) => void;
  setInterviewIsSingleHop: (v: boolean) => void;
  setInterviewAnswerPrompt: (prompt: string) => void;
  setInterviewMaxTokens: (n: number) => void;
  setInterviewTemperature: (t: number) => void;
  setInterviewAsrBackend: (backend: 'mimo' | 'local' | 'hybrid') => void;
  setIncludePartialMessages: (v: boolean) => void;
  setUpdateAvailable: (available: boolean, version?: string) => void;
  setUpdateDownloaded: (downloaded: boolean) => void;
  setLastSeenVersion: (version: string) => void;
  setAiAvatarUrl: (url: string) => void;
  setUserAvatarUrl: (url: string) => void;
  setUserDisplayName: (name: string) => void;
  toggleHiddenFiles: () => void;
  setVideoAnalysisBaseUrl: (url: string) => void;
  setVideoAnalysisApiKey: (key: string) => void;
  setVideoAnalysisApiKeyEnv: (name: string) => void;
  setVideoAnalysisModel: (model: string) => void;
  setVideoAnalysisMultimodal: (cfg: {
    baseUrl?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    model?: string;
  }) => void;
  setVideoAnalysisAsrModel: (model: string) => void;
  setSpeechEnabled: (enabled: boolean) => void;
  setSpeechLanguage: (lang: string) => void;
  setSpeechUseOfflineModel: (use: boolean) => void;
  setWallpaperEnabled: (enabled: boolean) => void;
  setWallpaperName: (name: string) => void;
  setWallpaperQuality: (quality: WallpaperQuality) => void;
  setWallpaperOpacity: (opacity: number) => void;
}

// --- Theme cycle order ---

const themeCycle: Theme[] = ['light', 'dark', 'system'];

function nextTheme(current: Theme): Theme {
  const idx = themeCycle.indexOf(current);
  return themeCycle[(idx + 1) % themeCycle.length];
}

// --- Store ---

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      colorTheme: 'black',
      backgroundTheme: 'minimal',
      sidebarOpen: true,
      secondaryPanelOpen: false,
      secondaryPanelTab: 'files',
      secondaryPanelWidth: 300,
      settingsOpen: false,
      agentPanelOpen: false,
      workingDirectory: '',
      selectedModel: 'claude-sonnet-4-6',
      sessionMode: 'bypass',
      locale: 'zh',
      fontSize: 14,
      fontFamily: 'microsoft',
      monoFontFollowsInterface: true,
      sidebarWidth: 280,
      setupCompleted: false,
      thinkingLevel: 'medium' as ThinkingLevel,
      contextWindowMode: 'default',
      autoCompactThresholdTokens: 160_000,
      updateAvailable: false,
      updateVersion: '',
      cliUpdateAvailable: false,
      cliLatestVersion: '',
      codexUpdateAvailable: false,
      codexLatestVersion: '',
      updateDownloaded: false,
      lastSeenVersion: '',
      aiAvatarUrl: '',
      userAvatarUrl: '',
      userDisplayName: '',
      showHiddenFiles: false,
      videoAnalysisBaseUrl: '',
      videoAnalysisApiKey: '',
      videoAnalysisApiKeyEnv: '',
      _enc_videoAnalysisApiKey: '',
      videoAnalysisModel: '',
      videoAnalysisAccelEnabled: false,
      videoAnalysisAsrModel: 'small',
      speechEnabled: false,
      speechLanguage: 'zh',
      speechUseOfflineModel: false,
      wallpaperEnabled: false,
      wallpaperName: '',
      wallpaperQuality: 'balanced' as WallpaperQuality,
      wallpaperOpacity: 0.18,
      cliBackend: 'claude' as 'claude' | 'codex',
      previewSidebarVisible: true,
      skillsSidebarVisible: true,
      interviewMimoModel: 'mimo-v2.5-pro',
      interviewMimoBaseUrl: '',
      interviewMimoApiKey: '',
      interviewMimoApiKeyEnv: '',
      _enc_interviewMimoApiKey: '',
      interviewPreset: 'mimo' as 'mimo' | 'openai' | 'custom',
      interviewAsrModel: 'mimo-v2.5-asr',
      interviewIsSingleHop: false,
      interviewAnswerPrompt:
        '你是一个面试助手。针对以下中文面试问题，用中文给出简洁清晰的答案（100字以内，适合口头作答）。',
      interviewMaxTokens: 512,
      interviewTemperature: 0,
      interviewAsrBackend: 'mimo' as 'mimo' | 'local' | 'hybrid',
      includePartialMessages: true, // A2: default on for backward compat

      toggleTheme: () =>
        set((state) => ({ theme: nextTheme(state.theme) })),

      setTheme: (theme) => set(() => ({ theme })),

      setColorTheme: (colorTheme) => set(() => ({ colorTheme })),

      setBackgroundTheme: (backgroundTheme) => set(() => ({ backgroundTheme })),

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      toggleSecondaryPanel: () =>
        set((state) => ({
          secondaryPanelOpen: !state.secondaryPanelOpen,
        })),

      toggleAgentPanel: () =>
        set((state) => ({ agentPanelOpen: !state.agentPanelOpen })),

      setSecondaryTab: (tab) =>
        set(() => ({
          secondaryPanelTab: tab,
          secondaryPanelOpen: true,
        })),

      setSecondaryPanelWidth: (width) =>
        set(() => ({ secondaryPanelWidth: width })),

      toggleSettings: () =>
        set((state) => ({
          settingsOpen: !state.settingsOpen,
          // Clear update badge when opening settings
          ...(!state.settingsOpen && state.updateAvailable ? { updateAvailable: false } : {}),
        })),

      setWorkingDirectory: (dir) =>
        set(() => ({ workingDirectory: dir })),

      setSelectedModel: (model) =>
        set(() => ({ selectedModel: model })),

      setSessionMode: (mode) =>
        set(() => ({ sessionMode: mode })),

      setLocale: (locale) =>
        set(() => ({ locale })),

      toggleLocale: () =>
        set((state) => ({ locale: state.locale === 'zh' ? 'en' : 'zh' })),

      setFontSize: (size) =>
        set(() => ({ fontSize: Math.max(10, Math.min(36, size)) })),

      setFontFamily: (fontFamily) =>
        set(() => ({ fontFamily })),

      setMonoFontFollowsInterface: (monoFontFollowsInterface) =>
        set(() => ({ monoFontFollowsInterface })),

      increaseFontSize: () =>
        set((state) => ({ fontSize: Math.min(36, state.fontSize + 1) })),

      decreaseFontSize: () =>
        set((state) => ({ fontSize: Math.max(10, state.fontSize - 1) })),

      setSidebarWidth: (width) =>
        set(() => ({ sidebarWidth: Math.max(180, Math.min(450, width)) })),

      setSetupCompleted: (completed) =>
        set(() => ({ setupCompleted: completed })),

      setThinkingLevel: (level) =>
        set(() => ({ thinkingLevel: level })),

      setContextWindowMode: (contextWindowMode) =>
        set((state) => {
          const oldDefault = defaultAutoCompactThreshold(state.contextWindowMode);
          const nextDefault = defaultAutoCompactThreshold(contextWindowMode);
          return {
            contextWindowMode,
            ...(state.autoCompactThresholdTokens === oldDefault
              ? { autoCompactThresholdTokens: nextDefault }
              : {}),
          };
        }),

      setCliBackend: (cliBackend) => set(() => ({ cliBackend })),

      setPreviewSidebarVisible: (previewSidebarVisible) =>
        set(() => ({ previewSidebarVisible })),
      setSkillsSidebarVisible: (skillsSidebarVisible) =>
        set(() => ({ skillsSidebarVisible })),
      setInterviewMimoModel: (interviewMimoModel) =>
        set(() => ({ interviewMimoModel })),
      setInterviewMimoBaseUrl: (interviewMimoBaseUrl) =>
        set(() => ({ interviewMimoBaseUrl })),
      setInterviewMimoApiKey: (interviewMimoApiKey) => {
        const seq = ++_apiKeyEncryptSeq;
        set({ interviewMimoApiKey, _enc_interviewMimoApiKey: interviewMimoApiKey ? undefined as any : '' });
        if (!interviewMimoApiKey) return;
        // S3: Encrypt for localStorage persistence (async side-effect).
        // Sequence-guarded: a slow resolve for an older key must not overwrite
        // a newer key's ciphertext. Retry once on transient failure; a
        // persistent failure is logged loudly (the key won't survive restart).
        const attempt = (retry: boolean): void => {
          encryptApiKey(interviewMimoApiKey)
            .then((enc) => {
              if (enc && seq === _apiKeyEncryptSeq) set({ _enc_interviewMimoApiKey: enc });
            })
            .catch((e) => {
              if (seq !== _apiKeyEncryptSeq) return;
              console.error(
                '[settingsStore] Failed to encrypt interviewMimoApiKey — key will NOT survive restart. Re-enter the key to retry:',
                e,
              );
              if (retry) attempt(false);
            });
        };
        attempt(true);
      },
      setInterviewMimoApiKeyEnv: (interviewMimoApiKeyEnv) =>
        set(() => ({ interviewMimoApiKeyEnv })),
      setInterviewPreset: (interviewPreset: 'mimo' | 'openai' | 'custom') => set(() => ({ interviewPreset })),
      setInterviewAsrModel: (interviewAsrModel: string) => set(() => ({ interviewAsrModel })),
      setInterviewIsSingleHop: (interviewIsSingleHop: boolean) => set(() => ({ interviewIsSingleHop })),
      setInterviewAnswerPrompt: (interviewAnswerPrompt: string) => set(() => ({ interviewAnswerPrompt })),
      setInterviewMaxTokens: (interviewMaxTokens: number) => set(() => ({ interviewMaxTokens })),
      setInterviewTemperature: (interviewTemperature: number) => set(() => ({ interviewTemperature })),
      setInterviewAsrBackend: (interviewAsrBackend: 'mimo' | 'local' | 'hybrid') => set(() => ({ interviewAsrBackend })),
      setIncludePartialMessages: (includePartialMessages: boolean) =>
        set(() => ({ includePartialMessages })),

      setAutoCompactThresholdTokens: (autoCompactThresholdTokens) =>
        set(() => ({ autoCompactThresholdTokens: clampAutoCompactThreshold(autoCompactThresholdTokens) })),

      setUpdateAvailable: (available, version) =>
        set(() => ({
          updateAvailable: available,
          ...(version !== undefined ? { updateVersion: version } : {}),
          ...(!available ? { updateVersion: '', updateDownloaded: false } : {}),
        })),

      setUpdateDownloaded: (downloaded) =>
        set(() => ({ updateDownloaded: downloaded })),

      setLastSeenVersion: (version) =>
        set(() => ({ lastSeenVersion: version })),

      setAiAvatarUrl: (url) => {
        set(() => ({ aiAvatarUrl: url }));
        // 报告B10: avatar data URLs persist under their own key — NOT through
        // the settings persist, which re-serializes on every settings change.
        const avatars = loadAvatars() ?? { aiAvatarUrl: '', userAvatarUrl: '' };
        saveAvatars(url, avatars.userAvatarUrl);
      },

      setUserAvatarUrl: (url) => {
        set(() => ({ userAvatarUrl: url }));
        const avatars = loadAvatars() ?? { aiAvatarUrl: '', userAvatarUrl: '' };
        saveAvatars(avatars.aiAvatarUrl, url);
      },

      setUserDisplayName: (name) =>
        set(() => ({ userDisplayName: name.slice(0, 20) })),
      toggleHiddenFiles: () =>
        set((state) => ({ showHiddenFiles: !state.showHiddenFiles })),
      setVideoAnalysisBaseUrl: (url) =>
        set(() => ({ videoAnalysisBaseUrl: url.trim() })),
      setVideoAnalysisApiKey: (key) => {
        const seq = ++_apiKeyEncryptSeq;
        set({ videoAnalysisApiKey: key, _enc_videoAnalysisApiKey: key ? undefined as any : '' });
        if (!key) return;
        // S3: Encrypt for localStorage persistence (async side-effect).
        // Sequence-guarded: a slow resolve for an older key must not overwrite
        // a newer key's ciphertext. Retry once on transient failure; a
        // persistent failure is logged loudly (the key won't survive restart).
        const attempt = (retry: boolean): void => {
          encryptApiKey(key)
            .then((enc) => {
              if (enc && seq === _apiKeyEncryptSeq) set({ _enc_videoAnalysisApiKey: enc });
            })
            .catch((e) => {
              if (seq !== _apiKeyEncryptSeq) return;
              console.error(
                '[settingsStore] Failed to encrypt videoAnalysisApiKey — key will NOT survive restart. Re-enter the key to retry:',
                e,
              );
              if (retry) attempt(false);
            });
        };
        attempt(true);
      },
      setVideoAnalysisApiKeyEnv: (name) =>
        set(() => ({ videoAnalysisApiKeyEnv: name.trim() })),
      setVideoAnalysisModel: (model) =>
        set(() => ({ videoAnalysisModel: model.trim() })),
      setVideoAnalysisAsrModel: (model) =>
        set(() => ({ videoAnalysisAsrModel: model })),
      setSpeechEnabled: (enabled) =>
        set(() => ({ speechEnabled: enabled })),
      setSpeechLanguage: (lang) =>
        set(() => ({ speechLanguage: lang })),
      setSpeechUseOfflineModel: (use) =>
        set(() => ({ speechUseOfflineModel: use })),
      setWallpaperEnabled: (enabled) =>
        set(() => ({ wallpaperEnabled: enabled })),
      setWallpaperName: (name) =>
        set(() => ({ wallpaperName: name })),
      setWallpaperQuality: (quality) =>
        set(() => ({ wallpaperQuality: quality })),
      setWallpaperOpacity: (opacity: number) =>
        set(() => ({ wallpaperOpacity: opacity })),
      setVideoAnalysisMultimodal: (cfg) =>
        set((state) => ({
          videoAnalysisBaseUrl:
            cfg.baseUrl !== undefined ? cfg.baseUrl.trim() : state.videoAnalysisBaseUrl,
          videoAnalysisApiKey:
            cfg.apiKey !== undefined ? cfg.apiKey : state.videoAnalysisApiKey,
          videoAnalysisApiKeyEnv:
            cfg.apiKeyEnv !== undefined ? cfg.apiKeyEnv.trim() : state.videoAnalysisApiKeyEnv,
          videoAnalysisModel:
            cfg.model !== undefined ? cfg.model.trim() : state.videoAnalysisModel,
        })),
    }),
    {
      name: 'tokenicode-settings',
      version: 21,
      // S3: Encryption is handled by _enc_* companion fields + encryptApiKey in setters.
      // Decryption happens here on hydration.
      onRehydrateStorage: () => {
        return (_state: unknown, error: unknown) => {
          if (error) {
            console.warn('[settingsStore] Rehydration failed:', error);
            return;
          }
          const current = useSettingsStore.getState() as unknown as Record<string, unknown>;
          decryptStoredApiKeys(current).then((updates) => {
            if (Object.keys(updates).length > 0) {
              useSettingsStore.setState(updates as Partial<SettingsState>);
            }
          });
          // 报告B10: merge avatar data URLs back from their own storage key.
          const avatars = loadAvatars();
          if (avatars) {
            useSettingsStore.setState(avatars);
          }
        };
      },
      migrate: (persistedState: unknown, version: number) => {
        const persisted = persistedState as Record<string, unknown>;
        if (version === 0) {
          // Migrate legacy model IDs to current ones
          const legacyMap: Record<string, ModelId> = {
            'claude-opus-4-0': 'claude-opus-4-6',
            'claude-sonnet-4-0': 'claude-sonnet-4-6',
            'claude-haiku-3-5': 'claude-haiku-4-5-20251001',
          };
          const old = persisted.selectedModel as string;
          if (old && legacyMap[old]) {
            persisted.selectedModel = legacyMap[old];
          }
        }
        if (version < 2) {
          persisted.updateAvailable = false;
          persisted.updateVersion = '';
          persisted.lastSeenVersion = '';
        }
        if (version < 3) {
          persisted.apiProviderMode = 'inherit';
          persisted.customProviderName = '';
          persisted.customProviderBaseUrl = '';
          persisted.customProviderModelMappings = [];
          persisted.customProviderApiFormat = 'anthropic';
        }
        if (version < 4) {
          // Migrate boolean thinkingEnabled → ThinkingLevel
          const oldThinking = persisted.thinkingEnabled;
          persisted.thinkingLevel = oldThinking === false ? 'off' : 'high';
          delete persisted.thinkingEnabled;
        }
        if (version < 5) {
          // Force default mode to bypass — old versions may have persisted 'code'/'ask'
          persisted.sessionMode = 'bypass';
        }
        if (version < 6) {
          // Fix Haiku model ID: claude-haiku-4-5 → claude-haiku-4-5-20251001
          if (persisted.selectedModel === 'claude-haiku-4-5') {
            persisted.selectedModel = 'claude-haiku-4-5-20251001';
          }
        }
        if (version < 7) {
          const migratedModel = migrateModelSelection(persisted.selectedModel);
          if (migratedModel) {
            persisted.selectedModel = migratedModel;
          }
        }
        if (version < 8) {
          persisted.backgroundTheme = 'minimal';
        }
        if (version < 9) {
          persisted.monoFontFollowsInterface = true;
        }
        if (version < 10) {
          persisted.contextWindowMode = 'default';
        }
        if (version < 11) {
          const mode = persisted.contextWindowMode === 'large1m' ? 'large1m' : 'default';
          persisted.autoCompactThresholdTokens = defaultAutoCompactThreshold(mode);
        }
        if (version < 12) {
          persisted.videoAnalysisBaseUrl = '';
          persisted.videoAnalysisApiKey = '';
          persisted.videoAnalysisModel = '';
        }
        if (version < 13) {
          persisted.videoAnalysisApiKeyEnv = '';
        }
        if (version < 14) {
          persisted.videoAnalysisAccelEnabled = false;
          persisted.videoAnalysisAsrModel = 'small';
        }
        if (version < 15) {
          persisted.speechEnabled = false;
          persisted.speechLanguage = 'zh';
          persisted.speechUseOfflineModel = false;
        }
        if (version < 16) {
          persisted.wallpaperEnabled = false;
          persisted.wallpaperName = '';
          persisted.wallpaperQuality = 'balanced';
        }
        if (version < 17) {
          persisted.wallpaperOpacity = 0.18;
        }
        if (version < 18) {
          persisted.codexUpdateAvailable = false;
          persisted.codexLatestVersion = '';
        }
        if (version < 19) {
          persisted.previewSidebarVisible = true;
          persisted.skillsSidebarVisible = true;
        }
        if (version < 20) {
          persisted.interviewMimoModel = 'mimo-v2.5-pro';
        }
        if (version < 21) {
          persisted.interviewMimoBaseUrl = '';
          persisted.interviewMimoApiKey = '';
          persisted.interviewMimoApiKeyEnv = '';
        }
        return persisted;
      },
      partialize: (state: SettingsState) => ({
        theme: state.theme,
        colorTheme: state.colorTheme,
        backgroundTheme: state.backgroundTheme,
        sidebarOpen: state.sidebarOpen,
        secondaryPanelWidth: state.secondaryPanelWidth,
        workingDirectory: state.workingDirectory,
        selectedModel: state.selectedModel,
        sessionMode: state.sessionMode,
        locale: state.locale,
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
        monoFontFollowsInterface: state.monoFontFollowsInterface,
        sidebarWidth: state.sidebarWidth,
        setupCompleted: state.setupCompleted,
        thinkingLevel: state.thinkingLevel,
        contextWindowMode: state.contextWindowMode,
        autoCompactThresholdTokens: state.autoCompactThresholdTokens,
        updateAvailable: state.updateAvailable,
        updateVersion: state.updateVersion,
        lastSeenVersion: state.lastSeenVersion,
        // 报告B10: avatar data URLs excluded — persisted under AVATARS_STORAGE_KEY.
        userDisplayName: state.userDisplayName,
        showHiddenFiles: state.showHiddenFiles,
        videoAnalysisBaseUrl: state.videoAnalysisBaseUrl,
        // S3: Persist encrypted api key, not plaintext
        _enc_videoAnalysisApiKey: state._enc_videoAnalysisApiKey,
        videoAnalysisApiKeyEnv: state.videoAnalysisApiKeyEnv,
        videoAnalysisModel: state.videoAnalysisModel,
        videoAnalysisAccelEnabled: state.videoAnalysisAccelEnabled,
        videoAnalysisAsrModel: state.videoAnalysisAsrModel,
        speechEnabled: state.speechEnabled,
        speechLanguage: state.speechLanguage,
        speechUseOfflineModel: state.speechUseOfflineModel,
        wallpaperEnabled: state.wallpaperEnabled,
        wallpaperName: state.wallpaperName,
        wallpaperQuality: state.wallpaperQuality,
        wallpaperOpacity: state.wallpaperOpacity,
        cliBackend: state.cliBackend,
        cliUpdateAvailable: state.cliUpdateAvailable,
        cliLatestVersion: state.cliLatestVersion,
        codexUpdateAvailable: state.codexUpdateAvailable,
        codexLatestVersion: state.codexLatestVersion,
        previewSidebarVisible: state.previewSidebarVisible,
        skillsSidebarVisible: state.skillsSidebarVisible,
        interviewMimoModel: state.interviewMimoModel,
        interviewMimoBaseUrl: state.interviewMimoBaseUrl,
        // S3: Persist encrypted api key, not plaintext
        _enc_interviewMimoApiKey: state._enc_interviewMimoApiKey,
        interviewMimoApiKeyEnv: state.interviewMimoApiKeyEnv,
        interviewPreset: state.interviewPreset,
        interviewAsrModel: state.interviewAsrModel,
        interviewIsSingleHop: state.interviewIsSingleHop,
        interviewAnswerPrompt: state.interviewAnswerPrompt,
        interviewMaxTokens: state.interviewMaxTokens,
        interviewTemperature: state.interviewTemperature,
        interviewAsrBackend: state.interviewAsrBackend,
        includePartialMessages: state.includePartialMessages,
      }),
    },
  ),
);

/** True when baseUrl + model + (apiKey OR apiKeyEnv) are non-empty. */
export function hasVideoAnalysisMultimodalDefaults(state?: {
  videoAnalysisBaseUrl?: string;
  videoAnalysisApiKey?: string;
  videoAnalysisApiKeyEnv?: string;
  videoAnalysisModel?: string;
}): boolean {
  const s = state ?? useSettingsStore.getState();
  const hasSecret = Boolean(
    s.videoAnalysisApiKey?.trim() || s.videoAnalysisApiKeyEnv?.trim(),
  );
  return Boolean(
    s.videoAnalysisBaseUrl?.trim() && hasSecret && s.videoAnalysisModel?.trim(),
  );
}

// --- Per-session effective value helpers (Phase 4) ---
// These read the snapshotted value from SessionMeta, falling back to the global store.
// Import SessionMeta lazily to avoid circular dependency.

/** Get the effective session mode for a given session's meta snapshot */
export function getEffectiveMode(meta: { snapshotMode?: SessionMode } | undefined): SessionMode {
  return meta?.snapshotMode ?? useSettingsStore.getState().sessionMode;
}

/** Get the effective model for a given session's meta snapshot */
export function getEffectiveModel(meta: { snapshotModel?: string } | undefined): string {
  return meta?.snapshotModel ?? useSettingsStore.getState().selectedModel;
}

/** Get the effective thinking level for a given session's meta snapshot */
export function getEffectiveThinking(meta: { snapshotThinking?: ThinkingLevel } | undefined): ThinkingLevel {
  return meta?.snapshotThinking ?? useSettingsStore.getState().thinkingLevel;
}

export function isLargeContextMode(model?: string, mode?: ContextWindowMode): boolean {
  if (mode === 'large1m') return true;
  const lower = (model || '').toLowerCase();
  return lower.includes('1m') || lower.includes('[1m]');
}

export function getContextWindowForModel(model?: string, mode?: ContextWindowMode): number {
  return isLargeContextMode(model, mode) ? 1_000_000 : 200_000;
}

export function getAutoCompactThreshold(model?: string, mode?: ContextWindowMode, overrideTokens?: number): number {
  if (typeof overrideTokens === 'number') {
    return clampAutoCompactThreshold(overrideTokens);
  }
  return getContextWindowForModel(model, mode) >= 1_000_000 ? 800_000 : 160_000;
}

// --- Runtime mode switching via SDK control protocol ---
// When sessionMode changes and there's an active CLI session, send set_permission_mode.

let _skipNextModeSync = false;

/** Monotonic sequence for the async `_enc_*` encrypt side-effects — lets a
 *  setter for a newer key invalidate an older key's in-flight encryption. */
let _apiKeyEncryptSeq = 0;

/** Update frontend sessionMode WITHOUT sending set_permission_mode to CLI.
 *  Use when CLI already switched modes internally (e.g. after ExitPlanMode allow). */
export function setSessionModeLocal(mode: SessionMode): void {
  _skipNextModeSync = true;
  useSettingsStore.getState().setSessionMode(mode);
}

useSettingsStore.subscribe((state, prevState) => {
  if (state.sessionMode === prevState.sessionMode) return;

  if (_skipNextModeSync) {
    _skipNextModeSync = false;
    return;
  }

  const cliMode = mapSessionModeToPermissionMode(state.sessionMode);

  // bypass uses --dangerously-skip-permissions at startup; can't switch TO bypass at runtime
  if (cliMode === 'bypassPermissions') return;

  // Dynamically import to avoid circular deps
  Promise.all([
    import('../lib/tauri-bridge'),
    import('./chatStore'),
  ]).then(([{ bridge }, { getActiveTabState }]) => {
    const stdinId = getActiveTabState().sessionMeta.stdinId;
    if (!stdinId) return; // No active session

    bridge.setPermissionMode(stdinId, cliMode).catch((err: unknown) => {
      console.error('[LITTLECLAUDE] Failed to set permission mode:', err);
    });
  });
});
