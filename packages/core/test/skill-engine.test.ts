import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  scoreSkillRelevance,
  interpolateVariables,
  SkillRegistry,
  resolveSkillAlias,
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

  it("parses real YAML block scalars and ignores nested host metadata", () => {
    const skill = parseSkillMarkdown(`---
name: api-gateway
description: >-
  Route requests through the named API gateway only when the user explicitly
  asks for this integration; do not treat generic API work as a match.
tags:
  - gateway
  - routing
metadata:
  env:
    TOKEN:
      description: This nested description must not replace the skill description.
parameters:
  - name: service
    description: Service identifier
    required: true
  - name: mode
    default: safe
---
Use the configured gateway for {{service}}.
`);

    expect(skill).not.toBeNull();
    expect(skill!.description).toContain("Route requests through the named API gateway");
    expect(skill!.description).not.toContain("nested description");
    expect(skill!.tags).toEqual(["gateway", "routing"]);
    expect(skill!.parameters).toEqual([
      { name: "service", description: "Service identifier", required: true },
      { name: "mode", description: "", required: false, default: "safe" },
    ]);
  });

  it("handles missing or malformed frontmatter gracefully", () => {
    expect(parseSkillMarkdown("Just plain markdown text without frontmatter")).toBeNull();
    expect(parseSkillMarkdown("---\nname: [broken\n---\nbody")).toBeNull();
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

  it("scores relevance from canonical names, tags, category and bounded description evidence", () => {
    const skill = parseSkillMarkdown(`---
name: systematic-debugging
description: Root-cause-first debugging for flaky tests and bugs.
category: qa
tags: [debug, root-cause, test-failure]
---
Debug the system systematically.`)!;

    const match1 = scoreSkillRelevance(
      skill,
      "We have a systematic-debugging emergency with flaky tests",
    );
    expect(match1.score).toBeGreaterThan(0.5);
    expect(match1.matchedKeywords).toContain("systematic-debugging");

    const match2 = scoreSkillRelevance(skill, "Can you write a poem about flowers?");
    expect(match2.score).toBeLessThan(0.2);
  });

  it("does not let generic automation wording route to unrelated service wrappers", () => {
    const slack = parseSkillMarkdown(`---
name: slack-automation
description: Automate Slack channels, messages, and workspace administration.
tags: [slack, messaging, automation]
---
Use Slack APIs.`)!;
    const github = parseSkillMarkdown(`---
name: github-automation
description: Automate GitHub issues, repositories, and pull requests.
tags: [github, repositories, automation]
---
Use GitHub APIs.`)!;

    expect(scoreSkillRelevance(slack, "automate this repetitive task").score).toBeLessThan(0.2);
    expect(scoreSkillRelevance(github, "automate this repetitive task").score).toBeLessThan(0.2);
    expect(scoreSkillRelevance(slack, "automate Slack channel membership").score).toBeGreaterThan(
      0.2,
    );
    expect(scoreSkillRelevance(github, "update this GitHub pull request").score).toBeGreaterThan(
      0.2,
    );
  });

  it("infers broad category from description and tags when category is omitted", () => {
    const skill = parseSkillMarkdown(`---
name: release-safety
 description: ignored
---
body`);
    expect(skill).toBeNull();

    const valid = parseSkillMarkdown(`---
name: release-safety
description: Validate deployment and CI release readiness.
tags: [deployment, release]
---
body`)!;
    expect(valid.category).toBe("ops");
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

  it("resolves default and custom skill aliases transparently without inventing removed targets", () => {
    expect(resolveSkillAlias("plan")).toBe("task-planning-runner");
    expect(resolveSkillAlias("review")).toBe("diff-correctness-review");
    expect(resolveSkillAlias("test")).toBe("project-test-runner");
    expect(resolveSkillAlias("debug")).toBe("root-cause-debugger");
    expect(resolveSkillAlias("auth-patterns")).toBe("nextjs-auth-patterns");
    expect(resolveSkillAlias("unknown-custom-skill")).toBe("unknown-custom-skill");
    expect(resolveSkillAlias("custom-alias", { "custom-alias": "canonical-target" })).toBe(
      "canonical-target",
    );
  });

  it("SkillRegistry retrieves skills by legacy aliases seamlessly", () => {
    const registry = new SkillRegistry();
    const planner = parseSkillMarkdown(`---
name: task-planning-runner
description: Ordered task implementation planning.
category: management
tags: [planning, tasks]
---
Create ordered step-by-step implementation plans.`)!;

    registry.register(planner);
    expect(registry.has("task-planning-runner")).toBe(true);
    expect(registry.has("plan")).toBe(true);
    expect(registry.get("plan")?.name).toBe("task-planning-runner");

    const section = registry.buildPromptSection("plan");
    expect(section).toContain("=== SKILL: task-planning-runner ===");
    expect(section).toContain("Create ordered step-by-step implementation plans.");

    registry.registerAlias("my-custom-plan-alias", "task-planning-runner");
    expect(registry.has("my-custom-plan-alias")).toBe(true);
    expect(registry.get("my-custom-plan-alias")?.name).toBe("task-planning-runner");
  });

  it("rejects dynamic alias self-cycles and longer cycles", () => {
    const registry = new SkillRegistry({});
    expect(() => registry.registerAlias("one", "one")).toThrow(/cannot target itself/);
    registry.registerAlias("one", "two");
    expect(() => registry.registerAlias("two", "one")).toThrow(/cycle/);
  });
});
