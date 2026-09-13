import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectJsonStore } from "../src/services/project-json-store.js";
import { makeTempRoot } from "./helpers.js";

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid ?? 2 ** 21;
}

function decodeCounter(raw: string): { count: number } {
  const parsed = JSON.parse(raw) as { count?: unknown };
  if (!Number.isInteger(parsed.count) || (parsed.count as number) < 0) {
    throw new Error("invalid counter");
  }
  return { count: parsed.count as number };
}

describe("ProjectJsonStore stale-lock recovery", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function fixture(): Promise<{
    root: string;
    projectId: string;
    target: string;
    first: ProjectJsonStore<{ count: number }>;
    second: ProjectJsonStore<{ count: number }>;
  }> {
    const root = await makeTempRoot();
    roots.push(root);
    const projectId = "recovery_project";
    const target = path.join(root, projectId, ".counter.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const create = () =>
      new ProjectJsonStore(root, ".counter.json", () => ({ count: 0 }), decodeCounter);
    return { root, projectId, target, first: create(), second: create() };
  }

  async function ageLock(lockPath: string): Promise<void> {
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, old, old);
  }

  async function incrementConcurrently(
    projectId: string,
    first: ProjectJsonStore<{ count: number }>,
    second: ProjectJsonStore<{ count: number }>,
  ): Promise<void> {
    const increment = (current: { count: number }) => ({
      value: { count: current.count + 1 },
      result: undefined,
    });
    await Promise.all([first.update(projectId, increment), second.update(projectId, increment)]);
  }

  it("serializes concurrent recovery of a stale dead-owner lock", async () => {
    const { projectId, target, first, second } = await fixture();
    const lockPath = `${target}.lock`;
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        token: "stale-owner",
        pid: deadPid(),
        hostname: os.hostname(),
        createdAt: Date.now() - 120_000,
      }),
    );
    await ageLock(lockPath);

    await incrementConcurrently(projectId, first, second);

    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ count: 2 });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent recovery of a stale unpublished malformed reservation", async () => {
    const { projectId, target, first, second } = await fixture();
    const lockPath = `${target}.lock`;
    await fs.writeFile(lockPath, "{partial");
    await ageLock(lockPath);

    await incrementConcurrently(projectId, first, second);

    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ count: 2 });
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
