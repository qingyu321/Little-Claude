import { create } from 'zustand';

// --- Types ---

export type AgentPhase = 'spawning' | 'thinking' | 'writing' | 'tool' | 'completed' | 'error';

export interface AgentNode {
  id: string;
  parentId: string | null;
  description: string;
  phase: AgentPhase;
  currentTool?: string;
  startTime: number;
  endTime?: number;
  isMain: boolean;
}

interface AgentState {
  agents: Map<string, AgentNode>;
  /** Per-session agent cache for tab switching */
  agentCache: Map<string, Map<string, AgentNode>>;

  upsertAgent: (node: Partial<AgentNode> & { id: string }) => void;
  updatePhase: (id: string, phase: AgentPhase, currentTool?: string) => void;
  completeAgent: (id: string, phase?: AgentPhase) => void;
  completeAll: (phase?: AgentPhase) => void;
  clearAgents: () => void;
  /** Save current agents to cache for a tab */
  saveToCache: (tabId: string) => void;
  /** Restore agents from cache for a tab (returns true if found) */
  restoreFromCache: (tabId: string) => boolean;
  /** Apply an updater to the cached agent snapshot for a tab, leaving the
   *  live `agents` map untouched. Used by the background stream path (A4) so
   *  agent progress from non-active sessions accumulates into their per-tab
   *  cache instead of being dropped. */
  updateAgentsForTab: (
    tabId: string,
    updater: (agents: Map<string, AgentNode>) => void,
  ) => void;
  /** Drop the cached agents for a tab (called when the tab is removed) */
  removeCache: (tabId: string) => void;
}

// --- Store ---

export const useAgentStore = create<AgentState>()((set, get) => ({
  agents: new Map(),
  agentCache: new Map(),

  upsertAgent: (node) => {
    const next = new Map(get().agents);
    const existing = next.get(node.id);
    next.set(node.id, { ...existing, ...node } as AgentNode);
    set({ agents: next });
  },

  updatePhase: (id, phase, currentTool) => {
    const agent = get().agents.get(id);
    if (
      !agent ||
      agent.phase === 'completed' ||
      agent.phase === 'error' ||
      // Same-value guard: updatePhase is called on EVERY text_delta/thinking_delta
      // (~60Hz during streaming). Skipping the Map copy + set() when nothing
      // changed stops the whole AgentPanel tree from re-rendering per frame.
      (agent.phase === phase && agent.currentTool === currentTool)
    ) {
      return;
    }
    const next = new Map(get().agents);
    next.set(id, { ...agent, phase, currentTool });
    set({ agents: next });
  },

  completeAgent: (id, phase = 'completed') => {
    const next = new Map(get().agents);
    const agent = next.get(id);
    if (agent && agent.phase !== 'completed' && agent.phase !== 'error') {
      next.set(id, { ...agent, phase, endTime: Date.now(), currentTool: undefined });
      set({ agents: next });
    }
  },

  completeAll: (phase = 'completed') => {
    const next = new Map(get().agents);
    let changed = false;
    for (const [id, agent] of next) {
      if (agent.phase !== 'completed' && agent.phase !== 'error') {
        next.set(id, { ...agent, phase, endTime: Date.now(), currentTool: undefined });
        changed = true;
      }
    }
    if (changed) set({ agents: next });
  },

  clearAgents: () => set({ agents: new Map() }),

  saveToCache: (tabId) => {
    const next = new Map(get().agentCache);
    next.set(tabId, new Map(get().agents));
    set({ agentCache: next });
  },

  restoreFromCache: (tabId) => {
    const cached = get().agentCache.get(tabId);
    if (!cached) {
      set({ agents: new Map() });
      return false;
    }
    set({ agents: new Map(cached) });
    return true;
  },

  updateAgentsForTab: (tabId, updater) => {
    const nextCache = new Map(get().agentCache);
    const snapshot = nextCache.get(tabId);
    const working = snapshot ? new Map(snapshot) : new Map<string, AgentNode>();
    updater(working);
    nextCache.set(tabId, working);
    set({ agentCache: nextCache });
  },

  removeCache: (tabId) => {
    const next = new Map(get().agentCache);
    next.delete(tabId);
    set({ agentCache: next });
  },
}));

// --- Helpers ---

/** Same-value-guarded updatePhase applied to an arbitrary snapshot Map
 *  (background stream path). Mirrors the live `updatePhase` guard so the
 *  ~60Hz text_delta stream doesn't rebuild the cache Map every frame.
 *  Returns true if the node changed. */
export function updatePhaseInSnapshot(
  agents: Map<string, AgentNode>,
  id: string,
  phase: AgentPhase,
  currentTool?: string,
): boolean {
  const agent = agents.get(id);
  if (
    !agent ||
    agent.phase === 'completed' ||
    agent.phase === 'error' ||
    (agent.phase === phase && agent.currentTool === currentTool)
  ) {
    return false;
  }
  agents.set(id, { ...agent, phase, currentTool });
  return true;
}

/** Resolve which agent a stream event belongs to based on parent_tool_use_id */
export function resolveAgentId(
  parentToolUseId: string | null | undefined,
  agents: Map<string, AgentNode>,
): string {
  if (!parentToolUseId) return 'main';
  if (agents.has(parentToolUseId)) return parentToolUseId;
  return 'main';
}

/** Compute nesting depth of an agent (main = 0, direct sub-agent = 1, etc.) */
export function getAgentDepth(
  agentId: string,
  agents: Map<string, AgentNode>,
): number {
  let depth = 0;
  let current = agents.get(agentId);
  while (current && !current.isMain && current.parentId) {
    depth++;
    current = agents.get(current.parentId);
    if (depth > 10) break; // safety guard against cycles
  }
  return depth;
}
