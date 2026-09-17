/**
 * T38 reconciliation: PersonaRegistry.renderSystemPrompt and PromptCatalog.assemble
 * exist separately; there is no assemblePersonaPrompt or automatic role/vendor binding.
 * These tests pin string assembly, not model behavior or prompt confidentiality.
 * Neither assembler promises to redact prompts from user-visible responses.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_PERSONA_MASKS, PersonaRegistry } from "../src/agent/persona-masks.js";
import { BUILTIN_PROMPT_PROFILES, PromptCatalog } from "../src/agent/prompt-catalog.js";

describe("persona role rendering", () => {
  it.each(BUILTIN_PERSONA_MASKS)(
    "preserves the complete $id role and runtime instructions",
    (persona) => {
      const registry = new PersonaRegistry();
      const extraInstructions = "Runtime instruction: report verification results.";

      expect(registry.renderSystemPrompt(persona.id)).toBe(persona.systemPrompt);
      expect(registry.renderSystemPrompt(persona.id, { extraInstructions })).toBe(
        `${persona.systemPrompt}\n\n## Additional Instructions\n${extraInstructions}`,
      );
      expect(registry.renderSystemPrompt(persona.id, { extraInstructions: "" })).toBe(
        persona.systemPrompt,
      );
      // Rendering one invocation must not contaminate the next invocation.
      expect(registry.renderSystemPrompt(persona.id)).toBe(persona.systemPrompt);
    },
  );
});

describe("vendor profile assembly", () => {
  it.each(BUILTIN_PROMPT_PROFILES)(
    "preserves $vendor/$id instructions and interpolates runtime options",
    (profile) => {
      const catalog = new PromptCatalog();
      const allowedTools = ["read_file", "grep_search"];
      const customDirectives = ["Review only the requested files.", "Report verification results."];
      const options = {
        allowedTools,
        customDirectives,
        workspaceRoot: "D:/Workspace/review project",
        additionalContext: "Review scope: the current branch.",
      };
      const before = structuredClone(options);
      const base = [
        profile.systemPrompt,
        "### Core Principles\n" +
          profile.principles.map((principle) => `- ${principle}`).join("\n"),
        `### Tool Calling Guidelines\n${profile.toolCallingDirectives}`,
      ].join("\n\n");
      const expected = [
        base,
        "### Permitted Tools\n`read_file`, `grep_search`",
        "### Workspace Context\nWorking Directory: `D:/Workspace/review project`",
        "### Task Directives\n- Review only the requested files.\n- Report verification results.",
        "### Additional Context\nReview scope: the current branch.",
      ].join("\n\n");

      expect(catalog.assemble(profile.id, options)).toBe(expected);
      expect(catalog.assemble(profile.id.toUpperCase(), options)).toBe(expected);
      expect(options).toEqual(before);
      // Previous runtime options must not carry into later assemblies.
      expect(catalog.assemble(profile.id)).toBe(base);
      expect(
        catalog.assemble(profile.id, {
          allowedTools: [],
          customDirectives: [],
          workspaceRoot: "",
          additionalContext: "",
        }),
      ).toBe(base);
    },
  );

  it("omits empty optional sections in a registered minimal profile", () => {
    const catalog = new PromptCatalog([
      {
        id: "minimal",
        name: "Minimal profile",
        vendor: "custom",
        description: "Assembly regression fixture",
        targetModels: [],
        principles: [],
        toolCallingDirectives: "",
        systemPrompt: "You are a documentation reviewer.",
        recommendedTemperature: 0,
      },
    ]);

    expect(catalog.assemble("minimal")).toBe("You are a documentation reviewer.");
    expect(catalog.assemble("minimal", { allowedTools: ["read_file"] })).toBe(
      "You are a documentation reviewer.\n\n### Permitted Tools\n`read_file`",
    );
  });
});
