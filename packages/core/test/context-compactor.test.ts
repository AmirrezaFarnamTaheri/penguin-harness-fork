import { describe, expect, it } from "vitest";
import {
  ContextCompactor,
  type ConversationMessage,
} from "../src/agent/context-compactor.js";

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
          "Step 1: research codebase extensively across packages/core, packages/server, and packages/web to find all occurrences of quota, model combos, and billing limits.",
      },
      {
        role: "assistant",
        content:
          "Investigated 50 files across packages. Identified quota-parser.ts in core, gateway.ts in server routes, and quota-badge.tsx in web. Ready for next step.",
      },
      {
        role: "user",
        content:
          "Step 2: edit file A to integrate the unified model combos, error classifications, and quota resets with full test coverage.",
      },
      {
        role: "assistant",
        content:
          "File A edited successfully with full TypeScript typings, comprehensive error boundaries, and unit tests covering all edge cases.",
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

  it("supports custom summarizers", async () => {
    const compactor = new ContextCompactor({ keepRecentTurns: 1 });
    const messages: ConversationMessage[] = [
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Resp 1" },
      { role: "user", content: "Turn 2" },
      { role: "assistant", content: "Resp 2" },
      { role: "user", content: "Turn 3" },
      { role: "assistant", content: "Resp 3" },
    ];

    const customSummarizer = async (folded: ConversationMessage[]) => {
      return `Custom synthesized summary of ${folded.length} messages`;
    };

    const { compactedMessages, anchor } = await compactor.compact(
      messages,
      "manual",
      "in-loop",
      customSummarizer
    );

    expect(anchor.status).toBe("done");
    expect(anchor.summary).toContain("Custom synthesized summary of 4 messages");
    expect(compactedMessages[0]!.content).toContain("Custom synthesized summary");
  });
});
