#!/usr/bin/env node
/**
 * Skill naming policy
 * ===================
 *
 * A skill name is a routing key first and a label second: `SkillRegistry` matches
 * a prompt against the name's tokens (see `scoreSkillRelevance` in
 * packages/core/src/agent/skill-engine.ts), so a name has to carry the words a
 * user would actually say. These rules decide what a corpus name must look like.
 *
 * Canonical form — lowercase, digits and single hyphens only, <= 64 chars
 * (`SKILL_NAME_PATTERN`), and the frontmatter `name` must equal the directory
 * name; `audit.mjs` fails the build on any mismatch.
 *
 * Naming shape, in precedence order — the first one that applies wins:
 *
 *   1. An external service is named for the service (`linear`, `github`,
 *      `slack`), never `codex-linear` or `slack-skill`. The service token is
 *      what a prompt contains.
 *   2. Verb-phrase skills put the verb first (`deploy-to-vercel`,
 *      `review-animations`, `run-skill-generator`) so the action leads the noun.
 *      `animations-review-animations` inverts this and is a consolidation target.
 *   3. A vendor/author prefix is dropped when the topic stands on its own
 *      (`minimax-shader-dev` -> `shader-dev`). `minimax-` / `codex-` /
 *      `davidondrej-` prefixes say where a skill came from, not what it does,
 *      and they cost a routing token while earning nothing.
 *   4. Kind suffixes are reserved for *how* the skill delivers, and are matched
 *      by the alias table rather than by the stem: `-automation` (drives a named
 *      SaaS service), `-bilingual` (English/Indonesian bilingual specialist),
 *      `-patterns` / `-best-practices` (reference guidance, not execution),
 *      `-runner` (execution), `-review` (inspection), `-dev` (a language or
 *      platform development guide).
 *
 * Renaming is a move, not a rename-and-forget: the directory is renamed, the
 * frontmatter `name` is rewritten, local path references inside the skill are
 * repointed, and the old name becomes an alias of the new one — so nothing that
 * used the old name stops resolving.
 *
 * Two policies drive automatic renaming:
 *
 *   --bilingual-experts    A `-expert` skill whose description declares English
 *                          and Indonesian coverage is really a bilingual
 *                          specialist; it becomes `-bilingual`, which is the
 *                          suffix the corpus reserves for that.
 *
 *   --core-disambiguation  EXPLICIT_RENAMES below: names that are actively
 *                          misleading — they promise a different capability from
 *                          the one they deliver, so a router scoring their tokens
 *                          sends a prompt to the wrong skill.
 */
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
  // `healthcheck` reads as an infrastructure probe; the skill actually logs water
  // and sleep to a JSON file.
  ["healthcheck", "water-sleep-tracker"],
  // `model-update` reads as an LLM/weights update; the skill actually updates
  // financial models with new earnings and macro data.
  ["model-update", "financial-model-update"],
  // In a corpus full of finance skills, `portfolio` reads as an investment
  // portfolio; the skill tracks an IP portfolio (registrations, renewals, fees).
  ["portfolio", "ip-portfolio"],
]);

function replaceFrontmatterName(raw, oldName, newName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw.replace(/^\uFEFF/, ""));
  if (!match) throw new Error(`${oldName}: missing frontmatter`);
  const yaml = match[1];
  const replaced = yaml.replace(
    new RegExp(
      `^name\\s*:\\s*["']?${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`,
      "m",
    ),
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
    if (!entry.isFile() || !/\.(?:md|txt|json|ya?ml|toml|mjs|cjs|js|ts|tsx|sh)$/i.test(entry.name))
      continue;
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
    /(?:\bPanduan\b|\bBahasa Indonesia\b|English and Indonesian|\/\s*Ahli\b)/i.test(
      metadata.description,
    )
  ) {
    target = `${name.slice(0, -"-expert".length)}-bilingual`;
    reason = "description declares English/Indonesian bilingual specialization";
  }

  if (!target || target === name) continue;
  if (!SKILL_NAME_PATTERN.test(target) || target.length > 64) {
    throw new Error(`${name}: proposed target '${target}' is not a valid skill name`);
  }
  if (existing.has(target)) {
    throw new Error(
      `${name}: proposed target '${target}' already exists; review this overlap manually`,
    );
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
execFileSync(
  process.execPath,
  [path.join(REPO_ROOT, "scripts", "skills", "sync-aliases.mjs"), "--write"],
  {
    cwd: REPO_ROOT,
    stdio: "inherit",
  },
);

console.log(`Renamed ${plan.length} skill(s):`);
for (const item of plan) console.log(`- ${item.oldName} -> ${item.newName}: ${item.reason}`);
