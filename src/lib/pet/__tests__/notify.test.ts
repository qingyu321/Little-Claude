import { describe, expect, it } from "vitest";
import { shouldNotify, type NotifyLast } from "../notify";

describe("shouldNotify", () => {
  const last: NotifyLast = { phase: "completed", at: 0 };

  it("fires on active → completed", () => {
    expect(shouldNotify("writing", "completed", null, 1000)).toBe(true);
  });

  it("fires on active → error", () => {
    expect(shouldNotify("tool", "error", null, 1000)).toBe(true);
  });

  it("does not fire when the previous phase is unknown (startup)", () => {
    expect(shouldNotify(undefined, "completed", null, 1000)).toBe(false);
  });

  it("does not fire on idle → completed", () => {
    expect(shouldNotify("idle", "completed", null, 1000)).toBe(false);
  });

  it("does not fire on completed → completed", () => {
    expect(shouldNotify("completed", "completed", null, 1000)).toBe(false);
  });

  it("throttles within the per-agent cooldown window", () => {
    expect(shouldNotify("writing", "completed", last, 1000, 30_000)).toBe(false);
    // After the window elapses, a new active → completed transition fires again.
    expect(shouldNotify("writing", "completed", { ...last, at: 0 }, 31_000, 30_000)).toBe(true);
  });
});
