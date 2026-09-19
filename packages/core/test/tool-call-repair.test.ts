import { describe, it, expect } from "vitest";
import {
  isTruncatedJSON,
  repairTruncatedJSON,
  scavengeToolCalls,
  truncateKeepEnds,
} from "../src/llm/tool-call-repair.js";

// Assembled from parts so the markers stay literal in this file rather than being parsed as tags.
const OPEN_THINK = "<" + "think" + ">";
const CLOSE_THINK = "<" + "/think" + ">";

describe("isTruncatedJSON", () => {
  it("returns false for valid complete JSON", () => {
    expect(isTruncatedJSON('{"name": "test", "value": 123}')).toBe(false);
    expect(isTruncatedJSON("[1, 2, 3]")).toBe(false);
    expect(isTruncatedJSON('"simple string"')).toBe(false);
    expect(isTruncatedJSON("")).toBe(false);
  });

  it("detects truncated JSON with missing closing braces", () => {
    expect(isTruncatedJSON('{"name": "test", "items": [1, 2')).toBe(true);
    expect(isTruncatedJSON('{"command": "ls", "args": {')).toBe(true);
  });

  it("ignores braces inside string literals", () => {
    expect(isTruncatedJSON('{"pattern": "foo { bar } baz"}')).toBe(false);
    expect(isTruncatedJSON('{"pattern": "foo { bar"')).toBe(true);
  });

  it("handles escaped characters inside strings", () => {
    expect(isTruncatedJSON('{"escaped": "quote \\" and { brace"}')).toBe(false);
  });
});

describe("repairTruncatedJSON", () => {
  it("leaves already valid JSON untouched", () => {
    const input = '{"status": "ok", "code": 200}';
    const res = repairTruncatedJSON(input);
    expect(res.fixed).toBe(false);
    expect(res.repaired).toBe(input);
  });

  it("closes unclosed brackets and braces", () => {
    const input = '{"items": ["apple", "banana"';
    const res = repairTruncatedJSON(input);
    expect(res.fixed).toBe(true);
    expect(JSON.parse(res.repaired)).toEqual({ items: ["apple", "banana"] });
  });

  it("closes unclosed strings before closing structures", () => {
    const input = '{"user": "alice", "action": "run_test';
    const res = repairTruncatedJSON(input);
    expect(res.fixed).toBe(true);
    const parsed = JSON.parse(res.repaired);
    expect(parsed.user).toBe("alice");
    expect(parsed.action).toBe("run_test");
  });

  it("cleans trailing commas before closing braces", () => {
    const input = '{"a": 1, "b": 2,';
    const res = repairTruncatedJSON(input);
    expect(res.fixed).toBe(true);
    expect(JSON.parse(res.repaired)).toEqual({ a: 1, b: 2 });
  });

  it("handles dangling keys without values", () => {
    const input = '{"completed": true, "result":';
    const res = repairTruncatedJSON(input);
    expect(res.fixed).toBe(true);
    expect(JSON.parse(res.repaired)).toEqual({ completed: true });
  });
});

describe("scavengeToolCalls", () => {
  it("scavenges tool calls from <think> reasoning blocks", () => {
    const response = `<think>
I should use read_file to inspect the config:
\`\`\`json
{"function": {"name": "read_file", "arguments": {"path": "config.json"}}}
\`\`\`
</think>
Here is my plan.`;

    const calls = scavengeToolCalls(response);
    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe("read_file");
    expect(calls[0]!.arguments).toEqual({ path: "config.json" });
    expect(calls[0]!.source).toBe("think_tag");
  });

  it("scavenges tool calls from markdown code fences", () => {
    const response = `I will run the test command:
\`\`\`json
{"name": "run_command", "arguments": {"command": "npm test"}}
\`\`\``;

    const calls = scavengeToolCalls(response);
    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe("run_command");
    expect(calls[0]!.arguments).toEqual({ command: "npm test" });
    expect(calls[0]!.source).toBe("code_fence");
  });

  it("handles stringified arguments within scavenged tool calls", () => {
    const response = `{"function": {"name": "grep_search", "arguments": "{\\"query\\": \\"TODO\\", \\"path\\": \\"src\\"}"}}`;
    const calls = scavengeToolCalls(response);
    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe("grep_search");
    expect(calls[0]!.arguments).toEqual({ query: "TODO", path: "src" });
  });

  it("deduplicates identical scavenged calls", () => {
    const response = `<think>
{"name": "list_dir", "arguments": {"path": "."}}
</think>
\`\`\`json
{"name": "list_dir", "arguments": {"path": "."}}
\`\`\``;

    const calls = scavengeToolCalls(response);
    expect(calls.length).toBe(1);
  });

  it("keeps two identical parallel calls from the same source", () => {
    // A retry after a transient error, or two reasoning branches each reading the same path: these
    // are distinct calls that must not be collapsed into one.
    const response = [
      '{"name": "read_file", "arguments": {"path": "src/a.ts"}}',
      "meanwhile, unrelated reasoning happens here",
      '{"name": "read_file", "arguments": {"path": "src/a.ts"}}',
    ].join("\n");

    const found = scavengeToolCalls(response);
    expect(found.length).toBe(2);
    expect(found.every((c) => c.source === "inline_pattern")).toBe(true);
    expect(new Set(found.map((c) => c.id)).size).toBe(2);
  });

  it("keeps identical calls living in two separate think tags", () => {
    const call = '{"name": "read_file", "arguments": {"path": "src/a.ts"}}';
    const response = [OPEN_THINK, call, CLOSE_THINK, OPEN_THINK, call, CLOSE_THINK].join("\n");

    const found = scavengeToolCalls(response);
    expect(found.length).toBe(2);
    expect(found.every((c) => c.source === "think_tag")).toBe(true);
  });

  it("still collapses one call re-extracted across overlapping passes", () => {
    // The same call surfacing in a think tag and again in inline text is one call, not two: the
    // inline pass re-scans the think tag's text, so the repeat reaches a different source.
    const call = '{"name": "read_file", "arguments": {"path": "src/a.ts"}}';
    const response = [OPEN_THINK, call, CLOSE_THINK, `Inline echo: ${call}`].join("\n");

    const found = scavengeToolCalls(response);
    expect(found.length).toBe(1);
    expect(found[0]!.source).toBe("think_tag");
  });
});

describe("truncateKeepEnds", () => {
  it("does not truncate content within limits", () => {
    const text = "Short text under cap";
    expect(truncateKeepEnds(text, 100)).toBe(text);
  });

  it("preserves head context and tail conclusion when truncating", () => {
    const head = "START_OF_LOG: Initializing build pipeline. Running step 1, 2, 3...";
    const middle = "MIDDLE_JUNK_".repeat(500);
    const tail = "...FINAL_RESULT: Build succeeded with 0 errors and 1 warning.";
    const full = head + middle + tail;

    const truncated = truncateKeepEnds(full, 200);
    expect(truncated.length).toBeLessThan(full.length);
    expect(truncated).toContain("START_OF_LOG");
    expect(truncated).toContain("FINAL_RESULT");
    expect(truncated).toContain("[Truncated");
  });
});
