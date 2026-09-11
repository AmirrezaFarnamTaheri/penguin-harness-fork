import { describe, expect, it } from "vitest";
import { PersonaRegistry } from "../src/agent/persona-masks.js";

describe("PersonaRegistry", () => {
  it("loads built-in personas and filters by category", () => {
    const registry = new PersonaRegistry();
    const personas = registry.listPersonas();
    expect(personas.length).toBeGreaterThan(5);

    const eng = registry.listPersonas("engineering");
    expect(eng.some((p) => p.id === "software_architect")).toBe(true);
    expect(eng.some((p) => p.id === "fullstack_engineer")).toBe(true);

    const sec = registry.getPersona("security_auditor");
    expect(sec?.name).toBe("Security Auditor");
    expect(sec?.category).toBe("security");
  });

  it("renders system prompts with optional extra instructions", () => {
    const registry = new PersonaRegistry();
    const prompt = registry.renderSystemPrompt("qa_test_engineer", {
      extraInstructions: "Focus specifically on vitest mocking and edge cases.",
    });

    expect(prompt).toContain("QA & Test Engineer");
    expect(prompt).toContain("Focus specifically on vitest mocking and edge cases.");
  });
});
