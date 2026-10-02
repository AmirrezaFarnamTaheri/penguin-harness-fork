/**
 * The patch ledger's supersession checks, driven through the real script in fixture trees.
 *
 * Every case here is a way `--check` could previously pass while an artifact was broken: a
 * directory it could not read reported as empty, a planned supersession whose sidecar was deleted
 * (no directory left to discover), a redirect that only exists in the body, an alias whose first
 * hop reads right but ends elsewhere, and a canonical skill that is itself a redirect. The fixture
 * is a miniature repository (`process.cwd()` is the root the script reads), so these run the
 * shipped CLI rather than a reimplementation of it.
 *
 * Run: node --test scripts/skills/patch-ledger.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "patch-ledger.mjs");

/** Writes `files` (repo-relative path → content) into a throwaway root and returns it. */
async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patch-ledger-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return root;
}

/** Runs the ledger in `cwd`; never throws, so a non-zero exit is data, not a test failure. */
function run(cwd, args = ["--json"]) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const skill = (name, extra = "") =>
  `---\nname: ${name}\n${extra}---\n\nInstructions for ${name}.\n`;
const sidecar = (name) => `---\nname: ${name}\n---\n\nOriginal instructions for ${name}.\n`;
const plan = (superseded, canonical) =>
  JSON.stringify({ consolidations: [{ superseded, canonical }] }, null, 2);
const aliases = (map) => JSON.stringify({ aliases: map }, null, 2);

/** A tree whose one planned supersession resolves cleanly. */
const resolved = () => ({
  ".agents/skills/alpha/SKILL.md": skill("alpha", "redirect: beta\n"),
  ".agents/skills/alpha/SKILL.superseded.md": sidecar("alpha"),
  ".agents/skills/beta/SKILL.md": skill("beta"),
  ".agents/skills/aliases.json": aliases({ alpha: "beta" }),
  "artifacts/skill-consolidations.json": plan("alpha", "beta"),
});

const rowOf = (json, name) =>
  JSON.parse(json).supersessions.find((row) => row.skill === name) ?? null;

test("passes and reports 'retain' when the supersession resolves", async () => {
  const root = await fixture(resolved());
  const check = run(root, ["--check"]);
  assert.equal(check.status, 0, check.stderr);
  const row = rowOf(run(root).stdout, "alpha");
  assert.equal(row.decision, "retain: deliberate supersession resolves once");
  assert.equal(row.sidecarExists, true);
  assert.equal(row.canonicalExists, true);
  assert.equal(row.aliasRegisters, true);
  assert.equal(row.canonicalRedirect, null);
  await fs.rm(root, { recursive: true, force: true });
});

test("fails a planned supersession whose sidecar was deleted", async () => {
  // The directory and its redirect are still there, but the verbatim original is gone: nothing
  // points the reader back to what the skill used to say.
  const files = resolved();
  delete files[".agents/skills/alpha/SKILL.superseded.md"];
  const root = await fixture(files);
  const check = run(root, ["--check"]);
  assert.notEqual(check.status, 0);
  const row = rowOf(run(root).stdout, "alpha");
  assert.equal(row.sidecarExists, false);
  assert.match(row.decision, /escalate: planned supersession has no sidecar/);
  await fs.rm(root, { recursive: true, force: true });
});

test("fails a redirect that only appears in the document body", async () => {
  // `redirect: beta` in prose is documentation, not a working redirect: the parsed frontmatter
  // is what the loaders move a reader with.
  const files = resolved();
  files[".agents/skills/alpha/SKILL.md"] = `---\nname: alpha\n---\n\nredirect: beta\n`;
  const root = await fixture(files);
  const check = run(root, ["--check"]);
  assert.notEqual(check.status, 0);
  const row = rowOf(run(root).stdout, "alpha");
  assert.equal(row.redirect, null);
  assert.match(row.decision, /SKILL\.md redirect is 'none', expected 'beta'/);
  await fs.rm(root, { recursive: true, force: true });
});

test("fails an alias whose chain ends somewhere else, or loops", async () => {
  // The first hop (`alpha` -> `beta`) is what a substring/regex check would be satisfied by, but
  // resolution continues: `beta` -> `delta` means the old name does not arrive at the canonical.
  const chained = resolved();
  chained[".agents/skills/aliases.json"] = aliases({ alpha: "beta", beta: "delta" });
  chained[".agents/skills/delta/SKILL.md"] = skill("delta");
  const root = await fixture(chained);
  const chainCheck = run(root, ["--check"]);
  assert.notEqual(chainCheck.status, 0);
  const chainRow = rowOf(run(root).stdout, "alpha");
  assert.equal(chainRow.aliasTarget, "delta");
  assert.match(chainRow.decision, /alias resolves to 'delta', expected 'beta'/);
  await fs.rm(root, { recursive: true, force: true });

  const looping = resolved();
  looping[".agents/skills/aliases.json"] = aliases({ alpha: "beta", beta: "alpha" });
  const loopRoot = await fixture(looping);
  const loopCheck = run(loopRoot, ["--check"]);
  assert.notEqual(loopCheck.status, 0);
  const loopRow = rowOf(run(loopRoot).stdout, "alpha");
  assert.notEqual(loopRow.aliasCycle, null);
  assert.match(loopRow.decision, /\(cycle\)/);
  await fs.rm(loopRoot, { recursive: true, force: true });
});

test("fails a canonical skill that is itself a redirect", async () => {
  const files = resolved();
  files[".agents/skills/beta/SKILL.md"] = skill("beta", "redirect: gamma\n");
  const root = await fixture(files);
  const check = run(root, ["--check"]);
  assert.notEqual(check.status, 0);
  const row = rowOf(run(root).stdout, "alpha");
  assert.equal(row.canonicalRedirect, "gamma");
  assert.match(row.decision, /canonical 'beta' is itself a redirect/);
  await fs.rm(root, { recursive: true, force: true });
});

test("keeps escalating a sidecar with no consolidation entry", async () => {
  const files = resolved();
  files[".agents/skills/orphan/SKILL.superseded.md"] = sidecar("orphan");
  const root = await fixture(files);
  const check = run(root, ["--check"]);
  assert.notEqual(check.status, 0);
  const row = rowOf(run(root).stdout, "orphan");
  assert.equal(row.canonical, null);
  assert.match(row.decision, /sidecar with no consolidation entry/);
  await fs.rm(root, { recursive: true, force: true });
});

test("fails closed when discovery cannot read a directory", async () => {
  // A skill root that is not a directory (or not readable) is "I could not check", never "there
  // was nothing to check": the run must not print a clean ledger.
  const root = await fixture({
    ".agents/skills": "not a directory\n",
    "artifacts/skill-consolidations.json": plan("alpha", "beta"),
  });
  for (const args of [["--check"], ["--json"]]) {
    const result = run(root, args);
    assert.equal(result.status, 2, `expected the operational exit for ${args.join(" ")}`);
    assert.match(result.stderr, /patch-ledger: cannot read \.agents\/skills/);
    assert.equal(result.stdout, "");
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("each reader refuses an unreadable root on its own", async () => {
  // The two readers cover the same root, so a CLI run cannot say which one refused — and
  // removing either guard would still exit 2 because of the other. Importing the module (its
  // main() is guarded) and calling the readers directly is what keeps both live.
  const root = await fixture({ ".agents/skills": "not a directory\n" });
  const previous = process.cwd();
  process.chdir(root);
  try {
    // A fresh module instance, because the roots are resolved at import time.
    const module = await import(`${pathToFileURL(SCRIPT).href}?fixture=${Date.now()}`);
    await assert.rejects(() => module.listSkillDirs(), /cannot read skill root/);
    await assert.rejects(
      () => module.findPatches(module.SKILL_ROOT),
      /cannot read \.agents\/skills/,
    );
  } finally {
    process.chdir(previous);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a nested directory cannot be read", async (t) => {
  // The unreadable directory is a patch-discovery failure rather than a skill-root one, and is
  // only enforceable without root's permission bypass.
  const root = await fixture(resolved());
  const trap = path.join(root, ".agents", "skills", "unreadable");
  await fs.mkdir(trap, { recursive: true });
  await fs.chmod(trap, 0o000);
  try {
    await fs.readdir(trap);
    t.skip("running as a user that can read mode-000 directories");
    return;
  } catch {
    // Expected: the directory really is unreadable, so the ledger must refuse to continue.
  }
  const result = run(root, ["--check"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /patch-ledger: cannot read \.agents\/skills\/unreadable/);
  await fs.chmod(trap, 0o700);
  await fs.rm(root, { recursive: true, force: true });
});
