import fs from "node:fs/promises";
import path from "node:path";
import {
  listSkillDirectories,
  loadAliases,
  readSkillRecord,
  readRedirectTarget,
  resolveAlias,
} from "file:///D:/GitHub/penguin-harness-fork/scripts/skills/lib.mjs";

const root = ".agents/skills";
const plan = JSON.parse(await fs.readFile("artifacts/skill-consolidations.json", "utf8"));
const { aliases } = await loadAliases(path.join(root, "aliases.json"));
const dirs = new Set(await listSkillDirectories(root));

let problems = 0;
const log = (line) => console.log(line);
const bad = (line) => {
  problems += 1;
  console.log(`FAIL ${line}`);
};

log(`consolidations in plan: ${plan.consolidations.length}`);
for (const item of plan.consolidations) {
  const { canonical, superseded } = item;
  if (!dirs.has(canonical)) bad(`${canonical}: canonical dir missing`);
  if (!dirs.has(superseded)) bad(`${superseded}: superseded dir was deleted`);
  const record = await readSkillRecord(root, superseded);
  const redirect = readRedirectTarget(record.metadata);
  if (redirect !== canonical)
    bad(`${superseded}: SKILL.md redirect is '${redirect}', expected '${canonical}'`);
  const sidecar = path.join(root, superseded, "SKILL.superseded.md");
  try {
    const original = await fs.readFile(sidecar, "utf8");
    if (!original.includes(`name: ${superseded}`))
      bad(`${superseded}: sidecar does not preserve the original frontmatter name`);
  } catch {
    bad(`${superseded}: original instructions not preserved (no SKILL.superseded.md)`);
  }
  const resolved = resolveAlias(superseded, aliases);
  if (resolved.target !== canonical)
    bad(`${superseded}: alias resolves to '${resolved.target}', expected '${canonical}'`);
  if (record.metadata.name !== superseded)
    bad(`${superseded}: frontmatter name '${record.metadata.name}' != directory name`);
  const canonicalRecord = await readSkillRecord(root, canonical);
  if (readRedirectTarget(canonicalRecord.metadata))
    bad(`${canonical}: canonical is itself a redirect`);
  log(
    `ok  ${superseded} -> ${canonical} (dir kept, redirect set, original preserved, alias registered)`,
  );
}

// Renames: old name must resolve through the alias chain to the new one.
for (const [oldName, newName] of [
  ["healthcheck", "water-sleep-tracker"],
  ["model-update", "financial-model-update"],
  ["portfolio", "ip-portfolio"],
]) {
  if (dirs.has(oldName)) bad(`rename ${oldName}: old directory still present`);
  if (!dirs.has(newName)) bad(`rename ${newName}: new directory missing`);
  const resolved = resolveAlias(oldName, aliases);
  if (resolved.target !== newName)
    bad(`rename ${oldName}: alias resolves to '${resolved.target}', expected '${newName}'`);
  log(`ok  rename ${oldName} -> ${newName} (dir moved, alias registered)`);
}

// No alias may dangle or cycle.
for (const [alias] of Object.entries(aliases)) {
  const resolved = resolveAlias(alias, aliases);
  if (resolved.cycle) bad(`alias cycle at ${alias}`);
  else if (!dirs.has(resolved.target)) bad(`dangling alias ${alias} -> ${resolved.target}`);
}

// Taxonomy must account for every skill exactly once.
const taxonomy = JSON.parse(await fs.readFile("artifacts/skill-taxonomy.json", "utf8"));
const counted = new Set();
for (const group of taxonomy.groups) {
  for (const name of group.skills) {
    if (counted.has(name)) bad(`taxonomy: ${name} in two groups`);
    counted.add(name);
  }
}
const missing = [...dirs].filter((name) => !counted.has(name));
const extra = [...counted].filter((name) => !dirs.has(name));
if (missing.length)
  bad(
    `taxonomy: ${missing.length} skill(s) unaccounted for, e.g. ${missing.slice(0, 5).join(", ")}`,
  );
if (extra.length) bad(`taxonomy: ${extra.length} non-existent skill(s) listed`);
log(
  `taxonomy: ${counted.size} skills across ${taxonomy.groups.length} groups, every skill in exactly one`,
);

// Redirects must be counted as redirects, and nothing else may be one.
const redirects = (
  await Promise.all(
    [...dirs].map(async (name) => {
      const record = await readSkillRecord(root, name);
      return readRedirectTarget(record.metadata) ? name : null;
    }),
  )
).filter(Boolean);
if (redirects.length !== plan.consolidations.length)
  bad(`expected ${plan.consolidations.length} redirects, found ${redirects.length}`);
log(`redirects present: ${redirects.length}`);

console.log(`\n${problems === 0 ? "ALL CHECKS PASSED" : `${problems} PROBLEM(S)`}`);
process.exit(problems === 0 ? 0 : 1);
