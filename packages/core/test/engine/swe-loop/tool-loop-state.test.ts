import { describe, expect, it } from "vitest";

import {
  ToolLoopStateMachine,
  type ToolLoopLimits,
} from "../../../src/engine/swe-loop/tool-loop-state.js";

/** Drives one full happy-path tool call, returning the machine. */
function happyRun(limits: Partial<ToolLoopLimits> = {}): ToolLoopStateMachine {
  const machine = new ToolLoopStateMachine(limits);
  machine.transition("enter_planning", "awaiting_model");
  machine.transition("model_responded", "dispatching");
  machine.transition("tool_dispatched", "running", {
    toolName: "read_file",
    args: { path: "a.ts" },
  });
  machine.transition("tool_succeeded", "observing");
  return machine;
}

describe("ToolLoopStateMachine transitions", () => {
  it("runs the happy path through to a submitted result", () => {
    const machine = happyRun();
    machine.transition("submit_requested", "submitting");
    machine.transition("submit_completed", "submitted");

    expect(machine.getState()).toBe("submitted");
    expect(machine.isTerminal()).toBe(true);
    expect(machine.getTransitions().map((transition) => transition.kind)).toEqual([
      "enter_planning",
      "model_responded",
      "tool_dispatched",
      "tool_succeeded",
      "submit_requested",
      "submit_completed",
    ]);
  });

  it("counts model calls, tool calls and steps", () => {
    const machine = happyRun();
    const snapshot = machine.snapshot();
    expect(snapshot.modelCalls).toBe(1);
    expect(snapshot.toolCalls).toBe(1);
    expect(snapshot.step).toBe(1);
    expect(snapshot.terminal).toBe(false);
  });

  it("throws on an illegal transition and names both states", () => {
    const machine = new ToolLoopStateMachine();
    expect(() => machine.transition("tool_dispatched", "running")).toThrow(
      /Illegal tool-loop transition: event 'tool_dispatched' from 'planning' to 'running'/,
    );
    // The failed transition left the machine untouched.
    expect(machine.getState()).toBe("planning");
  });

  it("refuses every transition once the run is terminal", () => {
    const machine = happyRun();
    machine.transition("abort", "aborted");
    expect(machine.isTerminal()).toBe(true);
    expect(machine.getExitStatus()).toBeUndefined();
    expect(() => machine.transition("enter_planning", "awaiting_model")).toThrow(
      /Tool loop is terminal \('aborted'\)/,
    );
  });

  it("records a model request that produces no action as a self-transition", () => {
    const machine = new ToolLoopStateMachine();
    machine.transition("enter_planning", "awaiting_model");
    machine.transition("model_requested", "awaiting_model");
    expect(machine.snapshot().modelCalls).toBe(2);
  });

  it("can submit straight from a tool result without an intervening planning step", () => {
    const machine = new ToolLoopStateMachine();
    machine.transition("enter_planning", "awaiting_model");
    machine.transition("model_responded", "submitting");
    machine.transition("submit_completed", "submitted");
    expect(machine.getState()).toBe("submitted");
  });
});

describe("ToolLoopStateMachine budgets", () => {
  it("blocks a further step once the step budget is exhausted", () => {
    const machine = new ToolLoopStateMachine({ maxSteps: 1 });
    expect(machine.canStep()).toEqual({ allowed: true });
    // One tool dispatch consumes the single step.
    machine.transition("enter_planning", "awaiting_model");
    machine.transition("model_responded", "dispatching");
    machine.transition("tool_dispatched", "running");
    expect(machine.canStep().allowed).toBe(false);
    expect(machine.canStep().reason).toMatch(/step budget exhausted \(1\/1\)/);
  });

  it("blocks on a spent cost budget", () => {
    const machine = new ToolLoopStateMachine({ costLimit: 0 });
    expect(machine.canStep().allowed).toBe(false);
    expect(machine.canStep().reason).toMatch(/cost budget exhausted/);
  });

  it("blocks on a spent wall-time budget", () => {
    const machine = new ToolLoopStateMachine({ wallTimeLimitMs: 0 });
    expect(machine.canStep().allowed).toBe(false);
    expect(machine.canStep().reason).toMatch(/wall-time budget exhausted/);
  });

  it("records cost and forces a terminal transition on budget breach", () => {
    const machine = new ToolLoopStateMachine({ costLimit: 2 });
    machine.recordCost(1);
    expect(machine.isTerminal()).toBe(false);
    machine.recordCost(1);
    expect(machine.getState()).toBe("limit_exceeded");
    expect(machine.getExitStatus()).toBe("CostLimitExceeded");
  });

  it("ignores non-positive cost deltas", () => {
    const machine = new ToolLoopStateMachine({ costLimit: 1 });
    machine.recordCost(-5);
    machine.recordCost(Number.NaN);
    expect(machine.snapshot().cost).toBe(0);
    expect(machine.isTerminal()).toBe(false);
  });
});

describe("ToolLoopStateMachine format errors", () => {
  it("ends the run after the configured number of consecutive format errors", () => {
    const machine = new ToolLoopStateMachine({ maxConsecutiveFormatErrors: 3 });
    machine.transition("enter_planning", "awaiting_model");
    machine.transition("format_error", "format_error");
    expect(machine.snapshot().consecutiveFormatErrors).toBe(1);
    machine.transition("format_error", "format_error");
    expect(machine.snapshot().consecutiveFormatErrors).toBe(2);
    expect(machine.isTerminal()).toBe(false);
    // The third consecutive failure is a stop condition, not another retry.
    machine.transition("format_error", "format_error");
    expect(machine.getState()).toBe("exited");
    expect(machine.getExitStatus()).toBe("RepeatedFormatError");
    expect(machine.isTerminal()).toBe(true);
    expect(machine.snapshot().totalFormatErrors).toBe(3);
  });

  it("resets the streak on clean forward progress", () => {
    const machine = new ToolLoopStateMachine({ maxConsecutiveFormatErrors: 3 });
    machine.transition("enter_planning", "awaiting_model");
    machine.transition("format_error", "format_error");
    machine.transition("format_error", "format_error");
    expect(machine.snapshot().consecutiveFormatErrors).toBe(2);

    // A retry then a clean response zeroes the streak.
    machine.retry("with_output");
    expect(machine.getState()).toBe("retrying");
    machine.transition("model_responded", "dispatching");
    expect(machine.snapshot().consecutiveFormatErrors).toBe(0);

    // Two more errors after the reset do not trip a limit that needed three in
    // a row — proof the earlier streak was actually cleared.
    machine.transition("format_error", "format_error");
    machine.transition("format_error", "format_error");
    expect(machine.snapshot().consecutiveFormatErrors).toBe(2);
    expect(machine.isTerminal()).toBe(false);
  });
});

describe("ToolLoopStateMachine repeat detection", () => {
  it("flags a tool signature repeated past the threshold", () => {
    const machine = new ToolLoopStateMachine({ maxRepeats: 2 });
    expect(machine.trackRepeat("edit_file", { path: "a.ts" })).toEqual({
      breaking: false,
      repeats: 1,
    });
    expect(machine.trackRepeat("edit_file", { path: "a.ts" })).toEqual({
      breaking: false,
      repeats: 2,
    });
    const third = machine.trackRepeat("edit_file", { path: "a.ts" });
    expect(third).toEqual({ breaking: true, repeats: 3 });
    expect(machine.getState()).toBe("exited");
    expect(machine.getExitStatus()).toBe("LoopDetected");
    expect(machine.snapshot().lastSignature).toBe('edit_file::{"path":"a.ts"}');
  });

  it("does not conflate different arguments with a repeat", () => {
    const machine = new ToolLoopStateMachine({ maxRepeats: 2 });
    machine.trackRepeat("edit_file", { path: "a.ts" });
    machine.trackRepeat("edit_file", { path: "b.ts" });
    expect(machine.snapshot().repeatCount).toBe(1);
    expect(machine.isTerminal()).toBe(false);
  });
});

describe("ToolLoopStateMachine stall accounting", () => {
  it("increments on a stall and decrements on evidence of progress", () => {
    const machine = new ToolLoopStateMachine({ maxStalls: 3 });
    expect(machine.recordStall(true)).toEqual({ stalls: 1, replanning: false });
    expect(machine.recordStall(true)).toEqual({ stalls: 2, replanning: false });
    expect(machine.recordStall(false)).toEqual({ stalls: 1, replanning: false });
    expect(machine.recordStall(false)).toEqual({ stalls: 0, replanning: false });
  });

  it("floors the stall counter at zero", () => {
    const machine = new ToolLoopStateMachine({ maxStalls: 3 });
    machine.recordStall(false);
    machine.recordStall(false);
    expect(machine.snapshot().stalls).toBe(0);
  });

  it("forces a re-plan when the stall budget is breached", () => {
    const machine = new ToolLoopStateMachine({ maxStalls: 2 });
    machine.recordStall(true);
    const breached = machine.recordStall(true);
    expect(breached).toEqual({ stalls: 2, replanning: true });
    expect(machine.getState()).toBe("limit_exceeded");
    expect(machine.getExitStatus()).toBe("StallBudgetExceeded");
  });

  it("does not stall-account a terminal run", () => {
    const machine = happyRun();
    machine.transition("abort", "aborted");
    expect(machine.recordStall(true)).toEqual({ stalls: 0, replanning: false });
  });
});

describe("ToolLoopStateMachine retries", () => {
  it("records the retry token and whether the failed output is retained", () => {
    const machine = new ToolLoopStateMachine();
    machine.transition("enter_planning", "awaiting_model");
    machine.transition("format_error", "format_error");

    const withOutput = machine.retry("with_output");
    expect(withOutput.kind).toBe("retry_with_output");
    expect(withOutput.note).toMatch(/retains the failed observation/);
    expect(machine.snapshot()).toMatchObject({ retries: 1, lastRetryMode: "with_output" });

    machine.transition("model_responded", "format_error");
    const withoutOutput = machine.retry("without_output");
    expect(withoutOutput.kind).toBe("retry_without_output");
    expect(withoutOutput.note).toMatch(/drops the failed observation/);
    expect(machine.snapshot()).toMatchObject({ retries: 2, lastRetryMode: "without_output" });
  });

  it("only allows a retry from a format error", () => {
    const machine = new ToolLoopStateMachine();
    machine.transition("enter_planning", "awaiting_model");
    expect(() => machine.retry("with_output")).toThrow(/Illegal tool-loop transition/);
  });
});
