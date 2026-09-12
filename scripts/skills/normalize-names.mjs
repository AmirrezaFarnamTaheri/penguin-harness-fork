#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_ALIASES_FILE,
  DEFAULT_SKILL_ROOT,
  REPO_ROOT,
  SKILL_NAME_PATTERN,
  listSkillDirectories,
  loadAliases,
  parseFrontmatter,
  stableStringify,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const normalizeBilingualExperts = args.has("--bilingual-experts");
const normalizeCoreAmbiguity = args.has("--core-disambiguation");
const root = DEFAULT_SKILL_ROOT;

if (!normalizeBilingualExperts && !normalizeCoreAmbiguity) {
  console.error("Choose at least one naming policy: --bilingual-experts or --core-disambiguation");
  process.exit(2);
}

const EXPLICIT_RENAMES = new Map([
  ["browser", "chrome-cdp-browser-control"],
  ["browsing", "use-browser-mcp-control"],
  ["snowflake-expert", "snowflake-platform-engineering"],
]);

function replaceFrontmatterName(raw, oldName, newName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw.replace(/^\uFEFF/, ""));
  if (!match) throw new Error(`${oldName}: missing frontmatter`);
  const yaml = match[1];
  const replaced = yaml.replace(
    new RegExp(`^name\\s*:\\s*["']?${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`, "m"),
    `name: ${newName}`,
  );
  if (replaced === yaml) throw new Error(`${oldName}: could not replace frontmatter name`);
  return raw.replace(match[1], replaced);
}

async function rewriteSkillLocalPaths(dir, oldName, newName) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteSkillLocalPaths(full, oldName, newName);
      continue;
    }
    if (!entry.isFile() || !/\.(?:md|txt|json|ya?ml|toml|mjs|cjs|js|ts|tsx|sh)$/i.test(entry.name)) continue;
    let content;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const next = content
      .replaceAll(`.agents/skills/${oldName}/`, `.agents/skills/${newName}/`)
      .replaceAll(`/skills/${oldName}/`, `/skills/${newName}/`)
      .replaceAll(`skills/${oldName}/`, `skills/${newName}/`);
    if (next !== content) await fs.writeFile(full, next);
  }
}

const names = await listSkillDirectories(root);
const existing = new Set(names);
const plan = [];

for (const name of names) {
  const raw = await fs.readFile(path.join(root, name, "SKILL.md"), "utf8");
  let metadata;
  try {
    metadata = parseFrontmatter(raw, `${name}/SKILL.md`).metadata;
  } catch {
    continue;
  }
  let target;
  let reason;

  if (normalizeCoreAmbiguity && EXPLICIT_RENAMES.has(name)) {
    target = EXPLICIT_RENAMES.get(name);
    reason = "ambiguous or misleading canonical name";
  } else if (
    normalizeBilingualExperts &&
    name.endsWith("-expert") &&
    typeof metadata.description === "string" &&
    /(?:\bPanduan\b|\bBahasa Indonesia\b|English and Indonesian|\/\s*Ahli\b)/i.test(metadata.description)
  ) {
    target = `${name.slice(0, -"-expert".length)}-bilingual`;
    reason = "description declares English/Indonesian bilingual specialization";
  }

  if (!target || target === name) continue;
  if (!SKILL_NAME_PATTERN.test(target) || target.length > 64) {
    throw new Error(`${name}: proposed target '${target}' is not a valid skill name`);
  }
  if (existing.has(target)) {
    throw new Error(`${name}: proposed target '${target}' already exists; review this overlap manually`);
  }
  existing.delete(name);
  existing.add(target);
  plan.push({ oldName: name, newName: target, reason });
}

if (plan.length === 0) {
  console.log("Skill naming policies are normalized.");
  process.exit(0);
}

if (!write) {
  console.error(`Skill naming normalization required for ${plan.length} skill(s):`);
  for (const item of plan) console.error(`- ${item.oldName} -> ${item.newName}: ${item.reason}`);
  process.exitCode = 1;
  process.exit();
}

const manifest = await loadAliases(DEFAULT_ALIASES_FILE);
const aliases = { ...manifest.aliases };
for (const item of plan) {
  const oldDir = path.join(root, item.oldName);
  const newDir = path.join(root, item.newName);
  await fs.rename(oldDir, newDir);
  const skillFile = path.join(newDir, "SKILL.md");
  const raw = await fs.readFile(skillFile, "utf8");
  await fs.writeFile(skillFile, replaceFrontmatterName(raw, item.oldName, item.newName));
  await rewriteSkillLocalPaths(newDir, item.oldName, item.newName);

  for (const [alias, target] of Object.entries(aliases)) {
    if (target === item.oldName) aliases[alias] = item.newName;
  }
  aliases[item.oldName] = item.newName;
}

const nextManifest = {
  ...manifest,
  version: manifest.version,
  aliases,
};
await fs.writeFile(DEFAULT_ALIASES_FILE, stableStringify(nextManifest));
execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts", "skills", "sync-aliases.mjs"), "--write"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

console.log(`Renamed ${plan.length} skill(s):`);
for (const item of plan) console.log(`- ${item.oldName} -> ${item.newName}: ${item.reason}`);
