/**
 * apiFetch's empty-body contract: a 204 or an empty 200 resolves `undefined` (the
 * signature says so), and apiFetchJson — the path every body-reading call site uses —
 * turns the same answer into an ApiError that names the route instead of an `undefined`
 * the caller would destructure on the next line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  apiFetchJson,
  apiFetchJsonWithMeta,
  apiFetchWithMeta,
  ApiError,
} from "../src/api/client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", date: "Thu, 18 Sep 2026 10:00:00 GMT" },
  });

describe("empty bodies", () => {
  const unstub = () => vi.unstubAllGlobals();

  afterEach(unstub);

  it("a 204 resolves undefined from apiFetch, and apiFetchJson names the route", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    await expect(apiFetch<{ agents: string[] }>("/api/agents")).resolves.toBeUndefined();
    await expect(apiFetchJson<{ agents: string[] }>("/api/agents")).rejects.toThrow(
      "Empty response body for GET /api/agents",
    );
    await expect(apiFetchJson<{ agents: string[] }>("/api/agents")).rejects.toMatchObject({
      name: "ApiError",
      code: "empty_body",
      status: 0,
    });
    expect(() => {
      throw new ApiError(0, "empty_body", "x");
    }).toThrow(ApiError);
  });

  it("a 200 with an empty body resolves undefined too, and apiFetchJson refuses it", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
    await expect(apiFetch<unknown>("/api/whatever")).resolves.toBeUndefined();
    await expect(apiFetchWithMeta<unknown>("/api/whatever")).resolves.toMatchObject({
      data: undefined,
      serverNowMs: null,
    });
    await expect(
      apiFetchJson<{ ok: boolean }>("/api/whatever", { method: "POST" }),
    ).rejects.toThrow("Empty response body for POST /api/whatever");
    await expect(apiFetchJsonWithMeta<{ ok: boolean }>("/api/whatever")).rejects.toMatchObject({
      code: "empty_body",
    });
  });

  it("a body still arrives intact through both paths", async () => {
    vi.stubGlobal("fetch", async () => json({ agents: ["default_agent"] }));
    await expect(apiFetchJson<{ agents: string[] }>("/api/agents")).resolves.toEqual({
      agents: ["default_agent"],
    });
    const withMeta = await apiFetchJsonWithMeta<{ agents: string[] }>("/api/agents");
    expect(withMeta.data).toEqual({ agents: ["default_agent"] });
    expect(typeof withMeta.serverNowMs).toBe("number");
  });
});
