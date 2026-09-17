/** T35 reconciliation: desktop HTTP auth already exists; net/proxy is outbound-only.
 * Cockpit WebSockets use session cookies, not this shell-only Bearer credential.
 * Exercise the mounted HTTP route without opening a listener or requesting shutdown.
 */
import { describe, expect, it, vi } from "vitest";
import { createDesktopApp, desktopLoginCookie, TEST_DESKTOP_TOKEN } from "./helpers.js";

const shutdownPath = "/api/desktop/shutdown";

describe("existing desktop HTTP bearer authentication (T35)", () => {
  it("rejects missing and non-exact Bearer schemes even with a desktop cookie", async () => {
    const t = await createDesktopApp();
    try {
      const cookie = await desktopLoginCookie(t.app);
      const shutdown = vi.fn();
      t.deps.desktop!.onShutdownRequest(shutdown);
      vi.useFakeTimers();
      for (const authorization of [
        undefined,
        "Bearer",
        "Bearer ",
        `bearer ${TEST_DESKTOP_TOKEN}`,
        `BEARER ${TEST_DESKTOP_TOKEN}`,
        `Basic ${TEST_DESKTOP_TOKEN}`,
        `BearerX ${TEST_DESKTOP_TOKEN}`,
        `Bearer\t${TEST_DESKTOP_TOKEN}`,
        `Bearer  ${TEST_DESKTOP_TOKEN}`,
      ]) {
        const headers = new Headers({ cookie });
        if (authorization !== undefined) headers.set("authorization", authorization);
        const res = await t.app.request(shutdownPath, { method: "POST", headers });
        expect(res.status, String(authorization)).toBe(401);
        expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
      }
      await vi.runAllTimersAsync();
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await t.cleanup();
    }
  });

  it("rejects unequal credentials without scheduling shutdown or falling back to a cookie", async () => {
    const t = await createDesktopApp();
    try {
      const cookie = await desktopLoginCookie(t.app);
      const shutdown = vi.fn();
      t.deps.desktop!.onShutdownRequest(shutdown);
      vi.useFakeTimers();
      for (const token of [
        `${TEST_DESKTOP_TOKEN.slice(0, -1)}X`,
        TEST_DESKTOP_TOKEN.slice(0, -1),
        `${TEST_DESKTOP_TOKEN}X`,
        "x".repeat(4096),
        "\u00e9".repeat(TEST_DESKTOP_TOKEN.length),
      ]) {
        const res = await t.app.request(shutdownPath, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, cookie },
        });
        expect(res.status, `credential length ${token.length}`).toBe(401);
        expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
      }
      await vi.runAllTimersAsync();
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await t.cleanup();
    }
  });

  it("accepts the exact credential repeatedly without a cookie after one-shot login redemption", async () => {
    const t = await createDesktopApp();
    try {
      await desktopLoginCookie(t.app);
      const shutdown = vi.fn();
      t.deps.desktop!.onShutdownRequest(shutdown);
      vi.useFakeTimers();
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await t.app.request(shutdownPath, {
          method: "POST",
          headers: { authorization: `Bearer ${TEST_DESKTOP_TOKEN}` },
        });
        expect(res.status).toBe(202);
        expect(shutdown).toHaveBeenCalledTimes(attempt);
        await vi.runAllTimersAsync();
        expect(shutdown).toHaveBeenCalledTimes(attempt + 1);
      }
    } finally {
      vi.useRealTimers();
      await t.cleanup();
    }
  });
});
