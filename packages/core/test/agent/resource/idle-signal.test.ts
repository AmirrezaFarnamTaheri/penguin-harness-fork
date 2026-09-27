import { describe, it, expect, vi } from "vitest";
import { AgentIdleSignal } from "../../../src/agent/resource/idle-signal.js";

describe("AgentIdleSignal", () => {
  it("is idle from construction when nothing has been declared", () => {
    const signal = new AgentIdleSignal({ now: () => 1000 });
    expect(signal.isIdle(0, 1000)).toBe(true);
    expect(signal.idleSince(0, 1000)).toBe(1000);
  });

  it("is not idle one millisecond short of the threshold", () => {
    const signal = new AgentIdleSignal({ now: () => 0 });
    expect(signal.isIdle(1000, 999)).toBe(false);
    expect(signal.idleSince(1000, 999)).toBeNull();
  });

  it("is idle exactly at the threshold", () => {
    // `>=` rather than `>`: an agent idle for exactly the configured window has been idle
    // that long, and treating the boundary as active would make every timer fire one tick late.
    const signal = new AgentIdleSignal({ now: () => 0 });
    expect(signal.isIdle(1000, 1000)).toBe(true);
    expect(signal.idleSince(1000, 1000)).toBe(0);
  });

  it("noteActivity resets the idle clock", () => {
    let t = 0;
    const signal = new AgentIdleSignal({ now: () => t });
    t = 10_000;
    expect(signal.isIdle(1000, 10_000)).toBe(true);

    t = 10_500;
    signal.noteActivity();
    expect(signal.lastActivity).toBe(10_500);
    expect(signal.isIdle(1000, 10_500)).toBe(false);
    expect(signal.isIdle(1000, 11_400)).toBe(false);
    expect(signal.isIdle(1000, 11_500)).toBe(true);
  });

  it("accepts an explicit activity timestamp", () => {
    const signal = new AgentIdleSignal({ now: () => 0 });
    signal.noteActivity(5_000);
    expect(signal.lastActivity).toBe(5_000);
  });

  it("never goes idle under a stream of activity", () => {
    // The load-bearing property: an agent doing work every 500ms is never idle at a 1000ms
    // threshold, no matter how long the run goes on. This is the "does not fire under load"
    // guarantee, at the signal that all release decisions hang off.
    let t = 0;
    const signal = new AgentIdleSignal({ now: () => t });
    let wentIdle = false;
    for (let i = 0; i < 10_000; i++) {
      t = i * 500;
      signal.noteActivity();
      if (signal.isIdle(1000, t)) wentIdle = true;
    }
    expect(wentIdle).toBe(false);
  });

  it("reports remaining idle time, floored at zero", () => {
    const signal = new AgentIdleSignal({ now: () => 0 });
    expect(signal.remainingIdleMs(1000, 0)).toBe(1000);
    expect(signal.remainingIdleMs(1000, 400)).toBe(600);
    expect(signal.remainingIdleMs(1000, 5000)).toBe(0);
  });
});

describe("AgentIdleSignal scheduling", () => {
  it("does not schedule anything on its own", () => {
    // The signal is a pure comparison. A sweep loop is the caller's business, and a signal
    // that kept its own timer would hold a handle open for the life of the process.
    const spy = vi.spyOn(globalThis, "setTimeout");
    const signal = new AgentIdleSignal();
    signal.noteActivity();
    expect(signal.isIdle(0));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
