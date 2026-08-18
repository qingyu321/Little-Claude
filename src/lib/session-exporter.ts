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

// ─── Task 01: unified cross-harness handoff ────────────────────────────
// Three readers (Claude JSONL / in-memory ChatMessage[] / DSH zstd turns)
// converge on UnifiedTurn[], then render through TWO channels:
//   A) budgeted inline injection into the first prompt (recent turns)
//   B) a handoff brief file (.tokenicode/handoff/*.md) every harness can
//      read — the heavy channel that avoids blowing the context window.

export interface UnifiedTurn {
  role: 'user' | 'assistant';
  text: string;
  tools?: { name: string; args?: string }[];
}

export interface UnifiedTodo {
  content: string;
  status: string;
}

export interface HandoffContext {
  sourceBackend: string;
  projectDir: string;
  turns: UnifiedTurn[];
  todos?: UnifiedTodo[];
  model?: string;
}

/** Claude JSONL (raw text from export_claude_to_codex) → unified turns. */
export function unifiedTurnsFromClaudeJsonl(jsonlContent: string): UnifiedTurn[] {
  const turns: UnifiedTurn[] = [];
  for (const line of jsonlContent.split('\n')) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.isMeta) continue;
    const msgType: string = msg.type || '';
    if (msgType === 'user' || msgType === 'human') {
      const text = extractUserText(msg);
      if (text.trim()) turns.push({ role: 'user', text });
    } else if (msgType === 'assistant') {
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) continue;
      const text = blocks
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text)
        .join('\n');
      const tools = blocks
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({
          name: String(b.name || 'tool'),
          args: JSON.stringify(b.input ?? {}).slice(0, 300),
        }));
      if (text.trim() || tools.length > 0) {
        turns.push({ role: 'assistant', text, tools: tools.length ? tools : undefined });
      }
    }
  }
  return turns;
}

/** In-memory ChatMessage[] (codex or any live backend) → unified turns. */
export function unifiedTurnsFromChatMessages(messages: ChatMessage[]): UnifiedTurn[] {
  const grouped = groupMessagesIntoTurns(messages).filter(
    (t) => t.assistantMsgs.length > 0,
  );
  const turns: UnifiedTurn[] = [];
  for (const turn of grouped) {
    const userText = turn.userMsg.content || '';
    if (userText.trim()) turns.push({ role: 'user', text: userText });
    const textParts: string[] = [];
    const tools: { name: string; args?: string }[] = [];
    for (const m of turn.assistantMsgs) {
      if (m.type === 'text' && m.content) textParts.push(m.content);
      else if (m.type === 'tool_use') {
        tools.push({
          name: m.toolName || 'tool',
          args: JSON.stringify(m.toolInput ?? {}).slice(0, 300),
        });
      }
    }
    if (textParts.length || tools.length) {
      turns.push({
        role: 'assistant',
        text: textParts.join('\n'),
        tools: tools.length ? tools : undefined,
      });
    }
  }
  return turns;
}

/** read_dsh_session_turns payload → unified turns + todos. */
export function unifiedTurnsFromDsh(payload: any): {
  turns: UnifiedTurn[];
  todos: UnifiedTodo[];
  model?: string;
} {
  const turns: UnifiedTurn[] = Array.isArray(payload?.turns)
    ? payload.turns
        .filter((t: any) => t && (t.text || (t.tools && t.tools.length)))
        .map((t: any) => ({
          role: t.role === 'user' ? 'user' as const : 'assistant' as const,
          text: String(t.text || ''),
          tools: Array.isArray(t.tools) && t.tools.length
            ? t.tools.map((x: any) => ({ name: String(x.name || 'tool'), args: x.args }))
            : undefined,
        }))
    : [];
  const todos: UnifiedTodo[] = Array.isArray(payload?.todos)
    ? payload.todos.map((t: any) => ({
        content: String(t.content || ''),
        status: String(t.status || 'pending'),
      }))
    : [];
  return { turns, todos, model: payload?.model || undefined };
}

function renderTurnSegment(turn: UnifiedTurn): string {
  if (turn.role === 'user') {
    return `## User\n${turn.text}\n`;
  }
  const parts: string[] = [];
  if (turn.text.trim()) parts.push(turn.text);
  for (const tool of turn.tools ?? []) {
    parts.push(`[Tool: ${tool.name}]${tool.args ? ` ${tool.args}` : ''}`);
  }
  return `## Assistant\n${parts.join('\n')}\n`;
}

/**
 * Budgeted inline injection (channel A): most recent turns verbatim while
 * the budget holds; older turns collapse into one-line summaries so the
 * target harness still knows what happened without blowing its window.
 */
export function formatUnifiedForInjection(
  turns: UnifiedTurn[],
  sourceBackend: string,
  cwd: string,
  budgetChars = 28000,
): string {
  if (turns.length === 0) return '';

  // Keep recent turns verbatim within budget (newest first)
  const verbatim: UnifiedTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const seg = renderTurnSegment(turns[i]);
    if (used + seg.length > budgetChars && verbatim.length > 0) break;
    verbatim.unshift(turns[i]);
    used += seg.length;
  }
  const summarized = turns.slice(0, turns.length - verbatim.length);

  const body: string[] = [];
  if (summarized.length > 0) {
    body.push(`## Earlier turns (summarized, ${summarized.length} turns)\n`);
    for (const t of summarized) {
      const preview = t.text.replace(/\s+/g, ' ').slice(0, 100);
      if (t.role === 'user') {
        body.push(`- User: ${preview}${t.text.length > 100 ? '…' : ''}`);
      } else {
        const toolNote = t.tools && t.tools.length
          ? ` [tools: ${t.tools.map((x) => x.name).join(', ')}]`
          : '';
        body.push(`- Assistant: ${preview}${t.text.length > 100 ? '…' : ''}${toolNote}`);
      }
    }
    body.push('');
  }
  for (const t of verbatim) {
    body.push(renderTurnSegment(t));
  }

  const header = [
    'You are taking over a task from another AI harness. Below is the conversation history so far.',
    'A full handoff brief may be referenced after this history — read it if you need earlier details.',
    '',
    `<conversation_history source="${sourceBackend}" project="${cwd}">`,
    '',
  ].join('\n');
  const footer = '\n</conversation_history>\n\n---\nCurrent task: ';
  return header + body.join('\n') + footer;
}

/**
 * Handoff brief (channel B): markdown persisted to .tokenicode/handoff/.
 * Carries the task state (todos, per-turn summaries, limitations) — every
 * harness can read files, so this channel costs almost no context tokens.
 */
export function buildHandoffBrief(ctx: HandoffContext): string {
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push('# 任务交接简报 (Task Handoff Brief)');
  lines.push('');
  lines.push(`- 来源 harness: ${ctx.sourceBackend}`);
  lines.push(`- 项目目录: ${ctx.projectDir}`);
  if (ctx.model) lines.push(`- 来源模型: ${ctx.model}`);
  lines.push(`- 生成时间: ${now}`);
  lines.push(`- 交接轮次: ${ctx.turns.length}`);
  lines.push('');

  const openTodos = (ctx.todos ?? []).filter((t) => t.status !== 'completed');
  const doneTodos = (ctx.todos ?? []).filter((t) => t.status === 'completed');
  if (ctx.todos && ctx.todos.length > 0) {
    lines.push('## 任务进度（待办状态）');
    lines.push('');
    for (const t of openTodos) {
      lines.push(`- [ ] ${t.content}${t.status === 'in_progress' ? '（进行中）' : ''}`);
    }
    for (const t of doneTodos) {
      lines.push(`- [x] ${t.content}`);
    }
    lines.push('');
  }

  lines.push('## 逐轮摘要');
  lines.push('');
  ctx.turns.forEach((t, i) => {
    const preview = t.text.replace(/\s+/g, ' ').slice(0, 400);
    if (t.role === 'user') {
      lines.push(`${i + 1}. **用户**: ${preview}${t.text.length > 400 ? '…' : ''}`);
    } else {
      const toolNote = t.tools && t.tools.length
        ? `（工具: ${t.tools.map((x) => x.name).join(', ')}）`
        : '';
      lines.push(`   **助手**: ${preview}${t.text.length > 400 ? '…' : ''}${toolNote}`);
    }
  });
  lines.push('');

  lines.push('## 交接须知');
  lines.push('');
  lines.push('- thinking/图片/usage 未跨 harness 携带；文件改动现状请用 `git status` / `git diff --stat` 查看');
  lines.push(`- 最近 ${Math.min(ctx.turns.length, 12)} 轮全文已内联在对话开头，更早轮次仅摘要`);
  lines.push('- 请先确认当前进度与下一步计划，再继续未完成的工作');
  lines.push('');
  return lines.join('\n');
}
