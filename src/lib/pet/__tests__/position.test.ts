import { beforeEach, describe, expect, it } from "vitest";
import { clampToMonitor, loadPetPosition, savePetPosition } from "../position";

const KEY = "tokenicode_pet_window_v1";

describe("clampToMonitor", () => {
  const monitor = { x: 100, y: 50, width: 1920, height: 1080 };
  const win = { width: 200, height: 300 };

  it("keeps a position inside the monitor", () => {
    expect(clampToMonitor({ x: 300, y: 400 }, win, monitor)).toEqual({
      x: 300,
      y: 400,
    });
  });

  it("clamps negative offsets to the edge margin", () => {
    const out = clampToMonitor({ x: 0, y: 0 }, win, monitor);
    expect(out.x).toBe(monitor.x + 8);
    expect(out.y).toBe(monitor.y + 8);
  });

  it("clamps overflow to the far edge minus window size", () => {
    const out = clampToMonitor({ x: 99999, y: 99999 }, win, monitor);
    expect(out.x).toBe(monitor.x + monitor.width - win.width - 8);
    expect(out.y).toBe(monitor.y + monitor.height - win.height - 8);
  });

  it("never drops below the margin even when monitor is smaller than the window", () => {
    const tiny = { x: 0, y: 0, width: 100, height: 100 };
    const out = clampToMonitor({ x: 10, y: 10 }, { width: 200, height: 300 }, tiny);
    expect(out.x).toBeGreaterThanOrEqual(tiny.x + 8);
    expect(out.y).toBeGreaterThanOrEqual(tiny.y + 8);
  });
});

describe("localStorage position persistence", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    // Minimal localStorage mock for the node test env.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  it("round-trips a saved position", () => {
    savePetPosition(120, 340, 1.5);
    expect(loadPetPosition()).toEqual({ x: 120, y: 340, scaleFactor: 1.5 });
  });

  it("returns null when nothing is saved", () => {
    expect(loadPetPosition()).toBeNull();
  });

  it("returns null on corrupt data", () => {
    store.set(KEY, "{not json");
    expect(loadPetPosition()).toBeNull();
  });

  it("returns null on a structurally wrong payload", () => {
    store.set(KEY, JSON.stringify({ x: "a", y: 1 }));
    expect(loadPetPosition()).toBeNull();
  });

  it("survives a missing localStorage (private mode)", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: undefined,
    });
    expect(() => savePetPosition(1, 2, 1)).not.toThrow();
    expect(loadPetPosition()).toBeNull();
  });
});
