/**
 * J4.2 — the retry-zero probe.
 *
 * This file is a deliberate flake with a deterministic reproduction: it fails its first attempt
 * and passes the second, and vitest re-runs a failed test in the same module instance, so the
 * module counter survives between attempts. Under `retry: 0` it must fail; under any inherited
 * retry (`retry: 2` on Windows, `retry: 1` on macOS, or the `retry: 2` in
 * `retry-probe.config.mts`) it passes.
 *
 * The flake lane runs it through `--retry=0` and *requires* the failure, which is what proves the
 * flag overrides the config on the platform the lane is running on. It is not part of any package
 * suite: it lives under `scripts/`, which no package's vitest `include` pattern reaches.
 */
import { expect, it } from "vitest";

let attempts = 0;

it("fails the first attempt and passes the second", () => {
  attempts += 1;
  expect(
    attempts,
    "an inherited retry turned this deterministic flake into a pass",
  ).toBeGreaterThan(1);
});
