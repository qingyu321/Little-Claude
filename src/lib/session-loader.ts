import type { ChatMessage } from '../stores/chatStore';
import { generateMessageId } from '../stores/chatStore';
import type { AgentPhase } from '../stores/agentStore';
import { isSystemText } from './system-text';
import { semanticContextTokens } from './context-tokens';

// 报告B9 复查: session reload used to inject full tool results straight into
// memory, bypassing the 256 KiB cap that bounds live streams — reopening a
// session with multi-MB file dumps returned to the pre-fix memory profile.
// Mirror of useStreamProcessor's capToolResult; keep the constants in sync.
const MAX_TOOL_RESULT_CHARS = 256 * 1024;
const TOOL_RESULT_TRUNCATED_MARKER = '\n\n… (内容过长，已截断显示)';

function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + TOOL_RESULT_TRUNCATED_MARKER;
}

// B11: mirror of useStreamProcessor's capToolInput — reload must not inject
// full Write/Edit payloads that the live path now truncates. Keep the
// constants in sync.
const MAX_TOOL_INPUT_FIELD_CHARS = 64 * 1024;
const TOOL_INPUT_TRUNCATED_MARKER = '\n…（已截断）';

function capToolInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  let out: Record<string, unknown> | null = null;
  for (const key of ['content', 'old_string', 'new_string', 'plan'] as const) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > MAX_TOOL_INPUT_FIELD_CHARS) {
      if (!out) out = { ...(input as Record<string, unknown>) };
      out[key] = v.slice(0, MAX_TOOL_INPUT_FIELD_CHARS) + TOOL_INPUT_TRUNCATED_MARKER;
    }
  }
  return out ?? input;
}

export interface AgentData {
  id: string;
  parentId: string | null;
  description: string;
  phase: AgentPhase;
  startTime: number;
  endTime: number;
  isMain: boolean;
}

export interface LoadedSession {
  messages: ChatMessage[];
  agents: AgentData[];
  mainAgentStartTime: number;
  /** Token/context stats recovered from the JSONL's assistant usage records.
   *  Live-stream writes these into sessionMeta on result events; reopening a
   *  session from disk left them undefined, so the Ctx bar read 0% (and the
   *  sidebar counters read 0) until the next turn's result arrived. */
  usage?: LoadedSessionUsage;
}

/** Same metric as the live path (semanticContextTokens): the FULL
 *  last-request context including cached tokens — not bare input_tokens. */
export interface LoadedSessionUsage {
  contextTokens: number;
  contextInputTokens: number;
  contextCacheReadTokens: number;
  contextCacheCreationTokens: number;
  /** Last turn's input/output (live-stream semantics). */
  inputTokens: number;
  outputTokens: number;
  /** Cumulative across turns (per-JSONL-message, deduped by usage equality). */
  totalInputTokens: number;
  totalOutputTokens: number;
}

/**
 * CLI JSONL timestamps are ISO strings; the UI expects epoch milliseconds.
 * Passing the raw string through breaks time grouping and rewind comparisons.
 */
function toMillis(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string' && ts) {
    const ms = new Date(ts).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

/** Parse raw JSONL messages into structured session data */
export function parseSessionMessages(rawMessages: any[]): LoadedSession {
  const messages: ChatMessage[] = [];
  const agents: AgentData[] = [];

  // Create main agent with session start time
  const firstMsg = rawMessages[0];
  const sessionStartTime = firstMsg?.timestamp
    ? new Date(firstMsg.timestamp).getTime()
    : Date.now();

  agents.push({
    id: 'main',
    parentId: null,
    description: 'Main',
    phase: 'completed',
    startTime: sessionStartTime,
    endTime: Date.now(),
    isMain: true,
  });

  // Collect tool_use_id → index mapping for binding tool results
  const toolUseIdToIndex = new Map<string, number>();

  // Token/context recovery (see LoadedSession.usage): rebuild the in-memory
  // counters from the JSONL's assistant usage records. Mirrors the live path —
  // full context incl. cached tokens — and skips system text (compact
  // continuations) just like the live path excludes compact turns.
  let usageRec: LoadedSessionUsage | undefined;
  let lastUsageKey = '';
  let runningTotalInput = 0;
  let runningTotalOutput = 0;

  for (const msg of rawMessages) {
    // Skip system-injected meta messages
    if (msg.isMeta) continue;

    // Handle tool_result messages: attach result to parent tool_use card
    if (msg.toolUseResult || msg.type === 'tool_result') {
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_result' && b.tool_use_id) {
          const resultText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c: any) => c.text || c.content || '').join('')
              : '';
          if (resultText) {
            const idx = toolUseIdToIndex.get(b.tool_use_id);
            if (idx !== undefined && messages[idx]) {
              messages[idx] = { ...messages[idx], toolResultContent: capToolResult(resultText) };
            }
          }
        }
      }
      continue;
    }

    if (msg.type === 'human' || msg.type === 'user' || msg.role === 'user') {
      // Extract text blocks, filtering out system-injected content
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const userTexts: string[] = [];
      for (const b of blocks) {
        const text = typeof b === 'string' ? b : b?.type === 'text' ? b.text : '';
        if (text && !isSystemText(text)) userTexts.push(text);
      }
      // Fallback for plain string content
      if (blocks.length === 0 && typeof msg.message?.content === 'string') {
        const text = msg.message.content;
        if (!isSystemText(text)) userTexts.push(text);
      }
      let content = userTexts.join('');
      // Extract file attachments from text
      const attachments: Array<{ name: string; path: string; isImage: boolean }> = [];
      const attachRegex = /\n?\n?\[(?:附加的文件|Attached files)\]\n([\s\S]+)$/;
      const attachMatch = content.match(attachRegex);
      if (attachMatch) {
        content = content.slice(0, attachMatch.index!).trimEnd();
        const paths = attachMatch[1].split('\n').map(p => p.trim()).filter(Boolean);
        for (const p of paths) {
          const name = p.split(/[\\/]/).pop() || p;
          const ext = name.split('.').pop()?.toLowerCase() || '';
          const isImage = ['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext);
          attachments.push({ name, path: p, isImage });
        }
      }
      if (content.trim()) {
        messages.push({
          id: msg.uuid || generateMessageId(),
          role: 'user',
          type: 'text',
          content,
          timestamp: toMillis(msg.timestamp),
          attachments: attachments.length > 0 ? attachments : undefined,
        });
      }
    } else if (msg.type === 'assistant') {
      const blocks = msg.message?.content;
      // Recover usage stats (contextTokens etc.) from this assistant record.
      // A turn's usage is re-emitted per message block with identical values —
      // dedupe by usage equality so cumulative totals count each turn once.
      // System-text records (compact continuations) never contribute, matching
      // the live path's wasCompactTurn exclusion.
      const u = msg.message?.usage;
      if (u && typeof u === 'object' && (u.input_tokens || u.output_tokens)) {
        const hasSystemText = Array.isArray(blocks) && blocks.some(
          (b: any) => b?.type === 'text' && isSystemText(b.text || ''));
        if (!hasSystemText) {
          const input = u.input_tokens || 0;
          const output = u.output_tokens || 0;
          const cacheRead = u.cache_read_input_tokens || 0;
          const ccNested = u.cache_creation || {};
          const cacheCreation = (u.cache_creation_input_tokens || 0)
            + (ccNested.ephemeral_1h_input_tokens || 0)
            + (ccNested.ephemeral_5m_input_tokens || 0);
          // E3: same semantics-aware metric as the live path (see
          // context-tokens.ts) — DeepSeek-style usage (input already includes
          // the cached share) uses input alone; Anthropic-style usage must sum
          // all three. The CUMULATIVE total must use the same metric too:
          // summing only the raw input_tokens (the uncached remainder on
          // Anthropic) made a restored session's sidebar counter read ~0 while
          // the live session counted full context — 10000x off on cache-heavy
          // sessions. Live-path parity: per-turn inputTokens is the semantic
          // full, and each turn's full counts into the running total once.
          const fullInput = semanticContextTokens({ input, cacheRead, cacheCreation });
          const usageKey = `${input}|${output}|${cacheRead}|${cacheCreation}`;
          if (usageKey !== lastUsageKey) {
            lastUsageKey = usageKey;
            runningTotalInput += fullInput;
            runningTotalOutput += output;
          }
          usageRec = {
            contextTokens: fullInput,
            contextInputTokens: input,
            contextCacheReadTokens: cacheRead,
            contextCacheCreationTokens: cacheCreation,
            inputTokens: fullInput,
            outputTokens: output,
            totalInputTokens: runningTotalInput,
            totalOutputTokens: runningTotalOutput,
          };
        }
      }
      if (Array.isArray(blocks)) {
        for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
          const block = blocks[blockIdx];
          if (block.type === 'text') {
            if (isSystemText(block.text || '')) continue;
            // One assistant record can contain multiple text blocks — they
            // must not share msg.uuid (the store de-dupes by ID, so all but
            // the last block would be lost). Suffix with the block index to
            // match the live-stream ID format in useStreamProcessor.
            messages.push({
              id: msg.uuid ? `${msg.uuid}_text_${blockIdx}` : generateMessageId(),
              role: 'assistant',
              type: 'text',
              content: block.text,
              timestamp: toMillis(msg.timestamp),
            });
          } else if (block.type === 'tool_use') {
            // Rebuild agent tree from Agent/Task tool_use blocks
            if (block.name === 'Task' || block.name === 'Agent') {
              agents.push({
                id: block.id || generateMessageId(),
                parentId: 'main',
                description: block.input?.description || block.input?.prompt || 'Agent',
                phase: 'completed',
                startTime: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
                endTime: Date.now(),
                isMain: false,
              });
            }

            let chatMsg: ChatMessage;
            if (block.name === 'AskUserQuestion' && block.input?.questions) {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'question',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                questions: block.input.questions,
                resolved: true,
                timestamp: toMillis(msg.timestamp),
              };
            } else if (block.name === 'TodoWrite' && block.input?.todos) {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'todo',
                content: '',
                toolName: block.name,
                toolInput: block.input,
                todoItems: block.input.todos,
                timestamp: toMillis(msg.timestamp),
              };
            } else {
              chatMsg = {
                id: block.id || generateMessageId(),
                role: 'assistant',
                type: 'tool_use',
                content: '',
                toolName: block.name,
                toolInput: capToolInput(block.input),
                timestamp: toMillis(msg.timestamp),
              };
            }
            // Record tool_use_id for later result binding
            if (block.id) {
              toolUseIdToIndex.set(block.id, messages.length);
            }
            messages.push(chatMsg);
          } else if (block.type === 'tool_result') {
            const resultText = Array.isArray(block.content)
              ? block.content.map((b: any) => b.text || b.content || '').join('')
              : typeof block.content === 'string'
                ? block.content
                : block.output || '';
            if (block.tool_use_id && resultText) {
              const idx = toolUseIdToIndex.get(block.tool_use_id);
              if (idx !== undefined && messages[idx]) {
                messages[idx] = { ...messages[idx], toolResultContent: capToolResult(resultText) };
              }
            }
          } else if (block.type === 'thinking') {
            messages.push({
              id: generateMessageId(),
              role: 'assistant',
              type: 'thinking',
              content: block.thinking || '',
              timestamp: toMillis(msg.timestamp),
            });
          }
        }
      }
    }
  }

  return { messages, agents, mainAgentStartTime: sessionStartTime, usage: usageRec };
}
