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
  parseTrustLoopback,
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

  it("resolves Auto to Off on loopback ONLY with explicit trust, and never on a network bind", () => {
    // A loopback socket is not proof of data-root ownership: another local user can connect to
    // 127.0.0.1 without any access to the server's root, so `auto` needs the operator's second,
    // explicit statement of trust before it lifts authentication (CR).
    for (const host of loopback) {
      // Trust unset: `auto` on loopback is the gated mode, so the worst case of forgetting the
      // opt-in is a sign-in prompt, not an open admin.
      expect(resolveAuthMode("auto", host), host).toMatchObject({
        effective: "all-except-health",
        requiresAuth: true,
        bindClass: "loopback",
        loopbackTrusted: false,
      });
      // Trust set: same as before, and the decision records why.
      expect(resolveAuthMode("auto", host, { trustLoopback: true }), host).toMatchObject({
        effective: "off",
        requiresAuth: false,
        bindClass: "loopback",
        loopbackTrusted: true,
      });
    }
    for (const host of [...unspecified, ...lan]) {
      for (const trustLoopback of [false, true]) {
        // The flag cannot talk a network bind into `off`: it is about loopback, nothing else.
        expect(resolveAuthMode("auto", host, { trustLoopback }), host).toMatchObject({
          effective: "all-except-health",
          requiresAuth: true,
          loopbackTrusted: false,
        });
      }
    }
    // Parsing the flag: unset/empty/0/false/no mean no; 1/true/yes mean yes; a typo throws.
    expect(parseTrustLoopback(undefined)).toBe(false);
    expect(parseTrustLoopback("  ")).toBe(false);
    for (const no of ["0", "false", "FALSE", " no "])
      expect(parseTrustLoopback(no), no).toBe(false);
    for (const yes of ["1", "true", "YES"]) expect(parseTrustLoopback(yes), yes).toBe(true);
    expect(() => parseTrustLoopback("maybe")).toThrow(/Invalid PENGUIN_AUTH_TRUST_LOOPBACK/);
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
    // `auto` on loopback without the trust flag stays gated (see the matrix above).
    expect(resolveServerConfig({ HOST: "127.0.0.1", PENGUIN_AUTH_MODE: "auto" })).toMatchObject({
      authMode: "all-except-health",
      authModeConfigured: "auto",
      authTrustLoopback: false,
    });
    expect(
      resolveServerConfig({
        HOST: "127.0.0.1",
        PENGUIN_AUTH_MODE: "auto",
        PENGUIN_AUTH_TRUST_LOOPBACK: "1",
      }),
    ).toMatchObject({
      authMode: "off",
      authModeConfigured: "auto",
      authTrustLoopback: true,
    });
    // The flag is inert on a network bind, even when set.
    expect(
      resolveServerConfig({
        HOST: "0.0.0.0",
        PENGUIN_AUTH_MODE: "auto",
        PENGUIN_AUTH_TRUST_LOOPBACK: "1",
      }),
    ).toMatchObject({
      authMode: "all-except-health",
      authModeConfigured: "auto",
    });
    expect(resolveServerConfig({ HOST: "0.0.0.0", PENGUIN_AUTH_MODE: "auto" })).toMatchObject({
      authMode: "all-except-health",
      authModeConfigured: "auto",
    });
    // The trust flag does NOT turn an explicit gated mode off: it says "this loopback is
    // trustworthy", never "ignore what I configured".
    expect(
      resolveServerConfig({
        HOST: "127.0.0.1",
        PENGUIN_AUTH_MODE: "all-except-health",
        PENGUIN_AUTH_TRUST_LOOPBACK: "1",
      }),
    ).toMatchObject({ authMode: "all-except-health" });
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

  it("off: a supplied but invalid cookie is rejected, never served as the operator (CR)", async () => {
    t = await withMode("off");
    // No cookie at all: the operator grant applies (asserted above). A cookie that WAS supplied
    // and did not authenticate is different — falling through would serve an expired session's
    // request as the admin and silently attribute its writes to the wrong identity.
    // (An *empty* cookie value is not a supplied credential and stays equivalent to no cookie —
    // the rejection is about a value that claims to be a session and is not one.)
    for (const cookie of [
      "penguin_session=not-a-real-session",
      "penguin_session=expired.value",
      "penguin_session=a.b.c",
    ]) {
      const res = await t.app.request("/api/me", { headers: { cookie } });
      expect(res.status, cookie).toBe(401);
    }
    // A real cookie that stopped authenticating is rejected too — not just a malformed one.
    // Logging out revokes the session behind the cookie, which is exactly the "supplied but no
    // longer valid" shape (an expired one reaches the same branch: authenticateWithMeta null).
    const { cookie } = await provisionUser(t.app, "signed_out_member");
    expect((await t.app.request("/api/me", { headers: { cookie } })).status).toBe(200);
    await t.app.request("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect((await t.app.request("/api/me", { headers: { cookie } })).status).toBe(401);
    // ...and no cookie still works, so the rejection is about the cookie, not the mode.
    expect((await t.app.request("/api/me")).status).toBe(200);
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
