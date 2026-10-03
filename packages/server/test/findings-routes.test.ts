import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_TOOL_FACTORIES,
  projectDir,
  FindingsGraph,
  LifecycleError,
  FINDING_STATUSES,
} from "@prismshadow/penguin-core";
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
  const generator = tool.execute({ outputVersion: 1, ...args }, ctx);
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
  let cookie: string;

  beforeEach(async () => {
    t = await createTestApp();
    const user = await provisionUser(t.app, "findings_routes");
    cookie = user.cookie;
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

  it("preserves corrupt snapshots, exposes recovery/raw export, and audits explicit reset/restore", async () => {
    const target = path.join(projectDir(t.root, projectId), ".findings_graph.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const raw = '{"version":1,"findings":[';
    await fs.writeFile(target, raw);
    const report = await client.post(`/api/projects/${projectId}/findings`, {
      title: "Unsafe repair",
    });
    expect(report.status).toBe(409);
    expect(((await report.json()) as { error: { code: string } }).error.code).toBe(
      "findings_recovery_required",
    );
    expect(await fs.readFile(target, "utf8")).toBe(raw);
    const recovery = (await (
      await client.get(`/api/projects/${projectId}/findings/recovery`)
    ).json()) as { revision: string; recovery: { quarantinePath: string } };
    expect(await fs.readFile(recovery.recovery.quarantinePath, "utf8")).toBe(raw);
    const exported = await client.get(`/api/projects/${projectId}/findings/raw`);
    expect(exported.status).toBe(200);
    const page = (await exported.json()) as {
      data: string;
    };
    expect(Buffer.from(page.data, "base64").toString()).toBe(raw);
    const resetUrl = `/api/projects/${projectId}/findings/recovery/reset`;
    expect(
      (await client.post(resetUrl, { revision: recovery.revision, reason: "Reviewed" })).status,
    ).toBe(400);
    expect(
      (await client.post(resetUrl, { revision: "stale", reason: "Reviewed", acknowledge: true }))
        .status,
    ).toBe(409);
    const reset = await client.post(resetUrl, {
      revision: recovery.revision,
      reason: "Reviewed damaged snapshot",
      acknowledge: true,
    });
    expect(reset.status).toBe(200);
    const { revision } = (await reset.json()) as { revision: string };
    const snapshot = (await (
      await client.get(`/api/projects/${projectId}/findings/snapshot`)
    ).json()) as { findings: unknown[]; events: Array<{ actor: { kind: string }; note: string }> };
    expect(snapshot.findings).toHaveLength(0);
    expect(snapshot.events.at(-1)!.actor.kind).toBe("user");
    expect(await fs.readFile(JSON.parse(snapshot.events.at(-1)!.note).preserved, "utf8")).toBe(raw);
    const backup = new FindingsGraph();
    backup.report({ title: "Verified restored claim" });
    const restored = await client.post(`/api/projects/${projectId}/findings/recovery/restore`, {
      revision,
      reason: "Restore verified backup",
      acknowledge: true,
      snapshot: JSON.stringify(backup.exportSnapshot()),
    });
    expect(restored.status).toBe(200);
  });

  it("keeps recovery status and raw export available when quarantine creation is denied", async () => {
    const target = path.join(projectDir(t.root, projectId), ".findings_graph.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const original = Buffer.from("damaged snapshot");
    await fs.writeFile(target, original);
    const authorityPath = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(`${authorityPath}.quarantine-`) && args[1] === "wx")
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return open(...args);
    });
    try {
      const status = await client.get(`/api/projects/${projectId}/findings/recovery`);
      expect(status.status).toBe(200);
      const recovery = (await status.json()) as {
        recovery: {
          state: string;
          reason: string;
          quarantineError?: string;
          quarantinePath?: string;
        };
      };
      expect(recovery.recovery).toMatchObject({
        state: "read-only",
        reason: "corrupt",
        quarantineError: "permission denied",
      });
      expect(recovery.recovery.quarantinePath).toBeUndefined();

      const report = await client.post(`/api/projects/${projectId}/findings`, {
        title: "Must not overwrite damage",
      });
      expect(report.status).toBe(409);
      expect(((await report.json()) as { error: { code: string } }).error.code).toBe(
        "findings_recovery_required",
      );
      const raw = await client.get(`/api/projects/${projectId}/findings/raw`);
      expect(raw.status).toBe(200);
      const page = (await raw.json()) as { data: string };
      expect(Buffer.from(page.data, "base64")).toEqual(original);
      expect(await fs.readFile(target)).toEqual(original);
      expect(openSpy.mock.calls.some(([filePath]) => String(filePath) === authorityPath)).toBe(
        true,
      );
      expect(
        openSpy.mock.calls.some(
          ([filePath, flags]) =>
            String(filePath).startsWith(`${authorityPath}.quarantine-`) && flags === "wx",
        ),
      ).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("uses the same report limits as the tool and rejects a stale report revision", async () => {
    for (const input of [
      { title: "t".repeat(301) },
      { title: "Valid title", evidence: [{ tier: "runtime", quote: "q".repeat(2001) }] },
      { title: "Valid title", subjects: Array(101).fill("path") },
    ]) {
      expect((await client.post(`/api/projects/${projectId}/findings`, input)).status).toBe(400);
    }
    const before = (await (
      await client.get(`/api/projects/${projectId}/findings/recovery`)
    ).json()) as { revision: string };
    await client.post(`/api/projects/${projectId}/findings`, { title: "First claim" });
    const response = await t.app.request(`/api/projects/${projectId}/findings`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "If-Match": before.revision },
      body: JSON.stringify({ title: "Stale claim" }),
    });
    expect(response.status).toBe(409);
  });

  it("shows agent, user, system and legacy authorship from events on both read paths", async () => {
    const storePath = path.join(projectDir(t.root, projectId), ".findings_graph.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    for (const kind of ["agent", "user", "system", "legacy-unknown"] as const) {
      const graph = new FindingsGraph();
      graph.report(
        {
          title: "Loader waits",
          source: { agentId: "user:forged" },
          evidence: [{ tier: "runtime" }],
        },
        kind === "legacy-unknown" ? {} : { actor: { kind, id: "host-id" } },
      );
      const snapshot = graph.exportSnapshot();
      if (kind === "legacy-unknown") snapshot.events!.forEach((event) => delete event.actor);
      await fs.writeFile(storePath, JSON.stringify(snapshot));
      for (const suffix of ["", "/snapshot"]) {
        const body = (await (
          await client.get(`/api/projects/${projectId}/findings${suffix}`)
        ).json()) as { findings: Array<{ authoredBy: string; author: { id: string } }> };
        expect(body.findings[0]).toMatchObject({
          authoredBy: kind,
          status: "open",
          evidenceTiers: ["runtime"],
        });
        expect(body.findings[0]!.author.id).not.toBe("forged");
      }
    }
  });

  it("preserves refuted claims, deduplicates revisions, and requires a reason to reopen", async () => {
    const input = { title: "Loader waits", evidence: [{ tier: "runtime", path: "loader.ts" }] };
    const original = (await (
      await client.post(`/api/projects/${projectId}/findings`, input)
    ).json()) as { finding: { id: string } };
    const url = `/api/projects/${projectId}/findings/${original.finding.id}`;
    expect((await client.post(`${url}/refute`, { note: "Falsified" })).status).toBe(200);
    const revision = (await (
      await client.post(`/api/projects/${projectId}/findings`, { ...input, reopen: true })
    ).json()) as { finding: { id: string }; merged: boolean };
    expect(revision.finding.id).not.toBe(original.finding.id);
    expect(revision.merged).toBe(false);
    const replay = (await (
      await client.post(`/api/projects/${projectId}/findings`, input)
    ).json()) as typeof revision;
    expect(replay.finding.id).toBe(revision.finding.id);
    expect(replay.merged).toBe(true);
    const snapshot = (await (
      await client.get(`/api/projects/${projectId}/findings/snapshot`)
    ).json()) as { findings: Array<{ id: string; status: string; contradicts?: string[] }> };
    expect(snapshot.findings).toHaveLength(2);
    expect(snapshot.findings.find((f) => f.id === original.finding.id)).toMatchObject({
      status: "refuted",
      contradicts: [revision.finding.id],
    });
    expect((await client.post(`${url}/reopen`, {})).status).toBe(400);
    expect((await client.post(`${url}/reopen`, { note: " " })).status).toBe(400);
    expect(
      (
        await client.post(`${url}/reopen`, {
          note: "Independent review",
          actor: { kind: "system", id: "forged" },
        })
      ).status,
    ).toBe(200);
    const { events } = (await (
      await client.get(`/api/projects/${projectId}/findings/events`)
    ).json()) as {
      events: Array<{ type: string; actor: { kind: string; id: string }; method: string }>;
    };
    expect(events.at(-1)).toMatchObject({
      type: "reopen",
      actor: { kind: "user" },
      method: "route",
    });
    expect(events.at(-1)!.actor.id).not.toBe("forged");
    expect(
      (await client.post(`${url}/supersede`, { replacement_id: revision.finding.id })).status,
    ).toBe(200);
    expect((await client.post(`${url}/reopen`, { note: "reason" })).status).toBe(409);
  });

  it("rejects dead replacements and imported cyclic or overlong chains without writing", async () => {
    const seed = new FindingsGraph();
    const claim = seed.report({ title: "Loader waits" }).finding;
    const replacement = seed.report({ title: "Fresh budget evidence" }).finding;
    const base = seed.exportSnapshot();
    const dead = structuredClone(base);
    dead.findings[1]!.status = "refuted";
    const cycle = structuredClone(base);
    cycle.findings[1]!.supersededBy = replacement.id;
    const deep = structuredClone(base);
    deep.findings[1]!.supersededBy = "hop-1";
    for (let i = 1; i <= 65; i++)
      deep.findings.push({
        ...replacement,
        id: `hop-${i}`,
        ...(i < 65 ? { supersededBy: `hop-${i + 1}` } : {}),
      });
    const storePath = path.join(projectDir(t.root, projectId), ".findings_graph.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    for (const [snapshot, message] of [
      [dead, "open or confirmed"],
      [cycle, "cycle"],
      [deep, "64 hops"],
    ] as const) {
      const before = JSON.stringify(snapshot);
      await fs.writeFile(storePath, before);
      const response = await client.post(
        `/api/projects/${projectId}/findings/${claim.id}/supersede`,
        { replacement_id: replacement.id },
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
        message,
      );
      expect(await fs.readFile(storePath, "utf8")).toBe(before);
    }
  });

  it("enforces lifecycle transitions and takes actors only from authentication", async () => {
    const allowed = new Set([
      "open:confirmed",
      "open:refuted",
      "open:superseded",
      "confirmed:refuted",
      "confirmed:superseded",
    ]);
    const storePath = path.join(projectDir(t.root, projectId), ".findings_graph.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    for (const from of FINDING_STATUSES)
      for (const to of ["confirmed", "refuted", "superseded"] as const) {
        const graph = new FindingsGraph();
        const claim = graph.report({
          title: "Loader waits",
          evidence: [{ tier: "runtime" }],
        }).finding;
        const replacement = graph.report({ title: "Fresh budget evidence" }).finding;
        const snapshot = graph.exportSnapshot();
        snapshot.findings.find((f) => f.id === claim.id)!.status = from;
        const before = JSON.stringify(snapshot);
        await fs.writeFile(storePath, before);
        const action = to === "confirmed" ? "confirm" : to === "refuted" ? "refute" : "supersede";
        const response = await client.post(
          `/api/projects/${projectId}/findings/${claim.id}/${action}`,
          {
            replacement_id: replacement.id,
            actor: { kind: "system", id: "forged" },
            method: "engine",
          },
        );
        if (allowed.has(`${from}:${to}`)) {
          expect(response.status).toBe(200);
          expect(((await response.json()) as { finding: { status: string } }).finding.status).toBe(
            to,
          );
          const persisted = JSON.parse(await fs.readFile(storePath, "utf8"));
          const event = persisted.events.at(-1);
          expect(event.actor.kind).toBe("user");
          expect(event.actor.id).not.toBe("forged");
          expect(event.method).toBe("route");
        } else {
          expect(response.status).toBe(409);
          expect(await fs.readFile(storePath, "utf8")).toBe(before);
        }
      }
  });

  it("gates confirmation and records authenticated human override reasons", async () => {
    const { finding } = (await (
      await client.post(`/api/projects/${projectId}/findings`, { title: "Unproven claim" })
    ).json()) as { finding: { id: string; sources: Array<{ agentId: string }> } };
    const url = `/api/projects/${projectId}/findings/${finding.id}/confirm`;
    expect((await client.post(url, {})).status).toBe(409);
    for (const body of [
      { override: true },
      { override: true, note: " " },
      { override: "true", note: "reason" },
    ]) {
      expect((await client.post(url, body)).status).toBe(400);
    }
    expect(
      (
        await client.post(url, {
          override: true,
          note: "Reviewed manually",
          actor: { kind: "agent", id: "forged" },
        })
      ).status,
    ).toBe(200);
    const { events } = (await (
      await client.get(`/api/projects/${projectId}/findings/events`)
    ).json()) as { events: Array<Record<string, unknown>> };
    expect(events.at(-1)).toMatchObject({
      actor: { kind: "user", id: finding.sources[0]!.agentId.slice(5) },
      method: "route",
      override: true,
      note: "Reviewed manually",
    });
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

  it("keeps the original finding id usable after a longer-body merge", async () => {
    const first = (await (
      await client.post(`/api/projects/${projectId}/findings`, {
        title: "The cache invalidates stale workspace graphs",
        body: "Expiry prevents stale results.",
        evidence: [{ tier: "implementation", path: "cache.ts" }],
      })
    ).json()) as { finding: { id: string } };
    const merged = await client.post(`/api/projects/${projectId}/findings`, {
      title: "The cache invalidates stale workspace graphs",
      body: "Expiry prevents stale results, and a forced refresh rebuilds the graph from current files.",
    });
    const mergeBody = (await merged.json()) as { finding: { id: string } };
    expect(mergeBody.finding.id).toBe(first.finding.id);

    const confirmed = await client.post(
      `/api/projects/${projectId}/findings/${encodeURIComponent(first.finding.id)}/confirm`,
      { note: "verified" },
    );
    expect(confirmed.status).toBe(200);
  });

  it("runs the lifecycle: confirm, supersede, events replay", async () => {
    const old = (await (
      await client.post(`/api/projects/${projectId}/findings`, {
        title: "Old retry claim",
        evidence: [{ tier: "runtime" }],
      })
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

  it("validates GET enums with the same lists used by report", async () => {
    for (const query of ["kind=vibes", "kind=", "status=anything", "status="]) {
      const response = await client.get(`/api/projects/${projectId}/findings?${query}`);
      expect(response.status, query).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("must be one of:");
      expect(body.error.message).toContain(query.startsWith("kind") ? "hypothesis" : "superseded");
    }
  });

  it("rejects partial, fractional, empty and unsafe integer query values", async () => {
    for (const value of ["1junk", "1.5", "", "9007199254740992", "-1"]) {
      expect(
        (await client.get(`/api/projects/${projectId}/findings?limit=${value}`)).status,
        value,
      ).toBe(400);
      expect(
        (await client.get(`/api/projects/${projectId}/findings/events?since=${value}`)).status,
        value,
      ).toBe(400);
    }
  });

  it("returns 400 for malformed finding-id encoding on every mutation ingress", async () => {
    for (const action of ["confirm", "refute", "supersede", "link", "reopen"]) {
      const response = await client.post(`/api/projects/${projectId}/findings/%zz/${action}`, {});
      expect(response.status, action).toBe(400);
    }
  });

  it("keeps unexpected engine exceptions as 500 and leaves the persisted snapshot unchanged", async () => {
    const report = await client.post(`/api/projects/${projectId}/findings`, {
      title: "Test engine failure",
    });
    const { finding } = (await report.json()) as { finding: { id: string } };
    const before = await (await client.get(`/api/projects/${projectId}/findings/snapshot`)).json();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const confirm = vi.spyOn(FindingsGraph.prototype, "confirm").mockImplementation(() => {
      throw new TypeError("private engine failure detail");
    });
    try {
      const response = await client.post(
        `/api/projects/${projectId}/findings/${finding.id}/confirm`,
        {},
      );
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private engine failure detail");
      expect(
        await (await client.get(`/api/projects/${projectId}/findings/snapshot`)).json(),
      ).toEqual(before);
    } finally {
      confirm.mockRestore();
      log.mockRestore();
    }
  });

  it("maps only typed lifecycle rejection to 409", async () => {
    const confirm = vi.spyOn(FindingsGraph.prototype, "confirm").mockImplementation(() => {
      throw new LifecycleError("This transition conflicts with the current lifecycle.");
    });
    try {
      const response = await client.post(`/api/projects/${projectId}/findings/claim/confirm`, {});
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "finding_conflict" } });
    } finally {
      confirm.mockRestore();
    }
  });
});
