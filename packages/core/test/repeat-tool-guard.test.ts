import { describe, it, expect } from "vitest";
import {
  RepeatToolGuard,
  sortJsonValue,
  canonicalizeArguments,
  wildcardToRegExp,
  previewArguments,
} from "../src/agent/repeat-tool-guard.js";

describe("RepeatToolGuard", () => {
  describe("canonicalization and sorting", () => {
    it("sorts object keys recursively to produce identical JSON representations", () => {
      const obj1 = { b: 2, a: 1, nested: { z: 9, y: 8 } };
      const obj2 = { a: 1, b: 2, nested: { y: 8, z: 9 } };

      const canon1 = canonicalizeArguments(obj1);
      const canon2 = canonicalizeArguments(obj2);

      expect(canon1).toBe(canon2);
      expect(canon1).toBe('{"a":1,"b":2,"nested":{"y":8,"z":9}}');
    });

    it("handles arrays while preserving array order and sorting object elements", () => {
      const arr1 = [
        { beta: 1, alpha: 2 },
        { delta: 3, gamma: 4 },
      ];
      const arr2 = [
        { alpha: 2, beta: 1 },
        { gamma: 4, delta: 3 },
      ];

      expect(canonicalizeArguments(arr1)).toBe(canonicalizeArguments(arr2));
    });

    it("truncates long argument strings in preview", () => {
      const longStr = "a".repeat(100);
      const preview = previewArguments(longStr, 20);
      expect(preview).toBe("aaaaaaaaaaaaaaaaaaaa... (+80 more chars)");
    });
  });

  describe("wildcard pattern matching", () => {
    it("matches wildcard tool names", () => {
      const regex = wildcardToRegExp("mcp_*");
      expect(regex.test("mcp_search")).toBe(true);
      expect(regex.test("mcp_execute_code")).toBe(true);
      expect(regex.test("bash_execute")).toBe(false);
    });
  });

  describe("repetition detection and escalation", () => {
    it("triggers gentle reminder on first threshold and detailed on subsequent thresholds", () => {
      const guard = new RepeatToolGuard({
        thresholds: [3, 5, 8],
      });

      const agent = "agent-1";
      const tool = "read_file";
      const args = { path: "src/index.ts" };

      // Calls 1 and 2: no reminder
      expect(guard.observe(agent, tool, args)).toBeUndefined();
      expect(guard.observe(agent, tool, args)).toBeUndefined();

      // Call 3 (first threshold): gentle reminder
      const reminder3 = guard.observe(agent, tool, args);
      expect(reminder3).toBeDefined();
      expect(reminder3!.count).toBe(3);
      expect(reminder3!.isGentle).toBe(true);
      expect(reminder3!.message).toContain("repeating the exact same tool call");

      // Call 4: between thresholds -> undefined
      expect(guard.observe(agent, tool, args)).toBeUndefined();

      // Call 5 (second threshold): detailed escalating reminder
      const reminder5 = guard.observe(agent, tool, args);
      expect(reminder5).toBeDefined();
      expect(reminder5!.count).toBe(5);
      expect(reminder5!.isGentle).toBe(false);
      expect(reminder5!.message).toContain("Repeated tool call detected:");
      expect(reminder5!.message).toContain("consecutive_calls: 5");
    });

    it("resets tracking counter when tool or arguments change", () => {
      const guard = new RepeatToolGuard({ thresholds: [3, 5] });
      const agent = "agent-1";

      guard.observe(agent, "search", { q: "foo" });
      guard.observe(agent, "search", { q: "foo" });

      // Change argument
      guard.observe(agent, "search", { q: "bar" });
      // Next call with "bar" should be count 2, not 3
      const reminder = guard.observe(agent, "search", { q: "bar" });
      expect(reminder).toBeUndefined();

      const chain = guard.getChain(agent);
      expect(chain?.count).toBe(2);
    });

    it("supports explicit agent reset", () => {
      const guard = new RepeatToolGuard({ thresholds: [2] });
      const agent = "agent-1";

      guard.observe(agent, "ping", {});
      guard.reset(agent);

      // After reset, this is count 1
      expect(guard.observe(agent, "ping", {})).toBeUndefined();
    });

    it("honors include and exclude tool filters", () => {
      const guard = new RepeatToolGuard({
        thresholds: [2],
        include: ["safe_*"],
        exclude: ["safe_exempt_*"],
      });

      // Untracked because not in include
      guard.observe("a", "unsafe_tool", {});
      expect(guard.observe("a", "unsafe_tool", {})).toBeUndefined();

      // Untracked because excluded
      guard.observe("a", "safe_exempt_tool", {});
      expect(guard.observe("a", "safe_exempt_tool", {})).toBeUndefined();

      // Tracked
      guard.observe("a", "safe_query", {});
      const rem = guard.observe("a", "safe_query", {});
      expect(rem).toBeDefined();
      expect(rem!.count).toBe(2);
    });

    it("validates invalid configurations fail loud", () => {
      expect(() => new RepeatToolGuard({ thresholds: [] })).toThrow("empty");
      expect(() => new RepeatToolGuard({ thresholds: [1] })).toThrow(">= 2");
      expect(() => new RepeatToolGuard({ thresholds: [3, 3] })).toThrow("duplicates");
      expect(() => new RepeatToolGuard({ argumentsPreviewChars: 0 })).toThrow(">= 1");
    });
  });
});
