#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ALIASES_FILE,
  REPO_ROOT,
  listSkillDirectories,
  loadAliases,
  resolveAlias,
  stableStringify,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const pruneDangling = args.has("--prune-dangling");
const aliasesFile = DEFAULT_ALIASES_FILE;
const runtimeFile = path.join(REPO_ROOT, "packages", "core", "src", "agent", "skill-engine.ts");

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ""));
  if (!match) return version ?? "1.0.0";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function formatPropertyKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function runtimeBlock(aliases) {
  const lines = Object.entries(aliases).map(
    ([alias, target]) => `  ${formatPropertyKey(alias)}: ${JSON.stringify(target)},`,
  );
  return `export const DEFAULT_SKILL_ALIASES: Record<string, string> = {\n${lines.join("\n")}\n};`;
}

const manifest = await loadAliases(aliasesFile);
const originalAliases = manifest.aliases;
const skills = new Set(await listSkillDirectories());
const aliases = {};
const removed = [];

for (const [alias, target] of Object.entries(originalAliases)) {
  const resolved = resolveAlias(alias, originalAliases);
  const dangling = !resolved.cycle && !skills.has(resolved.target);
  if (dangling && pruneDangling) {
    removed.push({ alias, target: resolved.target });
    continue;
  }
  aliases[alias] = target;
}

const nextManifest = {
  ...manifest,
  ...(removed.length > 0 ? { version: bumpPatch(manifest.version) } : {}),
  aliases,
};
const currentManifestText = await fs.readFile(aliasesFile, "utf8");
const nextManifestText = stableStringify(nextManifest);

const currentRuntime = await fs.readFile(runtimeFile, "utf8");
const blockPattern = /export const DEFAULT_SKILL_ALIASES: Record<string, string> = \{[\s\S]*?\n\};/;
if (!blockPattern.test(currentRuntime))
  throw new Error(`Could not locate DEFAULT_SKILL_ALIASES in ${runtimeFile}`);
const nextRuntime = currentRuntime.replace(blockPattern, runtimeBlock(aliases));

const changedManifest = currentManifestText !== nextManifestText;
const changedRuntime = currentRuntime !== nextRuntime;
if (!changedManifest && !changedRuntime) {
  console.log("Skill aliases are synchronized.");
  process.exit(0);
}

if (!write) {
  if (removed.length > 0) {
    for (const item of removed) console.error(`Dangling alias ${item.alias} -> ${item.target}`);
  }
  if (changedRuntime)
    console.error("Runtime DEFAULT_SKILL_ALIASES differs from the declarative alias manifest.");
  process.exitCode = 1;
} else {
  if (changedManifest) await fs.writeFile(aliasesFile, nextManifestText);
  if (changedRuntime) await fs.writeFile(runtimeFile, nextRuntime);
  for (const item of removed) console.log(`Removed dangling alias ${item.alias} -> ${item.target}`);
  console.log(`Synchronized ${Object.keys(aliases).length} aliases.`);
}
