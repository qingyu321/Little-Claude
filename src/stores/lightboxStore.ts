import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';

/** B3c: monotonically increasing token for openFile/open/close races. */
let _openFileSeq = 0;

/* ================================================================
   Lightbox store — global state for the image lightbox overlay.
   Split out of ImageLightbox.tsx (perf): MessageBubble /
   MarkdownRenderer only need the store — importing it from the
   component module dragged the whole lightbox component (and its
   chunk) into the streaming hot path.
   ================================================================ */

interface LightboxState {
  isOpen: boolean;
  /** Data URL or file path to display */
  imageSrc: string | null;
  /** Original file path (for "open externally" action) */
  filePath: string | null;
  /** Optional alt text */
  alt: string;

  open: (src: string, filePath?: string, alt?: string) => void;
  /** Open by loading a file from disk via Rust base64 */
  openFile: (path: string, alt?: string) => void;
  close: () => void;
}

export const useLightboxStore = create<LightboxState>()((set) => ({
  isOpen: false,
  imageSrc: null,
  filePath: null,
  alt: '',

  open: (src, filePath, alt) => {
    // B3c: a plain open() supersedes any in-flight openFile read.
    _openFileSeq++;
    set({ isOpen: true, imageSrc: src, filePath: filePath || null, alt: alt || '' });
  },

  openFile: async (path, alt) => {
    set({ isOpen: true, imageSrc: null, filePath: path, alt: alt || '' });
    // B3c: rapid open A→B or close-while-loading must not let a stale slow
    // read overwrite the newer state. Track a request sequence.
    const seq = ++_openFileSeq;
    try {
      const dataUrl = await bridge.readFileBase64(path);
      if (seq !== _openFileSeq) return; // superseded by a newer open/close
      set({ imageSrc: dataUrl });
    } catch {
      if (seq !== _openFileSeq) return;
      set({ isOpen: false, imageSrc: null });
    }
  },

  close: () => {
    // B3c: closing supersedes any in-flight openFile read.
    _openFileSeq++;
    set({ isOpen: false, imageSrc: null, filePath: null, alt: '' });
  },
}));
