#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SKILL_ROOT,
  REPO_ROOT,
  inferSkillDomain,
  inferSkillKind,
  listSkillDirectories,
  pathType,
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

const EXTERNAL_RUNTIME_PATTERNS = [
  ["mcp", /\bMCP\b|mcp__[A-Za-z0-9_]+/],
  ["connector", /\bconnector\b|\bComposio\b|\bRube\b|\bMaton\b/i],
  ["browser-runtime", /\bPlaywright MCP\b|\bChrome DevTools Protocol\b|\bCDP\b|\buse_browser\b/i],
  [
    "external-cli",
    /\brequires?\s+(?:the\s+)?[A-Za-z0-9_.-]+\s+CLI\b|\binstall\s+(?:the\s+)?[A-Za-z0-9_.-]+\s+CLI\b/i,
  ],
  ["environment", /\b(?:environment variable|API key|access token|credentials?)\b/i],
];

const REFERENCE_ONLY_PATTERN =
  /\b(?:catalog(?:ue)? entry|reference[- ]only|install the upstream bundle|upstream bundle)\b/i;
const EXECUTABLE_PATTERN =
  /(?:^|\s)(?:node|python3?|bash|sh)\s+((?:scripts|references|assets)\/[^\s'"`;]+)/gm;

async function concreteMissing(record) {
  const missing = [];
  for (const rel of record.references) {
    if ((await pathType(path.join(record.dir, rel))) === "missing") missing.push(rel);
  }
  return missing;
}

function executableRefs(raw) {
  return [...raw.matchAll(EXECUTABLE_PATTERN)].map((match) => match[1]).filter(Boolean);
}

function detectExternalRequirements(raw) {
  return EXTERNAL_RUNTIME_PATTERNS.filter(([, matcher]) => matcher.test(raw)).map(([name]) => name);
}

const rows = [];
const gapIndex = new Map();
for (const name of await listSkillDirectories(root)) {
  let record;
  try {
    record = await readSkillRecord(root, name);
  } catch (error) {
    rows.push({
      name,
      status: "invalid-metadata",
      reason: error instanceof Error ? error.message : String(error),
      missingResources: [],
      executableReferences: [],
      externalRequirements: [],
    });
    continue;
  }
  if (!record.metadata) {
    rows.push({
      name,
      status: "missing-entrypoint",
      reason: "No canonical SKILL.md metadata could be loaded.",
      missingResources: [],
      executableReferences: [],
      externalRequirements: [],
    });
    continue;
  }

  const description =
    typeof record.metadata.description === "string" ? record.metadata.description : "";
  const tags = Array.isArray(record.metadata.tags)
    ? record.metadata.tags.filter((tag) => typeof tag === "string")
    : [];
  const missingResources = await concreteMissing(record);
  for (const rel of missingResources) {
    const bucket = gapIndex.get(rel) ?? [];
    bucket.push(name);
    gapIndex.set(rel, bucket);
  }
  const executableReferences = executableRefs(record.raw);
  const externalRequirements = detectExternalRequirements(record.raw);
  const referenceOnly = REFERENCE_ONLY_PATTERN.test(`${description}\n${record.body}`);

  let status = "ready";
  let reason = "No missing concrete local resources detected.";
  if (missingResources.length > 0) {
    status = "incomplete-local-resources";
    reason = `${missingResources.length} referenced local resource(s) are absent.`;
  } else if (referenceOnly) {
    status = "reference-only";
    reason =
      "Instructions identify this package as reference/catalogue material rather than a self-contained implementation.";
  } else if (externalRequirements.length > 0) {
    status = "requires-external-runtime";
    reason = `Requires external runtime/setup: ${externalRequirements.join(", ")}.`;
  }

  rows.push({
    name,
    status,
    reason,
    domain: inferSkillDomain(name, description, tags),
    kind: inferSkillKind(name, description),
    missingResources,
    executableReferences,
    externalRequirements,
  });
}

const groupedGaps = [...gapIndex.entries()]
  .map(([resource, skills]) => ({ resource, count: skills.length, skills: skills.sort() }))
  .sort((a, b) => b.count - a.count || a.resource.localeCompare(b.resource));

const statusCounts = Object.fromEntries(
  [
    ...rows.reduce((map, row) => map.set(row.status, (map.get(row.status) ?? 0) + 1), new Map()),
  ].sort(([a], [b]) => a.localeCompare(b)),
);

const report = {
  generatedAt: new Date().toISOString(),
  sourceRoot: path.relative(REPO_ROOT, root),
  summary: {
    skills: rows.length,
    statuses: statusCounts,
    missingResourceKinds: groupedGaps.length,
    skillsWithMissingResources: rows.filter((row) => row.status === "incomplete-local-resources")
      .length,
  },
  groupedGaps,
  skills: rows.sort((a, b) => a.name.localeCompare(b.name)),
};

if (jsonOut) {
  const out = path.resolve(jsonOut);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, stableStringify(report));
}

const markdown = [
  "# Skill readiness and resource-gap report",
  "",
  `Generated: ${report.generatedAt}`,
  `Skills: ${report.summary.skills}`,
  `Skills with missing concrete local resources: ${report.summary.skillsWithMissingResources}`,
  "",
  "## Readiness states",
  "",
  ...Object.entries(statusCounts).map(([status, count]) => `- ${status}: ${count}`),
  "",
  "## Most common missing concrete resources",
  "",
  ...(groupedGaps.length
    ? groupedGaps
        .slice(0, 100)
        .map(
          (gap) =>
            `- ${gap.resource}: ${gap.count} skill(s) — ${gap.skills.slice(0, 10).join(", ")}${gap.skills.length > 10 ? ", …" : ""}`,
        )
    : ["_None detected._"]),
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
