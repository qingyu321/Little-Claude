import { useCallback, useEffect, useState } from 'react';
import { bridge, onLocalModelPullProgress, type LocalModelInfo } from '../../lib/tauri-bridge';
import { stripAnsi } from '../../lib/strip-ansi';
import { useProviderStore } from '../../stores/providerStore';

type ServiceState = 'checking' | 'ready' | 'missing' | 'error';

const SUGGESTED_MODELS = [
  'qwen2.5-coder:7b',
  'deepseek-r1:7b',
  'llama3.2:3b',
  'codellama:7b',
];

export function LocalModelsTab() {
  const [state, setState] = useState<ServiceState>('checking');
  const [version, setVersion] = useState('');
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [modelName, setModelName] = useState('qwen2.5-coder:7b');
  const [errorMsg, setErrorMsg] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullLines, setPullLines] = useState<string[]>([]);
  const [providerMsg, setProviderMsg] = useState('');
  const addProvider = useProviderStore((s) => s.addProvider);
  const setActiveProvider = useProviderStore((s) => s.setActive);

  const refresh = useCallback(async () => {
    setState('checking');
    setErrorMsg('');
    try {
      const result = await bridge.checkLocalModelService();
      setVersion(result.version ?? '');
      setModels(result.models);
      if (!result.installed) {
        setState('missing');
        setErrorMsg(result.error ?? 'Ollama is not installed or not available in PATH.');
      } else if (result.error) {
        setState('error');
        setErrorMsg(result.error);
      } else {
        setState('ready');
      }
    } catch (e) {
      setState('error');
      setErrorMsg(stripAnsi(String(e)));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handlePull = useCallback(async () => {
    const trimmed = modelName.trim();
    if (!trimmed || pulling) return;

    setPulling(true);
    setPullLines([]);
    setErrorMsg('');

    const unlisten = await onLocalModelPullProgress((event) => {
      if (event.model !== trimmed) return;
      const line = stripAnsi(event.line).trim();
      if (!line) return;
      setPullLines((prev) => [...prev.slice(-7), line]);
    });

    try {
      await bridge.pullLocalModel(trimmed);
      const nextModels = await bridge.listLocalModels();
      setModels(nextModels);
      setState('ready');
    } catch (e) {
      setState('error');
      setErrorMsg(stripAnsi(String(e)));
    } finally {
      unlisten();
      setPulling(false);
    }
  }, [modelName, pulling]);

  const handleUseAsProvider = useCallback((name: string) => {
    const before = new Set(useProviderStore.getState().providers.map((p) => p.id));
    addProvider({
      name: `Ollama ${name}`,
      baseUrl: 'http://localhost:11434/v1',
      apiFormat: 'openai',
      apiKey: 'ollama',
      modelMappings: [
        { tier: 'opus', providerModel: name },
        { tier: 'sonnet', providerModel: name },
        { tier: 'haiku', providerModel: name },
      ],
      preset: 'ollama',
    });

    const created = useProviderStore.getState().providers.find((p) => !before.has(p.id));
    if (created) {
      setActiveProvider(created.id);
      setProviderMsg(`已添加并启用本地模型：${name}`);
    } else {
      setProviderMsg(`已添加本地模型：${name}`);
    }
  }, [addProvider, setActiveProvider]);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-[13px] font-semibold text-text-primary">本地模型服务</h3>
        <p className="text-xs text-text-tertiary leading-relaxed">
          通过 Ollama 管理本机模型。下载完成后，可以在 API 提供商里配置 OpenAI 格式端点
          <span className="font-mono text-text-muted"> http://localhost:11434/v1</span> 使用本地模型。
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-secondary/30 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${
                state === 'ready' ? 'bg-green-500'
                  : state === 'checking' ? 'bg-amber-500 animate-pulse'
                  : 'bg-red-500'
              }`} />
              <span className="text-[13px] font-medium text-text-primary">
                {state === 'checking' ? '正在检测 Ollama...'
                  : state === 'ready' ? 'Ollama 已就绪'
                  : state === 'missing' ? '未检测到 Ollama'
                  : 'Ollama 服务异常'}
              </span>
            </div>
            {version && (
              <p className="mt-1 text-xs text-text-tertiary truncate">{version}</p>
            )}
          </div>
          <button
            onClick={refresh}
            disabled={state === 'checking' || pulling}
            className="px-3 py-1.5 rounded-lg border border-border-subtle text-xs
              text-text-muted hover:bg-bg-secondary hover:text-text-primary transition-smooth
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            刷新
          </button>
        </div>

        {errorMsg && (
          <p className="text-xs text-red-500 leading-relaxed break-words">{errorMsg}</p>
        )}

        {state === 'missing' && (
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer"
            className="inline-flex text-xs font-medium text-accent hover:underline"
          >
            打开 Ollama 下载页面
          </a>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-text-primary">下载模型</h3>
          <span className="text-xs text-text-tertiary">示例：qwen2.5-coder:7b</span>
        </div>

        <div className="flex gap-2">
          <input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            disabled={pulling}
            placeholder="输入 Ollama 模型名..."
            className="flex-1 h-9 px-3 rounded-lg bg-bg-secondary border border-border-subtle
              text-[13px] text-text-primary placeholder-text-tertiary
              outline-none focus:border-accent/60 disabled:opacity-60"
          />
          <button
            onClick={handlePull}
            disabled={pulling || !modelName.trim() || state === 'missing'}
            className="h-9 px-4 rounded-lg bg-accent text-text-inverse text-[13px] font-medium
              hover:bg-accent-hover transition-smooth disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pulling ? '下载中...' : '下载'}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {SUGGESTED_MODELS.map((name) => (
            <button
              key={name}
              onClick={() => setModelName(name)}
              disabled={pulling}
              className="px-2.5 py-1 rounded-md border border-border-subtle text-xs
                text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-smooth
                disabled:opacity-50"
            >
              {name}
            </button>
          ))}
        </div>

        {pulling && (
          <div className="rounded-lg border border-border-subtle bg-bg-tertiary/40 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span className="w-3 h-3 border-[1.5px] border-accent/30 border-t-accent rounded-full animate-spin" />
              Ollama 正在拉取模型，首次下载可能比较久
            </div>
            {pullLines.length > 0 && (
              <div className="font-mono text-[11px] text-text-tertiary space-y-1 max-h-28 overflow-y-auto">
                {pullLines.map((line, index) => (
                  <p key={`${line}-${index}`} className="truncate" title={line}>{line}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {providerMsg && (
          <p className="text-xs text-green-500">{providerMsg}</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-text-primary">已安装模型</h3>
          <span className="text-xs text-text-tertiary">{models.length} 个</span>
        </div>

        {models.length === 0 ? (
          <p className="text-[13px] text-text-tertiary py-2">还没有检测到本地模型。</p>
        ) : (
          <div className="space-y-2">
            {models.map((model) => (
              <div
                key={`${model.name}-${model.id}`}
                className="rounded-lg border border-border-subtle px-3 py-2.5 bg-bg-secondary/20"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[13px] text-text-primary truncate">{model.name}</span>
                  <span className="text-xs text-text-tertiary shrink-0">{model.size}</span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-text-tertiary">
                  <span className="font-mono truncate">{model.id}</span>
                  {model.modified && <span className="shrink-0">{model.modified}</span>}
                </div>
                <button
                  onClick={() => handleUseAsProvider(model.name)}
                  className="mt-2 px-2.5 py-1 rounded-md border border-border-subtle text-xs
                    text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-smooth"
                >
                  设为 API Provider
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
