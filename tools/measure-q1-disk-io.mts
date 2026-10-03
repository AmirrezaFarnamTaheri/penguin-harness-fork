/**
 * Q1: bodies are read from disk to parse frontmatter — how much is that, in bytes?
 * Distinguishes I/O cost from context cost.
 */
import fs from "node:fs";
import path from "node:path";

const skillsDir =
  "C:/Users/ACER/.penguin/data/default_project/agents/default_agent/agent_state/skills";

let totalFileBytes = 0;
let frontmatterBytes = 0;
let n = 0;
for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const file = path.join(skillsDir, entry.name, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, "utf8");
  totalFileBytes += Buffer.byteLength(raw);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (m) frontmatterBytes += Buffer.byteLength(m[1]);
  n += 1;
}

const MB = (b) => Number((b / 1024 / 1024).toFixed(2));
console.log(
  JSON.stringify(
    {
      skills: n,
      allSkillMdBytesReadPerSessionOpen: { total: MB(totalFileBytes), totalMB: MB(totalFileBytes) },
      ofWhichFrontmatterBytes: { total: MB(frontmatterBytes), totalMB: MB(frontmatterBytes) },
      bodiesReadButNeverInjectedMB: MB(totalFileBytes - frontmatterBytes),
      note: "listInstalledSkills reads each SKILL.md in full to parse frontmatter; only frontmatter reaches the prompt.",
    },
    null,
    2,
  ),
);
