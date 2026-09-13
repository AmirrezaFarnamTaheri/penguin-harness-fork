#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SKILL_ROOT,
  REPO_ROOT,
  distinctiveNameTokens,
  inferSkillDomain,
  inferSkillKind,
  listSkillDirectories,
  loadAliases,
  normalizeDescription,
  normalizedStem,
  readSkillRecord,
  stableStringify,
} from "./lib.mjs";

const valueArg = (prefix) =>
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`${prefix}=`))
    ?.slice(prefix.length + 1);
const root = path.resolve(valueArg("--root") ?? DEFAULT_SKILL_ROOT);
const jsonOut = valueArg("--json");
const markdownOut = valueArg("--markdown");
const aliases = (await loadAliases()).aliases;
const aliasesByTarget = new Map();
for (const [alias, target] of Object.entries(aliases)) {
  const bucket = aliasesByTarget.get(target) ?? [];
  bucket.push(alias);
  aliasesByTarget.set(target, bucket);
}

const skills = [];
for (const name of await listSkillDirectories(root)) {
  let record;
  try {
    record = await readSkillRecord(root, name);
  } catch {
    continue;
  }
  if (!record.metadata) continue;
  const description =
    typeof record.metadata.description === "string" ? record.metadata.description.trim() : "";
  const tags = Array.isArray(record.metadata.tags)
    ? record.metadata.tags.filter((tag) => typeof tag === "string")
    : [];
  const bodyNormalized = normalizeDescription(record.body);
  const bodyHash = crypto.createHash("sha256").update(bodyNormalized).digest("hex").slice(0, 16);
  skills.push({
    name,
    description,
    domain: inferSkillDomain(name, description, tags),
    kind: inferSkillKind(name, description),
    tags,
    aliases: (aliasesByTarget.get(name) ?? []).sort(),
    routingTokens: distinctiveNameTokens(name),
    stem: normalizedStem(name),
    bodyHash,
  });
}

const countBy = (key) =>
  Object.fromEntries(
    [
      ...skills.reduce(
        (map, skill) => map.set(skill[key], (map.get(skill[key]) ?? 0) + 1),
        new Map(),
      ),
    ].sort(([a], [b]) => a.localeCompare(b)),
  );

const bodyGroups = new Map();
for (const skill of skills) {
  if (!skill.bodyHash) continue;
  const bucket = bodyGroups.get(skill.bodyHash) ?? [];
  bucket.push(skill.name);
  bodyGroups.set(skill.bodyHash, bucket);
}
const exactBodyDuplicates = [...bodyGroups.entries()]
  .filter(([, names]) => names.length > 1)
  .map(([bodyHash, names]) => ({ bodyHash, skills: names.sort() }))
  .sort((a, b) => a.skills[0].localeCompare(b.skills[0]));

const stemGroups = new Map();
for (const skill of skills) {
  const bucket = stemGroups.get(skill.stem) ?? [];
  bucket.push(skill.name);
  stemGroups.set(skill.stem, bucket);
}
const overlapFamilies = [...stemGroups.entries()]
  .filter(([, names]) => names.length > 1)
  .map(([stem, names]) => ({ stem, skills: names.sort() }))
  .sort((a, b) => a.stem.localeCompare(b.stem));

const ambiguousSingleWord = skills
  .filter((skill) => !skill.name.includes("-") && skill.routingTokens.length <= 1)
  .map((skill) => skill.name)
  .sort();

const report = {
  generatedAt: new Date().toISOString(),
  sourceRoot: path.relative(REPO_ROOT, root),
  summary: {
    skills: skills.length,
    domains: countBy("domain"),
    kinds: countBy("kind"),
    exactBodyDuplicateGroups: exactBodyDuplicates.length,
    overlapFamilies: overlapFamilies.length,
    ambiguousSingleWordSkills: ambiguousSingleWord.length,
  },
  routingPolicy: {
    precedence: [
      "explicit canonical skill name",
      "explicit legacy alias resolution",
      "distinctive canonical name tokens",
      "tags and declared/inferred domain",
      "description evidence",
    ],
    suffixSemantics: {
      automation:
        "named external service automation; require the service/product token for natural-language matching",
      bilingual:
        "bilingual specialist variant; prefer only when bilingual/localized expertise is relevant",
      patterns: "reference/design-pattern guidance rather than direct execution",
      runner: "execution-oriented workflow",
      review: "inspection/audit workflow",
    },
  },
  exactBodyDuplicates,
  overlapFamilies,
  ambiguousSingleWord,
  skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
};

if (jsonOut) {
  const out = path.resolve(jsonOut);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, stableStringify(report));
}

const markdown = [
  "# Skill taxonomy and routing report",
  "",
  `Generated: ${report.generatedAt}`,
  `Skills: ${report.summary.skills}`,
  `Exact-body duplicate groups: ${exactBodyDuplicates.length}`,
  `Potential stem-overlap families: ${overlapFamilies.length}`,
  `Ambiguous single-word skills: ${ambiguousSingleWord.length}`,
  "",
  "## Domains",
  "",
  ...Object.entries(report.summary.domains).map(([name, count]) => `- ${name}: ${count}`),
  "",
  "## Kinds",
  "",
  ...Object.entries(report.summary.kinds).map(([name, count]) => `- ${name}: ${count}`),
  "",
  "## Exact-body duplicate candidates",
  "",
  ...(exactBodyDuplicates.length
    ? exactBodyDuplicates.map((group) => `- ${group.skills.join(" ↔ ")}`)
    : ["_None detected._"]),
  "",
  "## Potential overlap families",
  "",
  ...(overlapFamilies.length
    ? overlapFamilies.map((group) => `- **${group.stem}**: ${group.skills.join(", ")}`)
    : ["_None detected._"]),
  "",
  "## Ambiguous single-word names",
  "",
  ambiguousSingleWord.length
    ? ambiguousSingleWord.map((name) => `- ${name}`).join("\n")
    : "_None detected._",
  "",
]
  .flat()
  .join("\n");

if (markdownOut) {
  const out = path.resolve(markdownOut);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${markdown}\n`);
}

if (!jsonOut && !markdownOut) console.log(markdown);
