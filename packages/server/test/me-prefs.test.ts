/**
 * ui_prefs is a free-form JSON column the route reads with `JSON.parse(raw) as UiPrefs`.
 * The catch around it only covers SyntaxError, so a row holding JSON that is not an
 * object — `null`, `5`, `"x"`, `[]`, written by hand or by an older writer — parsed fine
 * and was returned as `{ prefs: <that> }`, breaking PrefsResponse's contract; and in the
 * PUT the same merge silently no-oped, so a corrupted row could never be repaired through
 * the API. Both now read a non-object as `{}`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

describe("ui_prefs: a corrupted row", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let userId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const { cookie, user } = await provisionUser(t.app, "cora");
    api = apiClient(t.app, cookie);
    userId = user.userId;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it.each(["null", "5", '"a-string"', "[]"])("GET answers an object, not %s", async (junk) => {
    t.deps.prefsRepo.set(userId, junk);
    const res = await api.get("/api/me/prefs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prefs: {} });
  });

  it("unparseable JSON answers an object too", async () => {
    t.deps.prefsRepo.set(userId, "{not json");
    expect(await (await api.get("/api/me/prefs")).json()).toEqual({ prefs: {} });
  });

  it.each(["null", "5", '"a-string"', "[]"])(
    "PUT repairs the row instead of preserving %s",
    async (junk) => {
      // The merge was `{...current, ...body}` with `current` cast from the junk, so a
      // non-object current swallowed the write and the row stayed broken forever.
      t.deps.prefsRepo.set(userId, junk);
      const res = await api.put("/api/me/prefs", { lastProjectId: "default_project" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ prefs: { lastProjectId: "default_project" } });

      // Repaired on disk, and a subsequent read agrees.
      expect(await (await api.get("/api/me/prefs")).json()).toEqual({
        prefs: { lastProjectId: "default_project" },
      });
    },
  );

  it("a valid object row is untouched", async () => {
    t.deps.prefsRepo.set(userId, JSON.stringify({ theme: "dark", lastProjectId: "p1" }));
    expect(await (await api.get("/api/me/prefs")).json()).toEqual({
      prefs: { theme: "dark", lastProjectId: "p1" },
    });
  });
});
