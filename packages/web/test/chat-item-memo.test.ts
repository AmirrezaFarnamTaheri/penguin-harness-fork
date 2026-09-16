/**
 * Unit tests for ChatItem and WorkGroup stabilization & memoization.
 * Verifies active vs settled item classification, transition-render gating,
 * and skipping redundant re-renders on subsequent stream version bumps.
 */
import { describe, expect, it } from "vitest";
import { approvalKey } from "../src/lib/omni/stream-model";
import type {
  AssistantTextItem,
  ChatItem,
  ThinkingItem,
  ToolCallItem,
  UserTextItem,
} from "../src/lib/omni/stream-model";
import {
  areMessageItemPropsEqual,
  isItemActive,
  itemRenderState,
  recordItemRenderState,
} from "../src/features/chat/message-item";
import type { MessageItemProps } from "../src/features/chat/message-item";
import {
  areWorkGroupPropsEqual,
  isWorkGroupActive,
  recordWorkGroupRenderState,
  workGroupRenderState,
} from "../src/features/chat/work-group";
import type { WorkGroupProps } from "../src/features/chat/work-group";
import type { StreamRenderContext } from "../src/features/chat/message-stream";

function makeMockContext(overrides: Partial<StreamRenderContext> = {}): StreamRenderContext {
  return {
    pendingApprovals: new Map(),
    onApprove: async () => {},
    origin: [],
    taskRunning: false,
    ...overrides,
  };
}

describe("isItemActive", () => {
  it("classifies assistant_text streaming state accurately", () => {
    const ctx = makeMockContext();
    const streamingItem: AssistantTextItem = {
      kind: "assistant_text",
      id: 1,
      text: "hello",
      streaming: true,
    };
    expect(isItemActive(streamingItem, ctx)).toBe(true);

    const settledItem: AssistantTextItem = {
      kind: "assistant_text",
      id: 1,
      text: "hello world",
      streaming: false,
    };
    expect(isItemActive(settledItem, ctx)).toBe(false);
  });

  it("classifies thinking streaming state accurately", () => {
    const ctx = makeMockContext();
    const streamingItem: ThinkingItem = {
      kind: "thinking",
      id: 2,
      thinking: "pondering",
      streaming: true,
    };
    expect(isItemActive(streamingItem, ctx)).toBe(true);

    const settledItem: ThinkingItem = {
      kind: "thinking",
      id: 2,
      thinking: "pondered",
      streaming: false,
    };
    expect(isItemActive(settledItem, ctx)).toBe(false);
  });

  it("classifies tool_call phases (call streaming, executing, output streaming, pending approval)", () => {
    const ctx = makeMockContext();
    const toolCall: ToolCallItem = {
      kind: "tool_call",
      id: 3,
      toolCallId: "call_abc",
      name: "exec_command",
      argumentsText: '{"cmd":"ls"}',
      callStreaming: true,
      callComplete: false,
      output: "",
      outputStreaming: false,
      outputComplete: false,
    };
    // Call streaming
    expect(isItemActive(toolCall, ctx)).toBe(true);

    // Call complete, executing (output not complete)
    toolCall.callStreaming = false;
    toolCall.callComplete = true;
    expect(isItemActive(toolCall, ctx)).toBe(true);

    // Output streaming
    toolCall.outputStreaming = true;
    expect(isItemActive(toolCall, ctx)).toBe(true);

    // Output complete (settled)
    toolCall.outputStreaming = false;
    toolCall.outputComplete = true;
    expect(isItemActive(toolCall, ctx)).toBe(false);

    // Pending approval forces active even if callComplete
    const approvalCtx = makeMockContext({
      pendingApprovals: new Map([
        [
          approvalKey([], "call_abc"),
          {
            toolCall: {} as any,
            approvalTarget: { name: "exec_command" },
          },
        ],
      ]),
    });
    expect(isItemActive(toolCall, approvalCtx)).toBe(true);
  });

  it("identifies immutable items as immediately settled", () => {
    const ctx = makeMockContext();
    const userText: UserTextItem = {
      kind: "user_text",
      id: 4,
      text: "hello agent",
    };
    expect(isItemActive(userText, ctx)).toBe(false);
  });
});

describe("areMessageItemPropsEqual", () => {
  it("keeps re-rendering while streaming, forces transition render on settle, then skips subsequent renders", () => {
    const ctx = makeMockContext();
    const item: AssistantTextItem = {
      kind: "assistant_text",
      id: 10,
      text: "Part 1",
      streaming: true,
    };
    const props: MessageItemProps = { item, ctx };

    // 1. First render during active streaming
    expect(areMessageItemPropsEqual(props, props)).toBe(false);
    recordItemRenderState(item, ctx);
    expect(itemRenderState.get(item)?.settled).toBe(false);

    // 2. Token delta arrives in place
    item.text = "Part 1 and 2";
    expect(areMessageItemPropsEqual(props, props)).toBe(false);
    recordItemRenderState(item, ctx);

    // 3. Stream settles in place
    item.streaming = false;
    // Because last rendered state was not settled, it MUST re-render to reflect the settled state!
    expect(areMessageItemPropsEqual(props, props)).toBe(false);
    // Transition render commits and records settled state
    recordItemRenderState(item, ctx);
    expect(itemRenderState.get(item)?.settled).toBe(true);

    // 4. Subsequent stream version bumps while item is settled
    const nextCtx = makeMockContext(); // Fresh object reference
    const nextProps: MessageItemProps = { item, ctx: nextCtx };
    expect(areMessageItemPropsEqual(props, nextProps)).toBe(true);
    expect(areMessageItemPropsEqual(nextProps, nextProps)).toBe(true);
  });

  it("re-renders when tool_call decision mutates upon settle", () => {
    const ctx = makeMockContext();
    const toolCall: ToolCallItem = {
      kind: "tool_call",
      id: 11,
      toolCallId: "call_def",
      name: "write_file",
      argumentsText: '{"file_path":"test.ts"}',
      callStreaming: false,
      callComplete: true,
      output: "written",
      outputStreaming: false,
      outputComplete: true,
    };
    const props: MessageItemProps = { item: toolCall, ctx };
    recordItemRenderState(toolCall, ctx);

    // Initial settled comparison
    expect(areMessageItemPropsEqual(props, props)).toBe(true);

    // Decision updated
    toolCall.decision = "allow";
    expect(areMessageItemPropsEqual(props, props)).toBe(false);
  });

  it("re-renders when item instance or kind changes", () => {
    const ctx = makeMockContext();
    const itemA: UserTextItem = { kind: "user_text", id: 1, text: "A" };
    const itemB: UserTextItem = { kind: "user_text", id: 2, text: "B" };
    expect(areMessageItemPropsEqual({ item: itemA, ctx }, { item: itemB, ctx })).toBe(false);
  });
});

describe("areWorkGroupPropsEqual", () => {
  it("keeps re-rendering while running, settles on completion, and skips redundant renders", () => {
    const ctxRunning = makeMockContext({ taskRunning: true });
    const toolCall: ToolCallItem = {
      kind: "tool_call",
      id: 20,
      toolCallId: "call_work",
      name: "read_file",
      argumentsText: '{"file_path":"foo.ts"}',
      callStreaming: false,
      callComplete: true,
      output: "",
      outputStreaming: false,
      outputComplete: false, // still executing
    };
    const items: ChatItem[] = [toolCall];
    const groupProps: WorkGroupProps = {
      items,
      ctx: ctxRunning,
      isLast: true,
    };

    // 1. Group active (tool is executing)
    expect(isWorkGroupActive(items, ctxRunning, true)).toBe(true);
    expect(areWorkGroupPropsEqual(groupProps, groupProps)).toBe(false);
    recordWorkGroupRenderState(items, ctxRunning, true);
    expect(workGroupRenderState.get(toolCall)?.settled).toBe(false);

    // 2. Tool finishes execution, but task is still running as last segment
    toolCall.outputComplete = true;
    expect(isWorkGroupActive(items, ctxRunning, true)).toBe(true);
    expect(areWorkGroupPropsEqual(groupProps, groupProps)).toBe(false);

    // 3. New segment arrives (e.g. assistant reply begins), making this group isLast: false
    const groupSettledProps: WorkGroupProps = {
      items,
      ctx: ctxRunning,
      isLast: false,
    };
    expect(isWorkGroupActive(items, ctxRunning, false)).toBe(false);
    // Transition render must fire because prev.isLast !== next.isLast AND state.settled was false
    expect(areWorkGroupPropsEqual(groupProps, groupSettledProps)).toBe(false);

    // Transition render commits
    recordWorkGroupRenderState(items, ctxRunning, false);
    expect(workGroupRenderState.get(toolCall)?.settled).toBe(true);

    // 4. Subsequent version bumps with fresh ctx object: skips re-rendering
    const freshCtx = makeMockContext({ taskRunning: true });
    const nextGroupProps: WorkGroupProps = {
      items,
      ctx: freshCtx,
      isLast: false,
    };
    expect(areWorkGroupPropsEqual(groupSettledProps, nextGroupProps)).toBe(true);
  });

  it("re-renders when item count in the group changes", () => {
    const ctx = makeMockContext({ taskRunning: false });
    const tool1: ToolCallItem = {
      kind: "tool_call",
      id: 31,
      toolCallId: "c1",
      name: "read_file",
      argumentsText: "{}",
      callStreaming: false,
      callComplete: true,
      output: "ok",
      outputStreaming: false,
      outputComplete: true,
    };
    const tool2: ToolCallItem = {
      kind: "tool_call",
      id: 32,
      toolCallId: "c2",
      name: "write_file",
      argumentsText: "{}",
      callStreaming: false,
      callComplete: true,
      output: "ok",
      outputStreaming: false,
      outputComplete: true,
    };

    const prev: WorkGroupProps = { items: [tool1], ctx, isLast: false };
    recordWorkGroupRenderState([tool1], ctx, false);
    const next: WorkGroupProps = { items: [tool1, tool2], ctx, isLast: false };

    expect(areWorkGroupPropsEqual(prev, next)).toBe(false);
  });
});
