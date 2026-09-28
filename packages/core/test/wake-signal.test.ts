/**
 * Process-lifecycle behavior tests for WakeSignal.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("WakeSignal", () => {
  // Budget for the child process. This used to be 3s, which could not tell a
  // timer leak apart from a slow box: a leaked timer hangs for the full 60s
  // wait below, but so does a cold `node --import tsx` boot when several suites
  // are competing for the CPU. Measured: ~190ms idle, ~3.5s with 250
  // concurrent node workers. 20s clears that with room to spare while staying
  // 3x below the 60s hang a real leak produces, so the leak still fails fast.
  const CHILD_TIMEOUT_MS = 20_000;

  it(
    "keeps a standalone process alive while wait() is pending without leaving timers behind",
    () => {
      const moduleUrl = new URL(
        "../src/environment/tools/background/wake-signal.ts",
        import.meta.url,
      ).href;
      const script = `
      const { WakeSignal } = await import(${JSON.stringify(moduleUrl)});

      await new WakeSignal().wait(50);
      process.stdout.write("timeout\\n");

      const signal = new WakeSignal();
      setTimeout(() => signal.notify(), 10);
      await signal.wait(60_000);
      process.stdout.write("notified\\n");
    `;

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        { encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
      );

      // Surface the child's own output on failure — a bare ETIMEDOUT says
      // nothing about whether it hung or merely ran slowly.
      // `SpawnSyncReturns.error` is a bare `Error`, which has no `code`; the
      // errno lives on `ErrnoException`. Narrow instead of casting so the
      // diagnostic still says "none" when there is no error at all.
      const errorCode =
        result.error !== undefined && "code" in result.error ? String(result.error.code) : "none";
      const detail = `error=${errorCode} status=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr?.slice(0, 500))}`;

      expect(result.error, `child process detail: ${detail}`).toBeUndefined();
      expect(result.status, `child process detail: ${detail}`).toBe(0);
      expect(result.stdout, `child process detail: ${detail}`).toBe("timeout\nnotified\n");
    },
    // Must exceed CHILD_TIMEOUT_MS so a real leak surfaces as the assertion
    // above (which names the cause) rather than as a bare vitest timeout.
    CHILD_TIMEOUT_MS + 10_000,
  );
});
