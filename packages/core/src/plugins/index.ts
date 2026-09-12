/**
 * PenguinHarness plugin library: built-in plugins and their skill/hook loader.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  shortDescriptionZh?: string;
  version: string;
}

export interface LibrarySkill extends SkillMetadata {
  content: string;
  icon?: string;
  files?: Record<string, string>;
}

export interface HookCommand {
  command: string;
  timeout?: number;
}

export interface HookManifest {
  name: string;
  description: string;
  description_zh?: string;
  version: string;
  stop: HookCommand[];
  pre_tool_use: HookCommand[];
  user_prompt: HookCommand[];
}

export interface LibraryHooks {
  manifest: HookManifest;
  files: Record<string, string>;
}

export interface LibraryPlugin {
  name: string;
  description: string;
  descriptionZh?: string;
  shortDescription?: string;
  shortDescriptionZh?: string;
  version: string;
  category?: string;
  preinstall: boolean;
  icon?: string;
  skills: LibrarySkill[];
  hooks?: LibraryHooks;
}

export interface PluginCategory {
  id: string;
  title: string;
  titleZh?: string;
}

export interface ResolvedPluginGroup extends PluginCategory {
  plugins: LibraryPlugin[];
}

export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const PLUGIN_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
const LEGACY_PLUGIN_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;

export function parsePluginVersion(version: string): { date: string; seq: number } | null {
  if (!PLUGIN_VERSION_PATTERN.test(version) && !LEGACY_PLUGIN_VERSION_PATTERN.test(version)) {
    return null;
  }
  const dot = version.lastIndexOf(".");
  return { date: version.slice(0, dot).replace(/-/g, "."), seq: Number(version.slice(dot + 1)) };
}

export function comparePluginVersions(a: string, b: string): number {
  const va = parsePluginVersion(a);
  const vb = parsePluginVersion(b);
  if (!va || !vb) return Number(va !== null) - Number(vb !== null);
  if (va.date !== vb.date) return va.date < vb.date ? -1 : 1;
  return va.seq - vb.seq;
}

/**
 * Parse real YAML frontmatter while deliberately consuming only Penguin's scalar metadata.
 * Block scalars are supported; nested host-specific metadata is ignored rather than flattened into
 * misleading strings. Malformed YAML or a non-string name is not a valid skill.
 */
export function parseSkillFrontmatter(content: string): SkillMetadata | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.replace(/^\ufeff/, ""));
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  if (typeof fields.name !== "string" || fields.name.trim().length === 0) return null;

  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  const shortDescription =
    typeof fields.short_description === "string" ? fields.short_description.trim() : undefined;
  const shortDescriptionZh =
    typeof fields.short_description_zh === "string" ? fields.short_description_zh.trim() : undefined;
  const rawVersion = typeof fields.version === "string" ? fields.version.trim() : "";

  return {
    name: fields.name.trim(),
    description,
    ...(shortDescription !== undefined ? { shortDescription } : {}),
    ...(shortDescriptionZh !== undefined ? { shortDescriptionZh } : {}),
    version: parsePluginVersion(rawVersion) !== null ? rawVersion : "",
  };
}

function packageRoot(): string {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No package.json above the plugin loader at ${start}`);
    dir = parent;
  }
}
const PKG_ROOT = packageRoot();
const PLUGIN_PKG_PREFIX = "@penguinharness/";

function pluginRoots(): Map<string, string> {
  const roots = new Map<string, string>();
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const require = createRequire(import.meta.url);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!dep.startsWith(PLUGIN_PKG_PREFIX)) continue;
    let manifest: string;
    try {
      manifest = require.resolve(`${dep}/package.json`);
    } catch (err) {
      throw new Error(
        `Plugin package ${dep} is declared in ${PKG_ROOT}/package.json but cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    roots.set(dep.slice(PLUGIN_PKG_PREFIX.length), path.dirname(manifest));
  }
  return roots;
}

function readUtf8Strict(file: string): string {
  const data = fs.readFileSync(file);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`Plugin library file ${file} is binary or is not valid UTF-8 text.`);
  }
  if (text.includes("\u0000")) {
    throw new Error(`Plugin library file ${file} contains NUL bytes and cannot be loaded as text.`);
  }
  return text;
}

function readDirFiles(dir: string, except: readonly string[]): Record<string, string> | undefined {
  const files: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        if (rel === "" && except.includes(entry.name)) continue;
        files[childRel] = readUtf8Strict(path.join(abs, entry.name));
      }
    }
  };
  walk(dir, "");
  return Object.keys(files).length > 0 ? files : undefined;
}

function readSkillDir(dir: string, name: string): LibrarySkill {
  const file = path.join(dir, "SKILL.md");
  const content = readUtf8Strict(file);
  const meta = parseSkillFrontmatter(content);
  if (!meta) throw new Error(`Library skill ${file} has no valid YAML frontmatter with a name`);
  const files = readDirFiles(dir, ["SKILL.md", "icon.svg"]);
  return { ...meta, name, content, ...(files !== undefined ? { files } : {}) };
}

function yamlScalar(value: string): string {
  // A JSON string literal is also a valid YAML scalar and safely preserves colons/newlines/quotes.
  return JSON.stringify(value);
}

function stampSkill(
  skill: LibrarySkill,
  plugin: {
    shortDescription?: string;
    shortDescriptionZh?: string;
    version: string;
    icon?: string;
  },
): LibrarySkill {
  const { shortDescription, shortDescriptionZh } = plugin;
  const front = [
    "---",
    `name: ${yamlScalar(skill.name)}`,
    `description: ${yamlScalar(skill.description)}`,
    ...(shortDescription !== undefined ? [`short_description: ${yamlScalar(shortDescription)}`] : []),
    ...(shortDescriptionZh !== undefined ? [`short_description_zh: ${yamlScalar(shortDescriptionZh)}`] : []),
    `version: ${yamlScalar(plugin.version)}`,
    "---",
  ].join("\n");
  const body = skill.content.replace(/^\ufeff?---\r?\n[\s\S]*?\r?\n---/, "");
  return {
    ...skill,
    ...(shortDescription !== undefined ? { shortDescription } : {}),
    ...(shortDescriptionZh !== undefined ? { shortDescriptionZh } : {}),
    version: plugin.version,
    ...(plugin.icon !== undefined ? { icon: plugin.icon } : {}),
    content: `${front}${body}`,
  };
}

interface PluginManifestFile {
  description: string;
  description_zh?: string;
  short_description?: string;
  short_description_zh?: string;
  version: string;
  category?: string;
  preinstall?: boolean;
  hooks?: {
    stop?: HookCommand[];
    pre_tool_use?: HookCommand[];
    user_prompt?: HookCommand[];
  };
}

function readPluginDir(name: string, dir: string): LibraryPlugin {
  const manifestFile = path.join(dir, "plugin.json");
  const manifest = JSON.parse(readUtf8Strict(manifestFile)) as PluginManifestFile;
  if (!PLUGIN_VERSION_PATTERN.test(manifest.version)) {
    throw new Error(`${manifestFile}: version must be YYYY.MM.DD.N, got ${manifest.version}`);
  }
  const {
    description,
    description_zh: descriptionZh,
    short_description: shortDescription,
    short_description_zh: shortDescriptionZh,
    version,
  } = manifest;
  const skills: LibrarySkill[] = [];
  const skillsDir = path.join(dir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) skills.push(readSkillDir(path.join(skillsDir, entry.name), entry.name));
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
  }
  let icon: string | undefined;
  try {
    icon = readUtf8Strict(path.join(dir, "icon.svg"));
  } catch (error) {
    if (fs.existsSync(path.join(dir, "icon.svg"))) throw error;
  }
  const hooksDir = path.join(dir, "hooks");
  const hookFiles = fs.existsSync(hooksDir) ? readDirFiles(hooksDir, []) : undefined;
  const hooks: LibraryHooks | undefined =
    hookFiles !== undefined
      ? {
          manifest: {
            name,
            description,
            ...(descriptionZh !== undefined ? { description_zh: descriptionZh } : {}),
            version,
            stop: manifest.hooks?.stop ?? [],
            pre_tool_use: manifest.hooks?.pre_tool_use ?? [],
            user_prompt: manifest.hooks?.user_prompt ?? [],
          },
          files: hookFiles,
        }
      : undefined;
  return {
    name,
    description,
    ...(descriptionZh !== undefined ? { descriptionZh } : {}),
    ...(shortDescription !== undefined ? { shortDescription } : {}),
    ...(shortDescriptionZh !== undefined ? { shortDescriptionZh } : {}),
    version,
    ...(manifest.category !== undefined ? { category: manifest.category } : {}),
    preinstall: manifest.preinstall !== false,
    ...(icon !== undefined ? { icon } : {}),
    skills: skills.map((skill) =>
      stampSkill(skill, {
        ...(shortDescription !== undefined ? { shortDescription } : {}),
        ...(shortDescriptionZh !== undefined ? { shortDescriptionZh } : {}),
        version,
        ...(icon !== undefined ? { icon } : {}),
      }),
    ),
    ...(hooks !== undefined ? { hooks } : {}),
  };
}

export function loadLibraryPlugins(): LibraryPlugin[] {
  return [...pluginRoots()]
    .map(([name, dir]) => readPluginDir(name, dir))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadPreinstalledPlugins(): LibraryPlugin[] {
  return loadLibraryPlugins().filter((plugin) => plugin.preinstall);
}

export function libraryPlugin(name: string): LibraryPlugin | undefined {
  const dir = pluginRoots().get(name);
  return dir !== undefined ? readPluginDir(name, dir) : undefined;
}

export function librarySkill(
  name: string,
): { plugin: LibraryPlugin; skill: LibrarySkill } | undefined {
  for (const plugin of loadLibraryPlugins()) {
    const skill = plugin.skills.find((candidate) => candidate.name === name);
    if (skill) return { plugin, skill };
  }
  return undefined;
}

export const PLUGIN_CATEGORIES: PluginCategory[] = [
  { id: "office-productivity", title: "Office Productivity", titleZh: "\u529e\u516c\u6548\u7387" },
  { id: "software-development", title: "Software Development", titleZh: "\u8f6f\u4ef6\u5f00\u53d1" },
  { id: "ai-app-development", title: "AI App Development", titleZh: "AI \u5e94\u7528\u5f00\u53d1" },
  { id: "agent-company", title: "Agent Company", titleZh: "Agent \u516c\u53f8" },
];

export function groupPlugins(all: LibraryPlugin[]): ResolvedPluginGroup[] {
  const groups: ResolvedPluginGroup[] = [];
  const known = new Set(PLUGIN_CATEGORIES.map((category) => category.id));
  for (const category of PLUGIN_CATEGORIES) {
    const members = all
      .filter((plugin) => plugin.category === category.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (members.length > 0) groups.push({ ...category, plugins: members });
  }
  const others = all
    .filter((plugin) => plugin.category === undefined || !known.has(plugin.category))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (others.length > 0) {
    groups.push({ id: "other", title: "Other", titleZh: "\u5176\u4ed6", plugins: others });
  }
  return groups;
}

export function loadPluginGroups(): ResolvedPluginGroup[] {
  return groupPlugins(loadLibraryPlugins());
}

export interface ExternalPluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  format: "claude-code" | "gemini-cli" | "cursor" | "native";
  commands: Array<{ name: string; description: string; handler?: string }>;
  skills: string[];
  hooks: Record<string, string[]>;
}

export function parseClaudePluginManifest(rawJson: string): ExternalPluginManifest {
  const parsed = JSON.parse(rawJson);
  return {
    name: parsed.name ?? "unnamed-claude-plugin",
    version: parsed.version ?? "1.0.0",
    description: parsed.description ?? "",
    author: parsed.author,
    format: "claude-code",
    commands: Array.isArray(parsed.commands)
      ? parsed.commands.map((cmd: any) => ({
          name: cmd.name ?? "",
          description: cmd.description ?? "",
          handler: cmd.handler,
        }))
      : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    hooks: parsed.hooks ?? {},
  };
}

export function parseGeminiExtensionManifest(rawJson: string): ExternalPluginManifest {
  const parsed = JSON.parse(rawJson);
  return {
    name: parsed.name ?? parsed.id ?? "unnamed-gemini-extension",
    version: parsed.version ?? "1.0.0",
    description: parsed.description ?? "",
    author: parsed.publisher,
    format: "gemini-cli",
    commands: Array.isArray(parsed.contributions?.commands)
      ? parsed.contributions.commands.map((cmd: any) => ({
          name: cmd.command ?? cmd.id ?? "",
          description: cmd.title ?? cmd.description ?? "",
        }))
      : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    hooks: {},
  };
}

export function parseCursorPluginManifest(rawJson: string): ExternalPluginManifest {
  const parsed = JSON.parse(rawJson);
  return {
    name: parsed.name ?? "unnamed-cursor-plugin",
    version: parsed.version ?? "1.0.0",
    description: parsed.description ?? "",
    format: "cursor",
    commands: Array.isArray(parsed.rules)
      ? parsed.rules.map((rule: any) => ({
          name: rule.name ?? "",
          description: rule.description ?? "",
        }))
      : [],
    skills: [],
    hooks: {},
  };
}

export type PipelineStage = "pre-filter" | "command-match" | "llm-fallback" | "post-filter";

export interface PipelineFilter {
  name: string;
  stage: PipelineStage;
  priority: number;
  execute: (message: string, context?: Record<string, unknown>) => Promise<{
    handled: boolean;
    output?: string;
    stopPipeline?: boolean;
  }>;
}

export async function runMessagePipeline(
  message: string,
  filters: PipelineFilter[],
  context?: Record<string, unknown>,
): Promise<{ handled: boolean; finalOutput: string; executedFilters: string[] }> {
  const sorted = [...filters].sort((a, b) => a.priority - b.priority);
  let currentText = message;
  const executed: string[] = [];

  for (const filter of sorted) {
    executed.push(filter.name);
    const result = await filter.execute(currentText, context);
    if (result.output) currentText = result.output;
    if (result.stopPipeline || result.handled) {
      return { handled: true, finalOutput: currentText, executedFilters: executed };
    }
  }

  return { handled: false, finalOutput: currentText, executedFilters: executed };
}
