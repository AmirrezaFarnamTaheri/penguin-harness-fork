import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectCreateResponse } from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

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
