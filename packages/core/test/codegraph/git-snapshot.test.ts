import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
