import { describe, expect, it } from "vitest";

import type { FsStat, IFileSystem } from "../../src/sandbox/cow-fs-backend.js";
import {
  canonicalizePath,
  compareCanonicalContainment,
  compareFileIdentity,
  CowFsBackend,
  dirname,
  FileTraversalBudget,
  FileSystemPolicyError,
  isSameOrDescendantPath,
  joinPath,
  MAX_PATH_LENGTH,
  MAX_SYMLINK_DEPTH,
  normalizePath,
  resolveFileIdentity,
  resolvePath,
  resolveSymlinkTarget,
  sanitizeErrorMessage,
  TraversalBudgetError,
  traverseFileTree,
  validatePath,
} from "../../src/sandbox/cow-fs-backend.js";
import { resolveLimits } from "../../src/sandbox/execution-limits.js";

/** Capture what a synchronous throwing call raised, so the error's own properties
 *  can be asserted rather than just its message. */
function captureThrow(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The async counterpart, for the filesystem operations that reject. */
async function captureReject(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const encoder = new TextEncoder();

function dirStat(identity: string): FsStat {
  return {
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    size: 0,
    mode: 0o755,
    mtime: new Date(0),
    identity,
  };
}

function fileStat(identity: string, size: number): FsStat {
  return {
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    size,
    mode: 0o644,
    mtime: new Date(0),
    identity,
  };
}

/**
 * A map-backed IFileSystem for the tests that need to dictate `realpath` or
 * `identity` directly — containment, canonicalization, and the alias-based cycle
 * check in `traverseFileTree` all depend on those two, and the COW backend always
 * reports fresh unique identities, so it cannot express an alias on its own.
 */
class FakeFs implements IFileSystem {
  readonly stats = new Map<string, FsStat>();
  readonly realpaths = new Map<string, string>();
  readonly listings = new Map<string, string[]>();
  readonly contents = new Map<string, Uint8Array>();

  stat(path: string): Promise<FsStat | undefined> {
    return Promise.resolve(this.stats.get(normalizePath(path)));
  }
  lstat(path: string): Promise<FsStat | undefined> {
    return Promise.resolve(this.stats.get(normalizePath(path)));
  }
  realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    return Promise.resolve(this.realpaths.get(normalized) ?? normalized);
  }
  readdir(path: string): Promise<string[]> {
    return Promise.resolve([...(this.listings.get(normalizePath(path)) ?? [])]);
  }
  readlink(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  readFile(path: string, options?: { encoding?: string }): Promise<string | Uint8Array> {
    const data = this.contents.get(normalizePath(path)) ?? new Uint8Array();
    if (options?.encoding === "utf-8") return Promise.resolve(new TextDecoder().decode(data));
    return Promise.resolve(data);
  }
  async writeFile(): Promise<void> {
    throw new Error("FakeFs is read-only");
  }
  async mkdir(): Promise<void> {
    throw new Error("FakeFs is read-only");
  }
  async unlink(): Promise<void> {
    throw new Error("FakeFs is read-only");
  }
  async rmdir(): Promise<void> {
    throw new Error("FakeFs is read-only");
  }
  async symlink(): Promise<void> {
    throw new Error("FakeFs is read-only");
  }
}

/** A lower layer holding one directory with two files, the common COW fixture. */
async function seededLower(): Promise<CowFsBackend> {
  const lower = new CowFsBackend();
  await lower.mkdir("/data");
  await lower.writeFile("/data/keep", "lower-keep");
  await lower.writeFile("/data/kill", "lower-kill");
  return lower;
}

describe("cow-fs-backend", () => {
  describe("path normalization and algebra", () => {
    it("canonicalizes the root and relative inputs", () => {
      expect(normalizePath("")).toBe("/");
      expect(normalizePath("/")).toBe("/");
      expect(normalizePath("a")).toBe("/a");
      expect(normalizePath("a/b")).toBe("/a/b");
    });

    it("drops trailing slashes and single-dot segments", () => {
      expect(normalizePath("/a/")).toBe("/a");
      expect(normalizePath("/a/b/")).toBe("/a/b");
      expect(normalizePath("/a/./b/./")).toBe("/a/b");
    });

    it("resolves dot-dot segments and clamps at the root instead of escaping it", () => {
      expect(normalizePath("/a/b/../c")).toBe("/a/c");
      expect(normalizePath("/a/b/../../c")).toBe("/c");
      expect(normalizePath("/a/../..")).toBe("/");
      // A traversal attempt is resolved away before it is ever compared to the root.
      expect(normalizePath("/../../etc/passwd")).toBe("/etc/passwd");
      expect(normalizePath("/a/b/../../../../etc")).toBe("/etc");
    });

    it("collapses repeated slashes", () => {
      expect(normalizePath("//a///b//")).toBe("/a/b");
    });

    it("treats the root as containing everything and honors the prefix boundary", () => {
      expect(isSameOrDescendantPath("/", "/anything/deep")).toBe(true);
      expect(isSameOrDescendantPath("/a", "/a")).toBe(true);
      expect(isSameOrDescendantPath("/a", "/a/b")).toBe(true);
      expect(isSameOrDescendantPath("/a", "/a/b/c")).toBe(true);
      // A sibling that merely shares a name prefix is not a descendant.
      expect(isSameOrDescendantPath("/a", "/ab")).toBe(false);
      expect(isSameOrDescendantPath("/a", "/ba")).toBe(false);
    });

    it("rejects null bytes and over-long paths", () => {
      expect(() => validatePath("/ok", "read")).not.toThrow();
      expect(() => validatePath("/bad\0name", "read")).toThrow(/ENOENT/);
      expect(() => validatePath("/bad\0name", "read")).toThrow(/null byte/);
      expect(() => validatePath(`${"/".repeat(MAX_PATH_LENGTH)}x`, "read")).toThrow(/ENAMETOOLONG/);
    });

    it("takes the directory name of a normalized path", () => {
      expect(dirname("/")).toBe("/");
      expect(dirname("/a")).toBe("/");
      expect(dirname("/a/b/c")).toBe("/a/b");
      // The path is normalized first: "/a/b/.." resolves to "/a", whose parent
      // is the root — two spellings of one directory give one dirname.
      expect(dirname("/a/b/..")).toBe("/");
    });

    it("resolves a relative path against a base and an absolute path as-is", () => {
      expect(resolvePath("/", "a")).toBe("/a");
      expect(resolvePath("/a/b", "c")).toBe("/a/b/c");
      expect(resolvePath("/a/b", "./c")).toBe("/a/b/c");
      expect(resolvePath("/a/b", "../c")).toBe("/a/c");
      expect(resolvePath("/a/b", "/x/y")).toBe("/x/y");
    });

    it("joins a parent path with a child name", () => {
      expect(joinPath("/", "a")).toBe("/a");
      expect(joinPath("/a", "b")).toBe("/a/b");
    });

    it("resolves a symlink target against the link's own directory", () => {
      // A relative target is resolved against the directory the link sits in,
      // never against the link's own path — a link "/a" to "b" points at "/b".
      expect(resolveSymlinkTarget("/a", "b")).toBe("/b");
      expect(resolveSymlinkTarget("/a/b", "c")).toBe("/a/c");
      expect(resolveSymlinkTarget("/a/b", "../c")).toBe("/c");
      expect(resolveSymlinkTarget("/a/b", "/x/y")).toBe("/x/y");
    });
  });

  describe("sanitizeErrorMessage", () => {
    it("replaces quoted real paths with a bare marker", () => {
      expect(sanitizeErrorMessage("open file '/home/user/secret.txt' failed")).toBe(
        "open path failed",
      );
      expect(sanitizeErrorMessage("cannot stat dir '/etc'")).toBe("cannot stat path");
      expect(sanitizeErrorMessage("path '/tmp/x' is busy")).toBe("path is busy");
    });

    it("passes virtual-path error codes through untouched", () => {
      const eloop = "ELOOP: too many levels of symbolic links at '/a'";
      expect(sanitizeErrorMessage(eloop)).toBe(eloop);
      for (const code of ["ELOOP", "EFBIG", "EPERM", "ENAMETOOLONG"]) {
        expect(sanitizeErrorMessage(`${code}: something '/secret'`)).toContain(code);
        expect(sanitizeErrorMessage(`${code}: something '/secret'`)).toContain("'/secret'");
      }
    });

    it("leaves a message with no quoted path alone", () => {
      expect(sanitizeErrorMessage("no such file or directory")).toBe("no such file or directory");
    });
  });

  describe("copy-on-write layering", () => {
    it("reads an untouched lower-layer file straight through", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      expect(await upper.readFile("/data/keep", { encoding: "utf-8" })).toBe("lower-keep");
      const stat = await upper.stat("/data/keep");
      expect(stat?.isFile).toBe(true);
      expect(stat?.size).toBe("lower-keep".length);
      // A read-through does not promote anything into the writable layer.
      expect(upper.retainedMemoryBytes).toBe(0);
    });

    it("returns bytes for buffer, text for utf-8, and base64 on demand", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      const buffer = await upper.readFile("/data/keep", { encoding: "buffer" });
      expect(buffer).toBeInstanceOf(Uint8Array);
      expect((buffer as Uint8Array).byteLength).toBe("lower-keep".length);

      expect(await upper.readFile("/data/keep", { encoding: "base64" })).toBe(
        Buffer.from("lower-keep").toString("base64"),
      );
      expect(await upper.readFile("/data/keep")).toEqual(buffer);
    });

    it("lists a lower directory it has not written to", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });
      // Listings are sorted, so a caller comparing two backends sees one order.
      expect(await upper.readdir("/data")).toEqual(["keep", "kill"]);
    });

    it("copies a lower file into the overlay on write and leaves the original intact", async () => {
      const lower = await seededLower();
      const upper = new CowFsBackend({ lower });

      await upper.writeFile("/data/keep", "upper-keep");

      expect(await upper.readFile("/data/keep", { encoding: "utf-8" })).toBe("upper-keep");
      // The lower layer is never observed in a state the script created.
      expect(await lower.readFile("/data/keep", { encoding: "utf-8" })).toBe("lower-keep");
      expect(await lower.readFile("/data/kill", { encoding: "utf-8" })).toBe("lower-kill");
      expect(upper.retainedMemoryBytes).toBe("upper-keep".length);
    });

    it("isolates a brand-new file from the lower layer entirely", async () => {
      const lower = await seededLower();
      const upper = new CowFsBackend({ lower });

      await upper.writeFile("/data/new", "n");

      expect(await upper.readdir("/data")).toEqual(["keep", "kill", "new"]);
      expect(await lower.readdir("/data")).toEqual(["keep", "kill"]);
      const error = await captureReject(() => lower.readFile("/data/new"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/ENOENT/);
    });

    it("shadows a lower name in a merged listing without duplicating it", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      await upper.writeFile("/data/kill", "shadowed");

      expect(await upper.readdir("/data")).toEqual(["keep", "kill"]);
      expect(await upper.readFile("/data/kill", { encoding: "utf-8" })).toBe("shadowed");
    });

    it("hides a deleted lower entry behind a tombstone", async () => {
      const lower = await seededLower();
      const upper = new CowFsBackend({ lower });

      await upper.unlink("/data/kill");

      expect(await upper.readdir("/data")).toEqual(["keep"]);
      expect(await upper.stat("/data/kill")).toBeUndefined();
      // The tombstone shadows the lower entry only; the lower file itself survives.
      expect(await lower.readFile("/data/kill", { encoding: "utf-8" })).toBe("lower-kill");
    });

    it("clears the tombstone when a deleted name is recreated", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      await upper.unlink("/data/kill");
      expect(await upper.readdir("/data")).toEqual(["keep"]);

      await upper.writeFile("/data/kill", "reborn");
      expect(await upper.readdir("/data")).toEqual(["keep", "kill"]);
      expect(await upper.readFile("/data/kill", { encoding: "utf-8" })).toBe("reborn");
    });

    it("refuses to read a directory and reports ENOENT for a missing file", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      const dirError = await captureReject(() => upper.readFile("/data"));
      expect(dirError).toBeInstanceOf(FileSystemPolicyError);
      expect(String((dirError as Error).message)).toMatch(/EISDIR/);

      const missingError = await captureReject(() => upper.readFile("/data/nope"));
      expect(missingError).toBeInstanceOf(FileSystemPolicyError);
      expect(String((missingError as Error).message)).toMatch(/ENOENT/);
    });
  });

  describe("directories, deletion, and policy", () => {
    it("creates a directory when its parent exists", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      await upper.mkdir("/data/sub");
      expect((await upper.stat("/data/sub"))?.isDirectory).toBe(true);
      expect(await upper.readdir("/data")).toEqual(["keep", "kill", "sub"]);
    });

    it("refuses an existing path, a missing parent, and a recursive creation", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      const exists = await captureReject(() => upper.mkdir("/data"));
      expect(String((exists as Error).message)).toMatch(/EEXIST/);

      const noParent = await captureReject(() => upper.mkdir("/nope/sub"));
      expect(String((noParent as Error).message)).toMatch(/ENOENT/);

      await upper.mkdir("/nope/sub/deep", { recursive: true });
      expect((await upper.stat("/nope/sub/deep"))?.isDirectory).toBe(true);
      expect((await upper.stat("/nope/sub"))?.isDirectory).toBe(true);
    });

    it("removes an empty upper directory but not a populated one", async () => {
      const upper = new CowFsBackend();
      await upper.mkdir("/empty");
      await upper.mkdir("/full");
      await upper.writeFile("/full/f", "x");

      await upper.rmdir("/empty");
      expect(await upper.stat("/empty")).toBeUndefined();

      const notEmpty = await captureReject(() => upper.rmdir("/full"));
      expect(String((notEmpty as Error).message)).toMatch(/ENOTEMPTY/);
      expect((await upper.stat("/full"))?.isDirectory).toBe(true);
    });

    it("rejects rmdir on a file and unlink on a directory", async () => {
      const upper = new CowFsBackend({ lower: await seededLower() });

      const notDir = await captureReject(() => upper.rmdir("/data/keep"));
      expect(String((notDir as Error).message)).toMatch(/ENOTDIR/);

      const isDir = await captureReject(() => upper.unlink("/data"));
      expect(String((isDir as Error).message)).toMatch(/EISDIR/);

      const missing = await captureReject(() => upper.unlink("/data/nope"));
      expect(String((missing as Error).message)).toMatch(/ENOENT/);
    });

    it("enforces the memory ceiling on the writable layer", async () => {
      const upper = new CowFsBackend({ maxMemoryBytes: 4 });

      const error = await captureReject(() => upper.writeFile("/f", "12345"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/would exceed 4 bytes/);
      expect(upper.retainedMemoryBytes).toBe(0);
    });

    it("enforces the single-file read ceiling against the lower layer", async () => {
      const lower = new CowFsBackend();
      await lower.writeFile("/big", "x".repeat(20));
      const upper = new CowFsBackend({ lower, maxFileReadSize: 10 });

      const error = await captureReject(() => upper.readFile("/big"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/EFBIG/);
    });

    it("makes every mutating operation throw EROFS when read-only", async () => {
      const upper = new CowFsBackend({ lower: await seededLower(), readOnly: true });

      for (const op of [
        () => upper.writeFile("/data/x", "x"),
        () => upper.mkdir("/data/x"),
        () => upper.unlink("/data/keep"),
        () => upper.rmdir("/data"),
      ]) {
        const error = await captureReject(op);
        expect(error).toBeInstanceOf(FileSystemPolicyError);
        expect(String((error as Error).message)).toMatch(/EROFS/);
      }
      // Reads still pass through.
      expect(await upper.readFile("/data/keep", { encoding: "utf-8" })).toBe("lower-keep");
    });

    it("rejects a path outside the permitted root", async () => {
      const upper = new CowFsBackend({ lower: await seededLower(), root: "/data" });

      expect(await upper.readFile("/data/keep", { encoding: "utf-8" })).toBe("lower-keep");

      const error = await captureReject(() => upper.readFile("/etc/passwd"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/outside the permitted root/);
    });
  });

  describe("symlinks", () => {
    it("refuses to create or follow a symlink when they are disabled", async () => {
      const lower = new CowFsBackend({ allowSymlinks: true });
      await lower.symlink("/target", "/data/link");
      await lower.writeFile("/target", "t");
      const upper = new CowFsBackend({ lower });

      // Following one is denied even when the lower layer already holds the link.
      const traversal = await captureReject(() => upper.readFile("/data/link"));
      expect(traversal).toBeInstanceOf(FileSystemPolicyError);
      expect(String((traversal as Error).message)).toMatch(/traversal is disabled/);

      // Creating one is denied for the same reason.
      const creation = await captureReject(() => upper.symlink("/target", "/data/mine"));
      expect(String((creation as Error).message)).toMatch(/symbolic links are disabled/);
    });

    it("follows a symlink to the lower layer when allowed", async () => {
      const lower = new CowFsBackend({ allowSymlinks: true });
      await lower.symlink("/target", "/data/link");
      await lower.writeFile("/target", "t");
      const upper = new CowFsBackend({ lower, allowSymlinks: true });

      expect(await upper.readFile("/data/link", { encoding: "utf-8" })).toBe("t");
      expect(await upper.readlink("/data/link")).toBe("/target");
    });

    it("terminates a self-referential symlink with ELOOP", async () => {
      const fs = new CowFsBackend({ allowSymlinks: true });
      await fs.symlink("/loop", "/loop");

      const error = await captureReject(() => fs.realpath("/loop"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/ELOOP|cycle/);
    });

    it("terminates a mutual symlink cycle with ELOOP", async () => {
      const fs = new CowFsBackend({ allowSymlinks: true });
      await fs.symlink("/b", "/a");
      await fs.symlink("/a", "/b");

      const error = await captureReject(() => fs.realpath("/a"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/ELOOP|cycle/);
    });

    it("bounds a symlink chain at MAX_SYMLINK_DEPTH instead of hanging", async () => {
      const fs = new CowFsBackend({ allowSymlinks: true });
      // A chain longer than the depth limit has no cycle, so only the depth ceiling
      // stops it — this is the case that would hang if the guard were missing.
      for (let index = 0; index < MAX_SYMLINK_DEPTH + 10; index++) {
        await fs.symlink(`/s${index + 1}`, `/s${index}`);
      }

      const error = await captureReject(() => fs.realpath("/s0"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/too many levels of symbolic links/);
    });

    it("resolves a relative symlink target against the link's directory", async () => {
      const fs = new CowFsBackend({ allowSymlinks: true });
      await fs.mkdir("/dir");
      await fs.writeFile("/dir/real", "r");
      await fs.symlink("real", "/dir/rel");
      await fs.symlink("../dir/real", "/dir/up");

      expect(await fs.realpath("/dir/rel")).toBe("/dir/real");
      expect(await fs.realpath("/dir/up")).toBe("/dir/real");
      expect(await fs.readFile("/dir/rel", { encoding: "utf-8" })).toBe("r");
    });

    it("catches a symlink that points outside the root", async () => {
      const fs = new CowFsBackend({ allowSymlinks: true, root: "/sandbox" });
      await fs.symlink("/etc/passwd", "/sandbox/escape");

      const error = await captureReject(() => fs.realpath("/sandbox/escape"));
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/outside the permitted root/);
    });
  });

  describe("mount point translation", () => {
    it("maps the mount point to the lower layer's root", async () => {
      const lower = new FakeFs();
      lower.stats.set("/", dirStat("root"));
      lower.listings.set("/", ["data"]);
      lower.stats.set("/data", dirStat("data"));
      lower.listings.set("/data", ["f.txt"]);
      lower.stats.set("/data/f.txt", fileStat("f", 5));
      lower.contents.set("/data/f.txt", encoder.encode("lower"));

      const upper = new CowFsBackend({ lower, mountPoint: "/mnt/sandbox" });

      expect(await upper.readdir("/mnt/sandbox")).toEqual(["data"]);
      expect(await upper.readFile("/mnt/sandbox/data/f.txt", { encoding: "utf-8" })).toBe("lower");
    });

    it("passes a path outside the mount point through unchanged", async () => {
      const lower = new FakeFs();
      lower.stats.set("/other/x", fileStat("x", 0));

      const upper = new CowFsBackend({ lower, mountPoint: "/mnt/sandbox" });
      expect((await upper.stat("/other/x"))?.isFile).toBe(true);
    });
  });

  describe("FileTraversalBudget", () => {
    it("charges one unit of work per checkpoint and trips the work ceiling", () => {
      const budget = new FileTraversalBudget({
        limits: resolveLimits({ maxTraversalWork: 3 }),
        site: "test",
        label: "scan",
      });

      expect(() => budget.checkpoint()).not.toThrow();
      expect(() => budget.checkpoint()).not.toThrow();
      expect(() => budget.checkpoint()).not.toThrow();

      const error = captureThrow(() => budget.checkpoint());
      expect(error).toBeInstanceOf(TraversalBudgetError);
      expect((error as TraversalBudgetError).kind).toBe("iterations");
      expect(String((error as Error).message)).toMatch(/scan/);
      expect(String((error as Error).message)).toMatch(/limit exceeded/);
    });

    it("treats a zero-work checkpoint as free, so a tree walk's loop is unbillable", () => {
      const budget = new FileTraversalBudget({
        limits: resolveLimits({ maxTraversalWork: 0 }),
        site: "test",
      });

      for (let index = 0; index < 100; index++) {
        expect(() => budget.checkpoint(0)).not.toThrow();
      }
      const error = captureThrow(() => budget.checkpoint(1));
      expect((error as TraversalBudgetError).kind).toBe("iterations");
    });

    it("rejects negative and non-integer work", () => {
      const budget = new FileTraversalBudget({
        limits: resolveLimits({ maxTraversalWork: 10 }),
        site: "test",
      });

      expect(captureThrow(() => budget.checkpoint(-1))).toBeInstanceOf(TraversalBudgetError);
      expect(captureThrow(() => budget.checkpoint(1.5))).toBeInstanceOf(TraversalBudgetError);
      expect(captureThrow(() => budget.checkpoint(Number.NaN))).toBeInstanceOf(
        TraversalBudgetError,
      );
    });

    it("enforces the depth ceiling with the recursion kind", () => {
      const budget = new FileTraversalBudget({
        limits: resolveLimits({ maxTraversalDepth: 2 }),
        site: "test",
        label: "scan",
      });

      expect(() => budget.visit(2)).not.toThrow();

      const error = captureThrow(() => budget.visit(3));
      expect(error).toBeInstanceOf(TraversalBudgetError);
      expect((error as TraversalBudgetError).kind).toBe("recursion");
      expect(String((error as Error).message)).toMatch(/depth limit exceeded/);
    });

    it("enforces the entry ceiling with the iterations kind", () => {
      const budget = new FileTraversalBudget({
        limits: resolveLimits({ maxTraversalEntries: 1 }),
        site: "test",
      });

      expect(() => budget.visit(0)).not.toThrow();
      const error = captureThrow(() => budget.visit(0));
      expect(error).toBeInstanceOf(TraversalBudgetError);
      expect((error as TraversalBudgetError).kind).toBe("iterations");
      expect(String((error as Error).message)).toMatch(/entry limit exceeded/);
    });

    it("charges reserved children against the discovery ceiling before they are queued", () => {
      const budget = new FileTraversalBudget({
        limits: resolveLimits({ maxTraversalEntries: 2 }),
        site: "test",
      });

      expect(() => budget.reserve(1)).not.toThrow();
      const error = captureThrow(() => budget.reserve(1));
      expect((error as TraversalBudgetError).kind).toBe("iterations");
    });

    it("charges discover for both the entry and the work", () => {
      const budget = new FileTraversalBudget({
        limits: resolveLimits({ maxTraversalEntries: 10, maxTraversalWork: 1 }),
        site: "test",
        label: "scan",
      });

      expect(() => budget.discover(1)).not.toThrow();
      const error = captureThrow(() => budget.discover(1));
      expect(error).toBeInstanceOf(TraversalBudgetError);
      expect(String((error as Error).message)).toMatch(/limit exceeded/);
    });

    it("reports an aborted signal as an iteration error", () => {
      const controller = new AbortController();
      const budget = new FileTraversalBudget({
        limits: resolveLimits(),
        site: "test",
        signal: controller.signal,
      });

      expect(() => budget.checkpoint()).not.toThrow();
      controller.abort();

      const error = captureThrow(() => budget.checkpoint());
      expect(error).toBeInstanceOf(TraversalBudgetError);
      expect((error as TraversalBudgetError).kind).toBe("iterations");
      expect(String((error as Error).message)).toMatch(/aborted/);
    });
  });

  describe("traverseFileTree", () => {
    async function seededTree(): Promise<CowFsBackend> {
      const fs = new CowFsBackend();
      await fs.mkdir("/tree");
      await fs.writeFile("/tree/b", "b");
      await fs.writeFile("/tree/a", "a");
      await fs.mkdir("/tree/sub");
      await fs.writeFile("/tree/sub/c", "c");
      return fs;
    }

    it("walks the tree depth-first in sorted order and reports depth", async () => {
      const fs = await seededTree();
      const entered: Array<{ path: string; depth: number }> = [];
      const left: string[] = [];

      await traverseFileTree(
        { fs, root: "/tree", limits: resolveLimits({}), site: "test", includeLeave: true },
        async (entry) => {
          if (entry.phase === "enter") entered.push({ path: entry.path, depth: entry.depth });
          else left.push(entry.path);
        },
      );

      expect(entered.map((e) => e.path)).toEqual([
        "/tree",
        "/tree/a",
        "/tree/b",
        "/tree/sub",
        "/tree/sub/c",
      ]);
      expect(entered.map((e) => e.depth)).toEqual([0, 1, 1, 1, 2]);
      expect(left).toEqual(["/tree/sub", "/tree"]);
    });

    it("skips the leave phase entirely without includeLeave", async () => {
      const fs = await seededTree();
      const phases: string[] = [];

      await traverseFileTree(
        { fs, root: "/tree", limits: resolveLimits({}), site: "test" },
        async (entry) => {
          phases.push(entry.phase);
        },
      );

      expect(phases).toEqual(["enter", "enter", "enter", "enter", "enter"]);
    });

    it("stops a walk that outgrows the shared entry budget", async () => {
      const fs = await seededTree();
      const limits = resolveLimits({ maxTraversalEntries: 2 });
      const budget = new FileTraversalBudget({ limits, site: "test" });
      const visited: string[] = [];

      await expect(
        traverseFileTree({ fs, root: "/tree", limits, site: "test", budget }, async (entry) => {
          visited.push(entry.path);
        }),
      ).rejects.toThrow(TraversalBudgetError);

      // The walk got somewhere before the ceiling landed, and it did not complete.
      expect(visited).toContain("/tree");
      expect(visited).not.toContain("/tree/sub/c");
    });

    it("flags a directory reached twice by identity as a cycle", async () => {
      // Two names reporting one alias-resistant identity, each listing the other:
      // a naive visited-set would also suppress the legitimate case below, but the
      // active-ancestor set catches this one.
      const fs = new FakeFs();
      fs.stats.set("/a", dirStat("same-dir"));
      fs.listings.set("/a", ["b"]);
      fs.stats.set("/a/b", dirStat("same-dir"));
      fs.listings.set("/a/b", ["a"]);

      await expect(
        traverseFileTree(
          { fs, root: "/a", limits: resolveLimits({}), site: "test" },
          async () => {},
        ),
      ).rejects.toThrow(/symbolic-link directory cycle detected/);
    });

    it("allows the same directory identity to recur in a separate branch", async () => {
      const fs = new FakeFs();
      fs.stats.set("/root", dirStat("root"));
      fs.listings.set("/root", ["a", "b"]);
      fs.stats.set("/root/a", dirStat("shared"));
      fs.listings.set("/root/a", []);
      fs.stats.set("/root/b", dirStat("shared"));
      fs.listings.set("/root/b", []);

      const entered: string[] = [];
      await traverseFileTree(
        { fs, root: "/root", limits: resolveLimits({}), site: "test", includeLeave: true },
        async (entry) => {
          if (entry.phase === "enter") entered.push(entry.path);
        },
      );

      // /root/b carries the same identity as /root/a, but /root/a has already
      // left the active-ancestor set, so the recurrence is a branch, not a cycle.
      expect(entered).toEqual(["/root", "/root/a", "/root/b"]);
    });
  });

  describe("identity and containment", () => {
    async function seeded(): Promise<CowFsBackend> {
      const fs = new CowFsBackend();
      await fs.writeFile("/a", "a");
      await fs.writeFile("/b", "b");
      await fs.mkdir("/dir");
      return fs;
    }

    it("resolves an existing path to a stable identity and canonical path", async () => {
      const fs = await seeded();

      const resolved = await resolveFileIdentity(fs, "/a/../a");
      expect(resolved.existence).toBe("existing");
      // `stableIdentity` exists only on the existing branch of the result union.
      const existing = resolved as Extract<typeof resolved, { existence: "existing" }>;
      expect(existing.canonicalPath).toBe("/a");
      expect(existing.stableIdentity).toMatch(/^identity:cow:/);
    });

    it("resolves a missing path to the canonical path it would occupy", async () => {
      const fs = await seeded();

      const resolved = await resolveFileIdentity(fs, "/dir/new/deep");
      expect(resolved.existence).toBe("missing");
      // The canonical path a new entry would occupy exists only on the missing branch.
      const missing = resolved as Extract<typeof resolved, { existence: "missing" }>;
      expect(missing.canonicalPath).toBe("/dir/new/deep");
    });

    it("reports unknown when stat itself throws", async () => {
      // A filesystem whose root excludes the queried path: stat rejects, so the
      // comparison cannot claim either sameness or difference.
      const fs = new CowFsBackend({ root: "/sandbox" });
      expect((await resolveFileIdentity(fs, "/etc/x")).existence).toBe("unknown");
    });

    it("calls two spellings of one file same and two files different", async () => {
      const fs = await seeded();

      expect(await compareFileIdentity(fs, "/a", "/a/../a")).toBe("same");
      expect(await compareFileIdentity(fs, "/a", "/b")).toBe("different");
    });

    it("calls an existing and a missing path different", async () => {
      const fs = await seeded();
      expect(await compareFileIdentity(fs, "/a", "/nope")).toBe("different");
    });

    it("answers unknown for two missing paths that do not coincide", async () => {
      const fs = await seeded();
      expect(await compareFileIdentity(fs, "/nope/x", "/nope/y")).toBe("unknown");
      // Two spellings of the same missing path do coincide.
      expect(await compareFileIdentity(fs, "/nope/x", "/nope/./x")).toBe("same");
    });

    it("answers unknown when either side cannot be resolved", async () => {
      const fs = new CowFsBackend({ root: "/sandbox" });
      expect(await compareFileIdentity(fs, "/etc/x", "/etc/y")).toBe("unknown");
    });

    it("classifies a destination inside or outside a source directory", async () => {
      const fs = await seeded();

      expect(await compareCanonicalContainment(fs, "/dir", "/dir/new/deep")).toBe("inside");
      expect(await compareCanonicalContainment(fs, "/dir", "/a")).toBe("outside");
      // A source that does not exist cannot contain anything.
      expect(await compareCanonicalContainment(fs, "/nope", "/dir")).toBe("unknown");
    });

    it("canonicalizes and brands a path inside the policy root", async () => {
      const fs = await seeded();
      const canonical = await canonicalizePath(fs, "/dir/../a", { root: "/" });
      expect(canonical).toBe("/a");
    });

    it("rejects a path whose canonical form escapes the policy root", async () => {
      // The backend's own guard would catch this first if it went through realpath;
      // here the lower layer's realpath is what escapes, so the policy check itself
      // is the one that fires.
      const fs = new FakeFs();
      fs.realpaths.set("/sandbox/link", "/etc/secret");

      const error = await captureReject(() =>
        canonicalizePath(fs, "/sandbox/link", { root: "/sandbox" }),
      );
      expect(error).toBeInstanceOf(FileSystemPolicyError);
      expect(String((error as Error).message)).toMatch(/resolves outside the permitted root/);
    });
  });
});
