#!/usr/bin/env node
/**
 * Skill patch and supersession ledger (G4).
 *
 * Two ambiguous-looking artifact families live in `.agents/skills`:
 *
 *   1. `local.patch` files — records of localizations applied to an upstream skill. A patch that
 *      is *already applied* (a stale record) and a patch that is *still pending* look identical
 *      from the filename, and nothing in the repository says which is which.
 *   2. `SKILL.superseded.md` sidecars — the verbatim original of a skill whose SKILL.md became a
 *      redirect into its canonical replacement. "Superseded" is only meaningful if the redirect
 *      actually resolves, once and to a skill that exists.
 *
 * This script turns both into one explicit, machine-checked disposition per artifact:
 *
 *   node scripts/skills/patch-ledger.mjs               # human-readable table + summary
 *   node scripts/skills/patch-ledger.mjs --json        # same dispositions, machine-readable
 *   node scripts/skills/patch-ledger.mjs --check       # exit non-zero on any ambiguous artifact
 *
 * A patch is classified by dry-running it, never by guessing:
 *   applied    — it reverses cleanly, so its content is already in the tree (a stale record)
 *   pending    — it applies cleanly forward, so it is a live patch against this base
 *   unresolved — neither; the artifact no longer describes this tree and needs a human decision
 *
 * Usage is read-only: the ledger never applies, reverses or deletes anything. Removals are a
 * separate, human-reviewed step (see docs/audits/skill-patch-ledger-2026-10-02.md).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SKILL_ROOT = path.join(REPO_ROOT, ".agents", "skills");
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const check = args.has("--check");

/** Every `local.patch` in the tree, excluding dependencies and Git internals. */
async function findPatches(dir, found = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await findPatches(full, found);
    else if (entry.isFile() && entry.name === "local.patch") found.push(full);
  }
  return found;
}

/** Target files named by a unified diff's `--- a/...` headers. */
function patchTargets(text) {
  const targets = new Set();
  for (const line of text.split("\n")) {
    const match = /^--- a\/(.+?)(?:\t.*)?$/.exec(line);
    if (match?.[1]) targets.add(match[1]);
  }
  return [...targets].sort();
}

/**
 * Runs `patch --dry-run` for this patch and reports which direction describes the tree. The
 * skill directory is the working directory because the recorded prefixes are relative to it
 * (`a/<skill>/...`), and `-p2` strips those two leading components.
 */
function dryRun(patchFile, reverse) {
  try {
    execFileSync("patch", ["--dry-run", ...(reverse ? ["-R"] : []), "-p2", "-i", patchFile], {
      cwd: path.dirname(patchFile),
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/** Classifies one patch by dry-running it in both directions. */
function classifyPatch(patchFile, text) {
  // A patch that reverses but does not apply forward is already in the tree. Checking reverse
  // first keeps the common (stale-record) case off the slow path when both would succeed.
  if (dryRun(patchFile, true) && !dryRun(patchFile, false)) return "applied";
  if (dryRun(patchFile, false)) return "pending";
  if (dryRun(patchFile, true)) return "applied";
  return "unresolved";
}

/** Tracked files that mention a path, excluding the file's own skill directory. */
function externalReferences(relPath, skillDir) {
  let listing = "";
  try {
    listing = execFileSync("git", ["grep", "-l", "-F", relPath, "--", "."], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch {
    // git grep exits 1 when there is no match at all.
    return [];
  }
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => file !== relPath && !file.startsWith(`${skillDir}/`));
}

async function patchLedger() {
  const patches = (await findPatches(SKILL_ROOT)).sort();
  const rows = [];
  for (const patchFile of patches) {
    const rel = path.relative(REPO_ROOT, patchFile);
    const skillDir = path.relative(REPO_ROOT, path.dirname(patchFile));
    const skill = path.basename(path.dirname(patchFile));
    const text = await fs.readFile(patchFile, "utf8");
    const state = classifyPatch(patchFile, text);
    const references = externalReferences(rel, skillDir);
    rows.push({
      skill,
      path: rel,
      state,
      targets: patchTargets(text),
      references,
      // The decision the ledger states for every artifact, mechanically derived:
      //   applied + only the license/skill-doc surfaces -> retain as a stale record
      //   pending                                       -> retain as a live patch (it applies here)
      //   unresolved                                    -> retain and escalate; never silently dropped
      decision:
        state === "pending"
          ? "retain: live patch, applies to this base"
          : state === "applied"
            ? "retain: stale record, already applied"
            : "escalate: no longer describes this base",
    });
  }
  return rows;
}

/** The consolidation plan is the authority for deliberate supersession. */
async function loadConsolidations() {
  const planFile = path.join(REPO_ROOT, "artifacts", "skill-consolidations.json");
  try {
    return JSON.parse(await fs.readFile(planFile, "utf8"));
  } catch {
    return { consolidations: [] };
  }
}

async function listSkillDirs() {
  const entries = await fs.readdir(SKILL_ROOT, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function supersessionLedger() {
  const dirs = new Set(await listSkillDirs());
  const { consolidations } = await loadConsolidations();
  const aliasesFile = path.join(SKILL_ROOT, "aliases.json");
  const aliases = (await fs.readFile(aliasesFile, "utf8").catch(() => "{}")).trim();
  const aliasText = aliases;
  const rows = [];
  for (const dir of [...dirs].sort()) {
    const sidecar = path.join(SKILL_ROOT, dir, "SKILL.superseded.md");
    const sidecarExists = await fs
      .access(sidecar)
      .then(() => true)
      .catch(() => false);
    if (!sidecarExists) continue;
    const plan = consolidations.find((item) => item.superseded === dir);
    const canonical = plan?.canonical ?? null;
    const skillDoc = await fs.readFile(path.join(SKILL_ROOT, dir, "SKILL.md"), "utf8");
    const redirect = /^redirect:\s*(.+)$/m.exec(skillDoc)?.[1]?.trim() ?? null;
    const canonicalExists = canonical !== null ? dirs.has(canonical) : false;
    const aliasRegisters =
      canonical !== null && new RegExp(`"${dir}"\\s*:\\s*"${canonical}"`).test(aliasText);
    const row = {
      skill: dir,
      sidecar: path.relative(REPO_ROOT, sidecar),
      canonical,
      redirect,
      canonicalExists,
      aliasRegisters,
      // Deliberate supersession is functional only when the redirect names the canonical skill,
      // that skill exists, and the alias table sends the old name there.
      decision:
        canonical === null
          ? "escalate: sidecar with no consolidation entry"
          : canonicalExists && redirect === canonical && aliasRegisters
            ? "retain: deliberate supersession resolves once"
            : "escalate: redirect/alias do not resolve",
    };
    rows.push(row);
  }
  return rows;
}

const patches = await patchLedger();
const supersessions = await supersessionLedger();
const problems = [
  ...patches.filter((row) => row.state === "unresolved"),
  ...supersessions.filter((row) => row.decision.startsWith("escalate")),
];

if (asJson) {
  console.log(
    JSON.stringify({ generatedAt: new Date().toISOString(), patches, supersessions }, null, 2),
  );
} else {
  console.log(`local.patch artifacts: ${patches.length}`);
  for (const state of ["applied", "pending", "unresolved"]) {
    const count = patches.filter((row) => row.state === state).length;
    console.log(`  ${state.padEnd(10)} ${count}`);
  }
  console.log(`\nSKILL.superseded.md sidecars: ${supersessions.length}`);
  for (const row of supersessions) {
    console.log(
      `  ${row.skill} -> ${row.canonical ?? "(none)"}` +
        `${row.canonicalExists && row.redirect === row.canonical && row.aliasRegisters ? "" : "  <-- CHECK"}`,
    );
  }
  const referenced = patches.filter((row) => row.references.length > 0);
  console.log(`\npatches referenced outside their own skill directory: ${referenced.length}`);
  for (const row of referenced) console.log(`  ${row.path} <- ${row.references.join(", ")}`);
  console.log(
    `\nambiguous artifacts: ${problems.length}` +
      (problems.length === 0
        ? " (none)"
        : `: ${problems.map((row) => row.path ?? row.sidecar).join(", ")}`),
  );
}

if (check && problems.length > 0) process.exit(1);
