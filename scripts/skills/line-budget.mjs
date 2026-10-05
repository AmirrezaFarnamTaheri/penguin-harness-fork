#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_SKILL_ROOT, REPO_ROOT, listSkillDirectories } from "./lib.mjs";

export const MAX_SKILL_LINES = 80;

export function physicalLineCount(source) {
  if (source.length === 0) return 0;
  return source.split(/\r\n|\n|\r/).length - (/(?:\r\n|\n|\r)$/.test(source) ? 1 : 0);
}

export function compareLineBudget(currentLines, baselineLines, limit = MAX_SKILL_LINES) {
  if (
    !Number.isSafeInteger(currentLines) ||
    currentLines < 0 ||
    !Number.isSafeInteger(baselineLines) ||
    baselineLines < 0
  )
    throw new RangeError("Skill line counts must be non-negative integers");
  if (currentLines <= limit) return { status: "within-budget" };
  if (baselineLines <= limit)
    return {
      status: "new-violation",
      message: `Skill has ${currentLines} lines; the limit is ${limit}.`,
    };
  if (currentLines > baselineLines)
    return {
      status: "regression",
      message: `Skill grew from ${baselineLines} to ${currentLines} lines above the ${limit}-line limit.`,
    };
  return {
    status: "grandfathered",
    message: `Existing ${baselineLines}-line skill is ${currentLines} lines; keep reducing it toward ${limit}.`,
  };
}

/**
 * Parse `git diff --name-status -z` output. Rename and copy rows list the base path first and
 * the current path second; the baseline must be read from the base path.
 */
export function parseNameStatus(output) {
  const rows = output.split("\0");
  const entries = [];
  let i = 0;
  while (i < rows.length) {
    const status = rows[i++];
    if (!status) continue;
    const first = rows[i++];
    const renamed = status.startsWith("R") || status.startsWith("C");
    const file = renamed ? rows[i++] : first;
    if (!first || !file) throw new Error(`Malformed git name-status row: ${status}`);
    entries.push({ status, file, baselineFile: renamed ? first : file });
  }
  return entries;
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
}

async function longSkillInventory() {
  const inventory = [];
  for (const name of await listSkillDirectories(DEFAULT_SKILL_ROOT)) {
    const file = path.join(DEFAULT_SKILL_ROOT, name, "SKILL.md");
    try {
      const source = await fs.readFile(file, "utf8");
      const lines = physicalLineCount(source);
      if (lines > MAX_SKILL_LINES)
        inventory.push({
          skill: name,
          lines,
          sha256: createHash("sha256").update(source).digest("hex"),
        });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return inventory;
}

export async function runLineBudget(baseRef, reportPath) {
  if (!baseRef || /^0+$/.test(baseRef))
    throw new Error("Provide a non-zero base commit with SKILLS_BASE_REF.");
  git(["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const diffArgs = ["diff", "--name-status", "-z", baseRef, "--", ".agents/skills/*/SKILL.md"];
  const entries = parseNameStatus(git(diffArgs).toString("utf8"));
  let changed = 0;
  let grandfathered = 0;
  const failures = [];
  for (const { status, file, baselineFile } of entries) {
    if (status.startsWith("D")) continue;
    changed++;
    const absolute = path.resolve(REPO_ROOT, file);
    const currentLines = physicalLineCount(await fs.readFile(absolute, "utf8"));
    let baselineLines = 0;
    try {
      const baseline = git(["show", `${baseRef}:${baselineFile}`]).toString("utf8");
      baselineLines = physicalLineCount(baseline);
    } catch (error) {
      // A new skill has no baseline entry. Other git/read failures must be visible.
      if (!String(error?.stderr ?? "").includes("does not exist in")) throw error;
    }
    const result = compareLineBudget(currentLines, baselineLines);
    if (result.status === "grandfathered") grandfathered++;
    if (result.status === "new-violation" || result.status === "regression")
      failures.push(`${path.relative(REPO_ROOT, absolute)}: ${result.message}`);
  }
  const inventory = await longSkillInventory();
  if (reportPath) {
    const report = {
      schemaVersion: 1,
      baseRef,
      lineLimit: MAX_SKILL_LINES,
      changedSkills: changed,
      existingOverLimit: inventory.length,
      grandfatheredChangesReduced: grandfathered,
      legacyCorpus: inventory,
      failures,
    };
    const target = path.resolve(REPO_ROOT, reportPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `Skill line budget: ${changed} changed; ${inventory.length} existing skills exceed ${MAX_SKILL_LINES} lines; ${grandfathered} changed long skills were reduced without crossing the limit.`,
  );
  for (const failure of failures) console.error(`ERROR ${failure}`);
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const reportArg = process.argv.slice(2).find((arg) => arg.startsWith("--json="));
    await runLineBudget(process.env.SKILLS_BASE_REF, reportArg?.slice("--json=".length));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
