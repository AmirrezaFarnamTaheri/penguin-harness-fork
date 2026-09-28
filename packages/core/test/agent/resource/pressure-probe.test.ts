import { describe, it, expect } from "vitest";
import {
  defaultPressurePaths,
  ResourcePressureProbe,
} from "../../../src/agent/resource/pressure-probe.js";
import type { StatfsLike } from "../../../src/agent/resource/pressure-probe.js";

/** A statfs double: 1 GiB blocks of 4096, 25% free, recorded per call. */
function fakeStatfs(overrides: Partial<Record<string, number>> = {}): {
  fn: StatfsLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fn: StatfsLike = (path) => {
    calls.push(path);
    return Promise.resolve({
      bsize: 4096,
      blocks: 262_144, // 1 GiB total
      bavail: 65_536, // 256 MiB free
      bfree: 65_536,
      ...overrides,
    });
  };
  return { fn, calls };
}

const GB = 1024 * 1024 * 1024;

describe("ResourcePressureProbe — what the numbers mean", () => {
  it("reports memory from an instantaneous counter and never caches it", async () => {
    let total = 8 * GB;
    let free = 2 * GB;
    const probe = new ResourcePressureProbe({
      paths: ["/data"],
      memory: { free: () => free, total: () => total },
      statfs: fakeStatfs().fn,
    });

    const first = await probe.probe();
    expect(first.memory.kind).toBe("os-counter");
    expect(first.memory.totalBytes).toBe(8 * GB);
    expect(first.memory.freeBytes).toBe(2 * GB);
    expect(first.memory.usedBytes).toBe(6 * GB);
    expect(first.memory.usedRatio).toBeCloseTo(0.75);
    expect(first.memory.ageMs).toBe(0);
    // The caveat travels in the data, so a formatter cannot silently drop it.
    expect(first.memory.caveat).toMatch(/not an allocation budget/);

    // Memory is re-read every probe: it costs half a microsecond, so caching it would add
    // staleness for no saved work.
    total = 4 * GB;
    free = 1 * GB;
    const second = await probe.probe();
    expect(second.memory.totalBytes).toBe(4 * GB);
  });

  it("labels disk as a cached reading and reports its age", async () => {
    let t = 0;
    const { fn } = fakeStatfs();
    const probe = new ResourcePressureProbe({ paths: ["/data"], now: () => t, statfs: fn });

    const fresh = await probe.probe();
    expect(fresh.disks[0]?.kind).toBe("statfs-cache");
    expect(fresh.disks[0]?.servedFromCache).toBe(false);
    expect(fresh.disks[0]?.ageMs).toBe(0);
    expect(fresh.disks[0]?.totalBytes).toBe(GB);
    expect(fresh.disks[0]?.freeBytes).toBe(256 * 1024 * 1024);
    expect(fresh.disks[0]?.usedRatio).toBeCloseTo(0.75);
  });

  it("falls back to bfree when bavail is reported as zero", async () => {
    // Some platforms (Windows among them) report bavail = 0 while bfree is populated.
    // Without the fallback a healthy filesystem reads as 100% full, which is exactly the
    // kind of false alarm that trains an agent to ignore the monitor.
    const { fn } = fakeStatfs({ bavail: 0, bfree: 65_536 });
    const probe = new ResourcePressureProbe({ paths: ["/data"], statfs: fn });
    const report = await probe.probe();
    expect(report.disks[0]?.freeBytes).toBe(256 * 1024 * 1024);
    expect(report.disks[0]?.usedRatio).toBeCloseTo(0.75);
  });

  it("never reports NaN when total memory is unavailable", async () => {
    const probe = new ResourcePressureProbe({
      paths: ["/data"],
      memory: { free: () => 0, total: () => 0 },
      statfs: fakeStatfs().fn,
    });
    const report = await probe.probe();
    expect(report.memory.usedRatio).toBe(0);
  });
});

describe("ResourcePressureProbe — it does not block a hot path", () => {
  it("is asynchronous: a probe in flight is a promise, not a blocking call", () => {
    const probe = new ResourcePressureProbe({ paths: ["/data"], statfs: fakeStatfs().fn });
    const result = probe.probe();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it("serves disk from cache inside the TTL and re-reads after it", async () => {
    let t = 0;
    const { fn, calls } = fakeStatfs();
    const probe = new ResourcePressureProbe({
      paths: ["/data"],
      diskTtlMs: 1000,
      now: () => t,
      statfs: fn,
    });

    await probe.probe();
    expect(calls).toHaveLength(1);

    t = 999;
    const cached = await probe.probe();
    expect(calls).toHaveLength(1);
    expect(cached.disks[0]?.servedFromCache).toBe(true);
    // The cost of the cache is made visible rather than hidden.
    expect(cached.disks[0]?.ageMs).toBe(999);

    t = 1000;
    await probe.probe();
    expect(calls).toHaveLength(2);
  });

  it("force re-reads even inside the TTL", async () => {
    let t = 0;
    const { fn, calls } = fakeStatfs();
    const probe = new ResourcePressureProbe({
      paths: ["/data"],
      diskTtlMs: 100_000,
      now: () => t,
      statfs: fn,
    });
    await probe.probe();
    await probe.probe(true);
    expect(calls).toHaveLength(2);
  });

  it("invalidate drops the snapshot", async () => {
    const { fn, calls } = fakeStatfs();
    const probe = new ResourcePressureProbe({ paths: ["/data"], diskTtlMs: 100_000, statfs: fn });
    await probe.probe();
    probe.invalidate();
    await probe.probe();
    expect(calls).toHaveLength(2);
  });

  it("single-flights concurrent probes into one syscall sweep", async () => {
    // The bound that matters under load: N concurrent callers must not become N statfs
    // passes, or a burst of tool calls turns the monitor into the load.
    const { fn, calls } = fakeStatfs();
    const probe = new ResourcePressureProbe({ paths: ["/a", "/b", "/c"], statfs: fn });
    await Promise.all([probe.probe(), probe.probe(), probe.probe(), probe.probe(), probe.probe()]);
    expect(calls).toHaveLength(3); // one per path, not five times that
  });

  it("single-flights forced probes too", async () => {
    const { fn, calls } = fakeStatfs();
    const probe = new ResourcePressureProbe({ paths: ["/a"], statfs: fn });
    await Promise.all([probe.probe(true), probe.probe(true), probe.probe(true)]);
    expect(calls).toHaveLength(1);
  });

  it("reports the sweep cost only when it actually swept", async () => {
    let t = 0;
    const { fn } = fakeStatfs();
    const probe = new ResourcePressureProbe({ paths: ["/a"], now: () => t, statfs: fn });
    const swept = await probe.probe();
    expect(swept.sweepDurationMs).toBeDefined();
    t = 10;
    const cached = await probe.probe();
    // A cached call did no I/O; claiming a duration would be a lie.
    expect(cached.sweepDurationMs).toBeUndefined();
  });
});

describe("ResourcePressureProbe — bounds", () => {
  it("caps the number of paths it stats and counts the ones it dropped", async () => {
    const { fn, calls } = fakeStatfs();
    const paths = Array.from({ length: 40 }, (_, i) => `/p${i}`);
    const probe = new ResourcePressureProbe({ paths, maxPaths: 4, statfs: fn });
    const report = await probe.probe();
    expect(calls).toHaveLength(4);
    expect(report.disks).toHaveLength(4);
    // Never silently: a path the agent configured and cannot see is reported.
    expect(report.droppedPathCount).toBe(36);
  });

  it("clamps the TTL into a range where it is neither a syscall nor a lie", async () => {
    const tooLow = new ResourcePressureProbe({
      paths: ["/a"],
      diskTtlMs: 0,
      statfs: fakeStatfs().fn,
    });
    expect(tooLow.ttlMs).toBe(250);

    const tooHigh = new ResourcePressureProbe({
      paths: ["/a"],
      diskTtlMs: Number.MAX_SAFE_INTEGER,
      statfs: fakeStatfs().fn,
    });
    expect(tooHigh.ttlMs).toBe(300_000);
  });

  it("retains exactly one snapshot no matter how many probes run", async () => {
    // A clock that jumps past the TTL each round, so every probe really does sweep: the
    // point is that the cache is replaced each time rather than appended to.
    let t = 0;
    const { fn, calls } = fakeStatfs();
    const probe = new ResourcePressureProbe({
      paths: ["/a"],
      diskTtlMs: 250,
      now: () => t,
      statfs: fn,
    });
    for (let i = 0; i < 50; i++) {
      t += 1000;
      await probe.probe();
    }
    expect(calls).toHaveLength(50);
    // The cache is replaced, never appended to; nothing accumulates across calls.
    const report = await probe.probe();
    expect(report.disks).toHaveLength(1);
  });
});

describe("ResourcePressureProbe — it degrades instead of throwing", () => {
  it("records a failing path and still reports the others", async () => {
    const fn: StatfsLike = (path) =>
      path === "/gone"
        ? Promise.reject(new Error("ENOENT: no such file or directory"))
        : Promise.resolve({ bsize: 4096, blocks: 262_144, bavail: 65_536, bfree: 65_536 });

    const probe = new ResourcePressureProbe({ paths: ["/gone", "/data"], statfs: fn });
    const report = await probe.probe();

    const failed = report.disks.find((d) => d.path === "/gone");
    expect(failed?.error).toMatch(/ENOENT/);
    const ok = report.disks.find((d) => d.path === "/data");
    expect(ok?.error).toBeUndefined();
    expect(ok?.freeBytes).toBe(256 * 1024 * 1024);
    // Memory is still reported: one bad path does not blind the agent.
    expect(report.memory.totalBytes).toBeGreaterThan(0);
  });
});

describe("ResourcePressureProbe — it observes and never gates", () => {
  it("exposes no verdict field of any kind", async () => {
    const probe = new ResourcePressureProbe({ paths: ["/data"], statfs: fakeStatfs().fn });
    const report = await probe.probe();
    // A pressure report that could deny work would be a gate wearing a report's clothes.
    // This test exists so adding one is a deliberate, visible act rather than a slip.
    for (const key of Object.keys(report)) {
      expect(key).not.toMatch(/block|allow|deny|throttl|limit|verdict|gate|ok$/i);
    }
    expect(Object.keys(report.memory).every((k) => !/block|allow|deny|limit/i.test(k))).toBe(true);
    expect(
      Object.keys(report.disks[0] ?? {}).every((k) => !/block|allow|deny|limit/i.test(k)),
    ).toBe(true);
  });

  it("reports the same numbers whatever the pressure, with no threshold applied", async () => {
    // A full disk and an empty one are both just reported. The probe has no opinion, so the
    // agent is the only thing that can turn either reading into a decision.
    const nearlyFull = new ResourcePressureProbe({
      paths: ["/data"],
      statfs: fakeStatfs({ bavail: 1, bfree: 1 }).fn,
    });
    const roomy = new ResourcePressureProbe({
      paths: ["/data"],
      statfs: fakeStatfs({ bavail: 65_536, bfree: 65_536 }).fn,
    });
    const a = await nearlyFull.probe();
    const b = await roomy.probe();
    expect(a.disks[0]?.usedRatio).toBeGreaterThan(b.disks[0]?.usedRatio ?? 0);
    // Both are returned normally — no error, no refusal, no different shape.
    expect(a.disks[0]?.error).toBeUndefined();
    expect(b.disks[0]?.error).toBeUndefined();
  });
});

describe("defaultPressurePaths", () => {
  it("watches the data root and the workspace — the two that actually fill", () => {
    expect(defaultPressurePaths({ dataRoot: "/data", workspaceDir: "/repo" })).toEqual([
      "/data",
      "/repo",
    ]);
  });

  it("de-duplicates, so a workspace inside the data root is not statfs'd twice", () => {
    expect(defaultPressurePaths({ dataRoot: "/data", workspaceDir: "/data" })).toEqual(["/data"]);
  });

  it("omits what was not supplied rather than probing nothing", () => {
    expect(defaultPressurePaths({ workspaceDir: "/repo" })).toEqual(["/repo"]);
    expect(defaultPressurePaths({ dataRoot: "/data", workspaceDir: "" })).toEqual(["/data"]);
    expect(defaultPressurePaths({})).toEqual([]);
  });
});

describe("ResourcePressureProbe — real host defaults", () => {
  it("works against the real filesystem with no injected doubles", async () => {
    const probe = new ResourcePressureProbe({ paths: [process.cwd()] });
    const report = await probe.probe();
    expect(report.memory.totalBytes).toBeGreaterThan(0);
    const disk = report.disks[0];
    expect(disk?.error).toBeUndefined();
    expect(disk?.totalBytes).toBeGreaterThan(0);
    expect(disk?.freeBytes).toBeGreaterThan(0);
    expect(disk?.usedRatio).toBeGreaterThanOrEqual(0);
    expect(disk?.usedRatio).toBeLessThanOrEqual(1);
  });

  it("is cheap enough to sit on a tool-dispatch path", async () => {
    const probe = new ResourcePressureProbe({ paths: [process.cwd()], diskTtlMs: 60_000 });
    await probe.probe(); // warm the cache
    const started = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) await probe.probe();
    const perCallUs = Number(process.hrtime.bigint() - started) / 1000 / 2000;
    // A cached probe is memory-only: two counter reads and an object build. Generous
    // ceiling for a loaded Windows CI box; the point is that it is nowhere near a syscall
    // sweep's worth of work.
    expect(perCallUs).toBeLessThan(500);
  });
});
