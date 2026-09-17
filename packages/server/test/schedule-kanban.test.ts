import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scheduleDir } from "@prismshadow/penguin-core";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const PROJECT = "owner_a-schedule_board";
const AGENT = "default_agent";
const START = "2099-01-01T09:00:00Z";
const BASE = `/api/projects/${PROJECT}/agents/${AGENT}/schedule-kanban`;
const RAW = `# Preserve hand-written intent\nprompt = "Do not execute this fixture"\nstart_at = "${START}"\nenabled = true\nperiod = "30m"\nend_at = "2099-02-01T09:00:00Z"\n`;

describe("read-only schedule kanban projection", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let member: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  let dir: string;

  beforeEach(async () => {
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner_a");
    const b = await provisionUser(t.app, "member_b");
    const c = await provisionUser(t.app, "outsider_c");
    owner = apiClient(t.app, a.cookie);
    member = apiClient(t.app, b.cookie);
    outsider = apiClient(t.app, c.cookie);
    expect(
      (await owner.post("/api/projects", { projectId: PROJECT, name: "Schedules" })).status,
    ).toBe(201);
    expect(
      (await owner.post(`/api/projects/${PROJECT}/members`, { userId: "member_b" })).status,
    ).toBe(201);
    dir = scheduleDir(t.root, PROJECT, AGENT);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("projects real TOML intent for members without mutating files or Kanban tasks", async () => {
    const file = path.join(dir, "daily.toml");
    await fs.writeFile(file, RAW);
    await fs.writeFile(path.join(dir, "once.toml"), `prompt = "Once"\nstart_at = "${START}"\n`);
    const response = await member.get(BASE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cards: [
        {
          id: `${PROJECT}/${AGENT}/daily`,
          name: "daily",
          enabled: true,
          startAt: START,
          period: "30m",
          endAt: "2099-02-01T09:00:00Z",
        },
        { id: `${PROJECT}/${AGENT}/once`, name: "once", enabled: false, startAt: START },
      ],
      invalidFiles: [],
    });
    expect(t.deps.scheduler.files.counters.fileReads).toBeGreaterThanOrEqual(2);
    expect(await fs.readFile(file, "utf8")).toBe(RAW);
    expect(await (await owner.get(`/api/projects/${PROJECT}/kanban/tasks`)).json()).toEqual({
      tasks: [],
      total: 0,
    });
  });

  it("reports malformed and semantically invalid TOML rather than fabricating cards", async () => {
    await fs.writeFile(path.join(dir, "broken.toml"), "prompt = [");
    await fs.writeFile(path.join(dir, "missing.toml"), `start_at = "${START}"\n`);
    await fs.writeFile(path.join(dir, "ignored.txt"), RAW);
    const response = await owner.get(BASE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cards: [],
      invalidFiles: [
        { name: "broken", error: expect.stringContaining("Failed to parse TOML") },
        { name: "missing", error: "Missing required field prompt" },
      ],
    });
  });

  it("reflects external file edits on the next read with a stable identity", async () => {
    const file = path.join(dir, "daily.toml");
    await fs.writeFile(file, RAW);
    const first = await owner.get(BASE);
    expect(first.status).toBe(200);
    await fs.writeFile(file, RAW.replace("enabled = true", "enabled = false"));
    const second = await owner.get(BASE);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      cards: [{ id: `${PROJECT}/${AGENT}/daily`, name: "daily", enabled: false }],
    });
  });

  it("returns an honest empty projection when the schedule directory is absent", async () => {
    await fs.rename(dir, `${dir}-unused`);
    const response = await member.get(BASE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cards: [], invalidFiles: [] });
  });

  it("rejects nonmembers, unauthenticated requests, missing agents and invalid ids before reading", async () => {
    const reads = t.deps.scheduler.files.counters.gateStats;
    expect((await outsider.get(BASE)).status).toBe(404);
    expect((await t.app.request(BASE)).status).toBe(401);
    expect((await owner.get(BASE.replace(AGENT, "missing-agent"))).status).toBe(404);
    expect((await owner.get(BASE.replace(AGENT, "bad%20agent"))).status).toBe(404);
    expect(t.deps.scheduler.files.counters.gateStats).toBe(reads);
  });

  it("round-trips board edits through the owner-only schedules API into TOML and the projection", async () => {
    const file = path.join(dir, "daily.toml");
    await fs.writeFile(file, RAW);
    const url = `/api/projects/${PROJECT}/agents/${AGENT}/schedules/daily`;
    const body = {
      prompt: "Updated from the task board",
      enabled: false,
      startAt: START,
      period: "1h",
      endAt: "2099-02-01T09:00:00Z",
    };
    expect((await member.put(url, body)).status).toBe(403);
    expect(await fs.readFile(file, "utf8")).toBe(RAW);
    expect((await owner.put(url, body)).status).toBe(200);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toContain("Updated from the task board");
    expect(raw).toContain("enabled = false");
    expect(await (await owner.get(url)).json()).toMatchObject(body);
    expect(await (await member.get(BASE)).json()).toMatchObject({
      cards: [{ id: `${PROJECT}/${AGENT}/daily`, enabled: false, period: "1h" }],
    });
    await fs.writeFile(file, raw.replace('period = "1h"', 'period = "2h"'));
    expect(await (await owner.get(url)).json()).toMatchObject({ period: "2h" });
    expect(await (await member.get(BASE)).json()).toMatchObject({ cards: [{ period: "2h" }] });
  });

  it("does not accept mutations", async () => {
    await fs.writeFile(path.join(dir, "daily.toml"), RAW);
    for (const response of [
      await owner.post(BASE, { enabled: false }),
      await owner.put(BASE, { enabled: false }),
      await owner.delete(BASE),
    ])
      expect(response.status).toBe(404);
    expect(await fs.readFile(path.join(dir, "daily.toml"), "utf8")).toBe(RAW);
  });
});
