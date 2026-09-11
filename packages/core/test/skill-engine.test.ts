import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  scoreSkillRelevance,
  interpolateVariables,
  SkillRegistry,
} from "../src/agent/skill-engine.js";

describe("SkillEngine", () => {
  it("parses valid skill markdown with frontmatter and body", () => {
    const raw = `---
name: ccpm-planner
description: Spec-driven project planning and epic decomposition.
category: management
tags: [planning, epics, prd]
tools:
  - read_file
  - write_file
parameters: '[{"name":"epic_name","description":"Title of the epic","required":true}]'
---
# CCPM Planning Skill
Follow these guidelines to decompose an epic for {{epic_name}}.
`;
    const skill = parseSkillMarkdown(raw, "/path/to/skill/SKILL.md");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("ccpm-planner");
    expect(skill!.category).toBe("management");
    expect(skill!.tags).toEqual(["planning", "epics", "prd"]);
    expect(skill!.allowedTools).toEqual(["read_file", "write_file"]);
    expect(skill!.parameters).toHaveLength(1);
    expect(skill!.parameters[0]!.name).toBe("epic_name");
    expect(skill!.content).toContain("# CCPM Planning Skill");
  });

  it("handles missing frontmatter gracefully", () => {
    const result = parseSkillMarkdown("Just plain markdown text without frontmatter");
    expect(result).toBeNull();
  });

  it("interpolates variables properly", () => {
    const template = "Deploy service {{service}} to cluster {cluster} with profile $profile.";
    const result = interpolateVariables(template, {
      service: "api-gateway",
      cluster: "prod-us-east",
      profile: "release",
    });
    expect(result).toBe("Deploy service api-gateway to cluster prod-us-east with profile release.");
  });

  it("scores relevance accurately based on prompt query", () => {
    const skill = parseSkillMarkdown(`---
name: systematic-debugging
description: Root-cause-first debugging for flaky tests and bugs.
category: qa
tags: [debug, root-cause, test-failure]
---
Debug the system systematically.`)!;

    const match1 = scoreSkillRelevance(skill, "We have a systematic-debugging emergency with flaky tests");
    expect(match1.score).toBeGreaterThan(0.5);
    expect(match1.matchedKeywords).toContain("systematic-debugging");

    const match2 = scoreSkillRelevance(skill, "Can you write a poem about flowers?");
    expect(match2.score).toBeLessThan(0.2);
  });

  it("registers, matches, and formats prompt sections in SkillRegistry", () => {
    const registry = new SkillRegistry();
    const skill1 = parseSkillMarkdown(`---
name: ui-ux-pro-max
description: Semantic design systems, color tokens, and responsive layouts.
category: design
tags: [design, colors, typography]
---
Use high-contrast accessible color palettes.`)!;

    const skill2 = parseSkillMarkdown(`---
name: deploy-pipeline
description: CI/CD workflow automation and docker deployment.
category: ops
tags: [docker, ci, cd]
---
Deploy container images via registry.`)!;

    registry.register(skill1);
    registry.register(skill2);
    expect(registry.size()).toBe(2);

    const matches = registry.match("I need help with colors and typography for our UI design");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.skill.name).toBe("ui-ux-pro-max");

    const promptSection = registry.buildPromptSection("ui-ux-pro-max");
    expect(promptSection).toContain("=== SKILL: ui-ux-pro-max ===");
    expect(promptSection).toContain("Use high-contrast accessible color palettes.");
    expect(promptSection).toContain("=== END SKILL: ui-ux-pro-max ===");
  });
});
