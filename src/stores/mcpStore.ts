import { create } from 'zustand';
import { bridge } from '../lib/tauri-bridge';
import { showToast } from '../components/shared/Toast';
import { t } from '../lib/i18n';

// --- Types ---

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  type: string;
}

export interface McpServer {
  name: string;
  config: McpServerConfig;
}

export interface DiscoveredMcpServer extends McpServer {
  source: string;
  imported: boolean;
}

interface McpState {
  servers: McpServer[];
  discoveredServers: DiscoveredMcpServer[];
  isLoading: boolean;
  isScanning: boolean;
  editingServer: string | null;
  isAdding: boolean;
  scanMessage: string;

  fetchServers: () => Promise<void>;
  scanInstalledServers: () => Promise<void>;
  importDiscoveredServers: (names?: string[]) => Promise<number>;
  addServer: (name: string, config: McpServerConfig) => Promise<void>;
  updateServer: (oldName: string, newName: string, config: McpServerConfig) => Promise<void>;
  deleteServer: (name: string) => Promise<void>;
  setEditing: (name: string | null) => void;
  setAdding: (adding: boolean) => void;
}

// --- Helpers ---

/**
 * Read ~/.claude.json. This file is owned by the Claude CLI (OAuth account,
 * project history, etc.) — we must never overwrite it with a stub object.
 *
 * - File missing → return {} (first run, CLI has not created it yet).
 * - Read failure / corrupt JSON → throw, so write paths abort instead of
 *   clobbering the file with `{ "mcpServers": ... }`.
 */
async function readClaudeJson(): Promise<Record<string, unknown>> {
  const home = await bridge.getHomeDir();
  const path = `${home}/.claude.json`;
  if (!(await bridge.checkFileAccess(path))) {
    return {};
  }
  const content = await bridge.readFileContent(path);
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`~/.claude.json 解析失败（文件可能损坏），已拒绝写入: ${e}`);
  }
}

async function writeClaudeJson(data: Record<string, unknown>): Promise<void> {
  const home = await bridge.getHomeDir();
  const path = `${home}/.claude.json`;
  await bridge.writeFileContent(path, JSON.stringify(data, null, 2));
}

/** Detect and flatten double-nested mcpServers.mcpServers structure (Issue #33). */
function normalizeMcpServers(
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return raw;
  // If the only (or first) key is "mcpServers" and its value looks like a server map,
  // the user has a double-nested config — unwrap one level.
  if ('mcpServers' in raw && typeof raw.mcpServers === 'object' && raw.mcpServers !== null) {
    console.warn(
      '[mcpStore] WARNING: detected double-nested mcpServers.mcpServers in ~/.claude.json, auto-flattening',
    );
    return raw.mcpServers as Record<string, unknown>;
  }
  return raw;
}

function parseServers(mcpServers: Record<string, unknown> | undefined): McpServer[] {
  const normalized = normalizeMcpServers(mcpServers);
  if (!normalized || typeof normalized !== 'object') return [];
  return Object.entries(normalized).filter(([, raw]) => isServerConfig(raw)).map(([name, raw]) => {
    const cfg = raw as Record<string, unknown>;
    return {
      name,
      config: {
        command: (cfg.command as string) || '',
        args: Array.isArray(cfg.args) ? (cfg.args as string[]) : [],
        env: (cfg.env as Record<string, string>) || {},
        type: (cfg.type as string) || 'stdio',
      },
    };
  });
}

function isServerConfig(raw: unknown): boolean {
  return !!raw
    && typeof raw === 'object'
    && typeof (raw as Record<string, unknown>).command === 'string';
}

function getMcpRecord(data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (data.mcpServers && typeof data.mcpServers === 'object') {
    return data.mcpServers as Record<string, unknown>;
  }
  if (data.servers && typeof data.servers === 'object') {
    return data.servers as Record<string, unknown>;
  }
  if (Object.values(data).some(isServerConfig)) {
    return data;
  }
  return undefined;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await bridge.readFileContent(path));
  } catch {
    return null;
  }
}

function parseTomlString(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return trimmed;
}

function splitTomlArray(value: string): string[] {
  const body = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  const items: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const ch of body) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote === '"') {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === quote) {
      quote = '';
      current += ch;
      continue;
    }
    if (ch === ',' && !quote) {
      const item = current.trim();
      if (item) items.push(parseTomlString(item));
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) items.push(parseTomlString(tail));
  return items;
}

function parseCodexMcpServers(toml: string): McpServer[] {
  const servers: Record<string, McpServerConfig> = {};
  let currentName = '';
  let inEnv = false;

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const section = line.match(/^\[mcp_servers\.([^\].]+)(?:\.env)?\]$/);
    if (section) {
      currentName = section[1].replace(/^["']|["']$/g, '');
      inEnv = line.endsWith('.env]');
      servers[currentName] ??= { command: '', args: [], env: {}, type: 'stdio' };
      continue;
    }

    if (!currentName || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const server = servers[currentName];
    if (inEnv) {
      server.env[key] = parseTomlString(value);
    } else if (key === 'command') {
      server.command = parseTomlString(value);
    } else if (key === 'args') {
      server.args = splitTomlArray(value);
    }
  }

  return Object.entries(servers)
    .filter(([, config]) => config.command)
    .map(([name, config]) => ({ name, config }));
}

function serverKey(server: McpServer): string {
  return [
    server.name,
    server.config.command,
    server.config.args.join('\u0001'),
  ].join('\u0002').toLowerCase();
}

function mergeDiscovered(
  discovered: DiscoveredMcpServer[],
  server: McpServer,
  source: string,
  importedNames: Set<string>,
  seen: Set<string>,
) {
  const key = serverKey(server);
  if (seen.has(key)) return;
  seen.add(key);
  discovered.push({
    ...server,
    source,
    imported: importedNames.has(server.name),
  });
}

// --- Store ---

export const useMcpStore = create<McpState>()((set, get) => ({
  servers: [],
  discoveredServers: [],
  isLoading: false,
  isScanning: false,
  editingServer: null,
  isAdding: false,
  scanMessage: '',

  fetchServers: async () => {
    set({ isLoading: true });
    try {
      const json = await readClaudeJson();
      const rawMcp = json.mcpServers as Record<string, unknown> | undefined;
      // Auto-fix double-nested mcpServers.mcpServers on disk
      if (
        rawMcp &&
        typeof rawMcp === 'object' &&
        'mcpServers' in rawMcp &&
        typeof rawMcp.mcpServers === 'object'
      ) {
        json.mcpServers = rawMcp.mcpServers;
        await writeClaudeJson(json);
      }
      const servers = parseServers(json.mcpServers as Record<string, unknown> | undefined);
      set({ servers, isLoading: false });
    } catch (e) {
      console.error('[mcpStore] fetchServers failed:', e);
      set({ isLoading: false });
    }
  },

  scanInstalledServers: async () => {
    set({ isScanning: true, scanMessage: '' });
    const discovered: DiscoveredMcpServer[] = [];
    const seen = new Set<string>();
    const home = await bridge.getHomeDir();
    const currentJson = await readClaudeJson();
    const imported = parseServers(currentJson.mcpServers as Record<string, unknown> | undefined);
    const importedNames = new Set(imported.map((s) => s.name));

    try {
      for (const server of imported) {
        mergeDiscovered(discovered, server, '~/.claude.json', importedNames, seen);
      }

      const projects = currentJson.projects as Record<string, unknown> | undefined;
      if (projects && typeof projects === 'object') {
        for (const [project, raw] of Object.entries(projects)) {
          if (!raw || typeof raw !== 'object') continue;
          const mcp = (raw as Record<string, unknown>).mcpServers as Record<string, unknown> | undefined;
          for (const server of parseServers(mcp)) {
            mergeDiscovered(discovered, server, `Claude project: ${project}`, importedNames, seen);
          }
        }
      }

      for (const path of [
        `${home}/.claude/settings.json`,
        `${home}/.claude/settings.local.json`,
        `${home}/.mcp.json`,
      ]) {
        const json = await readJsonFile(path);
        const mcp = json ? getMcpRecord(json) : undefined;
        for (const server of parseServers(mcp)) {
          mergeDiscovered(discovered, server, path.replace(home, '~'), importedNames, seen);
        }
      }

      try {
        const codexToml = await bridge.readFileContent(`${home}/.codex/config.toml`);
        for (const server of parseCodexMcpServers(codexToml)) {
          mergeDiscovered(discovered, server, '~/.codex/config.toml', importedNames, seen);
        }
      } catch {
        // Codex config is optional.
      }

      set({
        discoveredServers: discovered,
        servers: imported,
        isScanning: false,
        scanMessage: discovered.length ? `扫描到 ${discovered.length} 个 MCP` : '没有扫描到 MCP 配置',
      });
    } catch (e) {
      set({ isScanning: false, scanMessage: String(e) });
    }
  },

  importDiscoveredServers: async (names) => {
    let json: any;
    try {
      json = await readClaudeJson();
    } catch (e) {
      // M5: corrupt ~/.claude.json must not leave the panel hanging.
      console.error('[mcpStore] importDiscoveredServers read failed:', e);
      showToast(t('mcp.saveFailed'), 'error');
      return 0;
    }
    const mcpServers = (json.mcpServers as Record<string, unknown>) || {};
    const existing = new Set(Object.keys(mcpServers));
    const selected = new Set(names);
    const candidates: DiscoveredMcpServer[] = get().discoveredServers.filter((server) =>
      !server.imported && !existing.has(server.name) && (!names || selected.has(server.name))
    );

    for (const server of candidates) {
      mcpServers[server.name] = {
        command: server.config.command,
        args: server.config.args,
        env: Object.keys(server.config.env).length > 0 ? server.config.env : undefined,
        type: server.config.type || 'stdio',
      };
    }

    json.mcpServers = mcpServers;
    try {
      await writeClaudeJson(json);
    } catch (e) {
      console.error('[mcpStore] importDiscoveredServers write failed:', e);
      showToast(t('mcp.saveFailed'), 'error');
      return 0;
    }
    const servers = parseServers(mcpServers);
    set((state) => ({
      servers,
      discoveredServers: state.discoveredServers.map((server) => ({
        ...server,
        imported: server.imported || candidates.some((c) => c.name === server.name),
      })),
      scanMessage: candidates.length ? `已导入 ${candidates.length} 个 MCP` : '没有可导入的 MCP',
    }));
    return candidates.length;
  },

  addServer: async (name, config) => {
    try {
      const json = await readClaudeJson();
      const mcpServers = (json.mcpServers as Record<string, unknown>) || {};
      mcpServers[name] = {
        command: config.command,
        args: config.args,
        env: Object.keys(config.env).length > 0 ? config.env : undefined,
        type: config.type,
      };
      json.mcpServers = mcpServers;
      await writeClaudeJson(json);
      const servers = parseServers(mcpServers);
      set({ servers, isAdding: false });
    } catch (e) {
      // M5: ~/.claude.json corrupt or write failure used to surface as an
      // unhandled rejection with zero user feedback.
      console.error('[mcpStore] addServer failed:', e);
      set({ isAdding: false });
      showToast(t('mcp.saveFailed'), 'error');
    }
  },

  updateServer: async (oldName, newName, config) => {
    try {
      const json = await readClaudeJson();
      const mcpServers = (json.mcpServers as Record<string, unknown>) || {};
      if (oldName !== newName) {
        // M5: renaming onto an existing server silently overwrote its
        // config (data loss). Refuse instead.
        if (mcpServers[newName] !== undefined) {
          set({ editingServer: null });
          showToast(t('mcp.nameConflict'), 'error');
          return;
        }
        delete mcpServers[oldName];
      }
      mcpServers[newName] = {
        command: config.command,
        args: config.args,
        env: Object.keys(config.env).length > 0 ? config.env : undefined,
        type: config.type,
      };
      json.mcpServers = mcpServers;
      await writeClaudeJson(json);
      const servers = parseServers(mcpServers);
      set({ servers, editingServer: null });
    } catch (e) {
      console.error('[mcpStore] updateServer failed:', e);
      set({ editingServer: null });
      showToast(t('mcp.saveFailed'), 'error');
    }
  },

  deleteServer: async (name) => {
    try {
      const json = await readClaudeJson();
      const mcpServers = (json.mcpServers as Record<string, unknown>) || {};
      delete mcpServers[name];
      json.mcpServers = mcpServers;
      await writeClaudeJson(json);
      const servers = parseServers(mcpServers);
      set((state) => ({
        servers,
        // U3: a deleted imported server used to stay marked 'imported' in
        // the scan list, making re-import impossible through the UI.
        discoveredServers: state.discoveredServers.map((s) =>
          s.name === name ? { ...s, imported: false } : s,
        ),
      }));
    } catch (e) {
      console.error('[mcpStore] deleteServer failed:', e);
      showToast(t('mcp.saveFailed'), 'error');
    }
  },

  setEditing: (name) => set({ editingServer: name, isAdding: false }),
  setAdding: (adding) => set({ isAdding: adding, editingServer: null }),
}));
