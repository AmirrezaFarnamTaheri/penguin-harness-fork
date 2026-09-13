import { describe, expect, it } from "vitest";
import { SignalChainManager } from "../src/agent/signal-chain.js";

describe("SignalChainManager", () => {
  it("tracks provenance from root source to signal to action to attempts", () => {
    const manager = new SignalChainManager({ maxDepth: 10, maxRetries: 2 });

    const source = manager.registerSource({
      sourceType: "user_prompt",
      payload: { text: "Fix authentication token issue" },
      scope: { userId: "user-123", taskId: "task-abc" },
    });

    expect(source.chain.depth).toBe(0);
    expect(source.chain.rootSourceId).toBe(source.sourceId);

    const signal = manager.emitSignal({
      sourceId: source.sourceId,
      signalType: "tool_call_request",
      payload: { tool: "edit_file", path: "src/auth.ts" },
    });

    expect(signal.chain.depth).toBe(1);
    expect(signal.chain.rootSourceId).toBe(source.sourceId);

    const action = manager.dispatchAction({
      signalId: signal.signalId,
      actionType: "execute_tool",
      payload: { command: "replace_file_content" },
    });

    expect(action.chain.depth).toBe(2);
    expect(action.status).toBe("pending");

    const attempt1 = manager.startAttempt(action.actionId);
    const afterFail = manager.completeAttempt(action.actionId, {
      attemptNumber: attempt1.attemptNumber,
      status: "failed",
      error: "Syntax error on line 42",
    });
    expect(afterFail.status).toBe("pending");

    const attempt2 = manager.startAttempt(action.actionId);
    const afterSuccess = manager.completeAttempt(action.actionId, {
      attemptNumber: attempt2.attemptNumber,
      status: "succeeded",
      output: { diff: "+ patched line 42" },
    });
    expect(afterSuccess.status).toBe("succeeded");
    expect(afterSuccess.attempts.length).toBe(2);

    const trace = manager.getTrace(action.actionId);
    expect(trace.length).toBe(3);
    expect(trace[0]?.chain.rootSourceId).toBe(source.sourceId);
    expect((trace[0] as any).sourceType).toBe("user_prompt");
    expect((trace[1] as any).signalType).toBe("tool_call_request");
    expect((trace[2] as any).actionType).toBe("execute_tool");
  });

  it("rejects duplicate causal node identities instead of erasing history", () => {
    const manager = new SignalChainManager({ maxRetries: 1 });
    const source = manager.registerSource({ sourceId: "source-1", sourceType: "trigger" });
    const signal = manager.emitSignal({
      signalId: "signal-1",
      sourceId: source.sourceId,
      signalType: "go",
    });
    const action = manager.dispatchAction({
      actionId: "action-1",
      signalId: signal.signalId,
      actionType: "run",
    });
    const attempt = manager.startAttempt(action.actionId);
    manager.completeAttempt(action.actionId, {
      attemptNumber: attempt.attemptNumber,
      status: "failed",
    });

    expect(() =>
      manager.dispatchAction({
        actionId: "action-1",
        signalId: signal.signalId,
        actionType: "run-again",
      }),
    ).toThrow(/already registered/);
    expect(manager.getAction("action-1")?.status).toBe("failed");
    expect(manager.getAction("action-1")?.attempts).toHaveLength(1);
  });

  it("enforces max depth to prevent runaway cascading loops", () => {
    const manager = new SignalChainManager({ maxDepth: 2 });
    const source = manager.registerSource({ sourceType: "trigger" });
    const sig1 = manager.emitSignal({ sourceId: source.sourceId, signalType: "step_1" });
    const act1 = manager.dispatchAction({ signalId: sig1.signalId, actionType: "step_2" });

    expect(() =>
      manager.emitSignal({
        sourceId: source.sourceId,
        parentActionId: act1.actionId,
        signalType: "step_3",
      }),
    ).toThrow(/Exceeded maximum causal depth/);
  });
});
