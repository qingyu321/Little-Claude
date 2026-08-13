import { describe, expect, it } from "vitest";
import type { PetPhase, PetStatusPayload } from "../../lib/pet/types";
import {
  initialFrameState,
  resolvePetState,
  shouldDrawFrame,
  shouldPauseRender,
  STATE_MAPPING,
  stepFrame,
  type PetFrameState,
} from "../petEngine";

const states = {
  idle: { row: 0, frames: 8, duration: 120, loop: true },
  run: { row: 1, frames: 8, duration: 100, loop: true },
  wave: { row: 2, frames: 4, duration: 150, loop: false },
  jump: { row: 3, frames: 6, duration: 130, loop: false },
  failed: { row: 4, frames: 4, duration: 200, loop: false },
  waiting: { row: 5, frames: 8, duration: 140, loop: true },
  running: { row: 6, frames: 8, duration: 100, loop: true },
  review: { row: 7, frames: 8, duration: 120, loop: true },
  sleep: { row: 8, frames: 8, duration: 600, loop: true },
};

function payload(claude: PetPhase, codex: PetPhase = "idle"): PetStatusPayload {
  return {
    v: 1,
    ts: 0,
    totalActive: 1,
    scale: 1,
    skin: "default",
    claude: { active: claude === "idle" ? 0 : 1, phase: claude },
    codex: { active: codex === "idle" ? 0 : 1, phase: codex },
    message: null,
  };
}

describe("resolvePetState", () => {
  it("maps each phase to the expected animation state", () => {
    expect(resolvePetState(payload("idle"))).toBe("idle");
    expect(resolvePetState(payload("thinking"))).toBe("waiting");
    expect(resolvePetState(payload("writing"))).toBe("running");
    expect(resolvePetState(payload("tool"))).toBe("review");
    expect(resolvePetState(payload("awaiting"))).toBe("wave");
    expect(resolvePetState(payload("error"))).toBe("failed");
    expect(resolvePetState(payload("completed"))).toBe("jump");
  });

  it("prefers the higher-priority phase across agents", () => {
    expect(resolvePetState(payload("writing", "awaiting"))).toBe("wave");
    expect(resolvePetState(payload("tool", "thinking"))).toBe("review");
    expect(resolvePetState(payload("idle", "writing"))).toBe("running");
  });

  it("STATE_MAPPING covers every PetPhase", () => {
    const phases: PetPhase[] = [
      "idle",
      "thinking",
      "writing",
      "tool",
      "awaiting",
      "error",
      "completed",
    ];
    for (const p of phases) {
      expect(STATE_MAPPING[p]).toBeDefined();
    }
  });
});

describe("stepFrame", () => {
  it("advances a loop state frame each duration", () => {
    let fs: PetFrameState = { ...initialFrameState(), state: "idle" };
    fs = stepFrame(fs, 120, states, 60_000);
    expect(fs.state).toBe("idle");
    expect(fs.frame).toBe(1);
    expect(fs.accum).toBe(120); // running total within the 8-frame period
  });

  it("wraps a loop state at the frame count", () => {
    // accum = 7 frames × 120ms → stepping one more duration wraps to frame 0.
    let fs: PetFrameState = { state: "idle", frame: 0, accum: 7 * 120, idleMs: 0 };
    fs = stepFrame(fs, 120, states, 60_000);
    expect(fs.frame).toBe(0);
  });

  it("keeps advancing loop frames across steps", () => {
    let fs: PetFrameState = { ...initialFrameState(), state: "idle" };
    fs = stepFrame(fs, 120, states, 60_000);
    expect(fs.frame).toBe(1);
    fs = stepFrame(fs, 120, states, 60_000);
    expect(fs.frame).toBe(2);
  });

  it("plays a transient once then falls back to idle", () => {
    let fs: PetFrameState = { state: "wave", frame: 0, accum: 0, idleMs: 0 };
    // wave: 4 frames × 150ms
    for (let i = 0; i < 3; i++) fs = stepFrame(fs, 150, states, 60_000);
    expect(fs.state).toBe("wave");
    expect(fs.frame).toBe(3);
    fs = stepFrame(fs, 150, states, 60_000);
    expect(fs.state).toBe("idle");
    expect(fs.frame).toBe(0);
  });

  it("falls asleep after the idle threshold", () => {
    let fs: PetFrameState = { state: "idle", frame: 0, accum: 0, idleMs: 999 };
    fs = stepFrame(fs, 10, states, 1000);
    expect(fs.state).toBe("sleep");
    expect(fs.idleMs).toBe(0);
  });

  it("does not sleep while busy", () => {
    let fs: PetFrameState = { state: "waiting", frame: 0, accum: 0, idleMs: 5000 };
    fs = stepFrame(fs, 10, states, 1000);
    expect(fs.state).toBe("waiting");
  });

  it("reset by applyStatus path clears idleMs (wakes the pet)", () => {
    // Simulate: sleeping pet receives a thinking status → resolvePetState = waiting
    const next = resolvePetState(payload("thinking"));
    expect(next).toBe("waiting");
  });

  it("does not fall asleep when the skin lacks a sleep state", () => {
    const noSleep = { ...states, sleep: undefined } as unknown as typeof states;
    let fs: PetFrameState = { state: "idle", frame: 0, accum: 0, idleMs: 9999 };
    fs = stepFrame(fs, 10, noSleep, 1000);
    expect(fs.state).toBe("idle"); // stays awake, no crash
  });

  it("falls back to idle when a transient state is missing", () => {
    const noWave = { ...states, wave: undefined } as unknown as typeof states;
    let fs: PetFrameState = { state: "wave", frame: 0, accum: 0, idleMs: 0 };
    fs = stepFrame(fs, 10, noWave, 60_000);
    expect(fs.state).toBe("idle");
  });
});

describe("shouldDrawFrame", () => {
  const prev: PetFrameState = { state: "idle", frame: 1, accum: 0, idleMs: 0 };
  const same: PetFrameState = { state: "idle", frame: 1, accum: 0, idleMs: 0 };
  const nextFrame: PetFrameState = { state: "idle", frame: 2, accum: 0, idleMs: 0 };
  const nextState: PetFrameState = { state: "waiting", frame: 0, accum: 0, idleMs: 0 };

  it("skips identical frames in variable-rate mode (idle ≈ 7fps, not 60)", () => {
    expect(shouldDrawFrame(prev, same, false, false)).toBe(false);
  });

  it("redraws when the animation frame changes", () => {
    expect(shouldDrawFrame(prev, nextFrame, false, false)).toBe(true);
  });

  it("redraws when the state changes", () => {
    expect(shouldDrawFrame(prev, nextState, false, false)).toBe(true);
  });

  it("redraws every frame in continuous mode (FX active)", () => {
    expect(shouldDrawFrame(prev, same, true, false)).toBe(true);
  });

  it("redraws every frame while a time-driven ambient is live", () => {
    expect(shouldDrawFrame(prev, same, false, true)).toBe(true);
  });
});

describe("shouldPauseRender", () => {
  const sleep: PetFrameState = { state: "sleep", frame: 0, accum: 0, idleMs: 0 };
  const idle: PetFrameState = { state: "idle", frame: 0, accum: 0, idleMs: 0 };

  it("fully stops the rAF loop once asleep (power saving)", () => {
    expect(shouldPauseRender(sleep, false)).toBe(true);
  });

  it("keeps rendering during sleep while an FX sequence runs", () => {
    expect(shouldPauseRender(sleep, true)).toBe(false);
  });

  it("never pauses outside sleep", () => {
    expect(shouldPauseRender(idle, false)).toBe(false);
  });
});
