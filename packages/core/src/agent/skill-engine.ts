/**
 * Skill Engine & Cross-Agent Capability Registry.
 *
 * Provides structured skill definition, parameter interpolation, semantic relevance
 * scoring against task prompts, and prompt section formatting for LLM contexts.
 *
 * Synthesized from skills-manager, ccpm, ui-ux-pro-max, and reasonix skill systems.
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
 * Parses frontmatter YAML-like block from markdown files.
 * Handles both key: value scalars and list syntax ([a, b] or multi-line - item).
 */
export function parseSkillMarkdown(rawContent: string, sourcePath = ""): SkillDefinition | null {
  const clean = rawContent.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(clean);
  if (!match) {
    return null;
  }

  const frontmatterStr = match[1] ?? "";
  const body = match[2]?.trim() ?? "";

  const fields: Record<string, string> = {};
  const arrayFields: Record<string, string[]> = {};
  let currentListKey: string | null = null;

  for (const line of frontmatterStr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Check list item (- item)
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

    if (rawVal === "" || rawVal === "[]") {
      currentListKey = key;
      arrayFields[key] = [];
      continue;
    }

    // Inline array: [a, b, c]
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      currentListKey = null;
      const items = rawVal
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      arrayFields[key] = items;
      continue;
    }

    currentListKey = null;
    fields[key] = rawVal.replace(/^['"]|['"]$/g, "");
  }

  const name = fields["name"];
  if (!name) return null;

  const description = fields["description"] ?? "";
  const shortDescription = fields["short-description"] ?? fields["short_description"];
  const version = fields["version"];
  const author = fields["author"];

  // Category inference
  let category: SkillMetadataInfo["category"] = "general";
  const rawCat = (fields["category"] ?? "").toLowerCase();
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

  const tags = arrayFields["tags"] ?? [];
  const allowedTools = arrayFields["allowed_tools"] ?? arrayFields["tools"] ?? [];

  // Parse parameters
  const parameters: SkillParameter[] = [];
  const rawParams = fields["parameters"];
  if (rawParams) {
    try {
      const parsed = JSON.parse(rawParams);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.name === "string") {
            parameters.push({
              name: item.name,
              description: typeof item.description === "string" ? item.description : "",
              required: Boolean(item.required),
              default: typeof item.default === "string" ? item.default : undefined,
            });
          }
        }
      }
    } catch {
      // Ignored non-json parameters
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

/**
 * Evaluates relevance between a prompt and a skill.
 * Returns a score between 0.0 and 1.0.
 */
export function scoreSkillRelevance(skill: SkillDefinition, prompt: string): SkillMatchResult {
  const lowerPrompt = prompt.toLowerCase();
  const matchedKeywords: string[] = [];
  let score = 0;

  // Exact skill name match (very high confidence)
  const normalizedName = skill.name.toLowerCase().replace(/[-_]/g, " ");
  if (lowerPrompt.includes(skill.name.toLowerCase()) || lowerPrompt.includes(normalizedName)) {
    score += 0.5;
    matchedKeywords.push(skill.name);
  }

  // Tag matches
  for (const tag of skill.tags) {
    const t = tag.toLowerCase();
    if (t.length > 2 && lowerPrompt.includes(t)) {
      score += 0.15;
      matchedKeywords.push(tag);
    }
  }

  // Keyword tokens in description and name
  const nameTokens = skill.name.toLowerCase().split(/[-_]/);
  for (const token of nameTokens) {
    if (token.length > 3 && lowerPrompt.includes(token) && !matchedKeywords.includes(token)) {
      score += 0.1;
      matchedKeywords.push(token);
    }
  }

  // Category match
  if (lowerPrompt.includes(skill.category)) {
    score += 0.1;
    matchedKeywords.push(skill.category);
  }

  const normalizedScore = Math.min(1.0, Math.round(score * 100) / 100);
  const reason = matchedKeywords.length > 0
    ? `Matched terms: ${matchedKeywords.join(", ")}`
    : "No strong term match";

  return {
    skill,
    score: normalizedScore,
    matchedKeywords,
    reason,
  };
}

/**
 * Interpolates variables in a template string.
 * Supports {{variable}}, {variable}, and $variable formats.
 */
export function interpolateVariables(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result
      .replace(new RegExp(`\\{\\{${escapedKey}\\}\\}`, "g"), value)
      .replace(new RegExp(`\\{${escapedKey}\\}`, "g"), value)
      .replace(new RegExp(`\\$${escapedKey}\\b`, "g"), value);
  }
  return result;
}

/**
 * SkillRegistry provides in-memory indexing, querying, matching, and prompt assembly.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  public register(skill: SkillDefinition): void {
    this.skills.set(skill.name.toLowerCase(), skill);
  }

  public get(name: string): SkillDefinition | undefined {
    return this.skills.get(name.toLowerCase());
  }

  public has(name: string): boolean {
    return this.skills.has(name.toLowerCase());
  }

  public delete(name: string): boolean {
    return this.skills.delete(name.toLowerCase());
  }

  public size(): number {
    return this.skills.size;
  }

  public list(filter?: {
    category?: string;
    tag?: string;
    tool?: string;
    query?: string;
  }): SkillDefinition[] {
    let list = Array.from(this.skills.values());

    if (filter?.category) {
      const cat = filter.category.toLowerCase();
      list = list.filter((s) => s.category.toLowerCase() === cat);
    }

    if (filter?.tag) {
      const tag = filter.tag.toLowerCase();
      list = list.filter((s) => s.tags.some((t) => t.toLowerCase() === tag));
    }

    if (filter?.tool) {
      const tool = filter.tool.toLowerCase();
      list = list.filter((s) =>
        s.allowedTools.includes("*") || s.allowedTools.some((t) => t.toLowerCase() === tool)
      );
    }

    if (filter?.query) {
      const q = filter.query.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.shortDescription && s.shortDescription.toLowerCase().includes(q))
      );
    }

    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  public match(
    prompt: string,
    options?: {
      maxResults?: number;
      minScore?: number;
      category?: string;
    }
  ): SkillMatchResult[] {
    const maxResults = options?.maxResults ?? 5;
    const minScore = options?.minScore ?? 0.2;

    const candidates = this.list(options?.category ? { category: options.category } : undefined);
    const scored = candidates
      .map((skill) => scoreSkillRelevance(skill, prompt))
      .filter((res) => res.score >= minScore)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, maxResults);
  }

  public buildPromptSection(
    skillName: string,
    variables: Record<string, string> = {},
    includeReferences = false
  ): string {
    const skill = this.get(skillName);
    if (!skill) {
      throw new Error(`Skill "${skillName}" is not registered`);
    }

    const interpolatedBody = interpolateVariables(skill.content, variables);
    let output = `=== SKILL: ${skill.name} ===\n${interpolatedBody}\n`;

    if (includeReferences && Object.keys(skill.referenceFiles).length > 0) {
      output += "\n--- REFERENCES ---\n";
      for (const [relPath, refContent] of Object.entries(skill.referenceFiles)) {
        output += `\n[Reference: ${relPath}]\n${refContent}\n`;
      }
    }

    output += `=== END SKILL: ${skill.name} ===\n`;
    return output;
  }
}

/**
 * Validates agent names according to Anda engine naming rules.
 * - Must not be empty
 * - Must not exceed 64 bytes
 * - Must start with a lowercase letter (a-z)
 * - Can only contain lowercase letters, digits, underscores, and hyphens
 */
export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: "Agent name must not be empty" };
  }
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 64) {
    return { valid: false, error: `Agent name exceeds maximum length of 64 bytes (got ${bytes.length})` };
  }
  if (!/^[a-z]/.test(name)) {
    return { valid: false, error: "Agent name must start with a lowercase letter (a-z)" };
  }
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

/**
 * Synthesizes a strict JSON function schema suitable for OpenAI/Claude/Gemini tool calling,
 * enforcing additionalProperties: false and strict: true (derived from anda_core/src/agent.rs).
 */
export function synthesizeFunctionDefinition(options: StrictFunctionDefinitionOptions): Record<string, unknown> {
  const validation = validateAgentName(options.name);
  if (!validation.valid) {
    throw new Error(`Invalid function definition name: ${validation.error}`);
  }

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
