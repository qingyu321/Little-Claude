/**
 * 麦克风音频采集 Hook。
 *
 * 使用 Web Audio API (getUserMedia + MediaRecorder) 采集麦克风输入，
 * 每 500ms 产生一个 WAV 音频块，通过回调传递给上层。
 *
 * 用法:
 *   const { isRecording, start, stop, error } = useAudioCapture((wavBase64, chunkId) => {
 *     bridge.sendInterviewAudio(sessionId, chunkId, wavBase64);
 *   });
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAudioCaptureOptions {
  /** 分块间隔（毫秒）。默认 500ms — 平衡低延迟和转写效率。 */
  chunkIntervalMs?: number;
}

interface UseAudioCaptureReturn {
  /** 是否正在录音。 */
  isRecording: boolean;
  /** 预热：提前获取麦克风和 AudioContext（suspended），使首次 start() 近乎瞬时。
   *  静默失败 —— 预热不成功也不影响 start() 现场建链。 */
  prepare: () => Promise<void>;
  /** 启动录音。 */
  start: () => Promise<void>;
  /** 停止录音。 */
  stop: () => void;
  /** 最后遇到的错误（null = 无错误）。 */
  error: string | null;
}

// ── 简易 WAV 编码器 ──
// 将 WebM/Opus AudioBuffer 或 PCM 数据转换为 WAV 格式。
// 生产环境可替换为更完善的库（如 wavefile）。

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples (Float32 → Int16, 对称舍入)
  let offset = 44;
  for (const sample of samples) {
    const s = Math.max(-1, Math.min(1, sample));
    const int16 = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ── Base64 编码 ──
// 分块 fromCharCode + join：逐字节 `+=` 拼接是 O(n²)（每次拼接都复制整段字符串），
// 音频越长主线程卡顿越明显，会拖累静音判定和发送回调的及时性。
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // spread 参数表上限，与 concatWavChunks 保持一致
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

// ── Hook ──

export function useAudioCapture(
  onChunk: (wavBase64: string, chunkId: string) => void,
  options: UseAudioCaptureOptions = {},
): UseAudioCaptureReturn {
  const { chunkIntervalMs = 500 } = options;
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const bufferRef = useRef<Float32Array[]>([]);
  const chunkTimerRef = useRef<number | null>(null);
  const chunkIndexRef = useRef(0);
  const recordingRef = useRef(false);
  // 流获取意图：prepare/start 置 true，stop 置 false。
  // 预热后用户马上停止时，借此立即释放迟到的 getUserMedia 结果，防止麦克风流悬挂。
  const wantStreamRef = useRef(false);
  // 用 ref 保存最新 callback，避免 setInterval 捕获 stale closure
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  // ── 卸载清理 ──
  useEffect(() => {
    return () => {
      wantStreamRef.current = false;
      if (chunkTimerRef.current !== null) {
        clearInterval(chunkTimerRef.current);
        chunkTimerRef.current = null;
      }
      try { processorRef.current?.disconnect(); } catch { /* 已断开 */ }
      try { sourceRef.current?.disconnect(); } catch { /* 已断开 */ }
      try { ctxRef.current?.close(); } catch { /* 已关闭 */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      recordingRef.current = false;
    };
  }, []);

  const stop = useCallback(() => {
    recordingRef.current = false;
    wantStreamRef.current = false;
    setIsRecording(false);
    if (chunkTimerRef.current !== null) {
      clearInterval(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    try { processorRef.current?.disconnect(); } catch { /* 已断开 */ }
    try { sourceRef.current?.disconnect(); } catch { /* 已断开 */ }
    try { ctxRef.current?.close(); } catch { /* 已关闭 */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current = null;
    processorRef.current = null;
    sourceRef.current = null;
    bufferRef.current = [];
  }, []);

  // ── 预热：提前获取麦克风 + AudioContext（suspended）──
  // 进入面试模式时调用，首次 start() 只需 resume，
  // 省掉 getUserMedia + new AudioContext 的几百 ms 异步启动。
  // 静默失败：预热没拿到资源时 start() 照常现场建链并报错。
  const prepare = useCallback(async () => {
    if (recordingRef.current || streamRef.current?.active) return;
    wantStreamRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      // 等待期间用户已停止（如退出面试）→ 立即释放，不让麦克风流悬挂
      if (!wantStreamRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: 16000 });
      } catch {
        ctx = new AudioContext();
      }
      ctxRef.current = ctx;
      // 预热上下文保持 suspended，start() 再 resume —— 避免自动播放策略干扰
      if (ctx.state === 'running') {
        try { await ctx.suspend(); } catch { /* 忽略 */ }
      }
    } catch {
      // 权限拒绝/无设备：留给 start() 重试并报错，预热失败不算错误
    }
  }, []);

  const flushBuffer = useCallback(() => {
    const buffers = bufferRef.current;
    if (buffers.length === 0) return;

    // 合并所有缓冲的 Float32Array
    const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
    const merged = new Float32Array(totalLen);
    let pos = 0;
    for (const b of buffers) {
      merged.set(b, pos);
      pos += b.length;
    }
    buffers.length = 0;

    const sampleRate = ctxRef.current?.sampleRate ?? 16000;
    const wavBuffer = encodeWav(merged, sampleRate);
    const base64 = arrayBufferToBase64(wavBuffer);
    const chunkId = `c${chunkIndexRef.current++}_${Date.now()}`;
    onChunkRef.current(base64, chunkId);
  }, []);

  const start = useCallback(async () => {
    // 重入保护：已在录音中则忽略
    if (recordingRef.current) return;
    recordingRef.current = true;
    setError(null);
    chunkIndexRef.current = 0;
    bufferRef.current = [];

    try {
      // 1. 麦克风流：优先复用预热流，没有则现场获取
      let stream = streamRef.current;
      if (!stream || !stream.active) {
        wantStreamRef.current = true;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        // 竞态保护：等待权限期间用户可能已停止录音 —— 立即释放刚拿到的流，
        // 否则麦克风流会在"已停止"后继续存活（隐私泄漏）
        if (!recordingRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
      }

      // 2. AudioContext：复用预热上下文（已关闭则重建；部分浏览器不支持自定义采样率 → 回退）
      let ctx = ctxRef.current;
      if (!ctx || ctx.state === 'closed') {
        try {
          ctx = new AudioContext({ sampleRate: 16000 });
        } catch {
          ctx = new AudioContext();
        }
        ctxRef.current = ctx;
      }
      // 自动播放策略下新 ctx 可能处于 suspended —— 不 resume 则 onaudioprocess 永不触发（静默无输出）
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          /* 部分环境拒绝 resume 后仍可工作，忽略 */
        }
      }

      // 3. 连接音频处理管线
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // 使用 ScriptProcessorNode 获取原始 PCM 数据
      // 注意: ScriptProcessorNode 已 deprecated，但 AudioWorklet 路径更复杂。
      // 对于 16kHz 单声道场景，ScriptProcessorNode 足够且兼容性好。
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        // 复制数据（因为 Float32Array 会被复用）
        bufferRef.current.push(new Float32Array(input));
      };

      source.connect(processor);
      // ScriptProcessor 必须有输出连接才会触发 onaudioprocess；但直连 destination
      // 会把麦克风原声送到扬声器（啸叫）——串一个 gain=0 的节点静音
      const mute = ctx.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(ctx.destination);

      // 4. 定时刷新缓冲为 WAV 块
      chunkTimerRef.current = window.setInterval(() => {
        flushBuffer();
      }, chunkIntervalMs);

      setIsRecording(true);
    } catch (e) {
      recordingRef.current = false;
      const msg = e instanceof DOMException
        ? (e.name === 'NotAllowedError'
          ? '麦克风权限被拒绝。请在系统设置中允许麦克风访问。'
          : e.name === 'NotFoundError'
            ? '未检测到麦克风设备。请连接麦克风后重试。'
            : `麦克风错误: ${e.message}`)
        : String(e);
      setError(msg);
      stop();
    }
  }, [chunkIntervalMs, flushBuffer, stop]);

  return { isRecording, prepare, start, stop, error };
}
