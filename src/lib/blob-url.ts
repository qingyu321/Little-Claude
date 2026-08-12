/**
 * Convert a data URL to a blob URL.
 * WebView2 blocks `data:` URIs in `<img>` tags when the page is loaded via a
 * custom protocol (tauri://), regardless of CSP. Blob URLs work reliably there,
 * so we convert once and cache the result per data URL.
 */
const blobUrlCache = new Map<string, string>();
/** Bound the cache: long-lived Tauri sessions must not grow it forever.
 *  Evicted entries get their object URL revoked so memory is actually freed. */
const MAX_CACHE_ENTRIES = 64;

export function dataUrlToBlobUrl(dataUrl: string): string {
  if (blobUrlCache.has(dataUrl)) {
    // LRU touch — move to the end so hot attachments stay cached
    const url = blobUrlCache.get(dataUrl)!;
    blobUrlCache.delete(dataUrl);
    blobUrlCache.set(dataUrl, url);
    return url;
  }
  const byteString = atob(dataUrl.split(',')[1]);
  const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  const blob = new Blob([ab], { type: mimeString });
  const url = URL.createObjectURL(blob);
  if (blobUrlCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = blobUrlCache.keys().next().value;
    if (oldest !== undefined) {
      const oldUrl = blobUrlCache.get(oldest)!;
      URL.revokeObjectURL(oldUrl);
      blobUrlCache.delete(oldest);
    }
  }
  blobUrlCache.set(dataUrl, url);
  return url;
}
