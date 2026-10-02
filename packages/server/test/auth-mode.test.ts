/**
 * I4 — the effective authentication-mode matrix and the gate that applies it.
 *
 * The pure table is asserted exhaustively (every configured policy × every bind class), because
 * "which mode are we in?" must have exactly one answer, derived from configuration only. The
 * route-level cases then prove the same decision at the boundary a caller sees: a probe is
 * public, everything else is not, an `off` bind serves anonymous requests as the local operator,
 * and no forwarded header can talk a request into a weaker mode.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveServerConfig } from "../src/config.js";
import {
  HEALTH_PUBLIC_PATHS,
  authPolicyFor,
  classifyBind,
  parseConfiguredAuthMode,
  resolveAuthMode,
  type BindClass,
  type ConfiguredAuthMode,
} from "../src/auth/auth-mode.js";
import { RUNTIME_AUTH_STATE_RESOURCE_ID } from "../src/hmr/capabilities.js";
import { createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

describe("I4 effective auth mode: the pure matrix", () => {
  const loopback = ["127.0.0.1", "::1", "localhost", "LOCALHOST"];
  const unspecified = ["0.0.0.0", "::", "[::]", "*"];
  const lan = ["192.168.1.10", "10.0.0.5", "server.lan", "eth0"];

  it("classifies loopback, unspecified and LAN binds without treating a wildcard as loopback", () => {
    for (const host of loopback) expect(classifyBind(host), host).toBe<BindClass>("loopback");
    for (const host of unspecified) expect(classifyBind(host), host).toBe<BindClass>("unspecified");
    for (const host of lan) expect(classifyBind(host), host).toBe<BindClass>("lan");
  });

  it("resolves Auto to Off on loopback and AllExceptHealth on every network-reachable bind", () => {
    for (const host of loopback) {
      expect(resolveAuthMode("auto", host), host).toMatchObject({
        effective: "off",
        requiresAuth: false,
        bindClass: "loopback",
      });
    }
    for (const host of [...unspecified, ...lan]) {
      expect(resolveAuthMode("auto", host), host).toMatchObject({
        effective: "all-except-health",
        requiresAuth: true,
      });
    }
  });

  it("honours an explicit policy regardless of bind", () => {
    for (const host of [...loopback, ...unspecified, ...lan]) {
      expect(resolveAuthMode("off", host).effective, host).toBe("off");
      expect(resolveAuthMode("all-except-health", host).effective, host).toBe("all-except-health");
      // The recorded decision names the configured policy and the bind it read.
      expect(resolveAuthMode("off", host)).toMatchObject({ configured: "off", host });
    }
  });

  it("parses the policy from the environment and rejects anything it does not recognize", () => {
    expect(parseConfiguredAuthMode(undefined)).toBe("all-except-health");
    expect(parseConfiguredAuthMode("  ")).toBe("all-except-health");
    expect(parseConfiguredAuthMode("AUTO")).toBe("auto");
    expect(parseConfiguredAuthMode(" Off ")).toBe("off");
    expect(parseConfiguredAuthMode("all-except-health")).toBe("all-except-health");
    // A typo is an error, not a fallback: guessing here would be a silent downgrade.
    for (const bad of ["sometimes", "all-except-healthy", "true", "loopback"]) {
      expect(() => parseConfiguredAuthMode(bad), bad).toThrow(/Invalid PENGUIN_AUTH_MODE/);
    }
    expect(() => resolveServerConfig({ HOST: "127.0.0.1", PENGUIN_AUTH_MODE: "nope" })).toThrow(
      /Invalid PENGUIN_AUTH_MODE/,
    );
  });

  it("derives the configuration's effective mode from the trusted bind, not from anything else", () => {
    expect(resolveServerConfig({ HOST: "127.0.0.1", PENGUIN_AUTH_MODE: "auto" })).toMatchObject({
      authMode: "off",
      authModeConfigured: "auto",
    });
    expect(resolveServerConfig({ HOST: "0.0.0.0", PENGUIN_AUTH_MODE: "auto" })).toMatchObject({
      authMode: "all-except-health",
      authModeConfigured: "auto",
    });
    // The shipped default keeps requiring a session on a loopback bind.
    expect(resolveServerConfig({ HOST: "127.0.0.1" })).toMatchObject({
      authMode: "all-except-health",
      authModeConfigured: "all-except-health",
    });
  });

  it("exempts exactly the health probes, and lifts nothing but the rejection when off", () => {
    const gated = authPolicyFor("all-except-health", "0.0.0.0");
    expect([...HEALTH_PUBLIC_PATHS].sort()).toEqual([
      "/api/health",
      "/api/health/metrics",
      "/api/health/ready",
      "/health",
      "/health/metrics",
      "/health/ready",
    ]);
    for (const path of [
      "/health",
      "/health/ready",
      "/health/metrics",
      "/api/health",
      "/api/health/ready",
      "/api/health/metrics",
    ]) {
      expect(gated.isPublicPath(path), path).toBe(true);
    }
    for (const path of [
      "/api/me",
      "/api/healthz",
      "/api/health/unknown",
      "/api/health/../me",
      "/api/health/%2e%2e/me",
      "/api/sessions",
      "/preview/x",
      "/",
    ]) {
      expect(gated.isPublicPath(path), path).toBe(false);
    }
    // A query string cannot smuggle an exemption past the path check; the path itself decides.
    expect(gated.isPublicPath("/api/me?next=/api/health")).toBe(false);
    // `off` exempts nothing: the gate still runs to establish identity (see the boundary case
    // where a missing operator grant must still 401, not crash a handler on an absent user).
    const open = authPolicyFor("off", "127.0.0.1");
    expect(open.isPublicPath("/api/sessions")).toBe(false);
    expect(open.publicPaths).toEqual([]);
    expect(open.decision.requiresAuth).toBe(false);
  });
});

describe("I4 effective auth mode: the gate at its boundary", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.cleanup();
  });

  const withMode = (configured: ConfiguredAuthMode, host = "127.0.0.1") =>
    createTestApp({
      config: {
        authModeConfigured: configured,
        authMode: resolveAuthMode(configured, host).effective,
        host,
      },
    });

  it("all-except-health: ordinary routes need a session and probes never do", async () => {
    t = await withMode("all-except-health");
    expect((await t.app.request("/api/health")).status).toBe(200);
    expect((await t.app.request("/health/ready")).status).toBe(200);
    expect((await t.app.request("/api/me")).status).toBe(401);
    const { cookie } = await provisionUser(t.app, "matrix_user");
    const me = await t.app.request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
  });

  it("off: an anonymous request is served as the local operator, and still honours a credential", async () => {
    t = await withMode("off");
    // No cookie, no Bearer: the local operator grant (this boot's own token) stands in.
    const me = await t.app.request("/api/me");
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      user: { userId: string; isAdmin: boolean };
      sessionVia: string;
    };
    expect(body.user.userId).toBe("admin");
    expect(body.user.isAdmin).toBe(true);
    expect(body.sessionVia).toBe("token");

    // A caller that DOES present a session keeps its own identity — `off` is not "everyone is
    // admin", it is "no credential required".
    const { cookie } = await provisionUser(t.app, "member_of_off");
    const asMember = await t.app.request("/api/me", { headers: { cookie } });
    const memberBody = (await asMember.json()) as { user: { userId: string }; sessionVia: string };
    expect(memberBody.user.userId).toBe("member_of_off");
    expect(memberBody.sessionVia).toBe("password");
  });

  it("fails closed when the local-operator grant is missing", async () => {
    t = await withMode("off");
    // A process that never minted its token has no grant to stand in with, so `off` must refuse
    // exactly like an ordinary anonymous request rather than invent an identity. The boot state
    // is the very object the service reads (it must outlive an App swap), so clearing it here is
    // the honest simulation of a tokenless boot.
    const state = t.deps.hmr.resources.claim<{ apiToken: string | null }>(
      RUNTIME_AUTH_STATE_RESOURCE_ID,
    )!;
    expect(state.apiToken).not.toBeNull();
    state.apiToken = null;
    expect((await t.app.request("/api/me")).status).toBe(401);
  });

  it("a forwarded header cannot change the mode or widen the exemption", async () => {
    t = await withMode("all-except-health", "0.0.0.0");
    const spoof = {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost",
      "x-forwarded-proto": "https",
      "x-real-ip": "::1",
    };
    // The bind is the trusted input, so a caller claiming loopback is still gated...
    expect((await t.app.request("/api/me", { headers: spoof })).status).toBe(401);
    // ...and the exemption is still exactly the probes.
    expect((await t.app.request("/api/health", { headers: spoof })).status).toBe(200);
    // A trailing-slash or dot-segment variant of a protected path does not become public.
    expect((await t.app.request("/api/me/", { headers: spoof })).status).toBe(401);
    expect((await t.app.request("/api/health/../me", { headers: spoof })).status).toBe(401);
  });
});
