import { describe, expect, it } from "vitest";
import { ContextCompactor, type ConversationMessage } from "../src/agent/context-compactor.js";

/**
 * Both payloads below bury their salient line (a code declaration, a test failure) behind
 * >120 chars of filler so the legacy flattening preview cannot reach it. AST-aware
 * extraction must surface the salient line from anywhere in the message, verbatim.
 */
const TOOL_RESULT_WITH_LATE_SIGNATURE = [
  "read 512 lines from src/math.ts; traced 3 call sites; checked git blame and recent diffs; scanned imports and re-exports; ran formatter; refreshed the symbol index for the workspace.",
  "export function add(a: number, b: number): number { return a + b; }",
].join("\n");

const ASSISTANT_WITH_LATE_ERROR = [
  "I ran the test suite twice, re-read the failing spec, compared fixtures against the golden files, checked for stale build artifacts in the out directory, and re-ran with the verbose reporter to collect the full diff output before concluding.",
  "Tests failed with AssertionError: expected 5 to be 4",
].join("\n");

describe("ContextCompactor AST-aware semantic compaction", () => {
  it("preserves function signatures and test diffs while shedding intermediate tool chatter", async () => {
    const compactor = new ContextCompactor({ astAware: true, keepRecentTurns: 1 });
    const messages: ConversationMessage[] = [
      { role: "user", content: "Implement add(a, b)" },
      { role: "tool", content: TOOL_RESULT_WITH_LATE_SIGNATURE },
      { role: "assistant", content: ASSISTANT_WITH_LATE_ERROR },
      { role: "user", content: "Run tests again" },
      { role: "assistant", content: "All tests passing" },
    ];

    const { anchor } = await compactor.compact(messages);

    expect(anchor.status).toBe("done");
    expect(anchor.summary).toContain("export function add(a: number, b: number): number");
    expect(anchor.summary).toContain("AssertionError: expected 5 to be 4");
  });

  it("keeps the legacy flattening behavior when astAware is not enabled", async () => {
    const compactor = new ContextCompactor({ keepRecentTurns: 1 });
    const messages: ConversationMessage[] = [
      { role: "user", content: "Implement add(a, b)" },
      { role: "tool", content: TOOL_RESULT_WITH_LATE_SIGNATURE },
      { role: "assistant", content: ASSISTANT_WITH_LATE_ERROR },
      { role: "user", content: "Run tests" },
      { role: "assistant", content: "Done" },
    ];

    const { anchor } = await compactor.compact(messages);
    expect(anchor.status).toBe("done");
    // The legacy preview truncates at 120 chars, so a signature buried behind filler is lost.
    expect(anchor.summary).not.toContain("export function add(a: number, b: number): number");
    expect(anchor.summary).not.toContain("AssertionError: expected 5 to be 4");
  });
});
