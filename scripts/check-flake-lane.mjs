/**
 * J4.2 — the retry-zero flake-lane checker.
 *
 * A scheduled retry:0 lane is only a guarantee if nothing can quietly turn retries back on. The
 * required lanes absorb first-attempt failures on purpose (core/server `retry: 2` on Windows,
 * `retry: 1` on macOS; ci.yml's Windows job re-runs the whole command once for a pool-teardown
 * crash), so the flake lane is the only place a flake is *supposed* to show up red. This checker
 * keeps it that way:
 *
 *  1. `schedule-missing`      — the lane must have a `schedule:` trigger with a five-field cron.
 *  2. `dispatch-missing`      — and `workflow_dispatch`, so it can be run on demand.
 *  3. `permissions-missing`   — a declared `permissions:` block (J2 also checks this globally).
 *  4. `owner-missing`         — a header `# Owner:` line; a red run needs an owner to route to.
 *  5. `retry-flag-missing`    — every vitest invocation carries `--retry=0`, every Playwright
 *                               invocation carries `--retries=0` — in a `run:` body *and* in a
 *                               `strategy.matrix` entry's `tests:` command, which is how this lane
 *                               names most of its suites.
 *  6. `retry-flag-nonzero`    — no `--retry=<n>` / `--retries=<n>` with n != 0.
 *  7. `masking`               — no `continue-on-error: true`, no loop inside a test step, and no
 *                               run body invoking the same suite twice (a shell re-run).
 *  8. `repeat-policy-missing` — the browser invocation pins `--repeat-each=` (no hidden repetition).
 *  9. `artifact-missing`      — at least one artifact upload, every upload carrying `retention-days`.
 * 10. `proof-missing`         — the lane runs the retry probe with `--retry=0` *and* the probe
 *                               config simulates an inherited retry (`retry: 2`); without both, the
 *                               self-check proves nothing.
 *
 * Usage: `node scripts/check-flake-lane.mjs`. Exit code 1 means at least one violation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LANE_PATH = ".github/workflows/flake-lane.yml";
export const PROBE_CONFIG_PATH = "scripts/flake-lane/retry-probe.config.mts";

/** The `run:` bodies of a workflow, with the 1-based line each starts on. */
export function collectRunBodies(text) {
  const lines = text.split("\n");
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[index]);
    if (match === null) continue;
    const indent = match[1].length;
    const body = [match[2]];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() !== "" && line.match(/^(\s*)/)[1].length <= indent) break;
      body.push(line);
      cursor += 1;
    }
    bodies.push({ line: index + 1, body: body.join("\n") });
  }
  return bodies;
}

/** `tests:` commands inside a `strategy.matrix` entry, with their 1-based line. */
export function collectMatrixCommands(text) {
  const commands = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*tests:\s*(\S.*?)\s*$/.exec(lines[index]);
    if (match !== null) commands.push({ line: index + 1, command: match[1] });
  }
  return commands;
}

/** Runs the ten rules over the workflow text. Pure: config text is passed in, nothing is read. */
export function checkLane(laneText, probeConfigText) {
  const violations = [];
  const report = (rule, detail) => violations.push({ rule, detail });

  if (!/^\s{2}schedule:\s*$/m.test(laneText)) {
    report("schedule-missing", "no `schedule:` trigger");
  } else {
    const crons = [...laneText.matchAll(/^\s*-\s*cron:\s*["'](.+?)["']\s*$/gm)].map((m) => m[1]);
    if (crons.length === 0) {
      report("schedule-missing", "`schedule:` present but no cron entry");
    }
    for (const cron of crons) {
      if (cron.trim().split(/\s+/).length !== 5) {
        report("schedule-missing", `cron "${cron}" is not a five-field cron`);
      }
    }
  }

  if (!/^\s{2}workflow_dispatch:\s*$/m.test(laneText)) {
    report("dispatch-missing", "no `workflow_dispatch` trigger");
  }
  if (!/^permissions:\s*$/m.test(laneText)) {
    report("permissions-missing", "no top-level `permissions:` block");
  }
  if (!/^#\s*Owner:\s*\S+/m.test(laneText)) {
    report("owner-missing", "no `# Owner:` line in the header");
  }

  const bodies = collectRunBodies(laneText);
  const testBodies = bodies.filter(({ body }) => /vitest|test:e2e|playwright test/.test(body));
  const matrixCommands = collectMatrixCommands(laneText).filter(({ command }) =>
    /vitest|test:e2e|playwright test/.test(command),
  );
  const invocations = [
    ...testBodies.map(({ line, body }) => ({ line, text: body, kind: "run body" })),
    ...matrixCommands.map(({ line, command }) => ({ line, text: command, kind: "matrix command" })),
  ];
  if (invocations.length === 0) {
    report("retry-flag-missing", "no test invocation found in any `run:` body or matrix entry");
  }
  for (const { line, text, kind } of invocations) {
    if (/vitest/.test(text) && !/--retry=0\b/.test(text)) {
      report("retry-flag-missing", `vitest ${kind} at line ${line} has no --retry=0`);
    }
    if (/test:e2e|playwright test/.test(text) && !/--retries=0\b/.test(text)) {
      report("retry-flag-missing", `Playwright ${kind} at line ${line} has no --retries=0`);
    }
    for (const match of text.matchAll(/--(retry|retries)=(\d+)/g)) {
      if (match[2] !== "0") {
        report(
          "retry-flag-nonzero",
          `line ${line}: --${match[1]}=${match[2]} can mask a first-attempt failure`,
        );
      }
    }
  }

  if (/continue-on-error:\s*true/.test(laneText)) {
    report("masking", "`continue-on-error: true` lets a failed suite pass the lane");
  }
  for (const { line, body } of testBodies) {
    const suiteRuns = body.match(/vitest run|test:e2e|playwright test/g) ?? [];
    if (suiteRuns.length > 1) {
      report("masking", `line ${line}: the same suite is invoked ${suiteRuns.length} times`);
    }
    if (/^\s*for\s+\w+\s+in\b/m.test(body)) {
      report("masking", `line ${line}: a shell loop in a test step can re-run a suite`);
    }
  }

  const browser = invocations.find(({ text }) => /test:e2e/.test(text));
  if (browser === undefined) {
    report("repeat-policy-missing", "no browser e2e invocation to pin --repeat-each on");
  } else if (!/--repeat-each=\d+/.test(browser.text)) {
    report("repeat-policy-missing", "the browser invocation does not pin --repeat-each");
  }

  const uploads = [...laneText.matchAll(/^\s*uses:\s*actions\/upload-artifact@[0-9a-f]{40}/gm)];
  if (uploads.length === 0) {
    report("artifact-missing", "no artifact upload step");
  }
  const retentions = (laneText.match(/^\s*retention-days:\s*\d+\s*$/gm) ?? []).length;
  if (uploads.length > retentions) {
    report(
      "artifact-missing",
      `${uploads.length} artifact upload(s) but only ${retentions} retention-days line(s)`,
    );
  }

  const proof = invocations.find(({ text }) => /retry-probe\.config\.mts/.test(text));
  if (proof === undefined || !/--retry=0\b/.test(proof.text)) {
    report("proof-missing", "the retry probe is not run with --retry=0");
  }
  // The probe config's *code* line, not a mention in its comments: `retry: 2` in prose must not
  // keep the rule satisfied once the setting itself is zero.
  if (!/^\s*retry:\s*[1-9]\d*\s*,?\s*$/m.test(probeConfigText)) {
    report(
      "proof-missing",
      `${PROBE_CONFIG_PATH} no longer simulates an inherited retry (needs \`retry: <nonzero>\`)`,
    );
  }

  return violations;
}

function main() {
  const laneText = readFileSync(path.join(ROOT, LANE_PATH), "utf8");
  const probeConfigText = readFileSync(path.join(ROOT, PROBE_CONFIG_PATH), "utf8");
  const violations = checkLane(laneText, probeConfigText);
  if (violations.length === 0) {
    console.log(`${LANE_PATH}: retries are zero, no re-run path, artifacts retained`);
    return;
  }
  for (const { rule, detail } of violations) {
    console.log(`${LANE_PATH}: ${rule} — ${detail}`);
  }
  process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();
