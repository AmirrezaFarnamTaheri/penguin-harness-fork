#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_LOCK_PATH = ".agents/skills-lock.json";
const SCHEMA_VERSION = 1;
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function skillSource(slug) {
  if (typeof slug !== "string" || !SKILL_NAME.test(slug)) {
    throw new Error(`Invalid skill name: ${String(slug)}`);
  }
  return `.agents/skills/${slug}/SKILL.md`;
}

function rootPath(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return absolutePath;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(filePath, description) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${description} is missing: ${filePath}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a regular, non-symlink file: ${filePath}`);
  }
  return fs.readFile(filePath);
}

async function assertDirectory(directoryPath, description) {
  let stat;
  try {
    stat = await fs.lstat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${description} is missing: ${directoryPath}`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${description} must be a regular, non-symlink directory: ${directoryPath}`);
  }
}

async function assertPlainParents(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const parts = path
    .dirname(relativePath)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = absoluteRoot;
  for (const part of parts) {
    current = path.join(current, part);
    await assertDirectory(current, "Skills lock parent");
  }
}

async function readLock(root, lockPath) {
  const absoluteLockPath = rootPath(root, lockPath);
  await assertPlainParents(root, lockPath);
  const bytes = await readRegularFile(absoluteLockPath, "Skills lock");
  let lock;
  try {
    lock = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Skills lock is invalid JSON: ${error.message}`);
  }
  if (
    lock === null ||
    typeof lock !== "object" ||
    lock.schemaVersion !== SCHEMA_VERSION ||
    lock.skills === null ||
    typeof lock.skills !== "object" ||
    Array.isArray(lock.skills)
  ) {
    throw new Error(`Unsupported skills lock format (expected schemaVersion ${SCHEMA_VERSION}).`);
  }
  return { lock, absoluteLockPath };
}

async function scanSkills(root) {
  await assertDirectory(rootPath(root, ".agents"), "Skill metadata directory");
  const skillsRoot = rootPath(root, ".agents/skills");
  await assertDirectory(skillsRoot, "Skill source directory");
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error(`Skill source directory is missing: ${skillsRoot}`);
    throw error;
  }

  const skills = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const source = skillSource(slug);
    await assertDirectory(rootPath(root, `.agents/skills/${slug}`), `Skill directory ${slug}`);
    const absoluteSource = rootPath(root, source);
    const bytes = await readRegularFile(absoluteSource, `Skill source ${slug}`);
    skills[slug] = { source, sha256: digest(bytes) };
  }
  return Object.fromEntries(
    Object.entries(skills).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let ownsTemp = false;
  try {
    const handle = await fs.open(tempPath, "wx", 0o644);
    ownsTemp = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (ownsTemp) await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Pins every local skill's canonical source path and exact UTF-8 bytes. */
export async function pinSkills({ root = REPO_ROOT, lockPath = DEFAULT_LOCK_PATH } = {}) {
  const absoluteLockPath = rootPath(root, lockPath);
  await assertPlainParents(root, lockPath);
  const skills = await scanSkills(root);
  const lock = { schemaVersion: SCHEMA_VERSION, skills };
  const json = `${JSON.stringify(lock, null, 2)}\n`;
  await atomicWrite(absoluteLockPath, json);
  return { count: Object.keys(skills).length, lockPath: absoluteLockPath };
}

/** Compares the source tree to its lock, reporting additions, removals, path changes, and drift. */
export async function verifySkills({ root = REPO_ROOT, lockPath = DEFAULT_LOCK_PATH } = {}) {
  const { lock } = await readLock(root, lockPath);
  const current = await scanSkills(root);
  const failures = [];
  const expectedNames = Object.keys(lock.skills).sort();
  const currentNames = Object.keys(current);

  for (const slug of expectedNames) {
    const expected = lock.skills[slug];
    const source = skillSource(slug);
    if (expected === null || typeof expected !== "object") {
      failures.push(`${slug}: invalid lock entry`);
      continue;
    }
    if (expected.source !== source) {
      failures.push(`${slug}: source identity changed (expected ${source})`);
      continue;
    }
    if (typeof expected.sha256 !== "string" || !SHA256.test(expected.sha256)) {
      failures.push(`${slug}: invalid SHA-256 in lock`);
      continue;
    }
    const actual = current[slug];
    if (actual === undefined) {
      failures.push(`${slug}: pinned source is missing`);
    } else if (actual.sha256 !== expected.sha256) {
      failures.push(`${slug}: content drift (expected ${expected.sha256}, got ${actual.sha256})`);
    }
  }
  const expected = new Set(expectedNames);
  for (const slug of currentNames) {
    if (!expected.has(slug)) failures.push(`${slug}: source is not pinned`);
  }
  return { count: currentNames.length, failures };
}

/** Resolves one skill offline, returning bytes only after its source identity and digest match. */
export async function resolveSkill(slug, { root = REPO_ROOT, lockPath = DEFAULT_LOCK_PATH } = {}) {
  const source = skillSource(slug);
  const { lock } = await readLock(root, lockPath);
  const pin = lock.skills[slug];
  if (pin === undefined) throw new Error(`Skill is not pinned: ${slug}`);
  if (pin === null || typeof pin !== "object" || pin.source !== source) {
    throw new Error(`Skill lock has an invalid source identity: ${slug}`);
  }
  if (typeof pin.sha256 !== "string" || !SHA256.test(pin.sha256)) {
    throw new Error(`Skill lock has an invalid SHA-256: ${slug}`);
  }
  await assertPlainParents(root, source);
  const bytes = await readRegularFile(rootPath(root, source), `Skill source ${slug}`);
  const actual = digest(bytes);
  if (actual !== pin.sha256) {
    throw new Error(
      `Skill content drift detected: ${slug} (expected ${pin.sha256}, got ${actual})`,
    );
  }
  return { slug, source, sha256: actual, content: bytes.toString("utf8") };
}

async function main(args) {
  const [command, slug] = args;
  if (command === "pin") {
    const result = await pinSkills();
    process.stdout.write(
      `Pinned ${result.count} skills in ${path.relative(REPO_ROOT, result.lockPath)}.\n`,
    );
    return;
  }
  if (command === "verify") {
    const result = await verifySkills();
    if (result.failures.length > 0) {
      process.stderr.write(`Skill lock drift: ${result.failures.length} issue(s).\n`);
      for (const failure of result.failures) process.stderr.write(`- ${failure}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Verified ${result.count} pinned skills.\n`);
    return;
  }
  if (command === "resolve" && slug !== undefined) {
    const result = await resolveSkill(slug);
    process.stdout.write(result.content);
    return;
  }
  process.stderr.write("Usage: node scripts/skills/lock.mjs <pin|verify|resolve <skill-name>>\n");
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
