import { useState, useCallback, useEffect, useRef } from 'react';
import { bridge } from '../lib/tauri-bridge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTreeDragActive } from '../lib/drag-state';
import { useSettingsStore } from '../stores/settingsStore';
import { useFileStore } from '../stores/fileStore';
import { showToast } from '../components/shared/Toast';
import { t } from '../lib/i18n';
import { friendlyError } from '../lib/error-format';

// A9: attachments over this size are rejected with a toast — the CLI reads
// these files over stdin-free IPC, and multi-hundred-MB copies thrash disk
// and memory for no practical gain. Mirrors the Rust save_temp_file cap.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// --- Types ---

export interface FileAttachment {
  id: string;
  name: string;
  path: string;       // Temp path after saving via Rust
  size: number;
  type: string;
  isImage: boolean;
  preview?: string;   // Base64 data URL for image thumbnails (DEPRECATED: use getThumbnail)
}

// A8: Module-level thumbnail cache — avoids storing base64 data URLs in Zustand
// state (reduces GC heap pressure, state snapshot size, and DevTools overhead).
// LRU-bounded (THUMBNAIL_CACHE_MAX entries): Map iteration order = insertion
// order, so a read re-inserts the entry (delete + set) to move it to the tail,
// and an insert past the bound evicts the head (least recently used). Without
// a bound the map would grow without limit across drag-drops and sessions.
const THUMBNAIL_CACHE_MAX = 50;
const _thumbnailCache = new Map<string, string>();

function cacheThumbnail(path: string, thumb: string) {
  _thumbnailCache.delete(path); // re-insert → moves to tail (most recently used)
  _thumbnailCache.set(path, thumb);
  if (_thumbnailCache.size > THUMBNAIL_CACHE_MAX) {
    // Map preserves insertion order: the first key is the least recently used.
    const oldest = _thumbnailCache.keys().next().value;
    if (oldest !== undefined) _thumbnailCache.delete(oldest);
  }
}

/** Retrieve a cached thumbnail by file path. Returns undefined if not cached. */
export function getCachedThumbnail(path: string): string | undefined {
  const thumb = _thumbnailCache.get(path);
  if (thumb !== undefined) {
    // LRU touch: re-insert so frequently used entries survive eviction.
    _thumbnailCache.delete(path);
    _thumbnailCache.set(path, thumb);
  }
  return thumb;
}

// --- Helper ---

let fileCounter = 0;
function generateFileId(): string {
  fileCounter += 1;
  return `file_${Date.now()}_${fileCounter}`;
}

function isImageMime(type: string): boolean {
  return type.startsWith('image/');
}

/** Guess MIME type from file extension */
function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', js: 'text/javascript', ts: 'text/typescript',
    html: 'text/html', css: 'text/css', csv: 'text/csv',
    zip: 'application/zip', gz: 'application/gzip',
  };
  return map[ext] || 'application/octet-stream';
}

/** Check if a file extension is an image type */
function isImageExt(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

/** Generate a small base64 thumbnail for an image file */
async function generateThumbnail(file: File): Promise<string | undefined> {
  if (!isImageMime(file.type)) return undefined;

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 64;
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        } else {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = reader.result as string;
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/** Read a File as a Uint8Array */
async function readFileAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// --- Hook ---

export function useFileAttachments() {
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    setIsProcessing(true);
    try {
      const newFiles: FileAttachment[] = [];
      const fileArray = Array.from(fileList);

      for (const file of fileArray) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          showToast(t('files.attachmentTooLarge'), 'error');
          continue;
        }
        try {
          // Generate thumbnail for images
          const preview = await generateThumbnail(file);

          // Read file bytes and save via Rust (into working directory for CLI access)
          const bytes = await readFileAsBytes(file);
          const cwd = useSettingsStore.getState().workingDirectory;
          const tempPath = await bridge.saveTempFile(
            file.name,
            Array.from(bytes),
            cwd || undefined,
          );

          newFiles.push({
            id: generateFileId(),
            name: file.name,
            path: tempPath,
            size: file.size,
            type: file.type || 'application/octet-stream',
            isImage: isImageMime(file.type),
            preview,
          });
        } catch (err) {
          console.error('Failed to add file:', file.name, err);
          // L5: 附件读取失败不能只写 console —— toast 告知用户
          showToast(
            `${file.name}: ${friendlyError(String(err))}`,
            'error',
          );
        }
      }

      if (newFiles.length > 0) {
        setFiles((prev) => [...prev, ...newFiles]);
      }
    } finally {
      setIsProcessing(false);
    }
  }, []);

  /** Add files by their OS file paths (for Tauri native drag-drop) */
  const addFilePaths = useCallback(async (paths: string[]) => {
    setIsProcessing(true);
    try {
      const newFiles: FileAttachment[] = [];
      for (const filePath of paths) {
        try {
          const name = filePath.split(/[\\/]/).pop() || filePath;
          const mime = guessMime(name);
          const isImg = isImageExt(name);

          // The file is already on disk — just use its path directly
          // Get file size from Rust backend
          let fileSize = 0;
          try {
            fileSize = await bridge.getFileSize(filePath);
          } catch {
            // Ignore — size will show as 0
          }
          if (fileSize > MAX_ATTACHMENT_BYTES) {
            showToast(t('files.attachmentTooLarge'), 'error');
            continue;
          }

          // A8: Generate thumbnail and cache at module level, store only path ref in state.
          // This keeps large base64 strings out of Zustand state, reducing GC pressure.
          if (isImg) {
            try {
              const b64 = await bridge.readFileBase64(filePath);
              const dataUrl = `data:${mime};base64,${b64}`;
              const thumb = await new Promise<string | undefined>((resolve) => {
                const img = new Image();
                img.onload = () => {
                  const canvas = document.createElement('canvas');
                  const maxSize = 64;
                  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                  canvas.width = img.width * scale;
                  canvas.height = img.height * scale;
                  const ctx = canvas.getContext('2d');
                  if (ctx) {
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', 0.7));
                  } else {
                    resolve(undefined);
                  }
                };
                img.onerror = () => resolve(undefined);
                img.src = dataUrl;
              });
              if (thumb) cacheThumbnail(filePath, thumb);
            } catch {
              // Ignore — no thumbnail, still functional
            }
          }

          newFiles.push({
            id: generateFileId(),
            name,
            path: filePath,
            size: fileSize,
            type: mime,
            isImage: isImg,
            // A8: Don't store base64 in state — use getCachedThumbnail(path) at render time
          });
        } catch (err) {
          console.error('Failed to add dropped file:', filePath, err);
        }
      }
      if (newFiles.length > 0) {
        setFiles((prev) => [...prev, ...newFiles]);
      }
    } finally {
      setIsProcessing(false);
    }
  }, []);

  // Listen for Tauri native drag-drop events (OS file drag into window)
  // Debounce guard: Tauri may fire onDragDropEvent multiple times per drop
  const lastDropRef = useRef<{ time: number; key: string }>({ time: 0, key: '' });

  useEffect(() => {
    // B3b: onDragDropEvent resolves asynchronously; the cleanup must not miss
    // the unlisten. Keep it in a ref; if the component already unmounted when
    // registration resolves, release the listener immediately.
    const unlistenRef: { current: (() => void) | null } = { current: null };
    let unmounted = false;

    getCurrentWindow().onDragDropEvent((event) => {
      const { type } = event.payload;

      if (type === 'over' || type === 'enter') {
        // Skip internal tree drags
        if (isTreeDragActive()) return;
        // Check if pointer is over the file tree area
        const pos = (event.payload as any).position;
        if (pos) {
          const el = document.elementFromPoint(pos.x, pos.y);
          const overTree = !!el?.closest('[data-file-tree]');
          useFileStore.getState().setDragOverTree(overTree);
        }
        return;
      }

      if (type === 'leave') {
        useFileStore.getState().setDragOverTree(false);
        return;
      }

      if (type === 'drop') {
        const wasOverTree = useFileStore.getState().isDragOverTree;
        useFileStore.getState().setDragOverTree(false);

        // Skip if this is an internal file tree drag
        if (isTreeDragActive()) return;
        const paths = (event.payload as any).paths as string[] | undefined;
        if (!paths || paths.length === 0) return;

        // Deduplicate: skip if same paths within 500ms
        const now = Date.now();
        const key = [...paths].sort().join('|');
        if (now - lastDropRef.current.time < 500 && key === lastDropRef.current.key) return;
        lastDropRef.current = { time: now, key };

        if (wasOverTree) {
          // Drop onto file tree → copy files into project
          const rootPath = useSettingsStore.getState().workingDirectory
            || useFileStore.getState().rootPath;
          if (rootPath) {
            (async () => {
              for (const srcPath of paths) {
                const name = srcPath.split(/[\\/]/).pop() || srcPath;
                const dest = `${rootPath}/${name}`;
                try {
                  await bridge.copyFile(srcPath, dest);
                } catch (err) {
                  console.error('Failed to copy file to project:', name, err);
                }
              }
              useFileStore.getState().refreshTree(rootPath);
            })();
          }
        } else {
          // Split: images → file attachments (with preview), non-images → inline chips.
          // This ensures images show as visual thumbnails in FileUploadChips and
          // their paths are properly included in the message sent to CLI (#70).
          const imagePaths: string[] = [];
          const otherPaths: string[] = [];
          for (const p of paths) {
            const name = p.split(/[\\/]/).pop() || '';
            if (isImageExt(name)) {
              imagePaths.push(p);
            } else {
              otherPaths.push(p);
            }
          }

          // Images → attachment system (addFilePaths generates thumbnails)
          if (imagePaths.length > 0) {
            addFilePaths(imagePaths);
          }

          // Non-images → inline file chips
          for (const p of otherPaths) {
            window.dispatchEvent(new CustomEvent('little-claude:tree-file-inline', { detail: p }));
          }
        }
      }
    }).then((fn) => {
      if (unmounted) {
        fn(); // unmounted while registering — release immediately
      } else {
        unlistenRef.current = fn;
      }
    });

    return () => {
      unmounted = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
  }, []);

  return { files, setFiles, isProcessing, addFiles, addFilePaths, removeFile, clearFiles };
}
