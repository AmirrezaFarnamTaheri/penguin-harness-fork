/**
 * Loading and initialization of Agent State (semantics modeled on Hugging Face model loading).
 *
 * - Initializes when the target Agent directory is empty (no `system_config.yaml`): creates
 *   `agent_state/`, `tools/`, `memory/`, `skills/`, and the sibling `scratchpad/`, and writes
 *   the default `system_config.yaml` and `AGENTS.md`.
 * - Otherwise loads the existing system config and editable Prompt for the given `agentId`.
 *
 * The full runtime Prompt is rendered from the system-level Prompt template in
 * `system_config.yaml`; placeholders in the template are replaced with `AGENTS.md` and the
 * concrete Session runtime environment fields. Built-in tools and MCP Server config
 * come from `system_config.yaml`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  loadPreinstalledPlugins,
  parseSkillFrontmatter,
  type HookManifest,
  type LibraryPlugin,
  type SkillMetadata,
} from "../plugins/index.js";
import type { ToolConfig, ToolDefinitionConfig } from "../interfaces/index.js";
import { atomicWriteFile } from "../internal/atomic-write.js";
import {
  AGENT_ID_PLACEHOLDER,
  AGENTS_MD_PLACEHOLDER,
  VAULT_KEYS_PLACEHOLDER,
  SKILL_METADATA_PLACEHOLDER,
  CWD_PLACEHOLDER,
  PROVIDER_PLACEHOLDER,
  MODEL_ID_PLACEHOLDER,
  DATE_PLACEHOLDER,
  MEMORY_PLACEHOLDER,
  VAULT_PLACEHOLDER,
  SKILLS_PLACEHOLDER,
  SCHEDULES_PLACEHOLDER,
  SCHEDULE_LIST_PLACEHOLDER,
  SCHEDULE_LIST_EMPTY_NOTE,
  WORKSPACE_MEMORY_DIR_PLACEHOLDER,
  WORKSPACE_MEMORY_INDEX_PLACEHOLDER,
  USER_MEMORY_INDEX_PLACEHOLDER,
  MEMORY_INDEX_EMPTY_NOTE,
  MEMORY_INDEX_MAX_LINES,
  MEMORY_INDEX_MAX_CHARS,
  DEFAULT_MEMORY_PROMPT,
  DEFAULT_MEMORY_WORKSPACE_PROMPT,
  DEFAULT_VAULT_PROMPT,
  DEFAULT_SKILLS_PROMPT,
  DEFAULT_SCHEDULES_PROMPT,
  type MemoryConfig,
  type VaultConfig,
  type SkillsConfig,
  type SchedulesConfig,
  agentStateVersion,
  defaultAgentsMd,
  defaultSystemConfig,
  OS_VERSION_PLACEHOLDER,
  PLATFORM_PLACEHOLDER,
  PROJECT_DIR_PLACEHOLDER,
  SESSION_ID_PLACEHOLDER,
  SHELL_PLACEHOLDER,
  type SystemConfig,
} from "./default-config.js";
import { builtinProjectAgentPresets, type AgentPreset } from "./builtin-agents.js";
import { ensureUserMemoryDir, type SessionMemory } from "./memory.js";
import { provisionExampleBenchmark } from "./example-benchmark.js";
import {
  agentsMdPath,
  agentStateDir,
  DEFAULT_AGENT_ID,
  DEFAULT_PROJECT_ID,
  hooksDir,
  memoryDir,
  resolveRoot,
  scheduleDir,
  scratchpadDir,
  skillsDir,
  systemConfigPath,
  toolsDir,
} from "./paths.js";

/** project_id / agent_id / skill_name only allow letters, digits, underscore `_`, and hyphen `-` (prevents path traversal). */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export type IdKind = "project_id" | "agent_id" | "skill_name";

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function assertValidId(kind: IdKind, id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid ${kind} ${JSON.stringify(id)}: only letters, digits, "_" and "-" are allowed.`,
    );
  }
}

/** A loaded Agent State handle. */
export interface AgentState {
  root: string;
  projectId: string;
  agentId: string;
  stateDir: string;
  systemConfig: SystemConfig;
  /** `AGENTS.md` as read when the State was loaded. A Session never runs on a State object it did not load itself: every model context is assembled from a fresh `loadAgentState` (see Agent.createSession). */
  agentsMd: string;
}

export interface SessionEnvironmentValues {
  sessionId: string;
  cwd: string;
  /** The Agent id this Session belongs to (system Prompt placeholder {{AGENT_ID}}). */
  agentId: string;
  /** Absolute path to this Project's directory — PenguinHarness's app data root, injected via {{PROJECT_DIR}} and shown to the model as the Environment's "App Data Dir" line (Agent State/scratchpad paths live under its `agents/`). */
  projectDir: string;
  /** The session model's provider group (system Prompt placeholder {{PROVIDER}}; paired with modelId to form the model reference). */
  provider: string;
  /** The session model's upstream model id (system Prompt placeholder {{MODEL_ID}}). */
  modelId: string;
  platform: string;
  osVersion: string;
  /** The shell command sessions run in (system Prompt placeholder {{SHELL}}; e.g. "bash", "pwsh") — tells the model which command syntax exec_command speaks. */
  shell: string;
  date: string;
}

/** Reads the Agent's `AGENTS.md` as it is on disk right now; a missing file reads as the default content (see `loadAgentState`). */
export async function readAgentsMd(
  root: string,
  projectId: string,
  agentId: string,
): Promise<string> {
  const mdPath = agentsMdPath(root, projectId, agentId);
  return (await fileExists(mdPath)) ? await fs.readFile(mdPath, "utf8") : defaultAgentsMd();
}

/**
 * THE Agent State loader — the one function behind initialization and rotation alike.
 *
 * Loads the State as it is on disk right now (`system_config.yaml` and `AGENTS.md`). With
 * `init` given and no `system_config.yaml` present, the directory is treated as a new Agent
 * and initialized first (structure, default config, preinstalled Skills; `init.preset`
 * applies there only) — the create-or-load entry `createAgent` and project provisioning use.
 * Without `init`, a missing Agent throws: the other caller is a model context opening —
 * Session creation, the context a completed compaction opens, a resume that finds its
 * context closed — which must never re-create a deleted Agent as a side effect. Either way
 * an edit to the Agent State lands in the next context and never in the one that is
 * running; the snapshot a long-lived Agent object holds is not what a Session runs on.
 * Docs: /docs/agent-loop § "Compaction".
 */
export async function loadAgentState(opts?: {
  agentId?: string;
  projectId?: string;
  root?: string;
  /** Initialize a not-yet-initialized Agent instead of throwing (`preset` applies on that path only; an existing Agent is never overwritten). */
  init?: { preset?: AgentPreset };
}): Promise<AgentState> {
  const root = opts?.root ?? resolveRoot();
  const projectId = opts?.projectId ?? DEFAULT_PROJECT_ID;
  const agentId = opts?.agentId ?? DEFAULT_AGENT_ID;

  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);

  const stateDir = agentStateDir(root, projectId, agentId);
  const configPath = systemConfigPath(root, projectId, agentId);

  if (await fileExists(configPath)) {
    const parsed = parseYaml(await fs.readFile(configPath, "utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as SystemConfig).system_prompt !== "string"
    ) {
      throw new Error(
        `Invalid Agent State config: ${configPath} is empty, corrupted, or missing the system_prompt field.`,
      );
    }
    return {
      root,
      projectId,
      agentId,
      stateDir,
      systemConfig: parsed as SystemConfig,
      agentsMd: await readAgentsMd(root, projectId, agentId),
    };
  }

  if (!opts?.init) {
    throw new Error(`Agent State is not initialized: ${configPath} does not exist.`);
  }

  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(toolsDir(root, projectId, agentId), { recursive: true }),
    ensureUserMemoryDir(root, projectId, agentId),
    fs.mkdir(skillsDir(root, projectId, agentId), { recursive: true }),
    fs.mkdir(hooksDir(root, projectId, agentId), { recursive: true }),
    fs.mkdir(scratchpadDir(root, projectId, agentId), { recursive: true }),
  ]);
  const preset = opts.init.preset;
  const systemConfig: SystemConfig = {
    ...defaultSystemConfig(),
    ...(preset?.name !== undefined ? { name: preset.name } : {}),
    ...(preset?.description !== undefined ? { description: preset.description } : {}),
  };
  const agentsMd = preset?.agentsMd ?? defaultAgentsMd();
  const plugins =
    preset === undefined && agentId === DEFAULT_AGENT_ID
      ? loadPreinstalledPlugins()
      : (preset?.plugins ?? []);
  await Promise.all([
    atomicWriteFile(agentsMdPath(root, projectId, agentId), agentsMd, { followSymlinks: true }),
    ...plugins.map((plugin) => installPlugin(root, projectId, agentId, plugin)),
    ...(agentId === DEFAULT_AGENT_ID ? [provisionExampleBenchmark(root, projectId, agentId)] : []),
  ]);
  await atomicWriteFile(configPath, stringifyYaml(systemConfig), { followSymlinks: true });

  return { root, projectId, agentId, stateDir, systemConfig, agentsMd };
}

export async function provisionProjectAgents(opts?: {
  root?: string;
  projectId?: string;
}): Promise<string[]> {
  const agentIds: string[] = [];
  for (const { agentId, preset } of builtinProjectAgentPresets()) {
    await loadAgentState({
      ...(opts?.root !== undefined ? { root: opts.root } : {}),
      ...(opts?.projectId !== undefined ? { projectId: opts.projectId } : {}),
      agentId,
      init: { preset },
    });
    agentIds.push(agentId);
  }
  return agentIds;
}

export async function resetSystemConfigToDefaults(
  root: string,
  projectId: string,
  agentId: string,
): Promise<SystemConfig> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  const configPath = systemConfigPath(root, projectId, agentId);
  if (!(await fileExists(configPath))) {
    throw new Error(`Agent State config not found: ${configPath} (the Agent does not exist).`);
  }
  const parsed = parseYaml(await fs.readFile(configPath, "utf8")) as unknown;
  const prev = (
    parsed !== null && typeof parsed === "object" ? parsed : {}
  ) as Partial<SystemConfig>;
  const next: SystemConfig = {
    ...(typeof prev.name === "string" ? { name: prev.name } : {}),
    ...(typeof prev.description === "string" ? { description: prev.description } : {}),
    ...defaultSystemConfig(),
    version: agentStateVersion(prev),
  };
  await atomicWriteFile(configPath, stringifyYaml(next), { followSymlinks: true });
  return next;
}

function vaultKeysList(keys: string[]): string {
  return keys.map((key) => `- ${key}`).join("\n");
}

function indexForInjection(index: string): string {
  const trimmed = index.trim();
  if (trimmed.length === 0) return MEMORY_INDEX_EMPTY_NOTE;
  const totalLines = trimmed.split("\n").length;
  let kept = trimmed.split("\n").slice(0, MEMORY_INDEX_MAX_LINES).join("\n");
  if (kept.length > MEMORY_INDEX_MAX_CHARS) {
    const cut = kept.lastIndexOf("\n", MEMORY_INDEX_MAX_CHARS);
    kept = kept.slice(0, cut > 0 ? cut : MEMORY_INDEX_MAX_CHARS);
  }
  if (kept.length === trimmed.length) return trimmed;
  const keptLines = kept.split("\n").length;
  const reason =
    keptLines < totalLines
      ? `showing ${keptLines} of ${totalLines} lines`
      : `showing the first ${MEMORY_INDEX_MAX_CHARS} characters`;
  return `${kept}\n(index truncated: ${reason} — open MEMORY.md for the rest)`;
}

function memorySection(
  config: MemoryConfig | undefined,
  memory: SessionMemory | null | undefined,
): string {
  if (!memory) return "";
  const promptText = config?.prompt ?? DEFAULT_MEMORY_PROMPT;
  const workspacePromptText = config?.workspace_prompt ?? DEFAULT_MEMORY_WORKSPACE_PROMPT;
  const substituteUser = (text: string): string =>
    text.split(USER_MEMORY_INDEX_PLACEHOLDER).join(indexForInjection(memory.userIndex));

  const userBlock = substituteUser(promptText).trim();
  const workspace = memory.workspace;
  const workspaceBlock =
    workspace && workspacePromptText ? substituteUser(workspacePromptText).trim() : "";
  const joined =
    userBlock && workspaceBlock ? `${userBlock}\n\n${workspaceBlock}` : userBlock || workspaceBlock;
  return joined
    .split(WORKSPACE_MEMORY_INDEX_PLACEHOLDER)
    .join(workspace ? indexForInjection(workspace.index) : "")
    .split(WORKSPACE_MEMORY_DIR_PLACEHOLDER)
    .join(workspace?.dir ?? "")
    .trim();
}

function vaultSection(config: VaultConfig | undefined, keys: string[] | undefined): string {
  if (config?.enabled === false || keys === undefined) return "";
  const promptText = config?.prompt ?? DEFAULT_VAULT_PROMPT;
  return promptText.split(VAULT_KEYS_PLACEHOLDER).join(vaultKeysList(keys)).trim();
}

function skillsSection(
  config: SkillsConfig | undefined,
  skills: SkillMetadata[] | undefined,
): string {
  if (config?.enabled === false || skills === undefined) return "";
  const promptText = config?.prompt ?? DEFAULT_SKILLS_PROMPT;
  return promptText.split(SKILL_METADATA_PLACEHOLDER).join(skillMetadataSection(skills)).trim();
}

function scheduleListForInjection(names: string[]): string {
  if (names.length === 0) return SCHEDULE_LIST_EMPTY_NOTE;
  return names.map((name) => `- ${name}`).join("\n");
}

function schedulesSection(
  config: SchedulesConfig | undefined,
  scheduleNames: string[] | undefined,
): string {
  if (config?.enabled === false || scheduleNames === undefined) return "";
  const promptText = config?.prompt ?? DEFAULT_SCHEDULES_PROMPT;
  return promptText
    .split(SCHEDULE_LIST_PLACEHOLDER)
    .join(scheduleListForInjection(scheduleNames))
    .trim();
}

function assertSafeSkillFile(rel: string): void {
  if (
    rel.length === 0 ||
    path.isAbsolute(rel) ||
    rel.includes("\\") ||
    rel.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(
      `Invalid skill file path ${JSON.stringify(rel)}: it must stay within the skill directory.`,
    );
  }
}

export async function installSkill(
  root: string,
  projectId: string,
  agentId: string,
  skill: { name: string; content: string; icon?: string; files?: Record<string, string> },
): Promise<void> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  assertValidId("skill_name", skill.name);
  const auxiliary = Object.entries(skill.files ?? {});
  for (const [rel] of auxiliary) assertSafeSkillFile(rel);
  const dir = path.join(skillsDir(root, projectId, agentId), skill.name);
  const content = skill.content.endsWith("\n") ? skill.content : `${skill.content}\n`;
  const files: Array<[string, string]> = [
    ["SKILL.md", content],
    ...(skill.icon !== undefined ? ([["icon.svg", skill.icon]] as Array<[string, string]>) : []),
    ...auxiliary,
  ];
  await replaceSkillDirectory(dir, files);
}

const replacementTails = new Map<string, Promise<void>>();

function isFsError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

async function recoverInterruptedReplacement(dir: string, staging: string, backup: string): Promise<void> {
  const dirExists = await fileExists(dir);
  const backupExists = await fileExists(backup);
  if (backupExists && !dirExists) {
    await fs.rename(backup, dir);
  } else if (backupExists && dirExists) {
    await fs.rm(backup, { recursive: true, force: true });
  }
  await fs.rm(staging, { recursive: true, force: true });
}

async function performDirectoryReplacement(
  dir: string,
  files: Array<[string, string | Uint8Array]>,
): Promise<void> {
  const hiddenBase = path.join(path.dirname(dir), `.${path.basename(dir)}`);
  const staging = `${hiddenBase}.incoming`;
  const backup = `${hiddenBase}.backup`;
  await recoverInterruptedReplacement(dir, staging, backup);
  await fs.mkdir(staging, { recursive: true });

  let oldMoved = false;
  try {
    await Promise.all(
      files.map(async ([rel, data]) => {
        const file = path.join(staging, rel);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, data);
      }),
    );

    try {
      await fs.rename(dir, backup);
      oldMoved = true;
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }

    try {
      await fs.rename(staging, dir);
    } catch (installError) {
      if (oldMoved) {
        try {
          await fs.rename(backup, dir);
          oldMoved = false;
        } catch (rollbackError) {
          throw new AggregateError(
            [installError, rollbackError],
            `Skill replacement failed for '${dir}' and the previous installation could not be restored.`,
          );
        }
      }
      throw installError;
    }

    if (oldMoved) {
      await fs.rm(backup, { recursive: true, force: true });
      oldMoved = false;
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (oldMoved && !(await fileExists(dir))) {
      await fs.rename(backup, dir).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Replaces one Skill or hook directory transactionally. Replacements are serialized per target,
 * staged completely before the live directory is moved, and retain the previous live directory as
 * a backup until the staged rename succeeds. A later attempt self-heals an interrupted swap.
 */
export async function replaceSkillDirectory(
  dir: string,
  files: Iterable<[string, string | Uint8Array]>,
): Promise<void> {
  const snapshot = [...files];
  const previous = replacementTails.get(dir) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => performDirectoryReplacement(dir, snapshot));
  const tail = run.then(() => undefined, () => undefined);
  replacementTails.set(dir, tail);
  try {
    await run;
  } finally {
    if (replacementTails.get(dir) === tail) replacementTails.delete(dir);
  }
}

export async function removeSkill(
  root: string,
  projectId: string,
  agentId: string,
  name: string,
): Promise<void> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  assertValidId("skill_name", name);
  await fs.rm(path.join(skillsDir(root, projectId, agentId), name), {
    recursive: true,
    force: true,
  });
}

export interface InstalledSkill extends SkillMetadata {
  icon?: string;
}

export async function listInstalledSkills(
  root: string,
  projectId: string,
  agentId: string,
): Promise<InstalledSkill[]> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  const dir = skillsDir(root, projectId, agentId);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: InstalledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    let icon: string | undefined;
    try {
      icon = await fs.readFile(path.join(dir, entry.name, "icon.svg"), "utf8");
    } catch {
      // icon.svg is optional.
    }
    const parsed = parseSkillFrontmatter(raw);
    skills.push({
      ...(parsed ?? { description: "", version: "" }),
      name: entry.name,
      ...(icon !== undefined ? { icon } : {}),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function installPlugin(
  root: string,
  projectId: string,
  agentId: string,
  plugin: LibraryPlugin,
): Promise<void> {
  for (const skill of plugin.skills) await installSkill(root, projectId, agentId, skill);
  if (plugin.hooks) {
    await installHook(
      root,
      projectId,
      agentId,
      plugin.hooks.manifest,
      plugin.hooks.files,
      plugin.icon,
    );
  }
}

async function readHookManifest(dir: string): Promise<HookManifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "hooks.json"), "utf8")) as HookManifest;
  } catch {
    return null;
  }
}

function hookManifestText(manifest: HookManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function installHook(
  root: string,
  projectId: string,
  agentId: string,
  manifest: HookManifest,
  files: Record<string, string>,
  icon?: string,
): Promise<void> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  assertValidId("skill_name", manifest.name);
  for (const rel of Object.keys(files)) assertSafeSkillFile(rel);
  const dir = path.join(hooksDir(root, projectId, agentId), manifest.name);
  await replaceSkillDirectory(dir, [
    ["hooks.json", hookManifestText(manifest)],
    ...(icon !== undefined ? ([["icon.svg", icon]] as Array<[string, string]>) : []),
    ...Object.entries(files),
  ]);
}

export async function removeHook(
  root: string,
  projectId: string,
  agentId: string,
  name: string,
): Promise<void> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  assertValidId("skill_name", name);
  await fs.rm(path.join(hooksDir(root, projectId, agentId), name), {
    recursive: true,
    force: true,
  });
}

export interface InstalledHook extends HookManifest {
  dir: string;
  icon?: string;
}

export async function listInstalledHooks(
  root: string,
  projectId: string,
  agentId: string,
): Promise<InstalledHook[]> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  const base = hooksDir(root, projectId, agentId);
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const hooks: InstalledHook[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(base, entry.name);
    const manifest = await readHookManifest(dir);
    if (manifest === null) continue;
    let icon: string | undefined;
    try {
      icon = await fs.readFile(path.join(dir, "icon.svg"), "utf8");
    } catch {
      // No icon.svg.
    }
    hooks.push({ ...manifest, name: entry.name, dir, ...(icon !== undefined ? { icon } : {}) });
  }
  return hooks.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillMetadataSection(skills: SkillMetadata[]): string {
  return skills
    .map((s) => (s.description ? `- \`${s.name}\` — ${s.description}` : `- \`${s.name}\``))
    .join("\n");
}

export async function listScheduleNames(
  root: string,
  projectId: string,
  agentId: string,
): Promise<string[]> {
  assertValidId("project_id", projectId);
  assertValidId("agent_id", agentId);
  try {
    return (await fs.readdir(scheduleDir(root, projectId, agentId), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
      .map((entry) => entry.name.slice(0, -".toml".length))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function withShellLineFallback(
  assembled: string,
  template: string,
  sessionEnvironment?: SessionEnvironmentValues,
): string {
  if (!sessionEnvironment?.shell) return assembled;
  if (sessionEnvironment.shell === "bash") return assembled;
  if (template.includes(SHELL_PLACEHOLDER)) return assembled;
  if (/^- Shell: /m.test(assembled)) return assembled;
  const line = `- Shell: ${sessionEnvironment.shell}`;
  const heading = /^#+ Environment[ \t]*$/m.exec(assembled);
  if (heading) {
    const insertAt = heading.index + heading[0].length;
    return `${assembled.slice(0, insertAt)}\n${line}${assembled.slice(insertAt)}`;
  }
  return `${assembled}\n${line}`;
}

const SECTION_PLACEHOLDER_PATTERN = /\{\{(?:MEMORY|VAULT|SKILLS|SCHEDULES)\}\}/g;

export function assembleSystemPrompt(
  state: AgentState,
  sessionEnvironment?: SessionEnvironmentValues,
  vaultKeys?: string[],
  skillMetadata?: SkillMetadata[],
  memory?: SessionMemory | null,
  scheduleNames?: string[],
): string {
  const template = state.systemConfig.system_prompt;
  const inlineVaultKeys =
    state.systemConfig.vault?.enabled === false ? "" : vaultKeysList(vaultKeys ?? []);
  const inlineSkillMetadata =
    state.systemConfig.skills?.enabled === false ? "" : skillMetadataSection(skillMetadata ?? []);
  const sections: Record<string, string> = {
    [MEMORY_PLACEHOLDER]: memorySection(state.systemConfig.memory, memory),
    [VAULT_PLACEHOLDER]: vaultSection(state.systemConfig.vault, vaultKeys),
    [SKILLS_PLACEHOLDER]: skillsSection(state.systemConfig.skills, skillMetadata),
    [SCHEDULES_PLACEHOLDER]: schedulesSection(state.systemConfig.schedules, scheduleNames),
  };
  const assembled = template
    .split(AGENTS_MD_PLACEHOLDER)
    .join(state.agentsMd.trim())
    .split(VAULT_KEYS_PLACEHOLDER)
    .join(inlineVaultKeys)
    .split(SKILL_METADATA_PLACEHOLDER)
    .join(inlineSkillMetadata)
    .split(AGENT_ID_PLACEHOLDER)
    .join(sessionEnvironment?.agentId ?? state.agentId)
    .split(PROJECT_DIR_PLACEHOLDER)
    .join(sessionEnvironment?.projectDir ?? "")
    .split(SESSION_ID_PLACEHOLDER)
    .join(sessionEnvironment?.sessionId ?? "")
    .split(CWD_PLACEHOLDER)
    .join(sessionEnvironment?.cwd ?? "")
    .split(PROVIDER_PLACEHOLDER)
    .join(sessionEnvironment?.provider ?? "")
    .split(MODEL_ID_PLACEHOLDER)
    .join(sessionEnvironment?.modelId ?? "")
    .split(PLATFORM_PLACEHOLDER)
    .join(sessionEnvironment?.platform ?? "")
    .split(OS_VERSION_PLACEHOLDER)
    .join(sessionEnvironment?.osVersion ?? "")
    .split(SHELL_PLACEHOLDER)
    .join(sessionEnvironment?.shell ?? "")
    .split(DATE_PLACEHOLDER)
    .join(sessionEnvironment?.date ?? "")
    .replace(SECTION_PLACEHOLDER_PATTERN, (token) => sections[token] ?? token)
    .trim();
  return withShellLineFallback(assembled, template, sessionEnvironment);
}

export function selectBuiltinToolsForModel(
  tools: ToolDefinitionConfig[],
  modelVision: boolean,
): ToolDefinitionConfig[] {
  const kind = modelVision ? "vision" : "text-only";
  return tools.filter((t) => t.forModel === undefined || t.forModel === kind);
}

function applyCallDescriptionToggle(def: ToolDefinitionConfig): ToolDefinitionConfig {
  if (def.call_description !== false) return def;
  const params = def.parameters;
  if (params === undefined) return def;
  const properties = params["properties"];
  if (properties === null || typeof properties !== "object") return def;
  if (!("description" in (properties as Record<string, unknown>))) return def;
  const { description: _dropped, ...rest } = properties as Record<string, unknown>;
  const required = params["required"];
  const trimmed = Array.isArray(required)
    ? { required: required.filter((name) => name !== "description") }
    : {};
  return { ...def, parameters: { ...params, properties: rest, ...trimmed } };
}

export function buildToolConfig(state: AgentState): ToolConfig {
  const systemTools = state.systemConfig.tools;
  const builtin = systemTools?.builtin ?? defaultSystemConfig().tools?.builtin ?? [];
  return {
    customTools: builtin.map(applyCallDescriptionToggle),
    mcpServers: systemTools?.mcpServers ?? [],
    ...(systemTools?.toolExposure !== undefined ? { toolExposure: systemTools.toolExposure } : {}),
    ...(systemTools?.toolExposureThresholdTokens !== undefined
      ? { toolExposureThresholdTokens: systemTools.toolExposureThresholdTokens }
      : {}),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
