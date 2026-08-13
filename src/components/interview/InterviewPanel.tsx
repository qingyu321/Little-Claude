import { useCallback, useEffect, useRef, useState } from 'react';
import { useInterviewStore, InterviewPhase } from '../../stores/interviewStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAudioCapture } from '../../hooks/useAudioCapture';
import { bridge, onMimoToken, onMimoQuestion, onSystemAudioChunk, onSystemAudioResult, onSystemAudioError, onSystemAudioStatus, onLocalAsrTranscript } from '../../lib/tauri-bridge';
import { useT } from '../../lib/i18n';
import { debugLog, debugWarn, debugError } from '../../lib/debug-log';
import { HybridCompareCard } from './HybridCompareCard';

// ── 多模态直连参数 ──
const SILENCE_DURATION_MS = 1500;
// 单题音频累积上限（800ms chunk × 75 ≈ 60s）。两道防线：
// 1) 系统音频模式下底噪（0.001~0.01）判为语音 → 静音判句永不触发 →
//    音频无限累积。超限强制判句，防止内存/请求体积失控；
// 2) 超长连续语音（无 1.5s 停顿）也靠它强制分段，避免一次发送整段长音频。
const MAX_QA_AUDIO_CHUNKS = 75;
// 系统音频采集失败后自动重启的退避间隔与最大重试次数（防无限重启循环）。
const SYS_AUDIO_RESTART_MS = 5000;
const SYS_AUDIO_MAX_RESTARTS = 3;
// 麦克风静音判定阈值：近场信号强（正常语音 peak 0.05+），0.01 同时压掉
// 环境底噪（风扇/白噪声常在 0.001~0.01）——低于它判静音帧，防止底噪
// 持续重置静音计时器导致音频无限累积。
const AUDIO_MIN_PEAK = 0.01;
// 系统音频静音判定阈值：WASAPI loopback 回采的扬声器输出（微信电话/
// 腾讯会议）是远场弱信号，峰值常落在 0.001~0.01。沿用麦克风标准会把
// 系统语音全判成静音帧 → mimoQuestionStartedRef 永不置位 → local 后端
// 静音门控永不 finalize → 识别不出。与 Rust 侧 system_audio.rs 的静音线
// （peak < 0.001 计 silent_chunks）对齐。
const SYS_AUDIO_MIN_PEAK = 0.001;

/** 阶段 → 状态点颜色与文案 */
const PHASE_META: Record<InterviewPhase, { dot: string; glow?: string; pulse?: boolean }> = {
  idle:      { dot: 'bg-text-tertiary' },
  standby:   { dot: 'bg-text-tertiary' },
  listening: { dot: 'bg-red-500', glow: 'shadow-[0_0_8px_rgba(239,68,68,0.5)]', pulse: true },
  searching: { dot: 'bg-warning', glow: 'shadow-[0_0_8px_var(--color-warning)]', pulse: true },
  answering: { dot: 'bg-accent', glow: 'shadow-[0_0_8px_var(--color-accent-glow)]', pulse: true },
  answered:  { dot: 'bg-success', glow: 'shadow-[0_0_8px_var(--color-success)]' },
};

// ── WAV 纯 JS 工具 ──

/** 从 base64 WAV 数据中计算峰值 (0.0–1.0) */
function computeWavPeakFromBase64(base64: string): number {
  try {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (bytes.length < 44) return 0;
    let offset = 12, bitsPerSample = 16, dataStart = 0, dataSize = 0;
    while (offset + 8 <= bytes.length) {
      const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
      const chunkSize = new DataView(bytes.buffer, offset + 4, 4).getUint32(0, true);
      if (chunkId === 'fmt ' && chunkSize >= 16 && offset + 22 <= bytes.length) {
        bitsPerSample = new DataView(bytes.buffer, offset + 8 + 14, 2).getUint16(0, true);
      } else if (chunkId === 'data') {
        dataStart = offset + 8;
        dataSize = Math.min(chunkSize, bytes.length - dataStart);
        break;
      }
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset += 1;
    }
    if (dataStart === 0 || dataSize === 0) return 0;
    if (bitsPerSample === 16) {
      let maxAbs = 0;
      const view = new DataView(bytes.buffer, dataStart, dataSize);
      for (let i = 0; i + 1 < dataSize; i += 2) {
        const sample = view.getInt16(i, true);
        const abs = Math.abs(sample);
        if (abs > maxAbs) maxAbs = abs;
      }
      return maxAbs / 32768;
    }
    return 0;
  } catch { return 0; }
}

/** 裁剪单声道 16bit PCM 首尾静音样本，返回 [start, end) 字节偏移。
 *  阈值对应 peak≈0.001（与 SYS_AUDIO_MIN_PEAK 一致——系统语音是弱信号，
 *  0.01 会把整段裁光）；首尾各留 0.1s 余量，避免切掉起收的辅音。
 *  全静音时原样返回。 */
function trimSilencePcm(pcm: Uint8Array, sampleRate: number): { start: number; end: number } {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const total = Math.floor(pcm.length / 2);
  const THRESHOLD = 33; // 32768 * 0.001
  let first = 0;
  let last = total - 1;
  while (first < total && Math.abs(view.getInt16(first * 2, true)) < THRESHOLD) first++;
  while (last > first && Math.abs(view.getInt16(last * 2, true)) < THRESHOLD) last--;
  if (first >= last) return { start: 0, end: pcm.length };
  const pad = Math.floor(sampleRate * 0.1);
  return {
    start: Math.max(0, first - pad) * 2,
    end: Math.min(total - 1, last + pad) * 2 + 2,
  };
}

/** 线性插值重采样单声道 16bit PCM（与 Rust 侧 resample_linear 同算法）。
 *  发送前统一降到 8kHz：端点实测接受 8k WAV，转写准确度与 16k 一致，体积减半。 */
function resamplePcm16(pcm: Uint8Array, srcRate: number, dstRate: number): Uint8Array {
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const srcLen = Math.floor(pcm.length / 2);
  const dstLen = Math.ceil(srcLen * dstRate / srcRate);
  const out = new Uint8Array(dstLen * 2);
  const dst = new DataView(out.buffer);
  const ratio = srcRate / dstRate;
  const last = srcLen - 1;
  for (let i = 0; i < dstLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, last);
    const frac = pos - i0;
    const v = src.getInt16(i0 * 2, true) * (1 - frac) + src.getInt16(i1 * 2, true) * frac;
    dst.setInt16(i * 2, Math.round(v), true);
  }
  return out;
}

/** 将多个 WAV base64 chunks 拼接为完整 WAV base64（裁首尾静音 + 降采样到 8kHz 后输出） */
function concatWavChunks(chunks: string[]): string {
  const pcmParts: Uint8Array[] = [];
  let sampleRate = 16000, numChannels = 1, bitsPerSample = 16;
  for (const b64 of chunks) {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (bytes.length < 44) continue;
    if (pcmParts.length === 0) {
      sampleRate = new DataView(bytes.buffer, 24, 4).getUint32(0, true);
      numChannels = new DataView(bytes.buffer, 22, 2).getUint16(0, true);
      bitsPerSample = new DataView(bytes.buffer, 34, 2).getUint16(0, true);
    }
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkSize = new DataView(bytes.buffer, offset + 4, 4).getUint32(0, true);
      const chunkId = String.fromCharCode(...bytes.slice(offset, offset + 4));
      if (chunkId === 'data') {
        const dataStart = offset + 8;
        const dataSize = Math.min(chunkSize, bytes.length - dataStart);
        pcmParts.push(bytes.slice(dataStart, dataStart + dataSize));
        break;
      }
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset += 1;
    }
  }
  // 先合并为整段 PCM，再裁剪首尾静音（仅单声道 16bit）：
  // 上传体积 ↓ + 模型音频编码时间 ↓，短问答尤其明显（前后常有 0.5–1s 静音）
  const t0 = performance.now();
  const mergedLen = pcmParts.reduce((sum, p) => sum + p.length, 0);
  const pcmAll = new Uint8Array(mergedLen);
  {
    let pos = 0;
    for (const p of pcmParts) { pcmAll.set(p, pos); pos += p.length; }
  }
  const { start, end } = numChannels === 1 && bitsPerSample === 16
    ? trimSilencePcm(pcmAll, sampleRate)
    : { start: 0, end: pcmAll.length };
  // 发送前统一降采样到 8kHz：端点实测接受 8k WAV 且转写准确度与 16k 一致，体积再减半。
  // mp3 还能更小（约 1/10）但需引入编码器依赖，暂不做。非单声道 16bit 时原样透传。
  const TARGET_SEND_RATE = 8000;
  const trimmed = pcmAll.subarray(start, end);
  const pcmOut = numChannels === 1 && bitsPerSample === 16 && sampleRate !== TARGET_SEND_RATE
    ? resamplePcm16(trimmed, sampleRate, TARGET_SEND_RATE)
    : trimmed;
  const outRate = numChannels === 1 && bitsPerSample === 16 ? TARGET_SEND_RATE : sampleRate;
  const totalPcm = pcmOut.length;
  const headerSize = 44;
  const output = new Uint8Array(headerSize + totalPcm);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + totalPcm, true);
  output.set(new TextEncoder().encode('WAVE'), 8);
  output.set(new TextEncoder().encode('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * numChannels * bitsPerSample / 8, true);
  view.setUint16(32, numChannels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  output.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, totalPcm, true);
  output.set(pcmOut, 44);
  debugLog('mimo-perf',
    'concat+trim+resample: %dms, %dHz→%dHz, pcmIn=%d bytes, pcmOut=%d bytes',
    Math.round(performance.now() - t0), sampleRate, outRate, mergedLen, totalPcm,
  );
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < output.length; i += CHUNK) {
    let s = '';
    const end = Math.min(i + CHUNK, output.length);
    for (let j = i; j < end; j++) s += String.fromCharCode(output[j]);
    parts.push(s);
  }
  return btoa(parts.join(''));
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function DurationTicker({ startedAt }: { startedAt: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-[10px] font-mono text-text-tertiary flex items-center gap-1">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5V8l2.5 1.5" />
      </svg>
      {t('interview.duration')} {formatDuration(now - startedAt)}
    </span>
  );
}

function EntryPrompt() {
  const t = useT();
  const openConfirm = useInterviewStore((s) => s.openConfirm);
  return (
    <div className="h-full flex flex-col items-center justify-center px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-bg-secondary border border-border-subtle
        flex items-center justify-center text-text-tertiary mb-4">
        <svg width="24" height="24" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
          strokeLinejoin="round">
          <path d="M8 1a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" />
          <path d="M4 7v1a4 4 0 0 0 8 0V7" />
          <path d="M8 12v3M5 15h6" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-text-primary mb-1.5">
        {t('interview.title')}
      </h3>
      <p className="text-xs text-text-muted leading-relaxed mb-5 max-w-[220px]">
        {t('interview.confirm.subtitle')}
      </p>
      <button
        onClick={openConfirm}
        className="py-2 px-5 rounded-xl text-xs font-semibold bg-accent
          hover:bg-accent-hover text-text-inverse hover:shadow-glow
          transition-smooth cursor-pointer"
      >
        {t('interview.confirm.enter')}
      </button>
    </div>
  );
}

/**
 * 面试模式主面板 — 多模态直连模式。
 * 音频采集 → 累积 WAV → 静音判句 → mimo API → 答案展示。
 */
export function InterviewPanel() {
  const t = useT();
  const active = useInterviewStore((s) => s.active);
  const phase = useInterviewStore((s) => s.phase);
  const transcript = useInterviewStore((s) => s.transcript);
  const currentQuestion = useInterviewStore((s) => s.currentQuestion);
  const currentAnswer = useInterviewStore((s) => s.currentAnswer);
  const history = useInterviewStore((s) => s.history);
  const startedAt = useInterviewStore((s) => s.startedAt);
  const sessionId = useInterviewStore((s) => s.sessionId);
  const startListening = useInterviewStore((s) => s.startListening);
  const stopListening = useInterviewStore((s) => s.stopListening);
  const exitInterview = useInterviewStore((s) => s.exitInterview);
  const finalizeQA = useInterviewStore((s) => s.finalizeQA);
  const clearHistory = useInterviewStore((s) => s.clearHistory);
  const setSessionId = useInterviewStore((s) => s.setSessionId);
  const systemAudioEnabled = useInterviewStore((s) => s.systemAudioEnabled);
  const systemAudioChunks = useInterviewStore((s) => s.systemAudioChunks);
  const systemAudioStatus = useInterviewStore((s) => s.systemAudioStatus);
  const toggleSystemAudio = useInterviewStore((s) => s.toggleSystemAudio);
  const incrementSystemAudioChunks = useInterviewStore((s) => s.incrementSystemAudioChunks);
  const setSystemAudioStatus = useInterviewStore((s) => s.setSystemAudioStatus);
  const asrBackend = useSettingsStore((s) => s.interviewAsrBackend);
  const setAsrBackend = useSettingsStore((s) => s.setInterviewAsrBackend);

  // ── Local ASR transcript state ──
  const [localTranscript, setLocalTranscript] = useState('');
  const [localAsrActive, setLocalAsrActive] = useState(false);

  const [exitConfirming, setExitConfirming] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // ── 多模态直连状态 ──
  const mimoAudioChunksRef = useRef<string[]>([]);
  const mimoQuestionStartedRef = useRef(false);
  /** 系统音频模式下收到过任何 chunk（含静音帧）——local 后端静音门控据此
   *  放行 finalize：系统语音即使幅度低于 SYS_AUDIO_MIN_PEAK（被判静音帧），
   *  只要音频已推给本地 ASR 就允许转写（恢复老版本"有输入即转写"行为）。
   *  纯麦克风模式不受影响（仍按非静音帧置位）。 */
  const sysAudioInputSeenRef = useRef(false);
  const sysAudioRawActiveRef = useRef(false);
  const sysAudioRestartCountRef = useRef(0);
  const sysAudioRestartTimerRef = useRef<number | null>(null);
  /** local 模式下非静音 chunk 计数：超过单题时长上限强制 finalize
   *  （底噪判为语音时静音判句永不触发，防止 Rust 缓冲区无限累积） */
  const localAudioChunkCountRef = useRef(0);
  const silenceSinceRef = useRef<number | null>(null);
  /** 引擎冷启动期间的音频暂存区：引擎就绪后一次性 flush */
  const pendingAudioRef = useRef<string[]>([]);

  /** 获取 mimo API 凭证 */
  const getMimoCredentials = useCallback(() => {
    const settings = useSettingsStore.getState();
    const baseUrl = settings.interviewMimoBaseUrl;
    const apiKey = settings.interviewMimoApiKey || '';
    const apiKeyEnv = settings.interviewMimoApiKeyEnv || undefined;
    const model = settings.interviewMimoModel || 'mimo-v2.5-pro';
    if (!baseUrl) return null;
    return { baseUrl, apiKey, apiKeyEnv, model };
  }, []);

  /** 静音超时 → 发送累积音频到 API（流式直连模式）。
   *
   *  性能优化 (Steps 0+1):
   *  1. 发起 invoke 前先订阅 `interview:mimo-token` 事件流，
   *     通过 onMimoToken 逐 delta 累加并调用 setCurrentAnswer 增量渲染。
   *     用 `performance.now()` 打点记录 merge/首 token/invoke 完成。
   *  2. 若端点不支持 SSE（tokenCount === 0），回退到 invoke 返回值兜底。 */
  const finalizeMimoQuestion = useCallback(async () => {
    const chunks = mimoAudioChunksRef.current;
    if (chunks.length === 0) return;
    const st = useInterviewStore.getState();
    st.setTranscript('');
    st.setPhase('searching');

    const perfStart = performance.now();
    const mergedWav = concatWavChunks(chunks);
    mimoAudioChunksRef.current = [];
    mimoQuestionStartedRef.current = false;
    silenceSinceRef.current = null;

    const creds = getMimoCredentials();
    if (!creds) {
      debugError('mimo', 'no credentials configured');
      st.setCurrentAnswer('[错误] 未配置多模态 API 凭证。请在 设置 > 面试助手 中配置 MiMo API。');
      st.setPhase('answered');
      return;
    }
    debugLog('mimo', 'finalizing question, chunks=%d, baseUrl=%s, model=%s', chunks.length, creds.baseUrl, creds.model);

    // ── 流式监听：先订阅 token 事件，再发起 API 调用 ──
    let streamed = '';
    let firstTokenAt: number | null = null;
    let tokenCount = 0;
    // invoke 返回后用权威全文校准 UI；finished 挡住 IPC 队列里的迟到 token
    let finished = false;
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onMimoToken(({ delta }) => {
        if (finished) return;
        if (tokenCount === 0) {
          firstTokenAt = performance.now();
          debugLog('mimo-perf', 'first_token +%dms (from finalize start)', Math.round(firstTokenAt - perfStart));
        }
        tokenCount++;
        streamed += delta;
        // 增量渲染：每收到一个 token 就更新 UI
        useInterviewStore.getState().setCurrentAnswer(streamed);
      });
    } catch (e) {
      // 订阅失败不阻断问答 —— 降级为一次性渲染（用 invoke 返回值兜底）
      debugWarn('mimo', 'token stream subscription failed, falling back to one-shot render:', e);
    }

    // 问题文本事件：ASR 第一跳完成后把识别出的真实问题替换掉 "🔊 语音问题" 占位。
    // 订阅失败只保留占位，不阻断问答
    let unlistenQ: (() => void) | null = null;
    try {
      unlistenQ = await onMimoQuestion(({ text }) => {
        if (finished) return;
        if (text.trim()) useInterviewStore.getState().setCurrentQuestion(text);
      });
    } catch (e) {
      debugWarn('mimo', 'question event subscription failed, keeping placeholder:', e);
    }

    try {
      st.setCurrentQuestion('🔊 语音问题');
      st.setPhase('answering');
      debugLog('mimo-perf',
        'merge_done +%dms, sending audio wavSize=%d chars',
        Math.round(performance.now() - perfStart),
        mergedWav.length,
      );

      // 从 settings 读取面试预设参数（B4: 支持多 Provider）
      const interviewS = useSettingsStore.getState();
      const asrModel = interviewS.interviewAsrModel || 'mimo-v2.5-asr';
      const isSingleHop = interviewS.interviewIsSingleHop ?? false;
      const answerPrompt = interviewS.interviewAnswerPrompt || undefined;
      const maxTokens = interviewS.interviewMaxTokens;
      const temperature = interviewS.interviewTemperature;
      debugLog('mimo', 'interview params: asrModel=%s isSingleHop=%s maxTokens=%d temp=%s',
        asrModel, isSingleHop, maxTokens, temperature);

      const answer = await bridge.interviewMimoAnswer(
        creds.baseUrl, creds.apiKey, creds.apiKeyEnv, creds.model, asrModel, mergedWav,
        undefined, undefined, isSingleHop, answerPrompt, maxTokens, temperature,
      );

      const invokeResolvedAt = performance.now();
      debugLog('mimo-perf',
        'invoke_resolved +%dms tokens=%d streamed=%d chars',
        Math.round(invokeResolvedAt - perfStart),
        tokenCount,
        streamed.length,
      );

      if (tokenCount === 0) {
        debugLog('mimo', 'no tokens received (non-streaming endpoint), using invoke return value: %d chars', answer.length);
      } else {
        debugLog('mimo',
          'streaming complete: %d tokens, %d total chars (invoke returned %d chars)',
          tokenCount, streamed.length, answer.length,
        );
      }

      // invoke 返回值是权威全文：先停收 token，再一次性校准 UI。
      // IPC 队列里可能还剩几个迟到 token，不挡住会覆盖校准结果导致丢尾。
      finished = true;
      st.setCurrentAnswer(answer);
      st.setPhase('answered');
      debugLog('mimo-perf', 'total +%dms', Math.round(performance.now() - perfStart));
    } catch (e) {
      finished = true;
      debugError('mimo', 'API error:', e);
      const errText = `[错误] 多模态 API 请求失败: ${e instanceof Error ? e.message : String(e)}`;
      // 流中断但已流出部分答案：保留已渲染内容 + 追加错误提示
      st.setCurrentAnswer(streamed.trim() ? `${streamed}\n\n${errText}` : errText);
      st.setPhase('answered');
    } finally {
      unlisten?.();
      unlistenQ?.();
    }
  }, [getMimoCredentials]);

  /** 本地 ASR 推理：转录并重置缓冲区（不销毁引擎），然后调 Mimo Pro 获取答案 */
  const finalizeLocalAsr = useCallback(async () => {
    // 先重置标志位，防止推理期间重复触发
    mimoQuestionStartedRef.current = false;
    sysAudioInputSeenRef.current = false;
    localAudioChunkCountRef.current = 0;
    silenceSinceRef.current = null;
    mimoAudioChunksRef.current = [];
    debugLog('local-asr', 'running final inference...');
    const st = useInterviewStore.getState();
    st.setTranscript('');
    try {
      // transcribe_and_reset：取走 buffer 推理后放回空缓冲，引擎保持在内存中
      // 避免 stop→start 的 239MB 模型重载（~500ms-1s）
      const q = (await bridge.transcribeAndResetLocalAsr()).trim();
      if (q) {
        debugLog('local-asr', 'transcript:', q);
        setLocalTranscript(q);
        st.setCurrentQuestion(q);
        const creds = getMimoCredentials();
        if (creds) {
          debugLog('local-asr', 'calling Mimo Pro: model=%s baseUrl=%s question=%s', creds.model, creds.baseUrl, q.substring(0, 60));
          let streamed = '';
          let tokenCount = 0;
          let finished = false;
          let unlistenMimo: (() => void) | null = null;
          try {
            unlistenMimo = await onMimoToken(({ delta }) => {
              if (finished) return;
              tokenCount++;
              streamed += delta;
              useInterviewStore.getState().setCurrentAnswer(streamed);
            });
          } catch (e) { debugWarn('local-asr', 'token sub failed:', e); }
          try {
            st.setPhase('answering');
            const answer = await bridge.interviewMimoAnswer(
              creds.baseUrl, creds.apiKey, creds.apiKeyEnv, creds.model,
              '', '', undefined, undefined, undefined, undefined, undefined, undefined,
              q, // questionText
            );
            finished = true;
            debugLog('local-asr', 'Mimo answer: streamed=%d chars, invoke=%d chars', streamed.length, answer.length);
            if (tokenCount === 0) {
              debugLog('local-asr', 'no streaming tokens, using invoke return value');
              st.setCurrentAnswer(answer);
            }
            st.setPhase('answered');
          } catch (e: any) {
            finished = true;
            debugWarn('local-asr', 'Mimo answer error:', e);
            st.setCurrentAnswer(`[错误] 获取答案失败: ${e}`);
            st.setPhase('answered');
          } finally {
            if (unlistenMimo) unlistenMimo();
          }
        } else {
          st.setCurrentAnswer('');
          st.setPhase('answered');
        }
      } else {
        debugWarn('local-asr', 'Inference returned empty text');
        setLocalTranscript('');
        // 空转录：重置静音计时器，保持 listening 状态等下一句话
        // 如果是手动停止触发的，stopListening() 已经设置为 'standby'
        silenceSinceRef.current = null;
      }
    } catch (e) {
      debugWarn('local-asr', 'Inference/restart error:', e);
      // transcribeAndReset 不销毁引擎，只需重置状态
      setLocalTranscript('');
      silenceSinceRef.current = null;
    }
  }, [getMimoCredentials]);

  /** 静音帧处理：检查静音时长，触发判句。
   *  local 模式：静音 1.2s → finalizeLocalAsr
   *  mimo/hybrid 模式：累积 WAV 后调 Mimo API */
  const handleMimoSilence = useCallback(async () => {
    const backend = useSettingsStore.getState().interviewAsrBackend;
    // mimo 模式需要有人声才开始累积，local 模式只要有音频就尝试推理
    if (backend !== 'local' && !mimoQuestionStartedRef.current) return;
    if (silenceSinceRef.current === null) {
      silenceSinceRef.current = Date.now();
      return;
    }
    const elapsed = Date.now() - silenceSinceRef.current;
    if (elapsed < SILENCE_DURATION_MS) return;

    if (backend === 'local') {
      // 空推理保护：从未捕获到非静音帧 → 跳过空推理，避免每 ~1.5s 一次
      // 空 ASR 推理空转 CPU。放行条件：
      //  - mimoQuestionStartedRef：出现过非静音帧（幅度达标，正常语音路径）；
      //  - sysAudioInputSeenRef：系统音频模式下收到过任何 chunk（含幅度不
      //    达标被判静音帧的弱语音）——音频已推给本地 ASR，SenseVoice 能转写
      //    弱信号，必须放行（恢复老版本"有输入即转写"行为）。
      // 两者都在 finalizeLocalAsr 开头复位，与"曾有人声"语义一致。
      if (!mimoQuestionStartedRef.current && !sysAudioInputSeenRef.current) return;
      await finalizeLocalAsr();
      return;
    }

    if (backend === 'hybrid') {
      // 混合模式：同时触发 Mimo API 问答和本地 ASR 转录，供对比面板展示
      if (mimoAudioChunksRef.current.length > 0) {
        debugLog('mimo', 'silence threshold reached (%dms), triggering hybrid finalization', elapsed);
        void finalizeMimoQuestion();
        void finalizeLocalAsr();
      }
      return;
    }

    if (mimoAudioChunksRef.current.length === 0) return;
    debugLog('mimo', 'silence threshold reached (%dms), triggering question finalization', elapsed);
    void finalizeMimoQuestion();
  }, [finalizeMimoQuestion, finalizeLocalAsr]);

  // ── 音频采集 ──
  const handleAudioChunk = useCallback(
    async (wavBase64: string, _chunkId: string) => {
      const state = useInterviewStore.getState();
      if (!state.active || state.phase !== 'listening') return;

      const backend = useSettingsStore.getState().interviewAsrBackend;
      const sysAudioOn = state.systemAudioEnabled;
      // local + 系统音频: 麦克风只维持 isRecording 状态，音频和静音由 WASAPI 负责
      if (backend === 'local' && sysAudioOn) return;

      const needsLocal = backend === 'local' || backend === 'hybrid';

      // Push to local ASR (independent of peak detection)
      if (needsLocal) {
        if (localAsrActive) {
          bridge.pushLocalAsrAudio(wavBase64).catch((e) => {
            debugWarn('local-asr', 'push error:', e);
          });
        } else {
          // 引擎尚未就绪（冷启动窗口）→ 暂存，等就绪后一次性 flush
          pendingAudioRef.current.push(wavBase64);
        }
      }

      const peak = computeWavPeakFromBase64(wavBase64);
      if (peak < AUDIO_MIN_PEAK) {
        handleMimoSilence();
      } else {
        silenceSinceRef.current = null;
        mimoQuestionStartedRef.current = true;
        // 仅在 mimo/hybrid 模式累积音频到 Mimo API
        if (backend !== 'local') {
          mimoAudioChunksRef.current.push(wavBase64);
          if (mimoAudioChunksRef.current.length === 1) {
            debugLog('mimo', 'speech started (mic), peak=%.4f', peak);
          }
          // 上限兜底：超长连续语音（无 1.5s 停顿）强制分段判句
          if (mimoAudioChunksRef.current.length >= MAX_QA_AUDIO_CHUNKS) {
            debugLog('mimo', 'mic chunk cap reached (%d), forcing finalize', MAX_QA_AUDIO_CHUNKS);
            silenceSinceRef.current = null;
            void finalizeMimoQuestion();
          }
        } else {
          // local 模式：非静音 chunk 计数，超单题时长上限强制转写
          localAudioChunkCountRef.current += 1;
          if (localAudioChunkCountRef.current >= MAX_QA_AUDIO_CHUNKS) {
            debugLog('mimo', 'local mic chunk cap reached (%d), forcing finalize', MAX_QA_AUDIO_CHUNKS);
            localAudioChunkCountRef.current = 0;
            silenceSinceRef.current = null;
            void finalizeLocalAsr();
          }
        }
      }
    },
    [handleMimoSilence, localAsrActive],
  );

  const { isRecording, start: startCapture, stop: stopCapture, prepare: prepareCapture, error: captureError } =
    useAudioCapture(handleAudioChunk, { chunkIntervalMs: 500 });


  useEffect(() => { setAudioError(captureError); }, [captureError]);

  // ── 进入面试时预热（第三层优化 7+8+9，均静默失败）──
  // 7) 连接预热：零计费 GET 提前建好 TCP/TLS，第一题不等冷握手
  // 8) 录音管线预热：预取麦克风 + AudioContext（suspended），首句录音只需 resume
  // 9) 本地 ASR 引擎预热：与麦克风管线同时开始加载模型，最大化预热窗口
  useEffect(() => {
    if (!active) return;
    const creds = getMimoCredentials();
    if (creds) {
      bridge.prewarmMimoConnection(creds.baseUrl).catch(() => {});
    }
    void prepareCapture();
    // 本地/混合模式：提前加载 ASR 引擎，避免首句录音时冷启动丢失音频
    const needsLocal = asrBackend === 'local' || asrBackend === 'hybrid';
    if (needsLocal && !localAsrActive) {
      bridge.startLocalAsrSession().then(() => {
        setLocalAsrActive(true);
        setLocalTranscript('');
        // 引擎就绪：flush 冷启动期间暂存的音频
        const pending = pendingAudioRef.current;
        if (pending.length > 0) {
          debugLog('local-asr', 'engine ready, flushing %d pending chunks', pending.length);
          for (const chunk of pending) {
            bridge.pushLocalAsrAudio(chunk).catch((e) => {
              debugWarn('local-asr', 'flush error:', e);
            });
          }
          pendingAudioRef.current = [];
        }
      }).catch((e) => {
        debugWarn('local-asr', 'Failed to start session:', e);
      });
    } else if (!needsLocal && localAsrActive) {
      bridge.stopLocalAsrSession().then(() => {
        setLocalAsrActive(false);
        setLocalTranscript('');
      }).catch(() => {});
    }
  }, [active, getMimoCredentials, prepareCapture, asrBackend, localAsrActive]);

  // ── 进入面试 ──
  useEffect(() => {
    if (!active || sessionId) return;
    setSessionId('mimo-direct');
  }, [active, sessionId, setSessionId]);

  // ── 本地 ASR 转录事件监听 ──
  useEffect(() => {
    if (!active || !localAsrActive) return;
    const p = onLocalAsrTranscript(({ text, isFinal }) => {
      setLocalTranscript((prev) => {
        if (isFinal) return prev + text;
        // For partial results, replace the last line
        const lines = prev.split('\n');
        lines[lines.length - 1] = text;
        return lines.join('\n');
      });
    });
    return () => { p.then((u: () => void) => u()).catch(() => {}); };
  }, [active, localAsrActive]);

  // ── 退出面试 ──
  useEffect(() => {
    if (active) return;
    if (sysAudioRestartTimerRef.current !== null) {
      clearTimeout(sysAudioRestartTimerRef.current);
      sysAudioRestartTimerRef.current = null;
    }
    sysAudioRestartCountRef.current = 0;
    stopCapture();
    if (sysAudioRawActiveRef.current) {
      bridge.stopSystemAudioRaw().then(() => {
        sysAudioRawActiveRef.current = false;
      }).catch(() => {});
    }
    // Stop local ASR session if active
    if (localAsrActive) {
      bridge.stopLocalAsrSession().catch(() => {});
      setLocalAsrActive(false);
      setLocalTranscript('');
    }
    useInterviewStore.getState().setSessionId(null);
    setSystemAudioStatus(null);
  }, [active, setSystemAudioStatus, stopCapture, localAsrActive]);

  // ── 组件卸载清理 ──
  useEffect(() => {
    return () => {
      if (sysAudioRestartTimerRef.current !== null) {
        clearTimeout(sysAudioRestartTimerRef.current);
        sysAudioRestartTimerRef.current = null;
      }
      const state = useInterviewStore.getState();
      if (state.active) {
        stopCapture();
        if (sysAudioRawActiveRef.current) {
          bridge.stopSystemAudioRaw().then(() => {
            sysAudioRawActiveRef.current = false;
          }).catch(() => {});
        }
        state.setSessionId(null);
      }
    };
  }, []);

  // ── 系统音频开关 ──
  useEffect(() => {
    if (!active) return;
    if (systemAudioEnabled) {
      bridge.startSystemAudioRaw().then(() => {
        sysAudioRawActiveRef.current = true;
      }).catch((e) => {
        debugError('general', 'start system audio raw failed:', e);
        setAudioError(`系统音频启动失败: ${e}`);
        sysAudioRawActiveRef.current = false;
      });
    } else {
      bridge.stopSystemAudioRaw().then(() => {
        sysAudioRawActiveRef.current = false;
      }).catch(console.error);
      setSystemAudioStatus(null);
    }
  }, [systemAudioEnabled, active, setSystemAudioStatus]);

  // ── 系统音频事件监听 ──
  useEffect(() => {
    if (!active) return;

    const p0 = onSystemAudioChunk(() => {
      incrementSystemAudioChunks();
    });

    const p1 = onSystemAudioResult((result) => {
      const st = useInterviewStore.getState();
      if (st.phase !== 'listening') return;
      const peak = result.peak;
      const wavBase64 = (result as any).wavBase64 as string | undefined;
      const backend = useSettingsStore.getState().interviewAsrBackend;
      const needsLocal = backend === 'local' || backend === 'hybrid';

      // 收到过任何系统音频 chunk（含静音帧）——local 后端静音门控据此放行
      sysAudioInputSeenRef.current = true;

      // Push to local ASR if active; buffer if engine still loading
      if (needsLocal && wavBase64) {
        if (localAsrActive) {
          bridge.pushLocalAsrAudio(wavBase64).catch((e) => {
            debugWarn('local-asr', 'push (sys audio) error:', e);
          });
        } else {
          pendingAudioRef.current.push(wavBase64);
        }
      }

      if (typeof peak === 'number' && peak < SYS_AUDIO_MIN_PEAK) {
        // 静音帧：记录首次静音时间或累积判断
        if (silenceSinceRef.current === null) {
          silenceSinceRef.current = Date.now();
          debugLog('sys-audio', 'silence start, peak=%.6f', peak);
        }
        handleMimoSilence();
      } else if (wavBase64) {
        if (silenceSinceRef.current !== null) {
          debugLog('sys-audio', 'speech resumed, peak=%.6f (silence was %dms)', peak, Date.now() - silenceSinceRef.current);
        }
        silenceSinceRef.current = null;
        mimoQuestionStartedRef.current = true;
        // 仅在 mimo/hybrid 模式累积音频到 Mimo API
        if (backend !== 'local') {
          mimoAudioChunksRef.current.push(wavBase64);
          if (mimoAudioChunksRef.current.length === 1) {
            debugLog('mimo', 'speech started (sys), peak=%.4f', peak);
          }
          // 累积上限兜底：底噪判为语音导致静音判句永不触发时，强制分段判句
          if (mimoAudioChunksRef.current.length >= MAX_QA_AUDIO_CHUNKS) {
            debugLog('mimo', 'sys audio chunk cap reached (%d), forcing finalize', MAX_QA_AUDIO_CHUNKS);
            silenceSinceRef.current = null;
            void finalizeMimoQuestion();
          }
        } else {
          // local 模式：非静音 chunk 计数，超单题时长上限强制转写
          localAudioChunkCountRef.current += 1;
          if (localAudioChunkCountRef.current >= MAX_QA_AUDIO_CHUNKS) {
            debugLog('mimo', 'local sys audio chunk cap reached (%d), forcing finalize', MAX_QA_AUDIO_CHUNKS);
            localAudioChunkCountRef.current = 0;
            silenceSinceRef.current = null;
            void finalizeLocalAsr();
          }
        }
      }
    });

    const p2 = onSystemAudioError((err) => {
      debugWarn('sys-audio', 'system audio error:', err);
      // 设备拔出/切换（如插拔耳机）导致采集退出 → 自动重启（带退避防循环）
      const st = useInterviewStore.getState();
      if (!st.active || !st.systemAudioEnabled) return;
      if (sysAudioRestartCountRef.current >= SYS_AUDIO_MAX_RESTARTS) {
        debugWarn('sys-audio', 'restart limit reached (%d), giving up', SYS_AUDIO_MAX_RESTARTS);
        setAudioError('系统音频采集中断，且自动恢复失败。请检查音频设备后重新开启系统音频。');
        sysAudioRawActiveRef.current = false;
        return;
      }
      if (sysAudioRestartTimerRef.current !== null) return; // 已有重启计时在跑
      sysAudioRestartCountRef.current += 1;
      debugLog('sys-audio', 'scheduling restart #%d in %dms', sysAudioRestartCountRef.current, SYS_AUDIO_RESTART_MS);
      sysAudioRestartTimerRef.current = window.setTimeout(() => {
        sysAudioRestartTimerRef.current = null;
        const st2 = useInterviewStore.getState();
        if (!st2.active || !st2.systemAudioEnabled) return;
        bridge.startSystemAudioRaw().then(() => {
          // 竞态防护：invoke 在途期间用户退出了面试/关了开关 → 立即停掉，
          // 否则采集线程无人负责停止（exit effect 的 stop 已因 SYS_AUDIO_RAW
          // 为空而失败过）
          const st3 = useInterviewStore.getState();
          if (!st3.active || !st3.systemAudioEnabled) {
            bridge.stopSystemAudioRaw().catch(() => {});
            sysAudioRawActiveRef.current = false;
            return;
          }
          sysAudioRawActiveRef.current = true;
          sysAudioRestartCountRef.current = 0; // 重启成功，重置计数
          debugLog('sys-audio', 'restarted after error');
        }).catch((e) => {
          debugWarn('sys-audio', 'restart failed:', e);
          sysAudioRawActiveRef.current = false;
        });
      }, SYS_AUDIO_RESTART_MS);
    });

    const p3 = onSystemAudioStatus((status) => {
      setSystemAudioStatus(status);
    });

    return () => {
      p0.then((u) => u()).catch(() => {});
      p1.then((u) => u()).catch(() => {});
      p2.then((u) => u()).catch(() => {});
      p3.then((u) => u()).catch(() => {});
    };
  }, [active, handleMimoSilence, incrementSystemAudioChunks, setSystemAudioStatus, localAsrActive, finalizeMimoQuestion, finalizeLocalAsr]);

  // 退出时自动关闭系统音频
  useEffect(() => {
    if (!active) {
      const store = useInterviewStore.getState();
      if (store.systemAudioEnabled) {
        store.toggleSystemAudio();
      }
    }
  }, [active]);

  // 退出确认 3 秒自动撤销
  useEffect(() => {
    if (!exitConfirming) return;
    const id = setTimeout(() => setExitConfirming(false), 3000);
    return () => clearTimeout(id);
  }, [exitConfirming]);

  const meta = PHASE_META[phase];
  const isListening = phase === 'listening' && isRecording;
  const isBusy = phase === 'searching' || phase === 'answering';
  const showQA = currentQuestion || currentAnswer || phase === 'answered';

  // ── 麦克风开关（共享逻辑：onClick + Enter 键）──
  // 状态机：
  //   answered → finalizeQA() + 开始录音（下一题）
  //   正在录音 → 停止录音 + 触发问答
  //   standby  → 开始录音
  const handleToggleMic = useCallback(async () => {
    if (isTransitioning) return;
    if (phase === 'answered') {
      // 下一题：归档当前 QA，清空音频缓冲区，开始新录音
      finalizeQA();
      mimoAudioChunksRef.current = [];
      mimoQuestionStartedRef.current = false;
      sysAudioInputSeenRef.current = false;
      localAudioChunkCountRef.current = 0;
      silenceSinceRef.current = null;
      startListening();
      setIsTransitioning(true);
      try {
        await startCapture();
      } catch {
        stopListening();
      } finally {
        setIsTransitioning(false);
      }
    } else if (isListening) {
      // 停止录音 → 触发识别
      stopListening();
      stopCapture();
      const backend = useSettingsStore.getState().interviewAsrBackend;
      if (backend === 'local') {
        // 本地模式：立即触发推理（不等静音超时）
        void finalizeLocalAsr();
      } else if (backend === 'hybrid') {
        // 混合模式：同时触发 Mimo 问答和本地转录
        if (mimoAudioChunksRef.current.length > 0 && mimoQuestionStartedRef.current) {
          void finalizeMimoQuestion();
        }
        void finalizeLocalAsr();
      } else if (mimoAudioChunksRef.current.length > 0 && mimoQuestionStartedRef.current) {
        void finalizeMimoQuestion();
      }
    } else if (!isBusy) {
      // 开始录音
      startListening();
      setIsTransitioning(true);
      try {
        await startCapture();
      } catch {
        stopListening();
      } finally {
        setIsTransitioning(false);
      }
    }
  }, [phase, isListening, isBusy, isTransitioning, finalizeQA, stopListening, stopCapture, startCapture, startListening, finalizeMimoQuestion, finalizeLocalAsr]);

  // ── Enter 快捷键：开关麦克风 ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      // 焦点在输入框/编辑器时不触发
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      if (!useInterviewStore.getState().active) return;
      e.preventDefault();
      void handleToggleMic();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleToggleMic]);

  // 所有 hooks 必须在此 early return 之前调用完毕。
  // 若把 early return 放在 hooks 之间，active 切换（进入/退出面试模式）
  // 会让本次渲染比上次多/少调用 hook，违反 React hooks 规则 →
  // Minified React error #300 → 整页崩溃到错误边界。
  if (!active) return <EntryPrompt />;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 状态栏 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 transition-smooth
          ${meta.dot} ${meta.glow ?? ''} ${meta.pulse ? 'animate-pulse-soft' : ''}`} />
        <span className="text-xs font-semibold text-text-primary">
          {t(`interview.phase.${phase}`)}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          {startedAt && <DurationTicker startedAt={startedAt} />}
          {/* ASR 后端选择器 */}
          <select
            value={asrBackend}
            onChange={(e) => setAsrBackend(e.target.value as 'mimo' | 'local' | 'hybrid')}
            className="px-1.5 py-1 rounded-md text-[11px] font-medium transition-smooth cursor-pointer
              bg-bg-secondary border border-border-subtle text-text-secondary
              hover:border-border-focus focus:outline-none focus:ring-1 focus:ring-accent/30"
            title={t('interview.asrBackend.label')}
          >
            <option value="mimo">{t('interview.asrBackend.mimo')}</option>
            <option value="local">{t('interview.asrBackend.local')}</option>
            <option value="hybrid">{t('interview.asrBackend.hybrid')}</option>
          </select>
          {/* 系统音频开关 */}
          <button
            onClick={toggleSystemAudio}
            className={`px-2 py-1 rounded-lg text-[11px] font-medium transition-smooth cursor-pointer
              ${systemAudioEnabled
                ? 'bg-accent/15 text-accent hover:bg-accent/25'
                : 'bg-bg-secondary text-text-muted hover:bg-bg-tertiary hover:text-text-primary'}`}
            title={t('interview.systemAudio.hint')}
          >
            <span className="flex items-center gap-1">
              <span className="relative flex items-center">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 6v4M5 4v8M8 2v12M11 5v6M14 7v2" />
                </svg>
                {systemAudioEnabled && systemAudioChunks > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 animate-pulse-soft" />
                )}
              </span>
              {t('interview.systemAudio')}
              {systemAudioEnabled && systemAudioChunks > 0 && (
                <span className="text-[9px] text-text-tertiary ml-0.5">{systemAudioChunks}</span>
              )}
            </span>
          </button>
          <button
            onClick={() => exitConfirming ? (exitInterview(), setExitConfirming(false)) : setExitConfirming(true)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-smooth cursor-pointer
              ${exitConfirming
                ? 'bg-error/15 text-error hover:bg-error/25'
                : 'bg-bg-secondary text-text-muted hover:bg-bg-tertiary hover:text-text-primary'}`}
            title={exitConfirming ? t('interview.exit.confirm') : t('interview.exit')}
          >
            {exitConfirming ? t('common.confirm') : t('interview.exit')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-4">
        {/* 麦克风控制 */}
        <div className="flex flex-col items-center py-2">
          <div className="relative flex items-center justify-center">
            {isListening && (
              <>
                <span className="absolute w-20 h-20 rounded-full bg-red-500/15 animate-ping-slow" />
                <span className="absolute w-14 h-14 rounded-full bg-red-500/20 animate-ping-slow [animation-delay:350ms]" />
              </>
            )}
            <button
              onClick={handleToggleMic}
              disabled={isBusy || isTransitioning || !sessionId}
              className={`relative w-16 h-16 rounded-full flex items-center justify-center
                transition-smooth cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
                ${isListening
                  ? 'bg-red-500 text-white shadow-[0_4px_20px_rgba(239,68,68,0.4)] hover:bg-red-600'
                  : 'bg-accent text-text-inverse hover:bg-accent-hover hover:shadow-glow'}`}
              title={isListening ? t('interview.mic.stop') : t('interview.mic.start')}
            >
              {isListening ? (
                <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="4" y="4" width="8" height="8" rx="1.5" />
                </svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
                  strokeLinejoin="round">
                  <path d="M8 1a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z" />
                  <path d="M4 7v1a4 4 0 0 0 8 0V7" />
                  <path d="M8 12v3M5 15h6" />
                </svg>
              )}
            </button>
          </div>
          <p className="text-[11px] text-text-tertiary mt-3 text-center">
            {audioError
              ? audioError
              : isListening
                ? t('interview.phase.listening') + '…'
                : t('interview.mic.hint')}
          </p>
          {/* 系统音频调试状态 */}
          {systemAudioEnabled && systemAudioStatus && (
            <p className="text-[10px] text-text-tertiary text-center mt-1">
              WASAPI: {systemAudioStatus.elapsedSecs}s, {systemAudioStatus.totalFramesRead} frames, {systemAudioStatus.chunksProduced} chunks
              {' · '}
              peak:{' '}
              <span className={
                (systemAudioStatus.peakMax ?? 0) > 0.001
                  ? 'text-success font-medium'
                  : 'text-error font-medium'
              }>
                {(systemAudioStatus.peakMax ?? 0).toFixed(3)}
              </span>
              {(systemAudioStatus.silentChunks ?? 0) > 0 && (
                <span className="text-error"> (静音块 {systemAudioStatus.silentChunks})</span>
              )}
            </p>
          )}
          {audioError && (
            <button
              onClick={() => setAudioError(null)}
              className="text-[10px] text-accent hover:underline cursor-pointer mt-1"
            >
              {t('common.dismiss')}
            </button>
          )}
        </div>

        {/* 实时转录 */}
        <div className="rounded-xl border border-border-subtle bg-bg-secondary/60 overflow-hidden">
          <div className="px-3 py-2 border-b border-border-subtle/60 flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className="text-text-tertiary">
              <path d="M2 8h2M6 5v6M10 3v10M14 7h0" />
            </svg>
            <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
              {t('interview.transcript.label')}
            </span>
            {isListening && (
              <span className="ml-auto flex gap-0.5 items-end h-3">
                <span className="w-0.5 bg-red-500 rounded-full animate-pulse-soft h-1.5" />
                <span className="w-0.5 bg-red-500 rounded-full animate-pulse-soft h-3 [animation-delay:150ms]" />
                <span className="w-0.5 bg-red-500 rounded-full animate-pulse-soft h-2 [animation-delay:300ms]" />
              </span>
            )}
          </div>
          <p className={`px-3 py-3 text-[13px] leading-relaxed min-h-[52px]
            ${transcript ? 'text-text-primary' : 'text-text-tertiary'}`}>
            {transcript || t('interview.transcript.placeholder')}
            {isListening && transcript && (
              <span className="inline-block w-0.5 h-3.5 bg-red-500 ml-0.5 align-middle animate-pulse-soft" />
            )}
          </p>
        </div>

        {/* 本地 ASR 转录 (仅 local/hybrid 模式) */}
        {localAsrActive && (
          <div className="rounded-xl border border-green-500/25 bg-green-500/5 overflow-hidden">
            <div className="px-3 py-2 border-b border-green-500/15 flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                className="text-green-500/70">
                <path d="M2 8h2M6 5v6M10 3v10M14 7h0" />
              </svg>
              <span className="text-[11px] font-semibold text-green-500/80 uppercase tracking-wide">
                {t('interview.asrBackend.local')}
              </span>
              {isListening && (
                <span className="ml-auto flex gap-0.5 items-end h-3">
                  <span className="w-0.5 bg-green-500 rounded-full animate-pulse-soft h-1.5" />
                  <span className="w-0.5 bg-green-500 rounded-full animate-pulse-soft h-3 [animation-delay:150ms]" />
                  <span className="w-0.5 bg-green-500 rounded-full animate-pulse-soft h-2 [animation-delay:300ms]" />
                </span>
              )}
            </div>
            <p className={`px-3 py-3 text-[13px] leading-relaxed min-h-[52px]
              ${localTranscript ? 'text-text-primary' : 'text-text-tertiary'}`}>
              {localTranscript
                || (isListening ? t('interview.listening') : t('interview.transcript.placeholder'))
              }
              {isListening && localTranscript && (
                <span className="inline-block w-0.5 h-3.5 bg-green-500 ml-0.5 align-middle animate-pulse-soft" />
              )}
            </p>
          </div>
        )}

        {/* 混合对比面板 — 仅 hybrid 模式 + 两个转录都有内容时显示 */}
        {asrBackend === 'hybrid' && localAsrActive && transcript && localTranscript && (
          <HybridCompareCard
            mimoText={transcript}
            localText={localTranscript}
            mimoLabel={t('interview.asrBackend.mimo')}
            localLabel={t('interview.asrBackend.local')}
            hybridLabel={t('interview.asrBackend.hybrid')}
          />
        )}

        {/* 当前问答 */}
        {showQA && (
          <div className="rounded-xl border border-accent/25 bg-accent/5 overflow-hidden animate-fade-in">
            <div className="px-3 py-2 border-b border-accent/15 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-accent uppercase tracking-wide">
                {t('interview.question.label')}
              </span>
              {phase === 'answered' && (
                <button
                  onClick={() => finalizeQA()}
                  className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-accent/12
                    text-accent hover:bg-accent/20 transition-smooth cursor-pointer"
                >
                  {t('interview.next')} →
                </button>
              )}
            </div>
            <div className="px-3 py-2.5">
              <p className="text-[13px] font-medium text-text-primary leading-relaxed">
                {currentQuestion || '…'}
              </p>
            </div>
            <div className="px-3 pb-1">
              <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
                {t('interview.answer.label')}
              </span>
            </div>
            <div className="px-3 pb-3">
              <p className={`text-[13px] leading-relaxed
                ${currentAnswer ? 'text-text-secondary' : 'text-text-tertiary'}`}>
                {currentAnswer || t('interview.answer.placeholder')}
                {phase === 'answering' && (
                  <span className="inline-block w-0.5 h-3.5 bg-accent ml-0.5 align-middle animate-pulse-soft" />
                )}
              </p>
            </div>
          </div>
        )}

        {/* 问答历史 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
              {t('interview.history.label')}
              {history.length > 0 && (
                <span className="ml-1.5 text-text-tertiary font-normal">{history.length}</span>
              )}
            </span>
            {history.length > 0 && (
              <button onClick={clearHistory}
                className="text-[10px] text-text-tertiary hover:text-error transition-smooth cursor-pointer">
                {t('interview.history.clear')}
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-[11px] text-text-tertiary text-center py-4
              border border-dashed border-border-subtle rounded-lg">
              {t('interview.history.empty')}
            </p>
          ) : (
            <div className="space-y-2">
              {history.map((qa) => (
                <div key={qa.id}
                  className="rounded-lg border border-border-subtle bg-bg-secondary/50
                    px-3 py-2.5 hover:border-border-default transition-smooth">
                  <div className="flex items-start gap-2 mb-1">
                    <span className={`flex-shrink-0 px-1.5 py-px rounded text-[9px] font-semibold mt-0.5
                      ${qa.source === 'rag' ? 'bg-success/12 text-success'
                        : qa.source === 'web' ? 'bg-warning/12 text-warning'
                        : 'bg-accent/12 text-accent'}`}>
                      {t(`interview.source.${qa.source}`)}
                    </span>
                    <p className="text-xs font-medium text-text-primary leading-snug">
                      {qa.question}
                    </p>
                  </div>
                  <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">
                    {qa.answer}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
