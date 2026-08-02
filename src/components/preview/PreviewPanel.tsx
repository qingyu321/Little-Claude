import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { openUrl as openExternalUrl } from '@tauri-apps/plugin-opener';
import {
  usePreviewStore,
  isSafePreviewUrl,
  PreviewCommand,
  PreviewSnapshot,
} from '../../stores/previewStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';

export function PreviewPanel() {
  const t = useT();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const url = usePreviewStore((s) => s.url);
  const history = usePreviewStore((s) => s.history);
  const historyIndex = usePreviewStore((s) => s.historyIndex);
  const reloadToken = usePreviewStore((s) => s.reloadToken);
  const lastSnapshot = usePreviewStore((s) => s.lastSnapshot);
  const openUrl = usePreviewStore((s) => s.openUrl);
  const refresh = usePreviewStore((s) => s.refresh);
  const back = usePreviewStore((s) => s.back);
  const forward = usePreviewStore((s) => s.forward);
  const setSnapshot = usePreviewStore((s) => s.setSnapshot);
  const setSecondaryTab = useSettingsStore((s) => s.setSecondaryTab);
  const [draftUrl, setDraftUrl] = useState(url === 'about:blank' ? '' : url);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setDraftUrl(url === 'about:blank' ? '' : url);
  }, [url]);

  useEffect(() => {
    if (url !== 'about:blank') setLoading(true);
  }, [url, reloadToken]);

  useEffect(() => {
    const unlistenPromise = listen<PreviewCommand>('tokenicode-preview-command', (event) => {
      const command = event.payload;
      setSecondaryTab('preview');
      if (command.type === 'open') openUrl(command.url);
      if (command.type === 'refresh') refresh();
      if (command.type === 'back') back();
      if (command.type === 'forward') forward();
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [back, forward, openUrl, refresh, setSecondaryTab]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;
  const iframeKey = `${url}:${reloadToken}`;

  const submitUrl = () => {
    openUrl(draftUrl);
  };

  const captureSnapshot = async () => {
    const frame = iframeRef.current;
    const viewport = {
      width: frame?.clientWidth || 0,
      height: frame?.clientHeight || 0,
    };
    let title = '';
    let readableText = '';
    let note = '';
    try {
      const doc = frame?.contentDocument;
      title = doc?.title || '';
      readableText = (doc?.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (!readableText) note = t('preview.snapshotEmpty');
    } catch {
      note = t('preview.crossOriginSnapshot');
    }
    const snapshot: PreviewSnapshot = {
      url,
      title,
      capturedAt: new Date().toISOString(),
      viewport,
      ...(readableText ? { readableText } : {}),
      ...(note ? { note } : {}),
    };
    setSnapshot(snapshot);
    setNotice(note || t('preview.snapshotReady'));
  };

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <div className="px-3 py-2 border-b border-border-subtle space-y-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={back}
            disabled={!canGoBack}
            className="preview-icon-btn"
            title={t('preview.back')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <button
            onClick={forward}
            disabled={!canGoForward}
            className="preview-icon-btn"
            title={t('preview.forward')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3l5 5-5 5" />
            </svg>
          </button>
          <button
            onClick={refresh}
            className="preview-icon-btn"
            title={t('preview.refresh')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 8a5 5 0 11-1.46-3.54" />
              <path d="M13 3v4H9" />
            </svg>
          </button>
          <form
            className="flex-1 min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              submitUrl();
            }}
          >
            <input
              value={draftUrl}
              onChange={(event) => setDraftUrl(event.target.value)}
              placeholder={t('preview.urlPlaceholder')}
              className="w-full h-8 px-2 rounded-md bg-bg-secondary border border-border-subtle
                text-[12px] text-text-primary placeholder:text-text-tertiary outline-none
                focus:border-accent/60"
            />
          </form>
          <button
            onClick={submitUrl}
            className="preview-icon-btn"
            title={t('preview.open')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12L12 4" />
              <path d="M6 4h6v6" />
            </svg>
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 text-[11px] text-text-tertiary truncate">
            {loading ? t('preview.loading') : url}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={captureSnapshot}
              className="preview-action-btn"
              title={t('preview.snapshot')}
            >
              {t('preview.snapshotShort')}
            </button>
            <button
              onClick={() => url !== 'about:blank' && openExternalUrl(url)}
              className="preview-icon-btn"
              title={t('preview.external')}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 4H4a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2v-2" />
                <path d="M10 2h4v4" />
                <path d="M8 8l6-6" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-white">
        {!isSafePreviewUrl(url) ? (
          <div className="h-full flex items-center justify-center bg-bg-primary text-text-tertiary text-sm">
            {t('preview.loadFailed')}
          </div>
        ) : url === 'about:blank' ? (
          <div className="h-full flex items-center justify-center bg-bg-primary text-text-tertiary text-sm">
            {t('preview.empty')}
          </div>
        ) : (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={url}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts"
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setNotice(t('preview.loadFailed'));
            }}
          />
        )}
        {loading && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-accent animate-pulse" />
        )}
      </div>

      {(notice || lastSnapshot) && (
        <div className="px-3 py-2 border-t border-border-subtle bg-bg-primary text-[11px] text-text-muted">
          <div className="truncate">{notice || lastSnapshot?.note || t('preview.snapshotReady')}</div>
        </div>
      )}
    </div>
  );
}
