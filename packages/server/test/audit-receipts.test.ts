import fs from "node:fs/promises";
import path from "node:path";
import { toolCall } from "@prismshadow/penguin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditRecorder } from "../src/sandbox/audit.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const PROJECT = "audit_owner-receipts";
const URL = `/api/projects/${PROJECT}/audit/receipts`;

describe("project audit receipts route", () => {
  let t: TestApp;
  let member: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  beforeEach(async () => {
    t = await createTestApp();
    const owner = apiClient(t.app, (await provisionUser(t.app, "audit_owner")).cookie);
    member = apiClient(t.app, (await provisionUser(t.app, "audit_member")).cookie);
    outsider = apiClient(t.app, (await provisionUser(t.app, "audit_outsider")).cookie);
    expect((await owner.post("/api/projects", { projectId: PROJECT, name: "Audit" })).status).toBe(
      201,
    );
    expect(
      (await owner.post(`/api/projects/${PROJECT}/members`, { userId: "audit_member" })).status,
    ).toBe(201);
  });
  afterEach(() => {
    // Dispose only test-owned resources; retain temp fixture files (no cleanup deletion).
    t.deps.hmr.dispose();
    t.deps.channels.dispose();
    t.deps.db.close();
  });

  it("serves verified newest-first receipts to members, filtering cross-project and tampered lines", async () => {
    const recorder = new AuditRecorder(t.root, { record: async () => {} });
    for (const [projectId, sessionId] of [
      [PROJECT, "first"],
      ["other-project", "other"],
      [PROJECT, "last"],
    ]) {
      await recorder.record(
        {
          projectId: projectId!,
          sessionId: sessionId!,
          agentId: "agent",
          provider: "custom",
          modelId: "test",
        },
        toolCall({ name: "read_file", arguments: "{}", toolCallId: sessionId! }),
      );
    }
    const log = path.join(t.root, "audit", "events.jsonl");
    const valid = JSON.parse((await fs.readFile(log, "utf8")).trim().split("\n")[0]!);
    await fs.appendFile(log, JSON.stringify({ ...valid, payloadHash: "0".repeat(64) }) + "\n");
    const before = await fs.readFile(log, "utf8");
    const response = await member.get(URL);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      receipts: [{ sessionId: "last" }, { sessionId: "first" }],
      truncated: false,
    });
    expect(await fs.readFile(log, "utf8")).toBe(before);
  });

  it("distinguishes owning and executing sessions for direct and nested child events", async () => {
    const recorder = new AuditRecorder(t.root, { record: async () => {} });
    for (const origin of [[], ["child-session"], ["child-session", "grandchild-session"]]) {
      await recorder.record(
        {
          projectId: PROJECT,
          agentId: "owner-agent",
          sessionId: "owner-session",
          provider: "custom",
          modelId: "test",
        },
        {
          ...toolCall({ name: "read_file", arguments: "{}", toolCallId: `call-${origin.length}` }),
          origin,
        },
      );
    }
    const response = await member.get(URL);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      receipts: ["grandchild-session", "child-session", "owner-session"].map(
        (executingSessionId) => ({
          agentId: "owner-agent",
          sessionId: "owner-session",
          executingSessionId,
        }),
      ),
    });
  });

  it("returns empty with no log and hides missing projects/nonmembers with 404", async () => {
    expect(await (await member.get(URL)).json()).toEqual({ receipts: [], truncated: false });
    expect((await outsider.get(URL)).status).toBe(404);
    expect((await member.get(URL.replace(PROJECT, "missing-project"))).status).toBe(404);
    expect((await member.get(URL.replace(PROJECT, "bad%20project"))).status).toBe(404);
    expect((await t.app.request(URL)).status).toBe(401);
  });

  it("surfaces verification failure without leaking files and gates access before disk reads", async () => {
    const recorder = new AuditRecorder(t.root, { record: async () => {} });
    await recorder.record(
      {
        projectId: PROJECT,
        sessionId: "session",
        agentId: "agent",
        provider: "custom",
        modelId: "test",
      },
      toolCall({ name: "read_file", arguments: "{}", toolCallId: "call" }),
    );
    await fs.writeFile(path.join(t.root, "audit", "signing.key"), "invalid");
    expect((await outsider.get(URL)).status).toBe(404);
    const response = await member.get(URL);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "audit_unavailable",
        message: "Audit receipts could not be read or verified.",
      },
    });
  });
});
