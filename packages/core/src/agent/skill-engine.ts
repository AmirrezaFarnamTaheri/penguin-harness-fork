/**
 * Skill Engine & Cross-Agent Capability Registry.
 */
import { parse as parseYaml } from "yaml";

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

const GENERIC_ROUTING_TOKENS = new Set([
  "agent",
  "automation",
  "best",
  "expert",
  "helper",
  "patterns",
  "runner",
  "skill",
  "tool",
  "workflow",
]);

const DESCRIPTION_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "for",
  "from",
  "into",
  "that",
  "the",
  "their",
  "this",
  "through",
  "use",
  "using",
  "when",
  "with",
  "your",
]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferSkillCategory(
  name: string,
  description: string,
  tags: string[],
): SkillMetadataInfo["category"] {
  const haystack = `${name.replace(/[-_]/g, " ")} ${description} ${tags.join(" ")}`.toLowerCase();
  if (
    /\b(test|testing|qa|quality|verify|verification|debug|debugging|regression|lint|review|audit)\b/.test(
      haystack,
    )
  )
    return "qa";
  if (/\b(ui|ux|design|figma|visual|typography|brand|branding|css|accessibility)\b/.test(haystack))
    return "design";
  if (
    /\b(devops|deploy|deployment|ci|cd|pipeline|infra|infrastructure|docker|kubernetes|terraform|observability|monitoring|release)\b/.test(
      haystack,
    )
  )
    return "ops";
  if (
    /\b(plan|planning|project|product|prd|roadmap|epic|triage|strategy|management|manager|hiring|finance|budget)\b/.test(
      haystack,
    )
  )
    return "management";
  if (
    /\b(science|scientific|biology|bioinformatics|protein|chemistry|chemical|physics|medical|genomics|statistics|statistical)\b/.test(
      haystack,
    )
  )
    return "science";
  if (
    /\b(code|coding|software|engineer|engineering|api|backend|frontend|typescript|javascript|python|rust|golang|java|react|nextjs|architecture|security|database|sql)\b/.test(
      haystack,
    )
  )
    return "engineering";
  return "general";
}

function distinctiveNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_]/)
    .filter((token) => token.length > 2 && !GENERIC_ROUTING_TOKENS.has(token));
}

function textTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function descriptionTokens(value: string): string[] {
  return [...textTokens(value)].filter(
    (token) =>
      token.length > 3 && !DESCRIPTION_STOP_WORDS.has(token) && !GENERIC_ROUTING_TOKENS.has(token),
  );
}

export function parseSkillMarkdown(rawContent: string, sourcePath = ""): SkillDefinition | null {
  const clean = rawContent.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(clean);
  if (!match) return null;

  let fields: Record<string, unknown>;
  try {
    const parsed = parseYaml(match[1] ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    fields = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const body = match[2]?.trim() ?? "";
  const name = asString(fields.name);
  if (!name) return null;
  const description = asString(fields.description) ?? "";
  const shortDescription =
    asString(fields["short-description"]) ?? asString(fields.short_description);
  const version = asString(fields.version);
  const author = asString(fields.author);
  const tags = asStringArray(fields.tags);
  const allowedTools =
    asStringArray(fields.allowed_tools).length > 0
      ? asStringArray(fields.allowed_tools)
      : asStringArray(fields.tools);

  const rawCategory = asString(fields.category)?.toLowerCase();
  const category: SkillMetadataInfo["category"] =
    rawCategory &&
    ["engineering", "design", "qa", "science", "ops", "management", "general"].includes(rawCategory)
      ? (rawCategory as SkillMetadataInfo["category"])
      : inferSkillCategory(name, description, tags);

  const parameters: SkillParameter[] = [];
  let rawParameters: unknown = fields.parameters;
  if (typeof rawParameters === "string") {
    try {
      rawParameters = JSON.parse(rawParameters);
    } catch {
      rawParameters = undefined;
    }
  }
  if (Array.isArray(rawParameters)) {
    for (const item of rawParameters) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const parameter = item as Record<string, unknown>;
      const parameterName = asString(parameter.name);
      if (!parameterName) continue;
      const defaultValue = asString(parameter.default);
      parameters.push({
        name: parameterName,
        description: asString(parameter.description) ?? "",
        required: parameter.required === true,
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      });
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
  const promptTokens = textTokens(prompt);
  const matchedKeywords: string[] = [];
  let score = 0;

  const canonicalName = skill.name.toLowerCase();
  const normalizedName = canonicalName.replace(/[-_]/g, " ");
  const exactNameMatch =
    lowerPrompt.includes(canonicalName) || lowerPrompt.includes(normalizedName);
  if (exactNameMatch) {
    score += 0.6;
    matchedKeywords.push(skill.name);
  }

  const distinctiveTokens = distinctiveNameTokens(skill.name);
  let matchedDistinctive = 0;
  for (const token of distinctiveTokens) {
    if (promptTokens.has(token)) {
      matchedDistinctive += 1;
      score += 0.11;
      matchedKeywords.push(token);
    }
  }
  if (distinctiveTokens.length > 1 && matchedDistinctive === distinctiveTokens.length)
    score += 0.12;

  for (const tag of skill.tags) {
    const value = tag.toLowerCase();
    if (value.length > 2 && (lowerPrompt.includes(value) || promptTokens.has(value))) {
      score += 0.14;
      matchedKeywords.push(tag);
    }
  }

  if (skill.category !== "general" && promptTokens.has(skill.category)) {
    score += 0.08;
    matchedKeywords.push(skill.category);
  }

  let descriptionMatches = 0;
  for (const token of descriptionTokens(`${skill.shortDescription ?? ""} ${skill.description}`)) {
    if (!promptTokens.has(token) || matchedKeywords.includes(token)) continue;
    matchedKeywords.push(token);
    descriptionMatches += 1;
    score += 0.025;
    if (descriptionMatches >= 4) break;
  }

  // Service wrappers are intentionally numerous. A generic request mentioning only words such
  // as "automation" must not fan out across hundreds of unrelated integrations; require at
  // least one distinctive service/product token (or an explicit canonical-name match).
  if (canonicalName.endsWith("-automation") && !exactNameMatch && matchedDistinctive === 0) {
    score = Math.min(score, 0.19);
  }

  const normalizedScore = Math.min(1, Math.round(score * 100) / 100);
  return {
    skill,
    score: normalizedScore,
    matchedKeywords: [...new Set(matchedKeywords)],
    reason: matchedKeywords.length
      ? `Matched terms: ${[...new Set(matchedKeywords)].join(", ")}`
      : "No strong term match",
  };
}

export function interpolateVariables(template: string, vars: Record<string, string>): string {
  const token = /\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}|\$([A-Za-z_][A-Za-z0-9_.-]*)\b/g;
  return template.replace(
    token,
    (
      match,
      doubleKey: string | undefined,
      braceKey: string | undefined,
      dollarKey: string | undefined,
    ) => {
      const key = doubleKey ?? braceKey ?? dollarKey;
      return key !== undefined && Object.prototype.hasOwnProperty.call(vars, key)
        ? vars[key]!
        : match;
    },
  );
}

export function bindSkillVariables(
  skill: SkillDefinition,
  variables: Record<string, string> = {},
): Record<string, string> {
  const bound = { ...variables };
  for (const parameter of skill.parameters) {
    if (bound[parameter.name] !== undefined) continue;
    if (parameter.default !== undefined) {
      bound[parameter.name] = parameter.default;
      continue;
    }
    if (parameter.required) {
      throw new Error(`Skill "${skill.name}" requires parameter "${parameter.name}"`);
    }
  }
  return bound;
}

/** Aliases bundled with the runtime must only target capabilities still present in the shipped corpus. */
export const DEFAULT_SKILL_ALIASES: Record<string, string> = {
  "accessibility-testing-expert": "accessibility-testing-bilingual",
  "ai-evals-benchmark-expert": "ai-evals-benchmark-bilingual",
  "ai-llm-integration-expert": "ai-llm-integration-bilingual",
  "ai-media-generation-expert": "ai-media-generation-bilingual",
  "ai-prompt-engineering-expert": "prompt-engineering-bilingual",
  "api-design-expert": "api-design-bilingual",
  "api-gateway-proxy-expert": "api-gateway-proxy-bilingual",
  "apple-ecosystem-expert": "apple-ecosystem-bilingual",
  "astro-framework-expert": "astro-framework-bilingual",
  "async-queue-temporal-expert": "async-queue-temporal-bilingual",
  "auth-patterns": "nextjs-auth-patterns",
  "authentication-identity-expert": "authentication-identity-bilingual",
  "background-jobs-queue-expert": "background-jobs-queue-bilingual",
  "biome-linter-formatter-expert": "biome-linter-formatter-bilingual",
  "blockchain-web3-expert": "blockchain-web3-bilingual",
  browser: "chrome-cdp-browser-control",
  "browser-automation-expert": "browser-automation-bilingual",
  browsing: "use-browser-mcp-control",
  "bun-runtime-expert": "bun-runtime-bilingual",
  "chatbot-messaging-expert": "chatbot-messaging-bilingual",
  "cloud-hosting-expert": "cloud-hosting-bilingual",
  "compliance-gdpr-privacy-expert": "compliance-gdpr-privacy-bilingual",
  connect: "composio-cli-connect",
  "connect-apps": "composio-cli-connect",
  "cron-scheduler-expert": "cron-scheduler-bilingual",
  customize: "agent-profile-customizer",
  "data-pipeline-etl-expert": "data-pipeline-etl-bilingual",
  "data-telemetry-expert": "data-telemetry-bilingual",
  "data-visualization-expert": "data-visualization-bilingual",
  "database-migration-versioning-expert": "database-migration-versioning-bilingual",
  "database-orm-expert": "database-orm-bilingual",
  debug: "root-cause-debugger",
  delegate: "subagent-delegator",
  "desktop-electron-expert": "desktop-electron-bilingual",
  diagnose: "performance-diagnostics-loop",
  "documentation-site-expert": "documentation-site-bilingual",
  "domain-driven-design-expert": "domain-driven-design-bilingual",
  draft: "legal-clinic-document-drafter",
  "e2e-testing-expert": "e2e-testing-bilingual",
  "ecommerce-expert": "ecommerce-bilingual",
  "edge-serverless-db-expert": "edge-serverless-db-bilingual",
  "email-notification-expert": "email-notification-bilingual",
  "error-resilience-expert": "error-resilience-bilingual",
  "feature-flag-analytics-expert": "feature-flag-analytics-bilingual",
  "file-upload-media-expert": "file-upload-media-bilingual",
  "firebase-security-expert": "firebase-security-bilingual",
  "form-validation-expert": "form-validation-bilingual",
  "fullstack-expert": "fullstack-bilingual",
  "geospatial-maps-expert": "geospatial-maps-bilingual",
  "global-a11y-i18n-expert": "global-a11y-i18n-bilingual",
  "go-programming-expert": "go-programming-bilingual",
  "graph-rag-knowledge-expert": "graph-rag-knowledge-bilingual",
  handoff: "agent-session-handoff",
  "headless-cms-expert": "headless-cms-bilingual",
  implement: "feature-implementation-runner",
  init: "project-init-scaffold",
  interview: "socratic-task-interview",
  "journal-entry-prep": "journal-entry",
  "js-backend-expert": "js-backend-bilingual",
  "local-slm-edge-ai-expert": "local-slm-edge-ai-bilingual",
  "logging-error-tracking-expert": "logging-error-tracking-bilingual",
  loop: "recurring-prompt-loop",
  "mobile-expo-expert": "mobile-expo-bilingual",
  "mobile-push-notification-expert": "mobile-push-notification-bilingual",
  "modern-css-native-expert": "modern-css-native-bilingual",
  "n8n-automation-expert": "n8n-automation-bilingual",
  "nextjs-app-router-expert": "nextjs-app-router-bilingual",
  "payment-gateway-expert": "payment-gateway-bilingual",
  "pdf-document-generation-expert": "pdf-document-generation-bilingual",
  plan: "task-planning-runner",
  "prompt-engineering-expert": "prompt-instructions-design",
  "pwa-offline-first-expert": "pwa-offline-first-bilingual",
  "pydantic-ai-expert": "pydantic-ai-bilingual",
  "python-programming-expert": "python-programming-bilingual",
  "realtime-collaboration-expert": "realtime-collaboration-bilingual",
  release: "release-process-runner",
  review: "diff-correctness-review",
  "rich-text-editor-expert": "rich-text-editor-bilingual",
  "rust-programming-expert": "rust-programming-bilingual",
  screenshot: "window-screenshot-capture",
  "search-engine-expert": "search-engine-bilingual",
  "secrets-management-best-practices": "aws-secrets-manager-best-practices",
  "seo-audit-expert": "seo-optimization-bilingual",
  simplify: "code-simplification-cleaner",
  "snowflake-expert": "snowflake-platform-engineering",
  "solidjs-expert": "solidjs-bilingual",
  "sse-websocket-streaming-expert": "sse-websocket-streaming-bilingual",
  "state-management-expert": "state-management-bilingual",
  summarize: "media-url-summarizer",
  "supabase-security-expert": "supabase-security-bilingual",
  "svelte-sveltekit-expert": "svelte-sveltekit-bilingual",
  "svg-animation-motion-expert": "svg-animation-motion-bilingual",
  "synthetic-data-finetuning-expert": "synthetic-data-finetuning-bilingual",
  "tailwind-expert": "tailwind-bilingual",
  "tauri-expert": "tauri-bilingual",
  test: "project-test-runner",
  "typescript-expert": "typescript-bilingual",
  "ui-components-expert": "ui-components-bilingual",
  "vector-db-rag-expert": "vector-db-rag-bilingual",
  "vercel-ai-sdk-expert": "vercel-ai-sdk-bilingual",
  verify: "runtime-output-verifier",
  "vue-frontend-expert": "vue-frontend-bilingual",
  "wasm-edge-computing-expert": "wasm-edge-computing-bilingual",
  "wordpress-headless-expert": "wordpress-headless-bilingual",
  "workflow-orchestration-patterns": "temporal-workflow-orchestration",
  "workflow-patterns": "conductor-workflow-patterns",
};

export function resolveSkillAlias(name: string, customAliases?: Record<string, string>): string {
  const aliases = customAliases ?? DEFAULT_SKILL_ALIASES;
  let current = name.toLowerCase();
  const visited = new Set<string>();
  while (aliases[current]) {
    if (visited.has(current)) return name;
    visited.add(current);
    current = aliases[current]!;
  }
  return current === name.toLowerCase() ? name : current;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly aliases = new Map<string, string>();

  constructor(initialAliases: Record<string, string> = DEFAULT_SKILL_ALIASES) {
    for (const [alias, target] of Object.entries(initialAliases)) {
      this.aliases.set(alias.toLowerCase(), target.toLowerCase());
    }
  }

  public registerAlias(alias: string, canonicalName: string): void {
    const lowerAlias = alias.toLowerCase();
    const lowerTarget = canonicalName.toLowerCase();
    if (lowerAlias === lowerTarget) throw new Error(`Skill alias '${alias}' cannot target itself`);
    const previous = this.aliases.get(lowerAlias);
    this.aliases.set(lowerAlias, lowerTarget);
    try {
      this.resolveAlias(lowerAlias);
    } catch (error) {
      if (previous === undefined) this.aliases.delete(lowerAlias);
      else this.aliases.set(lowerAlias, previous);
      throw error;
    }
  }

  public resolveAlias(name: string): string {
    let current = name.toLowerCase();
    const visited = new Set<string>();
    while (this.aliases.has(current)) {
      if (visited.has(current)) {
        throw new Error(`Skill alias cycle detected at '${current}'`);
      }
      visited.add(current);
      current = this.aliases.get(current)!;
    }
    return current;
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

  public list(filter?: {
    category?: string;
    tag?: string;
    tool?: string;
    query?: string;
  }): SkillDefinition[] {
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
        (skill) =>
          skill.allowedTools.includes("*") ||
          skill.allowedTools.some((value) => value.toLowerCase() === tool),
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
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const specificity =
          distinctiveNameTokens(b.skill.name).length - distinctiveNameTokens(a.skill.name).length;
        return specificity !== 0 ? specificity : a.skill.name.localeCompare(b.skill.name);
      })
      .slice(0, maxResults);
  }

  public buildPromptSection(
    skillName: string,
    variables: Record<string, string> = {},
    includeReferences = false,
  ): string {
    const skill = this.get(skillName);
    if (!skill) throw new Error(`Skill "${skillName}" is not registered`);

    const bound = bindSkillVariables(skill, variables);
    const interpolatedBody = interpolateVariables(skill.content, bound);
    let output = `=== SKILL: ${skill.name} ===\n${interpolatedBody}\n`;
    if (includeReferences && Object.keys(skill.referenceFiles).length > 0) {
      output += "\n--- REFERENCES ---\n";
      for (const [relPath, refContent] of Object.entries(skill.referenceFiles)) {
        output += `\n[Reference: ${relPath}]\n${interpolateVariables(refContent, bound)}\n`;
      }
    }
    return `${output}=== END SKILL: ${skill.name} ===\n`;
  }
}

export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0)
    return { valid: false, error: "Agent name must not be empty" };
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 64) {
    return {
      valid: false,
      error: `Agent name exceeds maximum length of 64 bytes (got ${bytes.length})`,
    };
  }
  if (!/^[a-z]/.test(name))
    return { valid: false, error: "Agent name must start with a lowercase letter (a-z)" };
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return {
      valid: false,
      error:
        "Agent name can only contain lowercase letters (a-z), digits (0-9), underscores (_), and hyphens (-)",
    };
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

export function synthesizeFunctionDefinition(
  options: StrictFunctionDefinitionOptions,
): Record<string, unknown> {
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
          description:
            "The task prompt for this agent, including objective, relevant context, and constraints.",
          minLength: 1,
        },
      },
      required: options.required ?? ["prompt"],
      additionalProperties: false,
    },
    strict: options.strict ?? true,
  };
}
