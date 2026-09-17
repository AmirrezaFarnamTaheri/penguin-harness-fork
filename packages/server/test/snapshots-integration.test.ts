/**
 * Live snapshot listing integration: GET /api/projects/:p/agents/:a/snapshots
 * serves the versions SnapshotService actually wrote to snapshots/v<N>.tar.gz —
 * the same files the export/import flow creates, not a second data source.
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { snapshotsDir } from "@prismshadow/penguin-core";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import type { AgentSnapshotsResponse, ProjectCreateResponse } from "../src/api/types.js";

describe("agent snapshot listing", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let projectId: string;
  let base: string;

  beforeEach(async () => {
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner_a");
    owner = apiClient(t.app, a.cookie);
    const created = (await (
      await owner.post("/api/projects", { projectId: "owner_a-snaps", name: "Snapshots" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
    base = `/api/projects/${projectId}/agents/default_agent`;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("serves an empty live list before any export, and the exported version after", async () => {
    const before = await owner.get(`${base}/snapshots`);
    expect(before.status).toBe(200);
    expect(((await before.json()) as AgentSnapshotsResponse).snapshots).toEqual([]);

    // The export flow is what creates snapshots/v1.tar.gz; the listing must show it.
    expect((await owner.get(`${base}/export`)).status).toBe(200);
    const res = await owner.get(`${base}/snapshots`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentSnapshotsResponse;
    expect(body.currentVersion).toBe(1);
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]).toMatchObject({
      version: 1,
      fileName: "v1.tar.gz",
      isCurrent: true,
    });
    expect(body.snapshots[0]!.sizeBytes).toBeGreaterThan(0);
  });

  it("stays project-scoped: a non-member is refused, an unknown agent is 404", async () => {
    const outsider = await provisionUser(t.app, "outsider_o");
    const other = apiClient(t.app, outsider.cookie);
    expect((await other.get(`${base}/snapshots`)).status).toBe(404);
    expect((await owner.get(`/api/projects/${projectId}/agents/ghost/snapshots`)).status).toBe(404);
  });
});
