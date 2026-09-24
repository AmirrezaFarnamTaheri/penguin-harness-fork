import { describe, it, expect, afterEach } from "vitest";
import { WorkspaceLeaseManager, normalizeScopePath } from "../src/state/workspace-lease.js";

describe("WorkspaceLeaseManager", () => {
  let manager: WorkspaceLeaseManager;

  afterEach(() => {
    if (manager) {
      manager.dispose();
    }
  });

  it("normalizes scope paths consistently", () => {
    const p1 = normalizeScopePath("foo/bar");
    const p2 = normalizeScopePath("foo//bar/");
    expect(p1).toBe(p2);
  });

  it("allows multiple concurrent shared leases on the same scope", async () => {
    manager = new WorkspaceLeaseManager(0);

    const lease1 = await manager.acquire({
      scope: "/repo/workspace",
      holderId: "reader-1",
      mode: "shared",
    });

    const lease2 = await manager.acquire({
      scope: "/repo/workspace",
      holderId: "reader-2",
      mode: "shared",
    });

    expect(lease1.isAlive()).toBe(true);
    expect(lease2.isAlive()).toBe(true);

    const active = manager.getActiveLeases("/repo/workspace");
    expect(active.length).toBe(2);

    lease1.release();
    lease2.release();
    expect(manager.getActiveLeases().length).toBe(0);
  });

  it("serializes exclusive write leases, queuing subsequent writers", async () => {
    manager = new WorkspaceLeaseManager(0);

    const writer1 = await manager.acquire({
      scope: "/repo/workspace",
      holderId: "writer-1",
      mode: "exclusive",
    });

    expect(manager.isLocked("/repo/workspace")).toBe(true);

    // tryAcquire for writer2 should return null while writer1 is active
    const tryWriter2 = manager.tryAcquire({
      scope: "/repo/workspace",
      holderId: "writer-2",
      mode: "exclusive",
    });
    expect(tryWriter2).toBeNull();

    // Queued acquire for writer2
    let writer2Granted = false;
    const writer2Promise = manager
      .acquire({
        scope: "/repo/workspace",
        holderId: "writer-2",
        mode: "exclusive",
        timeoutMs: 1000,
      })
      .then((lease) => {
        writer2Granted = true;
        return lease;
      });

    // Verify writer2 is not yet granted
    expect(writer2Granted).toBe(false);

    // Release writer1
    writer1.release();

    const writer2 = await writer2Promise;
    expect(writer2Granted).toBe(true);
    expect(writer2.holderId).toBe("writer-2");

    writer2.release();
  });

  it("permits concurrent writes to non-overlapping keys in the same scope", async () => {
    manager = new WorkspaceLeaseManager(0);

    const writeA = await manager.acquire({
      scope: "/repo/project",
      holderId: "agent-a",
      mode: "exclusive",
      keys: ["src/feature-a.ts"],
    });

    // Different key in same scope should be immediately granted
    const writeB = manager.tryAcquire({
      scope: "/repo/project",
      holderId: "agent-b",
      mode: "exclusive",
      keys: ["src/feature-b.ts"],
    });

    expect(writeB).not.toBeNull();

    // Overlapping key with A should fail immediate acquisition
    const writeConflict = manager.tryAcquire({
      scope: "/repo/project",
      holderId: "agent-c",
      mode: "exclusive",
      keys: ["src/feature-a.ts"],
    });
    expect(writeConflict).toBeNull();

    writeA.release();
    writeB?.release();
  });

  it("rejects on acquisition timeout if lease is not freed", async () => {
    manager = new WorkspaceLeaseManager(0);

    const writer = await manager.acquire({
      scope: "/repo/busy",
      holderId: "blocking-writer",
      mode: "exclusive",
    });

    await expect(
      manager.acquire({
        scope: "/repo/busy",
        holderId: "impatient-writer",
        mode: "exclusive",
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Timeout after 50ms");

    writer.release();
  });

  it("supports heartbeat renewal and evicts expired leases", async () => {
    manager = new WorkspaceLeaseManager(0);

    const lease = await manager.acquire({
      scope: "/repo/quick",
      holderId: "fast-worker",
      mode: "exclusive",
      ttlMs: 20,
    });

    expect(lease.isAlive()).toBe(true);
    lease.heartbeat(50);
    expect(lease.expiresAt).toBeGreaterThan(Date.now() + 20);

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 60));
    const evicted = manager.evictExpired();
    expect(evicted).toBe(1);
    expect(lease.isAlive()).toBe(false);
  });

  it("treats an all-empty key set as a whole-scope request", async () => {
    manager = new WorkspaceLeaseManager(0);

    const writer = await manager.acquire({
      scope: "/repo/empty-keys",
      holderId: "writer-1",
      mode: "exclusive",
      keys: ["", "   "],
    });

    // The empty keys collapsed to a whole-scope exclusive lock, so any other writer is blocked.
    expect(
      manager.tryAcquire({
        scope: "/repo/empty-keys",
        holderId: "writer-2",
        mode: "exclusive",
        keys: ["src/deep/feature.ts"],
      }),
    ).toBeNull();

    // And the lease does not advertise empty-string keys.
    const info = manager.getActiveLeases("/repo/empty-keys")[0]!;
    expect(info.keys).toEqual([]);
    expect(manager.isLocked("/repo/empty-keys")).toBe(true);

    writer.release();
    expect(manager.isLocked("/repo/empty-keys")).toBe(false);
  });

  it("ignores empty keys when matching per-key overlap", async () => {
    manager = new WorkspaceLeaseManager(0);

    const holderA = await manager.acquire({
      scope: "/repo/mixed-keys",
      holderId: "agent-a",
      mode: "exclusive",
      keys: ["", "src/a.ts"],
    });

    // The empty key must not act as a wildcard that collides with every other key.
    const holderB = manager.tryAcquire({
      scope: "/repo/mixed-keys",
      holderId: "agent-b",
      mode: "exclusive",
      keys: ["src/b.ts"],
    });
    expect(holderB).not.toBeNull();

    // The real key still conflicts.
    expect(
      manager.tryAcquire({
        scope: "/repo/mixed-keys",
        holderId: "agent-c",
        mode: "exclusive",
        keys: ["src/a.ts"],
      }),
    ).toBeNull();

    holderA.release();
    holderB?.release();
  });
});
