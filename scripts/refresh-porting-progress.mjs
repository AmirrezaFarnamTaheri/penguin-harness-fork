#!/usr/bin/env node
/**
 * Regenerates porting_progress.json from the real HPORT track map.
 *
 * The previous file on disk was a stale backup: it claimed 163/163 projects
 * complete while only 14 of the real donor archives were tracked at all, and
 * pointed at a source root that does not exist. This generator emits the
 * verified state instead: 123 real archives across 11 tracks plus the 8
 * second-order Platform Planes, with a status that reflects what has actually
 * been measured in this workspace.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "porting_progress.json");

/** Archives the plan references but that are absent from disk. */
const ABSENT = [
  { zip: "Se7en-Pro-master.zip", reason: "referenced by the plan but not present on disk" },
  {
    zip: "huntx-output-34868179005-1.zip",
    reason: "referenced by the plan but not present on disk",
  },
  {
    zip: "ci-evidence-validate-browser-1.zip",
    reason: "referenced by the plan but not present on disk",
  },
  {
    zip: "ci-evidence-validate-frontend-1.zip",
    reason: "referenced by the plan but not present on disk",
  },
  {
    zip: "ci-evidence-release-smoke-windows-1.zip",
    reason: "referenced by the plan but not present on disk",
  },
];

/**
 * Verified per-track state. `complete` means the modules exist AND their tests
 * were run green in this workspace; `in_progress` means a subagent owns the
 * track and its files are mid-write; `pending` means no work started.
 */
const TRACK_STATE = {
  1: {
    status: "in_progress",
    modules: ["packages/core/src/browser/"],
    tests: "packages/core/test/browser/",
    note: "8 files, ~1105 LOC. Live subagent subagent-2ec25a21 owns this tree; do not edit.",
  },
  2: {
    status: "in_progress",
    modules: ["packages/core/src/sandbox/"],
    tests: "packages/core/test/sandbox/",
    note: "12 files, ~2449 LOC. Live subagent subagent-014e1a68 owns this tree; do not edit.",
  },
  3: {
    status: "complete",
    modules: ["packages/core/src/codegraph/"],
    tests: "packages/core/test/codegraph/",
    note: "20 modules, ~1667 LOC. 2 test files, 13 tests green. Typecheck clean.",
  },
  4: {
    status: "complete",
    modules: ["packages/core/src/memory/"],
    tests: "packages/core/test/memory/",
    note: "13 modules, ~4269 LOC. 13 test files, 381 tests green. Typecheck clean.",
  },
  5: {
    status: "in_progress",
    modules: [
      "packages/core/src/canvas/",
      "packages/core/src/terminal/",
      "packages/web/src/features/canvas/",
    ],
    tests: "packages/core/test/canvas/",
    note: "Live subagent subagent-ccb32fb7 owns this tree; do not edit.",
  },
  6: {
    status: "in_progress",
    modules: ["packages/core/src/fleet/", "packages/server/src/services/tool-fleet/"],
    tests: "packages/core/test/fleet/",
    note: "Live subagent subagent-bd7d10b1 owns this tree; do not edit.",
  },
  7: {
    status: "in_progress",
    modules: ["packages/core/src/engine/swarm/", "packages/core/src/engine/swe-loop/"],
    tests: "packages/core/test/engine/swarm/",
    note: "Live subagent subagent-f8bf106d owns this tree; do not edit.",
  },
  8: {
    status: "in_progress",
    modules: ["packages/core/src/agent/research/", "packages/core/src/llm/speculative/"],
    tests: "packages/core/test/llm/speculative/",
    note: "Live subagent subagent-8e667a11 owns this tree; do not edit.",
  },
  9: {
    status: "complete",
    modules: ["packages/core/src/prompts/"],
    tests: "packages/core/test/prompts/",
    note: "9 modules, ~5197 LOC. 4 test files, 102 tests green (archaeology 34, fingerprint 18, catalog 22, presets 28). 54 vendor prompts across 35 vendors; 6 persona presets. Delivered by subagent-c136730f.",
  },
  10: {
    status: "complete",
    modules: [".agents/skills/"],
    tests: "node scripts/skills/audit.mjs",
    note: "461 skills absorbed; registry 2106 -> 2567; audit errors 0 (27 soft warnings).",
  },
  11: {
    status: "in_progress",
    modules: ["packages/core/src/internal/evidence/", "packages/core/src/internal/visual-diff/"],
    tests: "packages/core/test/internal/evidence/, packages/core/test/internal/visual-diff/",
    note: "Dispatched to subagent-275ba181; the only real donor on disk is visual-review-1 (a CI evidence artifact bundle, not source).",
  },
};

/** The 8 second-order Platform Planes from plan section 15 (Batch E). */
const PLANES = [
  {
    id: 1,
    name: "AAOS kernel/memory plane",
    barrel: "packages/core/src/kernel/memory/",
    status: "pending",
  },
  {
    id: 2,
    name: "Swarm orchestration plane",
    barrel: "packages/core/src/engine/swarm/",
    status: "in_progress",
  },
  {
    id: 3,
    name: "Topology graph plane",
    barrel: "packages/core/src/kernel/graph/",
    status: "pending",
  },
  { id: 4, name: "Tool mesh plane", barrel: "packages/core/src/fleet/", status: "in_progress" },
  {
    id: 5,
    name: "Canvas cockpit plane",
    barrel: "packages/web/src/features/canvas/",
    status: "in_progress",
  },
  {
    id: 6,
    name: "Scientific research plane",
    barrel: "packages/core/src/agent/research/",
    status: "in_progress",
  },
  {
    id: 7,
    name: "Zero-trust sandbox plane",
    barrel: "packages/server/src/sandbox/",
    status: "pending",
  },
  {
    id: 8,
    name: "Terminal/desktop surface plane",
    barrel: "packages/core/src/terminal/",
    status: "in_progress",
  },
];

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
  const projects = {};
  let projectId = 0;
  const trackSummary = {};

  for (const [trackName, archives] of Object.entries(map)) {
    const num = trackNumber(trackName);
    const state = TRACK_STATE[num] ?? { status: "pending", modules: [], tests: "", note: "" };
    trackSummary[num] = {
      track: trackName.replace(/^\d+\.\s*/, ""),
      archives: archives.length,
      status: state.status,
      target_dirs: state.modules,
      test_dir: state.tests,
      note: state.note,
    };
    for (const zip of archives) {
      projectId += 1;
      projects[zip] = {
        project_id: projectId,
        status: state.status,
        track: Number(num),
        target_dirs: state.modules,
        exclusion_reason: "",
      };
    }
  }

  for (const absent of ABSENT) {
    if (!(absent.zip in projects)) {
      projectId += 1;
      projects[absent.zip] = {
        project_id: projectId,
        status: "absent",
        track: null,
        target_dirs: [],
        exclusion_reason: absent.reason,
      };
    }
  }

  const completeTracks = Object.values(trackSummary).filter((t) => t.status === "complete").length;
  const totalArchives = Object.values(trackSummary).reduce((n, t) => n + t.archives, 0);

  const doc = {
    target_project: "penguin-harness-fork",
    source_root: "D:\\GitHub\\HPORT",
    extracted_root: "D:\\GitHub\\HPORT\\extracted",
    compendium_path:
      "D:\\GitHub\\penguin-harness-fork\\PenguinHarness_Master_Porting_Compendium.md",
    master_plan: "2026-09-17-hport-porting-master-plan.md",
    generated_by: "scripts/refresh-porting-progress.mjs",
    last_updated: new Date().toISOString(),
    baseline_before_work: { test_files: 103, tests: 1492, suite_seconds: 48 },
    corpus: { archives_in_plan: totalArchives, tracks: 11, platform_planes: PLANES.length },
    tracks: {
      total: 11,
      complete: completeTracks,
      in_progress: 11 - completeTracks,
      per_track: trackSummary,
    },
    platform_planes: PLANES,
    projects_discovered: Object.keys(projects).length,
    projects: projects,
    verification_commands: {
      core_suite: "cd packages/core && npx vitest run",
      single_test: "cd packages/core && npx vitest run test/<dir>/<file>.test.ts",
      typecheck: "cd packages/core && npx tsc --noEmit -p tsconfig.json",
      skills_audit: "node scripts/skills/audit.mjs",
      note: "Do not use pnpm/npm run on this Windows box: they stall. Call the vitest/tsc binaries via npx.",
    },
    known_false_claims_in_previous_backup: [
      "claimed 163/163 projects complete; only 14 of 138 real archives were tracked",
      "claimed 2255 skills / 38 aliases; the real figures are 2567 skills and 3 true duplicate pairs",
      "named target files after upstream projects, which violates plan section 8",
    ],
  };

  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
  const tracks = Object.values(trackSummary);
  console.log(
    `wrote ${OUT}: ${totalArchives} archives across 11 tracks ` +
      `(${completeTracks} complete, ${11 - completeTracks} in progress), ` +
      `${ABSENT.length} absent, ${PLANES.length} planes pending.`,
  );
  for (const t of tracks)
    console.log(
      `  track ${String(t.track).padStart(2)} ${t.status.padEnd(11)} ${t.archives} archives`,
    );
}

main();
