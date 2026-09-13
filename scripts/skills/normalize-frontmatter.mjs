#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SKILL_ROOT, listSkillDirectories, parseFrontmatter } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const valueArg = (prefix) =>
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`${prefix}=`))
    ?.slice(prefix.length + 1);
const root = path.resolve(valueArg("--root") ?? DEFAULT_SKILL_ROOT);

const DESCRIPTION_OVERRIDES = {
  "agent-skills-schema":
    "Design database schemas, migrations, and multi-tenant architecture including RLS, tenant routing, provisioning, quotas, and isolation. Not for query-plan tuning.",
  boltz:
    "Predict biomolecular structures with Boltz-1 for protein, nucleic-acid, and small-molecule complexes.",
  "browser-use":
    "Automate browser interactions with the browser-use Python CLI for navigation, form interaction, screenshots, and web data extraction.",
  chai1:
    "Predict biomolecular structures with Chai-1 for protein, nucleic-acid, and small-molecule complexes.",
  "codebase-documentation-writer":
    "Write and update repository and product documentation, including READMEs, user guides, architecture docs, API docs, and runbooks.",
  "conversion-ops": "CRO audit, landing page optimization, and survey-to-lead-magnet conversion.",
  gget: "Query bioinformatics databases quickly from the CLI or Python for genes, transcripts, sequences, structures, and related biological data.",
  "growth-engine":
    "Autonomous marketing experiment engine that runs, measures, and optimizes growth.",
  "marketing-skills":
    "Use a collection of marketing playbooks for CRO, SEO, copywriting, analytics, experimentation, growth, positioning, and related marketing work.",
  "opencodex-proxy-controller":
    "Control a running opencodex (ocx) proxy from the CLI, including account pools, routing, health, limits, and provider state.",
  "policy-diff":
    "Compare changed regulations against an indexed policy library and produce per-requirement gaps and policy update recommendations.",
  "release-process-runner":
    "Prepare a named release version through preflight checks, version consistency, build and packaging, smoke verification, and release notes.",
  "revenue-intelligence":
    "Revenue attribution, sales call insights, and automated client report generation.",
  "sales-pipeline":
    "Sales pipeline automation for visitor routing, deal resurrection, buying-signal prospecting, and ICP learning.",
  "seo-ops":
    "SEO operations for content attack briefs, Search Console optimization, competitor gaps, and trend scouting.",
  "setup-cowork":
    "Guide Cowork setup by installing a matching plugin, trying a skill, connecting tools, and verifying the resulting environment.",
  "shopify-admin-api":
    "Manage Shopify Admin API resources including orders, products, customers, inventory, fulfillments, refunds, returns, and transactions.",
};

function frontmatterBounds(raw) {
  const clean = raw.replace(/^\uFEFF/, "");
  if (!clean.startsWith("---\n") && !clean.startsWith("---\r\n")) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(clean);
  if (!match) return null;
  return { clean, full: match[0], yaml: match[1] };
}

function normalizeDescriptionBlock(raw, expectedName, description) {
  const bounds = frontmatterBounds(raw);
  if (!bounds) throw new Error(`${expectedName}: missing frontmatter block`);
  const lines = bounds.yaml.split(/\r?\n/);
  const output = [];
  let inserted = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyMatch = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    const key = keyMatch?.[1];
    if (key === "description" || key === "descriptipn") {
      while (
        i + 1 < lines.length &&
        /^\s+\S/.test(lines[i + 1]) &&
        !/^\s+[A-Za-z0-9_-]+\s*:/.test(lines[i + 1])
      )
        i += 1;
      continue;
    }
    output.push(line);
    if (key === "name") {
      const currentName = line
        .slice(line.indexOf(":") + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (currentName !== expectedName)
        throw new Error(`${expectedName}: frontmatter name is '${currentName}'`);
      output.push(`description: ${JSON.stringify(description)}`);
      inserted = true;
    }
  }

  if (!inserted) throw new Error(`${expectedName}: missing name field`);
  const replacement = `---\n${output.join("\n")}\n---\n`;
  return `${replacement}${bounds.clean.slice(bounds.full.length)}`;
}

const changed = [];
for (const name of await listSkillDirectories(root)) {
  const override = DESCRIPTION_OVERRIDES[name];
  if (!override) continue;
  const file = path.join(root, name, "SKILL.md");
  const raw = await fs.readFile(file, "utf8");
  let validDescription = false;
  try {
    const parsed = parseFrontmatter(raw, file);
    validDescription =
      typeof parsed.metadata.description === "string" &&
      parsed.metadata.description.trim() === override;
  } catch {
    // The normalizer exists specifically to repair malformed legacy frontmatter.
  }
  if (validDescription) continue;
  const next = normalizeDescriptionBlock(raw, name, override);
  if (next === raw) continue;
  changed.push(path.relative(process.cwd(), file));
  if (write) await fs.writeFile(file, next);
}

if (changed.length === 0) {
  console.log("Skill frontmatter is normalized.");
} else if (write) {
  console.log(`Normalized ${changed.length} skill frontmatter file(s):`);
  for (const file of changed) console.log(`- ${file}`);
} else {
  console.error(`Skill frontmatter normalization required for ${changed.length} file(s):`);
  for (const file of changed) console.error(`- ${file}`);
  process.exitCode = 1;
}
