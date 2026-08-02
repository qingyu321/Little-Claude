# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

Little Claude is a native desktop GUI for Claude Code (Anthropic's CLI), built with **Tauri 2 + React 19 + TypeScript + Tailwind CSS 4 + Zustand 5**. It wraps the Claude CLI in a rich interface with multi-session tabs, file exploration, rewind/checkpoint restore, slash commands, a command palette, MCP server management, and a multi-provider API configuration system.

**Version**: 0.8.0
**Package manager**: pnpm
**Platforms**: macOS (primary), Windows (supported)

> For the full architecture reference (data flow diagrams, store relationships, component hierarchy), see **ARCHITECTURE.md**.

## Development Commands

```bash
# Install dependencies
pnpm install

# Development (Vite dev server + Tauri app)
pnpm tauri dev

# Build production app
pnpm tauri build

# Frontend only (Vite dev server on port 1420)
pnpm dev

# Type check + Vite build (frontend only)
pnpm build

# Rust checks (from src-tauri/)
cd src-tauri && cargo check && cargo clippy
```

The Tauri dev command runs `npm run dev` as its `beforeDevCommand` (configured in `tauri.conf.json`).

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, TypeScript 5.8, Tailwind CSS 4, Zustand 5 |
| Backend | Rust (Tauri 2), tokio, serde, reqwest 0.12, notify 7 |
| Rich text input | TipTap 3 (editor), CodeMirror 6 (code preview) |
| Markdown | react-markdown 10, rehype-highlight, remark-gfm |
| Build | Vite 7, @vitejs/plugin-react, @tailwindcss/vite |
| macOS native | cocoa 0.26, objc 0.2 (window customization) |
| Auto-update | tauri-plugin-updater (GitHub primary, Gitee fallback) |

## Architecture Overview

```
React UI  -->  src/lib/tauri-bridge.ts  -->  Tauri invoke()  -->  src-tauri/src/lib.rs
                                                                        |
                                                                  Claude CLI (subprocess)
                                                                  --output-format stream-json
                                                                  --permission-prompt-tool stdio
```

**IPC pattern**: All frontend-to-backend calls go through `src/lib/tauri-bridge.ts` (the single source of truth for the native API). Backend-to-frontend uses Tauri events.

**Event channels**:
- `claude:stream:{stdinId}` — NDJSON output from Claude CLI
- `claude:stderr:{stdinId}` — stderr output
- `claude:exit:{stdinId}` — process exit
- `claude:permission_request:{stdinId}` — SDK control protocol permission requests
- `fs:change` — file system watcher events
- `setup:*` — CLI installation/login progress events

### SDK Control Protocol

Little Claude uses the Claude CLI's SDK control protocol (`--permission-prompt-tool stdio`) for structured bidirectional communication:

- **CLI -> Little Claude**: Permission requests (`can_use_tool`), hook callbacks — parsed in `lib.rs`, emitted as Tauri events
- **Little Claude -> CLI**: Permission responses, runtime commands (`set_permission_mode`, `set_model`, `interrupt`, `rewind_files`) — sent via stdin pipe
- Protocol types defined in `src-tauri/src/protocol.rs`

### Claude CLI Integration

The Rust backend spawns Claude CLI as a subprocess. Key behaviors:
- First message spawns a new process with `--output-format stream-json`
- Follow-up messages are sent via **stdin pipe** (StdinManager) — no new process per message
- Session resume uses `--resume <session_id>` in a new process
- The `permission_mode` setting controls whether `--permission-prompt-tool stdio` or `--dangerously-skip-permissions` is used

## State Management

Ten independent **Zustand** stores in `src/stores/`:

| Store | Responsibility | Persisted |
|-------|---------------|-----------|
| `chatStore` | Messages, streaming state, session meta, per-tab cache, pending user messages | No |
| `sessionStore` | Session list, selection, drafts, running state, stdinId-to-tab routing, custom names | No (names to disk) |
| `settingsStore` | Theme, color theme, locale, model, mode, thinking level, layout, font size, update state | Yes (localStorage) |
| `fileStore` | File tree, preview, edit buffer, changed files, drag-drop state | No |
| `agentStore` | Agent tree (multi-agent nesting), phase tracking, per-tab cache | No |
| `commandStore` | Unified commands (built-in + custom + skills), prefix mode | No |
| `skillStore` | Skills CRUD, enable/disable, content editing | No |
| `mcpStore` | MCP servers from ~/.claude.json | No |
| `providerStore` | API providers (multi-provider), model mappings, active provider | Disk (providers.json) |
| `setupStore` | CLI install/login wizard state | No |

**Tab-switching pattern**: `chatStore` and `agentStore` implement `saveToCache(tabId)` / `restoreFromCache(tabId)` for seamless multi-session tab switching. Background sessions receive stream events via `*InCache()` methods.

## Frontend Structure

```
src/
├── App.tsx                    # Entry: theme, font, file watcher, global hotkeys
├── main.tsx                   # React root + ErrorBoundary
├── stores/                    # 10 Zustand stores (see above)
├── components/                # ~46 component files
│   ├── layout/                # AppShell, Sidebar, SecondaryPanel
│   ├── chat/                  # ChatPanel, InputBar, MessageBubble, TiptapEditor,
│   │                          # PermissionCard, QuestionCard, PlanReviewCard,
│   │                          # RewindPanel, SlashCommandPopover, ToolGroup,
│   │                          # ModelSelector, ModeSelector, CommandProcessingCard
│   ├── files/                 # FileExplorer, FilePreview, ProjectSelector
│   ├── conversations/         # ConversationList, SessionItem, SessionGroup,
│   │                          # SessionContextMenu, ExportMenu
│   ├── commands/              # CommandPalette
│   ├── agents/                # AgentPanel
│   ├── skills/                # SkillsPanel
│   ├── mcp/                   # McpPanel
│   ├── settings/              # SettingsPanel, ProviderTab, ProviderManager,
│   │                          # ProviderForm, ProviderCard, AddProviderMenu,
│   │                          # GeneralTab, CliTab, McpTab
│   ├── setup/                 # SetupWizard
│   └── shared/                # MarkdownRenderer, ImageLightbox, ConfirmDialog,
│                              # FileIcon, UpdateButton, ChangelogModal
├── hooks/
│   ├── useStreamProcessor.ts  # Stream message handling (foreground + background tabs)
│   ├── useFileAttachments.ts  # File upload, drag-drop (OS native + browser)
│   ├── useRewind.ts           # Rewind orchestration (kill, truncate, checkpoint restore)
│   └── useAutoUpdateCheck.ts  # Periodic update check via tauri-plugin-updater
└── lib/
    ├── tauri-bridge.ts        # ALL Tauri IPC calls + event listeners (single source of truth)
    ├── i18n.ts                # Chinese/English translations (zh/en)
    ├── api-provider.ts        # Model resolution for custom providers, env fingerprint
    ├── api-config.ts          # Provider config import/export (v1/v2 format)
    ├── provider-presets.ts    # Pre-configured API provider templates
    ├── session-loader.ts      # Parse CLI session JSONL into ChatMessage[] for history reload
    ├── turns.ts               # Turn parsing for rewind (pure functions)
    ├── platform.ts            # OS detection, modifier keys, path utilities
    ├── changelog.ts           # Version changelog entries for "What's New" modal
    ├── codemirror-theme.ts    # CodeMirror theme configuration
    ├── drag-state.ts          # File tree drag state coordination
    └── strip-ansi.ts          # ANSI escape sequence removal
```

## Rust Backend

**`src-tauri/src/lib.rs`** (~4,576 LOC) — All Tauri command handlers:

| Category | Commands |
|----------|---------|
| Session lifecycle | `start_claude_session`, `send_stdin`, `send_raw_stdin`, `kill_session`, `track_session`, `delete_session` |
| Session data | `list_sessions`, `load_session`, `export_session_markdown`, `export_session_json` |
| SDK control protocol | `respond_permission`, `send_control_request` |
| File operations | `read_file_tree`, `read_file_content`, `write_file_content`, `copy_file`, `rename_file`, `delete_file`, `create_directory`, `read_file_base64`, `check_file_access`, `get_file_size`, `save_temp_file` |
| File watching | `watch_directory`, `unwatch_directory` |
| External tools | `open_in_vscode`, `reveal_in_finder`, `open_with_default_app` |
| Skills/Commands | `list_slash_commands`, `list_skills`, `read_skill`, `write_skill`, `delete_skill`, `toggle_skill_enabled`, `list_all_commands` |
| Git | `run_git_command` (allowlisted operations only) |
| Rewind | `rewind_files` (spawn-based fallback for checkpoint restore) |
| CLI management | `check_claude_cli`, `install_claude_cli`, `check_node_env`, `install_node_env`, `run_claude_command` |
| Auth | `start_claude_login`, `check_claude_auth`, `open_terminal_login` |
| Session metadata | `load_custom_previews`, `save_custom_previews`, `load_pinned_sessions`, `save_pinned_sessions`, `load_archived_sessions`, `save_archived_sessions`, `generate_session_title` |
| Provider | `load_providers`, `save_providers`, `test_provider_connection` |
| Projects | `list_recent_projects` |
| UI | `set_dock_icon` |

**`src-tauri/src/commands/claude_process.rs`** — Types: `ProcessManager`, `StdinManager`, `ManagedProcess`, `StartSessionParams`, `SessionInfo`

**`src-tauri/src/protocol.rs`** — SDK control protocol types for bidirectional CLI communication (ControlRequest, ControlRequestPayload, SdkControlRequestPayload)

## Key Design Decisions

1. **Overlay title bar** — `titleBarStyle: "Overlay"` with `hiddenTitle: true`. Components must account for the traffic light area on macOS.

2. **StdinManager for follow-up messages** — After the first message spawns a CLI process, subsequent messages in the same session are written to the process's stdin pipe. No new process per message.

3. **Multi-session tabs** — Sessions run concurrently. `chatStore` caches per-tab state. Stream events for background tabs are routed via `stdinToTab` mapping in `sessionStore` and written to cache via `*InCache()` methods.

4. **SDK control protocol** — Permission requests, mode changes, model switching, and interrupts use the Claude CLI's native control protocol (`--permission-prompt-tool stdio`). Fallback: `--dangerously-skip-permissions` in "bypass" mode.

5. **Provider system** — Multi-provider API configuration stored in `~/.tokenicode/providers.json`. Supports Anthropic, OpenAI-compatible APIs, and presets (DeepSeek, Zhipu, Qwen, Kimi, MiniMax). Environment variables are injected into CLI process at spawn.

6. **Rewind via CLI checkpoints** — File restoration uses Claude CLI's native checkpoint system (`--replay-user-messages`) via the SDK control protocol. Falls back to spawning a separate CLI process if stdin pipe is unavailable.

7. **i18n** — All user-facing strings go through `src/lib/i18n.ts`. Supports `zh` (Chinese) and `en` (English). Default locale is `zh`.

8. **NDJSON streaming** — Claude CLI output is parsed line-by-line as newline-delimited JSON in `useStreamProcessor.ts`.

9. **Settings persistence** — `settingsStore` uses Zustand's `persist` middleware (localStorage, version 4 with migrations). `providerStore` persists to disk via Rust backend.

10. **Session mode mapping** — Frontend modes (`code`/`ask`/`plan`/`bypass`) map to CLI permission modes (`acceptEdits`/`default`/`plan`/`bypassPermissions`) via `mapSessionModeToPermissionMode()`.

## Common Debugging Locations

| Symptom | Where to look |
|---------|--------------|
| Message not appearing | `useStreamProcessor.ts` (stream parsing), `chatStore.ts` (addMessage, updatePartialMessage) |
| Message sent but no response | `InputBar.tsx` (handleSubmit), `tauri-bridge.ts` (startSession/sendStdin), `lib.rs` (start_claude_session) |
| Permission dialog issues | `PermissionCard.tsx`, `protocol.rs`, `lib.rs` (respond_permission, send_control_request) |
| Streaming stuck / partial | `useStreamProcessor.ts` (handleStreamMessage), `lib.rs` (stdout reading loop) |
| Tab switching loses state | `chatStore.ts` (saveToCache/restoreFromCache), `agentStore.ts` (saveToCache/restoreFromCache) |
| File tree not updating | `fileStore.ts` (loadTree/refreshTree), `lib.rs` (read_file_tree, watch_directory) |
| Provider/API connection | `providerStore.ts`, `api-provider.ts`, `lib.rs` (test_provider_connection, env injection in start_claude_session) |
| CLI not found / install | `setupStore.ts`, `SetupWizard.tsx`, `lib.rs` (check_claude_cli, install_claude_cli, find_claude_binary) |
| Rewind not working | `useRewind.ts`, `turns.ts`, `RewindPanel.tsx`, `lib.rs` (rewind_files, send_control_request) |
| Session resume failures | `InputBar.tsx` (resume logic), `lib.rs` (start_claude_session with resume_session_id) |
| Background session events | `useStreamProcessor.ts` (handleBackgroundStreamMessage), `chatStore.ts` (*InCache methods) |
| Mode/model switch at runtime | `settingsStore.ts` (subscribe watcher), `protocol.rs` (ControlRequest), `lib.rs` (send_control_request) |
| Auto-update | `useAutoUpdateCheck.ts`, `UpdateButton.tsx`, `tauri.conf.json` (updater endpoints) |

## File Quick Reference

| What | File |
|------|------|
| Message sending + stream processing | `src/components/chat/InputBar.tsx` + `src/hooks/useStreamProcessor.ts` |
| Chat state | `src/stores/chatStore.ts` |
| IPC bridge (all native calls) | `src/lib/tauri-bridge.ts` |
| Rust backend entry | `src-tauri/src/lib.rs` |
| Process/stdin management | `src-tauri/src/commands/claude_process.rs` |
| SDK protocol types | `src-tauri/src/protocol.rs` |
| Settings (persisted) | `src/stores/settingsStore.ts` |
| API provider management | `src/stores/providerStore.ts` + `src/lib/api-provider.ts` |
| Session list + tabs | `src/stores/sessionStore.ts` |
| Translations | `src/lib/i18n.ts` |
| Tauri config | `src-tauri/tauri.conf.json` |
| Build script (macOS local) | `scripts/build-macos-local.sh` |
