import { create } from 'zustand';

// --- Types ---

/**
 * Interview mode phase machine:
 *
 *   idle ──(确认进入)──> standby ──(开始监听)──> listening
 *    ▲                     ▲                        │
 *    │                     │                  (静音判句)
 *  (退出)               (下一题)                    ▼
 *    │                     │                    searching
 *    │                     │                        │
 *    │                     └──────────────── answering
 */
export type InterviewPhase =
  | 'idle'        // 未进入面试模式
  | 'standby'     // 已进入，麦克风待命
  | 'listening'   // 正在收音 + 实时转录
  | 'searching'   // 检测到问题，准备调用 API
  | 'answering'   // 正在调用多模态 API 生成答案
  | 'answered';   // 当前问题答案已就绪

export interface QARecord {
  id: string;
  question: string;
  answer: string;
  /** 答案来源：rag=本地知识库命中 / web=联网搜索 / llm=纯模型生成 */
  source: 'rag' | 'web' | 'llm';
  timestamp: number;
}

// ── 转录拼接 ──

/** CJK 判断：汉字 + CJK 标点 + 全角字符（任一相邻则拼接不补空格） */
function isCjk(ch: string | undefined): boolean {
  const c = ch?.codePointAt(0) ?? 0;
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xff00 && c <= 0xffef)
  );
}

/** 转录累积上限（字符数）——超出截掉头部，保留最新内容 */
const TRANSCRIPT_MAX_LEN = 2000;

interface InterviewState {
  /** 确认进入弹窗是否打开 */
  confirmOpen: boolean;
  /** 当前阶段 */
  phase: InterviewPhase;
  /** 面试会话是否激活（决定侧边栏入口行为） */
  active: boolean;
  /** 实时转录文字 */
  transcript: string;
  /** 当前完整问题 */
  currentQuestion: string;
  /** 当前答案 */
  currentAnswer: string;
  /** 当前答案的来源 — finalizeQA 归档时取此值打徽标 */
  lastAnswerSource: QARecord['source'];
  /** 问答历史 */
  history: QARecord[];
  /** 会话开始时间戳 */
  startedAt: number | null;
  /** 会话 ID（多模态直连模式固定为 'mimo-direct'） */
  sessionId: string | null;
  /** 系统音频采集开关 (WASAPI loopback) */
  systemAudioEnabled: boolean;
  /** 系统音频收到的 chunk 计数（用于活跃指示） */
  systemAudioChunks: number;
  /** WASAPI 采集状态（每秒更新一次） */
  systemAudioStatus: {
    elapsedSecs: number;
    totalFramesRead: number;
    bufferBytes: number;
    chunksProduced: number;
    /** 本秒内 chunk 峰值最大者（0..1）；≈0 说明 loopback 没抓到声音 */
    peakMax?: number;
    /** 峰值极低的 chunk 累计（诊断用） */
    silentChunks?: number;
  } | null;

  // Actions
  openConfirm: () => void;
  closeConfirm: () => void;
  enterInterview: () => void;
  exitInterview: () => void;
  startListening: () => void;
  stopListening: () => void;
  setPhase: (phase: InterviewPhase) => void;
  setTranscript: (text: string) => void;
  appendTranscript: (chunk: string) => void;
  setCurrentQuestion: (question: string) => void;
  setCurrentAnswer: (text: string) => void;
  setLastAnswerSource: (source: QARecord['source']) => void;
  appendAnswer: (chunk: string) => void;
  finalizeQA: (source?: QARecord['source']) => void;
  clearHistory: () => void;
  setSessionId: (id: string | null) => void;
  toggleSystemAudio: () => void;
  incrementSystemAudioChunks: () => void;
  setSystemAudioStatus: (s: InterviewState['systemAudioStatus']) => void;
}

// --- Store ---

export const useInterviewStore = create<InterviewState>()((set, get) => ({
  confirmOpen: false,
  phase: 'idle',
  active: false,
  transcript: '',
  currentQuestion: '',
  currentAnswer: '',
  lastAnswerSource: 'llm',
  history: [],
  startedAt: null,
  sessionId: null,
  systemAudioEnabled: false,
  systemAudioChunks: 0,
  systemAudioStatus: null,

  openConfirm: () => set({ confirmOpen: true }),
  closeConfirm: () => set({ confirmOpen: false }),

  enterInterview: () =>
    set({
      confirmOpen: false,
      active: true,
      phase: 'standby',
      startedAt: Date.now(),
      transcript: '',
      currentQuestion: '',
      currentAnswer: '',
      sessionId: null,
    }),

  exitInterview: () =>
    set({
      active: false,
      phase: 'idle',
      transcript: '',
      currentQuestion: '',
      currentAnswer: '',
      startedAt: null,
    }),

  startListening: () =>
    set({ phase: 'listening', transcript: '', currentQuestion: '', currentAnswer: '' }),

  stopListening: () => {
    const { phase } = get();
    if (phase === 'listening') set({ phase: 'standby' });
  },

  setPhase: (phase) => set({ phase }),
  setTranscript: (text) => set({ transcript: text }),
  appendTranscript: (chunk) =>
    set((s) => {
      const text = chunk.trim();
      if (!text) return s;
      const prev = s.transcript;
      if (!prev) {
        return { transcript: text.slice(-TRANSCRIPT_MAX_LEN) };
      }
      const sep = isCjk(prev[prev.length - 1]) || isCjk(text[0]) ? '' : ' ';
      const joined = prev + sep + text;
      return {
        transcript:
          joined.length > TRANSCRIPT_MAX_LEN
            ? joined.slice(joined.length - TRANSCRIPT_MAX_LEN)
            : joined,
      };
    }),
  setCurrentQuestion: (question) => set({ currentQuestion: question }),
  setCurrentAnswer: (text) => set({ currentAnswer: text }),
  setLastAnswerSource: (lastAnswerSource) => set({ lastAnswerSource }),
  appendAnswer: (chunk) =>
    set((s) => ({ currentAnswer: s.currentAnswer + chunk })),

  finalizeQA: (source) => {
    const { currentQuestion, currentAnswer, history, lastAnswerSource } = get();
    const src = source ?? lastAnswerSource;
    if (!currentQuestion.trim() && !currentAnswer.trim()) {
      set({ phase: 'standby', transcript: '', currentAnswer: '' });
      return;
    }
    const record: QARecord = {
      id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      question: currentQuestion.trim(),
      answer: currentAnswer.trim(),
      source: src,
      timestamp: Date.now(),
    };
    set({
      history: [record, ...history],
      phase: 'standby',
      transcript: '',
      currentQuestion: '',
      currentAnswer: '',
      lastAnswerSource: 'llm',
    });
  },

  clearHistory: () => set({ history: [] }),

  setSessionId: (sessionId) => set({ sessionId }),
  toggleSystemAudio: () => set((s) => ({
    systemAudioEnabled: !s.systemAudioEnabled,
    systemAudioChunks: 0,
  })),
  incrementSystemAudioChunks: () =>
    set((s) => ({ systemAudioChunks: s.systemAudioChunks + 1 })),
  setSystemAudioStatus: (systemAudioStatus) => set({ systemAudioStatus }),
}));
