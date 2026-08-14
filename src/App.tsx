import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Sidebar } from './components/layout/Sidebar';
import { ChatPanel } from './components/chat/ChatPanel';
import { SecondaryPanel } from './components/layout/SecondaryPanel';
import { DynamicBackground } from './components/background/DynamicBackground';
import { Toast } from './components/shared/Toast';
import { useSettingsStore } from './stores/settingsStore';
import { useProviderStore } from './stores/providerStore';
import type { ColorTheme, FontFamily, Theme } from './stores/settingsStore';
import { useFileStore } from './stores/fileStore';
import { useChatStore } from './stores/chatStore';
import { useSessionStore } from './stores/sessionStore';
import { useAgentStore } from './stores/agentStore';
import { bridge, onFileChange } from './lib/tauri-bridge';
import { useT } from './lib/i18n';
import { debugLog } from './lib/debug-log';
import { useAutoUpdateCheck } from './hooks/useAutoUpdateCheck';
import { usePetBridge } from './hooks/usePetBridge';
import { openUrl } from '@tauri-apps/plugin-opener';

// Lazy-load heavy components not needed for first paint
const CommandPalette = lazy(() => import('./components/commands/CommandPalette').then(m => ({ default: m.CommandPalette })));
const SettingsPanel = lazy(() => import('./components/settings/SettingsPanel').then(m => ({ default: m.SettingsPanel })));
const ImageLightbox = lazy(() => import('./components/shared/ImageLightbox').then(m => ({ default: m.ImageLightbox })));
const ChangelogModal = lazy(() => import('./components/shared/ChangelogModal').then(m => ({ default: m.ChangelogModal })));
const InterviewConfirmModal = lazy(() => import('./components/interview/InterviewConfirmModal').then(m => ({ default: m.InterviewConfirmModal })));
const OnboardingWizard = lazy(() => import('./components/onboarding/OnboardingWizard').then(m => ({ default: m.OnboardingWizard })));

/** Accent colors per theme for the slash in the icon */
const THEME_ACCENT_COLORS: Record<ColorTheme, string> = {
  black: '#FFFFFF',
  blue: '#4E80F7',
  orange: '#C47252',
  green: '#57A64B',
};

const FONT_FAMILY_STACKS: Record<FontFamily, string> = {
  system: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif',
  microsoft: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif',
  sourceHan: '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  lxgw: '"LXGW WenKai Screen", "LXGW WenKai", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Microsoft YaHei UI", monospace',
};

/** Render the app icon SVG as base64 PNG for macOS Dock.
 *  Uses the bundled watercolor app icon so dock and window branding match. */
function renderIconPng(_accentColor: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const size = 512;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, size, size);
      const dataUrl = canvas.toDataURL('image/png');
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror = () => {
      reject(new Error('Failed to render icon'));
    };
    img.src = '/app-icon.png';
  });
}

async function updateDockIcon(colorTheme: ColorTheme, _theme: Theme) {
  try {
    const accentColor = THEME_ACCENT_COLORS[colorTheme];
    const pngBase64 = await renderIconPng(accentColor);
    await bridge.setDockIcon(pngBase64);
  } catch {
    // Silently ignore on non-macOS or errors
  }
}

function App() {
  const pageStart = window.__LITTLE_CLAUDE_PAGE_START || 0;
  if (typeof performance !== 'undefined' && !performance.getEntriesByName('app-first-render')[0]) {
    performance.mark('app-first-render');
    debugLog('general', `first render mounted @ ${(performance.now() - pageStart).toFixed(0)}ms from page start`);
  }
  const theme = useSettingsStore((s) => s.theme);
  const colorTheme = useSettingsStore((s) => s.colorTheme);
  const backgroundTheme = useSettingsStore((s) => s.backgroundTheme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const monoFontFollowsInterface = useSettingsStore((s) => s.monoFontFollowsInterface);
  const settingsOpen = useSettingsStore((s) => s.settingsOpen);
  const onboardingOpen = useSettingsStore((s) => s.onboardingOpen);
  const setupCompleted = useSettingsStore((s) => s.setupCompleted);
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const setOnboardingOpen = useSettingsStore((s) => s.setOnboardingOpen);
  const workingDirectory = useSettingsStore((s) => s.workingDirectory);
  const lastSeenVersion = useSettingsStore((s) => s.lastSeenVersion);
  const setLastSeenVersion = useSettingsStore((s) => s.setLastSeenVersion);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const loadTree = useFileStore((s) => s.loadTree);
  const refreshTree = useFileStore((s) => s.refreshTree);
  const markFileChanged = useFileStore((s) => s.markFileChanged);
  const directoryMissing = useFileStore((s) => s.directoryMissing);
  const prevDirRef = useRef<string | null>(null);

  const t = useT();

  // Auto-check for app updates on startup
  useAutoUpdateCheck();

  // Desktop pet: aggregate session state → pet:status, handle pet:command
  usePetBridge();

  // CLI update detection: check on startup + poll every 30 minutes
  useEffect(() => {
    const checkCliUpdate = () => {
      const t0 = performance.now();
      bridge.checkCliUpdate().then((result) => {
        debugLog('general', `checkCliUpdate done in ${(performance.now() - t0).toFixed(0)}ms, update=${result.update_available}`);
        useSettingsStore.setState({
          cliUpdateAvailable: result.update_available,
          cliLatestVersion: result.latest ?? '',
        });
      }).catch(() => {}); // silently ignore
    };
    // Defer first check by 3s so the UI renders before network I/O starts.
    const timeout = setTimeout(checkCliUpdate, 3000);
    const interval = setInterval(checkCliUpdate, 30 * 60 * 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, []);

  // Confirm before closing the window (red X / Cmd+Q). B17: the confirmation
  // now carries a "don't ask again" checkbox — the native ask() can't host one,
  // so this uses a small custom dialog; the flag persists in settings
  // (confirmOnClose). When unchecked, closing exits immediately.
  const confirmOnClose = useSettingsStore((s) => s.confirmOnClose);
  const setConfirmOnClose = useSettingsStore((s) => s.setConfirmOnClose);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const closeNeverAgainRef = useRef(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      win.onCloseRequested(async (event) => {
        event.preventDefault();
        if (!confirmOnClose) {
          const { exit } = await import('@tauri-apps/plugin-process');
          await exit(0);
          return;
        }
        setCloseDialogOpen(true);
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, [confirmOnClose]);

  const handleCloseConfirmed = () => {
    setCloseDialogOpen(false);
    if (closeNeverAgainRef.current) setConfirmOnClose(false);
    import('@tauri-apps/plugin-process').then(({ exit }) => exit(0));
  };

  // 回归修复: 取消路径必须重置 "不再询问" ref — 勾选后取消再确认退出，
  // 残留的 ref 会静默关闭下一次的关闭确认。
  const handleCloseDialogCancel = () => {
    closeNeverAgainRef.current = false;
    setCloseDialogOpen(false);
  };

  // TK-329: On app startup (incl. browser refresh), detect and kill orphaned backend processes.
  // After refresh, frontend state (stdinToTab, listeners) is wiped, but Rust ProcessManager
  // may still hold live child processes. Kill any that have no corresponding frontend mapping.
  useEffect(() => {
    bridge.listActiveProcesses().then((activeIds) => {
      if (!activeIds.length) return;
      const { stdinToTab } = useSessionStore.getState();
      const orphaned = activeIds.filter((id) => !stdinToTab[id]);
      for (const id of orphaned) {
        debugLog('general', 'killing orphaned process:', id);
        bridge.killSession(id).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  // macOS Full Disk Access check — detect TCC restrictions on startup
  const [showPermDialog, setShowPermDialog] = useState(false);
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac');
    if (!isMac) return;
    // Skip if user previously dismissed the dialog
    if (localStorage.getItem('tokenicode-perm-dismissed')) return;
    bridge.checkFileAccess('/Users').then((ok) => {
      if (!ok) setShowPermDialog(true);
    }).catch(() => {});
  }, []);

  // Load custom session names and provider config on startup
  useEffect(() => {
    useSessionStore.getState().loadCustomPreviewsFromDisk();
    // Backend/provider alignment must run AFTER load() resolves — load()
    // awaits key decryption, so reading activeProviderPerBackend right
    // after calling it sees the empty initial state.
    useProviderStore.getState().load().then(() => {
      // DSH (deepseek backend) runs its own provider inside dsh web and
      // ignores providers.json. If a provider is active for claude/codex
      // but the header still says "deepseek", every message silently
      // bypasses the provider ("跑不通"). Switch to the provider's
      // backend so the active provider actually takes effect.
      const { activeProviderPerBackend } = useProviderStore.getState();
      const headerBackend = useSettingsStore.getState().cliBackend;
      if (headerBackend === 'deepseek') {
        if (activeProviderPerBackend.claude) {
          useSettingsStore.getState().setCliBackend('claude');
        } else if (activeProviderPerBackend.codex) {
          useSettingsStore.getState().setCliBackend('codex');
        }
      }
    });
    // Load the LiteLLM model-window table cache so getContextWindowForModel
    // resolves exact windows (262K/512K/1M…) synchronously during renders.
    bridge.loadModelWindows().then((windows) => {
      useSettingsStore.getState().setModelWindows(windows);
    }).catch(() => {});
    // Notification permission is requested lazily on first need (see useStreamProcessor.ts)
  }, []);

  // Changelog modal state
  const [showChangelog, setShowChangelog] = useState(false);
  const [currentAppVersion, setCurrentAppVersion] = useState('');

  useEffect(() => {
    // 首启时序：SetupWizard（环境）→ onboarding（功能教学）→ changelog 串行。
    // setup 未完成或教程未完成时不触发 changelog；教程完成后本 effect 重跑，
    // 此时 lastSeenVersion 仍为 ''，changelog 顺次弹出。
    if (!setupCompleted || !onboardingCompleted) return;
    import('@tauri-apps/api/app').then(({ getVersion }) =>
      getVersion().then((version) => {
        setCurrentAppVersion(version);
        if (version && version !== lastSeenVersion) {
          import('./lib/changelog').then(({ getChangelog }) => {
            if (getChangelog(version)) {
              setShowChangelog(true);
            } else {
              setLastSeenVersion(version);
            }
          });
        }
      }).catch(() => {})
    );
  }, [setupCompleted, onboardingCompleted]);

  // Onboarding: first-run feature tour. Opens once the environment setup is
  // done and the tour hasn't been completed. Deps deliberately exclude
  // onboardingOpen — closing without finishing must NOT re-trigger (loop).
  useEffect(() => {
    if (setupCompleted && !onboardingCompleted) setOnboardingOpen(true);
  }, [setupCompleted, onboardingCompleted]);

  // Disable browser context menu globally (native app feel)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow context menu only in input fields and textareas
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.isContentEditable) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // Apply dark/light mode class to document
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const apply = () => {
        if (mq.matches) root.classList.add('dark');
        else root.classList.remove('dark');
      };
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  // Apply color theme class to document
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-blue', 'theme-orange', 'theme-green');
    if (colorTheme === 'blue') {
      root.classList.add('theme-blue');
    } else if (colorTheme === 'orange') {
      root.classList.add('theme-orange');
    } else if (colorTheme === 'green') {
      root.classList.add('theme-green');
    }
    // 'black' is the default — no class needed
  }, [colorTheme]);

  // Apply watercolor background skin class to document
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('bg-theme-garden', 'bg-theme-sakura', 'bg-theme-lake', 'bg-theme-dusk', 'bg-theme-ink', 'bg-theme-vscode', 'bg-theme-minimal', 'bg-theme-deepseek');
    root.classList.add(`bg-theme-${backgroundTheme}`);
  }, [backgroundTheme]);

  // Update macOS dock icon when color theme changes
  useEffect(() => {
    updateDockIcon(colorTheme, theme);
  }, [colorTheme, theme]);

  // Apply font size to document root
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  // Apply font family to document root
  useEffect(() => {
    const stack = FONT_FAMILY_STACKS[fontFamily] || FONT_FAMILY_STACKS.microsoft;
    document.documentElement.style.setProperty('--little-claude-font-family', stack);
  }, [fontFamily]);

  useEffect(() => {
    document.documentElement.dataset.monoFollowsInterface = monoFontFollowsInterface ? 'true' : 'false';
  }, [monoFontFollowsInterface]);

  // Cmd+/- global shortcut for font size
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        useSettingsStore.getState().increaseFontSize();
      } else if (e.key === '-') {
        e.preventDefault();
        useSettingsStore.getState().decreaseFontSize();
      } else if (e.key === '0') {
        e.preventDefault();
        useSettingsStore.getState().setFontSize(14);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Ctrl+Tab: quick-switch between the two most recent sessions
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const sessionState = useSessionStore.getState();
        const { previousSessionId, selectedSessionId, sessions } = sessionState;
        if (!previousSessionId || previousSessionId === selectedSessionId) return;
        // Verify previous session still exists
        const prevSession = sessions.find((s) => s.id === previousSessionId);
        if (!prevSession) return;

        // Save current session to cache
        if (selectedSessionId) {
          useChatStore.getState().saveToCache(selectedSessionId);
          useAgentStore.getState().saveToCache(selectedSessionId);
        }

        // Close file preview
        useFileStore.getState().closePreview();

        // Switch selection (this also updates previousSessionId)
        sessionState.setSelectedSession(previousSessionId);

        // Restore from cache
        const restored = useChatStore.getState().restoreFromCache(previousSessionId);
        if (restored) {
          useAgentStore.getState().restoreFromCache(previousSessionId);
          // Restore working directory
          const projectPath = prevSession.project || prevSession.projectDir;
          if (projectPath) {
            // Resolve project path using same logic as ConversationList
            let resolved = projectPath;
            if (!projectPath.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(projectPath)) {
              if (projectPath.startsWith('~/')) {
                resolved = projectPath; // will work with home dir expansion
              } else if (/^[A-Za-z]-/.test(projectPath)) {
                const drive = projectPath[0];
                resolved = `${drive}:\\${projectPath.slice(2).replace(/-/g, '\\')}`;
              } else {
                resolved = projectPath.replace(/-/g, '/');
              }
            }
            useSettingsStore.getState().setWorkingDirectory(resolved);
          }
        } else {
          // M5: never-opened tab — no cache to restore. Clear the LIVE agent
          // tree left over from the previous tab, or AgentPanel would keep
          // showing the previous conversation's agents (the click path clears
          // via handleLoadSession; the Ctrl+Tab path had no equivalent).
          useAgentStore.getState().clearAgents();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Load file tree + start watcher when working directory changes
  useEffect(() => {
    if (!workingDirectory) return;

    // Unwatch previous directory
    if (prevDirRef.current && prevDirRef.current !== workingDirectory) {
      bridge.unwatchDirectory(prevDirRef.current).catch(() => {});
    }
    prevDirRef.current = workingDirectory;

    // Load tree and start watching
    loadTree(workingDirectory);
    bridge.watchDirectory(workingDirectory).catch(console.error);

    return () => {
      bridge.unwatchDirectory(workingDirectory).catch(() => {});
    };
  }, [workingDirectory]);

  // 报告B5: a deleted project directory kills its watcher (notify does not
  // auto-reconnect), so when the directory comes back on disk the watcher
  // would silently stay dead. Re-establish it and reload the tree on the
  // missing → present transition. watch_directory replaces stale entries
  // (Rust side), so a plain re-watch is safe and idempotent.
  useEffect(() => {
    if (!workingDirectory || directoryMissing) return;
    bridge.watchDirectory(workingDirectory).catch(console.error);
    useFileStore.getState().refreshTree();
  }, [directoryMissing, workingDirectory]);

  // Listen for file change events from the watcher
  // Debounce tree refresh for created/removed events (structure changes)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unlisten = onFileChange((event) => {
      // Defense-in-depth: skip paths under noisy directories (also filtered in Rust)
      const filtered = event.paths.filter((p) =>
        !/(^|[/\\])(\.(claude|git)|node_modules|__pycache__)[/\\]/.test(p)
      );
      if (filtered.length === 0) return;

      for (const filePath of filtered) {
        markFileChanged(filePath, event.kind);
      }

      // When files are created or removed, the tree structure changes —
      // debounce a full tree reload (300ms to batch rapid changes)
      if (event.kind === 'created' || event.kind === 'removed') {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          refreshTree();
          refreshTimerRef.current = null;
        }, 300);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [markFileChanged, refreshTree]);

  return (
    <>
      <DynamicBackground />
      <AppShell
        sidebar={<Sidebar />}
        main={<ChatPanel key={selectedSessionId || 'new'} />}
        secondary={<SecondaryPanel />}
      />
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <ImageLightbox />
      </Suspense>
      <Suspense fallback={null}>
        <InterviewConfirmModal />
      </Suspense>
      {onboardingOpen && (
        <Suspense fallback={null}>
          <OnboardingWizard />
        </Suspense>
      )}
      {showChangelog && currentAppVersion && (
        <Suspense fallback={null}>
          <ChangelogModal
            version={currentAppVersion}
            onClose={() => {
              setShowChangelog(false);
              setLastSeenVersion(currentAppVersion);
            }}
          />
        </Suspense>
      )}
      {showPermDialog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-bg-primary rounded-2xl border border-border-subtle shadow-2xl
            max-w-md w-full mx-4 overflow-hidden animate-scale-in">
            {/* Header */}
            <div className="px-6 pt-6 pb-3 flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-warning/15 flex items-center justify-center flex-shrink-0">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none"
                  stroke="currentColor" strokeWidth="1.5" className="text-warning">
                  <path d="M10 2L1.5 17h17L10 2z" />
                  <path d="M10 8v4M10 14.5v.5" />
                </svg>
              </div>
              <div>
                <h3 className="text-base font-semibold text-text-primary">{t('perm.title')}</h3>
                <p className="text-xs text-text-muted mt-1 leading-relaxed">{t('perm.desc')}</p>
              </div>
            </div>
            {/* Path hint */}
            <div className="mx-6 px-3 py-2 rounded-lg bg-bg-secondary text-[11px] text-text-tertiary font-mono">
              {t('perm.path')}
            </div>
            {/* Actions */}
            <div className="px-6 py-4 flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  localStorage.setItem('tokenicode-perm-dismissed', '1');
                  setShowPermDialog(false);
                }}
                className="px-4 py-2 rounded-lg text-xs font-medium
                  text-text-muted hover:text-text-primary hover:bg-bg-tertiary
                  transition-smooth cursor-pointer"
              >
                {t('perm.later')}
              </button>
              <button
                onClick={() => {
                  localStorage.setItem('tokenicode-perm-dismissed', '1');
                  openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
                  setShowPermDialog(false);
                }}
                className="px-4 py-2 rounded-lg text-xs font-semibold
                  bg-accent text-text-inverse hover:bg-accent-hover
                  transition-smooth cursor-pointer shadow-sm"
              >
                {t('perm.openSettings')}
              </button>
            </div>
          </div>
        </div>
      )}
      <Toast />
      {/* B17: close-confirmation dialog with "don't ask again" */}
      {closeDialogOpen && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
          onClick={handleCloseDialogCancel}
        >
          <div
            className="bg-bg-card border border-border-subtle rounded-xl p-5
              shadow-lg max-w-sm w-full mx-4 animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-text-primary mb-2">{t('confirm.exitTitle')}</h3>
            <p className="text-sm text-text-primary mb-4">{t('confirm.exit')}</p>
            <label className="flex items-center gap-2 mb-4 text-xs text-text-muted
              cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 rounded accent-accent"
                onChange={(e) => { closeNeverAgainRef.current = e.target.checked; }}
              />
              {t('confirm.dontAskAgain')}
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCloseDialogCancel}
                className="px-3 py-1.5 text-xs rounded-lg bg-bg-secondary
                  text-text-muted hover:bg-bg-tertiary transition-smooth cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCloseConfirmed}
                className="px-3 py-1.5 text-xs rounded-lg bg-accent/10 text-accent
                  hover:bg-accent/20 transition-smooth cursor-pointer"
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
