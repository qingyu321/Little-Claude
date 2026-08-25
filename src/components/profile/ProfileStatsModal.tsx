import { useEffect, useMemo, useState } from 'react';
import { bridge, ProfileStats } from '../../lib/tauri-bridge';
import type { ProfileDailyStats } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { displayDeepSeekModelName } from '../../lib/model-utils';
import { dataUrlToBlobUrl } from '../../lib/blob-url';
import { useT } from '../../lib/i18n';
import { friendlyError } from '../../lib/error-format';

interface Props {
  open: boolean;
  onClose: () => void;
}

type ActivityView = 'daily' | 'weekly' | 'total';
type TokenMetric = 'total' | 'input' | 'output' | 'cache';

// 每日口径对应的明细字段（后端 daily[] 本就带 input/output/cache 拆分，
// 此前只渲染了语义 total）。「总量」= 语义 total（含缓存、DeepSeek 输入
// 已含缓存不重复加），与热力图/模型行/Ctx 条同口径。
function metricValue(day: ProfileDailyStats, metric: TokenMetric): number {
  switch (metric) {
    case 'input': return day.input_tokens || 0;
    case 'output': return day.output_tokens || 0;
    case 'cache': return day.cache_tokens || 0;
    default: return day.total_tokens || 0;
  }
}

// 指标条配色：输入/输出/缓存用独立语义色，总量保持主色
const METRIC_BAR_CLASS: Record<TokenMetric, string> = {
  total: 'bg-accent',
  input: 'bg-accent-light',
  output: 'bg-success',
  cache: 'bg-warning',
};

function formatTokens(value: number, unitYi: string, unitWan: string): string {
  if (!value) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}${unitYi}`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}${unitWan}`;
  return value.toLocaleString();
}

function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

function heatColor(level: number): string {
  switch (level) {
    case 4: return '#e98d82';
    case 3: return '#f2aaa0';
    case 2: return '#f6c8b8';
    case 1: return '#f7ded0';
    default: return 'rgba(188, 144, 123, 0.13)';
  }
}

function monthLabel(date: Date, t: (k: string, p?: Record<string, string>) => string): string {
  return t('profile.monthLabel', { n: String(date.getMonth() + 1) });
}

export function ProfileStatsModal({ open, onClose }: Props) {
  const t = useT();
  const fmt = (v: number) => formatTokens(v, t('profile.unitYi'), t('profile.unitWan'));
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<ActivityView>('daily');
  const [metric, setMetric] = useState<TokenMetric>('total');
  const userAvatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const userDisplayName = useSettingsStore((s) => s.userDisplayName);

  const loadStats = async () => {
    setLoading(true);
    setError('');
    try {
      setStats(await bridge.getProfileStats());
    } catch (err) {
      // A5: 原始错误经分类器转成友好文案
      setError(friendlyError(String(err)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadStats();
  }, [open]);

  // 默认口径 = 语义 total（新输入 + 缓存 + 输出，DeepSeek 输入已含缓存则不重复加，
  // 与后端 scan_profile_stats 的 total_tokens / 模型行 / Ctx 条同口径）。
  // 之前用「输入+输出」会漏掉 Anthropic 风格记录的缓存命中（input 不含缓存），
  // 缓存重的日子直接从"亿"级掉到"百万"级。
  // metric 切换（总量/输入/输出/缓存）作用于热力图、每日条、每周条与峰值日。
  const dailyMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of stats?.daily ?? []) {
      if (day.date !== 'unknown') {
        map.set(day.date, metricValue(day, metric));
      }
    }
    return map;
  }, [stats, metric]);

  const heatmap = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let start = addDays(today, -364);
    start = addDays(start, -start.getDay());

    const days: { date: Date; key: string; tokens: number }[] = [];
    for (let d = start; d <= today; d = addDays(d, 1)) {
      const key = dateKey(d);
      days.push({ date: d, key, tokens: dailyMap.get(key) ?? 0 });
    }

    const weeks: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
    return weeks;
  }, [dailyMap]);

  const maxDay = useMemo(() => {
    let max = 0;
    for (const v of dailyMap.values()) {
      if (v > max) max = v;
    }
    return max;
  }, [dailyMap]);

  const recentDaily = useMemo(() => {
    return [...(stats?.daily ?? [])]
      .filter((d) => d.date !== 'unknown')
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 14);
  }, [stats]);

  const weekly = useMemo(() => {
    const weeks: { label: string; tokens: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 7; i >= 0; i -= 1) {
      const end = addDays(today, -i * 7);
      const start = addDays(end, -6);
      let tokens = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) {
        tokens += dailyMap.get(dateKey(d)) ?? 0;
      }
      weeks.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, tokens });
    }
    return weeks;
  }, [dailyMap]);

  const maxWeek = Math.max(...weekly.map((w) => w.tokens), 1);
  const displayName = userDisplayName.trim() || t('profile.defaultUser');
  const barClass = METRIC_BAR_CLASS[metric];

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center px-6 py-8"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/25 backdrop-blur-sm" />
      <div className="relative w-[min(1120px,calc(100vw-48px))] max-h-[calc(100vh-64px)]
        overflow-hidden rounded-[24px] border border-border-subtle bg-bg-card shadow-2xl
        animate-in fade-in zoom-in-95 duration-200">
        <button
          onClick={onClose}
          className="absolute right-5 top-5 z-10 p-2 rounded-full text-text-muted
            hover:text-text-primary hover:bg-bg-secondary transition-smooth"
          title={t('common.dismiss')}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <div className="overflow-y-auto max-h-[calc(100vh-64px)] px-10 py-9">
          <div className="text-center">
            <div className="mx-auto w-20 h-20 rounded-[24px] overflow-hidden shadow-sm border border-border-subtle bg-bg-secondary">
              {userAvatarUrl ? (
                // WebView2 blocks data: URIs under tauri:// — convert like UserAvatar/AiAvatar do
                <img src={dataUrlToBlobUrl(userAvatarUrl)} alt="" className="w-full h-full object-cover" />
              ) : (
                <img src="/app-icon.png" alt="" className="w-full h-full object-cover" />
              )}
            </div>
            <h2 className="mt-4 text-[28px] font-semibold text-text-primary">{displayName}</h2>
            <p className="mt-1 text-sm text-text-muted">{t('profile.subtitle')}</p>
          </div>

          {loading && (
            <div className="mt-10 text-center text-sm text-text-muted">{t('profile.loading')}</div>
          )}

          {error && (
            <div className="mt-8 rounded-2xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
              {t('profile.statsFailed', { error })}
            </div>
          )}

          {stats && !loading && (
            <>
              <div className="mt-9 grid grid-cols-5 rounded-[20px] border border-border-subtle bg-bg-primary/70 overflow-hidden">
                {[
                  [t('profile.totalTokens'), fmt(stats.totalTokens || 0)],
                  [t('profile.peakDayTokens'), fmt(maxDay)],
                  [t('profile.sessionCount'), stats.sessionCount.toLocaleString()],
                  [t('profile.activeDays'), t('profile.activeDaysUnit', { n: String(stats.activeDays) })],
                  [t('profile.messageCount'), stats.messageCount.toLocaleString()],
                ].map(([label, value]) => (
                  <div key={label} className="px-5 py-4 text-center border-r border-border-subtle last:border-r-0">
                    <div className="text-[18px] font-semibold text-text-primary">{value}</div>
                    <div className="mt-1 text-xs text-text-muted">{label}</div>
                  </div>
                ))}
              </div>

              <section className="mt-9">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold text-text-primary">{t('profile.tokenActivity')}</h3>
                  <div className="flex items-center gap-2">
                    <div className="inline-flex rounded-full border border-border-subtle bg-bg-primary/70 p-1">
                      {[
                        ['total', t('profile.metricTotal')],
                        ['input', t('profile.metricInput')],
                        ['output', t('profile.metricOutput')],
                        ['cache', t('profile.metricCache')],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          onClick={() => setMetric(id as TokenMetric)}
                          className={`px-3 py-1 rounded-full text-xs transition-smooth
                            ${metric === id ? 'bg-accent text-text-inverse' : 'text-text-muted hover:text-text-primary'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="inline-flex rounded-full border border-border-subtle bg-bg-primary/70 p-1">
                      {[
                        ['daily', t('profile.viewDaily')],
                        ['weekly', t('profile.viewWeekly')],
                        ['total', t('profile.viewTotal')],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          onClick={() => setView(id as ActivityView)}
                          className={`px-3 py-1 rounded-full text-xs transition-smooth
                            ${view === id ? 'bg-accent text-text-inverse' : 'text-text-muted hover:text-text-primary'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto pb-2">
                  <div className="inline-flex gap-[5px] min-w-full">
                    {heatmap.map((week, wi) => (
                      <div key={wi} className="flex flex-col gap-[5px]">
                        {week.map((day) => {
                          const level = levelFor(day.tokens, maxDay);
                          return (
                            <div
                              key={day.key}
                              title={`${day.key}: ${fmt(day.tokens)} tokens`}
                              className="w-[13px] h-[13px] rounded-[4px] border border-white/35"
                              style={{ background: heatColor(level) }}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-2 flex justify-between text-xs text-text-tertiary">
                  {heatmap
                    .filter((week) => week[0]?.date.getDate() <= 7)
                    .slice(-12)
                    .map((week) => (
                      <span key={week[0].key}>{monthLabel(week[0].date, t)}</span>
                    ))}
                </div>
              </section>

              <div className="mt-9 grid grid-cols-[1fr_0.95fr] gap-10">
                <section>
                  <h3 className="text-base font-semibold text-text-primary mb-4">{t('profile.insights')}</h3>
                  {view === 'daily' && (
                    <div className="space-y-2">
                      {recentDaily.length ? recentDaily.map((day) => (
                        <div key={day.date} className="flex items-center gap-3 text-sm">
                          <span className="w-24 text-text-muted">{day.date.slice(5)}</span>
                          <div className="h-2 flex-1 rounded-full bg-bg-secondary overflow-hidden">
                            <div
                              className={`h-full rounded-full ${barClass}`}
                              style={{ width: `${Math.max(3, metricValue(day, metric) / Math.max(maxDay, 1) * 100)}%` }}
                            />
                          </div>
                          <span className="w-20 text-right text-text-primary">
                            {fmt(metricValue(day, metric))}
                          </span>
                        </div>
                      )) : (
                        <p className="text-sm text-text-muted">{t('profile.noActivity')}</p>
                      )}
                    </div>
                  )}
                  {view === 'weekly' && (
                    <div className="space-y-2">
                      {weekly.map((week) => (
                        <div key={week.label} className="flex items-center gap-3 text-sm">
                          <span className="w-24 text-text-muted">{week.label}</span>
                          <div className="h-2 flex-1 rounded-full bg-bg-secondary overflow-hidden">
                            <div
                              className={`h-full rounded-full ${barClass}`}
                              style={{ width: `${Math.max(3, week.tokens / maxWeek * 100)}%` }}
                            />
                          </div>
                          <span className="w-20 text-right text-text-primary">{fmt(week.tokens)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {view === 'total' && (
                    <div className="space-y-3 text-sm">
                      {[
                        [t('profile.inputTokens'), stats.totalInputTokens],
                        [t('profile.cacheTokens'), stats.totalCacheTokens],
                        [t('profile.outputTokens'), stats.totalOutputTokens],
                      ].map(([label, value]) => (
                        <div key={label} className="flex items-center justify-between border-b border-border-subtle pb-2">
                          <span className="text-text-muted">{label}</span>
                          <span className="font-medium text-text-primary">{fmt(value as number)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <h3 className="text-base font-semibold text-text-primary mb-4">{t('profile.topModels')}</h3>
                  <div className="space-y-3">
                    {stats.models.length ? stats.models.map((model) => (
                      <div key={model.model} className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-xl bg-accent/15 text-accent flex items-center justify-center">
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                            stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                            <path d="M8 1.5l5.5 3.2v6.6L8 14.5l-5.5-3.2V4.7L8 1.5z" />
                            <path d="M2.8 4.9L8 8l5.2-3.1M8 8v6" />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-text-primary truncate">{displayDeepSeekModelName(model.model)}</div>
                          <div className="text-xs text-text-tertiary">{t('profile.responses', { n: String(model.message_count) })}</div>
                        </div>
                        <div className="text-sm text-text-muted">{fmt(model.total_tokens)}</div>
                      </div>
                    )) : (
                      <p className="text-sm text-text-muted">{t('profile.noModels')}</p>
                    )}
                  </div>
                </section>
              </div>

              <div className="mt-8 flex justify-center">
                <button
                  onClick={loadStats}
                  className="px-4 py-2 rounded-full border border-border-subtle text-sm text-text-muted
                    hover:text-text-primary hover:bg-bg-secondary transition-smooth"
                >
                  {t('profile.refresh')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
