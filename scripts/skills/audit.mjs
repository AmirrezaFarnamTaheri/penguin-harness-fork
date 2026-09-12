#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SKILL_ROOT,
  REPO_ROOT,
  SKILL_NAME_PATTERN,
  listSkillDirectories,
  loadAliases,
  normalizeDescription,
  normalizedStem,
  readSkillRecord,
  resolveAlias,
  stableStringify,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const valueArg = (prefix) => process.argv.slice(2).find((arg) => arg.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
const check = args.has("--check");
const strictResources = args.has("--strict-resources");
const jsonOut = valueArg("--json");
const root = path.resolve(valueArg("--root") ?? DEFAULT_SKILL_ROOT);

const errors = [];
const warnings = [];
const addError = (code, message, skill) => errors.push({ code, message, ...(skill ? { skill } : {}) });
const addWarning = (code, message, skill) => warnings.push({ code, message, ...(skill ? { skill } : {}) });

async function existsAsFileOrDir(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() || stat.isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function parseRuntimeAliases(source) {
  const block = /export const DEFAULT_SKILL_ALIASES:[^=]+\=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
  if (!block) return null;
  const entries = {};
  for (const match of block.matchAll(/"([a-z0-9-]+)"\s*:\s*"([a-z0-9-]+)"/g)) {
    entries[match[1]] = match[2];
  }
  return entries;
}

const dirNames = await listSkillDirectories(root);
const canonicalNames = new Set(dirNames);
const records = [];
for (const dirName of dirNames) {
  if (!SKILL_NAME_PATTERN.test(dirName) || dirName.length > 64) {
    addError("invalid-directory-name", `Directory '${dirName}' is not a canonical lowercase-hyphen skill name <= 64 chars.`, dirName);
  }
  let record;
  try {
    record = await readSkillRecord(root, dirName);
  } catch (error) {
    addError("invalid-frontmatter", error instanceof Error ? error.message : String(error), dirName);
    continue;
  }
  records.push(record);
  if (record.entrypointType !== "file") {
    if (record.lowercaseEntrypointType === "file") {
      addError("lowercase-entrypoint", `${dirName} has skill.md but requires canonical SKILL.md.`, dirName);
    } else {
      addError("missing-entrypoint", `${dirName} has no canonical SKILL.md.`, dirName);
    }
    continue;
  }

  const metadata = record.metadata ?? {};
  if (typeof metadata.name !== "string" || metadata.name.length === 0) {
    addError("missing-name", `${dirName}/SKILL.md has no non-empty string name.`, dirName);
  } else {
    if (!SKILL_NAME_PATTERN.test(metadata.name) || metadata.name.length > 64) {
      addError("invalid-frontmatter-name", `Frontmatter name '${metadata.name}' is not canonical.`, dirName);
    }
    if (metadata.name !== dirName) {
      addError("name-directory-mismatch", `Frontmatter name '${metadata.name}' does not match directory '${dirName}'.`, dirName);
    }
  }
  if (typeof metadata.description !== "string" || metadata.description.trim().length === 0) {
    addError("missing-description", `${dirName}/SKILL.md needs a non-empty description.`, dirName);
  }

  for (const rel of record.references) {
    if (rel.includes("..") || path.isAbsolute(rel)) {
      addError("unsafe-relative-reference", `Unsafe relative reference '${rel}'.`, dirName);
      continue;
    }
    if (!(await existsAsFileOrDir(path.join(record.dir, rel)))) {
      const message = `Referenced local resource '${rel}' does not exist in ${dirName}.`;
      if (strictResources) addError("missing-local-resource", message, dirName);
      else addWarning("missing-local-resource", message, dirName);
    }
  }
}

const { aliases } = await loadAliases();
for (const [alias, target] of Object.entries(aliases)) {
  if (!SKILL_NAME_PATTERN.test(alias) || alias.length > 64) {
    addError("invalid-alias-name", `Alias '${alias}' is not a canonical skill name.`, alias);
  }
  if (!SKILL_NAME_PATTERN.test(target) || target.length > 64) {
    addError("invalid-alias-target", `Alias '${alias}' targets invalid name '${target}'.`, alias);
  }
  const resolved = resolveAlias(alias, aliases);
  if (resolved.cycle) {
    addError("alias-cycle", `Alias cycle: ${resolved.cycle.join(" -> ")}.`, alias);
    continue;
  }
  if (!canonicalNames.has(resolved.target)) {
    addError("dangling-alias", `Alias '${alias}' resolves to missing skill '${resolved.target}'.`, alias);
  }
  if (canonicalNames.has(alias)) {
    addWarning("shadowed-alias", `Alias '${alias}' is also a canonical skill directory; exact-name lookup will shadow the alias.`, alias);
  }
}

const runtimeFile = path.join(REPO_ROOT, "packages", "core", "src", "agent", "skill-engine.ts");
const runtimeSource = await fs.readFile(runtimeFile, "utf8");
const runtimeAliases = parseRuntimeAliases(runtimeSource);
if (runtimeAliases === null) {
  addError("runtime-alias-table-unreadable", "Could not locate DEFAULT_SKILL_ALIASES in skill-engine.ts.");
} else {
  const manifestJson = stableStringify(aliases);
  const runtimeJson = stableStringify(runtimeAliases);
  if (manifestJson !== runtimeJson) {
    const missingInRuntime = Object.keys(aliases).filter((name) => runtimeAliases[name] !== aliases[name]);
    const extraInRuntime = Object.keys(runtimeAliases).filter((name) => aliases[name] !== runtimeAliases[name]);
    addError(
      "alias-table-drift",
      `Runtime aliases and .agents/skills/aliases.json differ. Manifest-only/different: ${missingInRuntime.join(", ") || "none"}; runtime-only/different: ${extraInRuntime.join(", ") || "none"}.`,
    );
  }
}

const descriptions = new Map();
for (const record of records) {
  const description = normalizeDescription(record.metadata?.description);
  if (!description) continue;
  const bucket = descriptions.get(description) ?? [];
  bucket.push(record.dirName);
  descriptions.set(description, bucket);
}
for (const names of descriptions.values()) {
  if (names.length > 1) {
    addWarning("duplicate-description", `Skills share the same normalized description: ${names.join(", ")}.`);
  }
}

const stems = new Map();
for (const name of dirNames) {
  const stem = normalizedStem(name);
  if (stem === name) continue;
  const bucket = stems.get(stem) ?? [];
  bucket.push(name);
  stems.set(stem, bucket);
}
for (const [stem, names] of stems) {
  if (canonicalNames.has(stem)) names.unshift(stem);
  if (names.length > 1) {
    addWarning("overlap-family", `Potential overlap family '${stem}': ${[...new Set(names)].join(", ")}.`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  root: path.relative(REPO_ROOT, root) || ".",
  summary: {
    skills: dirNames.length,
    aliases: Object.keys(aliases).length,
    errors: errors.length,
    warnings: warnings.length,
  },
  errors,
  warnings,
};

if (jsonOut) {
  const out = path.resolve(jsonOut);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, stableStringify(report));
}

console.log(`Skills: ${report.summary.skills}; aliases: ${report.summary.aliases}; errors: ${errors.length}; warnings: ${warnings.length}`);
for (const item of errors) console.error(`ERROR [${item.code}]${item.skill ? ` ${item.skill}:` : ""} ${item.message}`);
for (const item of warnings) console.warn(`WARN  [${item.code}]${item.skill ? ` ${item.skill}:` : ""} ${item.message}`);

if (check && errors.length > 0) process.exitCode = 1;
