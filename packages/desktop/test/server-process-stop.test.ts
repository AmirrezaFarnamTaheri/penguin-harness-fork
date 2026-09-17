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
    expect(owned.listenerCount("exit")).toBe(0);
  });

  it.each([false, true])(
    "quarantines only after the grace period (unreachable=%s)",
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
      expect(owned.kill).not.toHaveBeenCalled();
    },
  );

  it("does nothing when Electron has already cleared the owned child's PID", async () => {
    const { owned, server } = fixture();
    owned.exit();
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const stopping = stopEmbeddedServer(server);
    await vi.advanceTimersByTimeAsync(8000);
    await stopping;
    expect(request).not.toHaveBeenCalled();
    expect(forceStopUtilityProcess).not.toHaveBeenCalled();
    expect(owned.kill).not.toHaveBeenCalled();
    expect(owned.listenerCount("exit")).toBe(0);
  });

  it("removes its exit listener when the force-stop wait expires", async () => {
    const { owned, server } = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null)),
    );
    const stopping = stopEmbeddedServer(server);
    await vi.advanceTimersByTimeAsync(8000);
    await stopping;
    expect(forceStopUtilityProcess).toHaveBeenCalledExactlyOnceWith(server.child);
    expect(owned.listenerCount("exit")).toBe(0);
  });
});
