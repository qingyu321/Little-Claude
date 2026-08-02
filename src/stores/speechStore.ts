import { create } from 'zustand';

// --- Types ---

export interface RuntimeDepCheck {
  label: string;
  ready: boolean;
  detail?: string;
}

export type SpeechRuntimeStatus = 'idle' | 'checking' | 'ready' | 'missing';
export type SpeechInstallPhase = 'idle' | 'installing' | 'done' | 'error';

export interface SpeechProgress {
  percent: number;
  message: string;
  downloaded?: number;
  total?: number;
}

export interface SpeechRuntimeState {
  /** Overall runtime status. */
  status: SpeechRuntimeStatus;
  /** Per-component dependency checks. */
  checks: RuntimeDepCheck[];
  /** Whether auto-install (one-click download) is supported on this platform. */
  autoInstallSupported: boolean;
  /** Whether an install/download is in progress. */
  installing: boolean;
  /** Current install phase. */
  installPhase: SpeechInstallPhase;
  /** Download progress (percent + message). */
  progress: SpeechProgress | null;
  /** Last error message, if any. */
  error: string | null;
  /** Detected device backend for offline speech model (e.g. cuda, cpu). */
  deviceBackend: string;
  /** Human-readable device backend label. */
  deviceBackendLabel: string;

  // Actions
  setStatus: (s: SpeechRuntimeStatus) => void;
  setChecks: (c: RuntimeDepCheck[]) => void;
  setAutoInstallSupported: (v: boolean) => void;
  setInstalling: (v: boolean) => void;
  setInstallPhase: (p: SpeechInstallPhase) => void;
  setProgress: (p: SpeechProgress | null) => void;
  setError: (e: string | null) => void;
  setDeviceBackend: (backend: string, label: string) => void;
}

// --- Store ---

export const useSpeechStore = create<SpeechRuntimeState>()((set) => ({
  status: 'idle',
  checks: [],
  autoInstallSupported: false,
  installing: false,
  installPhase: 'idle',
  progress: null,
  error: null,
  deviceBackend: 'cpu',
  deviceBackendLabel: 'CPU',

  setStatus: (status) => set({ status }),
  setChecks: (checks) => set({ checks }),
  setAutoInstallSupported: (autoInstallSupported) => set({ autoInstallSupported }),
  setInstalling: (installing) => set({ installing }),
  setInstallPhase: (installPhase) => set({ installPhase }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  setDeviceBackend: (deviceBackend, deviceBackendLabel) =>
    set({ deviceBackend, deviceBackendLabel }),
}));
