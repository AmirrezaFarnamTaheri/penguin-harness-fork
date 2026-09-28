/**
 * The registry: joining, reusing, refusing, and the guarantees around each.
 *
 * This file is where the feature is either safe or not, so the order of the tests follows the
 * order of the claims. The sharing paths come first (a caller can see that it shared, and the
 * work ran once). Then the staleness proofs, because a sharing path that cannot be shown to be
 * fresh is not worth having. Then the bounds, because a cache that grows is a memory leak with a
 * good reputation. Then failures, which is the one place where a tempting optimisation would
 * quietly transfer a result nobody agreed to inherit.
 *
 * Every run is against a real temporary tree and a real `vitest run` argv, because the
 * fingerprint is the thing under test and a fake one would test nothing.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OperationShareRegistry,
  type OperationOutcome,
  type ShareOperationSpec,
  type ShareRegistryOptions,
} from "../../../src/agent/sharing/index.js";

let root: string;

const SRC = (): string => path.join(root, "src");
const deps = () => ({ roots: [SRC()] });

/**
 * A factory, not a constant: `root` only exists inside a test, so a module-level spec would
 * capture `undefined` and every key would be minted from a scope that does not exist.
 */
const SPEC = (): ShareOperationSpec => ({
  argv: ["vitest", "run", "test/agent/sharing/registry.test.ts"],
  cwd: root,
  effects: "read-only",
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "penguin-share-reg-"));
  await writeSource("export const a = 1;\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The watched "source file" is a single file: a fingerprint root may be a file or a directory. */
async function writeSource(content: string): Promise<string> {
  await rm(SRC(), { force: true });
  await writeFile(SRC(), content);
  return content;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function outcome(value: string, bytes = value.length, failed = false): OperationOutcome<string> {
  return { value, bytes, failed };
}

/**
 * Waits for the registry to REACH a state, rather than sleeping and hoping it got there.
 *
 * Every gate in this file has to open after a joiner has reached its wait, or the owner finishes
 * first and the joiner honestly finds a completed entry instead of a flight — the test would then
 * be asserting about the wrong mechanism and pass for the wrong reason. A fixed sleep is the
 * obvious way to try, and it is exactly what made these tests fail only under a loaded box: five
 * milliseconds is generous alone and far too short with the full suite's workers competing.
 * `stats().live` exposes the two facts that matter, so the wait is for the condition itself.
 */
async function waitFor(
  registry: OperationShareRegistry,
  what: string,
  predicate: (live: ReturnType<OperationShareRegistry["stats"]>["live"]) => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate(registry.stats().live)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for the registry to reach: ${what}`);
}

/** A run of `key` is registered, so a second caller will find something to wait on. */
const inFlight = (registry: OperationShareRegistry): Promise<void> =>
  waitFor(registry, "a run in flight", (live) => live.inFlightKeys === 1);

/** Exactly one caller is blocked on it, which is the state a joining assertion must start from. */
const oneWaiter = (registry: OperationShareRegistry): Promise<void> =>
  waitFor(registry, "one caller waiting", (live) => live.waiters === 1);

describe("registry: the three outcomes", () => {
  it("RAN, and says why, when the operation may not be shared at all", async () => {
    const registry = new OperationShareRegistry();
    const result = await registry.run({ ...SPEC(), effects: "writes" }, deps(), async () =>
      outcome("ran"),
    );

    expect(result.outcome).toBe("RAN");
    expect(result.origin).toBe("own");
    expect(result.inherited).toBe(false);
    // A caller that gets no key gets the REASON, not a null it has to interpret.
    expect(result.key).toBeNull();
    expect(result.excluded).toBe("declared-effects");
    expect(registry.stats().counters.refusals["declared-effects"]).toBe(1);
  });

  it("RAN with no key when the tree cannot be fingerprinted, rather than sharing blindly", async () => {
    const registry = new OperationShareRegistry();
    const result = await registry.run(SPEC(), { roots: [path.join(root, "gone")] }, async () =>
      outcome("ran"),
    );

    expect(result.outcome).toBe("RAN");
    expect(result.excluded).toBe("no-fingerprint");
    expect(registry.stats().counters.refusals["no-fingerprint"]).toBe(1);
  });

  it("REUSED: a second caller takes the completed result and the work ran once", async () => {
    const registry = new OperationShareRegistry();
    let executions = 0;
    const run = () =>
      registry.run(SPEC(), deps(), async () => {
        executions += 1;
        return outcome("green");
      });

    const first = await run();
    const second = await run();

    expect(first.outcome).toBe("RAN");
    expect(first.stored).toBe(true);
    expect(second.outcome).toBe("REUSED");
    expect(second.inherited).toBe(true);
    expect(second.origin).toBe("completed-entry");
    expect(second.value).toBe("green");
    expect(executions).toBe(1);
    expect(registry.stats().counters).toMatchObject({ ran: 1, reused: 1, joined: 0 });
  });

  it("JOINED: a concurrent caller waits on the run already in flight and does not re-run it", async () => {
    const registry = new OperationShareRegistry({ limits: { waitMs: 2_000 } });
    let executions = 0;
    const gate = deferred<OperationOutcome<string>>();

    const owner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return await gate.promise;
    });
    // Let the owner get as far as awaiting its work before the second caller fingerprints.
    await inFlight(registry);
    const joiner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return outcome("second-run");
    });
    await oneWaiter(registry);

    gate.resolve(outcome("first-run"));
    const [first, second] = await Promise.all([owner, joiner]);

    expect(first.outcome).toBe("RAN");
    expect(second.outcome).toBe("JOINED");
    expect(second.inherited).toBe(true);
    expect(second.origin).toBe("joined-in-flight");
    expect(second.value).toBe("first-run");
    expect(executions).toBe(1);
    expect(registry.stats().counters.joined).toBe(1);
  });

  it("does not share across scopes, arguments, or programs", async () => {
    const registry = new OperationShareRegistry();
    let executions = 0;
    const run = (spec: ShareOperationSpec) =>
      registry.run(spec, deps(), async () => {
        executions += 1;
        return outcome("ran");
      });

    await run(SPEC());
    // A different workspace is a different question, even for the same command.
    await run({ ...SPEC(), cwd: path.join(root, "other") });
    // So is a different argument list.
    await run({ ...SPEC(), argv: ["vitest", "run", "test/other.test.ts"] });
    // And returning to the first question finds the first answer.
    const again = await run(SPEC());

    expect(executions).toBe(3);
    expect(again.outcome).toBe("REUSED");
  });
});

describe("registry: staleness, which is the point", () => {
  it("discards a result whose tree changed while it was running", async () => {
    // The case keying alone cannot see: the run started at one state and finished at another, so
    // its answer describes a tree that no longer exists. Retaining it would hand the next agent a
    // confident answer about files nobody has looked at since.
    const registry = new OperationShareRegistry();
    let executions = 0;
    const run = () =>
      registry.run(SPEC(), deps(), async () => {
        executions += 1;
        if (executions === 1) await writeSource("export const a = 999;\n");
        return outcome(`run-${executions}`);
      });

    const first = await run();
    expect(first.outcome).toBe("RAN");
    expect(first.stored).toBe(false);
    expect(registry.stats().counters.discardedTreeMovedDuringRun).toBe(1);

    const second = await run();
    expect(second.outcome).toBe("RAN");
    expect(second.stored).toBe(true);
    expect(executions).toBe(2);
  });

  it("does not hand a waiter a result for a tree changed during the owner's run", async () => {
    const registry = new OperationShareRegistry();
    const gate = deferred<OperationOutcome<string>>();
    const owner = registry.run(SPEC(), deps(), () => gate.promise);
    await inFlight(registry);
    const waiter = registry.run(SPEC(), deps(), async () => outcome("fresh"));
    await oneWaiter(registry);
    await writeSource("export const a = 2;\n");
    gate.resolve(outcome("stale"));

    const [first, second] = await Promise.all([owner, waiter]);
    expect(first.stored).toBe(false);
    expect(second.outcome).toBe("RAN");
    expect(second.value).toBe("fresh");
    expect(registry.stats().counters.joinedStaleNotInherited).toBe(1);
  });

  it("runs rather than reuses when the tree moved after the first run finished", async () => {
    const registry = new OperationShareRegistry();
    let executions = 0;
    const run = () =>
      registry.run(SPEC(), deps(), async () => {
        executions += 1;
        return outcome(`run-${executions}`);
      });

    await run();
    await writeSource("export const a = 2;\n");
    const second = await run();

    expect(second.outcome).toBe("RAN");
    expect(second.value).toBe("run-2");
    expect(executions).toBe(2);
  });

  it("does not join an in-flight run once the tree has moved under it", async () => {
    // The join is the dangerous one: it is in flight, so it looks maximally fresh, and it belongs
    // to a state of the tree that no longer exists. The key is what stops it.
    const registry = new OperationShareRegistry({ limits: { waitMs: 2_000 } });
    const gate = deferred<OperationOutcome<string>>();
    let executions = 0;

    const owner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return await gate.promise;
    });
    await inFlight(registry);
    await writeSource("export const a = 42;\n");
    const joiner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return outcome("second-run");
    });

    gate.resolve(outcome("first-run"));
    const [first, second] = await Promise.all([owner, joiner]);

    expect(first.value).toBe("first-run");
    expect(second.outcome).toBe("RAN");
    expect(second.origin).toBe("own");
    expect(second.inherited).toBe(false);
    expect(executions).toBe(2);
  });

  it("reuses again once the tree is changed back to the state the result describes", async () => {
    // Proves the guard keys on the tree, not on a monotonically bumped generation: it is a
    // content fingerprint, and identical content is identical content.
    const registry = new OperationShareRegistry();
    let executions = 0;
    const run = () =>
      registry.run(SPEC(), deps(), async () => {
        executions += 1;
        return outcome("green");
      });

    const original = await writeSource("export const a = 1;\n");
    await run();
    await writeSource("export const a = 2;\n");
    await run();
    await writeSource(original);
    const third = await run();

    expect(executions).toBe(2);
    expect(third.outcome).toBe("REUSED");
  });

  it("does not let a repeated run of the same key keep an entry alive forever", async () => {
    // The tempting version of this feature is "refresh the timestamp on every hit", which turns
    // the age bound into a bound a busy agent never reaches. A reuse must not buy more life.
    let clock = 1_000;
    const registry = new OperationShareRegistry({
      now: () => clock,
      limits: { maxEntryAgeMs: 1_000 },
    });
    let executions = 0;
    const run = () =>
      registry.run(SPEC(), deps(), async () => {
        executions += 1;
        return outcome("green");
      });

    await run();
    for (let i = 0; i < 4; i += 1) {
      clock += 200;
      expect((await run()).outcome).toBe("REUSED");
    }
    expect(executions).toBe(1);

    clock += 300; // 1100ms after the entry was created, across four reuses
    expect((await run()).outcome).toBe("RAN");
    expect(executions).toBe(2);
  });
});

describe("registry: sharing must never serialise", () => {
  it("falls back to running the work when the wait budget expires", async () => {
    const registry = new OperationShareRegistry({ limits: { waitMs: 25 } });
    const gate = deferred<OperationOutcome<string>>();
    let executions = 0;

    const owner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return await gate.promise;
    });
    await inFlight(registry);
    const joiner = await registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return outcome("second-run");
    });

    // The owner's run is still going. The joiner must not be stuck behind it.
    expect(joiner.outcome).toBe("RAN");
    expect(joiner.fellBack).toBe(true);
    expect(joiner.value).toBe("second-run");
    expect(joiner.waitedMs).toBeGreaterThan(0);
    expect(registry.stats().counters.waitTimedOut).toBe(1);
    expect(executions).toBe(2);

    gate.resolve(outcome("first-run"));
    expect((await owner).value).toBe("first-run");
  });

  it("lets a caller opt out of waiting entirely", async () => {
    const registry = new OperationShareRegistry({ limits: { waitMs: 10_000 } });
    const gate = deferred<OperationOutcome<string>>();
    const owner = registry.run(SPEC(), deps(), () => gate.promise);
    await inFlight(registry);

    const joiner = await registry.run(SPEC(), deps(), async () => outcome("second-run"), {
      waitMs: 0,
    });
    expect(joiner.outcome).toBe("RAN");
    expect(joiner.fellBack).toBe(false);
    expect(registry.stats().counters.noWait).toBe(1);

    gate.resolve(outcome("first-run"));
    await owner;
  });

  it("stops waiting when the key is already at its waiter cap", async () => {
    // A queue, not a share: past the cap, running immediately beats piling up behind a run that
    // is evidently not finishing fast enough for anyone.
    const registry = new OperationShareRegistry({
      limits: { waitMs: 5_000, maxWaiters: 1 },
    });
    const gate = deferred<OperationOutcome<string>>();
    const owner = registry.run(SPEC(), deps(), () => gate.promise);
    await inFlight(registry);

    const firstWaiter = registry.run(SPEC(), deps(), async () => outcome("waiter-1"));
    await oneWaiter(registry);
    const secondWaiter = await registry.run(SPEC(), deps(), async () => outcome("waiter-2"));

    expect(secondWaiter.outcome).toBe("RAN");
    expect(registry.stats().counters.waiterCapHit).toBe(1);

    gate.resolve(outcome("first-run"));
    const [ownerResult, waiterResult] = await Promise.all([owner, firstWaiter]);
    expect(ownerResult.value).toBe("first-run");
    expect(waiterResult.outcome).toBe("JOINED");
  });

  it("bounds how many runs of one key exist at once, and still answers them", async () => {
    const registry = new OperationShareRegistry({
      limits: { waitMs: 5_000, maxConcurrentRuns: 1, maxWaiters: 8 },
    });
    const gate = deferred<OperationOutcome<string>>();
    let executions = 0;
    const owner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return await gate.promise;
    });
    await inFlight(registry);

    // A joiner that times out and runs anyway must not push the key past its run cap.
    const runner = registry.run(
      SPEC(),
      deps(),
      async () => {
        executions += 1;
        return outcome("second-run");
      },
      { waitMs: 1 },
    );
    await runner;
    gate.resolve(outcome("first-run"));
    await owner;

    expect(executions).toBe(2);
    expect(registry.stats().counters.concurrencyCapHit).toBe(1);
    expect(registry.stats().live.inFlightRuns).toBe(0);
  });
});

describe("registry: failures are not successes", () => {
  it("does not hand a failed run to a waiter, and does not retain it", async () => {
    const registry = new OperationShareRegistry({ limits: { waitMs: 2_000 } });
    const gate = deferred<OperationOutcome<string>>();
    let executions = 0;

    const owner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return await gate.promise;
    });
    await inFlight(registry);
    const joiner = registry.run(SPEC(), deps(), async () => {
      executions += 1;
      return outcome("second-run");
    });
    await oneWaiter(registry);

    gate.resolve(outcome("first-run", 10, true));
    const [first, second] = await Promise.all([owner, joiner]);

    expect(first.failed).toBe(true);
    expect(first.stored).toBe(false);
    // A caller that was handed a failure must be able to tell it inherited rather than ran it.
    // The stronger form of that guarantee: it never receives one at all.
    expect(second.outcome).toBe("RAN");
    expect(second.inherited).toBe(false);
    expect(second.failed).toBe(false);
    expect(second.value).toBe("second-run");
    expect(executions).toBe(2);
    expect(registry.stats().counters.joinedFailureNotInherited).toBe(1);
    expect(registry.stats().counters.failuresNotRetained).toBe(1);
  });

  it("runs again after a failure rather than reusing it", async () => {
    const registry = new OperationShareRegistry();
    const run = () => registry.run(SPEC(), deps(), async () => outcome("red", 10, true));
    expect((await run()).outcome).toBe("RAN");
    const second = await run();
    expect(second.outcome).toBe("RAN");
    expect(registry.stats().live.entries).toBe(0);
  });

  it("does not hand a thrower to a waiter, and rethrows the owner's own error unchanged", async () => {
    const registry = new OperationShareRegistry({ limits: { waitMs: 2_000 } });
    const gate = deferred<OperationOutcome<string>>();
    const boom = new Error("vitest could not start");

    const owner = registry.run(SPEC(), deps(), async () => {
      await gate.promise;
      throw boom;
    });
    await inFlight(registry);
    const joiner = registry.run(SPEC(), deps(), async () => outcome("second-run"));
    await oneWaiter(registry);

    gate.resolve(outcome("unused"));
    await expect(owner).rejects.toBe(boom);
    expect((await joiner).value).toBe("second-run");
    expect(registry.stats().counters.errors).toBe(1);
  });

  it("still labels an inherited failure as inherited when a caller opts in", async () => {
    // `shareFailures` is the deliberate exception, and it is only worth having if the receiving
    // caller can still tell that it did not run the work itself.
    const registry = new OperationShareRegistry({
      limits: { waitMs: 2_000 },
      shareFailures: true,
    });
    const gate = deferred<OperationOutcome<string>>();
    const owner = registry.run(SPEC(), deps(), () => gate.promise);
    await inFlight(registry);
    const joiner = registry.run(SPEC(), deps(), async () => outcome("second-run"));
    await oneWaiter(registry);

    gate.resolve(outcome("red", 10, true));
    const [, second] = await Promise.all([owner, joiner]);
    expect(second.outcome).toBe("JOINED");
    expect(second.failed).toBe(true);
    expect(second.inherited).toBe(true);

    const third = await registry.run(SPEC(), deps(), async () => outcome("third"));
    expect(third.outcome).toBe("REUSED");
    expect(third.failed).toBe(true);
    expect(third.inherited).toBe(true);
  });
});

describe("registry: bounds", () => {
  it("retains nothing when the entry limit is zero", async () => {
    const registry = new OperationShareRegistry({ limits: { maxEntries: 0 } });
    const result = await registry.run(SPEC(), deps(), async () => outcome("answer"));
    expect(result.stored).toBe(false);
    expect(registry.stats().live.entries).toBe(0);
  });

  it("holds the entry-count bound and reports what it dropped to hold it", async () => {
    const registry = new OperationShareRegistry({ limits: { maxEntries: 2 } });
    const run = (name: string) =>
      registry.run({ ...SPEC(), argv: ["vitest", "run", name] }, deps(), async () => outcome(name));

    await run("a");
    await run("b");
    await run("c");
    await run("d");

    const stats = registry.stats();
    expect(stats.live.entries).toBeLessThanOrEqual(2);
    expect(stats.counters.evictions.lru).toBeGreaterThanOrEqual(2);
    expect(stats.counters.evictions.count).toBe(stats.counters.evictions.lru);
  });

  it("holds the byte bound", async () => {
    const registry = new OperationShareRegistry({
      limits: { maxEntries: 100, maxTotalBytes: 300, maxEntryBytes: 100 },
    });
    const run = (name: string) =>
      registry.run({ ...SPEC(), argv: ["vitest", "run", name] }, deps(), async () =>
        outcome(name.repeat(80), 80),
      );

    for (const name of ["a", "b", "c", "d", "e"]) await run(name);

    const stats = registry.stats();
    expect(stats.live.bytes).toBeLessThanOrEqual(300);
    expect(stats.live.entries).toBeLessThanOrEqual(3);
    expect(stats.counters.evictions.lru).toBeGreaterThan(0);
  });

  it("accounts for the new byte size when a concurrent run replaces a cached answer", async () => {
    const registry = new OperationShareRegistry({
      limits: { maxTotalBytes: 100, maxEntryBytes: 100 },
    });
    await registry.run({ ...SPEC(), argv: ["vitest", "run", "other"] }, deps(), async () =>
      outcome("other", 50),
    );
    const firstGate = deferred<OperationOutcome<string>>();
    const secondGate = deferred<OperationOutcome<string>>();
    const first = registry.run(SPEC(), deps(), () => firstGate.promise);
    await inFlight(registry);
    const second = registry.run(SPEC(), deps(), () => secondGate.promise, { waitMs: 0 });
    await waitFor(registry, "two runs in flight", (live) => live.inFlightRuns === 2);
    firstGate.resolve(outcome("first", 30));
    await first;
    secondGate.resolve(outcome("second", 80));
    await second;

    expect(registry.stats().live.bytes).toBe(80);
    expect(registry.stats().live.entries).toBe(1);
    const reused = await registry.run(SPEC(), deps(), async () => outcome("unexpected"));
    expect(reused.value).toBe("second");
  });

  it("never retains a single result larger than the per-entry bound", async () => {
    const registry = new OperationShareRegistry({ limits: { maxEntryBytes: 1_000 } });
    const result = await registry.run(SPEC(), deps(), async () => outcome("x".repeat(10), 10_001));

    expect(result.value).toHaveLength(10);
    expect(result.stored).toBe(false);
    const stats = registry.stats();
    expect(stats.live.entries).toBe(0);
    expect(stats.counters.evictions.oversize).toBe(1);
  });

  it("holds the age bound, so an old answer is not handed out indefinitely", async () => {
    let clock = 1_000;
    const registry = new OperationShareRegistry({
      now: () => clock,
      limits: { maxEntryAgeMs: 1_000 },
    });
    let executions = 0;
    const run = () =>
      registry.run(SPEC(), deps(), async () => {
        executions += 1;
        return outcome("green");
      });

    await run();
    clock += 500;
    expect((await run()).outcome).toBe("REUSED");

    clock += 2_000;
    const stale = await run();
    expect(stale.outcome).toBe("RAN");
    expect(executions).toBe(2);
    expect(registry.stats().counters.evictions.expired).toBeGreaterThan(0);
  });

  it("does not retain a run the caller asked not to keep", async () => {
    const registry = new OperationShareRegistry({ limits: { waitMs: 2_000 } });
    const gate = deferred<OperationOutcome<string>>();
    const spec: ShareOperationSpec = { ...SPEC(), cacheResult: false };

    const owner = registry.run(spec, deps(), () => gate.promise);
    await inFlight(registry);
    const joiner = registry.run(spec, deps(), async () => outcome("second-run"));
    await oneWaiter(registry);
    gate.resolve(outcome("first-run"));
    const [first, second] = await Promise.all([owner, joiner]);

    // Sharing while it runs is exactly what was asked for; keeping it afterwards is not.
    expect(second.outcome).toBe("JOINED");
    expect(first.stored).toBe(false);
    expect(registry.stats().live.entries).toBe(0);
    expect(registry.stats().counters.notRetainedByCaller).toBe(1);
  });

  it("invalidateAll drops retained results at a boundary the fingerprint cannot see", async () => {
    const registry = new OperationShareRegistry();
    const run = () => registry.run(SPEC(), deps(), async () => outcome("green"));
    await run();
    expect(registry.stats().live.entries).toBe(1);

    expect(registry.invalidateAll()).toBe(1);
    expect(registry.stats().live.entries).toBe(0);
    expect(registry.stats().counters.invalidations).toEqual({ calls: 1, entries: 1 });
    expect((await run()).outcome).toBe("RAN");
  });

  it("prevents an active run and its waiter from crossing an invalidation", async () => {
    const registry = new OperationShareRegistry();
    const gate = deferred<OperationOutcome<string>>();
    const owner = registry.run(SPEC(), deps(), () => gate.promise);
    await inFlight(registry);
    const waiter = registry.run(SPEC(), deps(), async () => outcome("new configuration"));
    await oneWaiter(registry);
    registry.invalidateAll();
    gate.resolve(outcome("old configuration"));

    const [first, second] = await Promise.all([owner, waiter]);
    expect(first.stored).toBe(false);
    expect(second.outcome).toBe("RAN");
    expect(second.value).toBe("new configuration");
    expect(registry.stats().counters.discardedInvalidatedDuringRun).toBe(1);
  });
});

describe("registry: a caller can see that it shared", () => {
  it("reports joined, reused, ran, and the time avoided", async () => {
    let clock = 0;
    const registry = new OperationShareRegistry({
      now: () => clock,
      limits: { waitMs: 2_000 },
    });
    const run = (name: string) =>
      registry.run({ ...SPEC(), argv: ["vitest", "run", name] }, deps(), async () => {
        clock += 1_000;
        return outcome("green");
      });

    await run("a");
    const reused = await run("a");
    expect(reused.msAvoidedMs).toBe(1_000);

    const gate = deferred<OperationOutcome<string>>();
    const owner = registry.run({ ...SPEC(), argv: ["vitest", "run", "b"] }, deps(), async () => {
      clock += 2_000;
      return await gate.promise;
    });
    // The joiner has to be waiting before the gate opens, or the owner's retained result would be
    // the honest thing for it to find and the test would prove nothing about joining.
    await inFlight(registry);
    const joinerPromise = registry.run(
      { ...SPEC(), argv: ["vitest", "run", "b"] },
      deps(),
      async () => outcome("other"),
    );
    await oneWaiter(registry);
    gate.resolve(outcome("green"));
    const [, joiner] = await Promise.all([owner, joinerPromise]);
    expect(joiner.outcome).toBe("JOINED");
    expect(joiner.msAvoidedMs).toBe(2_000);

    const stats = registry.stats();
    expect(stats.counters.ran).toBe(2);
    expect(stats.counters.reused).toBe(1);
    expect(stats.counters.joined).toBe(1);
    expect(stats.counters.msAvoidedMs).toBe(3_000);
    expect(stats.counters.byProgram["vitest"]).toBe(2);
    expect(stats.counters.calls).toBe(4);
  });

  it("returns a detached snapshot a caller cannot use to change the registry's numbers", async () => {
    const registry = new OperationShareRegistry();
    await registry.run(SPEC(), deps(), async () => outcome("green"));
    const stats = registry.stats();
    expect(stats.counters.calls).toBe(1);

    (stats.counters as { calls: number }).calls = 99;
    (stats.counters.refusals as Record<string, number>)["declared-effects"] = 99;
    expect(registry.stats().counters.calls).toBe(1);
    expect(registry.stats().counters.refusals["declared-effects"]).toBe(0);
  });

  it("reports zero wait for a caller that never queued behind anyone", async () => {
    // The three ways a caller can get a value without waiting are the three ways a number that
    // claims to be "time blocked" must be zero: unshareable, already-completed, and the owner.
    const registry = new OperationShareRegistry();
    const unshareable = await registry.run({ ...SPEC(), effects: "writes" }, deps(), async () =>
      outcome("a"),
    );
    expect(unshareable.waitedMs).toBe(0);

    const owner = await registry.run(SPEC(), deps(), async () => outcome("b"));
    expect(owner.waitedMs).toBe(0);

    const reused = await registry.run(SPEC(), deps(), async () => outcome("c"));
    expect(reused.outcome).toBe("REUSED");
    expect(reused.waitedMs).toBe(0);
    expect(registry.stats().counters.waitedMs).toBe(0);
  });

  it("reset clears entries, flights and counters", async () => {
    const registry = new OperationShareRegistry();
    await registry.run(SPEC(), deps(), async () => outcome("green"));
    expect(registry.stats().counters.calls).toBe(1);

    registry.reset();
    const stats = registry.stats();
    expect(stats.counters.calls).toBe(0);
    expect(stats.live.entries).toBe(0);
    expect(stats.live.inFlightKeys).toBe(0);
  });
});
