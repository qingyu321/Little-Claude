/**
 * Path-safety helpers for rendering untrusted file paths (model output,
 * markdown content). Rust 侧有第二道防线（safe_resolve 拒绝字面 `..` 与
 * 系统目录），但前端必须兑现"工作区外路径不可点击"的承诺——此前相对路径
 * （`../secret.json`）一律放行，绝对路径在 wd 为空时也因 `''.startsWith` 的
 * 空前缀匹配而误放行。这里对相对路径做 `..` 折叠后再判定，两种形态一视同仁。
 */

/** Normalize a path at the string level (forward slashes, collapse `.`/`..`),
 *  with no filesystem access. Windows drive prefixes are preserved as a single
 *  leading segment; `..` above the root is dropped (stays at root). */
export function normalizePath(p: string): string {
  const hasDrive = /^[a-zA-Z]:[/\\]/.test(p);
  const isRooted = p.startsWith('/') || p.startsWith('\\') || hasDrive;
  const parts = p.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      // Never pop above the root (drive prefix counts as one segment).
      if (stack.length > (hasDrive ? 1 : 0)) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const body = stack.join('/');
  if (!isRooted) return body;
  return hasDrive ? body : `/${body}`;
}

/** Resolve a possibly-relative path against a base directory (string level). */
export function resolveAgainst(base: string, p: string): string {
  if (!base) return p;
  const isAbs =
    p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[/\\]/.test(p);
  if (isAbs) return p;
  return `${base.replace(/[\\/]+$/, '')}/${p}`;
}

/**
 * True if `filePath` (absolute or relative) resolves strictly inside `wd`.
 * An empty `wd` never passes (no workspace → nothing is clickable), which
 * also closes the previous `p.startsWith('')` always-true hole for absolute
 * paths when no working directory was configured.
 */
export function isPathInsideWorkspace(filePath: string, wd: string): boolean {
  if (!wd) return false;
  const base = normalizePath(wd);
  if (!base) return false;
  const p = normalizePath(resolveAgainst(wd, filePath));
  return p === base || p.startsWith(base + '/');
}
