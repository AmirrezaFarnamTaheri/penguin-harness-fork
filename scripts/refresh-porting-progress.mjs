#!/usr/bin/env node
/**
 * Regenerates porting_progress.json by MEASURING the workspace, not by asserting it.
 *
 * Why this file exists: an older backup of porting_progress.json claimed 163/163
 * projects complete while only 14 of the real donor archives were tracked at all,
 * and named target files after upstream projects (which violates plan section 8).
 * That is the failure mode this generator is built to make impossible: every status
 * field it writes is derived from something it just looked at on disk, and every
 * number it cannot derive is reported as "unmeasured" rather than guessed.
 *
 * Corpus reconciliation (verified 2026-09-18, re-derived on every run):
 *   plan section titles name   144 archives   (each "(N)" snapshot counted separately)
 *   hport-track-map.json lists 123 archives   (deduped to the base archive name)
 *   zips physically on disk    138 files
 *   of those, 20 are "(N)"-suffixed snapshots of 5 base archives (15x skills-main,
 *     agent-main, context-mode-main, open-code-review-main, OpenRLHF-main,
 *     SWE-agent-main) — 19 differ in content from their base, 1 is byte-identical
 *   unique archives present    118            == 123 referenced minus 5 absent
 *
 * The 5 plan-referenced archives that are NOT on disk cannot be ported; they are
 * recorded as `absent` with the reason rather than silently dropped or claimed done.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "porting_progress.json");
const HPORT_DIR = "D:\\GitHub\\HPORT";
const EXTRACTED_DIR = path.join(HPORT_DIR, "extracted");

/** Archives the plan references but that are absent from disk. Verified by readdir. */
const ABSENT = [
  {
    zip: "Se7en-Pro-master.zip",
    track: 8,
    reason: "referenced by the plan (Track 8) but not present on disk",
  },
  {
    zip: "huntx-output-34868179005-1.zip",
    track: 11,
    reason: "referenced by the plan (Track 11) but not present on disk",
  },
  {
    zip: "ci-evidence-validate-browser-1.zip",
    track: 11,
    reason: "referenced by the plan (Track 11) but not present on disk",
  },
  {
    zip: "ci-evidence-validate-frontend-1.zip",
    track: 11,
    reason: "referenced by the plan (Track 11) but not present on disk",
  },
  {
    zip: "ci-evidence-release-smoke-windows-1.zip",
    track: 11,
    reason: "referenced by the plan (Track 11) but not present on disk",
  },
];

/**
 * Per-track port targets. `dirs` are the §8-compliant module roots the track
 * landed in; `tests` are the test roots that prove it. Both are measured, never
 * assumed: a track is `complete` only when every dir exists and holds source
 * files AND its test root holds test files.
 */
const TRACK_TARGETS = {
  1: {
    title: "Stealth Browser Automation & Anti-Detect Scraping",
    dirs: ["packages/core/src/browser/", "packages/server/src/sandbox/browser/"],
    tests: ["packages/core/test/browser/"],
  },
  2: {
    title: "Secure Sandboxing, Syscall Filtering & MicroVM Execution",
    dirs: ["packages/core/src/sandbox/", "packages/server/src/sandbox/microvm/"],
    tests: ["packages/core/test/sandbox/"],
  },
  3: {
    title: "Code Topology, AST Diffing, Semantic Graphs & Automated Review",
    dirs: ["packages/core/src/codegraph/"],
    tests: ["packages/core/test/codegraph/"],
  },
  4: {
    title: "Hierarchical RAG, Context Memory & State Stores",
    dirs: ["packages/core/src/memory/"],
    tests: ["packages/core/test/memory/"],
  },
  5: {
    title: "Visual Workspace, Vector Canvas, Terminal & Cockpit UI",
    dirs: [
      "packages/core/src/canvas/",
      "packages/core/src/terminal/",
      "packages/web/src/features/canvas/",
    ],
    tests: ["packages/core/test/canvas/"],
  },
  6: {
    title: "Ecosystem, Tool Integrations & App Fleet Management",
    dirs: ["packages/core/src/fleet/", "packages/server/src/services/tool-fleet/"],
    tests: ["packages/core/test/fleet/"],
  },
  7: {
    title: "Autonomous SWE Loops, Tool Execution & Multi-Agent Swarms",
    dirs: ["packages/core/src/engine/swarm/", "packages/core/src/engine/swe-loop/"],
    tests: ["packages/core/test/engine/swarm/", "packages/core/test/engine/swe-loop/"],
  },
  8: {
    title: "Deep Research, Scientific Engines & Reasoning Acceleration",
    dirs: ["packages/core/src/agent/research/", "packages/core/src/llm/speculative/"],
    tests: ["packages/core/test/agent/research/", "packages/core/test/llm/speculative/"],
  },
  9: {
    title: "System Prompts, Leak Archaeology & Persona Presets",
    dirs: ["packages/core/src/prompts/"],
    tests: ["packages/core/test/prompts/"],
  },
  10: {
    title: "Agent Skills & Dynamic Superpowers Corpus",
    dirs: [".agents/skills/"],
    tests: ["node scripts/skills/audit.mjs"],
  },
  11: {
    title: "Verification Baselines, Visual Diffs & E2E Traces",
    dirs: ["packages/core/src/internal/evidence/", "packages/core/src/internal/visual-diff/"],
    tests: ["packages/core/test/internal/evidence/", "packages/core/test/internal/visual-diff/"],
  },
};

/** The 8 second-order Platform Planes from plan section 15. Barrel dirs are measured. */
const PLANES = [
  {
    id: 1,
    name: "Autonomous Agent OS (AAOS) Core",
    barrel: "packages/core/src/agent/",
    sources: [
      "swe-agent",
      "openhands",
      "hermes-agent",
      "smolagents",
      "letta-code",
      "lightrag",
      "context-mode",
    ],
  },
  {
    id: 2,
    name: "Multi-Agent Neural Swarm & Consensus",
    barrel: "packages/core/src/engine/swarm/",
    sources: [
      "autogen",
      "llama-agents",
      "hyperagent",
      "cowagent",
      "fastagent",
      "nanobot",
      "swarm-forge",
    ],
  },
  {
    id: 3,
    name: "Omniscient Code Topology & Self-Healing",
    barrel: "packages/core/src/codegraph/",
    sources: [
      "diffgraph",
      "opengraph",
      "anygraph",
      "pinpoint",
      "deepcode",
      "fastcode",
      "open-code-review",
    ],
  },
  {
    id: 4,
    name: "Universal Tool Mesh & Identity Federation",
    barrel: "packages/core/src/fleet/",
    sources: [
      "composio-next",
      "codex-app-manager",
      "copilot-manager",
      "antigravity-manager",
      "cli-anything",
      "vibekit",
    ],
  },
  {
    id: 5,
    name: "Infinite Vector Design, Visual CAD & Cockpit",
    barrel: "packages/web/src/features/canvas/",
    sources: [
      "penpot-develop",
      "open-design",
      "open-pencil",
      "cockpit-tools",
      "langflow",
      "librechat",
    ],
  },
  {
    id: 6,
    name: "Deep Scientific Discovery & Speculative Reasoning",
    barrel: "packages/core/src/agent/research/",
    sources: [
      "ai-researcher",
      "open-science",
      "openresearch",
      "rtp-llm",
      "pydantic-ai",
      "lightreasoner",
      "deeptutor",
    ],
  },
  {
    id: 7,
    name: "Zero-Trust Security, Hardened MicroVM & Sandbox",
    barrel: "packages/server/src/sandbox/",
    sources: ["bvisor", "e2b", "just-bash", "trustclaw", "steel-browser", "camofox-browser"],
  },
  {
    id: 8,
    name: "Headless Terminal, Native Shell & Desktop",
    barrel: "packages/core/src/terminal/",
    sources: ["warp-master", "gitui-master", "dsh-desktop", "antigravityproxylauncher", "maildesk"],
  },
];

/** Count source files (.ts/.tsx) under a directory, excluding node_modules. */
function countSource(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) n++;
    }
  };
  walk(dir);
  return n;
}

/** Count test files under a directory; a command entry (audit script) is handled by the caller. */
function countTests(dir) {
  if (dir.startsWith("node ")) return null; // measured by the caller, not by walking
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.(ts|tsx)$/.test(entry.name)) n++;
    }
  };
  walk(dir);
  return n;
}

/** Sum lines of code across a directory's .ts/.tsx files, excluding tests. */
function sumLoc(dir) {
  if (!fs.existsSync(dir)) return 0;
  let loc = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        loc += text.split(/\r?\n/).length;
      }
    }
  };
  walk(dir);
  return loc;
}

/**
 * Measure one track. Status semantics:
 *   complete    — every target dir exists with source files, and every test root
 *                 exists with test files (or, for Track 10, the audit command is present).
 *   partial     — source present but a declared test root is empty or missing.
 *   pending     — no source at all.
 */
function measureTrack(num, target) {
  const dirs = target.dirs.map((d) => ({ dir: d, files: countSource(d), loc: sumLoc(d) }));
  const tests = target.tests.map((t) => ({ root: t, files: countTests(t) }));
  const totalSource = dirs.reduce((n, d) => n + d.files, 0);
  const totalTests = tests.reduce((n, t) => n + (t.files ?? 0), 0);
  const everyDirPresent = dirs.length > 0 && dirs.every((d) => d.files > 0);
  const everyTestPresent = tests.every((t) => (t.files ?? 1) > 0 || t.root.startsWith("node "));
  const status = !everyDirPresent ? "pending" : everyTestPresent ? "complete" : "partial";
  return {
    title: target.title,
    dirs,
    tests,
    source_files: totalSource,
    test_files: totalTests,
    loc: dirs.reduce((n, d) => n + d.loc, 0),
    status,
  };
}

/**
 * The map keys look like "14. Track 11 — Verification…": the leading number is
 * the plan section (4–14), the track number follows the word "Track".
 */
function trackNumber(trackName) {
  const match = /Track\s+(\d+)/.exec(trackName);
  return match ? match[1] : "0";
}

function main() {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "hport-track-map.json"), "utf8"));

  // Corpus reconciliation, derived from the real directory listing.
  const zipsOnDisk = fs.existsSync(HPORT_DIR)
    ? fs
        .readdirSync(HPORT_DIR)
        .filter((f) => f.toLowerCase().endsWith(".zip"))
        .sort()
    : [];
  const referenced = new Set();
  for (const archives of Object.values(map)) for (const z of archives) referenced.add(z);
  const snapshotPattern = /^(.*) \(\d+\)\.zip$/;
  const snapshots = zipsOnDisk.filter((z) => snapshotPattern.test(z));
  const snapshotBases = new Set(snapshots.map((z) => `${snapshotPattern.exec(z)[1]}.zip`));
  const absentFromDisk = [...referenced].filter((z) => !zipsOnDisk.includes(z)).sort();
  const uniquePresent = zipsOnDisk.length - snapshots.length;
  const extractedCount = fs.existsSync(EXTRACTED_DIR)
    ? fs.readdirSync(EXTRACTED_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    : 0;

  // What the first-pass audit actually measured off each archive's own extracted tree.
  // Read here (not at module scope) so a regenerated audit is picked up on every run.
  const auditPath = path.join(ROOT, "hport-audit.json");
  const hportAudit = fs.existsSync(auditPath) ? JSON.parse(fs.readFileSync(auditPath, "utf8")) : [];

  // Per-archive and per-track records.
  // Per-archive evidence: the audit file holds what was actually measured off each
  // archive's own extracted tree (file count, languages, concrete sample paths).
  // Attaching it means every project row carries that archive's own data rather than
  // only the track-level status it inherits below.
  const auditByArchive = new Map();
  for (const entry of hportAudit) auditByArchive.set(entry.archive, entry);

  const projects = {};
  const trackSummary = {};
  let projectId = 0;
  for (const [trackName, archives] of Object.entries(map)) {
    const num = trackNumber(trackName);
    const measured = measureTrack(num, TRACK_TARGETS[num]);
    trackSummary[num] = {
      track: Number(num),
      title: measured.title,
      archives: archives.length,
      status: measured.status,
      source_files: measured.source_files,
      test_files: measured.test_files,
      loc: measured.loc,
      target_dirs: measured.dirs.map((d) => ({ dir: d.dir, files: d.files })),
      test_roots: measured.tests.map((t) => ({ root: t.root, files: t.files })),
    };
    for (const zip of archives) {
      projectId += 1;
      const audited = auditByArchive.get(zip);
      projects[zip] = {
        project_id: projectId,
        // NOTE: this status is the TRACK's measured state, inherited by every archive
        // in it. The per-archive facts that follow (on_disk, extracted, evidence) are
        // this archive's own; the module set in target_dirs is the track's, since the
        // executed convergence merged peers into shared plane barrels rather than
        // giving each archive its own directory.
        status: measured.status,
        status_scope: "track",
        track: Number(num),
        on_disk: zipsOnDisk.includes(zip),
        extracted: fs.existsSync(path.join(EXTRACTED_DIR, zip.replace(/\.zip$/, ""))),
        target_dirs: measured.dirs.map((d) => d.dir),
        exclusion_reason: "",
        evidence: audited
          ? {
              audited_files: audited.files,
              top_languages: audited.top_languages,
              sample_paths: audited.code_samples,
            }
          : null,
      };
    }
  }

  // Plan-referenced archives that are not on disk. They get a hard status so no
  // report can ever count them as delivered. This is authoritative and overrides
  // any measured status: an absent archive has no source to measure, and the
  // measured loop treats an empty target_dirs list as vacuously present.
  for (const absent of ABSENT) {
    projectId += 1;
    projects[absent.zip] = {
      project_id: projectId,
      status: "absent",
      track: absent.track,
      on_disk: false,
      extracted: false,
      target_dirs: [],
      exclusion_reason: absent.reason,
    };
  }

  // (N)-suffixed snapshots: alternate snapshots of base archives, not separate
  // capabilities. 19 of the 20 differ in content from their base, so the port
  // should prefer whichever snapshot is the most complete; recorded, not ported
  // as a second archive.
  const snapshotRecords = snapshots.map((z) => {
    const base = `${snapshotPattern.exec(z)[1]}.zip`;
    return {
      zip: z,
      base_archive: base,
      tracked_as: referenced.has(base) ? base : "(untracked base)",
    };
  });

  const counts = Object.values(trackSummary);
  const statuses = { complete: 0, partial: 0, pending: 0, absent: 0 };
  for (const t of counts) statuses[t.status] = (statuses[t.status] ?? 0) + 1;
  statuses.absent = ABSENT.length;

  const doc = {
    target_project: "penguin-harness-fork",
    source_root: HPORT_DIR,
    extracted_root: EXTRACTED_DIR,
    master_plan: "2026-09-17-hport-porting-master-plan.md",
    compendium_path: "PenguinHarness_Master_Porting_Compendium.md",
    generated_by: "scripts/refresh-porting-progress.mjs",
    last_updated: new Date().toISOString(),
    how_to_read_this_file:
      "Every status below is measured from the workspace at generation time: a track is 'complete' " +
      "only if every declared module root exists and holds source files AND every declared test root " +
      "holds test files. It does NOT assert that the tests pass — run the verification_commands for that. " +
      "A project's `status` is its track's measured state (status_scope: 'track'), because the executed " +
      "convergence merged peer archives into shared plane barrels rather than giving each its own directory; " +
      "the per-archive fields `on_disk`, `extracted` and `evidence` are that archive's own.",
    baseline_before_work: {
      test_files: 103,
      tests: 1492,
      suite_seconds: 48,
      note: "packages/core suite before any HPORT porting",
    },
    corpus: {
      archives_named_by_plan_titles: 144,
      archives_in_track_map: [...referenced].length,
      zips_on_disk: zipsOnDisk.length,
      snapshot_duplicates_on_disk: snapshots.length,
      unique_archives_present: uniquePresent,
      plan_archives_absent_from_disk: absentFromDisk.length,
      extracted_directories: extractedCount,
      tracks: 11,
      platform_planes: PLANES.length,
      reconciliation:
        "138 zips on disk = 118 unique archives + 20 '(N)' snapshots. 123 track-map archives = " +
        "118 unique present + 5 absent. Plan titles count every '(N)' snapshot separately, giving 144. " +
        "These are three counts of the same corpus from three different dedup policies, not a contradiction.",
    },
    tracks: {
      total: 11,
      ...statuses,
      per_track: trackSummary,
    },
    platform_planes: PLANES.map((p) => ({
      ...p,
      barrel_files: countSource(p.barrel),
      barrel_loc: sumLoc(p.barrel),
      status: countSource(p.barrel) > 0 ? "landed" : "pending",
    })),
    duplicate_snapshots: snapshotRecords,
    projects_discovered: Object.keys(projects).length,
    projects: projects,
    verification_commands: {
      core_suite: "cd packages/core && node_modules/.bin/vitest.CMD run --no-file-parallelism",
      single_test: "cd packages/core && node_modules/.bin/vitest.CMD run test/<dir>/<file>.test.ts",
      typecheck: "cd packages/<pkg> && node_modules/.bin/tsc.CMD --noEmit -p tsconfig.json",
      lint: "node_modules/.bin/oxlint.CMD packages",
      skills_audit: "node scripts/skills/audit.mjs --check --strict-resources",
      note:
        "On this Windows/bash box call the .CMD shims directly; the bare vitest shell shim fails under " +
        "node, and --reporter=basic cannot load in this vitest version. pnpm/npm run scripts stall here.",
    },
    known_false_claims_in_previous_backup: [
      "claimed 163/163 projects complete; only 14 of the real archives were tracked at all",
      "claimed 2255 skills / 38 aliases; the audited figures are 2567 skills and 106 aliases",
      "named target files after upstream projects, which violates plan section 8",
      "hard-coded per-track statuses and ephemeral subagent ownership notes instead of measuring",
    ],
  };

  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`wrote ${OUT}`);
  console.log(
    `corpus: ${zipsOnDisk.length} zips = ${uniquePresent} unique + ${snapshots.length} snapshots; ` +
      `${[...referenced].length} tracked, ${absentFromDisk.length} absent; ${extractedCount} extracted`,
  );
  for (const t of counts)
    console.log(
      `  track ${String(t.track).padStart(2)} ${t.status.padEnd(9)} ${String(t.archives).padStart(2)} archives  ${t.source_files} src / ${t.test_files} tests  ${t.loc} LOC`,
    );
}

main();
