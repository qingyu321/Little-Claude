import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../lib/i18n';
import { INTERVIEW_PRESETS, applyPreset } from '../../lib/interview-presets';
import { bridge, onLocalAsrDownloadProgress } from '../../lib/tauri-bridge';

type TestResult = {
  ok: boolean;
  model: string;
  latencyMs: number;
  status?: number;
  error?: string;
};

export default function InterviewHelperTab() {
  const t = useT();
  const mimoModel = useSettingsStore((s) => s.interviewMimoModel);
  const mimoBaseUrl = useSettingsStore((s) => s.interviewMimoBaseUrl);
  const mimoApiKey = useSettingsStore((s) => s.interviewMimoApiKey);
  const mimoApiKeyEnv = useSettingsStore((s) => s.interviewMimoApiKeyEnv);
  const preset = useSettingsStore((s) => s.interviewPreset);
  const asrModel = useSettingsStore((s) => s.interviewAsrModel);
  const isSingleHop = useSettingsStore((s) => s.interviewIsSingleHop);
  const answerPrompt = useSettingsStore((s) => s.interviewAnswerPrompt);
  const maxTokens = useSettingsStore((s) => s.interviewMaxTokens);
  const temperature = useSettingsStore((s) => s.interviewTemperature);
  const setMimoModel = useSettingsStore((s) => s.setInterviewMimoModel);
  const setMimoBaseUrl = useSettingsStore((s) => s.setInterviewMimoBaseUrl);
  const setMimoApiKey = useSettingsStore((s) => s.setInterviewMimoApiKey);
  const setMimoApiKeyEnv = useSettingsStore((s) => s.setInterviewMimoApiKeyEnv);
  const setInterviewPreset = useSettingsStore((s) => s.setInterviewPreset);
  const setInterviewAsrModel = useSettingsStore((s) => s.setInterviewAsrModel);
  const setInterviewIsSingleHop = useSettingsStore((s) => s.setInterviewIsSingleHop);
  const setInterviewAnswerPrompt = useSettingsStore((s) => s.setInterviewAnswerPrompt);
  const setInterviewMaxTokens = useSettingsStore((s) => s.setInterviewMaxTokens);
  const setInterviewTemperature = useSettingsStore((s) => s.setInterviewTemperature);

  const [testResults, setTestResults] = useState<Record<string, TestResult> | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // ── Local ASR model management ──
  const [localAsrRuntime, setLocalAsrRuntime] = useState<{ available: boolean; engine: string; version: string } | null>(null);
  const [asrModelLocal, setAsrModelLocal] = useState<{ installed: boolean; model_dir: string; files: string[] } | null>(null);
  const [localAsrDownloading, setLocalAsrDownloading] = useState(false);
  const [localAsrDownloadProgress, setLocalAsrDownloadProgress] = useState('');
  const [localAsrDownloadError, setLocalAsrDownloadError] = useState('');
  const [localAsrChecking, setLocalAsrChecking] = useState(false);

  const checkAsrEnv = useCallback(async () => {
    setLocalAsrChecking(true);
    try {
      const [rt, model] = await Promise.all([
        bridge.checkLocalAsrRuntime().catch(() => null),
        bridge.checkLocalAsrModel().catch(() => null),
      ]);
      setLocalAsrRuntime(rt);
      setAsrModelLocal(model);
    } catch {
      // silent
    } finally {
      setLocalAsrChecking(false);
    }
  }, []);

  useEffect(() => { checkAsrEnv(); }, [checkAsrEnv]);

  // Download progress listener
  useEffect(() => {
    const unlisten = onLocalAsrDownloadProgress((p: any) => {
      setLocalAsrDownloadProgress(`${p.current}/${p.total} ${p.file}`);
      if (p.status === 'done' && p.current >= p.total) {
        setLocalAsrDownloading(false);
        setLocalAsrDownloadProgress('');
        setLocalAsrDownloadError('');
        checkAsrEnv();
      }
    });
    return () => { unlisten.then((fn: () => void) => fn()).catch(() => {}); };
  }, [checkAsrEnv]);

  const handleDownloadAsr = useCallback(async () => {
    setLocalAsrDownloading(true);
    setLocalAsrDownloadProgress('');
    setLocalAsrDownloadError('');
    try {
      // mirrorIndex=undefined → 自动尝试所有镜像源
      await bridge.downloadLocalAsrModel(undefined);
    } catch (e: any) {
      setLocalAsrDownloadError(typeof e === 'string' ? e : e?.message || String(e));
      setLocalAsrDownloading(false);
    }
  }, []);

  const handlePresetChange = (presetId: string) => {
    const p = INTERVIEW_PRESETS[presetId];
    if (!p) return;
    setInterviewPreset(presetId as 'mimo' | 'openai' | 'custom');
    const fields = applyPreset(p);
    setInterviewAsrModel(fields.asrModel);
    setInterviewIsSingleHop(fields.isSingleHop);
    setInterviewAnswerPrompt(fields.answerPrompt);
    setInterviewMaxTokens(fields.maxTokens);
    setInterviewTemperature(fields.temperature);
    // Preset model → 仅当用户未手动填写时覆盖，避免覆盖自定义输入
    if (presetId !== 'custom') {
      setMimoModel(fields.model);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResults(null);
    setTestError(null);
    try {
      const results = await bridge.interviewTestMimo(
        mimoBaseUrl,
        mimoApiKey || '',
        mimoApiKeyEnv || undefined,
        mimoModel || '',
        asrModel || '',
        isSingleHop,
      );
      setTestResults(results);
    } catch (e: any) {
      setTestError(typeof e === 'string' ? e : e?.message || 'Unknown error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-[15px] font-medium text-text-primary">
          {t('settings.interview.title')}
        </h3>
        <p className="mt-1.5 text-[12px] text-text-tertiary leading-relaxed max-w-xl">
          {t('settings.interview.desc')}
        </p>
      </div>

      {/* Provider Preset Selector */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary p-5 max-w-xl space-y-4">
        <div>
          <h4 className="text-[13px] font-medium text-text-primary">
            Provider 预设
          </h4>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            选择预配置的 API 方案，或手动填写自定义参数。切换预设将自动填充对应字段。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {Object.values(INTERVIEW_PRESETS).map((p) => (
            <button
              key={p.id}
              onClick={() => handlePresetChange(p.id)}
              className={`px-4 py-2 rounded-lg text-[12px] font-medium transition-smooth border ${
                preset === p.id
                  ? 'bg-accent/10 border-accent/40 text-accent'
                  : 'bg-bg-tertiary/50 border-border-subtle text-text-secondary hover:border-border-focus'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* API Connection */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary p-5 max-w-xl space-y-4">
        <div>
          <h4 className="text-[13px] font-medium text-text-primary">
            API 连接
          </h4>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            所有 Provider 均需 OpenAI 兼容端点。
          </p>
        </div>

        {/* Base URL */}
        <div className="space-y-1">
          <label className="text-[12px] font-medium text-text-secondary">
            API Base URL
          </label>
          <input
            type="text"
            value={mimoBaseUrl}
            onChange={(e) => setMimoBaseUrl(e.target.value)}
            placeholder="https://api.xiaomimimo.com/v1"
            className="w-full max-w-[320px] px-3 py-2 rounded-lg text-[13px]
              bg-bg-secondary border border-border-subtle text-text-primary
              focus:outline-none focus:ring-1.5 focus:ring-accent/40"
          />
        </div>

        {/* API Key (inline) */}
        <div className="space-y-1">
          <label className="text-[12px] font-medium text-text-secondary">
            API Key (直接填写)
          </label>
          <input
            type="password"
            value={mimoApiKey}
            onChange={(e) => setMimoApiKey(e.target.value)}
            placeholder="sk-..."
            className="w-full max-w-[320px] px-3 py-2 rounded-lg text-[13px]
              bg-bg-secondary border border-border-subtle text-text-primary
              focus:outline-none focus:ring-1.5 focus:ring-accent/40"
          />
        </div>

        {/* API Key Env Var */}
        <div className="space-y-1">
          <label className="text-[12px] font-medium text-text-secondary">
            API Key (环境变量名)
          </label>
          <input
            type="text"
            value={mimoApiKeyEnv}
            onChange={(e) => setMimoApiKeyEnv(e.target.value)}
            placeholder="如 MIMO_API_KEY"
            className="w-full max-w-[320px] px-3 py-2 rounded-lg text-[13px]
              bg-bg-secondary border border-border-subtle text-text-primary
              focus:outline-none focus:ring-1.5 focus:ring-accent/40"
          />
          <p className="text-[10px] text-text-tertiary">
            优先使用环境变量，留空则使用上方直接填写的 Key
          </p>
        </div>
      </div>

      {/* Model Configuration */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary p-5 max-w-xl space-y-4">
        <div>
          <h4 className="text-[13px] font-medium text-text-primary">
            模型参数
          </h4>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            选择预设后自动填充，也可手动调整。
          </p>
        </div>

        {/* Answer Model */}
        <div className="space-y-1">
          <label className="text-[12px] font-medium text-text-secondary">
            答题模型
          </label>
          <input
            type="text"
            value={mimoModel}
            onChange={(e) => setMimoModel(e.target.value)}
            placeholder="mimo-v2.5-pro"
            className="w-full max-w-[280px] px-3 py-2 rounded-lg text-[13px]
              bg-bg-secondary border border-border-subtle text-text-primary
              focus:outline-none focus:ring-1.5 focus:ring-accent/40"
          />
        </div>

        {/* ASR Model (hidden in single-hop mode) */}
        {!isSingleHop && (
          <div className="space-y-1">
            <label className="text-[12px] font-medium text-text-secondary">
              ASR 模型
            </label>
            <input
              type="text"
              value={asrModel}
              onChange={(e) => setInterviewAsrModel(e.target.value)}
              placeholder="mimo-v2.5-asr"
              className="w-full max-w-[280px] px-3 py-2 rounded-lg text-[13px]
                bg-bg-secondary border border-border-subtle text-text-primary
                focus:outline-none focus:ring-1.5 focus:ring-accent/40"
            />
          </div>
        )}

        {/* Mode indicator */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-tertiary">处理模式：</span>
          <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
            isSingleHop
              ? 'bg-purple-500/10 text-purple-400'
              : 'bg-blue-500/10 text-blue-400'
          }`}>
            {isSingleHop ? '单跳（ASR+回答一体）' : '两跳（ASR → 回答）'}
          </span>
        </div>

        {/* Answer Prompt */}
        <div className="space-y-1">
          <label className="text-[12px] font-medium text-text-secondary">
            回答提示词
          </label>
          <textarea
            value={answerPrompt}
            onChange={(e) => setInterviewAnswerPrompt(e.target.value)}
            rows={3}
            className="w-full max-w-[400px] px-3 py-2 rounded-lg text-[12px]
              bg-bg-secondary border border-border-subtle text-text-primary
              focus:outline-none focus:ring-1.5 focus:ring-accent/40 resize-y"
          />
        </div>

        {/* Max Tokens + Temperature */}
        <div className="flex gap-4">
          <div className="space-y-1 flex-1">
            <label className="text-[12px] font-medium text-text-secondary">
              Max Tokens
            </label>
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => setInterviewMaxTokens(Math.max(1, parseInt(e.target.value) || 512))}
              min={1}
              max={4096}
              className="w-full max-w-[120px] px-3 py-2 rounded-lg text-[13px]
                bg-bg-secondary border border-border-subtle text-text-primary
                focus:outline-none focus:ring-1.5 focus:ring-accent/40"
            />
          </div>
          <div className="space-y-1 flex-1">
            <label className="text-[12px] font-medium text-text-secondary">
              Temperature
            </label>
            <input
              type="number"
              value={temperature}
              onChange={(e) => setInterviewTemperature(Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)))}
              min={0}
              max={2}
              step={0.1}
              className="w-full max-w-[120px] px-3 py-2 rounded-lg text-[13px]
                bg-bg-secondary border border-border-subtle text-text-primary
                focus:outline-none focus:ring-1.5 focus:ring-accent/40"
            />
          </div>
        </div>
      </div>

      {/* Local ASR Model */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary p-5 max-w-xl space-y-4">
        <div>
          <h4 className="text-[13px] font-medium text-text-primary">
            本地语音识别模型 (sherpa-onnx)
          </h4>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            SenseVoice 离线 ASR，~80MB。下载后可在面试面板切换至"本地"引擎，无需云端 API 即可转录。
          </p>
        </div>

        {/* Status */}
        <div className="flex items-center gap-4 text-[11px]">
          <span className="text-text-tertiary">运行时:</span>
          {localAsrChecking ? (
            <span className="text-text-muted">检测中…</span>
          ) : localAsrRuntime ? (
            <span className={localAsrRuntime.available ? 'text-success font-medium' : 'text-warning font-medium'}>
              {localAsrRuntime.available ? '✓ 已编译 (' + localAsrRuntime.engine + ')' : '⚠ 未编译（需 local-asr feature）'}
            </span>
          ) : (
            <span className="text-error">检测失败</span>
          )}
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="text-text-tertiary">模型:</span>
          {localAsrChecking ? (
            <span className="text-text-muted">检测中…</span>
          ) : asrModelLocal ? (
            <span className={asrModelLocal.installed ? 'text-success font-medium' : 'text-text-muted'}>
              {asrModelLocal.installed
                ? `✓ 已安装 (${asrModelLocal.model_dir})`
                : '未安装'}
            </span>
          ) : (
            <span className="text-error">检测失败</span>
          )}
        </div>

        {/* Download button */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleDownloadAsr}
            disabled={localAsrDownloading || localAsrChecking}
            className="px-4 py-2 rounded-lg text-[12px] font-medium transition-smooth
              bg-accent text-white hover:bg-accent/90
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {localAsrDownloading ? '下载中（自动尝试所有镜像）…' : '下载模型'}
          </button>
          <button
            onClick={checkAsrEnv}
            disabled={localAsrChecking || localAsrDownloading}
            className="px-3 py-2 rounded-lg text-[11px] font-medium transition-smooth
              bg-bg-tertiary text-text-secondary border border-border-subtle
              hover:border-border-focus disabled:opacity-40 disabled:cursor-not-allowed"
          >
            刷新检测
          </button>
        </div>
        <p className="text-[10px] text-text-tertiary">
          自动依次尝试 ModelScope → HF-Mirror → HuggingFace。若全部失败，可设置系统环境变量 <code className="text-[10px] bg-bg-tertiary px-1 rounded">https_proxy</code> 后重启应用重试。
        </p>

        {/* Download progress */}
        {localAsrDownloading && localAsrDownloadProgress && (
          <p className="text-[11px] text-blue-400">{localAsrDownloadProgress}</p>
        )}

        {/* Download error */}
        {localAsrDownloadError && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-[11px] text-red-400 space-y-1">
            <p className="font-medium">下载失败</p>
            <p className="opacity-80 break-all">{localAsrDownloadError}</p>
            <p className="text-text-tertiary">
              可能原因：网络不通、镜像不可用、磁盘空间不足。可尝试切换镜像重试。
            </p>
          </div>
        )}
      </div>

      {/* Test Connection */}
      <div className="rounded-xl border border-border-subtle bg-bg-secondary p-5 max-w-xl space-y-4">
        <div>
          <h4 className="text-[13px] font-medium text-text-primary">
            测试连接
          </h4>
          <p className="mt-1 text-[11px] text-text-tertiary leading-relaxed">
            向答题模型（和 ASR 模型）发送轻量请求，验证端点和 API key 是否有效。不会消耗有意义的 token。
          </p>
        </div>

        <button
          onClick={handleTest}
          disabled={testing || !mimoBaseUrl}
          className="px-4 py-2 rounded-lg text-[12px] font-medium transition-smooth
            bg-accent text-white hover:bg-accent/90
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {testing ? '测试中…' : '测试连接'}
        </button>

        {/* Test Results */}
        {testError && (
          <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-[12px] text-red-400">
            {testError}
          </div>
        )}
        {testResults && (
          <div className="mt-3 space-y-2">
            {Object.entries(testResults).map(([key, r]) => (
              <div
                key={key}
                className={`p-3 rounded-lg text-[12px] border ${
                  r.ok
                    ? 'bg-green-500/10 border-green-500/20 text-green-400'
                    : 'bg-red-500/10 border-red-500/20 text-red-400'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${r.ok ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="font-medium capitalize">{key}</span>
                  <span className="text-text-tertiary">
                    {r.model} · {r.latencyMs}ms · HTTP {r.status ?? '—'}
                  </span>
                </div>
                {r.error && (
                  <div className="mt-1 text-[11px] opacity-80 truncate">{r.error}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
