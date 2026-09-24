import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import type { ProjectCreateResponse } from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

describe("upstream-features integration", () => {
  let t: TestApp;
  let userA: ReturnType<typeof apiClient>;
  let userB: ReturnType<typeof apiClient>;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    t = await createTestApp();
    const uA = await provisionUser(t.app, "user_a");
    const uB = await provisionUser(t.app, "user_b");
    userA = apiClient(t.app, uA.cookie);
    userB = apiClient(t.app, uB.cookie);

    const resA = (await (
      await userA.post("/api/projects", { projectId: "user_a-proj_a", name: "Project A" })
    ).json()) as ProjectCreateResponse;
    projectA = resA.project.projectId;

    const resB = (await (
      await userB.post("/api/projects", { projectId: "user_b-proj_b", name: "Project B" })
    ).json()) as ProjectCreateResponse;
    projectB = resB.project.projectId;
  });

  afterEach(async () => {
    await t.cleanup();
  });

  describe("Pipeline routes (F01, F03, F10, F14)", () => {
    it.each([
      { from: "missing", to: "start" },
      { from: "start", to: "missing" },
    ])("rejects unknown edge endpoints as a client error: %j", async (edge) => {
      const response = await userA.post(`/api/projects/${projectA}/pipelines`, {
        id: "bad-edge",
        name: "Invalid edge",
        nodes: [{ id: "start", name: "Start", kind: "trigger" }],
        edges: [edge],
      });
      expect(response.status).toBe(400);
      const listing = await userA.get(`/api/projects/${projectA}/pipelines`);
      expect(await listing.json()).toEqual({ pipelines: [] });
    });

    it("keeps prototype-named nodes runnable after disk persistence", async () => {
      const base = `/api/projects/${projectA}/pipelines`;
      const created = await userA.post(base, {
        id: "prototype-ids",
        name: "Prototype IDs",
        nodes: [
          { id: "__proto__", name: "Start", kind: "trigger" },
          { id: "constructor", name: "Finish", kind: "output" },
        ],
        edges: [{ from: "__proto__", to: "constructor" }],
      });
      expect(created.status).toBe(201);
      const response = await userA.post(`${base}/prototype-ids/runs`, {});
      expect(response.status).toBe(201);
      const { run } = (await response.json()) as { run: { runId: string } };
      const runBase = `${base}/prototype-ids/runs/${run.runId}`;
      const start = await userA.post(`${runBase}/nodes/__proto__/complete`, {});
      expect(start.status).toBe(200);
      const finish = await userA.post(`${runBase}/nodes/constructor/complete`, {});
      expect(finish.status).toBe(200);
      expect(await finish.json()).toMatchObject({
        run: { status: "completed", currentNodeIds: [] },
      });
    });

    it("creates pipeline, enforces DAG validation, persists to disk, and isolates across projects", async () => {
      // 1. Invalid node kind rejected
      const badRes = await userA.post(`/api/projects/${projectA}/pipelines`, {
        id: "bad-pipe",
        name: "Bad Pipeline",
        nodes: [{ id: "n1", name: "Bad Node", kind: "nonexistent_kind" }],
      });
      expect(badRes.status).toBe(400);

      // 2. Valid pipeline created
      const createRes = await userA.post(`/api/projects/${projectA}/pipelines`, {
        id: "pipe-1",
        name: "Workflow 1",
        nodes: [
          { id: "start", name: "Start Node", kind: "trigger" },
          { id: "step1", name: "Agent Step", kind: "agent" },
          { id: "end", name: "Finish", kind: "output" },
        ],
        edges: [
          { from: "start", to: "step1" },
          { from: "step1", to: "end" },
        ],
      });
      expect(createRes.status).toBe(201);

      // 3. Persisted to disk (.pipelines.json)
      const diskPath = path.join(t.root, projectA, ".pipelines.json");
      const diskContent = await fs.readFile(diskPath, "utf-8");
      expect(diskContent).toContain("pipe-1");

      // 4. Project B cannot access Project A's pipelines
      const leakRes = await userB.get(`/api/projects/${projectB}/pipelines`);
      expect(leakRes.status).toBe(200);
      const leakData = (await leakRes.json()) as { pipelines: Array<{ id: string }> };
      expect(leakData.pipelines.some((p) => p.id === "pipe-1")).toBe(false);

      const forbiddenRes = await userB.get(`/api/projects/${projectA}/pipelines`);
      expect(forbiddenRes.status).toBe(404);

      // 5. Create a run in Project A
      const runRes = await userA.post(`/api/projects/${projectA}/pipelines/pipe-1/runs`, {
        context: { init: true },
      });
      expect(runRes.status).toBe(201);
      const runData = (await runRes.json()) as { run: { runId: string; status: string } };
      const runId = runData.run.runId;
      expect(runData.run.status).toBe("running");

      // 6. Project B cannot query the run
      const crossRunRes = await userB.get(
        `/api/projects/${projectB}/pipelines/pipe-1/runs/${runId}`,
      );
      expect(crossRunRes.status).toBe(404);

      // 7. Complete node in run
      const completeRes = await userA.post(
        `/api/projects/${projectA}/pipelines/pipe-1/runs/${runId}/nodes/start/complete`,
        { output: { ok: true } },
      );
      expect(completeRes.status).toBe(200);

      // 8. Run state persisted to disk (.pipeline_runs.json)
      const runsDiskPath = path.join(t.root, projectA, ".pipeline_runs.json");
      const runsDiskContent = await fs.readFile(runsDiskPath, "utf-8");
      expect(runsDiskContent).toContain(runId);
    });
  });

  describe("Gateway combos & endpoints (F02, F05, F06)", () => {
    it("isolates combos per project and persists to disk (.combos.json)", async () => {
      const putRes = await userA.put(`/api/projects/${projectA}/gateway/combos`, {
        id: "combo-sonnet",
        name: "Sonnet Cascade",
        targets: [{ provider: "anthropic", modelId: "claude-3-7-sonnet" }],
      });
      expect(putRes.status).toBe(200);

      // Persisted to disk
      const combosDiskPath = path.join(t.root, projectA, ".combos.json");
      const content = await fs.readFile(combosDiskPath, "utf-8");
      expect(content).toContain("combo-sonnet");

      // Project B does not see Project A's combos
      const listBRes = await userB.get(`/api/projects/${projectB}/gateway/combos`);
      expect(listBRes.status).toBe(200);
      const listB = (await listBRes.json()) as { combos: Array<{ id: string }> };
      expect(listB.combos.some((c) => c.id === "combo-sonnet")).toBe(false);
    });

    it("returns HTTP 501 for chat/completions", async () => {
      const res = await userA.post(`/api/projects/${projectA}/gateway/chat/completions`, {
        model: "claude-3-7-sonnet",
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(res.status).toBe(501);
      const err = (await res.json()) as { error: { code: number; type: string } };
      expect(err.error.code).toBe(501);
      expect(err.error.type).toBe("not_implemented");
    });

    it("validates action and rejects unknown approval in webhook", async () => {
      const badActionRes = await userA.post(`/api/projects/${projectA}/gateway/webhooks/approval`, {
        approvalId: "appr-1",
        action: "invalid_action",
      });
      expect(badActionRes.status).toBe(400);

      const unknownApprRes = await userA.post(
        `/api/projects/${projectA}/gateway/webhooks/approval`,
        {
          approvalId: "nonexistent-appr",
          action: "approve",
        },
      );
      expect(unknownApprRes.status).toBe(404);
    });
  });

  describe("Kanban board (F04, F12, F13, F14)", () => {
    it("validates states, enforces leases and generations, and persists tasks to disk", async () => {
      // 1. Invalid state rejected
      const invalidCreate = await userA.post(`/api/projects/${projectA}/kanban/tasks`, {
        title: "Bad State Task",
        state: "not_a_state",
      });
      expect(invalidCreate.status).toBe(400);

      // 2. Create valid task
      const createRes = await userA.post(`/api/projects/${projectA}/kanban/tasks`, {
        title: "Deploy Service",
        priority: "high",
        state: "backlog",
      });
      expect(createRes.status).toBe(201);
      const taskData = (await createRes.json()) as { task: { id: string } };
      const taskId = taskData.task.id;

      // 3. Persisted to disk (.kanban.json)
      const kanbanDisk = path.join(t.root, projectA, ".kanban.json");
      const diskContent = await fs.readFile(kanbanDisk, "utf-8");
      expect(diskContent).toContain("Deploy Service");

      // 4. Claim task
      const claimRes = await userA.post(`/api/projects/${projectA}/kanban/tasks/${taskId}/claim`, {
        workerId: "worker-alpha",
        leaseDurationMs: 60000,
      });
      expect(claimRes.status).toBe(200);
      const claimed = (await claimRes.json()) as {
        task: { leaseGeneration: number; assignee: string };
      };
      expect(claimed.task.leaseGeneration).toBe(1);
      expect(claimed.task.assignee).toBe("worker-alpha");

      // 5. Heartbeat with wrong worker rejected
      const badWorkerHb = await userA.post(
        `/api/projects/${projectA}/kanban/tasks/${taskId}/heartbeat`,
        {
          workerId: "worker-impostor",
          generation: 1,
        },
      );
      expect(badWorkerHb.status).toBe(400);

      // 6. Release task
      const releaseRes = await userA.post(
        `/api/projects/${projectA}/kanban/tasks/${taskId}/release`,
        {
          workerId: "worker-alpha",
          generation: 1,
        },
      );
      expect(releaseRes.status).toBe(200);

      // 7. Project B cannot view Project A tasks
      const listBRes = await userB.get(`/api/projects/${projectB}/kanban/tasks`);
      expect(listBRes.status).toBe(200);
      const listB = (await listBRes.json()) as { tasks: Array<{ id: string }> };
      expect(listB.tasks.some((tk) => tk.id === taskId)).toBe(false);
    });
  });

  describe("Wiki Engine (F04, F14, F17)", () => {
    it("persists wiki graph and reports broken links upon target deletion", async () => {
      // 1. Add page A linking to page B
      const pageARes = await userA.post(`/api/projects/${projectA}/wiki/nodes`, {
        id: "arch/overview",
        content:
          "---\ntitle: Architecture Overview\ntype: concept\n---\nSee [[arch/storage]] for details.",
      });
      expect(pageARes.status).toBe(201);

      // 2. Add page B
      const pageBRes = await userA.post(`/api/projects/${projectA}/wiki/nodes`, {
        id: "arch/storage",
        content: "---\ntitle: Storage System\ntype: concept\n---\nDetails on database.",
      });
      expect(pageBRes.status).toBe(201);

      // 3. Persisted to disk (.wiki_graph.json)
      const wikiDisk = path.join(t.root, projectA, ".wiki_graph.json");
      const wikiContent = await fs.readFile(wikiDisk, "utf-8");
      expect(wikiContent).toContain("arch/overview");
      expect(wikiContent).toContain("arch/storage");

      // 4. Lint before deletion: no broken links
      const lintBeforeRes = await userA.get(`/api/projects/${projectA}/wiki/lint`);
      expect(lintBeforeRes.status).toBe(200);
      const lintBefore = (await lintBeforeRes.json()) as { brokenLinks: Array<{ target: string }> };
      expect(lintBefore.brokenLinks.length).toBe(0);

      // 5. Delete page B
      const delRes = await userA.delete(`/api/projects/${projectA}/wiki/nodes/arch%2Fstorage`);
      expect(delRes.status).toBe(200);

      // 6. Lint after deletion: detects broken link to arch/storage
      const lintAfterRes = await userA.get(`/api/projects/${projectA}/wiki/lint`);
      expect(lintAfterRes.status).toBe(200);
      const lintAfter = (await lintAfterRes.json()) as { brokenLinks: Array<{ target: string }> };
      expect(lintAfter.brokenLinks.some((l) => l.target === "arch/storage")).toBe(true);
    });

    it("reads a damaged .wiki_graph.json as empty instead of 500ing, and repairs it on the next write", async () => {
      // The store's decoder used to assert only parseability and hand the raw string back, so
      // a document that parsed but was not a graph reached the engine, whose own cast trusted
      // it — a literal null body threw reading `.nodes` and every route on the project 500'd.
      const pageRes = await userA.post(`/api/projects/${projectA}/wiki/nodes`, {
        id: "arch/overview",
        content: "---\ntitle: Architecture\n---\nBody.",
      });
      expect(pageRes.status).toBe(201);

      const wikiDisk = path.join(t.root, projectA, ".wiki_graph.json");
      await fs.writeFile(wikiDisk, "null");

      // Every read answers the empty graph rather than an error.
      const graphRes = await userA.get(`/api/projects/${projectA}/wiki/graph`);
      expect(graphRes.status).toBe(200);
      expect((await graphRes.json()) as { nodes: unknown[] }).toMatchObject({ nodes: [] });

      // And the next write repairs the file: the decoder handed the mutation a valid (empty)
      // graph, so the stored document is a graph again rather than junk. The page the
      // corruption had masked is gone — unreadable is unreadable — but the store is usable.
      const repairRes = await userA.post(`/api/projects/${projectA}/wiki/nodes`, {
        id: "arch/storage",
        content: "---\ntitle: Storage\n---\nBody.",
      });
      expect(repairRes.status).toBe(201);
      const repaired = JSON.parse(await fs.readFile(wikiDisk, "utf-8")) as {
        nodes: Array<{ id: string }>;
      };
      expect(repaired.nodes.map((n) => n.id)).toEqual(["arch/storage"]);
    });
  });
});
