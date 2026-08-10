import { useEffect, useRef, useState, useCallback } from 'react';
import { useT } from '../../lib/i18n';
import { bridge } from '../../lib/tauri-bridge';
import { type ApiProvider, type WebSearchFallbackConfig } from '../../stores/providerStore';

const INPUT_CLASS = 'w-full px-3 py-2 text-[13px] bg-bg-chat border border-border-subtle rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent';

type TestStatus = 'idle' | 'testing' | 'success' | 'failed';

/* SVG eye icons（同 ProviderForm） */
function EyeOpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M2 14L14 2" />
    </svg>
  );
}

interface WebSearchFallbackCardProps {
  /** 当前活跃提供商；undefined = inherit 模式（无 provider 可选）。 */
  provider: ApiProvider | undefined;
  /** 配置变更回调（null = 清除/未启用）。已做 500ms 防抖。 */
  onChange: (fb: WebSearchFallbackConfig | null) => void;
}

/**
 * "联网搜索兜底模型"配置卡：请求携带 web_search 服务端工具时，由本地代理
 * 转发到该端点执行搜索（工具名自动改写为 web_search_20250305）。
 * 挂载于 ProviderManager 底部、API 提供商列表之后。
 */
export function WebSearchFallbackCard({ provider, onChange }: WebSearchFallbackCardProps) {
  const t = useT();
  const existing = provider?.webSearchFallback;

  const [enabled, setEnabled] = useState(existing?.enabled !== false);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl || '');
  // 解密失败时 store 保留 TENC1: 密文——不在字段里显示，让用户重输
  const [apiKey, setApiKey] = useState(
    existing?.apiKey && existing.apiKey.startsWith('TENC1:') ? '' : existing?.apiKey || '',
  );
  const [showKey, setShowKey] = useState(false);
  const [envVar, setEnvVar] = useState(existing?.envVar || '');
  const [model, setModel] = useState(existing?.model || '');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testTime, setTestTime] = useState(0);

  // 切换 provider 时重置本地状态
  useEffect(() => {
    const fb = provider?.webSearchFallback;
    setEnabled(fb?.enabled !== false);
    setBaseUrl(fb?.baseUrl || '');
    setApiKey(fb?.apiKey && fb.apiKey.startsWith('TENC1:') ? '' : fb?.apiKey || '');
    setEnvVar(fb?.envVar || '');
    setModel(fb?.model || '');
    setTestStatus('idle');
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 500ms 防抖推送。onChange 必须经 ref 引用而非依赖项：ProviderManager 的
  // onChange 若每次渲染新建，push 引用随之变化 → 渲染后 effect 必跑 →
  // 防抖循环触发 updateProvider（updatedAt 变化 → 重渲染）→ debouncedSave
  // 被无限重置永不落盘。ref 模式保证 push 稳定，effect 只在字段真实变化时运行。
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const push = useCallback((fb: WebSearchFallbackConfig | null) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChangeRef.current(fb), 500);
  }, []);
  useEffect(() => {
    // baseUrl 为空 → 未配置任何内容，清除（无论开关状态）
    if (!baseUrl.trim()) {
      push(null);
      return;
    }
    const fb: WebSearchFallbackConfig = {
      // 关闭开关仅停用，内容保留（下次启动无需重输）
      enabled,
      baseUrl: baseUrl.trim(),
      // 解密失败的 TENC1 密文必须原样保留——否则整体替换 fb 会覆盖唯一副本
      ...(apiKey.trim()
        ? { apiKey: apiKey.trim() }
        : existing?.apiKey && existing.apiKey.startsWith('TENC1:')
          ? { apiKey: existing.apiKey }
          : {}),
      ...(envVar.trim() ? { envVar: envVar.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    };
    push(fb);
  }, [enabled, baseUrl, apiKey, envVar, model, push]);

  const canTest = !!baseUrl.trim() && !!apiKey.trim() && testStatus !== 'testing';

  const handleTest = useCallback(async () => {
    if (!canTest) return;
    setTestStatus('testing');
    const start = Date.now();
    try {
      const result = await bridge.testProviderConnection(
        baseUrl.trim(),
        'anthropic',
        apiKey.trim(),
        model.trim() || '',
      );
      setTestTime(Date.now() - start);
      if (result.connectivity.ok && result.auth.ok && result.model.ok) {
        setTestStatus('success');
      } else {
        setTestStatus('failed');
      }
    } catch (e) {
      setTestStatus('failed');
      console.error('[webSearchFallback] test failed:', e);
    }
  }, [canTest, baseUrl, apiKey, model]);

  const noProvider = provider === undefined;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-secondary/50 p-4 space-y-3">
      {/* 标题 + 启用开关 */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text-primary">
            {t('provider.webSearchFallback.title')}
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
            {t('provider.webSearchFallback.desc')}
          </p>
        </div>
        <label
          className={`flex items-center gap-1.5 shrink-0 select-none ${
            noProvider ? 'opacity-50 pointer-events-none' : 'cursor-pointer'
          }`}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 accent-accent"
            disabled={noProvider}
          />
          <span className="text-xs text-text-muted">{t('provider.webSearchFallback.enable')}</span>
        </label>
      </div>

      {noProvider ? (
        <p className="text-xs text-text-tertiary">{t('provider.webSearchFallback.needActive')}</p>
      ) : enabled ? (
        <>
          {/* 端点 */}
          <div>
            <label className="text-xs text-text-muted mb-1 block">
              {t('provider.webSearchFallback.baseUrl')}
            </label>
            <input
              className={INPUT_CLASS}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('provider.webSearchFallback.baseUrlPlaceholder')}
              spellCheck={false}
            />
          </div>

          {/* 密钥 */}
          <div>
            <label className="text-xs text-text-muted mb-1 block">
              {t('provider.webSearchFallback.apiKey')}
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                className={`${INPUT_CLASS} pr-8`}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('provider.webSearchFallback.apiKeyPlaceholder')}
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-muted"
                aria-label="toggle key visibility"
              >
                {showKey ? <EyeClosedIcon /> : <EyeOpenIcon />}
              </button>
            </div>
          </div>

          {/* 环境变量名 */}
          <div>
            <label className="text-xs text-text-muted mb-1 block">
              {t('provider.webSearchFallback.envVar')}
            </label>
            <input
              className={INPUT_CLASS}
              value={envVar}
              onChange={(e) => setEnvVar(e.target.value)}
              placeholder="DEEPSEEK_API_KEY"
              spellCheck={false}
            />
            <p className="text-xs text-text-tertiary mt-1">{t('provider.webSearchFallback.envVarHint')}</p>
          </div>

          {/* 模型 */}
          <div>
            <label className="text-xs text-text-muted mb-1 block">
              {t('provider.webSearchFallback.model')}
            </label>
            <input
              className={INPUT_CLASS}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('provider.webSearchFallback.modelPlaceholder')}
              spellCheck={false}
            />
            <p className="text-xs text-text-tertiary mt-1">{t('provider.webSearchFallback.modelHint')}</p>
          </div>

          <p className="text-xs text-text-tertiary leading-relaxed">
            {t('provider.webSearchFallback.toolNameHint')}
          </p>

          {/* 测试连接 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={!canTest}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-smooth
                border border-border-subtle text-text-muted hover:bg-bg-secondary
                disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {testStatus === 'testing' ? '…' : t('provider.webSearchFallback.test')}
            </button>
            {!apiKey.trim() && envVar.trim() && (
              <span className="text-xs text-text-tertiary">
                {t('provider.webSearchFallback.testNoKey')}
              </span>
            )}
            {testStatus === 'success' && (
              <span className="text-xs text-green-500">
                ✓ {testTime > 0 ? `${Math.round(testTime)}ms` : ''}
              </span>
            )}
            {testStatus === 'failed' && (
              <span className="text-xs text-red-400">✗</span>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
