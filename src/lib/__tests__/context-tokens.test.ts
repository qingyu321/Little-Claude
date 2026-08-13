import { describe, expect, it } from "vitest";
import { semanticContextTokens } from "../context-tokens";

describe("semanticContextTokens", () => {
  it("returns input alone under DeepSeek semantics (input already includes the cached share)", () => {
    // Verified on 96/96 usage-log records: input == cache_read + cache_creation.
    expect(semanticContextTokens({ input: 70308, cacheRead: 69504, cacheCreation: 804 }))
      .toBe(70308);
  });

  it("handles a DeepSeek first turn (no cache hit yet — the whole context is a cache write)", () => {
    expect(semanticContextTokens({ input: 38436, cacheRead: 0, cacheCreation: 38436 }))
      .toBe(38436);
  });

  it("sums all three parts under Anthropic semantics (input is only the uncached remainder)", () => {
    // Real Anthropic shape: input_tokens=6, cache_read=85163, creation=14244.
    expect(semanticContextTokens({ input: 6, cacheRead: 85163, cacheCreation: 14244 }))
      .toBe(99413);
  });

  it("handles an Anthropic cache-write turn (no reads, small fresh remainder)", () => {
    expect(semanticContextTokens({ input: 5000, cacheRead: 0, cacheCreation: 80000 }))
      .toBe(85000);
  });

  it("returns bare input when nothing is cached", () => {
    expect(semanticContextTokens({ input: 1234, cacheRead: 0, cacheCreation: 0 }))
      .toBe(1234);
  });

  it("returns zero for an all-zero usage record", () => {
    expect(semanticContextTokens({ input: 0, cacheRead: 0, cacheCreation: 0 })).toBe(0);
  });

  it("does not regress the previous double-count on Anthropic-style data (sum of three)", () => {
    const b = { input: 6, cacheRead: 85163, cacheCreation: 0 };
    expect(semanticContextTokens(b)).toBe(85169); // old formula value
    expect(semanticContextTokens(b)).toBe(b.input + b.cacheRead + b.cacheCreation);
  });
});
