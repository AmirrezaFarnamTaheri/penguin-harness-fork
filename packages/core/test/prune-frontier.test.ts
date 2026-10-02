/**
 * B4 — prune frontier: repeated pruning must not re-decide what it already decided, must never
 * drop retained context, and must keep making progress.
 *
 * The unit cases drive `planPrune` directly (it is pure: list in, decision out), and the last case
 * exercises the real archive through a restart, asserting on the persisted frontier rather than on
 * a mocked filesystem.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPruneFrontier,
  parsePruneFrontier,
  planPrune,
  serializePruneFrontier,
  type PruneFrontier,
} from "../src/internal/prune-frontier.js";
import { TruncatedToolOutputArchive } from "../src/environment/truncated-tool-output-archive.js";

const LIMITS = { maxEntries: 10, maxTotalBytes: 1000 };
const AT = 5_000_000;

function entry(name: string, bytes: number, mtimeMs: number) {
  return { name, bytes, mtimeMs };
}

describe("B4.3 — prune frontier algebra", () => {
  it("reports fits without dropping anything and records what it saw", () => {
    const plan = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 10,
      limits: LIMITS,
      entries: [entry("a.log", 10, 1), entry("b.log", 10, 2)],
    });
    expect(plan.decision).toBe("fits");
    expect(plan.drops).toEqual([]);
    expect(Object.keys(plan.frontier.examined).sort()).toEqual(["a.log", "b.log"]);
    expect(plan.frontier.passes).toBe(1);
  });

  it("drops oldest-first until the write fits, honoring both bounds", () => {
    const plan = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 100,
      limits: { maxEntries: 3, maxTotalBytes: 300 },
      entries: [entry("new.log", 50, 30), entry("old.log", 50, 10), entry("mid.log", 50, 20)],
    });
    // Dropping the oldest entry (50) brings the store to 100 + 100 = 200 with 3 entries: it fits.
    expect(plan.decision).toBe("drop");
    expect(plan.drops).toEqual(["old.log"]);
  });

  it("never drops a kept name, even when it is the oldest and largest", () => {
    const plan = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 30,
      limits: { maxEntries: 3, maxTotalBytes: 200 },
      entries: [entry("kept.log", 80, 1), entry("old.log", 40, 2), entry("new.log", 40, 3)],
      keepNames: ["kept.log"],
    });
    expect(plan.drops).toEqual(["old.log"]);
    expect(plan.drops).not.toContain("kept.log");
    expect(plan.frontier.kept["kept.log"]).toEqual({ bytes: 80, mtimeMs: 1 });
    // The block was skipped, not reconsidered as a drop candidate.
    expect(plan.keptNames).toContain("kept.log");
  });

  it("keeps retained context across passes without the caller re-declaring it", () => {
    const first = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 30,
      limits: { maxEntries: 3, maxTotalBytes: 100 },
      entries: [entry("kept.log", 80, 1), entry("old.log", 20, 2)],
      keepNames: ["kept.log"],
    });
    const second = planPrune({
      directoryMtimeMs: AT + 1,
      requiredBytes: 30,
      limits: { maxEntries: 3, maxTotalBytes: 100 },
      entries: [entry("kept.log", 80, 1), entry("old.log", 20, 2)],
      frontier: first.frontier,
    });
    expect(second.drops).not.toContain("kept.log");
    expect(second.frontier.kept["kept.log"]).toBeDefined();
  });

  it("blocks a write larger than the store and records that decision", () => {
    const plan = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 2000,
      limits: LIMITS,
      entries: [entry("a.log", 10, 1)],
    });
    expect(plan.decision).toBe("blocked");
    expect(plan.examined).toBe(0);
    expect(plan.frontier.blockedAtRequiredBytes).toBe(2000);
  });

  it("answers a repeated blocked requirement without listing the directory at all", () => {
    const first = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 2000,
      limits: LIMITS,
      entries: [entry("a.log", 10, 1)],
    });
    const cached = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 2000,
      // No `entries` at all: a cached answer must not need the listing.
      limits: LIMITS,
      frontier: first.frontier,
    });
    expect(cached.decision).toBe("cached-blocked");
    expect(cached.examined).toBe(0);
    expect(cached.frontier.examined).toEqual({});
  });

  it("answers a larger requirement from the same blocked decision", () => {
    const first = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 2000,
      limits: LIMITS,
      entries: [],
    });
    const cached = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 3000,
      limits: { maxEntries: 10, maxTotalBytes: 5000 },
      frontier: first.frontier,
    });
    expect(cached.decision).toBe("cached-blocked");
  });

  it("rescans when the requirement is smaller, and clears the block when it fits", () => {
    const blocked = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 2000,
      limits: LIMITS,
      entries: [entry("a.log", 10, 1)],
    });
    const smaller = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 10,
      limits: LIMITS,
      entries: [entry("a.log", 10, 1)],
      frontier: blocked.frontier,
    });
    expect(smaller.decision).toBe("fits");
    expect(smaller.frontier.blockedAtRequiredBytes).toBeNull();
  });

  it("invalidates the cached decision when the directory changes", () => {
    // A real scan that ends blocked: the kept block alone exceeds what a 200-byte write can join.
    const blocked = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 200,
      limits: LIMITS,
      entries: [entry("kept.log", 900, 1)],
      keepNames: ["kept.log"],
    });
    expect(blocked.decision).toBe("blocked");
    expect(blocked.examined).toBe(1);
    const cachedSameState = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 200,
      limits: LIMITS,
      frontier: blocked.frontier,
    });
    expect(cachedSameState.decision).toBe("cached-blocked");

    // The directory changed (mtime moved), so the decision must be re-derived from a fresh scan.
    const afterChange = planPrune({
      directoryMtimeMs: AT + 1,
      requiredBytes: 200,
      limits: LIMITS,
      entries: [entry("kept.log", 900, 1)],
      keepNames: ["kept.log"],
      frontier: blocked.frontier,
    });
    expect(afterChange.decision).toBe("blocked");
    expect(afterChange.examined).toBe(1);
  });

  it("makes forward progress past a kept oversized block toward later entries", () => {
    // The kept block is the oldest; the pruner must move past it rather than stop at it.
    const plan = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 60,
      limits: { maxEntries: 2, maxTotalBytes: 300 },
      entries: [entry("kept.log", 150, 1), entry("b.log", 40, 2), entry("c.log", 40, 3)],
      keepNames: ["kept.log"],
    });
    expect(plan.decision).toBe("drop");
    // The kept block is the oldest entry, and pruning moved past it to the later ones.
    expect(plan.drops).toEqual(["b.log", "c.log"]);
    expect(plan.drops).not.toContain("kept.log");
  });

  it("increments passes on every plan, cached or not", () => {
    const first = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 2000,
      limits: LIMITS,
      entries: [],
    });
    const second = planPrune({
      directoryMtimeMs: AT,
      requiredBytes: 2000,
      limits: LIMITS,
      frontier: first.frontier,
    });
    expect(first.frontier.passes).toBe(1);
    expect(second.frontier.passes).toBe(2);
  });

  it("round-trips through serialization and discards anything it cannot trust", () => {
    const frontier = createPruneFrontier({
      directoryMtimeMs: AT,
      blockedAtRequiredBytes: 123,
      kept: { "kept.log": { bytes: 1, mtimeMs: 2 } },
      passes: 4,
    });
    expect(parsePruneFrontier(serializePruneFrontier(frontier))).toEqual(frontier);
    expect(parsePruneFrontier("{not json")).toEqual(createPruneFrontier());
    // A future version's data must be discarded, not partially trusted: the fixture carries state a
    // fresh frontier does not have, so accepting it would be visible here.
    expect(
      parsePruneFrontier(
        JSON.stringify({
          version: 99,
          blockedAtRequiredBytes: 5000,
          passes: 7,
          kept: { a: { bytes: 1, mtimeMs: 1 } },
        }),
      ),
    ).toEqual(createPruneFrontier());
    expect(parsePruneFrontier(null)).toEqual(createPruneFrontier());
    // A fingerprint with a non-numeric field is dropped rather than trusted.
    const partial = parsePruneFrontier(
      JSON.stringify({ version: 1, kept: { a: { bytes: "x", mtimeMs: 1 } }, passes: 2 }),
    );
    expect(partial.kept).toEqual({});
    expect(partial.passes).toBe(2);
  });

  it("serializes deterministically for the same input", () => {
    const build = (): PruneFrontier =>
      planPrune({
        directoryMtimeMs: AT,
        requiredBytes: 10,
        limits: LIMITS,
        entries: [entry("b.log", 1, 2), entry("a.log", 1, 1)],
      }).frontier;
    expect(serializePruneFrontier(build())).toBe(serializePruneFrontier(build()));
  });
});

describe("B4.3/B4.4 — the archive's frontier across a restart", () => {
  let tmp = "";
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "penguin-prune-frontier-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("refuses a repeated oversized capture without re-examining the directory", async () => {
    const rootDir = path.join(tmp, "output");
    const frontierPath = path.join(tmp, "prune-frontier.json");
    const limits = { maxEntries: 5, maxTotalBytes: 128 };
    const overseer = new TruncatedToolOutputArchive({
      rootDir,
      fileLimitBytes: 4096,
      archiveLimits: limits,
      pruneFrontierPath: frontierPath,
    });
    const first = overseer.startCapture();
    first.append("x".repeat(1024));
    expect(await first.save("tool", "too-big")).toEqual({ status: "failed", code: "ARCHIVE_FULL" });
    const afterFirst = JSON.parse(await readFile(frontierPath, "utf8")) as {
      blockedAtRequiredBytes: number | null;
      examined: Record<string, unknown>;
      passes: number;
    };
    expect(afterFirst.blockedAtRequiredBytes).toBeGreaterThanOrEqual(1024);
    expect(afterFirst.passes).toBeGreaterThanOrEqual(1);

    // A restart with the same frontier: the same oversized capture is refused from the recorded
    // decision — nothing is listed, so nothing new is added to `examined`.
    const restarted = new TruncatedToolOutputArchive({
      rootDir,
      fileLimitBytes: 4096,
      archiveLimits: limits,
      pruneFrontierPath: frontierPath,
    });
    const second = restarted.startCapture();
    second.append("x".repeat(1024));
    expect(await second.save("tool", "too-big-again")).toEqual({
      status: "failed",
      code: "ARCHIVE_FULL",
    });
    await restarted.archiveStats(); // a stats call may list; the refusal above must not have
    const afterSecond = JSON.parse(await readFile(frontierPath, "utf8")) as {
      examined: Record<string, unknown>;
      passes: number;
    };
    expect(afterSecond.examined).toEqual({});
    expect(afterSecond.passes).toBeGreaterThan(afterFirst.passes);

    // Forward progress is intact: a write that does fit still succeeds after the refusals.
    const ok = restarted.startCapture();
    ok.append("small");
    expect((await ok.save("tool", "fits")).status).toBe("saved");
  });

  it("still evicts oldest-first with a frontier loaded, and never touches recall entries", async () => {
    const rootDir = path.join(tmp, "output");
    const frontierPath = path.join(tmp, "prune-frontier.json");
    const archive = new TruncatedToolOutputArchive({
      rootDir,
      fileLimitBytes: 64,
      archiveLimits: { maxEntries: 2, maxTotalBytes: 4096 },
      pruneFrontierPath: frontierPath,
    });
    const recall = await archive.saveRecallEntry("tool", "recall me");
    expect(recall.status).toBe("saved");
    for (let index = 0; index < 3; index += 1) {
      const capture = archive.startCapture();
      capture.append(`output-${index}`);
      expect((await capture.save("tool", `call-${index}`)).status).toBe("saved");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stats = await archive.archiveStats();
    expect(stats.entries).toBe(2);
    expect(stats.dropped.length).toBe(1);
    if (recall.status === "saved") {
      const recalled = await archive.recall(recall.id);
      expect(recalled.status).toBe("ok");
    }
    // The frontier file lives outside the archive root (documented default), so the root still
    // holds only the `.log` files this class writes.
    expect(await readFile(frontierPath, "utf8")).toContain('"version":1');
  });
});

describe("B4.4 — failure injection around the swap", () => {
  it("leaves the persisted frontier usable when its write target is not writable", async () => {
    const tmp2 = await mkdtemp(path.join(tmpdir(), "penguin-prune-fail-"));
    try {
      const rootDir = path.join(tmp2, "output");
      const blockedPath = path.join(tmp2, "occupied");
      await writeFile(blockedPath, "not a directory", "utf8");
      const archive = new TruncatedToolOutputArchive({
        rootDir,
        fileLimitBytes: 4096,
        archiveLimits: { maxEntries: 5, maxTotalBytes: 128 },
        pruneFrontierPath: path.join(blockedPath, "frontier.json"), // ENOTDIR on write
      });
      const capture = archive.startCapture();
      capture.append("x".repeat(1024));
      // The refusal is the bound talking, not the persistence failure: no throw, no partial write.
      expect(await capture.save("tool", "too-big")).toEqual({
        status: "failed",
        code: "ARCHIVE_FULL",
      });
      const fits = archive.startCapture();
      fits.append("small");
      expect((await fits.save("tool", "fits")).status).toBe("saved");
    } finally {
      await rm(tmp2, { recursive: true, force: true });
    }
  });
});
