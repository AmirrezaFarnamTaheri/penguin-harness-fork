/**
 * I7.3: POST /api/sessions/:id/pressure-overrides — the authenticated, recorded grant.
 *
 * The policy refuses the harness's own nonessential archive writes under real disk pressure, and
 * the model cannot lift that refusal: the evaluator has no parameter tool arguments can reach.
 * This route is the human's half, and the cases here are about the *scope* it derives rather than
 * accepts: the Session comes from the authenticated resolution, the volume is that Session's own
 * scratchpad (where its archive lives), the record lands in that scratchpad, and the request can
 * name only the producer and the tool call it lifts.
 *
 * The last case drives the whole loop with a real archive: a store the route wrote admits exactly
 * the one write it was granted for, and nothing else.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PressureOverrideStore,
  TruncatedToolOutputArchive,
  createProbeWritePressureGate,
  sessionPressureOverridePath,
  sessionScratchpadDir,
} from "@prismshadow/penguin-core";
import type { SessionRow } from "../src/db/repos/sessions.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const PROJECT_ID = "pressure_owner-project";
const AGENT_ID = "default_agent";
const SID = "session-2026-10-03-12-00-00-pres0001";
const OTHER_SID = "session-2026-10-03-12-00-01-pres0002";

const sessionRow = (sessionId: string): SessionRow => ({
  sessionId,
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  provider: "custom",
  modelId: "m1",
  workspace: "/tmp/w",
  approvalMode: "allow-all",
  title: null,
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
});

async function setup(): Promise<{ t: TestApp; api: ReturnType<typeof apiClient> }> {
  const t = await createTestApp();
  const { cookie } = await provisionUser(t.app, "pressure_owner");
  const api = apiClient(t.app, cookie);
  expect(
    (await api.post("/api/projects", { projectId: PROJECT_ID, name: "Pressure" })).status,
  ).toBe(201);
  t.deps.sessionsRepo.insert(sessionRow(SID));
  t.deps.sessionsRepo.insert(sessionRow(OTHER_SID));
  return { t, api };
}

/** A probe report with a chosen amount of free space, shaped exactly as the probe's own. */
function reportWithFree(freeBytes: number) {
  return {
    memory: {
      kind: "os-counter" as const,
      freeBytes: 1,
      totalBytes: 2,
      usedBytes: 1,
      usedRatio: 0.5,
      sampledAt: 0,
      ageMs: 0,
      caveat: "test",
    },
    disks: (volumePath: string) => [
      {
        path: volumePath,
        kind: "statfs-cache" as const,
        freeBytes,
        totalBytes: 0,
        usedBytes: 0,
        usedRatio: 0,
        sampledAt: 0,
        ageMs: 0,
        servedFromCache: false,
      },
    ],
    droppedPathCount: 0,
    diskTtlMs: 5000,
  };
}

describe("POST /api/sessions/:id/pressure-overrides (I7.3)", () => {
  it("records a grant scoped to the Session's own scratchpad volume", async () => {
    const { t, api } = await setup();
    try {
      const response = await api.post(`/api/sessions/${SID}/pressure-overrides`, {
        producerId: "recall-store",
        toolCallId: "call-42",
        reason: "disk is nearly full and this one read matters",
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      const scratchpad = sessionScratchpadDir(t.deps.config.root, PROJECT_ID, AGENT_ID, SID);
      expect(body).toMatchObject({
        producerId: "recall-store",
        toolCallId: "call-42",
        volumePath: scratchpad,
        grantedBy: "operator",
        reason: "disk is nearly full and this one read matters",
        warnBelowBytes: 200 * 1024 * 1024,
        blockBelowBytes: 50 * 1024 * 1024,
      });
      expect(typeof body.overrideId).toBe("string");
      expect(typeof body.grantedAt).toBe("number");
      // Recorded on disk, in the Session's own scratchpad, with the full record shape.
      const recordFile = JSON.parse(
        await fs.readFile(sessionPressureOverridePath(scratchpad), "utf8"),
      ) as { records: Array<Record<string, unknown>> };
      expect(recordFile.records).toEqual([
        expect.objectContaining({
          sessionId: SID,
          producerId: "recall-store",
          toolCallId: "call-42",
          volumePath: scratchpad,
          grantedBy: "operator",
        }),
      ]);
    } finally {
      await t.cleanup();
    }
  });

  it("refuses an unknown producer and an empty tool call", async () => {
    const { t, api } = await setup();
    try {
      const badProducer = await api.post(`/api/sessions/${SID}/pressure-overrides`, {
        producerId: "write_file",
        toolCallId: "call-1",
      });
      expect(badProducer.status).toBe(400);
      expect(((await badProducer.json()) as { error: { code: string } }).error.code).toBe(
        "pressure_producer_invalid",
      );

      const badCall = await api.post(`/api/sessions/${SID}/pressure-overrides`, {
        producerId: "recall-store",
        toolCallId: "   ",
      });
      expect(badCall.status).toBe(400);
      expect(((await badCall.json()) as { error: { code: string } }).error.code).toBe(
        "pressure_tool_call_invalid",
      );
      // Nothing was recorded by either refusal.
      const scratchpad = sessionScratchpadDir(t.deps.config.root, PROJECT_ID, AGENT_ID, SID);
      await expect(
        fs.readFile(sessionPressureOverridePath(scratchpad), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await t.cleanup();
    }
  });

  it("does not resolve another user's Session, and scopes to whichever Session was asked for", async () => {
    const { t, api } = await setup();
    try {
      // The same user, a different Session: the grant lands in *that* Session's scratchpad, not
      // in the first one's — a grant can never be widened to a Session it was not made for.
      expect(
        (
          await api.post(`/api/sessions/${OTHER_SID}/pressure-overrides`, {
            producerId: "tool-output-archive",
            toolCallId: "call-9",
          })
        ).status,
      ).toBe(201);
      const other = sessionScratchpadDir(t.deps.config.root, PROJECT_ID, AGENT_ID, OTHER_SID);
      const first = sessionScratchpadDir(t.deps.config.root, PROJECT_ID, AGENT_ID, SID);
      const records = JSON.parse(await fs.readFile(sessionPressureOverridePath(other), "utf8")) as {
        records: Array<{ sessionId: string }>;
      };
      expect(records.records[0]?.sessionId).toBe(OTHER_SID);
      await expect(fs.readFile(sessionPressureOverridePath(first), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const stranger = await createTestApp();
      try {
        const { cookie } = await provisionUser(stranger.app, "someone_else");
        const theirApi = apiClient(stranger.app, cookie);
        expect(
          (
            await theirApi.post(`/api/sessions/${SID}/pressure-overrides`, {
              producerId: "recall-store",
              toolCallId: "call-1",
            })
          ).status,
        ).toBe(404);
      } finally {
        await stranger.cleanup();
      }
    } finally {
      await t.cleanup();
    }
  });

  it("admits exactly the write the recorded grant names — and only that one", async () => {
    const { t, api } = await setup();
    try {
      const scratchpad = sessionScratchpadDir(t.deps.config.root, PROJECT_ID, AGENT_ID, SID);
      await api.post(`/api/sessions/${SID}/pressure-overrides`, {
        producerId: "recall-store",
        toolCallId: "call-granted",
        reason: "one write",
      });
      // A store reading the route's record file — the same convention a host's gate uses.
      const gate = createProbeWritePressureGate({
        probe: {
          probe: async () => {
            const base = reportWithFree(1); // far below the block threshold
            return { ...base, disks: base.disks(scratchpad) };
          },
        },
        volumePath: scratchpad,
        sessionId: SID,
        // A fresh store per call would defeat single-use, so this mirrors one live gate.
        overrides: new PressureOverrideStore({
          persistPath: sessionPressureOverridePath(scratchpad),
        }),
      });
      const archive = new TruncatedToolOutputArchive({
        rootDir: path.join(scratchpad, "truncated-tool-output"),
        writePressure: gate,
      });
      // The granted call is admitted (and consumed), the same call again is refused, and a call
      // the grant does not name is refused.
      expect(
        (await archive.saveRecallEntry("exec_command", "granted text", "call-granted")).status,
      ).toBe("saved");
      expect(await archive.saveRecallEntry("exec_command", "again", "call-granted")).toEqual({
        status: "failed",
        code: "PRESSURE_BLOCKED",
      });
      expect(await archive.saveRecallEntry("exec_command", "other", "call-other")).toEqual({
        status: "failed",
        code: "PRESSURE_BLOCKED",
      });
    } finally {
      await t.cleanup();
    }
  });
});
