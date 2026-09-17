import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, loginAdmin, provisionUser, type TestApp } from "./helpers.js";
import type { WorktreesResponse } from "../src/api/types.js";

const exec = promisify(execFile);
describe("project worktree listing", () => {
  let app: TestApp;
  let cookie: string;
  let workspace: string;
  beforeEach(async () => {
    app = await createTestApp();
    cookie = (await loginAdmin(app.app)).cookie;
    workspace = path.join(app.root, "repository with spaces");
    await fs.mkdir(workspace);
    await exec("git", ["init", workspace]);
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: workspace },
    );
  });
  afterEach(async () => {
    await app?.cleanup();
  });
  const url = (directory: string) =>
    `/api/projects/default_project/worktrees?workspace=${encodeURIComponent(directory)}`;

  it("lists real worktrees including detached entries for the explicitly chosen repository", async () => {
    const lane = path.join(app.root, "detached lane");
    await exec("git", ["worktree", "add", "--detach", lane], { cwd: workspace });
    const response = await apiClient(app.app, cookie).get(url(workspace));
    expect(response.status).toBe(200);
    const body = (await response.json()) as WorktreesResponse;
    expect(body.workspace).toBe(await fs.realpath(workspace));
    expect(body.worktrees).toHaveLength(2);
    expect(body.worktrees).toContainEqual(
      expect.objectContaining({ branch: "", head: expect.stringMatching(/^[a-f0-9]{40}$/) }),
    );
    const listedPaths = await Promise.all(
      body.worktrees.map((entry: { path: string }) => fs.realpath(entry.path)),
    );
    expect(listedPaths).toContain(await fs.realpath(lane));
  });
  it("requires authentication and project access before inspecting a directory", async () => {
    expect((await app.app.request(url(workspace))).status).toBe(401);
    const outsider = await provisionUser(app.app, "worktree_outsider");
    expect((await apiClient(app.app, outsider.cookie).get(url(workspace))).status).toBe(404);
  });
  it("rejects missing or relative workspace and distinguishes a non-repository from an empty list", async () => {
    const client = apiClient(app.app, cookie);
    expect((await client.get(url(""))).status).toBe(400);
    expect((await client.get(url("."))).status).toBe(400);
    const response = await client.get(url(app.root));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "worktree_list_failed" } });
  });
});
