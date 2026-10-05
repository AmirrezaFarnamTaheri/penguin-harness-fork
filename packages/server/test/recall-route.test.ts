/**
 * F18: GET /api/sessions/:id/recall/:recallId — bounded, path-free retrieval of archived output.
 *
 * The route is the seam the web chip and `penguin recall` read through, so these cases are about
 * its boundaries rather than about paging arithmetic (that is core's `recall-page.test.ts`):
 * a valid id returns the stored text page by page and reassembles byte for byte; an id that is
 * not 12/32 hex characters is refused as input, never treated as a path; another Session's id
 * does not resolve here even though the file exists on disk; a deleted entry reports expiration
 * distinctly from an unknown id; and an offset that is not a place in the text is its own error
 * carrying the real length.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TruncatedToolOutputArchive, sessionScratchpadDir } from "@prismshadow/penguin-core";
import type { RecallPageResponse } from "../src/api/types.js";
import type { SessionRow } from "../src/db/repos/sessions.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const PROJECT_ID = "recall_owner-project";
const OTHER_PROJECT_ID = "recall_owner-other";
const AGENT_ID = "default_agent";
const SID = "session-2026-10-03-09-00-00-reca1101";
const OTHER_SID = "session-2026-10-03-09-00-01-reca1102";

/** Writes text into a Session's recall store exactly as the running Environment does. */
async function storeRecall(
  root: string,
  sessionId: string,
  text: string,
  projectId = PROJECT_ID,
): Promise<string> {
  const archive = new TruncatedToolOutputArchive({
    rootDir: path.join(
      sessionScratchpadDir(root, projectId, AGENT_ID, sessionId),
      "truncated-tool-output",
    ),
  });
  const saved = await archive.saveRecallEntry("exec_command", text);
  if (saved.status !== "saved") throw new Error(`fixture save failed: ${saved.status}`);
  return saved.id;
}

describe("GET /api/sessions/:id/recall/:recallId (F18)", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;

  const sessionRow = (sessionId: string, projectId = PROJECT_ID): SessionRow => ({
    sessionId,
    projectId,
    agentId: AGENT_ID,
    provider: "custom",
    modelId: "m1",
    workspace: "/tmp/w",
    approvalMode: "allow-all",
    title: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    t = await createTestApp();
    const { cookie } = await provisionUser(t.app, "recall_owner");
    api = apiClient(t.app, cookie);
    expect(
      (await api.post("/api/projects", { projectId: PROJECT_ID, name: "Recall" })).status,
    ).toBe(201);
    t.deps.sessionsRepo.insert(sessionRow(SID));
  });

  afterEach(async () => {
    await t.cleanup();
  });

  const get = (recallId: string, offset?: number, sessionId = SID) =>
    api.get(
      `/api/sessions/${sessionId}/recall/${encodeURIComponent(recallId)}${
        offset === undefined ? "" : `?offset=${offset}`
      }`,
    );

  it("returns the stored text in bounded pages that reassemble byte for byte", async () => {
    const text = Array.from({ length: 3000 }, (_, i) => `output line ${i}`).join("\n");
    const id = await storeRecall(t.root, SID, text);

    const pages: string[] = [];
    let offset: number | null = 0;
    for (let guard = 0; guard < 200 && offset !== null; guard += 1) {
      const res = await get(id, offset);
      expect(res.status).toBe(200);
      const page = (await res.json()) as RecallPageResponse;
      expect(page.recallId).toBe(id);
      expect(page.offset).toBe(offset);
      expect(page.totalChars).toBe(text.length);
      expect(page.page.length).toBeLessThanOrEqual(12_000);
      pages.push(page.page);
      offset = page.nextOffset;
    }
    expect(offset).toBeNull();
    expect(pages.join("")).toBe(text);

    // A default offset of 0 is the first page, so a caller that sends none is not an error.
    const first = (await (await get(id)).json()) as RecallPageResponse;
    expect(first.offset).toBe(0);
    expect(first.page).toBe(pages[0]);
  });

  it("never turns an id into a path: traversal-shaped and extension-shaped ids are refused", async () => {
    const text = "secret output";
    const id = await storeRecall(t.root, SID, text);
    expect(id).toMatch(/^[a-f0-9]{32}$/);

    // Every one of these is refused as INPUT (400), before any read happens — including ids that
    // would name a real file if the route joined them into a path.
    for (const bad of [
      "..%2F..%2Fetc%2Fpasswd",
      "%2e%2e%2f%2e%2e%2fweb.db",
      `${id}.log`,
      "0123456789a",
      "0123456789abz",
      "%2Fetc%2Fpasswd",
    ]) {
      const res = await api.get(`/api/sessions/${SID}/recall/${bad}`);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "recall_id_invalid" } });
    }

    // An id with a separator in it cannot even reach the route (the path would need two
    // segments), so it answers "no such resource" — the important half is that it is never
    // resolved as a path either.
    for (const multiSegment of [`sub/${id}`, "....//....//etc/passwd", "../../etc/passwd"]) {
      expect(
        (await api.get(`/api/sessions/${SID}/recall/${multiSegment}`)).status,
        multiSegment,
      ).toBe(404);
    }

    // The refusal is about the ID, not about ids in general: the real one still works.
    expect((await get(id)).status).toBe(200);
  });

  it("does not resolve another Session's id, even when its file exists on disk", async () => {
    const otherText = "the other Session's private output";
    const otherId = await storeRecall(t.root, OTHER_SID, otherText);
    // The file really exists — the store wrote it — but it belongs to a Session this request is
    // not scoped to, so the route must not find it.
    const listed = await fs.readdir(
      path.join(
        sessionScratchpadDir(t.root, PROJECT_ID, AGENT_ID, OTHER_SID),
        "truncated-tool-output",
        "recall",
      ),
    );
    expect(listed.some((name) => name.startsWith(otherId))).toBe(true);

    const res = await get(otherId);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "recall_unavailable" } });
  });

  it("does not resolve an id belonging to a Session of another Project", async () => {
    expect(
      (await api.post("/api/projects", { projectId: OTHER_PROJECT_ID, name: "Other" })).status,
    ).toBe(201);
    t.deps.sessionsRepo.insert(sessionRow(OTHER_SID, OTHER_PROJECT_ID));
    const foreignId = await storeRecall(
      t.root,
      OTHER_SID,
      "foreign project output",
      OTHER_PROJECT_ID,
    );

    // Served under the Session that owns it...
    expect((await get(foreignId, 0, OTHER_SID)).status).toBe(200);
    // ...and not under a Session in this project, whose own store never held it.
    const res = await get(foreignId);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "recall_unavailable" } });
  });

  it("distinguishes an expired entry from an id that was never stored", async () => {
    const id = await storeRecall(t.root, SID, "expiring output");
    // Age the file past the store's advertised lifetime, the way a long-lived Session does.
    const recallDir = path.join(
      sessionScratchpadDir(t.root, PROJECT_ID, AGENT_ID, SID),
      "truncated-tool-output",
      "recall",
    );
    const [name] = (await fs.readdir(recallDir)).filter((entry) => entry.startsWith(id));
    const file = path.join(recallDir, name!);
    // Past the store's advertised lifetime (30 days), so a fresh reader evicts it on load.
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(file, old, old);

    const expired = await get(id);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toMatchObject({ error: { code: "recall_expired" } });

    // An id that was never stored reads differently: same status, different code.
    const unknown = await get("f".repeat(32));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "recall_unavailable" } });
  });

  it("refuses an offset that is not a place in the text, and says how long the text is", async () => {
    const text = "a".repeat(50);
    const id = await storeRecall(t.root, SID, text);

    for (const bad of ["-1", "1.5", "abc", "9007199254740993"]) {
      const res = await api.get(`/api/sessions/${SID}/recall/${id}?offset=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "recall_offset_invalid" } });
    }

    // Past the end: the id is fine, the text exists, the position does not.
    const past = await api.get(`/api/sessions/${SID}/recall/${id}?offset=51`);
    expect(past.status).toBe(416);
    const body = (await past.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("recall_offset_out_of_range");
    expect(body.error.message).toContain("50");

    // The end itself is a valid place (an empty, complete page), not an error.
    const atEnd = (await (await get(id, 50)).json()) as RecallPageResponse;
    expect(atEnd).toMatchObject({ page: "", nextOffset: null, totalChars: 50 });
  });

  it("answers 404 for a Session that is not this caller's, without revealing anything else", async () => {
    const id = await storeRecall(t.root, SID, "owner only");
    const { cookie } = await provisionUser(t.app, "recall_outsider");
    const outsider = apiClient(t.app, cookie);
    const res = await outsider.get(`/api/sessions/${SID}/recall/${id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "session_not_found" } });
  });
});
