/**
 * Q1 measurement against the REAL implementation (src, not dist).
 * Run: node_modules/.bin/tsx tools/measure-q1-real.mts
 */
import {
  listInstalledSkills,
  skillMetadataSection,
} from "../packages/core/src/state/agent-state.js";

const skills = await listInstalledSkills(
  "C:/Users/ACER/.penguin/data",
  "default_project",
  "default_agent",
);

const after = skillMetadataSection(skills);
// The pre-fix form, reproduced here only as the comparison baseline.
const before = skills
  .map((s) => (s.description ? `- \`${s.name}\` — ${s.description}` : `- \`${s.name}\``))
  .join("\n");

const CHARS_PER_TOKEN = 4; // no BPE tokenizer exists in this repo; stated approximation

console.log(
  JSON.stringify(
    {
      installedSkills: skills.length,
      rows: skills.length,
      before: { chars: before.length, approxTokens: Math.round(before.length / CHARS_PER_TOKEN) },
      after: { chars: after.length, approxTokens: Math.round(after.length / CHARS_PER_TOKEN) },
      saved: {
        chars: before.length - after.length,
        approxTokens: Math.round((before.length - after.length) / CHARS_PER_TOKEN),
        pct: Math.round(((before.length - after.length) / before.length) * 100),
      },
      discoverability: {
        rowsBefore: before.split("\n").length,
        rowsAfter: after.split("\n").length,
        unchanged: before.split("\n").length === after.split("\n").length,
      },
    },
    null,
    2,
  ),
);
