import { formatErrorForUser } from '../hooks/useStreamProcessor';

/**
 * formatErrorForUser 的纯文本变体：只取首段友好文案，去掉 markdown 详情块。
 * 聊天流中的系统消息由 MarkdownRenderer 渲染，可直接用 formatErrorForUser；
 * toast / 卡片等纯文本场景用它，避免把 `<details>` 源码直接展示给用户。
 */
export function friendlyError(raw: string): string {
  const formatted = formatErrorForUser(raw);
  const idx = formatted.indexOf('\n\n<details>');
  return idx === -1 ? formatted : formatted.slice(0, idx);
}
