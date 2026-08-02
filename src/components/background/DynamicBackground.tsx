import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { bridge } from '../../lib/tauri-bridge';

/**
 * Fullscreen dynamic wallpaper overlay.
 *
 * The video sits at z-index 99999 ABOVE the entire UI with low opacity and
 * pointer-events: none, so it acts as a translucent film over the app.
 * This approach does NOT require making every panel background transparent
 * and works regardless of theme or skin.
 *
 * Opacity is user-adjustable (0.05–0.50) via settings.
 */
const DEFAULT_OPACITY = 0.18;
const MIN_OPACITY = 0.05;
const MAX_OPACITY = 0.50;

function clampOpacity(v: number): number {
  return Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, v));
}

export function DynamicBackground() {
  const wallpaperEnabled = useSettingsStore((s) => s.wallpaperEnabled);
  const wallpaperName = useSettingsStore((s) => s.wallpaperName);
  const wallpaperOpacity = useSettingsStore((s) => s.wallpaperOpacity);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  const opacity = Number.isFinite(wallpaperOpacity)
    ? clampOpacity(wallpaperOpacity)
    : DEFAULT_OPACITY;

  const active = wallpaperEnabled && !!wallpaperName;

  // Start the wallpaper HTTP server and build the video URL
  useEffect(() => {
    if (!active) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    bridge.startWallpaperServer().then((port) => {
      if (cancelled) return;
      const url = `http://127.0.0.1:${port}/${encodeURIComponent(wallpaperName)}.mp4`;
      setSrc(url);
    }).catch(() => {
      setSrc(null);
    });
    return () => { cancelled = true; };
  }, [active, wallpaperName]);

  // Auto-play whenever src changes
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !src) return;
    vid.play().catch(() => {});
  }, [src]);

  // Pause when window loses focus / tab is hidden
  useEffect(() => {
    const vid = videoRef.current;

    const onHidden = () => {
      if (vid && !vid.paused) vid.pause();
    };
    const onVisible = () => {
      if (vid && vid.paused && src) vid.play().catch(() => {});
    };
    const onVisibility = () => {
      if (document.hidden) onHidden();
      else onVisible();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onHidden);
    window.addEventListener('focus', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onHidden);
      window.removeEventListener('focus', onVisible);
    };
  }, [src]);

  if (!active || !src) return null;

  return (
    <video
      key={wallpaperName}
      ref={videoRef}
      className="fixed inset-0 w-full h-full object-cover"
      style={{
        zIndex: 99999,
        opacity,
        pointerEvents: 'none',
      }}
      src={src}
      loop
      muted
      autoPlay
      playsInline
      preload="auto"
    />
  );
}
