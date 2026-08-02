import { create } from 'zustand';

/** Per-component check result for a single runtime dependency. */
export interface RuntimeDepCheck {
  name: string;
  label: string;
  ready: boolean;
  detail?: string; // e.g. version or path
}

export interface RuntimeProgress {
  percent: number;
  message: string;
  downloaded?: number;
  total?: number;
}

export type RuntimeInstallPhase = 'idle' | 'confirming' | 'installing' | 'done' | 'error';

export interface VideoAnalysisRuntimeState {
  /** Full runtime status: body-only, need-download, ready, installing. */
  status: 'body-only' | 'need-download' | 'ready' | 'installing' | 'unknown';
  /** List of dependency checks (ffmpeg, ffprobe, whisper, python, pip pkgs). */
  checks: RuntimeDepCheck[];
  /** Whether the runtime prompt has been dismissed in SkillsPanel. */
  dismissed: boolean;
  /** Current install phase for UI. */
  installPhase: RuntimeInstallPhase;
  /** Download progress. */
  progress: RuntimeProgress | null;
  /** Error message when install or check fails. */
  error: string | null;
  /** Whether auto-install is supported on the current platform. */
  autoInstallSupported: boolean;
  /** Timestamp of last check (for polling cooldown). */
  lastCheckAt: number;
  /** Guard: set while any install is in-flight. */
  installing: boolean;
  /** Detected compute device: "cuda", "amd-gpu", "apple-silicon", "cpu". */
  deviceBackend: string;
  /** Human-readable device label. */
  deviceBackendLabel: string;

  setStatus: (status: VideoAnalysisRuntimeState['status']) => void;
  setChecks: (checks: RuntimeDepCheck[]) => void;
  setDismissed: (dismissed: boolean) => void;
  setInstallPhase: (phase: RuntimeInstallPhase) => void;
  setProgress: (progress: RuntimeProgress | null) => void;
  setError: (error: string | null) => void;
  setAutoInstallSupported: (supported: boolean) => void;
  setInstalling: (installing: boolean) => void;
  setDeviceBackend: (backend: string, label: string) => void;
  /** Reset to initial state. */
  reset: () => void;
}

const INITIAL: Pick<
  VideoAnalysisRuntimeState,
  | 'status'
  | 'checks'
  | 'dismissed'
  | 'installPhase'
  | 'progress'
  | 'error'
  | 'autoInstallSupported'
  | 'lastCheckAt'
  | 'installing'
  | 'deviceBackend'
  | 'deviceBackendLabel'
> = {
  status: 'unknown',
  checks: [],
  dismissed: false,
  installPhase: 'idle',
  progress: null,
  error: null,
  autoInstallSupported: false,
  lastCheckAt: 0,
  installing: false,
  deviceBackend: '',
  deviceBackendLabel: '',
};

export const useVideoAnalysisRuntimeStore = create<VideoAnalysisRuntimeState>()(
  (set) => ({
    ...INITIAL,

    setStatus: (status) => set({ status }),
    setChecks: (checks) => set({ checks, lastCheckAt: Date.now() }),
    setDismissed: (dismissed) => set({ dismissed }),
    setInstallPhase: (installPhase) => set({ installPhase }),
    setProgress: (progress) => set({ progress }),
    setError: (error) => set({ error }),
    setAutoInstallSupported: (autoInstallSupported) => set({ autoInstallSupported }),
    setInstalling: (installing) => set({ installing }),
    setDeviceBackend: (deviceBackend, deviceBackendLabel) => set({ deviceBackend, deviceBackendLabel }),
    reset: () => set({ ...INITIAL }),
  }),
);
