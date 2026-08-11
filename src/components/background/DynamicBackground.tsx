import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { bridge } from '../../lib/tauri-bridge';
import { showToast } from '../shared/Toast';
import { useT } from '../../lib/i18n';

/**
 * Fullscreen dynamic wallpaper overlay.
 *
 * The video sits at z-index 99999 ABOVE the entire UI with low opacity and
 * pointer-events: none, so it acts as a translucent film over the app.
 * This approach does NOT require making every panel background transparent
 * and works regardless of theme or skin.
 *
 * Opacity is user-adjustable (0.05–0.50) via settings.
 *
 * Performance safety net: a fullscreen translucent video on top of the whole
 * UI is expensive on machines where WebView2 falls back to software
 * compositing / software video decoding. requestVideoFrameCallback measures
 * the ACTUAL rendered frame rate and degrades in two steps:
 *   1. 'opacity' — cap opacity at 0.08 (halves the per-frame blend cost)
 *   2. 'static'  — pause the video on the current frame (static wallpaper)
 * Frame rate recovering for a while reverts one step automatically.
 */
const DEFAULT_OPACITY = 0.18;
const MIN_OPACITY = 0.05;
const MAX_OPACITY = 0.50;
/** Wallpapers are always compressed at 30fps — the monitor assumes this. */
const EXPECTED_FPS = 30;
/** Each stats window is 2.5s of rendered frames. */
const WINDOW_MS = 2500;
/** Ratio below which a window counts as "laggy" (30fps source < ~15fps). */
const LOW_RATIO = 0.5;
/** Consecutive laggy windows that trigger a degrade step. */
const LOW_WINDOWS = 2;
/** Consecutive healthy windows that revert one degrade step. */
const OK_WINDOWS = 3;
/** Cap applied to user opacity on the first degrade step. */
const DEGRADE_OPACITY = 0.08;

type DegradeLevel = 'none' | 'opacity' | 'static';

function clampOpacity(v: number): number {
  return Math.max(MIN_OPACITY, Math.min(MAX_OPACITY, v));
}

export function DynamicBackground() {
  const t = useT();
  const wallpaperEnabled = useSettingsStore((s) => s.wallpaperEnabled);
  const wallpaperName = useSettingsStore((s) => s.wallpaperName);
  const wallpaperOpacity = useSettingsStore((s) => s.wallpaperOpacity);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [degrade, setDegrade] = useState<DegradeLevel>('none');
  // Mirrors `degrade` for use inside the rVFC callback without re-registering.
  const degradeRef = useRef<DegradeLevel>('none');
  const errorShownRef = useRef(false);

  const opacity = Number.isFinite(wallpaperOpacity)
    ? clampOpacity(wallpaperOpacity)
    : DEFAULT_OPACITY;

  const active = wallpaperEnabled && !!wallpaperName;

  // The 'opacity' degrade step caps the blend cost; the 'static' step keeps
  // the user's opacity (a cached frame blends cheaply).
  const effectiveOpacity =
    degrade === 'opacity' ? Math.min(opacity, DEGRADE_OPACITY) : opacity;

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

  // User explicitly adjusts opacity → treat as intent to retry, reset degrade
  useEffect(() => {
    if (degradeRef.current !== 'none') {
      degradeRef.current = 'none';
      setDegrade('none');
      const vid = videoRef.current;
      if (vid && vid.paused) vid.play().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallpaperOpacity]);

  // Frame-rate watchdog: rVFC reports frames actually composited. A fullscreen
  // translucent video is expensive under software compositing / software
  // decode; we can't fix the machine, so we degrade gracefully.
  useEffect(() => {
    const vid = videoRef.current;
    // requestVideoFrameCallback needs Chromium 106+ (any evergreen WebView2);
    // without it, skip the watchdog entirely.
    if (!vid || !src || typeof vid.requestVideoFrameCallback !== 'function') return;

    // New video source: reset degrade + error state
    degradeRef.current = 'none';
    setDegrade('none');
    errorShownRef.current = false;

    let alive = true;
    let frames = 0;
    let windowStart = performance.now();
    let lowWindows = 0;
    let okWindows = 0;

    const upgrade = () => {
      const cur = degradeRef.current;
      if (cur === 'none') {
        degradeRef.current = 'opacity';
        setDegrade('opacity');
        showToast(t('settings.wallpaper.perfOpacity'), 'info');
      } else if (cur === 'opacity') {
        degradeRef.current = 'static';
        setDegrade('static');
        const v = videoRef.current;
        if (v) v.pause(); // holds the current frame → static wallpaper
        showToast(t('settings.wallpaper.perfStatic'), 'info', {
          label: t('settings.wallpaper.perfRetry'),
          onClick: () => {
            degradeRef.current = 'none';
            setDegrade('none');
            const v = videoRef.current;
            if (v) v.play().catch(() => {});
          },
        });
      }
    };
    const revert = () => {
      const cur = degradeRef.current;
      if (cur === 'opacity') {
        degradeRef.current = 'none';
        setDegrade('none');
      } else if (cur === 'static') {
        // Resume playback, but conservatively land on the opacity step
        degradeRef.current = 'opacity';
        setDegrade('opacity');
        const v = videoRef.current;
        if (v) v.play().catch(() => {});
      }
    };

    const onFrame = (now: number) => {
      if (!alive) return;
      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed >= WINDOW_MS) {
        const expected = (EXPECTED_FPS * elapsed) / 1000;
        const ratio = frames / Math.max(expected, 1);
        frames = 0;
        windowStart = now;
        // rVFC does not fire while paused, but be defensive
        if (vid.paused || vid.ended) return;
        if (ratio < LOW_RATIO) {
          lowWindows += 1;
          okWindows = 0;
          if (lowWindows >= LOW_WINDOWS) {
            lowWindows = 0;
            upgrade();
          }
        } else {
          okWindows += 1;
          lowWindows = 0;
          if (okWindows >= OK_WINDOWS && degradeRef.current !== 'none') {
            okWindows = 0;
            revert();
          }
        }
      }
      vid.requestVideoFrameCallback(onFrame);
    };
    vid.requestVideoFrameCallback(onFrame);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const handleVideoError = () => {
    if (errorShownRef.current) return;
    errorShownRef.current = true;
    showToast(t('settings.wallpaper.decodeError'), 'error');
  };

  if (!active || !src) return null;

  return (
    <video
      key={wallpaperName}
      ref={videoRef}
      className="fixed inset-0 w-full h-full object-cover"
      style={{
        zIndex: 99999,
        opacity: effectiveOpacity,
        pointerEvents: 'none',
        // Hint the compositor to promote the video to its own layer instead
        // of re-blending it with the (constantly repainting) UI layer.
        willChange: 'transform',
      }}
      src={src}
      loop
      muted
      autoPlay
      playsInline
      preload="auto"
      onError={handleVideoError}
    />
  );
}
