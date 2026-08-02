import { useEffect, useMemo, useState } from 'react';
import { bridge, type ClaudePluginInfo } from '../../lib/tauri-bridge';
import { useSettingsStore } from '../../stores/settingsStore';

type InstallScope = 'user' | 'project' | 'local';

function pluginKey(plugin: ClaudePluginInfo): string {
  return plugin.pluginId || `${plugin.name}@${plugin.marketplaceName || 'local'}`;
}

function pluginDisplayId(plugin: ClaudePluginInfo): string {
  return plugin.pluginId || plugin.name;
}

function shortSource(plugin: ClaudePluginInfo): string {
  const source = plugin.source;
  if (!source) return plugin.marketplaceName || 'local';
  if (typeof source === 'string') return source;
  if (source.path) return source.path;
  if (source.url) return source.url.replace(/^https?:\/\//, '');
  return source.source || plugin.marketplaceName || 'source';
}

function PluginCard({
  plugin,
  installed,
  busy,
  onInstall,
  onEnable,
  onDisable,
  onUpdate,
  onUninstall,
  onDetails,
}: {
  plugin: ClaudePluginInfo;
  installed: boolean;
  busy: boolean;
  onInstall: (plugin: ClaudePluginInfo) => void;
  onEnable: (plugin: ClaudePluginInfo) => void;
  onDisable: (plugin: ClaudePluginInfo) => void;
  onUpdate: (plugin: ClaudePluginInfo) => void;
  onUninstall: (plugin: ClaudePluginInfo) => void;
  onDetails: (plugin: ClaudePluginInfo) => void;
}) {
  const enabled = plugin.enabled !== false;
  return (
    <div className="px-3 py-2.5 border-b border-border-subtle hover:bg-bg-secondary/60 transition-smooth">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-text-primary truncate">{plugin.name}</span>
            {installed && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded
                ${enabled ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-muted'}`}>
                {enabled ? 'enabled' : 'disabled'}
              </span>
            )}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5 truncate">
            {plugin.marketplaceName || 'installed'} / {shortSource(plugin)}
            {plugin.installCount != null ? ` / ${plugin.installCount.toLocaleString()} installs` : ''}
          </div>
        </div>
        <button
          onClick={() => onDetails(plugin)}
          disabled={busy}
          className="p-1 rounded-md hover:bg-bg-tertiary text-text-tertiary flex-shrink-0"
          title="Details"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 7.5v4M8 4.5h.01" />
          </svg>
        </button>
      </div>
      {plugin.description && (
        <p className="text-xs text-text-muted leading-relaxed mt-1.5 line-clamp-3">
          {plugin.description}
        </p>
      )}
      <div className="flex items-center gap-1.5 mt-2">
        {installed ? (
          <>
            <button
              onClick={() => enabled ? onDisable(plugin) : onEnable(plugin)}
              disabled={busy}
              className="px-2 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover
                text-[11px] text-text-primary disabled:opacity-50"
            >
              {enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => onUpdate(plugin)}
              disabled={busy}
              className="px-2 py-1 rounded-md bg-bg-tertiary hover:bg-bg-hover
                text-[11px] text-text-primary disabled:opacity-50"
            >
              Update
            </button>
            <button
              onClick={() => onUninstall(plugin)}
              disabled={busy}
              className="px-2 py-1 rounded-md bg-error/10 hover:bg-error/15
                text-[11px] text-error disabled:opacity-50"
            >
              Uninstall
            </button>
          </>
        ) : (
          <button
            onClick={() => onInstall(plugin)}
            disabled={busy}
            className="px-2.5 py-1 rounded-md bg-accent/10 hover:bg-accent/15
              text-[11px] text-accent font-medium disabled:opacity-50"
          >
            Install
          </button>
        )}
        <span className="text-[10px] text-text-tertiary truncate">
          {busy ? 'Working...' : pluginDisplayId(plugin)}
        </span>
      </div>
    </div>
  );
}

export function PluginsPanel() {
  const cwd = useSettingsStore((s) => s.workingDirectory);
  const [installed, setInstalled] = useState<ClaudePluginInfo[]>([]);
  const [available, setAvailable] = useState<ClaudePluginInfo[]>([]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<InstallScope>('user');
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ title: string; output: string } | null>(null);

  const refresh = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await bridge.listClaudePlugins(true, cwd || undefined);
      setInstalled(result.installed || []);
      setAvailable(result.available || []);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const installedIds = useMemo(() => {
    const ids = new Set<string>();
    installed.forEach((p) => {
      ids.add(pluginKey(p));
      ids.add(p.name);
      if (p.marketplaceName) ids.add(`${p.name}@${p.marketplaceName}`);
    });
    return ids;
  }, [installed]);

  const marketplacePlugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available
      .filter((p) => !installedIds.has(pluginKey(p)) && !installedIds.has(p.name))
      .filter((p) => !q
        || p.name.toLowerCase().includes(q)
        || (p.description || '').toLowerCase().includes(q)
        || (p.marketplaceName || '').toLowerCase().includes(q))
      .slice(0, 200);
  }, [available, installedIds, query]);

  const runAction = async (plugin: ClaudePluginInfo, action: () => Promise<string>) => {
    const id = pluginDisplayId(plugin);
    setBusyId(id);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const showDetails = async (plugin: ClaudePluginInfo) => {
    const id = pluginDisplayId(plugin);
    setBusyId(id);
    setError(null);
    try {
      const output = await bridge.runClaudePluginCommand(['details', id], cwd || undefined);
      setDetails({ title: id, output: output || 'No details returned.' });
    } catch (e) {
      setDetails({ title: id, output: String(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="p-3 border-b border-border-subtle space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Claude Code Plugins</h3>
            <p className="text-[11px] text-text-tertiary mt-0.5">
              New sessions may be required after install or update.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={isLoading || !!busyId}
            className="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-tertiary disabled:opacity-50"
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5">
              <path d="M13 8a5 5 0 11-1.45-3.54" />
              <path d="M13 3.5V7h-3.5" />
            </svg>
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search plugins..."
          className="w-full px-2.5 py-1.5 rounded-lg bg-bg-secondary border border-border-subtle
            text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-focus"
        />
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-text-tertiary">Install scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as InstallScope)}
            className="bg-bg-secondary border border-border-subtle rounded-md px-2 py-1
              text-text-primary outline-none"
          >
            <option value="user">User</option>
            <option value="project">Project</option>
            <option value="local">Local</option>
          </select>
        </div>
        {error && (
          <div className="text-[11px] text-error bg-error/10 rounded-lg px-2 py-1.5">
            {error}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-3 py-2 text-[11px] font-medium text-text-tertiary uppercase tracking-wide">
          Installed / {installed.length}
        </div>
        {installed.length === 0 ? (
          <div className="px-3 pb-3 text-xs text-text-muted">No installed plugins.</div>
        ) : installed.map((plugin) => (
          <PluginCard
            key={pluginKey(plugin)}
            plugin={plugin}
            installed
            busy={busyId === pluginDisplayId(plugin)}
            onInstall={() => undefined}
            onEnable={(p) => runAction(p, () => bridge.enableClaudePlugin(pluginDisplayId(p), cwd || undefined))}
            onDisable={(p) => runAction(p, () => bridge.disableClaudePlugin(pluginDisplayId(p), cwd || undefined))}
            onUpdate={(p) => runAction(p, () => bridge.updateClaudePlugin(pluginDisplayId(p), cwd || undefined))}
            onUninstall={(p) => runAction(p, () => bridge.uninstallClaudePlugin(pluginDisplayId(p), cwd || undefined))}
            onDetails={showDetails}
          />
        ))}

        <div className="px-3 py-2 text-[11px] font-medium text-text-tertiary uppercase tracking-wide">
          Marketplace / {marketplacePlugins.length}{available.length > marketplacePlugins.length ? ` / ${available.length}` : ''}
        </div>
        {isLoading ? (
          <div className="px-3 py-6 text-center text-xs text-text-muted">Loading...</div>
        ) : marketplacePlugins.length === 0 ? (
          <div className="px-3 pb-3 text-xs text-text-muted">No matching plugins.</div>
        ) : marketplacePlugins.map((plugin) => (
          <PluginCard
            key={pluginKey(plugin)}
            plugin={plugin}
            installed={false}
            busy={busyId === pluginDisplayId(plugin)}
            onInstall={(p) => runAction(p, () => bridge.installClaudePlugin(pluginDisplayId(p), scope, cwd || undefined))}
            onEnable={() => undefined}
            onDisable={() => undefined}
            onUpdate={() => undefined}
            onUninstall={() => undefined}
            onDetails={showDetails}
          />
        ))}
      </div>

      {details && (
        <div className="border-t border-border-subtle bg-bg-card max-h-56 flex flex-col">
          <div className="px-3 py-2 flex items-center justify-between">
            <span className="text-xs font-medium text-text-primary truncate">{details.title}</span>
            <button
              onClick={() => setDetails(null)}
              className="p-1 rounded hover:bg-bg-tertiary text-text-tertiary"
              title="Close details"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </div>
          <pre className="px-3 pb-3 overflow-auto text-[11px] leading-relaxed text-text-muted whitespace-pre-wrap">
            {details.output}
          </pre>
        </div>
      )}
    </div>
  );
}
