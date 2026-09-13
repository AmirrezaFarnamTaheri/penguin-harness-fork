import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const DEFAULT_SKILL_ROOT = path.join(REPO_ROOT, ".agents", "skills");
export const DEFAULT_ALIASES_FILE = path.join(DEFAULT_SKILL_ROOT, "aliases.json");
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const requireFromCore = createRequire(path.join(REPO_ROOT, "packages", "core", "package.json"));
const { parse: parseYaml } = requireFromCore("yaml");

const GENERIC_NAME_TOKENS = new Set([
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

const DOMAIN_RULES = [
  [
    "qa",
    /\b(test|testing|qa|quality|verify|verification|debug|debugging|regression|lint|review|audit)\b/i,
  ],
  ["design", /\b(ui|ux|design|figma|visual|typography|brand|branding|css|accessibility)\b/i],
  [
    "ops",
    /\b(devops|deploy|deployment|ci|cd|pipeline|infra|infrastructure|docker|kubernetes|terraform|observability|monitoring|release)\b/i,
  ],
  [
    "security",
    /\b(security|secure|auth|authentication|authorization|oauth|secret|vulnerability|threat|pentest|crypto|cryptography)\b/i,
  ],
  [
    "data",
    /\b(data|database|sql|postgres|mysql|analytics|spreadsheet|csv|etl|warehouse|visualization)\b/i,
  ],
  [
    "science",
    /\b(science|scientific|biology|bioinformatics|protein|chemistry|chemical|physics|medical|genomics|statistics|statistical)\b/i,
  ],
  [
    "management",
    /\b(plan|planning|project|product|prd|roadmap|epic|triage|strategy|management|manager|hiring|finance|budget)\b/i,
  ],
  [
    "communication",
    /\b(write|writing|copy|email|message|document|docs|documentation|translation|summarize|summary|presentation|slides)\b/i,
  ],
  ["research", /\b(research|search|investigate|analysis|analyze|literature|evidence)\b/i],
  [
    "engineering",
    /\b(code|coding|software|engineer|engineering|api|backend|frontend|typescript|javascript|python|rust|go|java|react|nextjs|architecture)\b/i,
  ],
];

export function inferSkillDomain(name, description = "", tags = []) {
  const haystack = `${name.replaceAll("-", " ")} ${description} ${tags.join(" ")}`;
  for (const [domain, matcher] of DOMAIN_RULES) {
    if (matcher.test(haystack)) return domain;
  }
  return "general";
}

export function inferSkillKind(name, description = "") {
  const lower = `${name} ${description}`.toLowerCase();
  if (name.endsWith("-automation")) return "service-automation";
  if (name.endsWith("-bilingual")) return "bilingual-specialist";
  if (name.endsWith("-patterns") || name.endsWith("-best-practices")) return "reference-patterns";
  if (name.endsWith("-runner") || /\b(run|execute|execution)\b/.test(lower)) return "executor";
  if (name.endsWith("-author") || /\b(author|create|generate|draft)\b/.test(lower))
    return "authoring";
  if (name.endsWith("-review") || /\b(review|audit|inspect)\b/.test(lower)) return "review";
  if (/\b(router|route|dispatch|delegate)\b/.test(lower)) return "router";
  if (/\b(catalog(?:ue)? entry|reference-only|reference only)\b/.test(lower)) return "reference";
  return "workflow";
}

export function normalizedStem(name) {
  const suffixes = [
    "-automation",
    "-bilingual",
    "-expert",
    "-patterns",
    "-best-practices",
    "-runner",
    "-workflow",
    "-helper",
    "-tool",
  ];
  let stem = name;
  for (const suffix of suffixes) {
    if (stem.endsWith(suffix) && stem.length > suffix.length) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  return stem;
}

export function distinctiveNameTokens(name) {
  return name
    .toLowerCase()
    .split("-")
    .filter((token) => token.length > 2 && !GENERIC_NAME_TOKENS.has(token));
}

export function parseFrontmatter(raw, file = "SKILL.md") {
  const clean = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(clean);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  let parsed;
  try {
    parsed = parseYaml(match[1]);
  } catch (error) {
    throw new Error(
      `${file}: invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: frontmatter must be a mapping`);
  }
  return { metadata: parsed, body: clean.slice(match[0].length) };
}

export async function listSkillDirectories(root = DEFAULT_SKILL_ROOT) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function loadAliases(file = DEFAULT_ALIASES_FILE) {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: alias manifest must be an object`);
  }
  const aliases = parsed.aliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error(`${file}: aliases must be an object`);
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (typeof target !== "string")
      throw new Error(`${file}: alias '${alias}' must map to a string target`);
  }
  return { ...parsed, aliases };
}

export function resolveAlias(alias, aliases) {
  const visited = new Set();
  let current = alias;
  while (Object.hasOwn(aliases, current)) {
    if (visited.has(current)) {
      return { target: current, cycle: [...visited, current] };
    }
    visited.add(current);
    current = aliases[current];
  }
  return { target: current, cycle: null };
}

function stripAnchorAndQuery(value) {
  return value.split("#", 1)[0].split("?", 1)[0];
}

function isConcreteLocalReference(value) {
  // Placeholders, globs and illustrative pseudo-paths are routing/documentation examples,
  // not dependency-closure claims. Keep the audit focused on concrete paths a package can
  // actually ship and resolve.
  if (/[<>{}*\[\]]/.test(value) || value.includes("...")) return false;
  if (value.endsWith("/")) return false;
  return true;
}

export function extractLocalReferences(markdown) {
  const refs = new Set();
  const add = (raw) => {
    const value = stripAnchorAndQuery(raw.trim().replace(/^['"<]|['">]$/g, ""));
    if (!value || /^(?:https?:|mailto:|data:|asset:|#)/i.test(value)) return;
    if (value.startsWith("/") || value.startsWith("~")) return;
    if (!isConcreteLocalReference(value)) return;
    if (/^(?:scripts|references|assets|_common|_templates)\//.test(value)) refs.add(value);
  };

  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) add(match[1]);
  for (const match of markdown.matchAll(
    /`((?:scripts|references|assets|_common|_templates)\/[^`\s]+)`/g,
  ))
    add(match[1]);
  for (const match of markdown.matchAll(
    /(?:^|\s)(?:node|python3?|bash|sh)\s+((?:scripts|references|assets)\/[^\s'"`;]+)/gm,
  ))
    add(match[1]);
  return [...refs].sort((a, b) => a.localeCompare(b));
}

export async function pathType(abs) {
  try {
    const stat = await fs.lstat(abs);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    if (stat.isSymbolicLink()) return "symlink";
    return "other";
  } catch (error) {
    // ENOTDIR occurs when a path component that documentation expects to be a
    // directory is actually a flattened pointer/plain file. From the caller's
    // perspective the requested resource is unresolved, just like ENOENT.
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return "missing";
    throw error;
  }
}

export async function readSkillRecord(root, dirName) {
  const dir = path.join(root, dirName);
  const canonical = path.join(dir, "SKILL.md");
  const lowercase = path.join(dir, "skill.md");
  const canonicalType = await pathType(canonical);
  const lowercaseType = canonicalType === "missing" ? await pathType(lowercase) : "missing";
  if (canonicalType !== "file") {
    return {
      dirName,
      dir,
      entrypoint: canonical,
      entrypointType: canonicalType,
      lowercaseEntrypointType: lowercaseType,
      metadata: null,
      body: "",
      raw: "",
      references: [],
    };
  }
  const raw = await fs.readFile(canonical, "utf8");
  const { metadata, body } = parseFrontmatter(raw, canonical);
  return {
    dirName,
    dir,
    entrypoint: canonical,
    entrypointType: canonicalType,
    lowercaseEntrypointType: lowercaseType,
    metadata,
    body,
    raw,
    references: extractLocalReferences(raw),
  };
}

export function normalizeDescription(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[`*_#]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function stableStringify(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sort(input[key])]),
      );
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
