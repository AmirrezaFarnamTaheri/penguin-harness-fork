import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_FACTORIES, projectDir } from "@prismshadow/penguin-core";
import type { ToolExecutionContext } from "@prismshadow/penguin-core";
import type { ProjectCreateResponse } from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

async function runKnowledgeGraphTool(
  args: Record<string, unknown>,
  workspaceDir: string,
): Promise<string> {
  const factory = BUILTIN_TOOL_FACTORIES["knowledge_graph"];
  if (!factory) throw new Error("knowledge_graph builtin tool is not registered");
  const tool = factory({ name: "knowledge_graph", description: "test", parameters: {} });
  const ctx: ToolExecutionContext = { workspaceDir, toolCallId: "findings-scope-test" };
  let output = "";
  const generator = tool.execute(args, ctx);
  for (;;) {
    const step = await generator.next();
    if (step.done) return output;
    const message = step.value as unknown as {
      type?: string;
      payload?: { type?: string; event_type?: string; output?: string };
    };
    if (
      message.type === "model_msg" &&
      message.payload?.type === "partial_tool_call_output" &&
      message.payload.event_type === "delta"
    ) {
      output += message.payload.output ?? "";
    }
  }
}

describe("findings routes (persistent knowledge plane)", () => {
  let t: TestApp;
  let client: ReturnType<typeof apiClient>;
  let projectId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const user = await provisionUser(t.app, "findings_routes");
    client = apiClient(t.app, user.cookie);
    const created = (await (
      await client.post("/api/projects", {
        projectId: "findings_routes-project",
        name: "Findings routes",
      })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("reports a finding and reads it back from a later request (persisted)", async () => {
    const reported = await client.post(`/api/projects/${projectId}/findings`, {
      title: "The watcher skips node_modules",
      kind: "insight",
      subjects: ["packages/core/src/agent/code-graph-watcher.ts"],
      evidence: [
        { path: "packages/core/src/agent/code-graph-watcher.ts", line: 56, tier: "implementation" },
      ],
      confidence: "high",
    });
    expect(reported.status).toBe(201);
    const body = (await reported.json()) as {
      finding: { id: string; sources: Array<{ agentId: string }> };
      merged: boolean;
    };
    expect(body.merged).toBe(false);
    // Provenance is host-attested: the authenticated user, never the body.
    expect(body.finding.sources[0]?.agentId.startsWith("user:")).toBe(true);

    const queried = await client.get(`/api/projects/${projectId}/findings?text=node_modules`);
    const hits = (await queried.json()) as { findings: Array<{ id: string }> };
    expect(hits.findings.map((f) => f.id)).toContain(body.finding.id);
  });

  it("keeps workspace and project authorities separate across renames and name collisions", async () => {
    const workspaceDir = path.join(t.root, "workspaces", "Findings routes");
    const renamedWorkspaceDir = path.join(t.root, "workspaces", "renamed workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceReport = JSON.parse(
      await runKnowledgeGraphTool(
        { action: "report", title: "Workspace-only finding" },
        workspaceDir,
      ),
    ) as { id: string };
    const beforeProjectWrite = await client.get(
      `/api/projects/${projectId}/findings?text=${encodeURIComponent("Workspace-only finding")}`,
    );
    expect(((await beforeProjectWrite.json()) as { findings: unknown[] }).findings).toEqual([]);

    const serverReport = await client.post(`/api/projects/${projectId}/findings`, {
      title: "Project-only finding",
    });
    expect(serverReport.status).toBe(201);
    const serverFinding = (await serverReport.json()) as { finding: { id: string } };

    const secondProjectResponse = await client.post("/api/projects", {
      projectId: "findings_routes-same_name",
      name: "Findings routes",
    });
    expect(secondProjectResponse.status, await secondProjectResponse.clone().text()).toBe(201);
    const secondProject = (await secondProjectResponse.json()) as ProjectCreateResponse;
    expect(secondProject.project.projectId).not.toBe(projectId);
    const secondProjectFindings = await client.get(
      `/api/projects/${secondProject.project.projectId}/findings?text=${encodeURIComponent("Project-only finding")}`,
    );
    expect(((await secondProjectFindings.json()) as { findings: unknown[] }).findings).toEqual([]);

    const workspacePath = path.join(workspaceDir, ".penguin", "knowledge", "findings-graph.json");
    const projectPath = path.join(projectDir(t.root, projectId), ".findings_graph.json");
    expect(await fs.readFile(workspacePath, "utf8")).toContain("Workspace-only finding");
    expect(await fs.readFile(projectPath, "utf8")).toContain("Project-only finding");
    expect(path.resolve(workspacePath)).not.toBe(path.resolve(projectPath));

    await fs.rename(workspaceDir, renamedWorkspaceDir);
    const renamedWorkspaceFindings = JSON.parse(
      await runKnowledgeGraphTool({ action: "query" }, renamedWorkspaceDir),
    ) as Array<{ id: string; title: string }>;
    expect(renamedWorkspaceFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workspaceReport.id, title: "Workspace-only finding" }),
      ]),
    );

    const projectFindings = await client.get(
      `/api/projects/${projectId}/findings?text=${encodeURIComponent("Project-only finding")}`,
    );
    const projectRows = (await projectFindings.json()) as {
      findings: Array<{ id: string; title: string }>;
    };
    expect(projectRows.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: serverFinding.finding.id, title: "Project-only finding" }),
      ]),
    );
    expect(projectRows.findings.map((finding) => finding.title)).not.toContain(
      "Workspace-only finding",
    );

    const outsider = await provisionUser(t.app, "findings_scope_outsider");
    const outsiderClient = apiClient(t.app, outsider.cookie);
    expect(
      (
        await outsiderClient.get(
          `/api/projects/${projectId}/findings?text=${encodeURIComponent("Project-only finding")}`,
        )
      ).status,
    ).toBe(404);
    const unauthorizedWrite = await outsiderClient.post(`/api/projects/${projectId}/findings`, {
      title: "Unauthorized project write",
    });
    expect(unauthorizedWrite.status).toBe(404);
  });

  it("merges a duplicate report instead of creating a second finding", async () => {
    const first = (await (
      await client.post(`/api/projects/${projectId}/findings`, {
        title: "One claim about retry budgets",
        body: "The budget scales with pool shape.",
      })
    ).json()) as { finding: { id: string } };
    const second = (await (
      await client.post(`/api/projects/${projectId}/findings`, {
        title: "One claim about retry budgets",
        body: "The budget scales with pool shape.",
        confidence: "high",
      })
    ).json()) as { finding: { id: string; confidence: string }; merged: boolean };
    expect(second.merged).toBe(true);
    expect(second.finding.id).toBe(first.finding.id);
    expect(second.finding.confidence).toBe("high");
  });

  it("runs the lifecycle: confirm, supersede, events replay", async () => {
    const old = (await (
      await client.post(`/api/projects/${projectId}/findings`, { title: "Old retry claim" })
    ).json()) as { finding: { id: string } };
    const replacement = (await (
      await client.post(`/api/projects/${projectId}/findings`, { title: "Fresh budget evidence" })
    ).json()) as { finding: { id: string } };

    const confirmed = await client.post(
      `/api/projects/${projectId}/findings/${encodeURIComponent(old.finding.id)}/confirm`,
      { note: "verified in tests" },
    );
    expect(confirmed.status).toBe(200);

    const superseded = await client.post(
      `/api/projects/${projectId}/findings/${encodeURIComponent(old.finding.id)}/supersede`,
      { replacement_id: replacement.finding.id },
    );
    expect(superseded.status).toBe(200);
    const supersededBody = (await superseded.json()) as {
      finding: { status: string; supersededBy: string };
    };
    expect(supersededBody.finding.status).toBe("superseded");
    expect(supersededBody.finding.supersededBy).toBe(replacement.finding.id);

    const events = (await (
      await client.get(`/api/projects/${projectId}/findings/events?since=0`)
    ).json()) as { events: Array<{ type: string; seq: number }> };
    expect(events.events.map((e) => e.type)).toEqual(["ingest", "ingest", "update", "supersede"]);
    expect(events.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("answers 404 for unknown findings and 400 for malformed input", async () => {
    const missing = await client.post(
      `/api/projects/${projectId}/findings/${encodeURIComponent("no-such-finding")}/confirm`,
      {},
    );
    expect(missing.status).toBe(404);

    const noTitle = await client.post(`/api/projects/${projectId}/findings`, { body: "orphan" });
    expect(noTitle.status).toBe(400);

    const badTier = await client.post(`/api/projects/${projectId}/findings`, {
      title: "Bad evidence tier",
      evidence: [{ tier: "gossip" }],
    });
    expect(badTier.status).toBe(400);

    const badLimit = await client.get(`/api/projects/${projectId}/findings?limit=9999`);
    expect(badLimit.status).toBe(400);

    const badStatus = await client.post(`/api/projects/${projectId}/findings`, {
      title: "Bad kind",
      kind: "vibes",
    });
    expect(badStatus.status).toBe(400);
  });

  it("links two findings symmetrically and exports a snapshot", async () => {
    const a = (await (
      await client.post(`/api/projects/${projectId}/findings`, { title: "Link target alpha" })
    ).json()) as { finding: { id: string } };
    const b = (await (
      await client.post(`/api/projects/${projectId}/findings`, { title: "Link target beta" })
    ).json()) as { finding: { id: string } };

    const linked = await client.post(
      `/api/projects/${projectId}/findings/${encodeURIComponent(a.finding.id)}/link`,
      { link_id: b.finding.id },
    );
    expect(linked.status).toBe(200);

    const snapshot = (await (
      await client.get(`/api/projects/${projectId}/findings/snapshot`)
    ).json()) as { version: number; findings: Array<{ id: string; related: string[] }> };
    expect(snapshot.version).toBe(1);
    const aRecord = snapshot.findings.find((f) => f.id === a.finding.id);
    expect(aRecord?.related).toContain(b.finding.id);
  });
});
