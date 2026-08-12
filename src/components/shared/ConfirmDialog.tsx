import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../lib/i18n';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // B21: 键盘可达 —— 打开时聚焦取消按钮（更安全的默认动作）、Enter 触发确认、
  // Esc 关闭、关闭后焦点还原到触发元素
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    cancelBtnRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  const isDanger = variant === 'danger';

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="bg-bg-card border border-border-subtle rounded-xl p-5
          shadow-lg max-w-sm w-full mx-4 animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-text-primary mb-2">{title}</h3>
        {/* 回归修复: whitespace-pre-line — 调用方（如删除运行中会话警告）用 \n 拼
            接的多段文案此前被 HTML 折叠成一行，警告信息失去分层。 */}
        <p className="text-sm text-text-primary mb-1 whitespace-pre-line">{message}</p>
        {detail && (
          <p className="text-xs text-text-muted mb-4 truncate">{detail}</p>
        )}
        {!detail && <div className="mb-4" />}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelBtnRef}
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
              text-text-muted hover:bg-bg-tertiary transition-smooth cursor-pointer"
          >
            {cancelLabel || t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 text-xs rounded-lg transition-smooth cursor-pointer
              ${isDanger
                ? 'bg-error/10 text-error hover:bg-error/20'
                : 'bg-accent/10 text-accent hover:bg-accent/20'
              }`}
          >
            {confirmLabel || t('common.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
