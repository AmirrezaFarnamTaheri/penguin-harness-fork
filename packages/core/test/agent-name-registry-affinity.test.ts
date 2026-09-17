import { describe, expect, it } from "vitest";
import { AgentNameRegistry } from "../src/agent/agent-name-registry.js";

describe("agent skill affinity", () => {
  it("counts each successful completion per owner and domain", () => {
    const registry = new AgentNameRegistry();
    registry.assign("owner-1");
    registry.recordSuccess("owner-1", "ast_refactor");
    registry.recordSuccess("owner-1", "ast_refactor");
    registry.recordSuccess("owner-1", "test_runs");
    expect(registry.getAffinity("owner-1", "ast_refactor")).toBe(2);
    expect(registry.getAffinity("owner-1", "test_runs")).toBe(1);
    expect(registry.getAffinity("owner-1", "untouched")).toBe(0);
    expect(registry.getAffinity("other-owner", "ast_refactor")).toBe(0);
  });

  it("keeps affinity independent of name assignment and persists across revival", () => {
    const registry = new AgentNameRegistry();
    expect(registry.assign("coder")).not.toBe(registry.assign("reviewer"));
    registry.recordSuccess("reviewer", "code_review");
    // Reviving the owner must not reset what they are known to be good at.
    registry.assign("reviewer");
    registry.recordSuccess("reviewer", "code_review");
    expect(registry.getAffinity("reviewer", "code_review")).toBe(2);
    expect(registry.getAffinity("reviewer", "code_review")).toBe(2);
    expect(() => registry.recordSuccess("reviewer", "")).toThrow();
    expect(registry.getAffinity("reviewer", "")).toBe(0);
  });

  it("returns a rank-ordered affinity view per owner", () => {
    const registry = new AgentNameRegistry();
    registry.recordSuccess("worker", "b");
    registry.recordSuccess("worker", "a");
    registry.recordSuccess("worker", "b");
    expect(registry.affinityDomains("worker")).toEqual(["b", "a"]);
    expect(registry.affinityDomains("nobody")).toEqual([]);
  });
});
