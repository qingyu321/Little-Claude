import { useState, useRef, useCallback, useEffect } from 'react';
import { useT } from '../../lib/i18n';

interface AvatarCropModalProps {
  /** The raw image file selected by user */
  imageFile: File;
  /** Called with the cropped data URL on save */
  onSave: (dataUrl: string) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

const CROP_SIZE = 240;   // Visual crop area in px
const OUTPUT_SIZE = 256;  // Output resolution

/**
 * Avatar crop modal — drag to reposition, scroll/buttons to zoom.
 * Renders a square crop frame with the image behind it.
 */
export function AvatarCropModal({ imageFile, onSave, onCancel }: AvatarCropModalProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Image state
  const [imgSrc, setImgSrc] = useState('');
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [naturalW, setNaturalW] = useState(0);
  const [naturalH, setNaturalH] = useState(0);

  // Transform state: scale and offset (in image-space pixels)
  const [scale, setScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);

  // Drag state
  const dragRef = useRef<{ startX: number; startY: number; origOX: number; origOY: number } | null>(null);

  // Load image
  useEffect(() => {
    const url = URL.createObjectURL(imageFile);
    setImgSrc(url);
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      setNaturalW(img.naturalWidth);
      setNaturalH(img.naturalHeight);
      // Initial scale: fit the shorter side to crop area
      const fitScale = CROP_SIZE / Math.min(img.naturalWidth, img.naturalHeight);
      setScale(fitScale);
      // Center
      setOffsetX((CROP_SIZE - img.naturalWidth * fitScale) / 2);
      setOffsetY((CROP_SIZE - img.naturalHeight * fitScale) / 2);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  // Clamp offset so image always covers the crop area
  const clampOffset = useCallback((ox: number, oy: number, s: number) => {
    const imgW = naturalW * s;
    const imgH = naturalH * s;
    // Image left edge must be <= 0 (can't expose left gap)
    // Image right edge must be >= CROP_SIZE
    const minX = CROP_SIZE - imgW;
    const maxX = 0;
    const minY = CROP_SIZE - imgH;
    const maxY = 0;
    return {
      x: Math.min(maxX, Math.max(minX, ox)),
      y: Math.min(maxY, Math.max(minY, oy)),
    };
  }, [naturalW, naturalH]);

  // Zoom
  const handleZoom = useCallback((delta: number) => {
    setScale((prev) => {
      const minScale = CROP_SIZE / Math.min(naturalW, naturalH);
      const maxScale = minScale * 5;
      const next = Math.min(maxScale, Math.max(minScale, prev + delta));
      // Adjust offset to zoom toward center
      const cx = CROP_SIZE / 2;
      const cy = CROP_SIZE / 2;
      const newOX = cx - (cx - offsetX) * (next / prev);
      const newOY = cy - (cy - offsetY) * (next / prev);
      const clamped = clampOffset(newOX, newOY, next);
      setOffsetX(clamped.x);
      setOffsetY(clamped.y);
      return next;
    });
  }, [naturalW, naturalH, offsetX, offsetY, clampOffset]);

  // Mouse drag
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, origOX: offsetX, origOY: offsetY };
  }, [offsetX, offsetY]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const clamped = clampOffset(dragRef.current.origOX + dx, dragRef.current.origOY + dy, scale);
    setOffsetX(clamped.x);
    setOffsetY(clamped.y);
  }, [scale, clampOffset]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const minScale = CROP_SIZE / Math.min(naturalW || 1, naturalH || 1);
    const step = minScale * 0.1;
    handleZoom(e.deltaY < 0 ? step : -step);
  }, [naturalW, naturalH, handleZoom]);

  // Save — render to canvas
  const handleSave = useCallback(() => {
    if (!imgEl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d')!;
    // Map visual crop area → output
    const ratio = OUTPUT_SIZE / CROP_SIZE;
    ctx.drawImage(
      imgEl,
      0, 0, imgEl.naturalWidth, imgEl.naturalHeight,
      offsetX * ratio, offsetY * ratio,
      imgEl.naturalWidth * scale * ratio, imgEl.naturalHeight * scale * ratio,
    );
    onSave(canvas.toDataURL('image/png'));
  }, [imgEl, scale, offsetX, offsetY, onSave]);

  const minScale = naturalW ? CROP_SIZE / Math.min(naturalW, naturalH) : 1;

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50"
      onClick={onCancel}>
      <div className="bg-bg-card rounded-2xl shadow-2xl p-6 flex flex-col items-center gap-4 w-[320px]"
        onClick={(e) => e.stopPropagation()}>
        {/* Title */}
        <div className="flex items-center justify-between w-full">
          <h3 className="text-[14px] font-semibold text-text-primary">{t('settings.aiAvatarCrop')}</h3>
          <button onClick={onCancel} className="text-text-muted hover:text-text-primary transition-smooth text-lg leading-none">&times;</button>
        </div>

        {/* Crop area */}
        <div
          ref={containerRef}
          className="relative rounded-xl overflow-hidden cursor-grab active:cursor-grabbing select-none bg-black/10 dark:bg-white/10"
          style={{ width: CROP_SIZE, height: CROP_SIZE }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          {imgSrc && (
            <img
              src={imgSrc}
              alt=""
              draggable={false}
              className="absolute pointer-events-none max-w-none"
              style={{
                width: naturalW * scale,
                height: naturalH * scale,
                transform: `translate(${offsetX}px, ${offsetY}px)`,
              }}
            />
          )}
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleZoom(-minScale * 0.15)}
            className="w-8 h-8 rounded-lg border border-border-subtle flex items-center justify-center
              text-text-muted hover:bg-bg-secondary transition-smooth text-sm font-bold"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="7" cy="7" r="5" />
              <path d="M11 11l3 3" />
              <path d="M5 7h4" />
            </svg>
          </button>
          <input
            type="range"
            min={minScale}
            max={minScale * 5}
            step={minScale * 0.01}
            value={scale}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              const cx = CROP_SIZE / 2;
              const cy = CROP_SIZE / 2;
              const newOX = cx - (cx - offsetX) * (next / scale);
              const newOY = cy - (cy - offsetY) * (next / scale);
              const clamped = clampOffset(newOX, newOY, next);
              setOffsetX(clamped.x);
              setOffsetY(clamped.y);
              setScale(next);
            }}
            className="w-28 accent-accent"
          />
          <button
            onClick={() => handleZoom(minScale * 0.15)}
            className="w-8 h-8 rounded-lg border border-border-subtle flex items-center justify-center
              text-text-muted hover:bg-bg-secondary transition-smooth text-sm font-bold"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="7" cy="7" r="5" />
              <path d="M11 11l3 3" />
              <path d="M5 7h4M7 5v4" />
            </svg>
          </button>
        </div>

        {/* Actions */}
        <div className="flex gap-3 w-full">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-xl text-[13px] font-medium
              border border-border-subtle text-text-muted hover:bg-bg-secondary transition-smooth"
          >
            {t('settings.aiAvatarCancel')}
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-2 rounded-xl text-[13px] font-medium
              bg-accent text-text-inverse hover:bg-accent-hover transition-smooth"
          >
            {t('settings.aiAvatarSave')}
          </button>
        </div>

        {/* Hidden canvas for output */}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
}
