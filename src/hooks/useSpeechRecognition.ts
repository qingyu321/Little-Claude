import { useState, useRef, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';

// --- Types ---

export type SpeechPhase =
  | 'idle'
  | 'listening'
  | 'confirming'   // raw transcription shown, [取消] [确定]
  | 'editing';     // editable textarea for correction, [取消] [确认输入]

export interface SpeechRecognitionResult {
  /** Whether the browser/OS supports speech recognition at all. */
  isSupported: boolean;
  /** Current phase in the two-stage flow. */
  phase: SpeechPhase;
  /** Live interim text (updates continuously while listening). */
  interimText: string;
  /** Final transcribed text (populated after stopping). */
  finalText: string;
  /** Text being edited in the correction phase. */
  editText: string;
  /** Start listening (triggers browser mic permission). */
  startListening: () => void;
  /** Stop listening and move to confirmation phase. */
  stopListening: () => void;
  /** Cancel current recording / discard all and return to idle. */
  cancel: () => void;
  /** Confirm raw transcription → move to editing phase. */
  confirm: () => void;
  /** Final confirm after editing → caller reads editText and resets. */
  confirmInput: () => void;
  /** Set edit text during correction phase. */
  setEditText: (text: string) => void;
}

// --- Browser Speech Recognition wrapper ---

interface BrowserSpeech {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionError) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: {
    isFinal: boolean;
    [index: number]: { transcript: string; confidence: number };
  };
}

interface SpeechRecognitionError {
  error: string;
  message: string;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => BrowserSpeech;
    webkitSpeechRecognition?: new () => BrowserSpeech;
  }
}

function createBrowserRecognition(lang: string): BrowserSpeech | null {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = lang;
  return rec;
}

// --- Hook ---

export function useSpeechRecognition(): SpeechRecognitionResult {
  const speechLanguage = useSettingsStore((s) => s.speechLanguage);

  const [phase, setPhase] = useState<SpeechPhase>('idle');
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [editText, setEditText] = useState('');
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef<BrowserSpeech | null>(null);
  const finalBufferRef = useRef('');

  // Check support on mount
  useEffect(() => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    setIsSupported(Boolean(Ctor));
  }, []);

  // Build recognition instance
  const getRecognition = useCallback(() => {
    if (!recognitionRef.current) {
      recognitionRef.current = createBrowserRecognition(speechLanguage);
    }
    return recognitionRef.current;
  }, [speechLanguage]);

  // Teardown any running recognition when language changes
  useEffect(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    if (phase === 'listening') {
      setPhase('idle');
      setInterimText('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechLanguage]);

  // Unmount cleanup: abort an in-flight recognition so the microphone is
  // released and no callbacks fire into an unmounted component.
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try { rec.abort(); } catch { /* ignore */ }
        recognitionRef.current = null;
      }
      finalBufferRef.current = '';
    };
  }, []);

  const startListening = useCallback(() => {
    const rec = getRecognition();
    if (!rec) return;

    finalBufferRef.current = '';
    setInterimText('');
    setFinalText('');
    setEditText('');
    setPhase('listening');

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalBufferRef.current += result[0]?.transcript ?? '';
        } else {
          interim += result[0]?.transcript ?? '';
        }
      }
      setInterimText(interim);
      setFinalText(finalBufferRef.current);
    };

    rec.onerror = (event: SpeechRecognitionError) => {
      // 'no-speech' and 'aborted' are benign — don't reset on them
      if (event.error === 'no-speech') {
        setPhase('idle');
        setInterimText('未检测到语音，请重试');
      } else if (event.error !== 'aborted') {
        setPhase('idle');
        setInterimText('语音识别出错');
      }
    };

    rec.onend = () => {
      // Only auto-transition if still listening (not programmatic stop)
      setPhase((prev) => {
        if (prev === 'listening') {
          // Combine any remaining interim text
          const final = finalBufferRef.current + (finalBufferRef.current ? '' : '');
          return final.length > 0 ? 'confirming' : 'idle';
        }
        return prev;
      });
    };

    try {
      rec.start();
    } catch {
      // Already started or permission denied
    }
  }, [getRecognition]);

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
      rec.onend = null; // prevent double-trigger
    }
    // Use the accumulated final text
    const combined = finalBufferRef.current || interimText;
    setFinalText(combined);
    setPhase(combined.length > 0 ? 'confirming' : 'idle');
  }, [interimText]);

  const cancel = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.abort(); } catch { /* ignore */ }
      rec.onend = null;
    }
    finalBufferRef.current = '';
    setInterimText('');
    setFinalText('');
    setEditText('');
    setPhase('idle');
  }, []);

  const confirm = useCallback(() => {
    const text = finalText || interimText;
    setEditText(text);
    setPhase('editing');
  }, [finalText, interimText]);

  const confirmInput = useCallback(() => {
    // editText is already set — caller will read it
    setPhase('idle');
    setInterimText('');
    setFinalText('');
  }, []);

  return {
    isSupported,
    phase,
    interimText,
    finalText,
    editText,
    startListening,
    stopListening,
    cancel,
    confirm,
    confirmInput,
    setEditText,
  };
}
