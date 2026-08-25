// F16: memo 用于 TreeNode，阻断无关重渲
import { useState, useCallback, useMemo, useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { FileNode } from '../../lib/tauri-bridge';
import { useFileStore, FileChangeKind } from '../../stores/fileStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { bridge } from '../../lib/tauri-bridge';
import { isMac } from '../../lib/platform';
import { useT } from '../../lib/i18n';
import { startTreeDrag, moveTreeDrag, endTreeDrag } from '../../lib/drag-state';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { FileIcon } from '../shared/FileIcon';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';

function getChangeBadge(kind: FileChangeKind | undefined) {
  if (!kind) return null;
  const colors = {
    created: 'bg-success',
    modified: 'bg-success',
    removed: 'bg-error',
  };
  const labels = { created: 'A', modified: 'M', removed: 'D' };
  return (
    <span className={`ml-auto flex-shrink-0 w-4 h-4 rounded text-[9px]
      font-bold text-text-inverse flex items-center justify-center ${colors[kind]}`}>
      {labels[kind]}
    </span>
  );
}

// --- Context Menu ---
interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

interface ContextMenuCallbacks {
  onCopyPath: (path: string) => void;
  onCopyFile: (path: string) => void;
  onPaste: (targetDir: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string, isDir: boolean) => void;
  onInsertToChat: (path: string) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  clipboardPath: string | null;
}

type MenuItem = { label: string; icon: React.ReactNode; action: () => void; danger?: boolean } | 'separator';

function ContextMenu({ menu, onClose, callbacks }: {
  menu: ContextMenuState;
  onClose: () => void;
  callbacks: ContextMenuCallbacks;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = menu.x;
    let y = menu.y;
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setPos({ x, y });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const items: MenuItem[] = [
    ...(menu.isDir ? [
      {
        label: t('files.newFile'),
        icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M9 2H4v12h8V5l-3-3z" /><path d="M8 7v4M6 9h4" /></svg>,
        action: () => { callbacks.onNewFile(menu.path); onClose(); },
      },
      {
        label: t('files.newFolder'),
        icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 4h4l2 2h6v7H2V4z" /><path d="M7 8v3M5.5 9.5h3" /></svg>,
        action: () => { callbacks.onNewFolder(menu.path); onClose(); },
      },
      'separator' as const,
    ] as MenuItem[] : []),
    ...(!menu.isDir ? [{
      label: t('files.insertToChat'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 14l4-2 8-8-2-2-8 8-2 4z" /><path d="M10 4l2 2" /></svg>,
      action: () => { callbacks.onInsertToChat(menu.path); onClose(); },
    }] as MenuItem[] : []),
    {
      label: t('files.copyPath'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M5 2H2v12h8v-3" /><path d="M6 6h8v8H6V6z" /></svg>,
      action: () => { callbacks.onCopyPath(menu.path); onClose(); },
    },
    ...(!menu.isDir ? [{
      label: t('files.copyFile'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M5 11H3.5A1.5 1.5 0 012 9.5v-6A1.5 1.5 0 013.5 2h6A1.5 1.5 0 0111 3.5V5" /></svg>,
      action: () => { callbacks.onCopyFile(menu.path); onClose(); },
    }] as MenuItem[] : []),
    ...(menu.isDir && callbacks.clipboardPath ? [{
      label: t('files.paste'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M10 2H6a1 1 0 00-1 1v1H3a1 1 0 00-1 1v8a1 1 0 001 1h10a1 1 0 001-1V5a1 1 0 00-1-1h-2V3a1 1 0 00-1-1z" /></svg>,
      action: () => { callbacks.onPaste(menu.path); onClose(); },
    }] as MenuItem[] : []),
    'separator',
    {
      label: t('files.rename'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M11 2l3 3-9 9H2v-3l9-9z" /></svg>,
      action: () => { callbacks.onRename(menu.path); onClose(); },
    },
    {
      label: t('files.delete'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 4h10M6 4V2h4v2M5 4v9h6V4" /></svg>,
      action: () => { callbacks.onDelete(menu.path, menu.isDir); onClose(); },
      danger: true,
    },
    'separator',
    {
      label: t('files.revealInFinder'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 4h4l2 2h6v7H2V4z" /></svg>,
      action: () => { bridge.revealInFinder(menu.path); onClose(); },
    },
    {
      label: t('files.openDefault'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M12 9v4H4V5h4" /><path d="M8 8l6-6M10 2h4v4" /></svg>,
      action: () => { bridge.openWithDefaultApp(menu.path).catch((e) => console.warn('[files] open default failed:', e)); onClose(); },
    },
    ...(isMac() ? [
      {
        label: t('files.share'),
        icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 2v8" /><path d="M5 5l3-3 3 3" /><path d="M3 9v4h10V9" /></svg>,
        action: () => { bridge.shareFile(menu.path); onClose(); },
      },
    ] : []),
    {
      label: t('files.shareToWechat'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6.5 4C4 4 2 5.8 2 8c0 1.2.6 2.2 1.6 2.9L3.2 13l2-1.2c.4.1.8.2 1.3.2 2.5 0 4.5-1.8 4.5-4S9 4 6.5 4z" /><path d="M10 7.5c-1.8 0-3.3 1.3-3.3 2.9 0 1.6 1.5 2.9 3.3 2.9.3 0 .7-.1 1-.1L12.5 14l-.3-1.5c.7-.5 1.1-1.3 1.1-2.1 0-1.6-1.5-2.9-3.3-2.9z" /></svg>,
      action: () => {
        const filePath = menu.path;
        onClose();
        // Delay IPC to let menu close + main thread settle before presenting share UI
        setTimeout(() => {
          bridge.shareToWechat(filePath)
            .then(() => {
              if (!isMac()) showToast(t('files.shareToWechatSuccess'), 'success');
            })
            .catch(() => showToast(t('files.shareToWechatFailed'), 'error'));
        }, 100);
      },
    },
    {
      label: t('files.openVscodeShort'),
      icon: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 3l8 5-8 5V3z" /></svg>,
      action: () => { bridge.openInVscode(menu.path); onClose(); },
    },
  ];

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[200px] py-1 rounded-xl border border-border-subtle
        bg-bg-card shadow-lg animate-fade-in whitespace-nowrap"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="my-1 border-t border-border-subtle" />
        ) : (
          <button
            key={i}
            onClick={item.action}
            className={`w-full flex items-center gap-2 px-3 py-2 text-[13px]
              hover:bg-bg-secondary transition-smooth text-left cursor-pointer
              ${item.danger ? 'text-error hover:bg-error/10' : 'text-text-primary'}`}
          >
            <span className={`flex-shrink-0 ${item.danger ? 'text-error/60' : 'text-text-tertiary'}`}>
              {item.icon}
            </span>
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// --- Search Result Item (flat list) ---
interface FlatMatch {
  node: FileNode;
  /** Relative directory path for context, e.g. "src/components" */
  relDir: string;
}

// F14: limit 参数——达到上限即停止遍历（调用方显示"精确关键词"提示）
function collectMatches(nodes: FileNode[], query: string, rootPrefix: string, limit = Infinity): FlatMatch[] {
  const results: FlatMatch[] = [];
  /** returns true when the cap is hit (abort traversal) */
  function walk(node: FileNode): boolean {
    if (node.name.toLowerCase().includes(query)) {
      // Compute relative directory (parent path minus root prefix)
      const lastSep = node.path.lastIndexOf('/');
      const parentPath = lastSep > 0 ? node.path.slice(0, lastSep) : '';
      const relDir = parentPath.startsWith(rootPrefix)
        ? parentPath.slice(rootPrefix.length).replace(/^\//, '')
        : parentPath;
      results.push({ node, relDir });
      if (results.length >= limit) return true;
    }
    if (node.children) {
      for (const child of node.children) {
        if (walk(child)) return true;
      }
    }
    return false;
  }
  for (const n of nodes) {
    if (walk(n)) break;
  }
  return results;
}

/** F14: 搜索结果条数上限（超出截断 + 提示精确关键词） */
const SEARCH_MATCH_LIMIT = 500;

function SearchResultItem({
  match,
  onContextMenu,
}: {
  match: FlatMatch;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
}) {
  const { node, relDir } = match;
  const selectedFile = useFileStore((s) => s.selectedFile);
  const selectFile = useFileStore((s) => s.selectFile);
  const changeKind = useFileStore((s) => s.changedFiles.get(node.path));
  const isSelected = selectedFile === node.path;
  return (
    <button
      onClick={() => { if (!node.is_dir) selectFile(node.path); }}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, node.is_dir); }}
      className={`w-full flex items-center gap-2 py-1.5 px-3 rounded-lg
        text-left text-[13px] transition-smooth group
        ${isSelected
          ? 'bg-accent/10 text-accent'
          : changeKind
            ? 'text-success'
            : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'
        }`}
    >
      <FileIcon name={node.name} isDir={node.is_dir} size={14} className="flex-shrink-0" />
      <span className="truncate">{node.name}</span>
      {relDir && (
        <span className="ml-auto text-xs text-text-tertiary truncate max-w-[40%] flex-shrink-0">
          {relDir}
        </span>
      )}
      {getChangeBadge(changeKind)}
    </button>
  );
}

// --- Tree Node ---

// P2: 单目录渲染上限 —— node_modules 等数千条目的目录一次性 map 渲染会卡住
// 主线程；默认只渲前 200 项，其余折叠进「展开全部」按钮（按需一次渲染）。
const CHILD_RENDER_CAP = 200;

// F16: React.memo —— 树更新时未变化的子树不再重渲（props 浅比较）
const TreeNode = memo(function TreeNode({
  node,
  depth,
  onContextMenu,
  renamingPath,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  creatingIn,
  createName,
  onCreateNameChange,
  onCreateSubmit,
  onCreateCancel,
}: {
  node: FileNode;
  depth: number;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  creatingIn: { dir: string; type: 'file' | 'folder' } | null;
  createName: string;
  onCreateNameChange: (v: string) => void;
  onCreateSubmit: () => void;
  onCreateCancel: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  // P2: 超大目录的「展开全部」状态（折叠目录时一并复位）
  const [showAllChildren, setShowAllChildren] = useState(false);
  const selectedFile = useFileStore((s) => s.selectedFile);
  const selectFile = useFileStore((s) => s.selectFile);
  const changeKind = useFileStore((s) => s.changedFiles.get(node.path));
  // 报告B3: subscribe the derived prefix index (O(1) boolean) instead of
  // scanning the entire changedFiles Map per render — the old selector
  // subscribed every directory node to the whole Map and re-ran
  // Array.from(keys()).some() on every changedFiles update (O(N×M)).
  const hasChildChanges = useFileStore((s) =>
    node.is_dir ? s.changedPrefixes.has(node.path) : false
  );
  // R1 lazy loading: a dir whose children were invalidated by watcher events
  // is stale; expanded stale dirs refetch in place (children are preserved so
  // the subtree never collapses).
  const isStale = useFileStore((s) => (node.is_dir ? s.staleDirs.has(node.path) : false));
  const loadDirChildren = useFileStore((s) => s.loadDirChildren);
  // F18: 隐藏文件过滤下推到渲染条件（不再整树深拷贝）
  const showHiddenFiles = useSettingsStore((s) => s.showHiddenFiles);
  const isSelected = selectedFile === node.path;

  // R1: fetch a directory's children on first expand, and refetch whenever it
  // turns stale. Children live in the store tree — this effect is the only
  // place that triggers a load.
  // F16: 不再订阅 childrenVersion —— 失效语义不变：markStale 总是把受影响
  // 目录加入 staleDirs（isStale 翻转即重跑本 effect），而 in-flight 结果的
  // 作废仍由 loadDirChildren 内部的 childrenVersion get() 比对完成；此前每个
  // 目录节点都订阅全局 version，任何失效都触发全树 effect 重跑。
  useEffect(() => {
    if (node.is_dir && expanded && (isStale || !node.children)) {
      loadDirChildren(node.path, isStale);
    }
  }, [expanded, isStale, node.is_dir, node.path, node.children, loadDirChildren]);

  // Track active drag listeners for cleanup on unmount
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const isExpanded = expanded;

  const handleClick = () => {
    if (node.is_dir) {
      // P2: 折叠时复位「展开全部」，下次展开重新按上限截断
      if (expanded) setShowAllChildren(false);
      setExpanded(!expanded);
    } else {
      selectFile(node.path);
    }
  };

  return (
    <div>
      <button
        onClick={handleClick}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          const startX = e.clientX;
          const startY = e.clientY;
          let started = false;

          const onMove = (me: MouseEvent) => {
            if (!started) {
              const dx = me.clientX - startX;
              const dy = me.clientY - startY;
              if (dx * dx + dy * dy < 25) return; // 5px threshold
              started = true;
              startTreeDrag(node.path, node.is_dir);
            }
            moveTreeDrag(me.clientX, me.clientY);
          };

          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            dragCleanupRef.current = null;
            if (started) {
              // Prevent the click event from firing after drag
              const suppressClick = (ce: MouseEvent) => {
                ce.stopPropagation();
                ce.preventDefault();
              };
              document.addEventListener('click', suppressClick, { capture: true, once: true });
              // End drag (cleans up ghost + detects drop target)
              const result = endTreeDrag();
              if (result) {
                if (result.targetFolder) {
                  // Drop on folder → move file
                  const fileName = result.sourcePath.split(/[\\/]/).pop() || '';
                  const dest = `${result.targetFolder}/${fileName}`;
                  bridge.renameFile(result.sourcePath, dest)
                    .then(() => {
                      const dir = useSettingsStore.getState().workingDirectory
                        || useFileStore.getState().rootPath;
                      if (dir) useFileStore.getState().refreshTree(dir);
                    })
                    .catch((err: unknown) => {
                      console.error('Failed to move file:', err);
                      // A10: drag-to-move that silently fails leaves the file
                      // where it was with no explanation.
                      showToast(t('files.renameFailed'), 'error');
                    });
                } else if (!result.droppedInTree) {
                  // Drop outside file tree → insert file chip in chat
                  window.dispatchEvent(
                    new CustomEvent('little-claude:tree-file-inline', { detail: result.sourcePath }),
                  );
                }
              }
            }
          };

          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          dragCleanupRef.current = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, node.path, node.is_dir);
        }}
        {...(node.is_dir ? { 'data-dir-path': node.path } : {})}
        className={`w-full flex items-center gap-2 py-1.5 px-2 rounded-lg
          text-left text-[13px] transition-smooth group
          ${isSelected
            ? 'bg-accent/10 text-accent'
            : changeKind
              ? 'text-success'
              : 'text-text-muted hover:bg-bg-secondary hover:text-text-primary'
          }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {node.is_dir && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className={`flex-shrink-0 transition-transform duration-150
              ${isExpanded ? 'rotate-90' : ''}`}>
            <path d="M3 2l4 3-4 3" />
          </svg>
        )}
        {!node.is_dir && <span className="w-2.5" />}
        <FileIcon name={node.name} isDir={node.is_dir} size={14}
          className={`flex-shrink-0 ${node.is_dir ? 'text-accent/70 dark:text-accent' : ''}`} />
        {renamingPath === node.path ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') onRenameSubmit();
              if (e.key === 'Escape') onRenameCancel();
            }}
            onBlur={onRenameCancel}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 text-[13px] bg-bg-input border border-border-focus
              rounded-lg px-1.5 py-0.5 outline-none text-text-primary"
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
        {getChangeBadge(changeKind)}
        {!changeKind && hasChildChanges && (
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-success
            flex-shrink-0" />
        )}
      </button>
      {node.is_dir && isExpanded && node.children && (
        <div>
          {creatingIn?.dir === node.path && (
            <div className="flex items-center gap-2 py-1 px-2"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
              <FileIcon name={creatingIn.type === 'folder' ? '' : createName}
                isDir={creatingIn.type === 'folder'} size={14}
                className="flex-shrink-0 text-text-tertiary" />
              <input
                autoFocus
                value={createName}
                onChange={(e) => onCreateNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter' && createName.trim()) onCreateSubmit();
                  if (e.key === 'Escape') onCreateCancel();
                }}
                onBlur={onCreateCancel}
                placeholder={creatingIn.type === 'folder' ? 'folder name' : 'file name'}
                className="flex-1 min-w-0 text-[13px] bg-bg-input border border-border-focus
                  rounded-lg px-1.5 py-0.5 outline-none text-text-primary"
              />
            </div>
          )}
          {(() => {
            // F18: 隐藏文件可见性下推到渲染条件——不显示隐藏文件时跳过，
            // 替代此前对整树的递归深拷贝（filteredTree）
            // P2: 超大目录截断渲染，剩余项折叠进「展开全部」
            const filtered = showHiddenFiles
              ? node.children!
              : node.children!.filter((c) => !c.name.startsWith('.'));
            const capped = showAllChildren || filtered.length <= CHILD_RENDER_CAP
              ? filtered
              : filtered.slice(0, CHILD_RENDER_CAP);
            const hiddenCount = filtered.length - capped.length;
            return (
              <>
                {capped.map((child) => (
                  <TreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    onContextMenu={onContextMenu}
                    renamingPath={renamingPath}
                    renameValue={renameValue}
                    onRenameChange={onRenameChange}
                    onRenameSubmit={onRenameSubmit}
                    onRenameCancel={onRenameCancel}
                    creatingIn={creatingIn}
                    createName={createName}
                    onCreateNameChange={onCreateNameChange}
                    onCreateSubmit={onCreateSubmit}
                    onCreateCancel={onCreateCancel}
                  />
                ))}
                {hiddenCount > 0 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowAllChildren(true); }}
                    className="w-full text-left text-[11px] text-text-tertiary hover:text-accent
                      py-0.5 transition-colors"
                    style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                  >
                    {t('files.showMoreChildren', { n: String(hiddenCount) })}
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
});

// --- Main Component ---
export function FileExplorer() {
  const t = useT();
  const tree = useFileStore((s) => s.tree);
  const isLoading = useFileStore((s) => s.isLoading);
  const rootPath = useFileStore((s) => s.rootPath);
  const changedFiles = useFileStore((s) => s.changedFiles);
  const clearChangedFiles = useFileStore((s) => s.clearChangedFiles);
  // R1: search runs over a full-depth tree loaded on demand (the lazy tree
  // only contains loaded/expanded levels)
  const searchTree = useFileStore((s) => s.searchTree);
  const isSearchLoading = useFileStore((s) => s.isSearchLoading);
  const loadSearchTree = useFileStore((s) => s.loadSearchTree);
  // F13: 过期标记 + 查询清空时的回收
  const searchTreeStale = useFileStore((s) => s.searchTreeStale);
  const clearSearchTree = useFileStore((s) => s.clearSearchTree);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);

  const refreshTree = useFileStore((s) => s.refreshTree);
  const createFile = useFileStore((s) => s.createFile);
  const createFolder = useFileStore((s) => s.createFolder);
  const isDragOverTree = useFileStore((s) => s.isDragOverTree);
  const showHiddenFiles = useSettingsStore((s) => s.showHiddenFiles);
  const toggleHiddenFiles = useSettingsStore((s) => s.toggleHiddenFiles);

  const [searchQuery, setSearchQuery] = useState('');
  // F14: 搜索输入 150ms 防抖——按键过程中不反复扫全深树
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const searchActive = debouncedQuery.trim().length > 0;

  // R1: load the full-depth search tree when a query starts.
  // F13: 树过期（结构变更只打标不重建）时也在真正搜索时重建
  useEffect(() => {
    if (searchActive && (searchTree.length === 0 || searchTreeStale)) loadSearchTree();
  }, [searchActive, searchTree.length, searchTreeStale, loadSearchTree]);

  // F13: 查询清空即清 searchTree（释放全深树内存）
  useEffect(() => {
    if (!searchActive && searchTree.length > 0) clearSearchTree();
  }, [searchActive, searchTree.length, clearSearchTree]);

  // F14: useMemo 缓存匹配结果（query/searchTree 不变不重扫）+ 500 条截断
  const matches = useMemo(
    () => (searchActive
      ? collectMatches(searchTree, debouncedQuery.trim().toLowerCase(), rootPath || '', SEARCH_MATCH_LIMIT)
      : []),
    [searchActive, searchTree, debouncedQuery, rootPath],
  );
  const matchesTruncated = matches.length >= SEARCH_MATCH_LIMIT;

  // Right-click menu state
  const [clipboardPath, setClipboardPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ path: string; isDir: boolean } | null>(null);

  // New file/folder inline creation state
  const [creatingIn, setCreatingIn] = useState<{ dir: string; type: 'file' | 'folder' } | null>(null);
  const [createName, setCreateName] = useState('');

  // F18: filteredTree 移除——不再递归深拷贝整树；showHiddenFiles 下推到
  // TreeNode 渲染条件（见下方根级 map 与 TreeNode 内部 children 过滤）

  const changedCount = changedFiles.size;

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // --- Right-click menu callbacks ---
  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path);
  }, []);

  const handleCopyFile = useCallback((path: string) => {
    setClipboardPath(path);
  }, []);

  const handlePaste = useCallback(async (targetDir: string) => {
    if (!clipboardPath) return;
    const fileName = clipboardPath.split(/[\\/]/).pop() || 'file';
    const dest = `${targetDir}/${fileName}`;
    try {
      await bridge.copyFile(clipboardPath, dest);
      setClipboardPath(null);
      refreshTree();
    } catch (err) {
      console.error('Failed to paste file:', err);
      // A10: silent paste failure leaves the user's clipboard operation
      // unacknowledged — the file simply never appears.
      showToast(t('files.renameFailed'), 'error');
    }
  }, [clipboardPath, refreshTree, t]);

  const handleStartRename = useCallback((path: string) => {
    const name = path.split(/[\\/]/).pop() || '';
    setRenamingPath(path);
    setRenameValue(name);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    const dir = renamingPath.substring(0, Math.max(renamingPath.lastIndexOf('/'), renamingPath.lastIndexOf('\\')));
    const dest = `${dir}/${renameValue.trim()}`;
    if (dest === renamingPath) {
      setRenamingPath(null);
      return;
    }
    try {
      await bridge.renameFile(renamingPath, dest);
      setRenamingPath(null);
      refreshTree();
    } catch (err) {
      console.error('Failed to rename file:', err);
      // A10: silent failure — the input box closes and the tree keeps the old
      // name, leaving the user to wonder whether the rename happened.
      showToast(t('files.renameFailed'), 'error');
      setRenamingPath(null);
    }
  }, [renamingPath, renameValue, refreshTree, t]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleRequestDelete = useCallback((path: string, isDir: boolean) => {
    setDeleteTarget({ path, isDir });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await bridge.deleteFile(deleteTarget.path);
      setDeleteTarget(null);
      refreshTree();
    } catch (err) {
      console.error('Failed to delete file:', err);
      // A10: silent failure — the dialog closes and the file is still there.
      showToast(t('files.deleteFailed'), 'error');
      setDeleteTarget(null);
    }
  }, [deleteTarget, refreshTree, t]);

  const handleInsertToChat = useCallback((path: string) => {
    const tabId = useSessionStore.getState().selectedSessionId;
    if (!tabId) return;
    const tab = useChatStore.getState().getTab(tabId);
    const currentDraft = tab?.inputDraft ?? '';
    const prefix = currentDraft && !currentDraft.endsWith('\n') && !currentDraft.endsWith(' ') ? ' ' : '';
    useChatStore.getState().setInputDraft(tabId, currentDraft + prefix + path);
  }, []);

  const handleNewFile = useCallback((dir: string) => {
    setCreatingIn({ dir, type: 'file' });
    setCreateName('');
  }, []);

  const handleNewFolder = useCallback((dir: string) => {
    setCreatingIn({ dir, type: 'folder' });
    setCreateName('');
  }, []);

  const handleCreateSubmit = useCallback(async () => {
    if (!creatingIn || !createName.trim()) {
      setCreatingIn(null);
      return;
    }
    if (creatingIn.type === 'file') {
      await createFile(creatingIn.dir, createName.trim());
    } else {
      await createFolder(creatingIn.dir, createName.trim());
    }
    setCreatingIn(null);
    setCreateName('');
  }, [creatingIn, createName, createFile, createFolder]);

  const handleCreateCancel = useCallback(() => {
    setCreatingIn(null);
    setCreateName('');
  }, []);

  const contextMenuCallbacks: ContextMenuCallbacks = useMemo(() => ({
    onCopyPath: handleCopyPath,
    onCopyFile: handleCopyFile,
    onPaste: handlePaste,
    onRename: handleStartRename,
    onDelete: handleRequestDelete,
    onInsertToChat: handleInsertToChat,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    clipboardPath,
  }), [handleCopyPath, handleCopyFile, handlePaste, handleStartRename, handleRequestDelete, handleInsertToChat, handleNewFile, handleNewFolder, clipboardPath]);

  // No project selected
  if (!workingDirectory) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center px-3 py-2 border-b border-border-subtle">
          <span className="text-[13px] font-medium text-text-tertiary
            uppercase tracking-wider">{t('files.title')}</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center
          px-4 text-center">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none"
            stroke="currentColor" strokeWidth="1.2"
            className="text-text-tertiary/40 mb-3">
            <path d="M4 8h8l4 4h12v14H4V8z" />
          </svg>
          <p className="text-xs text-text-tertiary leading-relaxed">
            {t('files.selectProject')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2
        border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0"
          title={workingDirectory}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="text-accent flex-shrink-0">
            <path d="M2 4h4l2 2h6v7H2V4z" />
          </svg>
          <div className="min-w-0">
            <span className="text-[13px] font-medium text-text-primary
              truncate block">
              {workingDirectory.split(/[\\/]/).pop()}
            </span>
          </div>
          {changedCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full
              bg-success/15 text-success
              font-medium flex-shrink-0">
              {changedCount} {t('files.changed')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={() => handleNewFile(workingDirectory || rootPath)}
            className="p-1.5 rounded-lg hover:bg-bg-secondary active:bg-bg-tertiary
              text-text-tertiary hover:text-text-secondary transition-smooth"
            title={t('files.newFile')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M9 2H4v12h8V5l-3-3z" />
              <path d="M8 7v4M6 9h4" />
            </svg>
          </button>
          <button onClick={() => handleNewFolder(workingDirectory || rootPath)}
            className="p-1.5 rounded-lg hover:bg-bg-secondary active:bg-bg-tertiary
              text-text-tertiary hover:text-text-secondary transition-smooth"
            title={t('files.newFolder')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h4l2 2h6v7H2V4z" />
              <path d="M7 8v3M5.5 9.5h3" />
            </svg>
          </button>
          <button onClick={toggleHiddenFiles}
            className={`p-1.5 rounded-lg hover:bg-bg-secondary active:bg-bg-tertiary
              transition-smooth ${showHiddenFiles ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary'}`}
            title={t('files.toggleHidden')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              {showHiddenFiles ? (
                <>
                  <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
                  <circle cx="8" cy="8" r="2" />
                </>
              ) : (
                <>
                  <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
                  <circle cx="8" cy="8" r="2" />
                  <path d="M2 14L14 2" />
                </>
              )}
            </svg>
          </button>
          <button onClick={() => {
              clearChangedFiles();
              const dir = workingDirectory || rootPath;
              if (dir) refreshTree(dir);
            }}
            className="p-1.5 rounded-lg hover:bg-bg-secondary active:bg-bg-tertiary
              text-text-tertiary hover:text-text-secondary transition-smooth"
            title={t('files.refresh')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1.5 7a5.5 5.5 0 0110-3M12.5 7a5.5 5.5 0 01-10 3" />
              <path d="M11.5 1v3h-3M2.5 13v-3h3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="px-2 py-1.5 border-b border-border-subtle">
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3 3" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('files.search')}
            className="w-full pl-7 pr-7 py-1 text-[13px] bg-bg-secondary/50
              border border-border-subtle rounded-lg text-text-primary
              placeholder:text-text-tertiary outline-none
              focus:border-border-focus focus:bg-bg-input
              transition-smooth"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2
                p-0.5 rounded-lg text-text-tertiary hover:text-text-primary
                transition-smooth"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 min-h-0 relative" data-file-tree>
        {isDragOverTree && (
          <div className="absolute inset-0 z-10 border-2 border-dashed border-accent
            bg-accent/5 rounded-lg flex items-center justify-center pointer-events-none">
            <span className="text-xs text-accent font-medium">
              {t('files.dropHere')}
            </span>
          </div>
        )}
        <div className="h-full overflow-y-auto py-1">
        {(isLoading && (searchActive ? searchTree.length === 0 : tree.length === 0)) ||
          (searchActive && isSearchLoading && searchTree.length === 0) ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent/30
              border-t-accent rounded-full animate-spin" />
          </div>
        ) : searchActive ? (
          // --- Flat search results (full-depth tree, loaded on demand) ---
          // F14: 结果来自上方 useMemo（防抖 + 缓存 + 500 条截断）
          matches.length > 0 ? (
            <div className="py-1">
              {matches.map((m) => (
                <SearchResultItem
                  key={m.node.path}
                  match={m}
                  onContextMenu={handleContextMenu}
                />
              ))}
              {matchesTruncated && (
                <div className="text-center py-2 px-3 text-[11px] text-text-tertiary">
                  {t('files.searchTruncated')}
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8 text-xs text-text-tertiary">
              {t('files.noFiles')}
            </div>
          )
        ) : tree.length > 0 ? (
            // --- Normal tree view ---
            <>
              {/* Inline creation input at root level */}
              {creatingIn && creatingIn.dir === (workingDirectory || rootPath) && (
                <div className="flex items-center gap-2 py-1.5 px-2"
                  style={{ paddingLeft: '8px' }}>
                  <FileIcon name={creatingIn.type === 'folder' ? '__dir__' : 'untitled'}
                    isDir={creatingIn.type === 'folder'} size={14}
                    className="flex-shrink-0 text-text-tertiary" />
                  <input
                    autoFocus
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === 'Enter') handleCreateSubmit();
                      if (e.key === 'Escape') handleCreateCancel();
                    }}
                    onBlur={handleCreateCancel}
                    placeholder={creatingIn.type === 'file' ? t('files.newFile') : t('files.newFolder')}
                    className="flex-1 min-w-0 text-[13px] bg-bg-input border border-border-focus
                      rounded-lg px-1.5 py-0.5 outline-none text-text-primary
                      placeholder:text-text-tertiary"
                  />
                </div>
              )}
              {tree.map((node) => {
                // F18: 根级隐藏节点按 showHiddenFiles 渲染条件跳过（免深拷贝）
                if (!showHiddenFiles && node.name.startsWith('.')) return null;
                return (
                  <TreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    onContextMenu={handleContextMenu}
                    renamingPath={renamingPath}
                    renameValue={renameValue}
                    onRenameChange={setRenameValue}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    creatingIn={creatingIn}
                    createName={createName}
                    onCreateNameChange={setCreateName}
                    onCreateSubmit={handleCreateSubmit}
                    onCreateCancel={handleCreateCancel}
                  />
                );
              })}
            </>
          )
        : (
          <div className="text-center py-8 text-xs text-text-tertiary">
            {t('files.noFiles')}
          </div>
        )}
        </div>{/* end scroll container */}
      </div>{/* end data-file-tree wrapper */}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu menu={contextMenu} onClose={closeContextMenu} callbacks={contextMenuCallbacks} />
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={t('files.delete')}
        message={
          deleteTarget
            ? (deleteTarget.isDir ? t('files.deleteConfirmDir') : t('files.deleteConfirm'))
                .replace('{name}', deleteTarget.path.split(/[\\/]/).pop() ?? '')
            : ''
        }
        detail={deleteTarget?.path}
        variant="danger"
        confirmLabel={t('files.delete')}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
