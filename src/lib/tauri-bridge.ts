import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// --- Types ---

export interface StartSessionParams {
  prompt: string;
  cwd: string;
  model?: string;
  /** Desk-generated process key (stdinId) — used as key in Rust StdinManager/ProcessManager.
   *  NOT the Claude CLI session UUID (that comes back as SessionInfo.session_id). */
  session_id?: string;
  allowed_tools?: string[];
  /** Resume an existing Claude CLI conversation by its UUID (for session continuity) */
  resume_session_id?: string;
  /** Thinking effort level: 'off' | 'low' | 'medium' | 'high' | 'max' */
  thinking_level?: string;
  /** Session mode: "ask", "plan", or undefined for auto */
  session_mode?: string;
  /** Active provider ID from providers.json */
  provider_id?: string;
  /** Declared model context window, e.g. 1000000 for compatible DeepSeek/CC Switch routes. */
  context_window?: number;
  /** Permission mode for CLI control protocol.
   *  "acceptEdits" | "default" | "plan" | "bypassPermissions"
   *  When not "bypassPermissions", enables structured permission requests via SDK protocol. */
  permission_mode?: string;
  /** Which CLI backend to use: "claude" (default) or "codex". */
  cli_backend?: string;
  /** When false, omit --include-partial-messages (A2: reduces event volume 10-50×). */
  include_partial_messages?: boolean;
}

export interface SessionInfo {
  /** The Claude CLI's own conversation UUID (used for --resume).
   *  This is different from the stdinId (desk-generated process key). */
  session_id: string;
  pid: number;
  cli_path: string;
}

export interface SessionListItem {
  id: string;
  path: string;
  project: string;
  projectDir: string;
  modifiedAt: number;
  preview: string;
  /** Which CLI backend created this session: "claude" (default) or "codex". */
  origin?: string;
}

export interface ContentSearchResult {
  session_id: string;
  project: string;
  project_dir: string;
  preview: string;
  modified_at: number;
  origin: string;
  user_match_count: number;
  assistant_match_count: number;
  user_snippets: string[];
  assistant_snippets: string[];
  user_match_indices: number[];
  assistant_match_indices: number[];
}

export interface ProfileDailyStats {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  total_tokens: number;
  message_count: number;
}

export interface ProfileModelStats {
  model: string;
  total_tokens: number;
  message_count: number;
}

export interface ProfileStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalTokens: number;
  sessionCount: number;
  messageCount: number;
  activeDays: number;
  peakDayTokens: number;
  daily: ProfileDailyStats[];
  models: ProfileModelStats[];
}

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[] | null;
}

export interface RecentProject {
  name: string;
  path: string;
  shortPath: string;
  lastUsed: number;
}

export interface FileChangeEvent {
  kind: 'created' | 'modified' | 'removed';
  paths: string[];
  path: string; // watch root（后端载荷字段为 path）
}

export interface SlashCommand {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project';
  has_args: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
  disable_model_invocation?: boolean;
  user_invocable?: boolean;
  allowed_tools?: string[];
  argument_hint?: string;
  model?: string;
  context?: string;
  agent?: string;
  version?: string;
}

export interface SkillTranslationItem {
  key: string;
  name: string;
  description: string;
}

export interface SkillTranslation {
  key: string;
  name: string;
  description: string;
}

export interface SkillTranslationConfig {
  baseUrl: string;
  apiFormat: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  proxyUrl?: string;
}

/** Result from system audio (WASAPI loopback) transcription. */
export interface SystemAudioResult {
  sessionId: string;
  chunkId: string;
  transcript: string;
  /** chunk 峰值 (0..1)，用于前端二次门控过滤底噪幻觉 */
  peak?: number;
}

/** Compressed wallpaper stored in ~/.tokenicode/wallpapers/ */
export interface WallpaperInfo {
  name: string;
  path: string;
  sizeBytes: number;
  durationSecs: number;
  compressed: boolean;
}

/** Progress event emitted during wallpaper compression */
export interface WallpaperProgress {
  stage: string;      // "probing" | "compressing" | "done" | "error"
  progress: number;    // 0-100
  message: string;
  encoder: string;     // "nvidia" | "intel" | "amd" | "cpu"
  inputSize: number;
  outputSize?: number;
}

export interface SkillRuntimeDownloadProgress {
  skill: string;
  phase: string;
  url: string;
  percent: number;
  message: string;
  downloaded?: number;
  total?: number;
}

/** Runtime package status for the bundled video-analysis skill. */
export interface SkillRuntimeStatus {
  skillName: string;
  skillInstalled: boolean;
  skillPath?: string | null;
  runtimeInstalled: boolean;
  dismissed: boolean;
  downloadUrl: string;
  missing: string[];
  message: string;
  /** China-first pip mirror URL. */
  pipMirror: string;
  /** Fallback pip mirror URL. */
  pipMirrorFallback: string;
  /** Ready-to-copy pip install command using China mirror. */
  pipInstallCmd: string;
  /** Multi-line manual install guide (ffmpeg + model + pip). */
  manualGuide: string;
  /** HuggingFace China mirror page for the ASR model. */
  modelMirror: string;
  /** High-level status: 'body-only' | 'need-download' | 'ready' | 'installing' | 'unknown'. */
  status: string;
  /** Per-dependency check results. */
  checks?: RuntimeDepCheck[];
  /** Whether one-click auto-install is supported on the current platform. */
  autoInstallSupported?: boolean;
  /** Whether an install is currently in-flight (singleton guard). */
  installing?: boolean;
  /** Detected compute device backend: "cuda", "amd-gpu", "apple-silicon", or "cpu". */
  deviceBackend?: string;
  /** Human-readable device label for UI display. */
  deviceBackendLabel?: string;
}

/** A single runtime dependency check result. */
export interface RuntimeDepCheck {
  name: string;
  label: string;
  ready: boolean;
  detail?: string | null;
}

export interface VideoAnalysisMultimodalConfig {
  baseUrl: string;
  /** Direct API key (optional if apiKeyEnv is set). */
  apiKey: string;
  /** Env var name holding the key, e.g. OPENAI_API_KEY (optional if apiKey is set). */
  apiKeyEnv: string;
  model: string;
  /** Enable local acceleration pipeline (VAD, scene-detect, pHash dedup, 2x2 grids). */
  accelerationEnabled: boolean;
  /** faster-whisper ASR model size. Default "small". */
  asrModelSize: string;
}

/** Runtime status for the speech recognition offline model. */
export interface SpeechRuntimeStatus {
  status: 'idle' | 'checking' | 'ready' | 'missing';
  checks: { label: string; ready: boolean; detail?: string }[];
  autoInstallSupported: boolean;
  deviceBackend?: string;
  deviceBackendLabel?: string;
}

export interface ClaudePluginSource {
  source?: string;
  url?: string;
  path?: string;
  ref?: string;
  sha?: string;
}

export interface ClaudePluginInfo {
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName?: string;
  version?: string;
  source?: ClaudePluginSource | string;
  installCount?: number;
  enabled?: boolean;
}

export interface ClaudePluginListResult {
  installed: ClaudePluginInfo[];
  available: ClaudePluginInfo[];
}

export interface CliStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  version_compatible: boolean;
  git_bash_missing: boolean;
}

export interface CliCandidate {
  path: string;
  source: 'official' | 'system' | 'appLocal' | 'versionManager' | 'dynamic';
  isNative: boolean;
  version: string | null;
  issues: string[];
}

export interface CleanupResult {
  removed: string[];
  skipped: { path: string; reason: string }[];
}

export interface AuthStatus {
  authenticated: boolean;
  unknown?: boolean;
}

export interface StepResult {
  ok: boolean;
  message: string;
}

export interface ConnectionTestResult {
  connectivity: StepResult;
  auth: StepResult;
  model: StepResult;
}

export interface SetupOutputEvent {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface SetupExitEvent {
  code: number;
}

export interface DownloadProgressEvent {
  downloaded: number;
  total: number;
  percent: number;
  phase: 'version' | 'downloading' | 'installing' | 'complete'
       | 'native_version' | 'native_manifest' | 'native_download' | 'native_verify' | 'native_install'
       | 'npm_fallback'
       | 'node_downloading' | 'node_extracting' | 'node_complete'
       | 'git_downloading' | 'git_extracting' | 'git_complete';
}

export interface NodeEnvStatus {
  node_available: boolean;
  node_version: string | null;
  node_source: string | null; // "system" | "local"
  npm_available: boolean;
}

export interface LocalModelInfo {
  name: string;
  id: string;
  size: string;
  modified: string;
}

export interface LocalModelServiceStatus {
  installed: boolean;
  version: string | null;
  models: LocalModelInfo[];
  error: string | null;
}

export interface LocalModelPullEvent {
  model: string;
  stream: 'stdout' | 'stderr' | 'status';
  line: string;
}

export interface ProvidersFile {
  version: number;
  activeProviderId: string | null;
  activeProviderPerBackend?: Record<string, string | null>;
  providers: {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: string;
    apiKey?: string;
    modelMappings: { tier: string; providerModel: string }[];
    extra_env?: Record<string, string>;
    proxyUrl?: string;
    preset?: string;
    cliBackend?: string;
    webSearchFallback?: {
      baseUrl: string;
      apiKey?: string;
      envVar?: string;
      model?: string;
      enabled?: boolean;
    } | null;
    createdAt: number;
    updatedAt: number;
  }[];
}

export interface UnifiedCommand {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project';
  category: 'builtin' | 'command' | 'skill';
  has_args: boolean;
  path?: string;
  immediate: boolean;
  execution?: 'ui' | 'cli' | 'session';
}

// --- Bridge ---

// ── 超时包装的 invoke ──────────────────────────────────────────
// 裸 invoke 在 Rust 命令挂死时前端 promise 永不 settle、UI 永久转圈。
// 仅对下载/安装/网络测试类高风险命令包一层超时（普通 IPC 命令毫秒级返回，
// 不需要也不应该加超时）。

/** 默认超时：60 秒 */
const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;
/** 安装/下载类命令超时：10 分钟（大模型/运行时下载在慢网络下耗时很长） */
export const INSTALL_INVOKE_TIMEOUT_MS = 10 * 60_000;
/** 测试/探测类命令超时：30 秒 */
export const TEST_INVOKE_TIMEOUT_MS = 30_000;

/** 给后端命令加超时的 invoke：超时后 reject 中文错误，避免 UI 永久转圈。
 *  @param cmd        后端命令名（同 invoke 的第一个参数）
 *  @param args       invoke 参数（可选）
 *  @param timeoutMs  超时毫秒数，默认 60 秒 */
export function invokeWithTimeout<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_INVOKE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`后端命令 ${cmd} 超时，请重试`));
    }, timeoutMs);
    invoke<T>(cmd, args).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── 可取消 invoke（CancellationToken）─────────────────────────────
// 后端注册中心：commands/download_cancel.rs。前端生成 scopeId → 传入命令 →
// 需要中断时调 cancelDownload(scopeId)，后端在等待循环/chunk 循环中轮询令牌，
// 提前返回“已取消”错误并清理临时文件。仅新增函数，不改动既有调用。

/**
 * 请求后端取消指定 scope 的下载/安装任务（幂等：未知 scopeId 返回 Ok）。
 * 取消后后端命令会以「已取消下载」错误 reject。
 */
export function cancelDownload(scopeId: string): Promise<void> {
  return invoke<void>('cancel_download', { scopeId });
}

/** 自带 scopeId 的 invoke + 超时：给安装/下载命令注入取消令牌。
 *  取消语义由后端轮询承担，本函数只负责传参与超时兜底。 */
export function invokeWithCancellation<T>(
  cmd: string,
  args: Record<string, unknown>,
  scopeId: string,
  timeoutMs: number = INSTALL_INVOKE_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`后端命令 ${cmd} 超时，请重试`));
    }, timeoutMs);
    invoke<T>(cmd, { ...args, scopeId }).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export const bridge = {
  previewOpenUrl: (url: string) =>
    invoke<string>('preview_open_url', { url }),

  previewRefresh: () =>
    invoke<void>('preview_refresh'),

  previewBack: () =>
    invoke<void>('preview_back'),

  previewForward: () =>
    invoke<void>('preview_forward'),

  startSession: (params: StartSessionParams) =>
    invoke<SessionInfo>('start_claude_session', { params }),

  sendMessage: (sessionId: string, message: string) =>
    invoke<void>('send_message', { sessionId, message }),

  sendStdin: (sessionId: string, message: string) =>
    invoke<void>('send_stdin', { sessionId, message }),

  sendRawStdin: (sessionId: string, message: string) =>
    invoke<void>('send_raw_stdin', { sessionId, message }),

  killSession: (sessionId: string) =>
    invoke<void>('kill_session', { sessionId }),

  /** TK-329: List all active stdinIds from backend ProcessManager.
   *  Used after refresh to detect orphaned processes. */
  listActiveProcesses: () =>
    invoke<string[]>('list_active_processes'),

  abortSession: (sessionId: string) =>
    invoke<void>('abort_session', { sessionId }),

  trackSession: (sessionId: string) =>
    invoke<void>('track_session', { sessionId }),

  deleteSession: (sessionId: string, sessionPath: string) =>
    invoke<void>('delete_session', { sessionId, sessionPath }),

  listSessions: () =>
    invoke<SessionListItem[]>('list_sessions'),

  getProfileStats: () =>
    invoke<ProfileStats>('get_profile_stats'),

  appendUsageRecord: (params: {
    session_id: string;
    message_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    model: string;
    timestamp: string;
  }) =>
    invoke<void>('append_usage_record', params),

  searchSessions: (query: string, roleFilter?: string | null) =>
    invoke<ContentSearchResult[]>('search_sessions', { query, roleFilter: roleFilter || null }),

  loadSession: (path: string) =>
    invoke<any[]>('load_session', { path }),

  openInVscode: (path: string) =>
    invoke<void>('open_in_vscode', { path }),

  revealInFinder: (path: string) =>
    invoke<void>('reveal_in_finder', { path }),

  openWithDefaultApp: (path: string) =>
    invoke<void>('open_with_default_app', { path }),

  shareFile: (path: string) =>
    invoke<void>('share_file', { path }),

  shareToWechat: (path: string) =>
    invoke<void>('share_to_wechat', { path }),

  readFileTree: (path: string, depth?: number) =>
    invoke<FileNode[]>('read_file_tree', { path, depth }),

  readFileContent: (path: string) =>
    invoke<string>('read_file_content', { path }),

  saveImportedPet: (petId: string, petJson: string, spritesheetB64: string) =>
    invoke<string>('save_imported_pet', { petId, petJson, spritesheetB64 }),

  readImportedPet: (petId: string, fileName: 'pet.json' | 'spritesheet.webp') =>
    invoke<string>('read_imported_pet', { petId, fileName }),

  listImportedPets: () =>
    invoke<string[]>('list_imported_pets'),

  writeFileContent: (path: string, content: string) =>
    invoke<void>('write_file_content', { path, content }),

  copyFile: (src: string, dest: string) =>
    invoke<void>('copy_file', { src, dest }),

  renameFile: (src: string, dest: string) =>
    invoke<void>('rename_file', { src, dest }),

  deleteFile: (path: string) =>
    invoke<void>('delete_file', { path }),

  createDirectory: (path: string) =>
    invoke<void>('create_directory', { path }),

  getHomeDir: () =>
    invoke<string>('get_home_dir'),

  exportSessionMarkdown: (path: string, outputPath: string, conversationOnly = false) =>
    invoke<void>('export_session_markdown', { path, outputPath, conversationOnly }),

  exportSessionJson: (path: string, outputPath: string) =>
    invoke<void>('export_session_json', { path, outputPath }),

  listRecentProjects: () =>
    invoke<RecentProject[]>('list_recent_projects'),

  watchDirectory: (path: string) =>
    invoke<void>('watch_directory', { path }),

  unwatchDirectory: (path: string) =>
    invoke<void>('unwatch_directory', { path }),

  saveTempFile: (name: string, data: number[], cwd?: string) =>
    invoke<string>('save_temp_file', { name, data, cwd: cwd || null }),

  getFileSize: (path: string) =>
    invoke<number>('get_file_size', { path }),

  readFileBase64: (path: string) =>
    invoke<string>('read_file_base64', { path }),

  /** Check if app has file system access to a directory (macOS TCC detection) */
  checkFileAccess: (path: string) =>
    invoke<boolean>('check_file_access', { path }),

  // Slash commands
  listSlashCommands: (cwd?: string) =>
    invoke<SlashCommand[]>('list_slash_commands', { cwd }),

  // Skills
  listSkills: (cwd?: string) =>
    invoke<SkillInfo[]>('list_skills', { cwd }),

  readSkill: (path: string, cwd?: string | null) =>
    invoke<string>('read_skill', { path, cwd: cwd || null }),

  writeSkill: (path: string, content: string, cwd?: string | null) =>
    invoke<void>('write_skill', { path, content, cwd: cwd || null }),

  deleteSkill: (path: string, cwd?: string | null) =>
    invoke<void>('delete_skill', { path, cwd: cwd || null }),

  toggleSkillEnabled: (path: string, enabled: boolean, cwd?: string | null) =>
    invoke<void>('toggle_skill_enabled', { path, enabled, cwd: cwd || null }),

  /** Bundled video-analysis skill runtime status (body vs heavy deps). */
  getVideoAnalysisRuntimeStatus: () =>
    invoke<SkillRuntimeStatus>('get_video_analysis_runtime_status'),

  /** User chose "later" for runtime download prompt. */
  dismissVideoAnalysisRuntimePrompt: () =>
    invoke<void>('dismiss_video_analysis_runtime_prompt'),

  /**
   * Download/install video-analysis runtime via China-first mirrors:
   * ffmpeg zip → faster-whisper model (hf-mirror) → pip (清华/阿里云).
   * Emits skill-runtime:download:progress for the panel progress bar.
   */
  downloadVideoAnalysisRuntime: () =>
    invoke<SkillRuntimeStatus>('download_video_analysis_runtime'),

  /** Open skill directory so the user can install runtime manually. */
  openVideoAnalysisSkillDir: () =>
    invoke<string>('open_video_analysis_skill_dir'),

  /** Default multimodal model for video-analysis skill (Mode B). */
  getVideoAnalysisMultimodalConfig: () =>
    invoke<VideoAnalysisMultimodalConfig>('get_video_analysis_multimodal_config'),

  /** Persist multimodal defaults; injected into CLI env on next session start. */
  saveVideoAnalysisMultimodalConfig: (config: VideoAnalysisMultimodalConfig) =>
    invoke<VideoAnalysisMultimodalConfig>('save_video_analysis_multimodal_config', {
      config,
    }),

  /** Toggle acceleration only — does not touch API key/model fields. */
  setVideoAnalysisAcceleration: (enabled: boolean) =>
    invoke<VideoAnalysisMultimodalConfig>('set_video_analysis_acceleration', {
      enabled,
    }),

  /** Set ASR model size — does not touch API key/model fields. */
  setVideoAnalysisAsrModel: (modelSize: string) =>
    invoke<VideoAnalysisMultimodalConfig>('set_video_analysis_asr_model', {
      modelSize,
    }),

  /** Get speech recognition runtime status (whisper model availability, etc.). */
  getSpeechRuntimeStatus: () =>
    invoke<SpeechRuntimeStatus>('get_speech_runtime_status'),

  /** Download/install offline speech recognition model. */
  downloadSpeechRuntime: () =>
    invokeWithTimeout<SpeechRuntimeStatus>('download_speech_runtime', undefined, INSTALL_INVOKE_TIMEOUT_MS),

  /** Open skill directory for manual speech model install. */
  openSpeechSkillDir: () =>
    invoke<string>('open_speech_skill_dir'),

  translateSkillMetadata: (
    items: SkillTranslationItem[],
    providerId?: string | null,
    config?: SkillTranslationConfig | null,
  ) =>
    invoke<SkillTranslation[]>('translate_skill_metadata', {
      items,
      providerId: providerId || null,
      config: config || null,
    }),

  translateSkillMarkdown: (content: string, config: SkillTranslationConfig) =>
    invoke<string>('translate_skill_markdown', { content, config }),

  // --- Interview module (mimo multimodal direct) ---

  /** Start system audio capture without ASR engine (raw passthrough, for mimo mode). */
  startSystemAudioRaw: () =>
    invoke<void>('interview_start_system_audio_raw'),

  /** Stop system audio raw capture. */
  stopSystemAudioRaw: () =>
    invoke<void>('interview_stop_system_audio_raw'),

  /** Mimo two-stage direct answer: the backend first sends the accumulated WAV
   * to `asrModel` (mimo-v2.5-asr, audio-only — the gateway forbids text parts)
   * for transcription, then asks `model` (text model) to answer the transcribed
   * question via streaming SSE. The transcribed question text arrives through
   * the `interview:mimo-question` event; answer tokens via `interview:mimo-token`.
   * Returns the model's final answer text. */
  interviewMimoAnswer: (baseUrl: string, apiKey: string, apiKeyEnv: string | undefined, model: string, asrModel: string, audioBase64: string, promptText?: string, proxyUrl?: string, isSingleHop?: boolean, answerPrompt?: string, maxTokens?: number, temperature?: number, questionText?: string) =>
    invoke<string>('interview_mimo_answer', { baseUrl, apiKey, apiKeyEnv: apiKeyEnv || null, model, asrModel, audioBase64, promptText: promptText || null, proxyUrl: proxyUrl || null, isSingleHop: isSingleHop ?? null, answerPrompt: answerPrompt || null, maxTokens: maxTokens ?? null, temperature: temperature ?? null, questionText: questionText || null }),

  /** Prewarm the TCP/TLS connection to the mimo endpoint with a zero-billing
   *  GET, so the first question of a session reuses a hot connection instead
   *  of paying the cold TLS handshake. Always resolves; failures are silent. */
  prewarmMimoConnection: (baseUrl: string, proxyUrl?: string) =>
    invoke<void>('interview_prewarm_connection', { baseUrl, proxyUrl: proxyUrl || null }),

  /** Test interview endpoint connectivity — verifies the answer model (and ASR
   *  model in two-hop mode) can accept requests. Returns a JSON object with
   *  per-model ok/latencyMs/error fields. Does NOT consume meaningful tokens. */
  interviewTestMimo: (baseUrl: string, apiKey: string, apiKeyEnv: string | undefined, model: string, asrModel: string, isSingleHop: boolean, proxyUrl?: string) =>
    invoke<Record<string, { ok: boolean; model: string; latencyMs: number; status?: number; error?: string }>>('interview_test_mimo', { baseUrl, apiKey, apiKeyEnv: apiKeyEnv || null, model, asrModel, isSingleHop, proxyUrl: proxyUrl || null }),

  // ── Local ASR (sherpa-onnx) — model management ──
  checkLocalAsrRuntime: () => invoke<{ available: boolean; engine: string; version: string }>('check_local_asr_runtime'),
  checkLocalAsrModel: () => invoke<{ installed: boolean; model_dir: string; files: string[] }>('check_local_asr_model'),
  downloadLocalAsrModel: (mirrorIndex?: number) => invokeWithTimeout<string>('download_local_asr_model', { mirrorIndex: mirrorIndex ?? null }, INSTALL_INVOKE_TIMEOUT_MS),
  deleteLocalAsrModel: () => invoke<string>('delete_local_asr_model'),
  testLocalAsr: (modelDir?: string) => invoke<string>('test_local_asr', { modelDir: modelDir ?? null }),
  // ── Local ASR (sherpa-onnx) — streaming session ──
  startLocalAsrSession: () => invoke<string>('start_local_asr_session'),
  pushLocalAsrAudio: (wavBase64: string) => invoke('push_local_asr_audio', { wavBase64 }),
  stopLocalAsrSession: () => invoke<string>('stop_local_asr_session'),
  /** 转录并重置：取走当前缓冲区做推理，放回空缓冲，不销毁引擎（避免重载 239MB 模型） */
  transcribeAndResetLocalAsr: () => invoke<string>('transcribe_and_reset_local_asr'),

  // Unified commands (commands + skills)
  listAllCommands: (cwd?: string, cliBackend?: string) =>
    invoke<UnifiedCommand[]>('list_all_commands', { cwd, cliBackend }),

  // Git commands (safe, allowlisted operations only)
  runGitCommand: (cwd: string, args: string[]) =>
    invoke<string>('run_git_command', { cwd, args }),

  // Rewind files via SDK control protocol (fast, in-process) with CLI spawn fallback
  rewindFiles: (stdinId: string, userMessageId: string, sessionId: string, cwd: string) =>
    invoke<void>('send_control_request', {
      sessionId: stdinId,
      subtype: 'rewind_files',
      payload: { user_message_id: userMessageId },
    }).catch(() =>
      // Fallback: spawn new CLI process if stdin pipe not available
      invoke<string>('rewind_files', { sessionId, checkpointUuid: userMessageId, cwd }),
    ),

  // Truncate the CLI session JSONL to just before the given user turn (1-based),
  // so `--resume` after a rewind rebuilds only the pre-rewind history.
  // Returns null when the whole history was cleared (file deleted).
  truncateSessionHistory: (sessionId: string, projectDir: string, truncateBeforeTurn: number) =>
    invoke<number | null>('truncate_session_history', {
      sessionId,
      projectDir,
      truncateBeforeTurn,
    }),

  // Set macOS dock icon from base64-encoded PNG
  setDockIcon: (pngBase64: string) =>
    invoke<void>('set_dock_icon', { pngBase64 }),

  // Run a Claude CLI subcommand as a one-shot process (e.g. `claude doctor`)
  runClaudeCommand: (subcommand: string, cwd?: string) =>
    invoke<string>('run_claude_command', { subcommand, cwd }),

  runClaudePluginCommand: (args: string[], cwd?: string) =>
    invoke<string>('run_claude_plugin_command', { args, cwd }),

  listClaudePlugins: async (includeAvailable = true, cwd?: string) => {
    const args = includeAvailable
      ? ['list', '--json', '--available']
      : ['list', '--json'];
    const output = await invoke<string>('run_claude_plugin_command', { args, cwd });
    return JSON.parse(output || '{"installed":[],"available":[]}') as ClaudePluginListResult;
  },

  installClaudePlugin: (pluginId: string, scope: 'user' | 'project' | 'local' = 'user', cwd?: string) =>
    invoke<string>('run_claude_plugin_command', {
      args: ['install', pluginId, '--scope', scope],
      cwd,
    }),

  enableClaudePlugin: (pluginId: string, cwd?: string) =>
    invoke<string>('run_claude_plugin_command', { args: ['enable', pluginId], cwd }),

  disableClaudePlugin: (pluginId: string, cwd?: string) =>
    invoke<string>('run_claude_plugin_command', { args: ['disable', pluginId], cwd }),

  updateClaudePlugin: (pluginId: string, cwd?: string) =>
    invoke<string>('run_claude_plugin_command', { args: ['update', pluginId], cwd }),

  uninstallClaudePlugin: (pluginId: string, cwd?: string) =>
    invoke<string>('run_claude_plugin_command', { args: ['uninstall', pluginId], cwd }),

  // Setup: CLI detection, installation & login
  checkClaudeCli: () =>
    invoke<CliStatus>('check_claude_cli'),

  checkCodexCli: () =>
    invoke<CliStatus>('check_codex_cli'),

  /** Scan all CLI installations with version/issues for diagnostic UI */
  diagnoseCli: () =>
    invoke<CliCandidate[]>('diagnose_cli'),

  /** Remove selected CLI installations (only auto-deletes app-local tier) */
  cleanupOldCli: (targets: string[]) =>
    invoke<CleanupResult>('cleanup_old_cli', { targets }),

  pinCli: (path: string) => invoke<void>('pin_cli', { path }),
  unpinCli: () => invoke<void>('unpin_cli'),
  getPinnedCli: () => invoke<string | null>('get_pinned_cli'),
  injectCliPath: (path: string) => invoke<string>('inject_cli_path', { path }),
  deleteCli: (path: string) => invoke<string>('delete_cli', { path }),

  installClaudeCli: () =>
    invokeWithTimeout<void>('install_claude_cli', undefined, INSTALL_INVOKE_TIMEOUT_MS),

  /** Update CLI to latest version via npm (bypasses "already installed" skip) */
  updateClaudeCli: () =>
    invokeWithTimeout<string>('update_claude_cli', undefined, INSTALL_INVOKE_TIMEOUT_MS),

  /** Check if a newer CLI version is available */
  checkCliUpdate: () =>
    invoke<{ current: string | null; latest: string | null; update_available: boolean }>('check_cli_update'),

  installCodexCli: () =>
    invokeWithTimeout<void>('install_codex_cli', undefined, INSTALL_INVOKE_TIMEOUT_MS),

  /** Update Codex CLI to latest version via npm */
  updateCodexCli: () =>
    invokeWithTimeout<string>('update_codex_cli', undefined, INSTALL_INVOKE_TIMEOUT_MS),

  /** Check if a newer Codex CLI version is available */
  checkCodexUpdate: () =>
    invoke<{ current: string | null; latest: string | null; update_available: boolean }>('check_codex_update'),

  /** Export Codex session to Claude-compatible JSONL session file.
   *  Takes pre-built JSONL content and cwd, returns the new Claude session UUID. */
  exportCodexToClaude: (jsonlContent: string, cwd: string) =>
    invoke<string>('export_codex_to_claude', { jsonlContent, cwd }),

  /** Export Claude session as text context for Codex thread.
   *  Returns raw JSONL content; frontend formats via formatJsonlAsText(). */
  exportClaudeToCodex: (sessionId: string, projectDir: string) =>
    invoke<string>('export_claude_to_codex', { sessionId, projectDir }),

  checkNodeEnv: () =>
    invokeWithTimeout<NodeEnvStatus>('check_node_env', undefined, TEST_INVOKE_TIMEOUT_MS),

  installNodeEnv: () =>
    invokeWithTimeout<void>('install_node_env', undefined, INSTALL_INVOKE_TIMEOUT_MS),

  checkLocalModelService: () =>
    invoke<LocalModelServiceStatus>('check_local_model_service'),

  listLocalModels: () =>
    invoke<LocalModelInfo[]>('list_local_models'),

  pullLocalModel: (model: string) =>
    invoke<void>('pull_local_model', { model }),

  startClaudeLogin: () =>
    invoke<void>('start_claude_login'),

  checkClaudeAuth: () =>
    invoke<AuthStatus>('check_claude_auth'),

  openTerminalLogin: () =>
    invoke<void>('open_terminal_login'),

  // Session custom names — localStorage only (portable EXE, no disk writes)
  // Kept as documentation; the actual data lives in sessionStore localStorage cache.

  // AI title generation (spawns separate CLI process, no channel interference)
  generateSessionTitle: (userMessage: string, assistantMessage: string, providerId?: string) =>
    invoke<string>('generate_session_title', { userMessage, assistantMessage, providerId: providerId || null }),

  // --- Provider Management ---

  /** One-time disk migration: read legacy providers.json. Returns default if not found. */
  loadProviders: () =>
    invoke<ProvidersFile>('load_providers'),

  /** Push current provider config to Rust backend in-memory cache.
   *  Replaces the old save_providers disk write — data lives in localStorage
   *  and is synced to Rust on each mutation so resolve_provider_env() works. */
  syncProviders: (data: ProvidersFile) =>
    invoke<void>('sync_providers', { data }),

  testProviderConnection: (baseUrl: string, apiFormat: string, apiKey: string, model: string, proxyUrl?: string) =>
    invokeWithTimeout<ConnectionTestResult>('test_provider_connection', { baseUrl, apiFormat, apiKey, model, proxyUrl: proxyUrl || null }, TEST_INVOKE_TIMEOUT_MS),

  /** Fetch model IDs available at the provider endpoint. Tries the format-native
   *  /models endpoint, then the OpenAI-compatible twin path for /anthropic gateways. */
  listProviderModels: (baseUrl: string, apiFormat: string, apiKey: string, proxyUrl?: string) =>
    invoke<string[]>('list_provider_models', { baseUrl, apiFormat, apiKey, proxyUrl: proxyUrl || null }),

  // --- S3: localStorage API key encryption ---
  encryptValue: (value: string) =>
    invoke<string>('encrypt_value', { value }),
  decryptValue: (encrypted: string) =>
    invoke<string>('decrypt_value', { encrypted }),


  // --- SDK Control Protocol ---

  /** Respond to a structured permission request from CLI */
  respondPermission: (sessionId: string, requestId: string, allow: boolean, message?: string, toolUseId?: string, updatedInput?: Record<string, unknown>) =>
    invoke<void>('respond_permission', { sessionId, requestId, allow, message: message ?? null, toolUseId: toolUseId ?? null, updatedInput: updatedInput ?? null }),

  /** Send a runtime control command to change permission mode without restart */
  setPermissionMode: (sessionId: string, mode: string) =>
    invoke<void>('send_control_request', { sessionId, subtype: 'set_permission_mode', payload: { mode } }),

  /** Send a runtime control command to change model without restart */
  setModel: (sessionId: string, model: string | null) =>
    invoke<void>('send_control_request', { sessionId, subtype: 'set_model', payload: { model } }),

  /** Send a runtime interrupt command */
  interruptSession: (sessionId: string) =>
    invoke<void>('send_control_request', { sessionId, subtype: 'interrupt', payload: {} }),

  // ── Dynamic Wallpaper ─────────────────────────────

  listWallpapers: () =>
    invoke<WallpaperInfo[]>('list_wallpapers'),

  deleteWallpaper: (name: string) =>
    invoke<void>('delete_wallpaper', { name }),

  getWallpaperPath: (name: string) =>
    invoke<string>('get_wallpaper_path', { name }),

  compressWallpaper: (inputPath: string, quality: string) =>
    invoke<WallpaperInfo>('compress_wallpaper', { inputPath, quality }),

  /** Start (or return existing) local HTTP server for wallpaper video streaming. */
  startWallpaperServer: () =>
    invoke<number>('start_wallpaper_server'),

  // ── Prerequisites ─────────────────────────────

  checkPrerequisites: () =>
    invoke<PrerequisiteItem[]>('check_prerequisites'),

  installPrerequisite: (key: string) =>
    invoke<void>('install_prerequisite', { key }),

  // ── Web hot update ─────────────────────────────

  /** 下载并原子切换前端资源包（免重装升级）。返回当前生效资源版本。 */
  downloadWebUpdate: (url: string, sha256: string, version: string) =>
    invoke<string>('download_web_update', { url, sha256, version }),

  /** 当前生效的前端资源版本（current.json 指针；None = 未热更过）。 */
  getWebResourceVersion: () =>
    invoke<string | null>('get_web_resource_version'),

  // ── localStorage 磁盘持久化 + origin 迁移 ─────────────────────────────

  /** 读取 localStorage 磁盘快照（JSON 对象字符串）。启动时灌回 localStorage。 */
  loadLsSnapshot: () => invoke<string>('load_ls_snapshot'),

  /** 写入单个 key 到磁盘快照（镜像 localStorage.setItem）。 */
  saveLsEntry: (key: string, value: string) =>
    invoke<void>('save_ls_entry', { key, value }),

  /** 从磁盘快照删除单个 key（镜像 localStorage.removeItem）。 */
  removeLsEntry: (key: string) => invoke<void>('remove_ls_entry', { key }),

  /** 一次性迁移旧 origin 的 localStorage 到磁盘。dev 直接返回 0。 */
  ensureMigrated: () => invoke<number>('ensure_migrated'),
};

// --- SDK Control Protocol Types ---

// ── Prerequisites ─────────────────────────────────────────────

export interface PrerequisiteItem {
  key: string;
  name: string;
  description: string;
  status: string;       // "ok" | "missing" | "checking"
  version: string | null;
  installable: boolean;
  required: boolean;
}

export interface PrereqInstallProgress {
  key: string;
  phase: string;        // "start" | "complete" | "error"
  message: string;
}

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  description?: string;
  tool_use_id?: string;
}

// --- Event Listeners ---

/** Listen for structured permission requests from the SDK control protocol.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onPermissionRequest(
  stdinId: string,
  callback: (req: PermissionRequest) => void,
): Promise<UnlistenFn> {
  const channel = `claude:permission_request:${stdinId}`;
  return listen<PermissionRequest>(
    channel,
    (event) => callback(event.payload),
  );
}

/** Listen for NDJSON stream events from a Claude CLI process.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onClaudeStream(
  stdinId: string,
  callback: (message: any) => void,
): Promise<UnlistenFn> {
  return listen<any>(
    `claude:stream:${stdinId}`,
    (event) => callback(event.payload),
  );
}

/** Listen for stderr output from a Claude CLI process.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onClaudeStderr(
  stdinId: string,
  callback: (line: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(
    `claude:stderr:${stdinId}`,
    (event) => callback(event.payload),
  );
}

/** Listen for process exit events.
 *  @param stdinId - Desk-generated process key (NOT the CLI session UUID) */
export function onSessionExit(
  stdinId: string,
  callback: (code: number | null) => void,
): Promise<UnlistenFn> {
  // 后端载荷为 { code: number | null }（旧格式 null / codex 的 {} 兼容为 null）
  return listen<{ code: number | null } | null>(
    `claude:exit:${stdinId}`,
    (event) => callback(event.payload?.code ?? null),
  );
}

export function onSetupInstallOutput(
  callback: (event: SetupOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupOutputEvent>(
    'setup:install:output',
    (event) => callback(event.payload),
  );
}

export function onSetupInstallExit(
  callback: (event: SetupExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupExitEvent>(
    'setup:install:exit',
    (event) => callback(event.payload),
  );
}

export function onSetupLoginOutput(
  callback: (event: SetupOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupOutputEvent>(
    'setup:login:output',
    (event) => callback(event.payload),
  );
}

export function onSetupLoginExit(
  callback: (event: SetupExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupExitEvent>(
    'setup:login:exit',
    (event) => callback(event.payload),
  );
}

export function onSkillRuntimeDownloadProgress(
  callback: (event: SkillRuntimeDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<SkillRuntimeDownloadProgress>(
    'skill-runtime:download:progress',
    (event) => callback(event.payload),
  );
}

// 防御性进度监听：SetupWizard / CliTab 的 onDownloadProgress 只在安装完成后
// unlisten，组件中途卸载会泄漏原生 listener（每次安装叠加一个，无限累积）。
// 统一入口做防御：每个 channel 只注册一个原生 listener，回调多播；返回的
// unlisten 只摘除本回调。原生监听数量恒为 1，泄漏的至多是空闭包。
const singletonListenerCallbacks = new Map<string, Set<(payload: unknown) => void>>();

function subscribeSingletonListener<T>(
  channel: string,
  callback: (payload: T) => void,
): UnlistenFn {
  let callbacks = singletonListenerCallbacks.get(channel);
  if (!callbacks) {
    callbacks = new Set();
    singletonListenerCallbacks.set(channel, callbacks);
    listen<T>(channel, (event) => {
      const set = singletonListenerCallbacks.get(channel);
      if (set) {
        for (const cb of [...set]) cb(event.payload);
      }
    }).catch(() => {
      // 原生监听注册失败：静默（后端未就绪时退化为无事件，不抛未处理 rejection）
    });
  }
  const cb = callback as (payload: unknown) => void;
  callbacks.add(cb);
  return () => {
    callbacks.delete(cb);
  };
}

export function onDownloadProgress(
  callback: (event: DownloadProgressEvent) => void,
): Promise<UnlistenFn> {
  return Promise.resolve(
    subscribeSingletonListener<DownloadProgressEvent>('setup:download:progress', callback),
  );
}

export function onLocalModelPullProgress(
  callback: (event: LocalModelPullEvent) => void,
): Promise<UnlistenFn> {
  return listen<LocalModelPullEvent>(
    'local-model:pull-progress',
    (event) => callback(event.payload),
  );
}

export function onFileChange(
  callback: (event: FileChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<FileChangeEvent>(
    'fs:change',
    (event) => callback(event.payload),
  );
}

// ── Web resource hot update (免重装升级) ────────────────────────

/** 热更进度事件（download/verify/extract/switching/done/error）。 */
export interface UpdateProgressEvent {
  phase: 'download' | 'verify' | 'extract' | 'switching' | 'done' | 'error';
  downloaded: number;
  total: number | null;
  message?: string | null;
}

/** 下载并应用前端资源热更新包（Rust 侧流式下载+校验+原子切换）。 */
export function downloadWebUpdate(url: string, sha256: string, version: string): Promise<string> {
  return bridge.downloadWebUpdate(url, sha256, version);
}

/** 查询当前生效的磁盘资源版本（无热更 → null，前端回退 APP_VERSION）。 */
export function getWebResourceVersion(): Promise<string | null> {
  return bridge.getWebResourceVersion();
}

/** 热更进度（防御性多播：原生监听恒为 1）。 */
export function onUpdateProgress(
  callback: (event: UpdateProgressEvent) => void,
): Promise<UnlistenFn> {
  return Promise.resolve(
    subscribeSingletonListener<UpdateProgressEvent>('update:progress', callback),
  );
}

// ── Dynamic Wallpaper ──────────────────────────────────────────

export function onWallpaperProgress(
  callback: (event: WallpaperProgress) => void,
): Promise<UnlistenFn> {
  return listen<WallpaperProgress>(
    'wallpaper:progress',
    (event) => callback(event.payload),
  );
}

export function onPrereqInstallProgress(
  callback: (event: PrereqInstallProgress) => void,
): Promise<UnlistenFn> {
  return listen<PrereqInstallProgress>(
    'prereq:install:progress',
    (event) => callback(event.payload),
  );
}

// ── System Audio ────────────────────────────────────────────────

/** Fired every second from the WASAPI capture loop with status info. */
export function onSystemAudioStatus(
  callback: (data: {
    sessionId: string;
    elapsedSecs: number;
    totalFramesRead: number;
    bufferBytes: number;
    chunksProduced: number;
    peakMax?: number;
    silentChunks?: number;
  }) => void,
): Promise<UnlistenFn> {
  return listen<{
    sessionId: string;
    elapsedSecs: number;
    totalFramesRead: number;
    bufferBytes: number;
    chunksProduced: number;
    peakMax?: number;
    silentChunks?: number;
  }>(
    'interview:system-audio-status',
    (event) => callback(event.payload),
  );
}

/** Fired when the WASAPI capture thread is started. */
export function onSystemAudioStarted(
  callback: (data: { sessionId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string }>(
    'interview:system-audio-started',
    (event) => callback(event.payload),
  );
}

/** Fired when a raw PCM chunk is captured (before transcription). */
export function onSystemAudioChunk(
  callback: (data: { sessionId: string; chunkId: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; chunkId: string }>(
    'interview:system-audio-chunk',
    (event) => callback(event.payload),
  );
}

export function onSystemAudioResult(
  callback: (result: SystemAudioResult) => void,
): Promise<UnlistenFn> {
  return listen<SystemAudioResult>(
    'interview:system-audio-result',
    (event) => callback(event.payload),
  );
}

export function onSystemAudioError(
  callback: (error: { sessionId: string; chunkId: string; error: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; chunkId: string; error: string }>(
    'interview:system-audio-error',
    (event) => callback(event.payload),
  );
}

/** Fired for each streaming token during mimo multimodal answer generation
 *  (SSE stream parsing on the Rust side).  Frontend accumulates deltas
 *  for real-time progressive rendering — first-token latency wins over
 *  full-response latency. */
export function onMimoToken(
  callback: (payload: { requestId: string; delta: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ requestId: string; delta: string }>(
    'interview:mimo-token',
    (event) => callback(event.payload),
  );
}

/** Subscribe to the transcribed interview question text. In the two-stage
 *  pipeline the ASR hop emits this once per question, right before the
 *  answer stream starts — use it to replace the "voice question" placeholder
 *  with what was actually asked. */
export function onMimoQuestion(
  callback: (payload: { requestId: string; text: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ requestId: string; text: string }>(
    'interview:mimo-question',
    (event) => callback(event.payload),
  );
}

/** Local ASR model download progress */
export function onLocalAsrDownloadProgress(
  callback: (payload: { file: string; current: number; total: number; status: string; size?: number }) => void,
): Promise<UnlistenFn> {
  return listen('local-asr:download-progress', (event) => callback(event.payload as any));
}

/** Local ASR transcript event (streaming from sherpa-onnx engine) */
export function onLocalAsrTranscript(
  callback: (payload: { text: string; startTime: number; isFinal: boolean }) => void,
): Promise<UnlistenFn> {
  return listen<{ text: string; startTime: number; isFinal: boolean }>(
    'local-asr:transcript',
    (event) => callback(event.payload),
  );
}
