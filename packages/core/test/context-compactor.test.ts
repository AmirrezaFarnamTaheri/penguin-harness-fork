import { describe, expect, it } from "vitest";
import { ContextCompactor, type ConversationMessage } from "../src/agent/context-compactor.js";

describe("ContextCompactor", () => {
  it("skips compaction when conversation is too short to fold", async () => {
    const compactor = new ContextCompactor({ keepRecentTurns: 2 });
    const messages: ConversationMessage[] = [
      { role: "system", content: "You are an assistant" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ];

    const { compactedMessages, anchor } = await compactor.compact(messages);
    expect(anchor.status).toBe("skipped");
    expect(anchor.foldedCount).toBe(0);
    expect(compactedMessages.length).toBe(3);
  });

  it("compacts older messages while preserving system prompt and recent turns", async () => {
    const compactor = new ContextCompactor({ keepRecentTurns: 1 });
    const messages: ConversationMessage[] = [
      { role: "system", content: "System prompt" },
      {
        role: "user",
        content:
          "Step 1: research codebase extensively across packages/core, packages/server, and packages/web to find all occurrences of quota, model combos, and billing limits. ".repeat(
            4,
          ),
      },
      {
        role: "assistant",
        content:
          "Investigated 50 files across packages. Identified quota-parser.ts in core, gateway.ts in server routes, and quota-badge.tsx in web. Ready for next step. ".repeat(
            4,
          ),
      },
      {
        role: "user",
        content:
          "Step 2: edit file A to integrate the unified model combos, error classifications, and quota resets with full test coverage. ".repeat(
            4,
          ),
      },
      {
        role: "assistant",
        content:
          "File A edited successfully with full TypeScript typings, comprehensive error boundaries, and unit tests covering all edge cases. ".repeat(
            4,
          ),
      },
      { role: "user", content: "Step 3: run tests" },
      { role: "assistant", content: "All tests passing" },
    ];

    const { compactedMessages, anchor } = await compactor.compact(messages, "auto", "turn-start");

    expect(anchor.status).toBe("done");
    expect(anchor.foldedCount).toBe(4); // Folds step 1 and step 2
    expect(anchor.postTokens).toBeLessThan(anchor.preTokens!);

    // Index 0 must remain system prompt
    expect(compactedMessages[0]!.role).toBe("system");
    expect(compactedMessages[0]!.content).toBe("System prompt");

    // Index 1 must be summary message
    expect(compactedMessages[1]!.role).toBe("user");
    expect(compactedMessages[1]!.content).toContain("[Context Compaction Summary");
    expect(compactedMessages[1]!.content).toContain("research codebase");

    // Recent turn must be preserved intact
    const lastTwo = compactedMessages.slice(-2);
    expect(lastTwo[0]!.content).toBe("Step 3: run tests");
    expect(lastTwo[1]!.content).toBe("All tests passing");
  });

  it("supports custom summarizers when their output reduces context", async () => {
    const compactor = new ContextCompactor({ keepRecentTurns: 1 });
    const messages: ConversationMessage[] = [
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Resp 1" },
      { role: "user", content: "Turn 2" },
      { role: "assistant", content: "Resp 2" },
      { role: "user", content: "Turn 3" },
      { role: "assistant", content: "Resp 3" },
    ];

    const customSummarizer = async (_folded: ConversationMessage[]) => "S";

    const { compactedMessages, anchor } = await compactor.compact(
      messages,
      "manual",
      "in-loop",
      customSummarizer,
    );

    expect(anchor.status).toBe("done");
    expect(anchor.summary).toBe("S");
    expect(compactedMessages[0]!.content).toContain("S");
  });

  it("does not let an embedded compaction summary steal a keepRecentTurns slot from a real turn", async () => {
    // A prior summary carried `role: "user"`; counting it as a turn would make `keepRecentTurns: 2`
    // protect only one real turn, folding the oldest real turn out from under the window.
    const compactor = new ContextCompactor({ keepRecentTurns: 2 });
    const messages: ConversationMessage[] = [
      { role: "user", content: "Real turn one".repeat(20) },
      { role: "assistant", content: "Real reply one".repeat(20) },
      {
        id: "compaction-summary-abcdef12",
        role: "user",
        content: "[Context Compaction Summary - 4 earlier messages folded]\nPrior context.",
      },
      { role: "user", content: "Real turn two".repeat(20) },
      { role: "assistant", content: "Real reply two".repeat(20) },
    ];

    const { compactedMessages, anchor } = await compactor.compact(messages, "auto", "turn-start");

    // Both real turns must survive: the summary is context, not a turn, so it occupies no slot.
    expect(anchor.status).toBe("skipped");
    expect(compactedMessages.map((m) => m.content)).toContain("Real turn one".repeat(20));
  });

  it("retains the same number of real turns across repeated compactions", async () => {
    // Repeated auto-compaction must not shrink the retention window one turn at a time until it
    // can no longer compact at all.
    const compactor = new ContextCompactor({ keepRecentTurns: 2 });
    const big = (s: string) => s.repeat(20);
    const realTurnCount = (list: ConversationMessage[]) =>
      list.filter((m) => m.role === "user" && !String(m.id ?? "").startsWith("compaction-summary-"))
        .length;

    let current: ConversationMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: big("turn one asks for a big change. ") },
      { role: "assistant", content: big("reply one makes the big change. ") },
      { role: "user", content: big("turn two asks for another change. ") },
      { role: "assistant", content: big("reply two makes it. ") },
      { role: "user", content: big("turn three asks for a third change. ") },
      { role: "assistant", content: big("reply three makes it. ") },
      { role: "user", content: big("turn four asks for a fourth change. ") },
      { role: "assistant", content: big("reply four makes it. ") },
    ];

    const retained: number[] = [];
    for (let round = 0; round < 3; round++) {
      const result = await compactor.compact(current, "auto", "turn-start");
      retained.push(realTurnCount(result.compactedMessages));
      // The conversation keeps moving, so a fresh turn arrives after each compaction.
      current = [
        ...result.compactedMessages,
        { role: "user", content: big(`turn ${5 + round} arrives. `) },
        { role: "assistant", content: big(`reply ${5 + round} arrives. `) },
      ];
    }

    // Every round protects the same two real turns — never one, never zero.
    expect(retained).toEqual([2, 2, 2]);
  });
});
