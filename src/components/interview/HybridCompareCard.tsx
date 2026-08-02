interface HybridCompareCardProps {
  mimoText: string;
  localText: string;
  mimoLabel: string;
  localLabel: string;
  hybridLabel: string;
}

/** 混合对比面板 — 并排展示 Mimo 云端和本地 sherpa-onnx 的转录结果 */
export function HybridCompareCard({
  mimoText,
  localText,
  mimoLabel,
  localLabel,
  hybridLabel,
}: HybridCompareCardProps) {
  const mimoLen = mimoText.length;
  const localLen = localText.length;
  const ratio = mimoLen > 0 ? Math.round((localLen / mimoLen) * 100) : 100;
  const delta = Math.abs(mimoLen - localLen);
  const agreeColor = ratio >= 80 && ratio <= 120 ? 'text-success' : 'text-warning';

  return (
    <div className="rounded-xl border border-purple-500/25 bg-purple-500/5 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-purple-500/15 flex items-center gap-1.5">
        <svg
          width="11" height="11" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className="text-purple-500/70"
        >
          <path d="M2 8h3l2-4 2 8 2-4h3" />
        </svg>
        <span className="text-[11px] font-semibold text-purple-500/80 uppercase tracking-wide">
          {hybridLabel}
        </span>
        <span className="ml-auto text-[10px] text-text-tertiary">
          Mimo {mimoLen}字 · 本地 {localLen}字
        </span>
      </div>

      {/* Side-by-side transcripts */}
      <div className="grid grid-cols-2 divide-x divide-purple-500/10">
        {/* Mimo column */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            <span className="text-[10px] font-medium text-text-muted">{mimoLabel}</span>
          </div>
          <p className="text-[11px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {mimoText || '—'}
          </p>
        </div>
        {/* Local column */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span className="text-[10px] font-medium text-text-muted">{localLabel}</span>
          </div>
          <p className="text-[11px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {localText || '—'}
          </p>
        </div>
      </div>

      {/* Metrics bar */}
      <div className="px-3 py-2 border-t border-purple-500/10 flex items-center gap-4 text-[10px]">
        <span className="text-text-tertiary">
          长度比:{' '}
          <span className={`font-semibold ${agreeColor}`}>{ratio}%</span>
        </span>
        <span className="text-text-tertiary">
          差异:{' '}
          <span className={`font-semibold ${delta <= 10 ? 'text-success' : 'text-warning'}`}>
            {delta}字
          </span>
        </span>
        <span
          className={`ml-auto font-medium ${
            ratio >= 80 && ratio <= 120 ? 'text-success' : 'text-warning'
          }`}
        >
          {ratio >= 80 && ratio <= 120 ? '✓ 高度一致' : '⚠ 注意差异'}
        </span>
      </div>
    </div>
  );
}
