import { useSettingsStore } from '../../stores/settingsStore';

/** Default brand avatar when the user has not set a custom AI avatar. */
function DefaultIcon() {
  return (
    <img
      src="/default-ai-avatar.png"
      alt="Little Claude"
      className="w-full h-full object-cover"
    />
  );
}

interface AiAvatarProps {
  /** Tailwind size class for the container, e.g. "w-8 h-8", "w-16 h-16", "w-20 h-20" */
  size: string;
  /** Tailwind border-radius class, e.g. "rounded-[10px]", "rounded-2xl", "rounded-3xl" */
  rounded?: string;
  /** Extra classes for the container */
  className?: string;
}

/**
 * AI avatar that shows a user-customized image if set, otherwise the default </> icon.
 * The custom image is stored as a data URL in settingsStore.aiAvatarUrl.
 */
/**
 * Convert a data URL to a blob URL.
 * WebView2 blocks `data:` URIs in `<img>` tags when the page is loaded via a
 * custom protocol (tauri://), regardless of CSP. Blob URLs work reliably there,
 * so we convert once and cache the result per data URL.
 */
const blobUrlCache = new Map<string, string>();

function dataUrlToBlobUrl(dataUrl: string): string {
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

export function AiAvatar({ size, rounded = 'rounded-[10px]', className = '' }: AiAvatarProps) {
  const avatarUrl = useSettingsStore((s) => s.aiAvatarUrl);

  // Brand default avatar and custom uploads both use cover images; keep bg transparent.
  const bgClass = 'bg-transparent';

  // Convert data URL → blob URL so the image renders under tauri:// protocol
  const blobUrl = avatarUrl ? dataUrlToBlobUrl(avatarUrl) : undefined;

  return (
    <div className={`${size} ${rounded} ${bgClass}
      flex items-center justify-center flex-shrink-0 shadow-md overflow-hidden ${className}`}>
      {avatarUrl && blobUrl ? (
        <img src={blobUrl} alt="AI" className="w-full h-full object-cover" />
      ) : (
        <DefaultIcon />
      )}
    </div>
  );
}
