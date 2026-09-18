import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, utilityProcess: { fork: vi.fn() } }));
vi.mock("../src/utility-process-stop.js", () => ({
  forceStopUtilityProcess: vi.fn(async () => {}),
}));

import { utilityProcess } from "electron";
import { stopEmbeddedServer } from "../src/server-process.js";
import { forceStopUtilityProcess } from "../src/utility-process-stop.js";

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 4242;
  kill = vi.fn(() => true);
  exit(): void {
    this.pid = undefined;
    this.emit("exit", 0);
  }
}

function fixture() {
  const owned = new FakeUtilityProcess();
  // Electron's fork is replaced at the module boundary; no Electron or child is launched.
  vi.mocked(utilityProcess.fork).mockImplementation(() =>
    Object.assign(owned, {
      stdout: null,
      stderr: null,
      postMessage: vi.fn(),
    }),
  );
  return {
    owned,
    server: {
      child: utilityProcess.fork("fixture"),
      origin: "http://localhost:12345",
      token: "fixture-token",
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("embedded server stop wiring", () => {
  it("keeps authenticated graceful shutdown first and avoids quarantine after exit", async () => {
    const { owned, server } = fixture();
    const request = vi.fn(async () => {
      owned.exit();
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", request);
    await stopEmbeddedServer(server);
    expect(request).toHaveBeenCalledWith(`${server.origin}/api/desktop/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-token" },
      signal: expect.any(AbortSignal),
    });
    expect(forceStopUtilityProcess).not.toHaveBeenCalled();
    expect(owned.kill).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "escalates to the force stop only after the grace period (unreachable=%s)",
    async (unreachable) => {
      const { owned, server } = fixture();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (unreachable) throw new Error("unreachable");
          return new Response(null, { status: 202 });
        }),
      );
      const stopping = stopEmbeddedServer(server);
      await vi.advanceTimersByTimeAsync(5999);
      expect(forceStopUtilityProcess).not.toHaveBeenCalled();
      expect(owned.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(forceStopUtilityProcess).toHaveBeenCalledExactlyOnceWith(server.child);
      owned.exit();
      await stopping;
      // stopEmbeddedServer delegates the hard stop entirely; it never kills the child
      // itself, so the Windows taskkill branch is the one that runs on win32.
      expect(owned.kill).not.toHaveBeenCalled();
    },
  );

  it("completes when the child exits during the grace window", async () => {
    const { owned, server } = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202 })),
    );
    const stopping = stopEmbeddedServer(server);
    await vi.advanceTimersByTimeAsync(1000);
    owned.exit();
    await stopping;
    expect(forceStopUtilityProcess).not.toHaveBeenCalled();
    expect(owned.kill).not.toHaveBeenCalled();
  });

  it("settles the force-stop wait without the child ever exiting", async () => {
    const { owned, server } = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null)),
    );
    const stopping = stopEmbeddedServer(server);
    await vi.advanceTimersByTimeAsync(8000);
    await stopping;
    expect(forceStopUtilityProcess).toHaveBeenCalledExactlyOnceWith(server.child);
    expect(owned.kill).not.toHaveBeenCalled();
  });
});
