/** T33: real HTTP handlers, organization service and disk; no agent runs or listeners. */
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORG_CONFIG_DEFAULTS } from "../src/organization/files.js";
import { handbookFilePath } from "../src/organization/paths.js";
import { OrgStore } from "../src/organization/store.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const projectId = "olivia-default_project";
const base = `/api/projects/${projectId}/organizations/acme/handbook`;
const index = "# Acme handbook\n\n[Hiring](decisions/hiring-plan.md)\n";
const doc = "decisions/hiring-plan.md";
const markdown = "# Hiring plan\n\nKeep **review** mandatory.\n\n团队手册\n";

describe("existing handbook editor HTTP persistence", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let dir: string;

  beforeEach(async () => {
    t = await createTestApp();
    owner = apiClient(t.app, (await provisionUser(t.app, "olivia")).cookie);
    const store = new OrgStore(t.root);
    dir = store.dir(projectId, "acme");
    // Seed intent files directly: creating an organization via POST starts the CEO's desk.
    await store.createLayout(dir);
    await store.writeConfig(dir, {
      ...ORG_CONFIG_DEFAULTS,
      name: "Acme",
      mission: "Maintain the handbook",
      timezone: "UTC",
      createdBy: "olivia",
    });
    await store.writeChart(dir, {
      employees: [{ agentId: "acme_ceo", title: "CEO", reportsTo: null, workspace: "." }],
    });
    await store.writeHandbook(dir, index);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("persists nested Markdown edits, lists UTF-8 bytes and reopens the exact saved content", async () => {
    const response = await owner.put(`${base}/files/${doc}`, { content: markdown });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: doc, content: markdown });
    expect(await fs.readFile(handbookFilePath(dir, doc), "utf8")).toBe(markdown);
    const reopened = await owner.get(`${base}/files/${doc}`);
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual({ path: doc, content: markdown });
    const listing = await owner.get(`${base}/files`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      files: expect.arrayContaining([
        { path: doc, size: Buffer.byteLength(markdown), updatedAt: expect.any(String) },
      ]),
    });
    expect(await (await owner.get(`${base}/files/README.md`)).json()).toEqual({
      path: "README.md",
      content: index,
    });

    expect((await owner.put(`${base}/files/${doc}`, { content: "" })).status).toBe(200);
    expect(await fs.readFile(handbookFilePath(dir, doc), "utf8")).toBe("");
    expect(await (await owner.get(`${base}/files/${doc}`)).json()).toEqual({
      path: doc,
      content: "",
    });
  });

  it("rejects an invalid save body without overwriting the index", async () => {
    const response = await owner.put(`${base}/files/README.md`, { content: 42 });
    expect(response.status).toBe(400);
    expect(await fs.readFile(handbookFilePath(dir, "README.md"), "utf8")).toBe(index);
  });
});
