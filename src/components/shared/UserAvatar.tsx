import { useSettingsStore } from '../../stores/settingsStore';

/** Convert a data URL to a blob URL (cached) so images render under the tauri:// protocol. */
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

interface UserAvatarProps {
  size: string;
  rounded?: string;
  className?: string;
}

export function UserAvatar({ size, rounded = 'rounded-[10px]', className = '' }: UserAvatarProps) {
  const avatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const displayName = useSettingsStore((s) => s.userDisplayName);

  const initial = displayName ? displayName[0].toUpperCase() : '';

  // Convert data URL → blob URL so the image renders under tauri:// protocol
  const blobUrl = avatarUrl ? dataUrlToBlobUrl(avatarUrl) : undefined;

  return (
    <div className={`${size} ${rounded}
      flex items-center justify-center flex-shrink-0 shadow-md overflow-hidden ${className}
      ${avatarUrl ? 'bg-transparent' : 'bg-accent/80'}`}>
      {avatarUrl && blobUrl ? (
        <img src={blobUrl} alt="User" className="w-full h-full object-cover" />
      ) : initial ? (
        <span className="text-white font-semibold select-none" style={{ fontSize: 'inherit' }}>
          {initial}
        </span>
      ) : (
        <svg width="60%" height="60%" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.2" strokeLinecap="round">
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" />
        </svg>
      )}
    </div>
  );
}
