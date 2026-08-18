import React, { memo, useState, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useLightboxStore } from './ImageLightbox';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFileStore } from '../../stores/fileStore';
import { bridge } from '../../lib/tauri-bridge';
import { isPathInsideWorkspace } from '../../lib/path-safety';
import { useT } from '../../lib/i18n';

/* ================================================================
   AsyncImage — loads local files via Rust base64 bridge
   ================================================================ */
function isLocalPath(src: string): boolean {
  return (
    src.startsWith('file://') ||
    src.startsWith('/') ||
    /^[A-Za-z]:[/\\]/.test(src)
  );
}

/** Schemes a markdown link may open in the external browser. */
const SAFE_LINK_RE = /^(https?|mailto|tel):/i;

function isSafeExternalLink(href: string): boolean {
  return SAFE_LINK_RE.test(href);
}

/** Broken/rejected image placeholder (shared by AsyncImage and the img handler). */
function ImagePlaceholder({ alt }: { alt?: string }) {
  const t = useT();
  return (
    <div className="my-3 rounded-xl overflow-hidden border border-border-subtle
      inline-block max-w-full">
      <div className="flex items-center justify-center gap-2 py-6 px-4
        text-xs text-text-muted bg-bg-secondary">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="2" width="14" height="12" rx="2" />
          <circle cx="5" cy="6" r="1.5" />
          <path d="M1 11l4-4 3 3 2-2 5 5" />
        </svg>
        {t('msg.imgError')}
      </div>
      {alt && (
        <div className="px-3 py-1.5 text-xs text-text-muted bg-bg-secondary
          border-t border-border-subtle">{alt}</div>
      )}
    </div>
  );
}

function AsyncImage({ src, alt }: { src: string; alt?: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const filePath = src.startsWith('file://') ? src.slice(7) : src;
    bridge.readFileBase64(filePath).then(setDataUrl).catch(() => setError(true));
  }, [src]);

  const handleClick = useCallback(() => {
    const filePath = src.startsWith('file://') ? src.slice(7) : src;
    useLightboxStore.getState().openFile(filePath, alt);
  }, [src, alt]);

  if (error) {
    return <ImagePlaceholder alt={alt} />;
  }

  if (!dataUrl) {
    return (
      <div className="my-3 rounded-xl overflow-hidden border border-border-subtle
        inline-block bg-bg-secondary px-6 py-4">
        <span className="w-4 h-4 border-2 border-accent/30 border-t-accent
          rounded-full animate-spin inline-block" />
      </div>
    );
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-border-subtle
      shadow-sm inline-block max-w-full">
      <img
        src={dataUrl}
        alt={alt || ''}
        className="max-w-full max-h-96 object-contain cursor-zoom-in"
        onClick={handleClick}
      />
      {alt && (
        <div className="px-3 py-1.5 text-xs text-text-muted bg-bg-secondary
          border-t border-border-subtle">{alt}</div>
      )}
    </div>
  );
}

/* ================================================================
   CopyButton — hover-reveal copy for code blocks
   ================================================================ */
export function CopyButton({ text, inline = false }: { text: string; inline?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={`px-2 py-1 rounded-md text-[10px]
        font-medium transition-smooth
        bg-bg-tertiary/80 text-text-muted hover:text-text-primary
        hover:bg-bg-tertiary border border-border-subtle ${
          inline ? '' : 'absolute top-2 right-2 opacity-0 group-hover:opacity-100'
        }`}
    >
      {copied ? t('msg.copied') : t('msg.copyCode')}
    </button>
  );
}

/** Extract fenced-code language (language-ts) from a <code> child node */
function extractCodeLang(node: ReactNode): string {
  if (Array.isArray(node)) return extractCodeLang(node[0]);
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { className?: string; children?: ReactNode } }).props;
    const m = /language-([\w+-]+)/.exec(props?.className || '');
    if (m) return m[1];
    return extractCodeLang(props?.children);
  }
  return '';
}

/** Extract plain text from nested React nodes (for copy button) */
function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as any).props.children);
  }
  return '';
}

/** Known code/config file extensions — shared between wrapBareFilePaths and inline code detection. */
const KNOWN_FILE_EXTENSIONS = new Set([
  'md', 'mdx', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl',
  'toml', 'yaml', 'yml', 'py', 'pyi', 'rs', 'go', 'html', 'htm', 'css',
  'scss', 'sass', 'less', 'vue', 'svelte', 'sh', 'bash', 'zsh', 'fish',
  'env', 'conf', 'cfg', 'ini', 'xml', 'sql', 'graphql', 'gql', 'proto',
  'lock', 'log', 'txt', 'csv', 'rb', 'php', 'java', 'kt', 'swift', 'c',
  'cpp', 'h', 'hpp', 'cs', 'r', 'lua', 'zig', 'ex', 'exs', 'erl', 'ml',
  'mli', 'tf', 'hcl', 'dockerfile', 'makefile', 'png', 'jpg', 'jpeg',
  'gif', 'svg', 'webp', 'ico', 'wasm', 'map',
]);

/** Detect file paths in inline code — conservative regex to avoid false positives.
 *  Matches: path-prefixed files (/foo.ts, ./bar.md, src/baz.rs) AND
 *  bare filenames with known code/config extensions (CLAUDE.md, package.json). */
const KNOWN_EXT_RE = /^[\w][\w.-]*\.(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|json|jsonl|toml|yaml|yml|py|pyi|rs|go|html|htm|css|scss|sass|less|vue|svelte|sh|bash|zsh|fish|env|conf|cfg|ini|xml|sql|graphql|gql|proto|lock|log|txt|csv|rb|php|java|kt|swift|c|cpp|h|hpp|cs|r|lua|zig|ex|exs|erl|ml|mli|tf|hcl|dockerfile|makefile)$/i;
const FILE_PATH_RE = /^(?:\/|\.\/|\.\.\/|[a-zA-Z]:[/\\]|src\/|lib\/|components\/|stores\/|hooks\/|utils\/|tests\/|__tests__\/)[\w.@/-]+\.\w{1,10}$/;

/**
 * Pre-process markdown to wrap bare file paths in backticks so the existing
 * `code` component handler can make them clickable.
 *
 * Only processes text outside fenced code blocks and inline code.
 * Matches absolute paths (/..., C:\...), relative (./..., ../...), and
 * common project-relative paths (src/..., lib/..., etc.).
 */
const BARE_PATH_RE = /(^|[^`\w:@#/])((?:(?:\/|\.\.?\/)[\w.@/+-]+\.\w{1,10}|(?:src|lib|components|stores|hooks|utils|tests|__tests__|app|pages|public|assets|styles|config)\/[\w.@/+-]+\.\w{1,10}))(?![`\w])/g;

/**
 * Split content on fenced code blocks (``` ... ```) with a single-pass scan.
 * The old regex split /(```[\s\S]*?```)/g backtracks quadratically on
 * unclosed fences — which is the common case while text is streaming in
 * (each frame re-renders the growing partial content).
 */
function splitFences(content: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf('```', cursor);
    if (open === -1) {
      parts.push(content.slice(cursor));
      break;
    }
    parts.push(content.slice(cursor, open));
    const close = content.indexOf('```', open + 3);
    if (close === -1) {
      // Unclosed fence — the rest of the content is code; stop processing
      parts.push(content.slice(open));
      break;
    }
    parts.push(content.slice(open, close + 3));
    cursor = close + 3;
  }
  return parts;
}

/**
 * Split on inline code (`...`, non-empty, no newline inside) with a
 * single-pass scan. Same quadratic-backtracking concern as splitFences: the
 * old regex /(`[^`\n]+`)/g retries every position on long lines with no
 * closing backtick.
 */
function splitInline(text: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('`', cursor);
    if (open === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    const close = text.indexOf('`', open + 1);
    const nl = text.indexOf('\n', open + 1);
    if (close !== -1 && close > open + 1 && (nl === -1 || nl > close)) {
      // Valid inline code: backtick pair with non-empty, single-line content
      parts.push(text.slice(cursor, open));
      parts.push(text.slice(open, close + 1));
      cursor = close + 1;
      continue;
    }
    // Lone backtick — treat as literal text and keep scanning from the next char
    parts.push(text.slice(cursor, open + 1));
    cursor = open + 1;
  }
  return parts;
}

function wrapBareFilePaths(content: string): string {
  // Split by fenced code blocks (``` ... ```) — don't touch code blocks
  const fenced = splitFences(content);
  return fenced.map((part, i) => {
    if (i % 2 === 1) return part; // inside fenced code block
    // Split by inline code (` ... `) — don't double-wrap
    const inlined = splitInline(part);
    return inlined.map((seg, j) => {
      if (j % 2 === 1) return seg; // inside inline code
      // Also skip markdown link targets: [text](url)
      return seg.replace(BARE_PATH_RE, (match, prefix, path, offset, str) => {
        const pathStart = offset + prefix.length;
        // Don't wrap if inside a markdown link target: ...](path)
        if (pathStart > 0 && str[pathStart - 1] === '(') return match;
        // Don't wrap if preceded by ]( (markdown link)
        const before = str.slice(Math.max(0, pathStart - 2), pathStart);
        if (before.endsWith('](')) return match;
        // TK-323: Only wrap if extension is a known code/config file type
        const ext = path.split('.').pop()?.toLowerCase();
        if (!ext || !KNOWN_FILE_EXTENSIONS.has(ext)) return match;
        return `${prefix}\`${path}\``;
      });
    }).join('');
  }).join('');
}

/* ================================================================
   MarkdownRenderer — shared markdown rendering with syntax highlighting
   ================================================================ */
interface Props {
  content: string;
  className?: string;
  /** Base path for resolving relative image paths (defaults to workingDirectory) */
  basePath?: string;
  /** Skip syntax highlighting entirely. Used by the streaming footer: its
   *  partial content re-parses every flush, and highlight.js runs synchronously
   *  on the main thread — the final message renders with highlighting instead. */
  skipHighlight?: boolean;
}

// Sanitize schema: GitHub defaults + className on all elements (needed for highlight.js)
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'className'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), 'data:image'],
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RemarkPlugin = any;

const EMPTY_REMARK_PLUGINS: RemarkPlugin[] = [];
let cachedRemarkPlugins: RemarkPlugin[] | null = null;
let remarkPluginsPromise: Promise<RemarkPlugin[]> | null = null;
let warnedAboutGfmFallback = false;

function supportsRemarkGfmRegex(): boolean {
  try {
    // remark-gfm's autolink-literal dependency uses this exact regex shape.
    // Older WebKit parses `(?<=` as an invalid group specifier and crashes
    // during module evaluation, so we gate the import on syntax support.
    void new RegExp(
      '(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)',
      'gu',
    );
    return true;
  } catch {
    return false;
  }
}

async function loadRemarkPlugins(): Promise<RemarkPlugin[]> {
  if (cachedRemarkPlugins) return cachedRemarkPlugins;

  if (!supportsRemarkGfmRegex()) {
    if (!warnedAboutGfmFallback) {
      warnedAboutGfmFallback = true;
      console.warn('[LITTLECLAUDE] remark-gfm disabled: current JS runtime does not support its regex syntax');
    }
    cachedRemarkPlugins = EMPTY_REMARK_PLUGINS;
    return cachedRemarkPlugins;
  }

  if (!remarkPluginsPromise) {
    remarkPluginsPromise = Promise.all([
      import('remark-gfm'),
      import('remark-cjk-friendly'),
    ])
      .then(([gfmMod, cjkMod]) => {
        cachedRemarkPlugins = [gfmMod.default, cjkMod.default];
        return cachedRemarkPlugins;
      })
      .catch((error) => {
        console.warn('[LITTLECLAUDE] failed to load remark plugins, falling back to basic markdown', error);
        cachedRemarkPlugins = EMPTY_REMARK_PLUGINS;
        return cachedRemarkPlugins;
      });
  }

  return remarkPluginsPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REHYPE_PLUGINS: any[] = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeHighlight];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REHYPE_PLUGINS_NO_HIGHLIGHT: any[] = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]];

/**
 * Line threshold above which a fenced code block skips syntax highlighting.
 * highlight.js highlights synchronously on the main thread — a 5000-line
 * block costs 80-300ms per render, and streaming partial content re-renders
 * every frame, freezing the UI while the backend keeps running.
 */
const CODE_BLOCK_HIGHLIGHT_LINE_LIMIT = 300;

/** True if any fenced code block in `content` exceeds the highlight line limit. */
function hasHugeCodeBlock(content: string): boolean {
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf('```', cursor);
    if (open === -1) return false;
    const close = content.indexOf('```', open + 3);
    const blockEnd = close === -1 ? content.length : close;
    let lines = 0;
    for (let i = open; i < blockEnd; i++) {
      if (content.charCodeAt(i) === 10) {
        lines++;
        if (lines >= CODE_BLOCK_HIGHLIGHT_LINE_LIMIT) return true;
      }
    }
    if (close === -1) return false;
    cursor = close + 3;
  }
  return false;
}

/** Error boundary scoped to a single markdown block.
 *  A malformed message (e.g. truncated table from rate-limit) crashes only
 *  its own bubble, not the entire app. */
class MarkdownErrorBoundary extends React.Component<
  { children: ReactNode; fallback: string },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownRenderer] render failed, falling back to plain text:', error.message);
  }
  render() {
    if (this.state.hasError) {
      return (
        <pre className="whitespace-pre-wrap break-words text-xs text-text-secondary">
          {this.props.fallback}
        </pre>
      );
    }
    return this.props.children;
  }
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, className, basePath, skipHighlight }: Props) {
  const t = useT();
  // A6: Don't subscribe to workingDirectory — read it imperatively only when a
  // file-path handler actually needs it. This avoids re-rendering every mounted
  // MarkdownRenderer (potentially 160+) when the user changes working directory.
  const [remarkPlugins, setRemarkPlugins] = useState<RemarkPlugin[]>(() => cachedRemarkPlugins ?? EMPTY_REMARK_PLUGINS);

  useEffect(() => {
    if (cachedRemarkPlugins !== null) return;

    let cancelled = false;
    loadRemarkPlugins().then((plugins) => {
      if (!cancelled) setRemarkPlugins(plugins);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Pre-process: wrap bare file paths in backticks so `code` handler makes them clickable
  const processedContent = useMemo(() => wrapBareFilePaths(content), [content]);

  // Huge code blocks (>=300 lines) skip syntax highlighting — highlight.js
  // would block the main thread per render while the block streams in.
  const hasHugeCode = useMemo(() => hasHugeCodeBlock(content), [content]);
  const rehypePlugins = useMemo(
    () => (hasHugeCode || skipHighlight ? REHYPE_PLUGINS_NO_HIGHLIGHT : REHYPE_PLUGINS),
    [hasHugeCode, skipHighlight],
  );

  // Stable components object — only recreated when `t` changes or when the
  // basePath prop changes (img/code handlers close over basePath; a stale
  // memo would resolve relative paths against the previous workspace).
  const components = useMemo(() => ({
    table: ({ children }: { children?: ReactNode }) => (
      <div className="my-3 overflow-x-auto rounded-lg border border-border-subtle">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }: { children?: ReactNode }) => (
      <thead className="bg-bg-secondary">{children}</thead>
    ),
    th: ({ children }: { children?: ReactNode }) => (
      <th className="px-3 py-2 text-left font-medium text-text-muted
        border-b border-border-subtle text-[11px]">{children}</th>
    ),
    td: ({ children }: { children?: ReactNode }) => (
      <td className="px-3 py-2 text-text-primary border-b border-border-subtle
        text-xs">{children}</td>
    ),
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      // Detect false-positive autolinks: remark-gfm treats file-like text
      // (e.g. AGENTS.md, config.rs) as URLs because some extensions are
      // valid TLDs (.md = Moldova, .rs = Serbia, .sh = St. Helena, etc.)
      const childText = typeof children === 'string' ? children : '';
      const FILE_EXT_RE = /\.(md|txt|json|ts|tsx|js|jsx|py|rs|go|toml|yaml|yml|html|css|sh|log|env|cfg|ini|xml|csv|sql|lock|swift|kt|java|c|h|cpp|hpp|rb|lua|zig|vue|svelte)$/i;
      if (
        href &&
        FILE_EXT_RE.test(childText) &&
        (href === `http://${childText}` || href === `https://${childText}`)
      ) {
        return <code className="rounded bg-black/[0.06] px-1 py-0.5 text-[0.9em] dark:bg-white/[0.08]">{children}</code>;
      }

      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            // Only http(s)/mailto/tel links open externally — file:, local
            // absolute paths, and custom schemes are never opened.
            if (href && isSafeExternalLink(href)) openUrl(href);
          }}
          className="text-accent hover:underline inline-flex items-center
            gap-0.5 cursor-pointer"
          title={href}
        >
          {children}
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            className="flex-shrink-0 opacity-60">
            <path d="M4.5 1.5h6v6M10.5 1.5L4 8" />
          </svg>
        </a>
      );
    },
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      // A6: Resolve relative paths against working directory (read imperatively
      // so workingDirectory changes don't re-render every MarkdownRenderer).
      let resolvedSrc = src || '';
      if (
        resolvedSrc &&
        !resolvedSrc.startsWith('file://') &&
        !resolvedSrc.startsWith('/') &&
        !resolvedSrc.startsWith('data:') &&
        !resolvedSrc.startsWith('http://') &&
        !resolvedSrc.startsWith('https://') &&
        !/^[A-Za-z]:[/\\]/.test(resolvedSrc)
      ) {
        const wd = basePath || useSettingsStore.getState().workingDirectory || '';
        if (wd) {
          const base = wd.endsWith('/') ? wd : wd + '/';
          resolvedSrc = `${base}${resolvedSrc}`;
        }
      }

      // Local files: load via Rust base64 bridge (file:// URLs don't work in
      // Tauri webview). Only paths inside the working directory are loaded —
      // an image in markdown is passive content and must not read arbitrary
      // files (e.g. ssh keys) without user interaction.
      if (isLocalPath(resolvedSrc)) {
        const filePath = resolvedSrc.startsWith('file://') ? resolvedSrc.slice(7) : resolvedSrc;
        const wd = basePath || useSettingsStore.getState().workingDirectory || '';
        if (wd && isPathInsideWorkspace(filePath, wd)) {
          return <AsyncImage src={resolvedSrc} alt={alt || undefined} />;
        }
        return <ImagePlaceholder alt={alt || undefined} />;
      }

      // Remote URLs & data URIs: render directly
      return (
      <div className="my-3 rounded-xl overflow-hidden border border-border-subtle
        shadow-sm inline-block max-w-full">
        <img
          src={resolvedSrc}
          alt={alt || ''}
          // Privacy: third-party image hosts must not see the workspace path
          // (the app origin) via the Referer header.
          referrerPolicy="no-referrer"
          loading="lazy"
          className="max-w-full max-h-96 object-contain cursor-zoom-in"
          onClick={() => {
            if (!resolvedSrc) return;
            if (resolvedSrc.startsWith('data:')) {
              useLightboxStore.getState().open(resolvedSrc, undefined, alt);
            } else if (/^https:/i.test(resolvedSrc)) {
              openUrl(resolvedSrc);
            }
            // http: links are not opened externally (downgrade-prone).
          }}
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = 'none';
            const placeholder = el.nextElementSibling;
            if (placeholder) (placeholder as HTMLElement).style.display = 'flex';
          }}
        />
        <div className="hidden items-center justify-center gap-2 py-6 px-4
          text-xs text-text-muted bg-bg-secondary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <circle cx="5" cy="6" r="1.5" />
            <path d="M1 11l4-4 3 3 2-2 5 5" />
          </svg>
          {t('msg.imgError')}
        </div>
        {alt && (
          <div className="px-3 py-1.5 text-xs text-text-muted bg-bg-secondary
            border-t border-border-subtle">
            {alt}
          </div>
        )}
      </div>
      );
    },
    pre: ({ children }: { children?: ReactNode }) => {
      const codeText = extractText(children);
      const lang = extractCodeLang(children);
      return (
        <div className="my-3 overflow-hidden rounded-xl
          border border-border-subtle">
          {/* DSH code-block banner — bluish-850/900 + language label */}
          <div className="flex items-center justify-between
            px-3 py-1.5 bg-bg-layer-1 border-b border-border-subtle">
            <span className="text-[10px] font-medium uppercase tracking-wide
              text-text-tertiary">
              {lang || 'code'}
            </span>
            <CopyButton text={codeText} inline />
          </div>
          <pre className="bg-bg-secondary p-4 overflow-x-auto">
            {children}
          </pre>
        </div>
      );
    },
    code: ({ children, className }: { children?: ReactNode; className?: string }) => {
      // Fenced code blocks (language-xxx) — don't intercept, let <pre> handle them
      if (className) return <code className={className}>{children}</code>;

      const text = extractText(children).trim();
      const ext = text.split('.').pop()?.toLowerCase() ?? '';
      if (((FILE_PATH_RE.test(text) || KNOWN_EXT_RE.test(text)) && KNOWN_FILE_EXTENSIONS.has(ext))) {
        const resolved = text.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(text)
          ? text
          : (() => {
              const base = basePath || useSettingsStore.getState().workingDirectory || '';
              return base ? `${base.replace(/\/$/, '')}/${text}` : text;
            })();
        const fileName = text.split(/[\\/]/).pop() || text;
        // Security: never turn an out-of-workspace path into a clickable
        // file chip — a malicious/accidental model output could otherwise
        // point at C:\Users\...\.ssh\config and read secrets into the
        // preview pane on a single click. Both absolute paths AND relative
        // paths that fold (`../`) outside the workspace render as plain
        // text instead.
        const wd = basePath || useSettingsStore.getState().workingDirectory || '';
        const inWorkspace = isPathInsideWorkspace(resolved, wd);
        if (!inWorkspace) {
          return <code>{text}</code>;
        }
        return (
          <button
            onClick={() => useFileStore.getState().selectFile(resolved)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5
              bg-accent/10 border border-accent/25 rounded-md
              text-xs text-accent font-medium cursor-pointer
              hover:bg-accent/20 hover:border-accent/40
              transition-all duration-150 select-none
              align-baseline leading-normal whitespace-nowrap"
            title={resolved}
          >
            <span className="text-[10px]">📄</span>
            <span className="max-w-[180px] truncate">{fileName}</span>
          </button>
        );
      }
      return <code>{children}</code>;
    },
  }), [t, basePath]); // A6: workingDirectory still read imperatively at call time

  return (
    <div className={`prose prose-sm max-w-none
      prose-code:bg-bg-secondary prose-code:px-1.5 prose-code:py-0.5
      prose-code:rounded-md prose-code:text-sm prose-code:text-accent
      prose-pre:bg-bg-secondary prose-pre:rounded-xl prose-pre:p-4
      prose-pre:border prose-pre:border-border-subtle
      prose-headings:text-text-primary prose-a:text-accent
      prose-strong:text-text-primary ${className || ''}`}>
      <MarkdownErrorBoundary fallback={content}>
        <Markdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {processedContent}
        </Markdown>
      </MarkdownErrorBoundary>
    </div>
  );
});
