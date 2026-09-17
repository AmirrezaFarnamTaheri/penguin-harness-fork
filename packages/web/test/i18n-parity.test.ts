import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../../../scripts/check-i18n.mjs", import.meta.url));
const fixtures = fileURLToPath(new URL("../../../scripts/check-i18n.test.mjs", import.meta.url));

// Exercise the real command, not a second implementation of the parity rules.
// Keep the negative fixtures in the web test gate as well as node --test.
describe("bilingual dictionary parity", () => {
  it("checks the actual en/zh exports recursively", () => {
    const result = spawnSync(process.execPath, [checker], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("i18n parity check passed");
  }, 30_000);

  it("rejects broken dictionary fixtures through the same checker", () => {
    const result = spawnSync(process.execPath, ["--test", fixtures], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 30_000);
});
