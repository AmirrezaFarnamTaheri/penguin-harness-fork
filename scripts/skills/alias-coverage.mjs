#!/usr/bin/env node
/**
 * Alias coverage for skill routing.
 *
 * A skill name is what a router matches against, and users do not type corpus
 * names — they type the topic (`typescript`), the abbreviation (`sklearn`) or
 * the other hyphenation (`next-js`). This script proposes aliases that cover
 * those forms, DERIVING them from the canonical names that exist rather than
 * hand-listing them.
 *
 * Every candidate passes four guards before it is written:
 *   1. it is a canonical lowercase-hyphen skill name,
 *   2. it is not already a canonical skill directory — an alias that shadows a
 *      real skill is a silent routing hazard,
 *   3. its target is a canonical skill, not a redirect stub, so the alias never
 *      chains through a redirect,
 *   4. exactly one canonical skill claims it — a short form two skills both
 *      match is the ambiguity an alias cannot repair.
 *
 * Usage:
 *   node scripts/skills/alias-coverage.mjs
 *   node scripts/skills/alias-coverage.mjs --write
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
  readRedirectTarget,
  readSkillRecord,
  stableStringify,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");

/**
 * Tech words commonly written both joined and hyphenated, with the hyphenation
 * point spelled out per word — a mechanical split produces non-words like
 * `graphq-l`. Both directions are generated, so `nextjs-app-router-patterns`
 * and `next-js-app-router-patterns` both resolve to whichever form shipped.
 */
const HYPHENATION_VARIANTS = [
  ["nextjs", "next-js"],
  ["nodejs", "node-js"],
  ["graphql", "graph-ql"],
  ["openai", "open-ai"],
  ["chatgpt", "chat-gpt"],
  ["websocket", "web-socket"],
  ["typescript", "type-script"],
  ["javascript", "java-script"],
  ["fullstack", "full-stack"],
];

/**
 * Abbreviations and common misspellings that cannot be derived from a name and
 * are therefore curated. Each entry is only applied when its target exists and
 * is the only claim on the alias.
 */
const CURATED_ALIASES = {
  sklearn: "scikit-learn",
  scikitlearn: "scikit-learn",
  "sci-kit-learn": "scikit-learn",
  postgres: "postgresql",
  "postgre-sql": "postgresql",
};

/**
 * Aliases that make a mis-named skill findable by what it actually does. These
 * are kept separate from the curated table above because they are not
 * abbreviations of the target's name — they describe the target's capability.
 * Renaming the skill itself is preferred, but is not worth it when other skills
 * reference the name by path.
 */
const DESCRIPTIVE_ALIASES = {
  // `remotion-best-practices` is a router over the Remotion skill family, not a
  // best-practices guide; `video-generator` and `remotion-upgrade` reference it
  // by name, so it is aliased rather than renamed.
  "remotion-router": "remotion-best-practices",
};

/** Suffixes whose bare topic form is the natural thing a user types. */
const SHORT_FORM_SUFFIXES = ["-dev", "-bilingual", "-expert"];

const canonical = new Set(await listSkillDirectories(DEFAULT_SKILL_ROOT));
const manifest = await loadAliases(DEFAULT_ALIASES_FILE);
const existingAliases = manifest.aliases;

// A redirect skill is a routing stub, not a destination: an alias pointing at
// one would chain (alias -> redirect -> canonical) when it could point straight
// at the canonical skill.
const redirectTargets = new Set();
for (const name of canonical) {
  const record = await readSkillRecord(DEFAULT_SKILL_ROOT, name);
  if (readRedirectTarget(record.metadata)) redirectTargets.add(name);
}

const accepted = {};
const rejected = [];
const claimants = new Map();

function noteRejected(alias, target, reason) {
  rejected.push({ alias, target, reason });
}

/**
 * Record one claim on an alias. Claims are resolved after all rules have run,
 * so an alias contested by two canonical skills is reported rather than
 * silently awarded to whichever rule happened to run first.
 */
function consider(alias, target) {
  if (!alias || !target || alias === target) return;
  if (!SKILL_NAME_PATTERN.test(alias) || alias.length > 64) {
    noteRejected(alias, target, "not a canonical skill name");
    return;
  }
  if (canonical.has(alias)) {
    noteRejected(alias, target, "shadows an existing canonical skill");
    return;
  }
  if (redirectTargets.has(target)) {
    noteRejected(alias, target, "target is a redirect stub, not a canonical skill");
    return;
  }
  if (!canonical.has(target)) {
    noteRejected(alias, target, "target is not a canonical skill");
    return;
  }
  const bucket = claimants.get(alias) ?? [];
  if (!bucket.includes(target)) bucket.push(target);
  claimants.set(alias, bucket);
}

// 1. Short forms: strip a kind suffix so the bare topic resolves.
for (const name of canonical) {
  for (const suffix of SHORT_FORM_SUFFIXES) {
    if (!name.endsWith(suffix) || name.length <= suffix.length) continue;
    consider(name.slice(0, -suffix.length), name);
  }
}

// 2. Joined / split hyphenation of tech words, both directions.
for (const name of canonical) {
  for (const [joined, split] of HYPHENATION_VARIANTS) {
    if (name.includes(joined)) consider(name.replaceAll(joined, split), name);
    else if (name.includes(split)) consider(name.replaceAll(split, joined), name);
  }
}

// 3. Curated abbreviations and misspellings.
for (const [alias, target] of Object.entries(CURATED_ALIASES)) {
  consider(alias, target);
}

// 4. Descriptive aliases for skills whose name does not say what they do.
for (const [alias, target] of Object.entries(DESCRIPTIVE_ALIASES)) {
  consider(alias, target);
}

// Resolve the claims: keep only the aliases exactly one canonical skill claims.
// An alias already in the manifest with the same target is covered, not a new
// proposal — counting it as pending would make this check non-idempotent, so it
// is reported as covered and left out of what gets written.
let alreadyCovered = 0;
for (const [alias, targets] of claimants) {
  if (targets.length !== 1) {
    noteRejected(
      alias,
      targets.join(" / "),
      `ambiguous: ${targets.length} canonical skills claim it`,
    );
    continue;
  }
  if (existingAliases[alias]) {
    if (existingAliases[alias] !== targets[0]) {
      noteRejected(alias, targets[0], "already aliased to a different skill");
      continue;
    }
    alreadyCovered++;
    continue;
  }
  accepted[alias] = targets[0];
}

const ordered = Object.fromEntries(Object.entries(accepted).sort(([a], [b]) => a.localeCompare(b)));

if (Object.keys(ordered).length === 0) {
  console.log(
    `No new alias coverage needed; ${Object.keys(existingAliases).length} aliases already cover the derived forms (${alreadyCovered} confirmed by the coverage rules).`,
  );
  if (rejected.length) {
    console.log(`${rejected.length} candidate(s) remain unresolvable:`);
    for (const item of rejected) console.log(`- ${item.alias} -> ${item.target}: ${item.reason}`);
  }
  process.exit(0);
}

if (!write) {
  console.error(`Alias coverage: ${Object.keys(ordered).length} new alias(es) proposed.`);
  console.error(`${alreadyCovered} derived form(s) already covered by an existing alias.`);
  for (const [alias, target] of Object.entries(ordered)) {
    console.error(`- ${alias} -> ${target}`);
  }
  if (rejected.length) {
    console.error(`\n${rejected.length} candidate(s) rejected:`);
    for (const item of rejected) console.error(`- ${item.alias} -> ${item.target}: ${item.reason}`);
  }
  process.exitCode = 1;
  process.exit();
}

const nextManifest = { ...manifest, aliases: { ...existingAliases, ...ordered } };
await fs.writeFile(DEFAULT_ALIASES_FILE, stableStringify(nextManifest));
execFileSync(
  process.execPath,
  [path.join(REPO_ROOT, "scripts", "skills", "sync-aliases.mjs"), "--write"],
  {
    cwd: REPO_ROOT,
    stdio: "inherit",
  },
);
console.log(`Added ${Object.keys(ordered).length} routing aliases:`);
for (const [alias, target] of Object.entries(ordered)) console.log(`- ${alias} -> ${target}`);
if (rejected.length) {
  console.log(`${rejected.length} candidate(s) rejected (kept out of the alias table):`);
  for (const item of rejected) console.log(`- ${item.alias} -> ${item.target}: ${item.reason}`);
}
