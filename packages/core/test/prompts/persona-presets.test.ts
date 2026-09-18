import { describe, expect, it } from "vitest";

import { BUILTIN_PROMPT_PROFILES as LEGACY_PROFILES } from "../../src/agent/prompt-catalog.js";
import {
  type PersonaPreset,
  BUILTIN_PERSONA_PRESETS,
  CONTEXT_CLOSE,
  CONTEXT_OPEN,
  INSTRUCTION_CLOSE,
  INSTRUCTION_OPEN,
  PersonaPresetRegistry,
  clampSlider,
  compilePreset,
  renderSliderDirectives,
  verifyCompiled,
} from "../../src/prompts/persona-presets.js";
import { VendorPromptCatalog } from "../../src/prompts/vendor-prompt-catalog.js";

const CATALOG = new VendorPromptCatalog();

describe("persona-presets / built-in catalog", () => {
  it("ships the four named archetypes plus the persona-family pair", () => {
    const ids = BUILTIN_PERSONA_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("frontier-coding-specialist");
    expect(ids).toContain("senior-devops-architect");
    expect(ids).toContain("socratic-code-reviewer");
    expect(ids).toContain("security-red-team-lead");
    expect(ids).toContain("supervisor-gate");
    expect(ids).toContain("values-aligned-synthesizer");
  });

  it("every preset traces to catalog entries that actually exist", () => {
    for (const preset of BUILTIN_PERSONA_PRESETS) {
      expect(preset.sourcePromptIds.length).toBeGreaterThanOrEqual(1);
      for (const sourceId of preset.sourcePromptIds) {
        expect(CATALOG.has(sourceId)).toBe(true);
      }
    }
  });

  it("every preset declares sliders inside the unit interval", () => {
    for (const preset of BUILTIN_PERSONA_PRESETS) {
      for (const value of Object.values(preset.sliders)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("the red-team lead is the most cautious and the least hedging", () => {
    const redTeam = BUILTIN_PERSONA_PRESETS.find((p) => p.id === "security-red-team-lead")!;
    const caution = Math.max(...BUILTIN_PERSONA_PRESETS.map((p) => p.sliders.caution));
    expect(redTeam.sliders.caution).toBe(caution);
    expect(redTeam.sliders.hedging).toBeLessThan(0.2);
  });
});

describe("persona-presets / sliders", () => {
  it("clampSlider holds the unit interval", () => {
    expect(clampSlider(-1)).toBe(0);
    expect(clampSlider(0.5)).toBe(0.5);
    expect(clampSlider(2)).toBe(1);
    expect(clampSlider(Number.NaN)).toBe(0);
  });

  it("renderSliderDirectives selects one directive sentence per band", () => {
    const low = renderSliderDirectives({
      verbosity: 0,
      autonomy: 0,
      caution: 0,
      formality: 0,
      hedging: 0,
    });
    expect(low).toHaveLength(5);
    expect(low[0]).toContain("fewest words");
    expect(low[1]).toContain("Propose the next action");
    expect(low[4]).toContain("Commit to the answer");

    const high = renderSliderDirectives({
      verbosity: 1,
      autonomy: 1,
      caution: 1,
      formality: 1,
      hedging: 1,
    });
    expect(high[0]).toContain("Walk the reasoning");
    expect(high[1]).toContain("Drive the task to completion");
    expect(high[2]).toContain("distinct trust boundaries");
    expect(high[3]).toContain("cite the file");
    expect(high[4]).toContain("Attach a confidence");

    // Mid-band values land between the two, and moving one slider moves one sentence.
    const mid = renderSliderDirectives({
      verbosity: 0.5,
      autonomy: 0.5,
      caution: 0.5,
      formality: 0.5,
      hedging: 0.5,
    });
    expect(mid[0]).not.toBe(low[0]);
    expect(mid[0]).not.toBe(high[0]);
  });
});

describe("persona-presets / compilation", () => {
  it("wraps the contract in an instruction block before any context", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[0]!, {
      taskContext: "Refactor the auth module.",
    });

    expect(compiled.text).toMatch(new RegExp(`^${INSTRUCTION_OPEN}\\n`));
    expect(compiled.text).toContain(INSTRUCTION_CLOSE);
    const instructionEnd = compiled.text.indexOf(INSTRUCTION_CLOSE);
    const contextStart = compiled.text.indexOf(CONTEXT_OPEN);
    expect(contextStart).toBeGreaterThan(instructionEnd);
    expect(compiled.text).toContain("Refactor the auth module.");
    expect(compiled.text).toContain(CONTEXT_CLOSE);
  });

  it("emits identity, slider directives and standing rules in order", () => {
    const preset = BUILTIN_PERSONA_PRESETS.find((p) => p.id === "socratic-code-reviewer")!;
    const compiled = compilePreset(preset);

    const identityAt = compiled.text.indexOf(preset.identity);
    const behaviourAt = compiled.text.indexOf("## Behaviour");
    const rulesAt = compiled.text.indexOf("## Standing rules");
    expect(identityAt).toBeGreaterThan(-1);
    expect(behaviourAt).toBeGreaterThan(identityAt);
    expect(rulesAt).toBeGreaterThan(behaviourAt);
    expect(compiled.text).toContain("- Open with the sharpest question");
  });

  it("omits the context block when no task context is supplied", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[1]!);
    expect(compiled.text).not.toContain(CONTEXT_OPEN);
    expect(compiled.text).toContain(INSTRUCTION_CLOSE);
  });

  it("lists permitted and forbidden tools inside the instruction block", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[3]!, {
      allowedTools: ["read_file", "grep_search"],
    });
    const instructionEnd = compiled.text.indexOf(INSTRUCTION_CLOSE);
    expect(compiled.text.indexOf("## Permitted tools")).toBeLessThan(instructionEnd);
    expect(compiled.text).toContain("## Forbidden tools");
    expect(compiled.text).toContain("`run_command`");
  });

  it("interpolates placeholders in identity and task context", () => {
    const probe: PersonaPreset = {
      id: "interpolation-probe",
      name: "Interpolation probe",
      category: "engineering",
      description: "Probe.",
      identity: "You work in ${workspace}, reading ${workspace}.",
      rules: ["One rule."],
      sliders: { verbosity: 0, autonomy: 0, caution: 0, formality: 0, hedging: 0 },
      toolCallFormat: "none",
      sourcePromptIds: ["cline-system"],
      variables: ["workspace", "policy_doc"],
    };

    const compiled = compilePreset(probe, {
      variables: { workspace: "/srv/app", policy_doc: "the-policy" },
      taskContext: "Policy: ${policy_doc}",
    });
    expect(compiled.text).toContain("You work in /srv/app");
    expect(compiled.text).toContain("Policy: the-policy");
  });

  it("interpolates an unset placeholder to blank, not to literal syntax", () => {
    const probe: PersonaPreset = {
      id: "interpolation-probe",
      name: "Interpolation probe",
      category: "engineering",
      description: "Probe.",
      identity: "You work in ${workspace}.",
      rules: [],
      sliders: { verbosity: 0, autonomy: 0, caution: 0, formality: 0, hedging: 0 },
      toolCallFormat: "none",
      sourcePromptIds: ["cline-system"],
      variables: ["workspace"],
    };
    // An empty value map still triggers interpolation, so an unset placeholder blanks out.
    expect(compilePreset(probe, { variables: {} }).text).toContain("You work in .");
    // No value map at all leaves the placeholder syntax visible.
    expect(compilePreset(probe).text).toContain("You work in ${workspace}.");
  });

  it("fits the 15% token budget on a default context window", () => {
    for (const preset of BUILTIN_PERSONA_PRESETS) {
      const compiled = compilePreset(preset);
      expect(compiled.withinBudget).toBe(true);
      expect(compiled.tokens).toBeLessThan(compiled.budget);
    }
  });

  it("reports a budget breach against a tiny context window", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[0]!, { contextWindow: 10 });
    expect(compiled.withinBudget).toBe(false);
    expect(compiled.budget).toBe(1);
  });

  it("measures every compile and reports a non-negative duration", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[0]!);
    expect(compiled.compileMs).toBeGreaterThanOrEqual(0);
    expect(compiled.presetId).toBe(BUILTIN_PERSONA_PRESETS[0]!.id);
  });

  it("compiles inside the 1.5ms QoS target at the median", () => {
    const preset = BUILTIN_PERSONA_PRESETS[0]!;
    // Warm the engine so the first compile's allocations are not the sample.
    for (let i = 0; i < 16; i += 1) compilePreset(preset);

    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      // compilePreset bypasses the registry cache: a cached compile is a map lookup and
      // would measure nothing.
      samples.push(compilePreset(preset, { taskContext: `turn ${i}` }).compileMs);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    expect(median).toBeLessThan(1.5);
  });
});

describe("persona-presets / verification", () => {
  it("verifies clean for every built-in preset", () => {
    for (const preset of BUILTIN_PERSONA_PRESETS) {
      expect(verifyCompiled(compilePreset(preset))).toEqual([]);
    }
  });

  it("flags a context block nested inside the instruction block", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[0]!);
    const broken = {
      ...compiled,
      text: `${INSTRUCTION_OPEN}\n## Behaviour\n${CONTEXT_OPEN}data${CONTEXT_CLOSE}\n${INSTRUCTION_CLOSE}`,
    };
    const issues = verifyCompiled(broken);
    expect(issues.map((i) => i.severity)).toContain("error");
    expect(issues.some((i) => i.message.includes("not separated"))).toBe(true);
  });

  it("flags a harness-injection marker that survived compilation", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[0]!);
    const poisoned = {
      ...compiled,
      text: `${compiled.text}\n<system-reminder>injected</system-reminder>`,
    };
    const issues = verifyCompiled(poisoned);
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toContain("injection marker");
  });

  it("warns rather than errors when the budget is exceeded", () => {
    const compiled = compilePreset(BUILTIN_PERSONA_PRESETS[0]!, { contextWindow: 10 });
    const issues = verifyCompiled(compiled);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warning");
  });
});

describe("persona-presets / registry", () => {
  it("registers, looks up and lists the built-in presets", () => {
    const registry = new PersonaPresetRegistry();
    expect(registry.list().length).toBe(BUILTIN_PERSONA_PRESETS.length);
    expect(registry.has("socratic-code-reviewer")).toBe(true);
    expect(registry.has("SOCRATIC-CODE-REVIEWER")).toBe(true);
    expect(registry.get("nope")).toBeUndefined();

    const security = registry.list("security");
    expect(security.map((p) => p.id)).toEqual(["security-red-team-lead"]);
  });

  it("rejects a duplicate or non-slug preset id", () => {
    const registry = new PersonaPresetRegistry();
    expect(() => registry.register({ ...BUILTIN_PERSONA_PRESETS[0]! })).toThrow(
      /already registered/,
    );
    expect(() => registry.register({ ...BUILTIN_PERSONA_PRESETS[0]!, id: "Not_A_Slug" })).toThrow(
      /lowercase slug/,
    );
  });

  it("throws on compiling an unknown preset", () => {
    const registry = new PersonaPresetRegistry();
    expect(() => registry.compile("ghost")).toThrow(/not registered/);
  });

  it("serves a repeat compile from cache and tracks the hit rate", () => {
    const registry = new PersonaPresetRegistry();
    const ctx = { taskContext: "same context" };

    registry.compile("frontier-coding-specialist", ctx);
    expect(registry.cacheHitRate()).toBe(0);

    for (let i = 0; i < 19; i += 1) registry.compile("frontier-coding-specialist", ctx);
    expect(registry.cacheSize()).toBe(1);
    expect(registry.cacheHits()).toBe(19);
    expect(registry.cacheMisses()).toBe(1);
    expect(registry.cacheHitRate()).toBe(0.95);
  });

  it("caches distinct contexts separately", () => {
    const registry = new PersonaPresetRegistry();
    registry.compile("frontier-coding-specialist", { taskContext: "A" });
    registry.compile("frontier-coding-specialist", { taskContext: "B" });
    registry.compile("socratic-code-reviewer", { taskContext: "A" });
    expect(registry.cacheSize()).toBe(3);
  });

  it("compileAndVerify is clean for the built-in presets", () => {
    const registry = new PersonaPresetRegistry();
    const { compiled, issues } = registry.compileAndVerify("supervisor-gate");
    expect(issues).toEqual([]);
    expect(compiled.sourcePromptIds).toEqual(["parahelp-manager", "parahelp-planning"]);
  });

  it("clearCache empties the cache and resets the counters", () => {
    const registry = new PersonaPresetRegistry();
    registry.compile("frontier-coding-specialist");
    registry.compile("frontier-coding-specialist");
    expect(registry.cacheSize()).toBe(1);
    registry.clearCache();
    expect(registry.cacheSize()).toBe(0);
    expect(registry.cacheHitRate()).toBe(0);
  });
});

describe("persona-presets / separation from the legacy catalog", () => {
  // The legacy registries stay the source of truth for their own callers; this preset
  // layer only reads them as archetypes and must not shadow their ids.
  it("uses preset ids distinct from the legacy prompt profile ids", () => {
    const legacyIds = new Set(LEGACY_PROFILES.map((profile) => profile.id));
    for (const preset of BUILTIN_PERSONA_PRESETS) {
      expect(legacyIds.has(preset.id)).toBe(false);
    }
  });
});
