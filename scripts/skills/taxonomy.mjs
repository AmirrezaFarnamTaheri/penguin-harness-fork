#!/usr/bin/env node
/**
 * Capability taxonomy for the agent-skills corpus.
 *
 * Derives one capability group per skill, programmatically, from the skill's
 * directory name, frontmatter description and tags. No hand-listed entries: a
 * rule chain is evaluated in precedence order and the first matching rule wins,
 * so adding a skill to the corpus cannot land it outside the taxonomy.
 *
 * Output: artifacts/skill-taxonomy.{json,md}
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SKILL_ROOT,
  REPO_ROOT,
  listSkillDirectories,
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

/**
 * Ordered capability groups. Precedence is deliberate: a skill that plausibly
 * belongs to two groups lands in the earlier one, and the earlier one is the
 * one whose signal is strongest for routing.
 *
 * Matcher receives ({ name, description, tags, body }) with the description and
 * body already lowercased and stripped of markdown punctuation.
 */
const GROUPS = [
  {
    id: "automation-integrations",
    label: "Third-party service automation & integrations",
    purpose: "Drive a named external SaaS/API service, usually through Rube MCP (Composio).",
    match: ({ name, description }) =>
      name.endsWith("-automation") ||
      name.endsWith("-integrations") ||
      name.endsWith("-integration") ||
      /\bcomposio\b|\brube mcp\b|\bmcp server\b|\bcomposio's\b/.test(`${name} ${description}`) ||
      /\b(?:via|using|from)\s+(?:the\s+)?[a-z0-9 .-]{2,40}?(?:api|network|sdk|feed)\b/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "agent-orchestration",
    label: "Agent orchestration, context & memory",
    purpose: "Compose, route, hand off and remember across agents and sessions.",
    match: ({ name, description }) =>
      /\b(sub-?agent|multi-?agent|agent (?:team|orchestrat|handoff|session|profile|registry|skill))|orchestrat|context (?:window|engineer|prun|compress)|memory (?:architect|layer|hierarch)|skill (?:graph|registry|router|routing)|\brouting\b/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "security-privacy",
    label: "Security, auth & privacy",
    purpose: "Threat modelling, hardening, secrets, authentication and compliance.",
    match: ({ name, description }) =>
      /\b(security|secure|threat model|vulnerabilit|owasp|pentest|gdpr|privacy|secret|credential|oauth|authoriz|authentic)|\bauth\b/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "testing",
    label: "Test authoring & test infrastructure",
    purpose: "Write and run unit, integration, e2e, performance and load tests.",
    match: ({ name, description }) =>
      /\b(test|testing|e2e|regression|mock|fixture|load test|performance test|playwright|vitest|jest|cypress|coverage|flaky)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "code-review-quality",
    label: "Code review & quality gates",
    purpose: "Inspect, review, lint and gate code and diffs for quality.",
    match: ({ name, description }) =>
      /\b(code review|review code|lint|linting|quality gate|diff review|patch review|pr review|pull request review|pr feedback|audit code|inspection|total review|fable and gpt reviews)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "professional-services",
    label: "Professional services — finance, legal & regulated work",
    purpose:
      "Deal, finance, accounting, legal, KYC/compliance and clinical workflows for regulated industries.",
    match: ({ name, description }) =>
      /\b(finance|financial|accounting|accounts receivable|invoice|valuation|portfolio|equity research|earnings|tax(es)?|reconcil|month-end|legal|litigation|law firm|matter|kyc|due diligence|deal team|investment proposal|underwrit|banking|insurance claim|patient|clinic|ip clause|amendment|written consent|closing checklist|statement of work|process letter|equity research|swap curve|ar aging|policy|dpa|data processing agreement|case brief|invention disclosure|patent|employment policy|entity compliance|renewal)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "frontend-design",
    label: "Frontend, UI/UX & design systems",
    purpose: "Interfaces, design systems, motion, typography, brand and accessibility.",
    match: ({ name, description }) =>
      /\b(ui|ux|user interface|design system|figma|tailwind|css|typograph|brand|accessib|frontend|front-end|react component|vue|svelte|animation|motion design|visual design|design engineer|moodboard|hi-fi|high-fidelity|prototype|wireframe|mockup|design artifact|design polish|widget|onboarding flow|storybook|navigation|nav-|color|theme|icon|illustration|email template|html email|landing page|faq|rich text|search engine|realtime collaboration|geospatial|\bmaps?\b|spec generator|design export|minimalist|browser control)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "media-creative",
    label: "Media & creative generation",
    purpose: "Generate and edit images, video, audio, 3D, shaders and documents.",
    match: ({ name, description }) =>
      /\b(image|images|video|audio|music|shader|glsl|3d model|three\.?js|sticker|podcast|voice|speech|creative|illustrat|photo|ppt|presentation|deck|slide|docx|xlsx|pdf|spreadsheet|screenshots?|remotion|captions|multimedia)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "agent-workflows",
    label: "Agent operating discipline & personal productivity",
    purpose:
      "How an agent works: session discipline, verification, coaching, skill authoring, trackers and personal tooling.",
    match: ({ name, description }) =>
      /\b(grill|interview the user|coach|remind|habit|anti-sleep|caffeinate|verification before|before completion|deep think|reasoning workflow|todo|to-do plan|tmux|keybind|shortcut|new skill|skill template|plugin author|cowork|plan execution|executing plans|deep work|morning note|journal|goal|milestone|checklist|discipline|standup|sync-?up|rename|folder-specific|decisions|overthinking|compress its|keep track|guardrail|slash command|recurring interval|rubric|task contract|alignment conversation|manually-invoked|re-pitch|router over|which skill|file organizer|water and sleep)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "docs-content",
    label: "Documentation & content writing",
    purpose: "Author and maintain docs, copy, translations and knowledge bases.",
    match: ({ name, description }) =>
      /\b(documentation|docs|readme|user guide|api doc|runbook|copywriting|copy writer|translation|translat|localiz|blog|content writer|writing|knowledge base|changelog|glossary|handbook|outline|manuscript|memo|note|documentation portal|\badr\b|decision record)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "ml-ai-research",
    label: "ML, LLM & AI research",
    purpose: "Models, prompting, RAG, embeddings, evaluation and AI research workflows.",
    match: ({ name, description }) =>
      /\b(llm|large language|prompt engineer|prompt engineering|rag|embedding|vector search|fine-?tun|train|training|model (?:evaluat|serv|infer)|inference|benchmark|machine learning|\bml\b|\bai\b|neural|transformer|token|dataset|evaluat|gradio|hugging face|\blora\b|deepseek|thinking mode|gpt|claude|gemini)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "scientific-computing",
    label: "Scientific & biomedical computing",
    purpose: "Biology, chemistry, physics, genomics and medical research tooling.",
    match: ({ name, description }) =>
      /\b(bioinformatic|biolog|genomic|protein|molecul|chemistry|chemical|physics|medical|clinical|crystallograph|phylogen|sequenc|scientific comput|research pipeline|single-cell|scverse|h5ad|statistic)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "data-pipelines",
    label: "Data, databases, BI & pipelines",
    purpose: "SQL/NoSQL stores, ETL/ELT, warehousing, lakehouses, BI semantics and analytics.",
    match: ({ name, description }) =>
      /\b(database|sql|postgres|mysql|mongodb|redis|etl|elt|warehouse|lakehouse|dbt|data pipeline|analytics|query (?:plan|optim)|index (?:design|tuning)|schema (?:design|migrat)|data quality|data contract|data lineage|data catalog|spreadsheet|reporting|visualization|visualiz|dashboard|lookml|powerbi|tableau|hadoop|hbase|hive|nifi|databricks|bigquery|metrics)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "devops-infrastructure",
    label: "DevOps, cloud & infrastructure",
    purpose: "Build, deploy, containerize, observe and operate systems and cloud platforms.",
    match: ({ name, description }) =>
      /\b(devops|deploy|deployment|release|ci\/cd|ci pipeline|docker|container|kubernetes|\bk8s\b|terraform|infra|infrastructure|observ|monitor|metric|alert|cloud|serverless|lambda|sre|incident|health check|gke|gcp|aws|azure|iam|backup|disaster recovery|lifecycle policy|mtls|remote compute|ssh|turborepo|monorepo|caching|git workflow|platform engineering|merge conflict|worktree|remote repository|branch protect)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "product-growth",
    label: "Product, growth & business operations",
    purpose: "Planning, roadmaps, marketing, SEO, sales, CRM, hiring and business operations.",
    match: ({ name, description }) =>
      /\b(product|roadmap|prd|epic|backlog|marketing|seo|growth|sales|crm|budget|hiring|recruit|survey|experiment|conversion|attribution|go-to-market|positioning|analytics dashboard|resume|social|newsletter|email campaign|flier|flyer|ad copy|lead management|lead scoring|call list|outreach|demand|scheduling|business report|teaser|expansion|discovery question)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "code-engineering",
    label: "Software engineering & language guides",
    purpose: "Language, framework and architecture guidance for building software.",
    match: ({ name, description }) =>
      /\b(code|coding|softw|engineer|api|backend|frontend|typescript|javascript|python|rust|golang|java\b|kotlin|swift|scala|c\+\+|dotnet|\.net|react|next\.?js|vue|svelte|node|express|django|flask|spring|android|ios|flutter|react native|architecture|refactor|migrat|debug|bug|pattern|framework|library|package|module|sdk|cli tool|smart contract|web3|blockchain|workflow engine|nft|token standard|develop app)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "shell-utilities",
    label: "Shell, CLI & scripting utilities",
    purpose: "Bash/shell scripting, terminal tooling and small automation helpers.",
    match: ({ name, description }) =>
      /\b(bash|shell|zsh|terminal|command line|cli\b|scripting|makefile|grep|awk|sed\b|cron|file process|batch|jq|json)/.test(
        `${name} ${description}`,
      ),
  },
  {
    id: "research-learning",
    label: "Research & learning",
    purpose: "Fact-finding, literature review, study planning and education workflows.",
    match: ({ name, description }) =>
      /\b(research|literature|investigation|stud(y|ying)|flashcard|education|thesis|syllabus|course material|lecture|exam prep|learning)/.test(
        `${name} ${description}`,
      ),
  },
];
const FALLBACK_GROUP = {
  id: "general-workflow",
  label: "General workflow & unclassified",
  purpose: "No capability signal matched a specific group; generic or reference material.",
};

function classify(record) {
  const description = String(record.metadata?.description ?? "").toLowerCase();
  const tags = Array.isArray(record.metadata?.tags)
    ? record.metadata?.tags.filter((t) => typeof t === "string").map((t) => t.toLowerCase())
    : [];
  const haystack = {
    name: record.dirName,
    description,
    tags,
    body: (record.body ?? "").toLowerCase(),
  };
  for (const group of GROUPS) {
    if (group.match(haystack)) return group.id;
  }
  return FALLBACK_GROUP.id;
}

const rows = [];
const buckets = new Map([...GROUPS, FALLBACK_GROUP].map((g) => [g.id, []]));
for (const name of await listSkillDirectories(root)) {
  let record;
  try {
    record = await readSkillRecord(root, name);
  } catch {
    buckets.get(FALLBACK_GROUP.id).push(name);
    rows.push({ name, group: FALLBACK_GROUP.id });
    continue;
  }
  const group = classify(record);
  buckets.get(group).push(name);
  rows.push({
    name,
    group,
    redirect:
      typeof record.metadata?.redirect === "string" && record.metadata.redirect.trim()
        ? record.metadata.redirect.trim()
        : undefined,
  });
}

const groups = [...GROUPS, FALLBACK_GROUP].map((g) => ({
  id: g.id,
  label: g.label,
  purpose: g.purpose,
  size: buckets.get(g.id).length,
  skills: buckets.get(g.id).sort((a, b) => a.localeCompare(b)),
}));

const report = {
  generatedAt: new Date().toISOString(),
  sourceRoot: path.relative(REPO_ROOT, root),
  summary: {
    skills: rows.length,
    groups: groups.length,
    largestGroup: groups.slice().sort((a, b) => b.size - a.size)[0]?.id ?? null,
    unclassified: buckets.get(FALLBACK_GROUP.id).length,
    redirects: rows.filter((row) => row.redirect).length,
  },
  precedence: groups.map((g) => g.id),
  groups,
  skills: rows.sort((a, b) => a.name.localeCompare(b.name)),
};

if (jsonOut) {
  const out = path.resolve(jsonOut);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, stableStringify(report));
}

const markdown = [
  "# Agent-skills capability taxonomy",
  "",
  `Generated: ${report.generatedAt}`,
  `Skills: ${report.summary.skills} in ${report.summary.skills} directory entries, classified into ${groups.length} capability groups.`,
  "",
  "Every skill lands in exactly one group. Groups are matched in precedence order —",
  "a skill that plausibly belongs to two groups is placed in the earlier (more specific)",
  "one. Classification is derived from the skill name, frontmatter description and tags,",
  "never from a hand-maintained list.",
  "",
  "## Group sizes",
  "",
  "| Group | Capability | Skills |",
  "|---|---|---:|",
  ...groups.map((g) => `| \`${g.id}\` | ${g.label} | ${g.size} |`),
  `| **total** | | **${rows.length}** |`,
  "",
  ...groups.flatMap((g) => [
    `## ${g.label} — \`${g.id}\` (${g.size})`,
    "",
    g.purpose,
    "",
    ...(g.size ? g.skills.map((name) => `- ${name}`) : ["_No skills in this group._"]),
    "",
  ]),
]
  .flat()
  .join("\n");

if (markdownOut) {
  const out = path.resolve(markdownOut);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${markdown}\n`);
}

if (!jsonOut && !markdownOut) {
  console.log(groups.map((g) => `${g.id}: ${g.size}`).join("\n") + `\ntotal: ${rows.length}`);
}
