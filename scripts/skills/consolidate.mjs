#!/usr/bin/env node
/**
 * Skill consolidation.
 *
 * Merges a superseded skill into a canonical one WITHOUT deleting anything:
 * the superseded directory keeps its name, its resources and a verbatim copy of
 * its original SKILL.md, but its SKILL.md becomes a redirect that points at the
 * canonical skill, and the superseded name is registered as an alias of the
 * canonical one. Reversing a consolidation is a file rename plus an alias entry.
 *
 * Modes (each asserts a different evidence level before anything is written):
 *   exact     — the two bodies are byte-equivalent after normalization.
 *   contained — >= 90% of the superseded body's non-empty lines appear in the
 *               canonical body, so the canonical is a superset.
 *   subsumed  — no containment is asserted; used when the canonical is the
 *               strictly richer authoritative copy of the same upstream
 *               capability and the superseded one is an older/thinner port.
 *               Requires --force.
 *
 * Usage:
 *   node scripts/skills/consolidate.mjs --plan=artifacts/skill-consolidations.json
 *   node scripts/skills/consolidate.mjs --plan=... --write
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_ALIASES_FILE,
  DEFAULT_SKILL_ROOT,
  REPO_ROOT,
  SKILL_NAME_PATTERN,
  bodyFingerprint,
  listSkillDirectories,
  loadAliases,
  parseFrontmatter,
  readSkillRecord,
  readRedirectTarget,
  stableStringify,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const valueArg = (prefix) =>
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`${prefix}=`))
    ?.slice(prefix.length + 1);
const write = args.has("--write");
const force = args.has("--force");
const planFile = valueArg("--plan");
const root = DEFAULT_SKILL_ROOT;

if (!planFile) {
  console.error("Usage: consolidate.mjs --plan=<consolidations.json> [--write] [--force]");
  process.exit(2);
}

const CONTAINED_THRESHOLD = 0.9;

function bodyOf(raw) {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

async function readRaw(name) {
  return fs.readFile(path.join(root, name, "SKILL.md"), "utf8");
}

const plan = JSON.parse(await fs.readFile(path.resolve(planFile), "utf8"));
if (!Array.isArray(plan.consolidations) || plan.consolidations.length === 0) {
  console.error(`${planFile}: no "consolidations" array`);
  process.exit(2);
}

const existing = new Set(await listSkillDirectories(root));
const manifest = await loadAliases(DEFAULT_ALIASES_FILE);
const aliases = { ...manifest.aliases };
const steps = [];

for (const item of plan.consolidations) {
  const { canonical, superseded, mode, rationale } = item;
  for (const field of ["canonical", "superseded", "mode", "rationale"]) {
    if (typeof item[field] !== "string" || item[field].length === 0) {
      throw new Error(`Invalid consolidation entry: missing ${field} — ${JSON.stringify(item)}`);
    }
  }
  if (!["exact", "contained", "subsumed"].includes(mode)) {
    throw new Error(`${superseded}: unknown mode '${mode}'`);
  }
  if (!existing.has(canonical))
    throw new Error(`${superseded}: canonical '${canonical}' does not exist`);
  if (!existing.has(superseded)) throw new Error(`${superseded}: superseded skill does not exist`);
  if (canonical === superseded)
    throw new Error(`cannot consolidate a skill into itself: ${canonical}`);

  const canonicalRaw = await readRaw(canonical);
  const supersededRaw = await readRaw(superseded);
  const canonicalMeta = parseFrontmatter(canonicalRaw, `${canonical}/SKILL.md`).metadata;
  const supersededMeta = parseFrontmatter(supersededRaw, `${superseded}/SKILL.md`).metadata;
  if (readRedirectTarget(canonicalMeta)) throw new Error(`${canonical} is itself a redirect`);
  if (readRedirectTarget(supersededMeta)) throw new Error(`${superseded} is already a redirect`);

  const canonicalBody = bodyOf(canonicalRaw);
  const supersededBody = bodyOf(supersededRaw);
  const evidence = { mode, rationale, canonicalBytes: canonicalRaw.length };

  if (mode === "exact") {
    if (bodyFingerprint(canonicalBody) !== bodyFingerprint(supersededBody)) {
      throw new Error(`${superseded}: mode 'exact' but bodies are not equivalent`);
    }
    evidence.equivalence = "byte-equivalent bodies";
  } else if (mode === "contained") {
    const canonicalLines = new Set(canonicalBody.split(/\r?\n/).filter((line) => line.trim()));
    const supersededLines = supersededBody.split(/\r?\n/).filter((line) => line.trim());
    const kept = supersededLines.filter((line) => canonicalLines.has(line)).length;
    evidence.coverage = kept / supersededLines.length;
    if (evidence.coverage < CONTAINED_THRESHOLD) {
      throw new Error(
        `${superseded}: mode 'contained' but only ${(evidence.coverage * 100).toFixed(1)}% of its body lines appear in ${canonical} (threshold ${CONTAINED_THRESHOLD * 100}%)`,
      );
    }
  } else if (mode === "subsumed" && !force) {
    throw new Error(
      `${superseded}: mode 'subsumed' asserts no containment; re-run with --force once the canonical is confirmed to be the authoritative copy`,
    );
  }

  const aliasTarget = aliases[superseded];
  if (aliasTarget && aliasTarget !== canonical) {
    throw new Error(
      `${superseded}: alias manifest already maps it to '${aliasTarget}', not '${canonical}'`,
    );
  }
  steps.push({ canonical, superseded, mode, rationale, evidence, canonicalMeta });
}

if (!write) {
  console.error(`Consolidation plan: ${steps.length} superseded skill(s) would be redirected.`);
  for (const step of steps) {
    const detail =
      step.mode === "exact"
        ? step.evidence.equivalence
        : step.mode === "contained"
          ? `${(step.evidence.coverage * 100).toFixed(1)}% of body lines contained`
          : "canonical is the authoritative richer copy (no containment asserted)";
    console.error(`- ${step.superseded} -> ${step.canonical} [${step.mode}] ${detail}`);
    console.error(`    ${step.rationale}`);
  }
  process.exitCode = 1;
  process.exit();
}

const archiveName = "SKILL.superseded.md";
for (const step of steps) {
  const dir = path.join(root, step.superseded);
  const original = await readRaw(step.superseded);
  const canonicalDescription = String(step.canonicalMeta.description ?? "").trim();
  // A description unique to this redirect: it echoes the canonical's routing
  // vocabulary (so the name still matches natural-language lookups) but is
  // never byte-equal to the canonical's own description.
  const redirectDescription = `Superseded by ${step.canonical}: ${canonicalDescription}`;
  const relation =
    step.mode === "exact"
      ? "byte-equivalent instructions"
      : step.mode === "contained"
        ? `instructions fully covered (${(step.evidence.coverage * 100).toFixed(1)}% line-identical)`
        : "an older, thinner port of the same upstream capability";

  await fs.writeFile(path.join(dir, archiveName), original);
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${step.superseded}`,
      `description: ${JSON.stringify(redirectDescription)}`,
      `redirect: ${step.canonical}`,
      "---",
      "",
      `# Superseded by \`${step.canonical}\``,
      "",
      `This skill was a redundant copy of [\`${step.canonical}\`](.agents/skills/${step.canonical}/SKILL.md)`,
      `— ${relation}. It is kept in the corpus only so that its name still resolves, and its`,
      `original instructions are preserved verbatim in \`${archiveName}\`.`,
      "",
      `Load [\`${step.canonical}\`](.agents/skills/${step.canonical}/SKILL.md) instead.`,
      "",
    ].join("\n"),
  );
  aliases[step.superseded] = step.canonical;
}

const nextManifest = { ...manifest, aliases };
await fs.writeFile(DEFAULT_ALIASES_FILE, stableStringify(nextManifest));
execFileSync(
  process.execPath,
  [path.join(REPO_ROOT, "scripts", "skills", "sync-aliases.mjs"), "--write"],
  {
    cwd: REPO_ROOT,
    stdio: "inherit",
  },
);

console.log(`Consolidated ${steps.length} skill(s):`);
for (const step of steps) {
  console.log(`- ${step.superseded} -> ${step.canonical} [${step.mode}]: ${step.rationale}`);
}
