/**
 * J4.2 — config for the retry-zero probe.
 *
 * `retry: 2` is deliberate: it stands in for what core's and the server's configs inherit on
 * Windows (`retry: 2`) and macOS (`retry: 1`), so the lane's `--retry=0` is proven to override a
 * nonzero config rather than merely agreeing with a config that was already zero. If the flag ever
 * stops overriding the config, the probe passes and the lane's self-check fails.
 *
 * `include` names only the probe so that running vitest at the repository root cannot reach any
 * package suite, and `passWithNoTests` stays false: a probe that stopped being collected must fail
 * loudly, not report success over zero tests.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/retry-probe.test.ts"],
    passWithNoTests: false,
    retry: 2,
  },
});
