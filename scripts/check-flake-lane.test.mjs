/**
 * J4.2/J4.4 — the retry-zero lane checker's cases.
 *
 * Negatives are mutations of the *real* lane file: each rule is exercised against the text this
 * repository actually runs, so a rule cannot pass because it was tested against a friendlier copy
 * that drifted away from the workflow. `mutate()` asserts the anchor existed, so a mutation that
 * stops applying fails here instead of silently testing nothing.
 *
 * `node --test scripts/check-flake-lane.test.mjs`
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { checkLane, LANE_PATH, PROBE_CONFIG_PATH } from "./check-flake-lane.mjs";

const ROOT = new URL("..", import.meta.url);
const lane = readFileSync(new URL(LANE_PATH, ROOT), "utf8");
const probeConfig = readFileSync(new URL(PROBE_CONFIG_PATH, ROOT), "utf8");

function mutate(text, from, to) {
  assert.ok(text.includes(from), `mutation anchor is gone from the lane: ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

const rulesOf = (text, config = probeConfig) => checkLane(text, config).map(({ rule }) => rule);

test("the committed lane passes every rule", () => {
  assert.deepEqual(checkLane(lane, probeConfig), []);
});

test("no schedule trigger is rejected", () => {
  assert.deepEqual(rulesOf(mutate(lane, "  schedule:", "  push:")), ["schedule-missing"]);
});

test("a scheduled lane without workflow_dispatch is rejected", () => {
  assert.deepEqual(rulesOf(mutate(lane, "  workflow_dispatch:", "  push:")), ["dispatch-missing"]);
});

test("a missing permissions block is rejected", () => {
  assert.deepEqual(rulesOf(mutate(lane, "permissions:\n  contents: read", "# no permissions")), [
    "permissions-missing",
  ]);
});

test("an ownerless lane is rejected", () => {
  assert.deepEqual(rulesOf(mutate(lane, "# Owner: the release owner", "# owner: unclaimed")), [
    "owner-missing",
  ]);
});

test("a vitest invocation without --retry=0 is rejected", () => {
  const mutated = mutate(
    lane,
    "exec vitest run --retry=0 --passWithNoTests\n          - shard: server",
    "exec vitest run --passWithNoTests\n          - shard: server",
  );
  assert.ok(rulesOf(mutated).includes("retry-flag-missing"));
});

test("an inherited retry (--retry=2) is rejected even though the flag is present", () => {
  const mutated = mutate(
    lane,
    "pnpm --filter @prismshadow/penguin-core exec vitest run --retry=0 --passWithNoTests \\",
    "pnpm --filter @prismshadow/penguin-core exec vitest run --retry=2 --passWithNoTests \\",
  );
  assert.ok(rulesOf(mutated).includes("retry-flag-nonzero"));
});

test("a browser invocation without --retries=0 is rejected", () => {
  const mutated = mutate(lane, "--retries=0 --repeat-each=1", "--repeat-each=1");
  assert.ok(rulesOf(mutated).includes("retry-flag-missing"));
});

test("continue-on-error is rejected", () => {
  const mutated = mutate(
    lane,
    "      - name: First-attempt log",
    "      - name: First-attempt log\n        continue-on-error: true",
  );
  assert.ok(rulesOf(mutated).includes("masking"));
});

test("running the same suite twice inside one step is rejected", () => {
  const mutated = mutate(
    lane,
    "        run: |\n          set -o pipefail\n          if pnpm exec vitest run --config",
    "        run: |\n          set -o pipefail\n          pnpm exec vitest run --config scripts/flake-lane/retry-probe.config.mts --retry=0\n          if pnpm exec vitest run --config",
  );
  assert.ok(rulesOf(mutated).includes("masking"));
});

test("a shell retry loop is rejected", () => {
  const mutated = mutate(
    lane,
    "        run: |\n          set -o pipefail\n          if pnpm exec vitest run --config",
    "        run: |\n          for attempt in 1 2; do\n          if pnpm exec vitest run --config",
  );
  assert.ok(rulesOf(mutated).includes("masking"));
});

test("dropping the repetition pin is rejected", () => {
  assert.ok(rulesOf(mutate(lane, " --repeat-each=1", "")).includes("repeat-policy-missing"));
});

test("a lane without artifact uploads is rejected", () => {
  const mutated = mutate(
    lane,
    "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "uses: actions/upload-artifact-disabled@ea165f8d65b6e75b540449e92b4886f43607fa02",
  );
  // `mutate` replaces only the first occurrence; remove the rest so no upload remains.
  const stripped = mutated.split(
    "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  );
  const all = stripped.join(
    "uses: actions/upload-artifact-disabled@ea165f8d65b6e75b540449e92b4886f43607fa02",
  );
  assert.ok(rulesOf(all).includes("artifact-missing"));
});

test("an upload without retention-days is rejected", () => {
  assert.ok(
    rulesOf(mutate(lane, "          retention-days: 14\n", "")).includes("artifact-missing"),
  );
});

test("removing --retry=0 from the probe step is rejected", () => {
  const mutated = mutate(
    lane,
    "--config scripts/flake-lane/retry-probe.config.mts --retry=0 \\",
    "--config scripts/flake-lane/retry-probe.config.mts \\",
  );
  assert.ok(rulesOf(mutated).includes("proof-missing"));
});

test("weakening the probe config (retry 2 -> 0) is rejected", () => {
  const weakened = mutate(probeConfig, "    retry: 2,\n", "    retry: 0,\n");
  assert.ok(rulesOf(lane, weakened).includes("proof-missing"));
});

test("the probe-config rule reads the setting, not a mention of it in prose", () => {
  // The config explains `retry: 2` in its comments; editing only that sentence must change nothing.
  const paraphrased = mutate(probeConfig, "(`retry: 2`)", "(`retry: 2`, the Windows value)");
  assert.deepEqual(checkLane(lane, paraphrased), []);
});

test("a zero-field cron is rejected", () => {
  assert.ok(rulesOf(mutate(lane, '"40 3 * * *"', '"40 3 *"')).includes("schedule-missing"));
});
