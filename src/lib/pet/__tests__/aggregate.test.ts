import { describe, expect, it } from "vitest";
import { computePetStatus, type PetAggregateInput, type PetTabLike } from "../aggregate";
import type { PetMessageTemplates } from "../types";

const templates: PetMessageTemplates = {
  awaiting: (toolName) => `等待权限：${toolName}`,
  tool: (toolName) => `使用工具：${toolName}`,
  writing: (preview) => preview,
  thinking: () => "思考中…",
  error: (detail) => `出错了：${detail}`,
  completed: () => "完成",
};

function tab(partial: Partial<PetTabLike> = {}): PetTabLike {
  return {
    sessionStatus: "running",
    activityStatus: { phase: "idle" },
    sessionMeta: {},
    ...partial,
  };
}

function input(overrides: Partial<PetAggregateInput> = {}): PetAggregateInput {
  return {
    tabs: new Map(),
    streams: new Map(),
    runningSessions: new Set(),
    defaultBackend: "claude",
    templates,
    now: 1000,
    ...overrides,
  };
}

describe("computePetStatus", () => {
  it("all idle when nothing active", () => {
    const out = computePetStatus(input());
    expect(out.totalActive).toBe(0);
    expect(out.claude).toMatchObject({ active: 0, phase: "idle" });
    expect(out.codex).toMatchObject({ active: 0, phase: "idle" });
    expect(out.message).toBeNull();
  });

  it("counts and phases an active claude writing tab but produces NO bubble", () => {
    // Live-phase bubbles were removed (they flashed by faster than readable);
    // the pet reports completion/error only.
    const tabs = new Map([["t1", tab({ activityStatus: { phase: "writing" } })]]);
    const running = new Set(["t1"]);
    const streams = new Map([["t1", { partialText: "hello", isStreaming: true }]]);
    const out = computePetStatus(input({ tabs, runningSessions: running, streams }));
    expect(out.totalActive).toBe(1);
    expect(out.claude.active).toBe(1);
    expect(out.claude.phase).toBe("writing");
    expect(out.codex.active).toBe(0);
    expect(out.message).toBeNull();
  });

  it("merges higher-priority phase across same-agent sessions", () => {
    const tabs = new Map([
      ["t1", tab({ activityStatus: { phase: "thinking" } })],
      ["t2", tab({ activityStatus: { phase: "tool", toolName: "Bash" } })],
    ]);
    const running = new Set(["t1", "t2"]);
    const out = computePetStatus(input({ tabs, runningSessions: running }));
    expect(out.claude.active).toBe(2);
    expect(out.claude.phase).toBe("tool");
    expect(out.claude.toolName).toBe("Bash");
  });

  it("separates claude and codex sessions via snapshotCliBackend", () => {
    const tabs = new Map([
      [
        "c",
        tab({
          activityStatus: { phase: "writing" },
          sessionMeta: { snapshotCliBackend: "claude" },
        }),
      ],
      [
        "x",
        tab({
          activityStatus: { phase: "thinking" },
          sessionMeta: { snapshotCliBackend: "codex" },
        }),
      ],
    ]);
    const running = new Set(["c", "x"]);
    const out = computePetStatus(input({ tabs, runningSessions: running }));
    expect(out.claude.active).toBe(1);
    expect(out.claude.phase).toBe("writing");
    expect(out.codex.active).toBe(1);
    expect(out.codex.phase).toBe("thinking");
  });

  it("falls back to defaultBackend when snapshotCliBackend is missing", () => {
    const tabs = new Map([
      ["t1", tab({ activityStatus: { phase: "awaiting", toolName: "Read" } })],
    ]);
    const running = new Set(["t1"]);
    const out = computePetStatus(
      input({ tabs, runningSessions: running, defaultBackend: "codex" }),
    );
    expect(out.codex.active).toBe(1);
    expect(out.codex.phase).toBe("awaiting");
    expect(out.message).toBeNull(); // awaiting 是活跃阶段，不产生气泡
  });

  it("writing with empty partialText produces no bubble", () => {
    const tabs = new Map([["t1", tab({ activityStatus: { phase: "writing" } })]]);
    const running = new Set(["t1"]);
    const streams = new Map([["t1", { partialText: "  ", isStreaming: true }]]);
    const out = computePetStatus(input({ tabs, runningSessions: running, streams }));
    expect(out.claude.phase).toBe("writing");
    expect(out.message).toBeNull();
  });

  it("reports completion on an active completed tab", () => {
    const tabs = new Map([
      ["t1", tab({ sessionStatus: "completed", activityStatus: { phase: "completed" } })],
    ]);
    const running = new Set(["t1"]);
    const out = computePetStatus(input({ tabs, runningSessions: running }));
    expect(out.message).toMatchObject({ source: "claude", kind: "completed" });
    expect(out.message?.ttlMs).toBe(8000);
  });

  it("reports completion even after the session left the active set", () => {
    // The 200ms aggregation cycle after exit: not running, not streaming —
    // but the tab still carries the terminal status. Without this branch the
    // report would be invisible (this was the original "一闪而过" bug).
    const tabs = new Map([
      ["t1", tab({ sessionStatus: "completed", activityStatus: { phase: "completed" } })],
    ]);
    const out = computePetStatus(input({ tabs }));
    expect(out.totalActive).toBe(0); // badge/tokens unaffected
    expect(out.message).toMatchObject({ source: "claude", kind: "completed", text: "完成" });
  });

  it("reports error after the session left the active set", () => {
    const tabs = new Map([
      [
        "t1",
        tab({
          sessionStatus: "error",
          activityStatus: { phase: "error", statusMessage: "boom" },
        }),
      ],
    ]);
    const out = computePetStatus(input({ tabs }));
    expect(out.message).toMatchObject({ kind: "error", text: "出错了：boom" });
  });

  it("terminal-phase reports never come from an idle-status tab", () => {
    const tabs = new Map([["t1", tab({ sessionStatus: "idle" })]]);
    const out = computePetStatus(input({ tabs }));
    expect(out.message).toBeNull();
  });

  it("inactive tabs (not running, not streaming) are ignored", () => {
    const tabs = new Map([["t1", tab({ activityStatus: { phase: "writing" } })]]);
    // runningSessions empty, streams empty → not active
    const out = computePetStatus(input({ tabs }));
    expect(out.totalActive).toBe(0);
    expect(out.message).toBeNull();
  });

  it("attaches token usage to the matching agent", () => {
    const tabs = new Map([
      [
        "c",
        tab({
          activityStatus: { phase: "writing" },
          sessionMeta: {
            snapshotCliBackend: "claude",
            inputTokens: 1200,
            outputTokens: 340,
            cacheReadTokens: 8000,
            cacheCreationTokens: 0,
          },
        }),
      ],
    ]);
    const running = new Set(["c"]);
    const out = computePetStatus(input({ tabs, runningSessions: running }));
    expect(out.claude.input).toBe(1200);
    expect(out.claude.output).toBe(340);
    expect(out.claude.cacheRead).toBe(8000);
    expect(out.claude.cacheCreation).toBe(0);
  });

  it("token usage is the SUM across all active tabs of the agent", () => {
    const tabs = new Map([
      [
        "c1",
        tab({
          activityStatus: { phase: "thinking" },
          sessionMeta: {
            snapshotCliBackend: "claude",
            inputTokens: 100,
            outputTokens: 10,
          },
        }),
      ],
      [
        "c2",
        tab({
          activityStatus: { phase: "tool", toolName: "Bash" },
          sessionMeta: {
            snapshotCliBackend: "claude",
            inputTokens: 5000,
            outputTokens: 900,
            cacheReadTokens: 200,
            cacheCreationTokens: 50,
          },
        }),
      ],
      [
        "x1",
        tab({
          activityStatus: { phase: "writing" },
          sessionMeta: {
            snapshotCliBackend: "codex",
            inputTokens: 3000,
            outputTokens: 120,
          },
        }),
      ],
    ]);
    const running = new Set(["c1", "c2", "x1"]);
    const out = computePetStatus(input({ tabs, runningSessions: running }));
    // claude: c1 + c2 summed (per-turn tokens of every active session).
    expect(out.claude.input).toBe(5100);
    expect(out.claude.output).toBe(910);
    expect(out.claude.cacheRead).toBe(200);
    expect(out.claude.cacheCreation).toBe(50);
    // codex: x1's own sum — agents are aggregated independently.
    expect(out.codex.input).toBe(3000);
    expect(out.codex.output).toBe(120);
    expect(out.codex.cacheRead).toBe(0);
    expect(out.codex.cacheCreation).toBe(0);
  });

  it("a later-finished session supersedes an earlier same-priority report", () => {
    // Persistent reports: without replacement, the FIRST completed session
    // would own the bubble forever and every later completion would be
    // swallowed (the old TTL used to free the slot after 8s).
    const tabs = new Map([
      ["t1", tab({ sessionStatus: "completed", activityStatus: { phase: "completed" } })],
      ["t2", tab({ sessionStatus: "completed", activityStatus: { phase: "completed" } })],
    ]);
    const out = computePetStatus(input({ tabs }));
    // t2 (later in iteration order) wins at equal priority — and carries its
    // own tabId so the main window keys it as a DISTINCT report.
    expect(out.message).toMatchObject({ source: "claude", kind: "completed", tabId: "t2" });
  });

  it("idle tabs contribute no tokens to the sum", () => {
    const tabs = new Map([
      [
        "c1",
        tab({
          activityStatus: { phase: "thinking" },
          sessionMeta: { inputTokens: 500 },
        }),
      ],
      [
        "c2",
        tab({
          activityStatus: { phase: "idle" },
          sessionMeta: { inputTokens: 999 },
        }),
      ],
    ]);
    const running = new Set(["c1", "c2"]);
    const out = computePetStatus(input({ tabs, runningSessions: running }));
    expect(out.claude.input).toBe(500);
  });
});
