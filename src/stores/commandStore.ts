import { create } from 'zustand';
import { bridge, type UnifiedCommand } from '../lib/tauri-bridge';

interface CommandState {
  // All available commands (built-in + custom)
  commands: UnifiedCommand[];
  isLoading: boolean;

  // Prefix mode: when a custom command with $ARGUMENTS is selected
  activePrefix: UnifiedCommand | null;

  // Actions
  fetchCommands: (cwd?: string, cliBackend?: string) => Promise<void>;
  setActivePrefix: (cmd: UnifiedCommand) => void;
  clearPrefix: () => void;
}

export const useCommandStore = create<CommandState>()((set) => ({
  commands: [],
  isLoading: false,
  activePrefix: null,

  fetchCommands: async (cwd?: string, cliBackend?: string) => {
    set({ isLoading: true });
    // B3c: a slow response from a PREVIOUS cwd/backend must not overwrite
    // the command list of the current one. Guard by request sequence.
    const seq = ++_fetchSeq;
    try {
      const commands = await bridge.listAllCommands(cwd, cliBackend);
      if (seq !== _fetchSeq) return; // superseded
      set({ commands, isLoading: false });
    } catch (err) {
      if (seq !== _fetchSeq) return;
      console.error('[commandStore] fetchCommands failed:', err);
      set({ isLoading: false });
    }
  },

  setActivePrefix: (cmd) => set({ activePrefix: cmd }),
  clearPrefix: () => set({ activePrefix: null }),
}));

/** B3c: monotonically increasing fetch sequence (module-level). */
let _fetchSeq = 0;
