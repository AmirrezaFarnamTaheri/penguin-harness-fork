import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pinSkills, resolveSkill, verifySkills } from "./lock.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-skill-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, ".agents", "skills", "example-skill");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# Example skill\n", "utf8");
  return { root, sourceDir };
}

test("pins a skill and resolves it offline after verification", async (t) => {
  const { root } = await fixture(t);
  const pinned = await pinSkills({ root });
  assert.equal(pinned.count, 1);
  assert.deepEqual(await verifySkills({ root }), { count: 1, failures: [] });
  const skill = await resolveSkill("example-skill", { root });
  assert.equal(skill.source, ".agents/skills/example-skill/SKILL.md");
  assert.equal(skill.content, "# Example skill\n");
  assert.match(skill.sha256, /^[a-f0-9]{64}$/);
});

test("resolver refuses changed bytes and verifier reports drift", async (t) => {
  const { root, sourceDir } = await fixture(t);
  await pinSkills({ root });
  await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# Changed skill\n", "utf8");
  await assert.rejects(() => resolveSkill("example-skill", { root }), /content drift detected/);
  const result = await verifySkills({ root });
  assert.match(result.failures[0], /example-skill: content drift/);
});

test("verification identifies unpinned and missing skill sources", async (t) => {
  const { root, sourceDir } = await fixture(t);
  await pinSkills({ root });
  await fs.rm(sourceDir, { recursive: true });
  const absent = await verifySkills({ root });
  assert.match(absent.failures[0], /pinned source is missing/);

  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# Example skill\n", "utf8");
  const addedDir = path.join(root, ".agents", "skills", "new-skill");
  await fs.mkdir(addedDir, { recursive: true });
  await fs.writeFile(path.join(addedDir, "SKILL.md"), "# New skill\n", "utf8");
  const added = await verifySkills({ root });
  assert.match(added.failures[0], /new-skill: source is not pinned/);
});

test("resolver refuses an unpinned name and path-shaped names", async (t) => {
  const { root } = await fixture(t);
  await pinSkills({ root });
  await assert.rejects(() => resolveSkill("missing-skill", { root }), /Skill is not pinned/);
  await assert.rejects(() => resolveSkill("../outside", { root }), /Invalid skill name/);
});

test("resolver refuses a replaced source directory even when the pinned bytes match", async (t) => {
  const { root, sourceDir } = await fixture(t);
  await pinSkills({ root });
  const redirected = path.join(root, "redirected-skill");
  await fs.rename(sourceDir, redirected);
  await fs.symlink(redirected, sourceDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => resolveSkill("example-skill", { root }), /non-symlink directory/);
});
