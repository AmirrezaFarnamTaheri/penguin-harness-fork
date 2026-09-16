import zlib from "node:zlib";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, loginAdmin } from "./helpers.js";
import type { TestApp } from "./helpers.js";

describe("API JSON compression", () => {
  let t: TestApp;
  let authCookie: string;

  beforeEach(async () => {
    t = await createTestApp();
    const login = await loginAdmin(t.app);
    authCookie = login.cookie;
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("compresses large JSON responses with gzip when Accept-Encoding is supplied on test app", () => {
    // Isolated Hono app with the exact middleware configuration as in app.ts
    const app = new Hono();
    app.use(
      "/api/*",
      compress({
        threshold: 1024,
        contentTypeFilter: (contentType) => contentType.startsWith("application/json"),
      }),
    );
    app.use("/api/*", async (c, next) => {
      await next();
      const ct = c.res.headers.get("content-type");
      if (
        ct?.startsWith("application/json") &&
        !c.res.headers.has("content-length") &&
        c.res.body
      ) {
        const buf = await c.res.arrayBuffer();
        c.res = new Response(buf, c.res);
        c.res.headers.set("content-length", String(buf.byteLength));
      }
    });

    app.get("/api/large-json", (c) => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        description: `Description for test item ${i} with repetitive content to ensure compressibility`,
      }));
      return c.json({ ok: true, items });
    });

    app.get("/api/small-json", (c) => {
      return c.json({ ok: true, message: "short" });
    });

    app.get("/api/events-stream", (c) => {
      c.header("Content-Type", "text/event-stream; charset=utf-8");
      c.header("Cache-Control", "no-cache");
      return c.body('data: {"event":"ping"}\n\n');
    });

    app.get("/api/plain-text", (c) => {
      c.header("Content-Type", "text/plain; charset=utf-8");
      return c.body("hello world ".repeat(200));
    });

    return Promise.all([
      // Large JSON is compressed
      (async () => {
        const res = await app.request("/api/large-json", {
          headers: { "accept-encoding": "gzip, deflate" },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(res.headers.get("content-encoding")).toBe("gzip");
        expect(res.headers.get("vary")).toContain("Accept-Encoding");

        const buf = Buffer.from(await res.arrayBuffer());
        const json = JSON.parse(zlib.gunzipSync(buf).toString("utf-8"));
        expect(json.ok).toBe(true);
        expect(json.items.length).toBe(100);
      })(),

      // Small JSON is NOT compressed
      (async () => {
        const res = await app.request("/api/small-json", {
          headers: { "accept-encoding": "gzip, deflate" },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(res.headers.get("content-encoding")).toBeNull();
      })(),

      // SSE event-stream is NOT compressed
      (async () => {
        const res = await app.request("/api/events-stream", {
          headers: { "accept-encoding": "gzip, deflate" },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        expect(res.headers.get("content-encoding")).toBeNull();
      })(),

      // Non-JSON plain-text is NOT compressed
      (async () => {
        const res = await app.request("/api/plain-text", {
          headers: { "accept-encoding": "gzip, deflate" },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/plain");
        expect(res.headers.get("content-encoding")).toBeNull();
      })(),
    ]);
  });

  it("runtime server preserves uncompressed text/event-stream for live SSE events", async () => {
    const res = await t.app.request("/api/events", {
      headers: {
        cookie: authCookie,
        "accept-encoding": "gzip, deflate",
      },
    });

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("runtime server handles real JSON endpoints correctly with compression headers", async () => {
    // Calling /api/me returns JSON
    const res = await t.app.request("/api/me", {
      headers: {
        cookie: authCookie,
        "accept-encoding": "gzip, deflate",
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // /api/me payload is small so it remains uncompressed below 1024 bytes
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});
