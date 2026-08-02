/**
 * Session Exporter — rebuild Claude-compatible JSONL from ChatMessage[].
 *
 * Used for cross-backend history sharing: Codex → Claude.
 * The reverse direction (Claude → Codex) uses formatSessionAsText() below.
 */

import type { ChatMessage } from '../stores/chatStore';

// ─── Helpers ──────────────────────────────────────────────────────────

function uuid(): string {
  // crypto.randomUUID() is available in all modern browsers + Tauri webview
  return crypto.randomUUID();
}

function isoNow(): string {
  return new Date().toISOString();
}

function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

// ─── Tool translation ─────────────────────────────────────────────────

/** Tools that exist in both Claude and Codex with matching schemas. */
const COMMON_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Task', 'Agent', 'TodoWrite', 'AskUserQuestion', 'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'NotebookEdit', 'EnterPlanMode', 'ExitPlanMode',
]);

function translateToolBlock(msg: ChatMessage): Record<string, unknown> {
  const name = msg.toolName || '';
  if (COMMON_TOOLS.has(name)) {
    return {
      type: 'tool_use',
      id: msg.id,
      name,
      input: msg.toolInput || {},
    };
  }
  // Unknown / Codex-specific tool → degrade to text
  const inputStr = msg.toolInput
    ? JSON.stringify(msg.toolInput, null, 2)
    : '{}';
  return {
    type: 'text',
    text: `[Codex used tool: ${name}, input: ${inputStr}]`,
  };
}

// ─── Turn grouping ────────────────────────────────────────────────────

interface Turn {
  userMsg: ChatMessage;
  assistantMsgs: ChatMessage[];
}

function groupMessagesIntoTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentUser: ChatMessage | null = null;
  let currentAssistant: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (currentUser) {
        turns.push({ userMsg: currentUser, assistantMsgs: currentAssistant });
      }
      currentUser = msg;
      currentAssistant = [];
    } else if (msg.role === 'assistant') {
      // Skip Claude-specific UI-only types (they don't exist in Codex sessions anyway)
      if (
        msg.type === 'permission' ||
        msg.type === 'plan' ||
        msg.type === 'plan_review' ||
        msg.type === 'todo'
      ) {
        continue;
      }
      currentAssistant.push(msg);
    }
    // system messages are skipped (mode switch, model switch, etc.)
  }

  // Last turn
  if (currentUser) {
    turns.push({ userMsg: currentUser, assistantMsgs: currentAssistant });
  }

  return turns;
}

// ─── Block builders ───────────────────────────────────────────────────

function buildUserContentBlocks(turn: Turn): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  // 1. User text
  blocks.push({ type: 'text', text: turn.userMsg.content });

  // 2. File attachments
  if (turn.userMsg.attachments && turn.userMsg.attachments.length > 0) {
    const attachText = turn.userMsg.attachments
      .map((a) => a.path || a.name)
      .join('\n');
    if (attachText) {
      blocks.push({
        type: 'text',
        text: `\n[Attached files]\n${attachText}`,
      });
    }
  }

  // 3. Tool results from the PREVIOUS turn's assistant messages
  //    (in JSONL, tool_result blocks are embedded in the NEXT user message)
  for (const msg of turn.assistantMsgs) {
    if (msg.type === 'tool_use' && msg.toolResultContent) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: msg.toolName ? msg.id : undefined,
        content: msg.toolResultContent,
      });
    }
  }

  return blocks;
}

function buildAssistantBlocks(
  msgs: ChatMessage[],
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];

  for (const msg of msgs) {
    switch (msg.type) {
      case 'text':
        blocks.push({ type: 'text', text: msg.content });
        break;
      case 'tool_use':
        blocks.push(translateToolBlock(msg));
        break;
      case 'thinking':
        blocks.push({ type: 'thinking', thinking: msg.content, signature: '' });
        break;
      case 'tool_result':
        // tool_result is handled in buildUserContentBlocks, skip here
        break;
      default:
        // question, permission, plan, plan_review, todo — skip
        break;
    }
  }

  return blocks;
}

// ─── Main reconstruction ──────────────────────────────────────────────

export interface ExportResult {
  jsonl: string;
  sessionUuid: string;
}

/**
 * Rebuild a Claude-compatible NDJSON session file from ChatMessage[].
 *
 * The output matches the real Claude CLI JSONL format:
 *   - queue-operation lines at the start
 *   - camelCase `sessionId` (NOT snake_case `session_id`)
 *   - `parentUuid` chain linking each message to the previous
 *   - `isSidechain`, `userType`, `entrypoint`, `cwd`, `version`, `gitBranch`
 *   - NO `system/init` line, NO `result` lines (those are stream-only)
 *
 * Only completed turns (user + assistant response) are included — the current
 * in-progress turn is excluded so it isn't duplicated when Claude CLI receives
 * the same prompt via --resume.
 *
 * @param messages  — Flat ChatMessage array from chatStore
 * @param cwd       — Working directory
 * @param model     — Model name for the session
 * @returns JSONL string ready to write to ~/.claude/projects/
 */
export function reconstructJsonl(
  messages: ChatMessage[],
  cwd: string,
  model: string,
): ExportResult {
  const sessionUuid = uuid();
  const version = '2.1.216'; // Claude CLI version marker

  // Only include completed turns (user + assistant response).
  // This excludes the current in-progress turn whose user message is
  // already in chatStore but hasn't been responded to yet.
  const turns = groupMessagesIntoTurns(messages).filter(
    (t) => t.assistantMsgs.length > 0,
  );

  if (turns.length === 0) {
    return { jsonl: '', sessionUuid };
  }

  const lines: string[] = [];
  const now = isoNow();

  // ── Queue-operation lines (mimics real Claude CLI session start) ──
  lines.push(
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: now,
      sessionId: sessionUuid,
      content: turns[0].userMsg.content,
    }),
  );
  lines.push(
    JSON.stringify({
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: now,
      sessionId: sessionUuid,
    }),
  );

  // ── parentUuid chain ──
  // First user message has parentUuid = null (no attachment lines to reference).
  let prevUuid: string | null = null;

  for (const turn of turns) {
    const ts = toIso(turn.userMsg.timestamp);
    const userUuid = uuid();

    // Build user content: use plain string for simple text (matches real
    // Claude CLI format), array of blocks when there are tool results.
    const userBlocks = buildUserContentBlocks(turn);
    const hasToolResults = userBlocks.some((b) => b.type === 'tool_result');
    let userContent: string | Record<string, unknown>[];
    if (!hasToolResults && userBlocks.length === 1 && userBlocks[0].type === 'text') {
      userContent = ((userBlocks[0] as any).text as string) || '';
    } else {
      userContent = userBlocks;
    }

    // User message — camelCase sessionId + parentUuid chain
    lines.push(
      JSON.stringify({
        parentUuid: prevUuid,
        isSidechain: false,
        type: 'user',
        uuid: userUuid,
        sessionId: sessionUuid,
        timestamp: ts,
        message: {
          role: 'user',
          content: userContent,
        },
        permissionMode: 'bypassPermissions',
        promptSource: 'sdk',
        userType: 'external',
        entrypoint: 'sdk-cli',
        cwd,
        version,
        gitBranch: 'HEAD',
      }),
    );
    prevUuid = userUuid;

    // Assistant message (all blocks merged into one line)
    const assistantBlocks = buildAssistantBlocks(turn.assistantMsgs);
    if (assistantBlocks.length > 0) {
      const assistantUuid = uuid();
      lines.push(
        JSON.stringify({
          parentUuid: prevUuid,
          isSidechain: false,
          type: 'assistant',
          uuid: assistantUuid,
          sessionId: sessionUuid,
          timestamp: ts,
          message: {
            id: `msg_syn_${uuid()}`,
            type: 'message',
            model,
            role: 'assistant',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            content: assistantBlocks,
          },
          userType: 'external',
          entrypoint: 'sdk-cli',
          cwd,
          version,
          gitBranch: 'HEAD',
        }),
      );
      prevUuid = assistantUuid;
    }
  }

  return { jsonl: lines.join('\n') + '\n', sessionUuid };
}

// ─── Claude → Codex: text formatter ───────────────────────────────────

/**
 * Format a Claude JSONL session as human-readable text for Codex injection.
 * Used by `export_claude_to_codex` Rust command.
 */
export function formatJsonlAsText(jsonlContent: string, cwd: string): string {
  const lines = jsonlContent.split('\n').filter((l) => l.trim());
  let model = 'unknown';
  const parts: string[] = [];

  for (const line of lines) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip meta and stream events
    if (msg.isMeta) continue;
    const msgType: string = msg.type || '';

    switch (msgType) {
      case 'system': {
        if (msg.model) model = msg.model;
        break;
      }
      case 'user':
      case 'human': {
        const text = extractUserText(msg);
        if (text) parts.push(`## User\n${text}\n`);
        break;
      }
      case 'assistant': {
        const text = formatAssistantContent(msg);
        if (text) parts.push(`## Assistant\n${text}\n`);
        break;
      }
      // result / tool_result / stream_event → skip
    }
  }

  const header = [
    'You are an AI assistant. Below is the conversation history between you and the user.',
    'Please continue the conversation based on this context.',
    '',
    `<conversation_history source="claude" project="${cwd}" model="${model}">`,
    '',
  ].join('\n');

  const footer = '\n</conversation_history>\n\n---\nNew task: ';

  return header + parts.join('\n') + footer;
}

function extractUserText(msg: any): string {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return msg.message?.content || '';
  return blocks
    .filter((b: any) => b.type === 'text' && b.text)
    .map((b: any) => b.text)
    .join('\n');
}

// ─── Codex → Claude: ChatMessage[] → readable text ────────────────────

/**
 * Format a Codex session's ChatMessage[] as human-readable text
 * for Claude injection. Symmetric with formatJsonlAsText().
 *
 * Mirrors the Claude→Codex text-injection pattern: wraps history in
 * <conversation_history> XML tags with ## User / ## Assistant blocks.
 * Only completed turns (user + assistant response) are included.
 */
export function formatCodexMessagesAsText(
  messages: ChatMessage[],
  cwd: string,
): string {
  const turns = groupMessagesIntoTurns(messages).filter(
    (t) => t.assistantMsgs.length > 0,
  );

  if (turns.length === 0) return '';

  const parts: string[] = [];

  for (const turn of turns) {
    // User message
    const userText = turn.userMsg.content || '';
    if (userText.trim()) {
      parts.push(`## User\n${userText}\n`);
    }

    // Assistant messages
    const assistantParts: string[] = [];
    for (const msg of turn.assistantMsgs) {
      switch (msg.type) {
        case 'text':
          if (msg.content) assistantParts.push(msg.content);
          break;
        case 'thinking':
          // Include thinking as bracketed summary (like Claude→Codex pattern)
          if (msg.content) {
            assistantParts.push(`[Thinking: ${msg.content}]`);
          }
          break;
        case 'tool_use': {
          const name = msg.toolName || 'unknown';
          const input = msg.toolInput
            ? JSON.stringify(msg.toolInput, null, 2)
            : '{}';
          assistantParts.push(`\n[Tool: ${name}]\n${input}`);
          break;
        }
        case 'tool_result': {
          const resultText =
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content);
          assistantParts.push(`\n[Tool result]\n${resultText}`);
          break;
        }
        // permission, plan, plan_review, question, todo → skip
      }
    }

    if (assistantParts.length > 0) {
      parts.push(`## Assistant\n${assistantParts.join('\n')}\n`);
    }
  }

  const header = [
    'You are an AI assistant. Below is the conversation history between you and the user.',
    'Please continue the conversation based on this context.',
    '',
    `<conversation_history source="codex" project="${cwd}">`,
    '',
  ].join('\n');

  const footer = '\n</conversation_history>\n\n---\nCurrent task: ';

  return header + parts.join('\n') + footer;
}

// ─── Claude JSONL → readable text (for Claude→Codex injection) ────────

function formatAssistantContent(msg: any): string {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return '';
  const out: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text) out.push(block.text);
        break;
      case 'tool_use':
        out.push(
          `\n[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`,
        );
        break;
      case 'tool_result': {
        const resultText =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        out.push(`\n[Tool result]\n${resultText}`);
        break;
      }
      // thinking → skip (too verbose)
    }
  }

  return out.join('\n');
}
