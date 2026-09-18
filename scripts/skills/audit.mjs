#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SKILL_ROOT,
  REPO_ROOT,
  SKILL_NAME_PATTERN,
  bodyFingerprint,
  listSkillDirectories,
  loadAliases,
  normalizeDescription,
  normalizedStem,
  readSkillRecord,
  readRedirectTarget,
  resolveAlias,
  stableStringify,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const valueArg = (prefix) =>
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`${prefix}=`))
    ?.slice(prefix.length + 1);
const check = args.has("--check");
const strictResources = args.has("--strict-resources");
const jsonOut = valueArg("--json");
const root = path.resolve(valueArg("--root") ?? DEFAULT_SKILL_ROOT);

const errors = [];
const warnings = [];
const addError = (code, message, skill) =>
  errors.push({ code, message, ...(skill ? { skill } : {}) });
const addWarning = (code, message, skill) =>
  warnings.push({ code, message, ...(skill ? { skill } : {}) });

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
  const entryPattern = /(?:"([a-z0-9-]+)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*:\s*"([a-z0-9-]+)"/g;
  for (const match of block.matchAll(entryPattern)) {
    const key = match[1] ?? match[2];
    if (key) entries[key] = match[3];
  }
  return entries;
}

const dirNames = await listSkillDirectories(root);
const canonicalNames = new Set(dirNames);
const records = [];
for (const dirName of dirNames) {
  if (!SKILL_NAME_PATTERN.test(dirName) || dirName.length > 64) {
    addError(
      "invalid-directory-name",
      `Directory '${dirName}' is not a canonical lowercase-hyphen skill name <= 64 chars.`,
      dirName,
    );
  }
  let record;
  try {
    record = await readSkillRecord(root, dirName);
  } catch (error) {
    addError(
      "invalid-frontmatter",
      error instanceof Error ? error.message : String(error),
      dirName,
    );
    continue;
  }
  records.push(record);
  if (record.entrypointType !== "file") {
    if (record.lowercaseEntrypointType === "file") {
      addError(
        "lowercase-entrypoint",
        `${dirName} has skill.md but requires canonical SKILL.md.`,
        dirName,
      );
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
      addError(
        "invalid-frontmatter-name",
        `Frontmatter name '${metadata.name}' is not canonical.`,
        dirName,
      );
    }
    if (metadata.name !== dirName) {
      addError(
        "name-directory-mismatch",
        `Frontmatter name '${metadata.name}' does not match directory '${dirName}'.`,
        dirName,
      );
    }
  }
  if (typeof metadata.description !== "string" || metadata.description.trim().length === 0) {
    addError("missing-description", `${dirName}/SKILL.md needs a non-empty description.`, dirName);
  }

  // Frontmatter alone is not a skill: the runtime hands the body to a model as
  // instructions. A body that is only comments, links or whitespace looks
  // installed but delivers nothing, which is worse than an missing entrypoint
  // because nothing else flags it.
  const redirectTarget = readRedirectTarget(metadata);
  if (!redirectTarget) {
    const instructions = record.body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/[#>*_|\-]/g, " ")
      .trim();
    if (instructions.length < 20) {
      addError(
        "no-instructions",
        `${dirName}/SKILL.md has frontmatter but no instruction body — only comments, links or whitespace.`,
        dirName,
      );
    }
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

const descriptionByName = new Map(records.map((record) => [record.dirName, record]));

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
    addError(
      "dangling-alias",
      `Alias '${alias}' resolves to missing skill '${resolved.target}'.`,
      alias,
    );
  }
  if (canonicalNames.has(alias)) {
    // A redirect skill keeps its directory AND its name is registered as an
    // alias of the canonical it points at. Exact-name lookup then resolves to
    // the redirect's forwarding stub, and alias resolution resolves to the
    // canonical — both end at the same skill, so the shadow is intentional and
    // is validated separately by the redirect-alias-mismatch check. Only a
    // shadow cast by a real, non-redirect skill is a silent routing hazard.
    const redirect = readRedirectTarget(descriptionByName.get(alias)?.metadata);
    if (redirect === resolved.target) continue;
    addWarning(
      "shadowed-alias",
      `Alias '${alias}' is also a canonical skill directory; exact-name lookup will shadow the alias.`,
      alias,
    );
  }
}

const runtimeFile = path.join(REPO_ROOT, "packages", "core", "src", "agent", "skill-engine.ts");
const runtimeSource = await fs.readFile(runtimeFile, "utf8");
const runtimeAliases = parseRuntimeAliases(runtimeSource);
if (runtimeAliases === null) {
  addError(
    "runtime-alias-table-unreadable",
    "Could not locate DEFAULT_SKILL_ALIASES in skill-engine.ts.",
  );
} else {
  const manifestJson = stableStringify(aliases);
  const runtimeJson = stableStringify(runtimeAliases);
  if (manifestJson !== runtimeJson) {
    const missingInRuntime = Object.keys(aliases).filter(
      (name) => runtimeAliases[name] !== aliases[name],
    );
    const extraInRuntime = Object.keys(runtimeAliases).filter(
      (name) => aliases[name] !== runtimeAliases[name],
    );
    addError(
      "alias-table-drift",
      `Runtime aliases and .agents/skills/aliases.json differ. Manifest-only/different: ${missingInRuntime.join(", ") || "none"}; runtime-only/different: ${extraInRuntime.join(", ") || "none"}.`,
    );
  }
}

const descriptions = new Map();
for (const record of records) {
  // A redirect skill is an intentional routing stub for a canonical skill; its
  // description deliberately echoes the canonical's, so it must not be reported
  // as an accidental description collision.
  if (readRedirectTarget(record.metadata)) continue;
  const description = normalizeDescription(record.metadata?.description);
  if (!description) continue;
  const bucket = descriptions.get(description) ?? [];
  bucket.push(record.dirName);
  descriptions.set(description, bucket);
}
for (const names of descriptions.values()) {
  if (names.length > 1) {
    addWarning(
      "duplicate-description",
      `Skills share the same normalized description: ${names.join(", ")}.`,
    );
  }
}

const fingerprints = new Map();
for (const record of records) {
  if (readRedirectTarget(record.metadata)) continue;
  const fingerprint = bodyFingerprint(record.body);
  if (!fingerprint) continue;
  const bucket = fingerprints.get(fingerprint) ?? [];
  bucket.push(record.dirName);
  fingerprints.set(fingerprint, bucket);
}
for (const names of fingerprints.values()) {
  if (names.length > 1) {
    addWarning(
      "exact-body-duplicate",
      `Skills carry byte-equivalent instruction bodies: ${names.join(", ")}. Consolidate into one canonical skill and redirect the rest.`,
    );
  }
}

// A stem family (e.g. `flink` + `flink-best-practices`) only signals real overlap
// when its members cannot be told apart: the same description, or a missing one.
// Distinguishing descriptions are the sanctioned way to keep both skills, so a
// family whose descriptions are all distinct is resolved rather than warned at.
const stemDescriptions = new Map();
for (const name of dirNames) {
  const description = normalizeDescription(descriptionByName.get(name)?.metadata?.description);
  const bucket = stemDescriptions.get(name) ?? [];
  if (description) bucket.push(description);
  stemDescriptions.set(name, bucket);
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
  if (names.length < 2) continue;
  const familyDescriptions = names.flatMap((name) => stemDescriptions.get(name) ?? []);
  const allDistinct = new Set(familyDescriptions).size === familyDescriptions.length;
  if (allDistinct) continue;
  addWarning(
    "overlap-family",
    `Potential overlap family '${stem}': ${[...new Set(names)].join(", ")}. Members share a description; consolidate or give each a distinguishing description.`,
  );
}

for (const record of records) {
  const redirect = readRedirectTarget(record.metadata);
  if (!redirect) continue;
  if (!SKILL_NAME_PATTERN.test(redirect) || redirect.length > 64) {
    addError(
      "invalid-redirect-target",
      `Redirect target '${redirect}' is not a canonical skill name.`,
      record.dirName,
    );
    continue;
  }
  if (redirect === record.dirName) {
    addError("self-redirect", `Skill '${record.dirName}' redirects to itself.`, record.dirName);
    continue;
  }
  if (readRedirectTarget(descriptionByName.get(redirect)?.metadata)) {
    addError(
      "redirect-chain",
      `Redirect '${record.dirName}' targets another redirect '${redirect}' instead of a canonical skill.`,
      record.dirName,
    );
    continue;
  }
  if (!canonicalNames.has(redirect)) {
    addError(
      "dangling-redirect",
      `Redirect '${record.dirName}' targets missing skill '${redirect}'.`,
      record.dirName,
    );
    continue;
  }
  const manifestTarget = aliases[record.dirName];
  if (manifestTarget !== redirect) {
    addWarning(
      "redirect-alias-mismatch",
      `Redirect '${record.dirName}' declares target '${redirect}' but the alias manifest maps it to '${manifestTarget ?? "nothing"}'. Run sync-aliases.mjs --write.`,
      record.dirName,
    );
  }
}

const redirectCount = records.filter((record) => readRedirectTarget(record.metadata)).length;

const report = {
  generatedAt: new Date().toISOString(),
  root: path.relative(REPO_ROOT, root) || ".",
  summary: {
    skills: dirNames.length,
    aliases: Object.keys(aliases).length,
    redirects: redirectCount,
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

console.log(
  `Skills: ${report.summary.skills}; aliases: ${report.summary.aliases}; errors: ${errors.length}; warnings: ${warnings.length}`,
);
for (const item of errors)
  console.error(`ERROR [${item.code}]${item.skill ? ` ${item.skill}:` : ""} ${item.message}`);
for (const item of warnings)
  console.warn(`WARN  [${item.code}]${item.skill ? ` ${item.skill}:` : ""} ${item.message}`);

if (check && errors.length > 0) process.exitCode = 1;
