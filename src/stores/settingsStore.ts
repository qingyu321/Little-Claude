import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEEPSEEK_V4_FLASH,
  DEEPSEEK_V4_PRO,
  normalizeDeepSeekModelName,
} from '../lib/model-utils';
import { decryptStoredApiKeys, encryptApiKey, ENCRYPTED_KEY_PAIRS } from '../lib/encrypted-storage';

// --- Types ---

export type Theme = 'light' | 'dark' | 'system';
export type ColorTheme = 'black' | 'blue' | 'orange' | 'green';
export type BackgroundTheme = 'garden' | 'sakura' | 'lake' | 'dusk' | 'ink' | 'vscode' | 'minimal' | 'deepseek';
export type WallpaperQuality = 'fast' | 'balanced' | 'quality';
export type SecondaryPanelTab = 'files' | 'preview' | 'skills' | 'plugins' | 'interview';
export type ModelId = 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';
export type SessionMode = 'code' | 'ask' | 'plan' | 'bypass';

/** DSH busy-Enter policy: queue follow-ups while running, or steer (interrupt & send) */
export type BusyEnterMode = 'queue' | 'steer';
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

/** How the auto-compact threshold is chosen (user-selectable, GeneralTab).
 *  - 'auto'   → window − 20K output reservation − 13K buffer, exactly the
 *    Claude CLI's own auto-compact point (token-budget docs). Scales with the
 *    window: 1M → ~967K (96.7%), 200K → ~167K (83.5%). The old fixed-80% rule
 *    compacted 1M sessions a full 17% earlier than the CLI itself.
 *  - 'pct90' / 'pct80' → fixed fractions of the declared window.
 *  - 'custom' → the user's autoCompactThresholdTokens value. */
export type AutoCompactMode = 'auto' | 'pct90' | 'pct80' | 'custom';

// CLI constants (token-budget docs): auto-compact fires at window − output
// reservation − buffer; warning fires WARNING_LEAD_TOKENS before that.
const OUTPUT_RESERVATION_TOKENS = 20_000;
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_LEAD_TOKENS = 20_000;

function contextWindowSize(mode: ContextWindowMode): number {
  return mode === 'large1m' ? 1_000_000 : 200_000;
}

function defaultAutoCompactThreshold(mode: ContextWindowMode): number {
  return contextWindowSize(mode) - OUTPUT_RESERVATION_TOKENS - AUTOCOMPACT_BUFFER_TOKENS;
}

function clampAutoCompactThreshold(tokens: number, window: number): number {
  // L1: non-finite input falls back to the CLI-aligned default of the CURRENT
  // window — a 1M window must not drop to the 200K default (over-eager compact).
  if (!Number.isFinite(tokens)) return window - OUTPUT_RESERVATION_TOKENS - AUTOCOMPACT_BUFFER_TOKENS;
  // B3: never exceed the active window — a custom threshold inherited from a
  // larger window would silently disable app-level compaction.
  return Math.max(10_000, Math.min(window - 1_000, Math.round(tokens)));
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

// --- Imported pet skins ---
// The list of imported pet ids lives under its own key (not the settings blob)
// so adding a skin never re-serializes the whole settings object. The pet.json
// contents themselves are on disk under ~/.tokenicode/pets/<id>/.
const PET_SKINS_STORAGE_KEY = 'tokenicode_pet_skins_v1';

function savePetSkins(skins: string[]) {
  try {
    localStorage.setItem(PET_SKINS_STORAGE_KEY, JSON.stringify(skins));
  } catch (e) {
    console.error('[settingsStore] pet skins save failed:', e);
  }
}

export function loadPetSkins(): string[] {
  try {
    const raw = localStorage.getItem(PET_SKINS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === 'string');
    }
  } catch {
    // fall through to empty
  }
  return [];
}

export function addPetSkin(id: string): void {
  const cur = loadPetSkins();
  if (!cur.includes(id)) {
    savePetSkins([...cur, id]);
  }
}

export function removePetSkin(id: string): void {
  savePetSkins(loadPetSkins().filter((s) => s !== id));
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
  // 'claude-opus-4-6-1m' was removed as a selectable model (the "声明 1M"
  // switch + [1m] suffix replaced it) — keep the migration so persisted
  // selections from older installs still resolve.
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
  /** Busy-Enter: 'queue' (default) or 'steer' — Ctrl+Enter flips it at submit time */
  busyEnter: BusyEnterMode;
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
  /** F22: 用户在 SetupWizard 选择了跳过（CLI 可能未安装）——聊天区顶部横幅提示 */
  setupSkipped: boolean;
  /** Whether the user has finished the onboarding tutorial (persisted) */
  onboardingCompleted: boolean;
  /** Whether the onboarding wizard is currently open (transient, not persisted) */
  onboardingOpen: boolean;
  /** Thinking effort level: off disables, low/medium/high/max set effort */
  thinkingLevel: ThinkingLevel;
  /** Declares that the selected/provider model supports a 1M context window. */
  contextWindowMode: ContextWindowMode;
  /** User-adjustable auto compact threshold in tokens (used when mode is 'custom'). */
  autoCompactThresholdTokens: number;
  /** User's chosen auto-compact timing policy (defaults to CLI-aligned 'auto'). */
  autoCompactMode: AutoCompactMode;
  /** Learned 1M models from runtime evidence: a success turn whose context
   *  exceeded 900K proves the model's real window is ≥1M (a 200K-class model
   *  would have been rejected by the API long before). Next spawn declares 1M
   *  automatically — the fallback for models the LiteLLM table doesn't know. */
  learned1mModels: Record<string, boolean>;
  /** LiteLLM model-window table cache { model-key → max_input_tokens }.
   *  In-memory only (loaded once at startup via load_model_windows) so
   *  getContextWindowForModel resolves synchronously during renders. */
  modelWindows: Record<string, number>;
  /** Whether closing the window asks for confirmation (default true) */
  confirmOnClose: boolean;
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
  /** Active CLI backend: "claude" (default), "codex" or "deepseek" (DSH headless). Independent of API provider. */
  cliBackend: 'claude' | 'codex' | 'deepseek';
  /** 模块管理 — 侧边栏预览按钮显隐 */
  previewSidebarVisible: boolean;
  /** 模块管理 — 侧边栏技能按钮显隐 */
  skillsSidebarVisible: boolean;
  /** 模块管理 — 侧边栏面试按钮显隐（旧版模块管理的第三张卡片，曾被移除，
   *  2026-08-03 恢复；面试进行中关闭需二次确认） */
  interviewSidebarVisible: boolean;
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
  /** 桌面宠物 — 是否启用 */
  petEnabled: boolean;
  /** 桌面宠物 — 显示缩放 (0.25–3.0，PetTab 滑块 + 预设) */
  petScale: number;
  /** 桌面宠物 — 当前皮肤 id（"default" 或已导入宠物 id） */
  petSkin: string;
  /** 桌面宠物 — 任务完成/出错时发送系统通知 */
  petNotify: boolean;
  /** Transient request: open the settings panel on this tab (pet window "设置" button).
   *  Consumed once by SettingsPanel on mount/open, then cleared. NEVER persisted. */
  settingsOpenRequest: { tab: string } | null;

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
  setBusyEnter: (mode: BusyEnterMode) => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: FontFamily) => void;
  setMonoFontFollowsInterface: (enabled: boolean) => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  setSidebarWidth: (width: number) => void;
  setSetupCompleted: (completed: boolean) => void;
  /** F22: 设置 SetupWizard 跳过标记 */
  setSetupSkipped: (skipped: boolean) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  setOnboardingOpen: (open: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  setContextWindowMode: (mode: ContextWindowMode) => void;
  setCliBackend: (backend: 'claude' | 'codex' | 'deepseek') => void;
  setModelWindows: (modelWindows: Record<string, number>) => void;
  learnModel1m: (model: string) => void;
  setAutoCompactThresholdTokens: (tokens: number) => void;
  setAutoCompactMode: (mode: AutoCompactMode) => void;
  setConfirmOnClose: (confirm: boolean) => void;
  setPreviewSidebarVisible: (v: boolean) => void;
  setSkillsSidebarVisible: (v: boolean) => void;
  setInterviewSidebarVisible: (v: boolean) => void;
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
  setPetEnabled: (enabled: boolean) => void;
  setPetScale: (scale: number) => void;
  setPetSkin: (skin: string) => void;
  setPetNotify: (v: boolean) => void;
  setSettingsOpenRequest: (req: { tab: string } | null) => void;
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
      backgroundTheme: 'deepseek',
      sidebarOpen: true,
      secondaryPanelOpen: false,
      secondaryPanelTab: 'files',
      secondaryPanelWidth: 300,
      settingsOpen: false,
      agentPanelOpen: false,
      workingDirectory: '',
      selectedModel: 'claude-sonnet-4-6',
      sessionMode: 'code',
      busyEnter: 'queue',
      locale: 'zh',
      fontSize: 18,
      fontFamily: 'microsoft',
      monoFontFollowsInterface: true,
      sidebarWidth: 280,
      setupCompleted: false,
      setupSkipped: false, // F22
      onboardingCompleted: false,
      onboardingOpen: false,
      thinkingLevel: 'medium' as ThinkingLevel,
      contextWindowMode: 'default',
      autoCompactThresholdTokens: 160_000,
      autoCompactMode: 'auto',
      learned1mModels: {},
      modelWindows: {},
      confirmOnClose: true,
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
      petEnabled: false,
      petScale: 1,
      petSkin: 'default',
      petNotify: true,
      settingsOpenRequest: null,
      wallpaperName: '',
      wallpaperQuality: 'balanced' as WallpaperQuality,
      wallpaperOpacity: 0.18,
      // DeepSeek Harness is the preferred backend (2026-08-14): service mode
      // gives real streaming + context continuity out of the box.
      cliBackend: 'deepseek' as 'claude' | 'codex' | 'deepseek',
      previewSidebarVisible: true,
      skillsSidebarVisible: true,
      interviewSidebarVisible: true,
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
      // F25: 默认改 false（与 Rust 侧同步）——partial messages 产生 10-50× 流事件量；
      // 设置项保留可手动开启。字段在 persist partialize 中，已存用户值不受影响。
      includePartialMessages: false,

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

      setWorkingDirectory: (dir) => {
        // B1: keep the backend's authorized-path gate in sync — the user
        // picked this folder as the workspace; without registration, file
        // browsing/preview would be rejected before the first session spawns
        // (the session start registers it too, belt-and-braces).
        if (dir) {
          import('../lib/tauri-bridge').then(({ bridge }) => {
            bridge.registerWorkspaceRoot(dir).catch(() => {});
          });
        }
        set(() => ({ workingDirectory: dir }));
      },

      setSelectedModel: (model) =>
        set(() => ({ selectedModel: model })),

      setSessionMode: (mode) =>
        set(() => ({ sessionMode: mode })),

      setBusyEnter: (mode) =>
        set(() => ({ busyEnter: mode })),

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

      // F22: SetupWizard 跳过标记（聊天区 CLI 缺失常驻横幅据此显示）
      setSetupSkipped: (skipped) =>
        set(() => ({ setupSkipped: skipped })),

      setOnboardingCompleted: (completed) =>
        set(() => ({ onboardingCompleted: completed })),

      setOnboardingOpen: (open) =>
        set(() => ({ onboardingOpen: open })),

      setConfirmOnClose: (confirm) =>
        set(() => ({ confirmOnClose: confirm })),

      setThinkingLevel: (level) =>
        set(() => ({ thinkingLevel: level })),

      setContextWindowMode: (contextWindowMode) =>
        set((state) => {
          // 'auto' mode derives the threshold from the window on every read —
          // nothing to migrate. Only a stale 'custom' tokens value (still the
          // window's old default) follows the new window's default.
          const oldDefault = defaultAutoCompactThreshold(state.contextWindowMode);
          const nextDefault = defaultAutoCompactThreshold(contextWindowMode);
          return {
            contextWindowMode,
            ...(state.autoCompactMode === 'custom'
              && state.autoCompactThresholdTokens === oldDefault
              ? { autoCompactThresholdTokens: nextDefault }
              : {}),
          };
        }),

      setCliBackend: (cliBackend) => set(() => ({ cliBackend })),

      /** Replace the in-memory LiteLLM table cache (called once at startup). */
      setModelWindows: (modelWindows) => set(() => ({ modelWindows })),

      /** Record a model as learned-1M (runtime evidence) so future spawns
       *  declare its 1M window. Persisted; fires the toast flag once per model. */
      learnModel1m: (model) => {
        if (!model) return;
        set((state) => {
          if (state.learned1mModels[model]) return {};
          return { learned1mModels: { ...state.learned1mModels, [model]: true } };
        });
      },

      setPreviewSidebarVisible: (previewSidebarVisible) =>
        set(() => ({ previewSidebarVisible })),
      setSkillsSidebarVisible: (skillsSidebarVisible) =>
        set(() => ({ skillsSidebarVisible })),
      setInterviewSidebarVisible: (interviewSidebarVisible) =>
        set(() => ({ interviewSidebarVisible })),
      setInterviewMimoModel: (interviewMimoModel) =>
        set(() => ({ interviewMimoModel })),
      setInterviewMimoBaseUrl: (interviewMimoBaseUrl) =>
        set(() => ({ interviewMimoBaseUrl })),
      setInterviewMimoApiKey: (interviewMimoApiKey) => {
        const seq = ++_apiKeyEncryptSeq.interviewMimoApiKey;
        // B3: keep the previous ciphertext until the new one is committed.
        // Clearing it synchronously opened a window where exiting the app
        // before async encryption finished lost the key entirely — now the
        // old ciphertext stays valid, so a crash/exit mid-encryption still
        // leaves the previous key usable.
        set({ interviewMimoApiKey });
        if (!interviewMimoApiKey) {
          // Clearing the key: drop the stored ciphertext too.
          set({ _enc_interviewMimoApiKey: '' });
          return;
        }
        // S3: Encrypt for localStorage persistence (async side-effect).
        // Sequence-guarded (per-field seq): a slow resolve for an older value
        // of THIS key must not overwrite a newer value's ciphertext. Retry once
        // on transient failure; a persistent failure is logged loudly (the key
        // won't survive restart).
        const attempt = (retry: boolean): void => {
          encryptApiKey(interviewMimoApiKey)
            .then((enc) => {
              if (enc && seq === _apiKeyEncryptSeq.interviewMimoApiKey) set({ _enc_interviewMimoApiKey: enc });
            })
            .catch((e) => {
              if (seq !== _apiKeyEncryptSeq.interviewMimoApiKey) return;
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
        set((state) => ({
          autoCompactThresholdTokens: clampAutoCompactThreshold(
            autoCompactThresholdTokens,
            contextWindowSize(state.contextWindowMode),
          ),
        })),

      setAutoCompactMode: (autoCompactMode) => set(() => ({ autoCompactMode })),

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
        const seq = ++_apiKeyEncryptSeq.videoAnalysisApiKey;
        // B3: same as setInterviewMimoApiKey — keep the old ciphertext
        // until the new one is committed (no loss window on exit).
        set({ videoAnalysisApiKey: key });
        if (!key) {
          set({ _enc_videoAnalysisApiKey: '' });
          return;
        }
        // S3: Encrypt for localStorage persistence (async side-effect).
        // Sequence-guarded: a slow resolve for an older key must not overwrite
        // a newer key's ciphertext. Retry once on transient failure; a
        // persistent failure is logged loudly (the key won't survive restart).
        const attempt = (retry: boolean): void => {
          encryptApiKey(key)
            .then((enc) => {
              if (enc && seq === _apiKeyEncryptSeq.videoAnalysisApiKey) set({ _enc_videoAnalysisApiKey: enc });
            })
            .catch((e) => {
              if (seq !== _apiKeyEncryptSeq.videoAnalysisApiKey) return;
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
      setVideoAnalysisMultimodal: (cfg) => {
        // S3: route the key through the encrypting setter so the multimodal
        // form's key is persisted encrypted too (previously set in plaintext
        // and never survived a restart).
        if (cfg.apiKey !== undefined && cfg.apiKey !== useSettingsStore.getState().videoAnalysisApiKey) {
          useSettingsStore.getState().setVideoAnalysisApiKey(cfg.apiKey);
        }
        set((state) => ({
          videoAnalysisBaseUrl:
            cfg.baseUrl !== undefined ? cfg.baseUrl.trim() : state.videoAnalysisBaseUrl,
          videoAnalysisApiKey:
            cfg.apiKey !== undefined ? cfg.apiKey : state.videoAnalysisApiKey,
          videoAnalysisApiKeyEnv:
            cfg.apiKeyEnv !== undefined ? cfg.apiKeyEnv.trim() : state.videoAnalysisApiKeyEnv,
          videoAnalysisModel:
            cfg.model !== undefined ? cfg.model.trim() : state.videoAnalysisModel,
        }));
      },
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
      setPetEnabled: (enabled) =>
        set(() => ({ petEnabled: enabled })),
      setPetScale: (scale) =>
        set(() => ({ petScale: scale })),
      setPetSkin: (skin) =>
        set(() => ({ petSkin: skin })),
      setPetNotify: (v) =>
        set(() => ({ petNotify: v })),
      setSettingsOpenRequest: (req) =>
        set(() => ({ settingsOpenRequest: req })),
    }),
    {
      name: 'tokenicode-settings',
      version: 30,
      // 头像（报告B10）必须在 merge 里恢复，不能在 onRehydrateStorage 的
      // post 回调中 setState：persist 对同步 localStorage 的 hydrate 是同步
      // 执行的，post 回调在 create() 返回前运行，此时模块顶层的
      // useSettingsStore 处于 TDZ，访问会抛 ReferenceError，导致头像与
      // 加密 key 的解密从不执行（症状：头像每次重启丢失、名字正常——
      // 名字由 hydrate 的 set() 恢复，头像只能靠 post 回调）。
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Record<string, unknown>),
        ...(loadAvatars() ?? {}),
      }),
      // S3: Encryption is handled by _enc_* companion fields + encryptApiKey in setters.
      // Decryption happens here on hydration. Must be deferred past module
      // initialization (TDZ), so it runs in a microtask after create() returns.
      onRehydrateStorage: () => {
        return (_state: unknown, error: unknown) => {
          if (error) {
            console.warn('[settingsStore] Rehydration failed:', error);
            return;
          }
          queueMicrotask(() => {
            const before = useSettingsStore.getState() as unknown as Record<string, unknown>;
            decryptStoredApiKeys(before).then((updates) => {
              // Guard against racing the user: decrypt is async (IPC round
              // trip); if the user typed a new key between the snapshot and
              // now, the ciphertext changed and applying the stale plaintext
              // would overwrite it. Skip fields whose _enc_* moved.
              const after = useSettingsStore.getState() as unknown as Record<string, unknown>;
              const safe: Record<string, string> = {};
              // Iterate the shared pair list (encrypted-storage.ts) so new
              // encrypted keys are applied here automatically — the previous
              // hardcoded copy silently dropped videoAnalysisApiKey.
              for (const [plain, enc] of ENCRYPTED_KEY_PAIRS) {
                if (updates[plain] && after[enc] === before[enc]) safe[plain] = updates[plain];
              }
              if (Object.keys(safe).length > 0) {
                useSettingsStore.setState(safe as Partial<SettingsState>);
              }
            }).catch((e) => console.error('[settingsStore] decrypt after hydration failed:', e));
          });
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
          // v5 historically force-set bypass; that made every tool call
          // auto-approved (--dangerously-skip-permissions). Keep the
          // user's stored mode when present; only fresh installs (no
          // stored value) get the app default (see sessionMode initial).
          if (persisted.sessionMode === undefined) {
            persisted.sessionMode = 'code';
          }
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
          // Historical default was the fixed-80% rule (160K / 800K). Written
          // literally, NOT via defaultAutoCompactThreshold — that function now
          // returns the CLI-aligned window−33K value, which would make v26's
          // "did the user ever change it?" check misclassify this as custom.
          const mode = persisted.contextWindowMode === 'large1m' ? 'large1m' : 'default';
          persisted.autoCompactThresholdTokens = mode === 'large1m' ? 800_000 : 160_000;
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
        if (version < 22) {
          persisted.interviewSidebarVisible = true;
        }
        if (version < 23) {
          persisted.petEnabled = false;
          persisted.petScale = 1;
        }
        if (version < 24) {
          persisted.petSkin = 'default';
        }
        if (version < 25) {
          // 新手教程：老用户（已完成 setup）升级后不弹；真新用户无持久化数据走默认 false
          persisted.onboardingCompleted = persisted.setupCompleted === true;
        }
        if (version < 26) {
          // Auto-compact threshold becomes user-selectable (auto / 90% / 80% /
          // custom). Legacy data only ever held the fixed-80% value: the old
          // default (160K / 800K) means "never touched" → upgrade to the
          // CLI-aligned 'auto'; anything else was a deliberate choice → keep
          // the tokens as 'custom'.
          const mode = persisted.contextWindowMode === 'large1m' ? 'large1m' : 'default';
          const legacyDefault = mode === 'large1m' ? 800_000 : 160_000;
          const tokens = persisted.autoCompactThresholdTokens as number | undefined;
          if (tokens === undefined || tokens === legacyDefault) {
            persisted.autoCompactMode = 'auto';
          } else {
            persisted.autoCompactMode = 'custom';
          }
        }
        if (version < 28) {
          // 桌宠完成通知：老用户升级默认开启（可在设置关闭）
          persisted.petNotify = true;
        }
        if (version < 29) {
          // Learned-1M map added (runtime evidence learning). Empty for
          // existing users — models get learned on first 900K+ success turn.
          (persisted as Record<string, unknown>).learned1mModels = {};
        }
        if (version < 30) {
          // v30 字体修复：早期版本的 persist 默认值是 14（与注释 "default 18"
          // 不符），dev 隔离目录的磁盘快照也被初始默认 14 灌回，用户看到
          // "字体变小"。把 14 一律升级为 18——14 从未是用户主动选择的正常值。
          if (persisted.fontSize === 14) {
            persisted.fontSize = 18;
          }
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
        busyEnter: state.busyEnter,
        locale: state.locale,
        fontSize: state.fontSize,
        fontFamily: state.fontFamily,
        monoFontFollowsInterface: state.monoFontFollowsInterface,
        sidebarWidth: state.sidebarWidth,
        setupCompleted: state.setupCompleted,
        setupSkipped: state.setupSkipped, // F22
        onboardingCompleted: state.onboardingCompleted,
        thinkingLevel: state.thinkingLevel,
        contextWindowMode: state.contextWindowMode,
        autoCompactThresholdTokens: state.autoCompactThresholdTokens,
        autoCompactMode: state.autoCompactMode,
        learned1mModels: state.learned1mModels,
        confirmOnClose: state.confirmOnClose,
        updateAvailable: state.updateAvailable,
        updateVersion: state.updateVersion,
        lastSeenVersion: state.lastSeenVersion,
        // 报告B10: avatar data URLs excluded — persisted under AVATARS_STORAGE_KEY.
        userDisplayName: state.userDisplayName,
        showHiddenFiles: state.showHiddenFiles,
        speechEnabled: state.speechEnabled,
        speechLanguage: state.speechLanguage,
        speechUseOfflineModel: state.speechUseOfflineModel,
        wallpaperEnabled: state.wallpaperEnabled,
        petEnabled: state.petEnabled,
        petScale: state.petScale,
        petSkin: state.petSkin,
        petNotify: state.petNotify,
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
        interviewSidebarVisible: state.interviewSidebarVisible,
        interviewMimoModel: state.interviewMimoModel,
        interviewMimoBaseUrl: state.interviewMimoBaseUrl,
        // S3: Persist encrypted api key, not plaintext
        _enc_interviewMimoApiKey: state._enc_interviewMimoApiKey,
        // S3 (video analysis): same encrypted-key pattern as interview — the
        // base URL / model / ASR settings were previously not persisted at
        // all, so every restart silently wiped the whole video config.
        videoAnalysisBaseUrl: state.videoAnalysisBaseUrl,
        videoAnalysisApiKeyEnv: state.videoAnalysisApiKeyEnv,
        _enc_videoAnalysisApiKey: state._enc_videoAnalysisApiKey,
        videoAnalysisModel: state.videoAnalysisModel,
        videoAnalysisAccelEnabled: state.videoAnalysisAccelEnabled,
        videoAnalysisAsrModel: state.videoAnalysisAsrModel,
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

/** Hardcoded 1M-family fallback — used only when the LiteLLM table cache is
 *  empty (offline first run) and the model was never runtime-learned. Mirrors
 *  the Rust fallback inference (session.rs). 1M-context families verified as
 *  of 2026-08 (a 259K-token DeepSeek V4 session was previously misread as
 *  200K-exceeded → constant 100% bar):
 *   - deepseek-v4-pro / -flash (1M is standard for V4)
 *   - mimo (presets mark the 1M tier explicitly as mimo-v2-pro[1m])
 *   - qwen3.5-plus / qwen3.6-plus / qwen3-coder-plus (Alibaba; the open-weight
 *     qwen3.5-397b and qwen3-max are 262K and intentionally do NOT match)
 *   - glm-5.2 (Zhipu; glm-5 / glm-5.1 / glm-4.7 are 200K and do NOT match)
 *   - kimi-k3 (Moonshot; kimi-k2.x are 256K and do NOT match)
 *   - minimax-m3 (MiniMax; m2.x are 200K and do NOT match)
 *   - longcat-2.x (Meituan)
 * NO bare '1m' substring match — a 200K "glm-5-1m" variant must not be
 * classified 1M (keeps the two sides from drifting apart). V3-era
 * deepseek-chat/reasoner (128K/64K) intentionally do NOT match either. */
function isKnown1mFamily(model?: string): boolean {
  const lower = (model || '').toLowerCase();
  return lower.includes('mimo') || lower.includes('[1m]')
    || lower.startsWith('deepseek-v4') || lower.includes('deepseek-v4')
    || lower.includes('qwen3.5-plus') || lower.includes('qwen3.6-plus')
    || lower.includes('qwen3-coder-plus') || lower.includes('glm-5.2')
    || lower.includes('kimi-k3') || lower.includes('minimax-m3')
    || lower.includes('longcat-2');
}

/** Mirror of the Rust lookup (model_windows.rs): exact match on the bare id
 *  or a key's last /-segment wins; substring fallback takes the MAXIMUM
 *  window across hits (the model's own window is a property of the model,
 *  provider-specific overrides are deployment details we can't see). */
export function windowFromTable(table: Record<string, number>, model: string): number | undefined {
  const m = model.trim().toLowerCase();
  if (!m || !table || Object.keys(table).length === 0) return undefined;
  if (table[m] != null) return table[m];
  for (const [key, val] of Object.entries(table)) {
    if (key === m || key.split('/').pop() === m) return val;
  }
  let best: number | undefined;
  for (const [key, val] of Object.entries(table)) {
    if (key.includes(m)) best = best === undefined ? val : Math.max(best, val);
  }
  return best;
}

export function isLargeContextMode(model?: string, mode?: ContextWindowMode): boolean {
  if (mode === 'large1m') return true;
  return getContextWindowForModel(model, mode) >= 900_000;
}

/** Resolve a model's context window — five tiers, most authoritative first:
 *  1. Manual 大上下文 mode (user override, wins over everything).
 *  2. Runtime-learned 1M (a success turn exceeded 900K of context).
 *  3. LiteLLM table cache — exact window, ANY value (262K/512K/1M…), loaded
 *     once at startup from the Rust cache (see model_windows.rs).
 *  4. Hardcoded 1M-family list (offline fallback).
 *  5. 200K default. */
export function getContextWindowForModel(model?: string, mode?: ContextWindowMode): number {
  if (mode === 'large1m') return 1_000_000;
  const st = useSettingsStore.getState();
  if (model && st.learned1mModels[model]) return 1_000_000;
  if (model) {
    const tableWindow = windowFromTable(st.modelWindows, model);
    if (tableWindow !== undefined) return tableWindow;
  }
  return isKnown1mFamily(model) ? 1_000_000 : 200_000;
}

export function getAutoCompactThreshold(
  model?: string,
  mode?: ContextWindowMode,
  overrideTokens?: number,
  autoCompactMode: AutoCompactMode = 'auto',
): number {
  const window = getContextWindowForModel(model, mode);
  switch (autoCompactMode) {
    case 'custom':
      if (typeof overrideTokens === 'number') {
        // B3: clamp into the CURRENT window on every read — a custom value set
        // under a 1M window (e.g. 500K) must never outlive a switch back to
        // 200K, where it would exceed the window and silence auto-compact.
        return clampAutoCompactThreshold(overrideTokens, window);
      }
      break; // no custom value — fall through to the CLI-aligned default
    case 'pct90':
      return Math.round(window * 0.9);
    case 'pct80':
      return Math.round(window * 0.8);
    case 'auto':
    default:
      return window - OUTPUT_RESERVATION_TOKENS - AUTOCOMPACT_BUFFER_TOKENS;
  }
  return window - OUTPUT_RESERVATION_TOKENS - AUTOCOMPACT_BUFFER_TOKENS;
}

/** Context warning point: fires WARNING_LEAD_TOKENS before auto-compact
 *  (CLI's WARNING_THRESHOLD_BUFFER_TOKENS semantics). 1M → ~947K, 200K → ~147K. */
export function getContextWarningThreshold(
  model?: string,
  mode?: ContextWindowMode,
  overrideTokens?: number,
  autoCompactMode: AutoCompactMode = 'auto',
): number {
  const threshold = getAutoCompactThreshold(model, mode, overrideTokens, autoCompactMode);
  // L2: a 50K floor would invert the ordering for very small custom thresholds
  // (warning point later than compact point). Never let the warning trail the
  // compact point — the floor only applies when it still leads by 1K+.
  return Math.max(threshold - WARNING_LEAD_TOKENS, Math.min(threshold - 1_000, 50_000));
}

// --- Runtime mode switching via SDK control protocol ---
// When sessionMode changes and there's an active CLI session, send set_permission_mode.

let _skipNextModeSync = false;

/** Monotonic sequence for the async `_enc_*` encrypt side-effect — lets a
 *  setter for a NEWER value of the SAME key invalidate an older key's in-flight
 *  encryption. */
const _apiKeyEncryptSeq: Record<string, number> = {
  interviewMimoApiKey: 0,
  videoAnalysisApiKey: 0,
};

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
