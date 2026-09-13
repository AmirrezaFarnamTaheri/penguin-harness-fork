import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/environment/worktrees.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function initRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-worktree-test-"));
  roots.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Penguin Test"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })),
  );
});

describe("WorktreeManager", () => {
  it("rolls back its lane reservation when Git creation fails", async () => {
    const root = await initRepository();
    const manager = new WorktreeManager(root);

    await execFileAsync("git", ["branch", "already-exists"], { cwd: root });
    await expect(manager.createWorktree("worker-a", "already-exists")).rejects.toBeTruthy();

    await expect(
      fs.access(path.join(root, ".lanes", ".registry", "worker-a.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const created = await manager.createWorktree("worker-a", "worker-a-fresh");
    expect(created.agentId).toBe("worker-a");
    expect(created.branch).toBe("worker-a-fresh");
    expect(created.worktreePath).toBe(path.join(root, ".lanes", "worker-a"));

    await manager.removeWorktree(created.worktreePath);
    await expect(fs.access(created.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to replace an existing managed lane", async () => {
    const root = await initRepository();
    const manager = new WorktreeManager(root);
    const created = await manager.createWorktree("worker-b", "worker-b-branch");

    await expect(manager.createWorktree("worker-b", "other-branch")).rejects.toThrow(
      /already exists/,
    );

    await manager.removeWorktree(created.worktreePath);
  });
});
