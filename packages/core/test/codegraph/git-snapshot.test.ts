import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitSnapshotError, GitSnapshotReader } from "../../src/codegraph/git-snapshot.js";

const repositories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true });
});

function createBareRepository(): string {
  const repository = mkdtempSync(path.join(os.tmpdir(), "penguin-git-snapshot-bare-"));
  repositories.push(repository);
  git(repository, "init", "--quiet", "--bare");
  return repository;
}

function tag(repository: string, name: string, revision: string): void {
  git(repository, "tag", name, revision);
}

function createRepository(): string {
  const repository = mkdtempSync(path.join(os.tmpdir(), "penguin-git-snapshot-"));
  repositories.push(repository);
  git(repository, "init", "--quiet");
  git(repository, "config", "user.name", "Snapshot Test");
  git(repository, "config", "user.email", "snapshot@example.invalid");
  git(repository, "config", "core.autocrlf", "false");
  return repository;
}

function git(repository: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
}

function commit(repository: string, message: string): string {
  git(repository, "add", "-A");
  git(repository, "commit", "--quiet", "-m", message);
  return git(repository, "rev-parse", "HEAD").toString("ascii").trim();
}

describe("GitSnapshotReader", () => {
  it("diffs two committed trees using one deduplicated blob batch without changing the worktree", async () => {
    const repository = createRepository();
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src", "shared.ts"), "export const value = 1;\n");
    writeFileSync(path.join(repository, "src", "removed.ts"), "export const removed = true;\n");
    writeFileSync(path.join(repository, "src", "stable.ts"), "export const stable = true;\n");
    const base = commit(repository, "base");

    writeFileSync(path.join(repository, "src", "shared.ts"), "export const value = 2;\n");
    rmSync(path.join(repository, "src", "removed.ts"));
    writeFileSync(path.join(repository, "src", "added.ts"), "export const added = true;\n");
    const head = commit(repository, "head");

    writeFileSync(path.join(repository, "src", "shared.ts"), "dirty working copy must survive\n");
    writeFileSync(path.join(repository, "untracked.txt"), "also survives\n");
    const statusBefore = git(repository, "status", "--porcelain=v1", "-z");
    const dirtyBytesBefore = readFileSync(path.join(repository, "src", "shared.ts"));
    const untrackedBytesBefore = readFileSync(path.join(repository, "untracked.txt"));

    const pair = await new GitSnapshotReader(repository).readPair(base, head);

    expect(pair.base.entries.get("src/shared.ts")?.content.toString()).toBe(
      "export const value = 1;\n",
    );
    expect(pair.head.entries.get("src/shared.ts")?.content.toString()).toBe(
      "export const value = 2;\n",
    );
    expect(pair.changes.map(({ status, path: filePath }) => `${status}:${filePath}`)).toEqual([
      "added:src/added.ts",
      "deleted:src/removed.ts",
      "modified:src/shared.ts",
    ]);
    expect(pair.uniqueBlobCount).toBe(5);
    expect(pair.base.entries.size + pair.head.entries.size).toBe(6);
    expect(pair.base.entries.get("src/stable.ts")?.content).toBe(
      pair.head.entries.get("src/stable.ts")?.content,
    );
    expect(pair.uniqueBlobBytes).toBeGreaterThan(0);
    expect(git(repository, "status", "--porcelain=v1", "-z")).toEqual(statusBefore);
    expect(readFileSync(path.join(repository, "src", "shared.ts"))).toEqual(dirtyBytesBefore);
    expect(readFileSync(path.join(repository, "untracked.txt"))).toEqual(untrackedBytesBefore);
  });

  it("turns an absent blob referenced by a committed tree into a typed missing-object error", async () => {
    const repository = createRepository();
    const missingObjectId = createHash("sha1").update("blob that is not present").digest("hex");
    const treeData = Buffer.concat([
      Buffer.from("100644 ghost.ts\0", "ascii"),
      Buffer.from(missingObjectId, "hex"),
    ]);
    const treeId = execFileSync("git", ["hash-object", "-t", "tree", "-w", "--stdin"], {
      cwd: repository,
      input: treeData,
    })
      .toString("ascii")
      .trim();
    const commitData = Buffer.from(
      `tree ${treeId}\nauthor Snapshot Test <snapshot@example.invalid> 1700000000 +0000\n` +
        "committer Snapshot Test <snapshot@example.invalid> 1700000000 +0000\n\nmissing blob\n",
      "utf8",
    );
    const brokenCommit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: repository,
      input: commitData,
    })
      .toString("ascii")
      .trim();

    await expect(
      new GitSnapshotReader(repository).readPair(brokenCommit, brokenCommit),
    ).rejects.toMatchObject({
      name: "GitSnapshotError",
      code: "missing-object",
      objectId: missingObjectId,
    });
  });

  it("rejects binary blobs and objects over the configured limit with typed errors", async () => {
    const binaryRepository = createRepository();
    writeFileSync(path.join(binaryRepository, "image.bin"), Buffer.from([0x41, 0, 0x42]));
    const binaryCommit = commit(binaryRepository, "binary");
    await expect(
      new GitSnapshotReader(binaryRepository).readPair(binaryCommit, binaryCommit),
    ).rejects.toMatchObject({
      name: "GitSnapshotError",
      code: "binary-object",
      filePath: "image.bin",
    });

    const largeRepository = createRepository();
    writeFileSync(path.join(largeRepository, "large.ts"), "0123456789");
    const largeCommit = commit(largeRepository, "large object");
    await expect(
      new GitSnapshotReader(largeRepository, { maxObjectBytes: 4, maxTotalBytes: 16 }).readPair(
        largeCommit,
        largeCommit,
      ),
    ).rejects.toMatchObject({ name: "GitSnapshotError", code: "object-too-large" });
  });

  it("kills an in-flight Git process when its caller aborts", async () => {
    const repository = createRepository();
    writeFileSync(path.join(repository, "file.ts"), "export const value = 1;\n");
    const head = commit(repository, "base");
    const controller = new AbortController();
    const read = new GitSnapshotReader(repository).readPair(head, head, {
      signal: controller.signal,
    });
    process.nextTick(() => controller.abort());
    await expect(read).rejects.toBeInstanceOf(GitSnapshotError);
    await expect(read).rejects.toMatchObject({ code: "interrupted" });
  });

  it("rejects an invalid revision with a typed error before spawning Git", async () => {
    const repository = createRepository();
    writeFileSync(path.join(repository, "file.ts"), "export const value = 1;\n");
    const head = commit(repository, "base");
    const reader = new GitSnapshotReader(repository);
    await expect(reader.readPair("no-such-revision", head)).rejects.toMatchObject({
      name: "GitSnapshotError",
      code: "invalid-revision",
      revision: "no-such-revision",
    });
    await expect(reader.readPair("a".repeat(1025), head)).rejects.toMatchObject({
      code: "invalid-revision",
    });
    await expect(reader.readPair("bad\0revision", head)).rejects.toMatchObject({
      code: "invalid-revision",
    });
    // The rejected reads did not disturb the repository.
    expect(git(repository, "rev-parse", "HEAD").toString("ascii").trim()).toBe(head);
  });

  it("bounds the tree entry count with a typed snapshot-too-large error", async () => {
    const repository = createRepository();
    for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(path.join(repository, name), name);
    const head = commit(repository, "three files");
    await expect(
      new GitSnapshotReader(repository, { maxEntries: 2 }).readPair(head, head),
    ).rejects.toMatchObject({ name: "GitSnapshotError", code: "snapshot-too-large" });
  });

  it("bounds ls-tree output bytes with a typed snapshot-too-large error", async () => {
    const repository = createRepository();
    for (let index = 0; index < 40; index++) {
      writeFileSync(path.join(repository, `file-${index}.ts`), `export const value = ${index};\n`);
    }
    const head = commit(repository, "many files");
    // The stream bound is what fires here, not the entry count: 40 entries pass maxEntries, and
    // the subprocess output exceeds the tree byte limit before the count is ever consulted.
    await expect(
      new GitSnapshotReader(repository, { maxEntries: 1000, maxTreeBytes: 64 }).readPair(
        head,
        head,
      ),
    ).rejects.toMatchObject({ name: "GitSnapshotError", code: "snapshot-too-large" });
  });

  it("ignores every inherited Git location/namespace override, not just GIT_DIR", async () => {
    const repository = createRepository();
    writeFileSync(path.join(repository, "file.ts"), "real content\n");
    const base = commit(repository, "real base");
    writeFileSync(path.join(repository, "file.ts"), "real head\n");
    const head = commit(repository, "real head");
    tag(repository, "snapshot-base", base);
    tag(repository, "snapshot-head", head);

    const decoy = createRepository();
    writeFileSync(path.join(decoy, "file.ts"), "decoy content\n");
    commit(decoy, "decoy");
    const decoyObjects = path.join(decoy, ".git", "objects");
    // Every override Git accepts for redirecting a read: with any one of them honoured, either
    // the tag would not resolve (namespace) or the content/staging area would come from the decoy.
    vi.stubEnv("GIT_DIR", path.join(decoy, ".git"));
    vi.stubEnv("GIT_WORK_TREE", decoy);
    vi.stubEnv("GIT_COMMON_DIR", path.join(decoy, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", path.join(decoy, ".git", "index"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", decoyObjects);
    vi.stubEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", decoyObjects);
    vi.stubEnv("GIT_NAMESPACE", "decoy-namespace");

    const pair = await new GitSnapshotReader(repository).readPair("snapshot-base", "snapshot-head");
    expect(pair.base.entries.get("file.ts")?.content.toString()).toBe("real content\n");
    expect(pair.head.entries.get("file.ts")?.content.toString()).toBe("real head\n");
    expect(pair.changes.map((change) => change.status)).toEqual(["modified"]);
  });

  it("reads a bare repository: no checkout, no worktree, no index needed", async () => {
    const origin = createRepository();
    writeFileSync(path.join(origin, "file.ts"), "export const value = 1;\n");
    const base = commit(origin, "base");
    writeFileSync(path.join(origin, "file.ts"), "export const value = 2;\n");
    const head = commit(origin, "head");

    // A clone without a worktree: the reader's whole contract is "committed objects only", so it
    // must work with no files on disk and no index to consult.
    const bare = createBareRepository();
    git(origin, "push", "--quiet", bare, `${base}:refs/heads/base`, `${head}:refs/heads/head`);

    const pair = await new GitSnapshotReader(bare).readPair("base", "head");
    expect(pair.base.entries.get("file.ts")?.content.toString()).toBe("export const value = 1;\n");
    expect(pair.head.entries.get("file.ts")?.content.toString()).toBe("export const value = 2;\n");
    expect(pair.changes.map((change) => `${change.status}:${change.path}`)).toEqual([
      "modified:file.ts",
    ]);
    // Nothing was checked out: the bare directory holds only Git's own files, and the revisions
    // resolve by ref as well as by object id.
    expect(existsSync(path.join(bare, "file.ts"))).toBe(false);
    expect(readdirSync(bare)).toContain("objects");
    const byObjectId = await new GitSnapshotReader(bare).readPair(base, head);
    expect(byObjectId.changes.map((change) => change.status)).toEqual(["modified"]);
  });

  it("does not rewrite the index or the worktree of the repository it reads", async () => {
    const repository = createRepository();
    writeFileSync(path.join(repository, "file.ts"), "export const value = 1;\n");
    const base = commit(repository, "base");
    writeFileSync(path.join(repository, "file.ts"), "export const value = 2;\n");
    const head = commit(repository, "head");
    const indexPath = path.join(repository, ".git", "index");
    const indexBefore = readFileSync(indexPath);
    const statusBefore = git(repository, "status", "--porcelain=v1", "-z");

    await new GitSnapshotReader(repository).readPair(base, head);

    // `git status` refreshes stat information in the index; the reader is not allowed to: the
    // index bytes and the porcelain output must both be exactly as they were.
    expect(readFileSync(indexPath)).toEqual(indexBefore);
    expect(git(repository, "status", "--porcelain=v1", "-z")).toEqual(statusBefore);
  });

  it("selects source files before fetching unrelated binary assets", async () => {
    const repository = createRepository();
    writeFileSync(path.join(repository, "file.ts"), "export const value = 1;\n");
    writeFileSync(path.join(repository, "asset.bin"), Buffer.alloc(100, 0));
    const head = commit(repository, "source and binary");
    const pair = await new GitSnapshotReader(repository, {
      maxObjectBytes: 50,
      maxTotalBytes: 50,
    }).readPair(head, head, { includePath: (filePath) => filePath.endsWith(".ts") });
    expect([...pair.head.entries.keys()]).toEqual(["file.ts"]);
    expect(pair.uniqueBlobCount).toBe(1);
  });

  it("reads the requested repository and original objects despite inherited Git settings and replace refs", async () => {
    const repository = createRepository();
    writeFileSync(path.join(repository, "file.ts"), "original\n");
    const base = commit(repository, "original");
    writeFileSync(path.join(repository, "file.ts"), "replacement\n");
    const head = commit(repository, "replacement");
    git(repository, "replace", base, head);
    const otherRepository = createRepository();
    writeFileSync(path.join(otherRepository, "other.ts"), "unrelated\n");
    commit(otherRepository, "unrelated");
    vi.stubEnv("GIT_DIR", path.join(otherRepository, ".git"));
    vi.stubEnv("GIT_WORK_TREE", otherRepository);
    const pair = await new GitSnapshotReader(repository).readPair(base, head);
    expect(pair.base.entries.get("file.ts")?.content.toString()).toBe("original\n");
    expect(pair.head.entries.get("file.ts")?.content.toString()).toBe("replacement\n");
    expect(pair.changes.map((change) => change.status)).toEqual(["modified"]);
  });
});
