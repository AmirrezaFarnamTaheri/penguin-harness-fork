/**
 * Skill Engine & Cross-Agent Capability Registry.
 *
 * Provides structured skill definition, parameter interpolation, semantic relevance
 * scoring against task prompts, and prompt section formatting for LLM contexts.
 */

export interface SkillParameter {
  name: string;
  description: string;
  required: boolean;
  default?: string;
}

export interface SkillMetadataInfo {
  name: string;
  description: string;
  shortDescription?: string;
  version?: string;
  author?: string;
  category: "engineering" | "design" | "qa" | "science" | "ops" | "management" | "general";
  tags: string[];
  allowedTools: string[];
  parameters: SkillParameter[];
}

export interface SkillDefinition extends SkillMetadataInfo {
  content: string;
  referenceFiles: Record<string, string>;
  sourcePath: string;
}

export interface SkillMatchResult {
  skill: SkillDefinition;
  score: number;
  matchedKeywords: string[];
  reason: string;
}

/**
 * Parses frontmatter YAML-like blocks from markdown skill files.
 * Structured `parameters` JSON is preserved before generic simple-array handling.
 */
export function parseSkillMarkdown(rawContent: string, sourcePath = ""): SkillDefinition | null {
  const clean = rawContent.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(clean);
  if (!match) return null;

  const frontmatterStr = match[1] ?? "";
  const body = match[2]?.trim() ?? "";
  const fields: Record<string, string> = {};
  const arrayFields: Record<string, string[]> = {};
  let currentListKey: string | null = null;

  for (const line of frontmatterStr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && currentListKey) {
      const val = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (val) {
        if (!arrayFields[currentListKey]) arrayFields[currentListKey] = [];
        arrayFields[currentListKey]!.push(val);
      }
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    // Parameters may be an inline JSON array of objects. Keep the original JSON
    // intact rather than treating it as a comma-separated scalar list.
    if (key === "parameters" && rawVal.startsWith("[") && rawVal.endsWith("]")) {
      currentListKey = null;
      fields[key] = rawVal;
      continue;
    }

    if (rawVal === "" || rawVal === "[]") {
      currentListKey = key;
      arrayFields[key] = [];
      continue;
    }

    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      currentListKey = null;
      try {
        const parsed: unknown = JSON.parse(rawVal.replace(/'/g, '"'));
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
          arrayFields[key] = parsed as string[];
          continue;
        }
      } catch {
        // Fall through to the legacy simple-list syntax below.
      }
      arrayFields[key] = rawVal
        .slice(1, -1)
        .split(",")
        .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      continue;
    }

    currentListKey = null;
    fields[key] = rawVal.replace(/^['"]|['"]$/g, "");
  }

  const name = fields.name;
  if (!name) return null;
  const description = fields.description ?? "";
  const shortDescription = fields["short-description"] ?? fields.short_description;
  const version = fields.version;
  const author = fields.author;

  let category: SkillMetadataInfo["category"] = "general";
  const rawCat = (fields.category ?? "").toLowerCase();
  if (["engineering", "design", "qa", "science", "ops", "management"].includes(rawCat)) {
    category = rawCat as SkillMetadataInfo["category"];
  } else {
    const lowerName = name.toLowerCase();
    if (lowerName.includes("test") || lowerName.includes("qa") || lowerName.includes("verify") || lowerName.includes("debug")) {
      category = "qa";
    } else if (lowerName.includes("design") || lowerName.includes("ui") || lowerName.includes("ux") || lowerName.includes("css")) {
      category = "design";
    } else if (lowerName.includes("deploy") || lowerName.includes("ci") || lowerName.includes("pipeline") || lowerName.includes("ops")) {
      category = "ops";
    } else if (lowerName.includes("plan") || lowerName.includes("prd") || lowerName.includes("epic") || lowerName.includes("triage")) {
      category = "management";
    } else if (lowerName.includes("protein") || lowerName.includes("fold") || lowerName.includes("bio") || lowerName.includes("chem")) {
      category = "science";
    } else {
      category = "engineering";
    }
  }

  const tags = arrayFields.tags ?? [];
  const allowedTools = arrayFields.allowed_tools ?? arrayFields.tools ?? [];
  const parameters: SkillParameter[] = [];
  const rawParams = fields.parameters;
  if (rawParams) {
    try {
      const parsed: unknown = JSON.parse(rawParams);
      if (!Array.isArray(parsed)) throw new Error("parameters must be a JSON array");
      for (const item of parsed) {
        if (typeof item !== "object" || item === null || typeof (item as { name?: unknown }).name !== "string") {
          continue;
        }
        const parameter = item as Record<string, unknown>;
        parameters.push({
          name: parameter.name as string,
          description: typeof parameter.description === "string" ? parameter.description : "",
          required: Boolean(parameter.required),
          default: typeof parameter.default === "string" ? parameter.default : undefined,
        });
      }
    } catch {
      // Unsupported structured parameter syntax remains empty rather than being
      // misparsed as comma-separated fragments.
    }
  }

  return {
    name,
    description,
    ...(shortDescription ? { shortDescription } : {}),
    ...(version ? { version } : {}),
    ...(author ? { author } : {}),
    category,
    tags,
    allowedTools,
    parameters,
    content: body,
    referenceFiles: {},
    sourcePath,
  };
}

export function scoreSkillRelevance(skill: SkillDefinition, prompt: string): SkillMatchResult {
  const lowerPrompt = prompt.toLowerCase();
  const matchedKeywords: string[] = [];
  let score = 0;
  const normalizedName = skill.name.toLowerCase().replace(/[-_]/g, " ");
  if (lowerPrompt.includes(skill.name.toLowerCase()) || lowerPrompt.includes(normalizedName)) {
    score += 0.5;
    matchedKeywords.push(skill.name);
  }
  for (const tag of skill.tags) {
    const value = tag.toLowerCase();
    if (value.length > 2 && lowerPrompt.includes(value)) {
      score += 0.15;
      matchedKeywords.push(tag);
    }
  }
  for (const token of skill.name.toLowerCase().split(/[-_]/)) {
    if (token.length > 3 && lowerPrompt.includes(token) && !matchedKeywords.includes(token)) {
      score += 0.1;
      matchedKeywords.push(token);
    }
  }
  if (lowerPrompt.includes(skill.category)) {
    score += 0.1;
    matchedKeywords.push(skill.category);
  }
  const normalizedScore = Math.min(1, Math.round(score * 100) / 100);
  return {
    skill,
    score: normalizedScore,
    matchedKeywords,
    reason: matchedKeywords.length ? `Matched terms: ${matchedKeywords.join(", ")}` : "No strong term match",
  };
}

/** Literal, single-pass interpolation: replacement-language tokens in values are data. */
export function interpolateVariables(template: string, vars: Record<string, string>): string {
  const token = /\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}|\$([A-Za-z_][A-Za-z0-9_.-]*)\b/g;
  return template.replace(token, (match, doubleKey: string | undefined, braceKey: string | undefined, dollarKey: string | undefined) => {
    const key = doubleKey ?? braceKey ?? dollarKey;
    return key !== undefined && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match;
  });
}

export const DEFAULT_SKILL_ALIASES: Record<string, string> = {
  "plan": "task-planning-runner",
  "review": "diff-correctness-review",
  "test": "project-test-runner",
  "debug": "root-cause-debugger",
  "verify": "runtime-output-verifier",
  "diagnose": "performance-diagnostics-loop",
  "implement": "feature-implementation-runner",
  "simplify": "code-simplification-cleaner",
  "summarize": "media-url-summarizer",
  "release": "release-process-runner",
  "init": "project-init-scaffold",
  "delegate": "subagent-delegator",
  "handoff": "agent-session-handoff",
  "interview": "socratic-task-interview",
  "loop": "recurring-prompt-loop",
  "customize": "agent-profile-customizer",
  "screenshot": "window-screenshot-capture",
  "draft": "legal-clinic-document-drafter",
  "auth-patterns": "nextjs-auth-patterns",
  "workflow-patterns": "conductor-workflow-patterns",
  "workflow-orchestration-patterns": "temporal-workflow-orchestration",
  "connect": "composio-cli-connect",
  "connect-apps": "composio-cli-connect",
  "pptx": "pptx-author",
  "xlsx": "xlsx-author",
  "spreadsheets": "xlsx-author",
  "journal-entry-prep": "journal-entry",
  "data-model-creation": "database-design",
  "plain-language-letters": "legal-plain-language",
  "relational-database-mcp-cloudbase": "postgresql-development-cloudbase",
  "relational-database-web-cloudbase": "postgresql-development-cloudbase",
  "rust-check": "cargo-test",
  "secrets-management-best-practices": "aws-secrets-manager-best-practices",
  "seo-audit-expert": "seo-optimization-bilingual",
  "e2e-testing-expert": "e2e-testing-bilingual",
  "nextjs-app-router-expert": "nextjs-app-router-bilingual",
  "prompt-engineering-expert": "prompt-instructions-design",
  "ai-prompt-engineering-expert": "prompt-engineering-bilingual",
};

export function resolveSkillAlias(name: string, customAliases?: Record<string, string>): string {
  const lower = name.toLowerCase();
  if (customAliases?.[lower]) return customAliases[lower]!;
  return DEFAULT_SKILL_ALIASES[lower] ?? name;
}

/** Exact registered names take precedence over aliases consistently. */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly aliases = new Map<string, string>();

  constructor(initialAliases: Record<string, string> = DEFAULT_SKILL_ALIASES) {
    for (const [alias, target] of Object.entries(initialAliases)) {
      this.aliases.set(alias.toLowerCase(), target.toLowerCase());
    }
  }

  public registerAlias(alias: string, canonicalName: string): void {
    this.aliases.set(alias.toLowerCase(), canonicalName.toLowerCase());
  }

  public resolveAlias(name: string): string {
    const lower = name.toLowerCase();
    return this.aliases.get(lower) ?? lower;
  }

  public register(skill: SkillDefinition): void {
    this.skills.set(skill.name.toLowerCase(), skill);
  }

  private resolveRegisteredKey(name: string): string | undefined {
    const exact = name.toLowerCase();
    if (this.skills.has(exact)) return exact;
    const aliasTarget = this.resolveAlias(name);
    return this.skills.has(aliasTarget) ? aliasTarget : undefined;
  }

  public get(name: string): SkillDefinition | undefined {
    const key = this.resolveRegisteredKey(name);
    return key ? this.skills.get(key) : undefined;
  }

  public has(name: string): boolean {
    return this.resolveRegisteredKey(name) !== undefined;
  }

  public delete(name: string): boolean {
    const key = this.resolveRegisteredKey(name);
    return key ? this.skills.delete(key) : false;
  }

  public size(): number {
    return this.skills.size;
  }

  public list(filter?: { category?: string; tag?: string; tool?: string; query?: string }): SkillDefinition[] {
    let list = Array.from(this.skills.values());
    if (filter?.category) {
      const category = filter.category.toLowerCase();
      list = list.filter((skill) => skill.category.toLowerCase() === category);
    }
    if (filter?.tag) {
      const tag = filter.tag.toLowerCase();
      list = list.filter((skill) => skill.tags.some((value) => value.toLowerCase() === tag));
    }
    if (filter?.tool) {
      const tool = filter.tool.toLowerCase();
      list = list.filter(
        (skill) => skill.allowedTools.includes("*") || skill.allowedTools.some((value) => value.toLowerCase() === tool),
      );
    }
    if (filter?.query) {
      const query = filter.query.toLowerCase();
      list = list.filter(
        (skill) =>
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          Boolean(skill.shortDescription?.toLowerCase().includes(query)),
      );
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  public match(
    prompt: string,
    options?: { maxResults?: number; minScore?: number; category?: string },
  ): SkillMatchResult[] {
    const maxResults = options?.maxResults ?? 5;
    const minScore = options?.minScore ?? 0.2;
    const candidates = this.list(options?.category ? { category: options.category } : undefined);
    return candidates
      .map((skill) => scoreSkillRelevance(skill, prompt))
      .filter((result) => result.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  public buildPromptSection(
    skillName: string,
    variables: Record<string, string> = {},
    includeReferences = false,
  ): string {
    const skill = this.get(skillName);
    if (!skill) throw new Error(`Skill "${skillName}" is not registered`);

    const interpolatedBody = interpolateVariables(skill.content, variables);
    let output = `=== SKILL: ${skill.name} ===\n${interpolatedBody}\n`;
    if (includeReferences && Object.keys(skill.referenceFiles).length > 0) {
      output += "\n--- REFERENCES ---\n";
      for (const [relPath, refContent] of Object.entries(skill.referenceFiles)) {
        output += `\n[Reference: ${relPath}]\n${refContent}\n`;
      }
    }
    return `${output}=== END SKILL: ${skill.name} ===\n`;
  }
}

export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) return { valid: false, error: "Agent name must not be empty" };
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 64) {
    return { valid: false, error: `Agent name exceeds maximum length of 64 bytes (got ${bytes.length})` };
  }
  if (!/^[a-z]/.test(name)) return { valid: false, error: "Agent name must start with a lowercase letter (a-z)" };
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return { valid: false, error: "Agent name can only contain lowercase letters (a-z), digits (0-9), underscores (_), and hyphens (-)" };
  }
  return { valid: true };
}

export interface StrictFunctionDefinitionOptions {
  name: string;
  description: string;
  properties?: Record<string, unknown>;
  required?: string[];
  strict?: boolean;
}

export function synthesizeFunctionDefinition(options: StrictFunctionDefinitionOptions): Record<string, unknown> {
  const validation = validateAgentName(options.name);
  if (!validation.valid) throw new Error(`Invalid function definition name: ${validation.error}`);
  return {
    name: options.name.toLowerCase(),
    description: options.description,
    parameters: {
      type: "object",
      properties: options.properties ?? {
        prompt: {
          type: "string",
          description: "The task prompt for this agent, including objective, relevant context, and constraints.",
          minLength: 1,
        },
      },
      required: options.required ?? ["prompt"],
      additionalProperties: false,
    },
    strict: options.strict ?? true,
  };
}
