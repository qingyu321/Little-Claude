/**
 * TiptapEditor — drop-in replacement for the <textarea> in InputBar.
 *
 * Exposes an imperative API (via ref) that mirrors the subset of textarea
 * behaviour that InputBar relies on:  getText(), setText(), focus(),
 * insertFileChip(), isEmpty().
 *
 * Internally uses a Tiptap editor with the StarterKit + custom FileChipExtension.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { FileChipExtension, type FileChipAttrs } from './file-chip-extension';
import { FileChipView } from './FileChipView';

/* ------------------------------------------------------------------ */
/*  F3: 全局 IME 组合态（多编辑器实例计数）                            */
/* ------------------------------------------------------------------ */
// 组合进行中切换 tab 会把 compositionend 的 flush 写进新 tab 的草稿。
// App.tsx 的 Ctrl+Tab 等会话切换热键在组合态中跳过，保证组合文本不丢、
// 不覆盖别的 tab 草稿。
let _globalComposingCount = 0;

/** F3: 任一编辑器实例处于 IME 组合态即为 true（会话切换热键据此跳过）。 */
export function isGlobalComposing(): boolean {
  return _globalComposingCount > 0;
}

/* ------------------------------------------------------------------ */
/*  Imperative handle                                                  */
/* ------------------------------------------------------------------ */

export interface TiptapEditorHandle {
  /** Extract plain text for submission. FileChips become `path` */
  getText(): string;
  /** Replace editor content with plain text (used by setInput) */
  setText(text: string): void;
  /** Focus the editor */
  focus(): void;
  /** Insert a file chip at the current cursor position */
  insertFileChip(attrs: FileChipAttrs): void;
  /** Whether the editor has no content */
  isEmpty(): boolean;
  /** Whether an IME composition is in progress */
  isComposing(): boolean;
  /** Get the underlying Tiptap editor instance (escape hatch) */
  getEditor(): ReturnType<typeof useEditor> | null;
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface TiptapEditorProps {
  /** Placeholder text */
  placeholder?: string;
  /** Called whenever the content changes (debounce-free) */
  onUpdate?: (text: string) => void;
  /** Called on keydown — receives the native keyboard event */
  onKeyDown?: (e: KeyboardEvent) => boolean | void;
  /** Called on paste */
  onPaste?: (e: ClipboardEvent) => boolean | void;
  /** Additional CSS class for the wrapper */
  className?: string;
  /** data attribute for external querySelector targeting */
  'data-chat-input'?: boolean;
}

/* ------------------------------------------------------------------ */
/*  FileChip extension with React NodeView                             */
/* ------------------------------------------------------------------ */

const FileChipWithView = FileChipExtension.extend({
  addNodeView() {
    return ReactNodeViewRenderer(FileChipView);
  },
});

/* ------------------------------------------------------------------ */
/*  Serializer: editor JSON → plain text with `path` for file chips    */
/* ------------------------------------------------------------------ */

function editorToPlainText(editor: ReturnType<typeof useEditor>): string {
  if (!editor) return '';
  const json = editor.getJSON();
  const parts: string[] = [];
  for (const block of (json.content ?? []) as any[]) {
    const lineParts: string[] = [];
    for (const node of (block.content ?? []) as any[]) {
      if (node.type === 'fileChip') {
        const displayPath = node.attrs?.label ?? node.attrs?.fullPath ?? '';
        lineParts.push(`\`${displayPath}\``);
      } else if (node.type === 'text') {
        lineParts.push(node.text ?? '');
      } else if (node.type === 'hardBreak') {
        lineParts.push('\n');
      }
    }
    parts.push(lineParts.join(''));
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const TiptapEditor = forwardRef<TiptapEditorHandle, TiptapEditorProps>(
  function TiptapEditor(props, ref) {
    const {
      placeholder = '',
      onUpdate,
      onKeyDown,
      onPaste,
      className,
    } = props;

    const wrapperRef = useRef<HTMLDivElement>(null);
    const composingRef = useRef(false);
    const onUpdateRef = useRef(onUpdate);
    onUpdateRef.current = onUpdate;

    const onKeyDownRef = useRef(onKeyDown);
    onKeyDownRef.current = onKeyDown;

    const onPasteRef = useRef(onPaste);
    onPasteRef.current = onPaste;

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // Disable all block-level nodes except paragraph + hardBreak
          heading: false,
          blockquote: false,
          codeBlock: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          horizontalRule: false,
          // Keep bold/italic/code inline marks
        }),
        Placeholder.configure({ placeholder }),
        FileChipWithView,
      ],
      editorProps: {
        attributes: {
          class: 'tiptap outline-none',
          'data-chat-input': '',
        },
        handleKeyDown: (_view, event) => {
          // Auto-unstick composingRef if browser says not composing.
          // compositionend can be missed on macOS WebKit (focus change, click outside),
          // leaving composingRef stuck true and blocking Enter. See issue #66.
          if (composingRef.current && !event.isComposing && event.keyCode !== 229) {
            composingRef.current = false;
            // F3: 全局计数同步解卡，否则切换热键会被永久屏蔽
            _globalComposingCount = Math.max(0, _globalComposingCount - 1);
          }
          return onKeyDownRef.current?.(event) === true;
        },
        handlePaste: (_view, event) => {
          return onPasteRef.current?.(event as unknown as ClipboardEvent) === true;
        },
      },
      onUpdate: ({ editor: ed }) => {
        // Skip store updates during IME composition to avoid React re-renders
        // that can disrupt WebKit's contentEditable composition state
        if (composingRef.current) return;
        const text = editorToPlainText(ed);
        onUpdateRef.current?.(text);
      },
    });

    // Track IME composition state and flush text on compositionend
    useEffect(() => {
      const el = editor?.view?.dom;
      if (!el) return;
      // F3: 组合起止同步维护全局计数（以 composingRef 状态翻转为准，保证配对）
      const onStart = () => {
        if (!composingRef.current) {
          composingRef.current = true;
          _globalComposingCount += 1;
        }
      };
      const onEnd = () => {
        if (composingRef.current) {
          composingRef.current = false;
          _globalComposingCount = Math.max(0, _globalComposingCount - 1);
        }
        // Flush the final composed text to the store
        const text = editorToPlainText(editor);
        onUpdateRef.current?.(text);
      };
      el.addEventListener('compositionstart', onStart);
      el.addEventListener('compositionend', onEnd);
      return () => {
        el.removeEventListener('compositionstart', onStart);
        el.removeEventListener('compositionend', onEnd);
        // F3: 卸载时仍处于组合态（如 tab 被切走）——归还计数防泄漏
        if (composingRef.current) {
          composingRef.current = false;
          _globalComposingCount = Math.max(0, _globalComposingCount - 1);
        }
      };
    }, [editor]);

    // Update placeholder when prop changes
    useEffect(() => {
      if (!editor) return;
      // Access the placeholder extension and reconfigure
      editor.extensionManager.extensions.forEach((ext) => {
        if (ext.name === 'placeholder') {
          (ext.options as any).placeholder = placeholder;
          // Force re-render of decorations
          editor.view.dispatch(editor.view.state.tr);
        }
      });
    }, [editor, placeholder]);

    useImperativeHandle(ref, () => ({
      getText() {
        return editorToPlainText(editor);
      },
      setText(text: string) {
        if (!editor) return;
        if (!text) {
          editor.commands.clearContent();
          return;
        }
        // Set plain text content (preserving newlines as hard breaks)
        editor.commands.setContent(
          text.split('\n').map((line) => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : [],
          })),
        );
      },
      focus() {
        editor?.commands.focus();
      },
      insertFileChip(attrs: FileChipAttrs) {
        if (!editor) return;
        editor.commands.focus();
        editor
          .chain()
          .insertContent({
            type: 'fileChip',
            attrs,
          })
          .insertContent(' ')  // space after chip for typing
          .run();
      },
      isEmpty() {
        return editor?.isEmpty ?? true;
      },
      isComposing() {
        return composingRef.current;
      },
      getEditor() {
        return editor;
      },
    }));

    return (
      <div
        ref={wrapperRef}
        className={className}
        data-chat-input={props['data-chat-input'] ? '' : undefined}
      >
        <EditorContent editor={editor} />
      </div>
    );
  },
);
