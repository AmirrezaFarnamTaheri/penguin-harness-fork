import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TopicStanding } from "@prismshadow/penguin-core";
import { getOrCreateProjectRuntime, resetCockpitRuntimesForTesting } from "../src/cockpit/ws.js";
import { apiClient, createTestApp, loginAdmin, provisionUser, type TestApp } from "./helpers.js";

const base = "/api/projects/default_project/quorum";
const proposal = { topic: "Verify quorum wiring", proposerId: "reviewer" };

describe("project quorum API wiring", () => {
  let app: TestApp;
  let cookie: string;

  beforeEach(async () => {
    app = await createTestApp();
    cookie = (await loginAdmin(app.app)).cookie;
  });

  afterEach(async () => {
    resetCockpitRuntimesForTesting();
    await app?.cleanup();
  });

  it("creates a standing in the same runtime as cockpit telemetry and lists live engine changes", async () => {
    const client = apiClient(app.app, cookie);
    const response = await client.post(`${base}/propose`, proposal);
    expect(response.status).toBe(201);
    const standing = (await response.json()) as TopicStanding;
    expect(standing).toMatchObject({
      ...proposal,
      topicId: expect.any(String),
      status: "debating",
      policy: { threshold: 2, requireGrounded: true, refutationCap: 1 },
      supporters: [],
      refuters: [],
    });
    const telemetry = await client.get("/api/cockpit/telemetry?project=default_project");
    expect(telemetry.status).toBe(200);
    expect(await telemetry.json()).toMatchObject({
      projectId: "default_project",
      data: { swarm: { standings: [standing] } },
    });
    const runtime = await getOrCreateProjectRuntime("default_project", { root: app.root });
    runtime.coordinator.consensus.endorseTopic(standing.topicId, "peer-one", "test/a.ts");
    runtime.coordinator.consensus.endorseTopic(standing.topicId, "peer-two", "test/b.ts");
    const list = await client.get(`${base}/standings`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(runtime.coordinator.getStandings());
    expect(runtime.coordinator.consensus.getStanding(standing.topicId)?.status).toBe("settled");
  });

  it("honors per-topic policy and grounds without changing the shared engine defaults", async () => {
    const client = apiClient(app.app, cookie);
    const response = await client.post(`${base}/propose`, {
      topic: "  Grounded proposal  ",
      proposerId: " reviewer ",
      initialGrounds: "src/example.ts",
      policy: { threshold: 3, requireGrounded: false, refutationCap: 2 },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      topic: "Grounded proposal",
      proposerId: "reviewer",
      policy: { threshold: 3, requireGrounded: false, refutationCap: 2 },
      supporters: [{ agentId: "reviewer", grounds: "src/example.ts" }],
    });
    const defaults = await client.post(`${base}/propose`, {
      ...proposal,
      policy: { threshold: 1 },
    });
    expect(defaults.status).toBe(201);
    expect(await defaults.json()).toMatchObject({
      policy: { threshold: 1, requireGrounded: true, refutationCap: 1 },
    });
  });

  it("allows a non-admin member but isolates projects and identical IDs in separate roots", async () => {
    const client = apiClient(app.app, cookie);
    const member = await provisionUser(app.app, "quorum_member");
    expect(
      (await client.post("/api/projects/default_project/members", { userId: "quorum_member" }))
        .status,
    ).toBe(201);
    const memberClient = apiClient(app.app, member.cookie);
    expect((await memberClient.post(`${base}/propose`, proposal)).status).toBe(201);
    const memberList = await memberClient.get(`${base}/standings`);
    expect(memberList.status).toBe(200);
    expect(await memberList.json()).toHaveLength(1);
    const otherProject = "quorum_member-other";
    expect(
      (await memberClient.post("/api/projects", { projectId: otherProject, name: "Other" })).status,
    ).toBe(201);
    const otherList = await memberClient.get(`/api/projects/${otherProject}/quorum/standings`);
    expect(otherList.status).toBe(200);
    expect(await otherList.json()).toEqual([]);

    const otherApp = await createTestApp();
    try {
      const otherCookie = (await loginAdmin(otherApp.app)).cookie;
      const response = await apiClient(otherApp.app, otherCookie).get(`${base}/standings`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    } finally {
      resetCockpitRuntimesForTesting();
      await otherApp.cleanup();
    }
  });

  it("requires login and project membership before either operation", async () => {
    expect((await app.app.request(`${base}/standings`)).status).toBe(401);
    expect((await app.app.request(`${base}/propose`, { method: "POST" })).status).toBe(401);
    const outsider = await provisionUser(app.app, "quorum_outsider");
    const client = apiClient(app.app, outsider.cookie);
    for (const projectId of ["default_project", "missing-project", "bad%2Fid"]) {
      const url = `/api/projects/${projectId}/quorum`;
      expect((await client.get(`${url}/standings`)).status).toBe(404);
      expect((await client.post(`${url}/propose`, proposal)).status).toBe(404);
    }
    const list = await apiClient(app.app, cookie).get(`${base}/standings`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  it.each([
    null,
    [],
    {},
    { ...proposal, topic: "  " },
    { ...proposal, topic: 3 },
    { ...proposal, proposerId: " " },
    { ...proposal, initialGrounds: 3 },
    { ...proposal, policy: null },
    { ...proposal, policy: [] },
    { ...proposal, policy: "invalid" },
    { ...proposal, policy: { threshold: 0 } },
    { ...proposal, policy: { threshold: 1.5 } },
    { ...proposal, policy: { threshold: "2" } },
    { ...proposal, policy: { requireGrounded: "false" } },
    { ...proposal, policy: { refutationCap: -1 } },
  ])("rejects invalid input %# without creating a standing", async (body) => {
    const client = apiClient(app.app, cookie);
    const response = await client.post(`${base}/propose`, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
    const list = await client.get(`${base}/standings`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
  });

  it("rejects malformed JSON with the standard 400 envelope", async () => {
    const response = await app.app.request(`${base}/propose`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  });
});
