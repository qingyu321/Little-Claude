/**
 * Convert a data URL to a blob URL.
 * WebView2 blocks `data:` URIs in `<img>` tags when the page is loaded via a
 * custom protocol (tauri://), regardless of CSP. Blob URLs work reliably there,
 * so we convert once and cache the result per data URL.
 */
const blobUrlCache = new Map<string, string>();

export function dataUrlToBlobUrl(dataUrl: string): string {
  if (blobUrlCache.has(dataUrl)) return blobUrlCache.get(dataUrl)!;
  const byteString = atob(dataUrl.split(',')[1]);
  const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  const blob = new Blob([ab], { type: mimeString });
  const url = URL.createObjectURL(blob);
  blobUrlCache.set(dataUrl, url);
  return url;
}
