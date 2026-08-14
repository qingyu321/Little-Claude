/** Semantics-aware full-context computation for streamed usage records.
 *
 * The FULL input context of a request is the number that genuinely occupies
 * the model's context window. With prompt caching enabled (the default),
 * 95%+ of the context sits in cache_read_input_tokens — comparing
 * input_tokens alone against the compact threshold made auto-compact
 * effectively never fire on real Anthropic data (input_tokens=6,
 * cache_read=85163).
 *
 * But the two endpoint families report input_tokens differently:
 *  - Anthropic official: input_tokens is the UNCACHED remainder. Full
 *    context = input + cacheRead + cacheCreation (cache write + cache hit
 *    are separate billable categories that all count against the window).
 *  - DeepSeek / OpenAI-compatible endpoints (incl. our proxy's OpenAI→
 *    Anthropic mapping): input_tokens is the FULL context, ALREADY
 *    including cache hits and writes. Verified on 96/96 usage-log records
 *    (5 sessions, first turn included): input == cache_read + cache_creation
 *    holds exactly, so summing the three fields double-counts (~140K shown
 *    for a real ~70K context).
 *
 * The semantics are detected from the numbers themselves: when the cached
 * share is non-zero and input alone covers it, input IS the full context.
 * (The only ambiguous case — Anthropic with a tiny cache hit and a large
 * fresh input — misreads by exactly the small cache-hit share, and only
 * when that share is < input, i.e. a few percent at most.)
 */

export interface ContextUsageParts {
  input: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Full input context of a request, regardless of which usage semantics the
 *  endpoint speaks. See the module comment for the detection rule. */
export function semanticContextTokens(b: ContextUsageParts): number {
  const cached = b.cacheRead + b.cacheCreation;
  if (cached > 0 && b.input >= cached) return b.input;
  return b.input + b.cacheRead + b.cacheCreation;
}

/** Normalize cache-creation tokens: the Claude CLI reports the same value
 *  both at the top level (usage.cache_creation_input_tokens) and inside the
 *  nested usage.cache_creation object (ephemeral_1h/5m). Summing them
 *  double-counts — prefer the top-level value; use the nested form only when
 *  the top level is absent (older CLI snapshots). Mirrors the Rust
 *  profile.rs cache_creation_tokens rule. */
export function normalizeCacheCreation(
  topLevel: number | undefined,
  ephemeral1h: number | undefined,
  ephemeral5m: number | undefined,
): number {
  const top = topLevel || 0;
  if (top > 0) return top;
  return (ephemeral1h || 0) + (ephemeral5m || 0);
}
