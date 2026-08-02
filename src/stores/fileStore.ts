import { create } from 'zustand';
import { bridge, FileNode, RecentProject } from '../lib/tauri-bridge';
import { showToast } from '../components/shared/Toast';
import { t } from '../lib/i18n';

export type FileChangeKind = 'created' | 'modified' | 'removed';
export type PreviewMode = 'preview' | 'source' | 'edit';

// Batch buffer for markFileChanged — collect changes within a single frame, flush once via rAF
const _pendingChanges = new Map<string, FileChangeKind>();
let _changeFlushRaf = 0;

// 报告B3: derived index — the set of directory prefixes that contain at
// least one changed file. TreeNode subscribes to `changedPrefixes.has(path)`
// (O(1) boolean) instead of scanning the whole changedFiles Map per render
// (O(M) per directory node — O(N×M) for the tree).
function dirPrefixOf(path: string): string {
  // Watcher events may arrive with either separator
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : '';
}

function computeChangedPrefixes(changed: Map<string, FileChangeKind>): Set<string> {
  const set = new Set<string>();
  for (const p of changed.keys()) {
    // 报告B3 复查: highlight the WHOLE ancestor chain, not just the direct
    // parent. A deep change (src/components/A.tsx) must light up src/ and
    // src/components too — with only the direct parent, every collapsed
    // ancestor directory showed no change marker at all.
    let prefix = dirPrefixOf(p);
    while (prefix) {
      set.add(prefix);
      prefix = dirPrefixOf(prefix);
    }
  }
  return set;
}

interface FileState {
  tree: FileNode[];
  isLoading: boolean;
  selectedFile: string | null;
  fileContent: string | null;
  isLoadingContent: boolean;
  previewMode: PreviewMode;
  rootPath: string;

  // Editing state
  editContent: string | null;     // buffer for edits (null = not dirty)
  isSaving: boolean;

  // Unsaved changes navigation guard
  pendingNavigation: string | null;
  showUnsavedDialog: boolean;

  // Project management
  recentProjects: RecentProject[];
  isLoadingProjects: boolean;

  // File change tracking
  changedFiles: Map<string, FileChangeKind>;
  /** Derived index (报告B3): directory prefixes containing ≥1 changed file */
  changedPrefixes: Set<string>;

  // Directory missing detection
  directoryMissing: boolean;

  // External drag-drop state
  isDragOverTree: boolean;

  loadTree: (path: string) => Promise<void>;
  /** Refresh the tree without clearing change markers. Optional path overrides rootPath. */
  refreshTree: (overridePath?: string) => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  clearSelection: () => void;
  closePreview: () => void;
  setPreviewMode: (mode: PreviewMode) => void;
  setEditContent: (content: string) => void;
  saveFile: () => Promise<void>;
  discardEdits: () => void;
  setRootPath: (path: string) => void;
  fetchRecentProjects: () => Promise<void>;
  /** Reload the currently previewed file content without toggling selection */
  reloadContent: () => Promise<void>;
  markFileChanged: (path: string, kind: FileChangeKind) => void;
  clearChangedFiles: () => void;
  // Unsaved changes actions
  confirmDiscard: () => void;
  confirmSaveAndSwitch: () => Promise<void>;
  cancelNavigation: () => void;
  // New file/folder actions
  createFile: (parentDir: string, name: string) => Promise<void>;
  createFolder: (parentDir: string, name: string) => Promise<void>;
  // External drag state
  setDragOverTree: (v: boolean) => void;
}

export const useFileStore = create<FileState>()((set, get) => ({
  tree: [],
  isLoading: false,
  selectedFile: null,
  fileContent: null,
  isLoadingContent: false,
  previewMode: 'preview' as PreviewMode,
  rootPath: '',
  editContent: null,
  isSaving: false,
  pendingNavigation: null,
  showUnsavedDialog: false,
  recentProjects: [],
  isLoadingProjects: false,
  changedFiles: new Map(),
  changedPrefixes: new Set(),
  directoryMissing: false,
  isDragOverTree: false,

  loadTree: async (path: string) => {
    if (!path) return;
    const prevRoot = get().rootPath;
    const isNewDir = path !== prevRoot;
    // Always show loading on first load or directory change
    set({
      rootPath: path,
      isLoading: true,
      // Clear stale tree immediately when switching directories
      ...(isNewDir ? { tree: [] } : {}),
    });
    try {
      const tree = await bridge.readFileTree(path, 8);
      // Guard: only apply if rootPath hasn't changed during async load
      if (get().rootPath === path) {
        set({ tree, isLoading: false, changedFiles: new Map(), changedPrefixes: new Set(), directoryMissing: false });
      }
    } catch (err) {
      if (get().rootPath === path) {
        const missing = String(err).includes('does not exist');
        set({ isLoading: false, directoryMissing: missing });
      }
    }
  },

  refreshTree: async (overridePath?: string) => {
    const dir = overridePath || get().rootPath;
    if (!dir) return;
    try {
      const tree = await bridge.readFileTree(dir, 8);
      // B1: async race guard — a stale refresh issued for a previous
      // directory must not clobber the tree of the currently selected one
      // (e.g. project switch while a watcher-triggered refresh is in flight).
      if (get().rootPath !== dir) return;
      // Sync rootPath if override was used and differs
      if (overridePath && overridePath !== get().rootPath) {
        set({ tree, rootPath: overridePath });
      } else {
        set({ tree });
      }
    } catch (err) {
      if (get().rootPath === dir && String(err).includes('does not exist')) {
        set({ directoryMissing: true, tree: [] });
      }
    }
  },

  selectFile: async (path: string) => {
    const { selectedFile, editContent, fileContent } = get();
    const isDirty = editContent !== null && editContent !== fileContent;

    // If dirty and trying to navigate to a different file, show dialog
    if (isDirty && path !== selectedFile) {
      set({ pendingNavigation: path, showUnsavedDialog: true });
      return;
    }

    // Toggle selection: click again to deselect
    if (selectedFile === path) {
      set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null });
    } else {
      set({ selectedFile: path, fileContent: null, isLoadingContent: true, previewMode: 'preview', editContent: null });

      // Binary-preview files: skip text reading, render with file:// URL in FilePreview
      const ext = path.split('.').pop()?.toLowerCase() || '';
      const BINARY_PREVIEW = new Set([
        'png','jpg','jpeg','gif','webp','bmp','ico',
        'pdf','mp4','webm','mov','avi',
        'mp3','wav','ogg','aac','m4a',
      ]);

      if (BINARY_PREVIEW.has(ext)) {
        // Load binary files as base64 data URL for rendering in webview
        try {
          const dataUrl = await bridge.readFileBase64(path);
          if (get().selectedFile === path) {
            set({ fileContent: dataUrl, isLoadingContent: false });
          }
        } catch {
          if (get().selectedFile === path) {
            set({ fileContent: null, isLoadingContent: false });
          }
        }
      } else {
        try {
          const content = await bridge.readFileContent(path);
          // Only update if selectedFile hasn't changed during the async call
          if (get().selectedFile === path) {
            set({ fileContent: content, isLoadingContent: false });
          }
        } catch {
          if (get().selectedFile === path) {
            set({ fileContent: '// Error loading file', isLoadingContent: false });
          }
        }
      }
    }
  },

  clearSelection: () => set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null }),

  closePreview: () => set({ selectedFile: null, fileContent: null, isLoadingContent: false, editContent: null }),

  setPreviewMode: (mode: PreviewMode) => {
    const state = get();
    if (mode === 'edit') {
      // Entering edit mode: initialize editContent from fileContent
      set({ previewMode: mode, editContent: state.fileContent });
    } else {
      set({ previewMode: mode });
    }
  },

  setEditContent: (content: string) => set({ editContent: content }),

  saveFile: async () => {
    const { selectedFile, editContent } = get();
    if (!selectedFile || editContent === null) return;
    set({ isSaving: true });
    try {
      await bridge.writeFileContent(selectedFile, editContent);
      // Update fileContent to match saved content
      set({ fileContent: editContent, editContent: null, isSaving: false, previewMode: 'preview' });
    } catch {
      set({ isSaving: false });
    }
  },

  discardEdits: () => {
    set({ editContent: null, previewMode: 'preview' });
  },

  setRootPath: (path: string) => set({ rootPath: path }),

  fetchRecentProjects: async () => {
    set({ isLoadingProjects: true });
    try {
      const projects = await bridge.listRecentProjects();
      set({ recentProjects: projects, isLoadingProjects: false });
    } catch {
      set({ isLoadingProjects: false });
    }
  },

  reloadContent: async () => {
    const path = get().selectedFile;
    if (!path) return;
    // Don't reload while user is editing
    if (get().editContent !== null) return;
    try {
      const ext = path.split('.').pop()?.toLowerCase() || '';
      const BINARY_PREVIEW = new Set([
        'png','jpg','jpeg','gif','webp','bmp','ico',
        'pdf','mp4','webm','mov','avi',
        'mp3','wav','ogg','aac','m4a',
      ]);
      if (BINARY_PREVIEW.has(ext)) {
        const dataUrl = await bridge.readFileBase64(path);
        if (get().selectedFile === path) set({ fileContent: dataUrl });
      } else {
        const content = await bridge.readFileContent(path);
        if (get().selectedFile === path) set({ fileContent: content });
      }
      // A8: reload syncs the preview with disk — clear the stale 'modified'
      // marker so the FilePreview auto-reload effect stops re-firing on every
      // unrelated changedFiles update (and the file stops showing a phantom
      // "changed" badge). 'deleted'/'created' are kept: reload can't fix those.
      const changed = get().changedFiles;
      if (changed.get(path) === 'modified') {
        const next = new Map(changed);
        next.delete(path);
        set({ changedFiles: next, changedPrefixes: computeChangedPrefixes(next) });
      }
    } catch {
      // Silently fail — keep existing content
    }
  },

  markFileChanged: (path: string, kind: FileChangeKind) => {
    _pendingChanges.set(path, kind);
    if (!_changeFlushRaf) {
      _changeFlushRaf = requestAnimationFrame(() => {
        _changeFlushRaf = 0;
        if (_pendingChanges.size === 0) return;
        const next = new Map(get().changedFiles);
        for (const [p, k] of _pendingChanges) {
          next.set(p, k);
        }
        _pendingChanges.clear();
        set({ changedFiles: next, changedPrefixes: computeChangedPrefixes(next) });
      });
    }
  },

  clearChangedFiles: () => set({ changedFiles: new Map(), changedPrefixes: new Set() }),

  // --- Unsaved changes dialog actions ---

  confirmDiscard: () => {
    const pending = get().pendingNavigation;
    set({ editContent: null, showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending);
  },

  confirmSaveAndSwitch: async () => {
    const pending = get().pendingNavigation;
    await get().saveFile();
    set({ showUnsavedDialog: false, pendingNavigation: null });
    if (pending) get().selectFile(pending);
  },

  cancelNavigation: () => {
    set({ pendingNavigation: null, showUnsavedDialog: false });
  },

  // --- New file/folder actions ---

  createFile: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.writeFileContent(path, '');
      await get().refreshTree();
      get().selectFile(path);
    } catch (e) {
      // B4: silent failure — the file simply never appears.
      console.error('Failed to create file:', e);
      showToast(t('files.createFailed'), 'error');
    }
  },

  createFolder: async (parentDir: string, name: string) => {
    const path = `${parentDir}/${name}`;
    try {
      await bridge.createDirectory(path);
      await get().refreshTree();
    } catch (e) {
      // B4: silent failure — the folder simply never appears.
      console.error('Failed to create folder:', e);
      showToast(t('files.createFailed'), 'error');
    }
  },

  // --- External drag state ---

  setDragOverTree: (v: boolean) => set({ isDragOverTree: v }),
}));
