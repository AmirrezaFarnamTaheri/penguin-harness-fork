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
 * The last case drives the route's durable grant through a live Agent Session's production gate
 * and archive, then verifies the consumed grant refuses a retry without changing the destination.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PressureOverrideStore,
  ResourcePressureProbe,
  TruncatedToolOutputArchive,
  createAgent,
  createProbeWritePressureGate,
  saveProjectConfig,
  sessionPressureOverridePath,
  sessionScratchpadDir,
} from "@prismshadow/penguin-core";
import type { ResourcePressureReport, Session } from "@prismshadow/penguin-core";
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

/** A probe report with a chosen amount of free space on the measured Session volume. */
function reportWithFree(volumePath: string, freeBytes: number): ResourcePressureReport {
  return {
    memory: {
      kind: "os-counter",
      freeBytes: 1,
      totalBytes: 2,
      usedBytes: 1,
      usedRatio: 0.5,
      sampledAt: 0,
      ageMs: 0,
      caveat: "test",
    },
    disks: [
      {
        path: volumePath,
        kind: "statfs-cache",
        freeBytes,
        totalBytes: 2,
        usedBytes: 1,
        usedRatio: 0.5,
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

  it("drives the authenticated grant through a live Agent's Session archive", async () => {
    const { t, api } = await setup();
    let session: Session | undefined;
    let restoreProbe: (() => void) | undefined;
    try {
      await saveProjectConfig(t.deps.config.root, PROJECT_ID, {
        default_model: { provider: "anthropic", model_id: "claude-sonnet-4-6" },
        models: [{ provider: "anthropic", model_id: "claude-sonnet-4-6", context_window: 1000 }],
      });
      const agent = await createAgent({
        root: t.deps.config.root,
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
      });
      const workspaceDir = path.join(t.root, "agent-workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      session = await agent.createSession({ workspaceDir });
      t.deps.sessionsRepo.insert({
        ...sessionRow(session.sessionId),
        provider: session.provider,
        modelId: session.modelId,
        workspace: session.workspaceDir,
      });

      const scratchpad = sessionScratchpadDir(
        t.deps.config.root,
        PROJECT_ID,
        AGENT_ID,
        session.sessionId,
      );
      const probe = vi
        .spyOn(ResourcePressureProbe.prototype, "probe")
        .mockImplementation(async () => reportWithFree(scratchpad, 1));
      restoreProbe = () => probe.mockRestore();

      const grant = await api.post(`/api/sessions/${session.sessionId}/pressure-overrides`, {
        producerId: "tool-output-archive",
        toolCallId: "call-granted",
        reason: "one archive write",
      });
      expect(grant.status).toBe(201);
      expect((await grant.json()) as Record<string, unknown>).toMatchObject({
        producerId: "tool-output-archive",
        toolCallId: "call-granted",
        volumePath: scratchpad,
        grantedBy: "operator",
      });

      // The Agent's real Session owns this Environment and the archive wired to its gate.
      // This private-field read keeps the test at the composition boundary rather than
      // replacing production wiring with a hand-built gate or archive.
      const environment = (
        session as unknown as {
          environment: {
            truncatedToolOutputArchive: TruncatedToolOutputArchive | null;
          };
        }
      ).environment;
      const archive = environment.truncatedToolOutputArchive;
      if (archive === null) throw new Error("Agent Session did not construct its output archive");
      const capture = archive.startCapture();
      capture.append("granted text from the live Session archive");
      expect(await capture.save("exec_command", "call-granted")).toMatchObject({
        status: "saved",
      });
      expect(probe).toHaveBeenCalledTimes(1);

      const archiveDir = path.join(scratchpad, "truncated-tool-output");
      const filesBeforeRefusal = await fs.readdir(archiveDir);
      expect(filesBeforeRefusal).toHaveLength(1);
      const archivedPath = path.join(archiveDir, filesBeforeRefusal[0]!);
      const archivedText = await fs.readFile(archivedPath, "utf8");
      expect(archivedText).toBe("granted text from the live Session archive");

      // The live Agent archive refuses a replay of the consumed grant and a different call.
      // Each refusal happens before touching the existing destination, and the archive queue
      // remains usable after a pressure block.
      const retry = archive.startCapture();
      retry.append("this retry must not reach disk");
      expect(await retry.save("exec_command", "call-granted")).toEqual({
        status: "failed",
        code: "PRESSURE_BLOCKED",
      });
      const unrelated = archive.startCapture();
      unrelated.append("this unrelated call must not reach disk");
      expect(await unrelated.save("exec_command", "call-not-granted")).toEqual({
        status: "failed",
        code: "PRESSURE_BLOCKED",
      });
      expect(await fs.readdir(archiveDir)).toEqual(filesBeforeRefusal);
      expect(await fs.readFile(archivedPath, "utf8")).toBe(archivedText);

      // A fresh gate/store also sees the durable consumption, not just this Agent's memory.
      const freshGate = createProbeWritePressureGate({
        probe: { probe: async () => reportWithFree(scratchpad, 1) },
        volumePath: scratchpad,
        sessionId: session.sessionId,
        overrides: new PressureOverrideStore({
          persistPath: sessionPressureOverridePath(scratchpad),
        }),
      });
      expect(
        await freshGate.admit({
          producerId: "tool-output-archive",
          toolCallId: "call-granted",
        }),
      ).toMatchObject({ action: "block", volumePath: scratchpad });
    } finally {
      restoreProbe?.();
      session?.dispose();
      await t.cleanup();
    }
  });
});
