import { describe, expect, it, vi } from "vitest";

const command = vi.hoisted(() => ({
  error: null as Error | null,
  calls: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile(
    file: string,
    args: readonly string[],
    options: object,
    callback: (error: Error | null) => void,
  ) {
    command.calls(file, args, options);
    callback(command.error);
  },
}));

import { forceStopUtilityProcess } from "../src/utility-process-stop.js";

function child(): { pid: number | undefined; kill: ReturnType<typeof vi.fn<() => boolean>> } {
  return { pid: 4242, kill: vi.fn(() => true) };
}

describe("owned desktop utility process quarantine", () => {
  it.each([null, new Error("access denied or timeout")])(
    "uses bounded, shell-free taskkill execution and handles its result (%s)",
    async (error) => {
      command.error = error;
      command.calls.mockClear();
      const owned = child();
      await forceStopUtilityProcess(owned, "win32");
      expect(command.calls).toHaveBeenCalledExactlyOnceWith(
        "taskkill",
        ["/pid", "4242", "/t", "/f"],
        { windowsHide: true, timeout: 2000 },
      );
      expect(owned.kill).toHaveBeenCalledTimes(error === null ? 0 : 1);
    },
  );

  it("terminates the Windows tree before the root can orphan its PTYs", async () => {
    const owned = child();
    const run = vi.fn(async (file: string, args: readonly string[]) => {
      expect(owned.kill).not.toHaveBeenCalled();
      expect(file).toBe("taskkill");
      expect(args).toEqual(["/pid", "4242", "/t", "/f"]);
      return true;
    });
    await forceStopUtilityProcess(owned, "win32", run);
    expect(run).toHaveBeenCalledOnce();
    expect(owned.kill).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, 1, -1, 1.5, NaN, Infinity, process.pid, process.ppid])(
    "does not target an absent, invalid or host PID (%s)",
    async (pid) => {
      const owned = child();
      owned.pid = pid;
      const run = vi.fn(async () => true);
      await forceStopUtilityProcess(owned, "win32", run);
      expect(run).not.toHaveBeenCalled();
      expect(owned.kill).not.toHaveBeenCalled();
    },
  );

  it.each(["linux", "darwin"] as const)(
    "does not assume a utility PID is a process-group leader on %s",
    async (platform) => {
      const owned = child();
      const run = vi.fn(async () => true);
      await forceStopUtilityProcess(owned, platform, run);
      expect(run).not.toHaveBeenCalled();
      expect(owned.kill).toHaveBeenCalledOnce();
    },
  );

  it.each([false, new Error("taskkill unavailable")])(
    "falls back to the still-owned root when tree termination fails (%s)",
    async (result) => {
      const owned = child();
      await forceStopUtilityProcess(owned, "win32", async () => {
        if (result instanceof Error) throw result;
        return result;
      });
      expect(owned.kill).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, 5252])(
    "does not kill a stale PID after the asynchronous tree attempt (%s)",
    async (nextPid) => {
      const owned = child();
      await forceStopUtilityProcess(owned, "win32", async () => {
        owned.pid = nextPid;
        return false;
      });
      expect(owned.kill).not.toHaveBeenCalled();
    },
  );
});
