import { describe, expect, it } from "vitest";
import { PromptCatalog, BUILTIN_PROMPT_PROFILES } from "../src/agent/prompt-catalog.js";

describe("PromptCatalog", () => {
  it("initializes with all builtin profiles", () => {
    const catalog = new PromptCatalog();
    expect(catalog.list().length).toBe(BUILTIN_PROMPT_PROFILES.length);
    expect(catalog.has("claude_code_standard")).toBe(true);
    expect(catalog.has("openai_o3_thinking")).toBe(true);
    expect(catalog.has("deepseek_r1_reasoning")).toBe(true);
    expect(catalog.has("xai_grok_engineer")).toBe(true);
    expect(catalog.has("perplexity_researcher")).toBe(true);
  });

  it("filters profiles by vendor", () => {
    const catalog = new PromptCatalog();
    const anthropicProfiles = catalog.list("anthropic");
    expect(anthropicProfiles.length).toBeGreaterThanOrEqual(1);
    expect(anthropicProfiles[0]!.vendor).toBe("anthropic");

    const openaiProfiles = catalog.list("openai");
    expect(openaiProfiles.length).toBeGreaterThanOrEqual(1);
    expect(openaiProfiles[0]!.vendor).toBe("openai");
  });

  it("assembles complete prompt with options", () => {
    const catalog = new PromptCatalog();
    const assembled = catalog.assemble("claude_code_standard", {
      customDirectives: ["Never modify lockfiles directly."],
      allowedTools: ["read_file", "write_file"],
      workspaceRoot: "D:/GitHub/project",
      additionalContext: "Target branch is feat/my-branch.",
    });

    expect(assembled).toContain("You are an elite coding agent");
    expect(assembled).toContain("### Core Principles");
    expect(assembled).toContain("### Permitted Tools");
    expect(assembled).toContain("`read_file`, `write_file`");
    expect(assembled).toContain("### Workspace Context");
    expect(assembled).toContain("D:/GitHub/project");
    expect(assembled).toContain("Never modify lockfiles directly.");
    expect(assembled).toContain("Target branch is feat/my-branch.");
  });

  it("throws for unregistered profile IDs", () => {
    const catalog = new PromptCatalog();
    expect(() => catalog.assemble("nonexistent_profile")).toThrow(
      'Prompt profile "nonexistent_profile" is not registered',
    );
  });
});
