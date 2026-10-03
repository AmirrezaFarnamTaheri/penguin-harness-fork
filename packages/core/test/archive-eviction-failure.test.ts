/**
 * CR (B4/E10.4 follow-up): an eviction that the operating system refuses is not an eviction.
 *
 * The `unlink` failure that means "another writer already removed it" is `ENOENT`. Everything
 * else — `EACCES`, `EPERM`, `EBUSY` — leaves the file in place, so counting it would lower the
 * archive's byte/entry accounting for a file a reader can still open, and would let the caller
 * write past the bound the archive exists to enforce.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ code: "" as string, only: "" as string }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (target: Parameters<typeof actual.unlink>[0]) => {
      const name = path.basename(String(target));
      if (fault.code !== "" && (fault.only === "" || name.includes(fault.only))) {
        const error = new Error(`fixture: unlink refused (${fault.code})`) as NodeJS.ErrnoException;
        error.code = fault.code;
        if (fault.code === "ENOENT") {
          // The race the ENOENT branch exists for: by the time this writer unlinks, the file is
          // already gone (here, because the fixture removes it). The directory state matches the
          // error, so counting the entry as dropped is truthful.
          await actual.unlink(target).catch(() => undefined);
        }
        throw error;
      }
      return actual.unlink(target);
    },
  };
});

import { TruncatedToolOutputArchive } from "../src/environment/truncated-tool-output-archive.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "penguin-eviction-failure-"));
  fault.code = "";
  fault.only = "";
});

afterEach(async () => {
  fault.code = "";
  fault.only = "";
  await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function save(archive: TruncatedToolOutputArchive, callId: string, text: string) {
  const capture = archive.startCapture();
  capture.append(text);
  return capture.save("tool", callId);
}

describe("eviction failures", () => {
  it("refuses the save when a planned eviction cannot remove the file (EACCES)", async () => {
    const dir = path.join(tmp, "output");
    const archive = new TruncatedToolOutputArchive({
      rootDir: dir,
      fileLimitBytes: 64,
      archiveLimits: { maxEntries: 1, maxTotalBytes: 1024 },
    });
    expect((await save(archive, "call-0", "first")).status).toBe("saved");
    const before = (await readdir(dir)).filter((name) => name.endsWith(".log"));
    expect(before).toHaveLength(1);

    fault.code = "EACCES";
    const refused = await save(archive, "call-1", "second");
    fault.code = "";

    // Truthful refusal: the bound could not be respected, so nothing new was written.
    expect(refused).toEqual({ status: "failed", code: "ARCHIVE_FULL" });
    const after = (await readdir(dir)).filter((name) => name.endsWith(".log"));
    expect(after).toEqual(before);
    // And the file it could not remove is not on the drop log as if it were gone.
    const stats = await archive.archiveStats();
    expect(stats.dropped).toEqual([]);
    expect(stats.entries).toBe(1);
  });

  it("still counts a file another writer already removed (ENOENT), and makes room", async () => {
    const dir = path.join(tmp, "output");
    const archive = new TruncatedToolOutputArchive({
      rootDir: dir,
      fileLimitBytes: 64,
      archiveLimits: { maxEntries: 2, maxTotalBytes: 1024 },
    });
    expect((await save(archive, "call-0", "first")).status).toBe("saved");
    expect((await save(archive, "call-1", "second")).status).toBe("saved");
    // The oldest file disappears behind the archive's back: the next save must treat its unlink
    // as "already gone" (the race the ENOENT branch exists for) and still succeed.
    const victim = (await readdir(dir)).filter((name) => name.endsWith(".log")).sort()[0]!;
    fault.code = "ENOENT";
    fault.only = victim.replace(/^tool-/, "").replace(/\.log$/, "");

    const third = await save(archive, "call-2", "third");
    fault.code = "";
    fault.only = "";
    expect(third.status).toBe("saved");
    const stats = await archive.archiveStats();
    // The vanished file counts as capacity-dropped, and the archive still respects maxEntries.
    expect(stats.dropped.map((drop) => drop.name)).toContain(victim);
    expect(stats.entries).toBeLessThanOrEqual(2);
  });
});
