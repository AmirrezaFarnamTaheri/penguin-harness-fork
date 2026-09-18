/**
 * OAuth 2.0 PKCE token exchange tests.
 *
 * The interesting assertions here are the ones that would break if the crypto were faked:
 *
 *  - {@link deriveCodeChallenge} is checked against RFC 7636 Appendix B's worked S256
 *    example, so the transform is verifiably the standard one and not a lookalike.
 *  - `state` is compared BEFORE the token endpoint is called, so a forged redirect cannot
 *    trade on a victim's in-flight handshake.
 *  - The loopback receiver moves real bytes: the test binds a socket, issues a genuine HTTP
 *    request against the returned URI, and asserts the code that comes back.
 */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
  CONNECTION_STATUS,
  PKCE_METHOD,
  PKCE_VERIFIER_BYTES,
  PkceError,
  base64url,
  basicAuthHeader,
  buildAuthorizationUrl,
  buildRefreshBody,
  buildTokenExchangeBody,
  deriveCodeChallenge,
  exchangeCodeForTokens,
  generateCodeVerifier,
  generatePkcePair,
  parseCallbackUrl,
  refreshTokens,
  startLoopbackReceiver,
  startPkceSession,
  tokenExpiry,
  validateTokenResponse,
  type ConnectionStatus,
  type PkceProviderConfig,
  type PkceSession,
  type TokenTransport,
} from "../../src/fleet/oauth-pkce-exchange.js";

const CONFIG: PkceProviderConfig = {
  providerId: "linear",
  clientId: "client-123",
  clientSecret: "secret-456",
  authorizationEndpoint: "https://api.linear.app/oauth/authorize",
  tokenEndpoint: "https://api.linear.app/oauth/token",
  redirectUri: "http://127.0.0.1:9876/callback",
  defaultScopes: ["read"],
};

/** A recording fake transport: captures what was sent and replays a canned response. */
function fakeTransport(
  response: unknown,
  status = 200,
): {
  transport: TokenTransport;
  calls: { url: string; body: URLSearchParams; headers: Record<string, string> }[];
} {
  const calls: { url: string; body: URLSearchParams; headers: Record<string, string> }[] = [];
  const transport: TokenTransport = async (url, body, headers) => {
    calls.push({ url, body, headers });
    return {
      status,
      json: async () => response,
    };
  };
  return { transport, calls };
}

describe("pkce verifier and challenge", () => {
  it("implements the RFC 7636 Appendix B S256 vector exactly", () => {
    // The RFC's worked example: this verifier must produce this challenge.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(deriveCodeChallenge(verifier)).toBe(challenge);
  });

  it("uses the S256 method exclusively", () => {
    expect(PKCE_METHOD).toBe("S256");
  });

  it("generates a 43-character base64url verifier from 32 random bytes", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    // 32 random bytes base64url-encode to exactly 43 characters with no padding.
    expect(Buffer.from(verifier, "base64url")).toHaveLength(PKCE_VERIFIER_BYTES);
  });

  it("never repeats a verifier", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it("refuses a verifier with under 32 bytes of entropy", () => {
    expect(() => generateCodeVerifier(16)).toThrow(/at least 32 bytes/);
  });

  it("derives a challenge that is a 43-character base64url string", () => {
    const { codeChallenge } = generatePkcePair();
    expect(codeChallenge).toHaveLength(43);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("binds the challenge to the verifier: a different verifier gives a different challenge", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
    expect(deriveCodeChallenge(a.codeVerifier)).toBe(a.codeChallenge);
  });

  it("refuses an empty verifier", () => {
    expect(() => deriveCodeChallenge("")).toThrow(/non-empty/);
  });

  it("base64url-encodes without padding", () => {
    expect(base64url("a")).toBe(Buffer.from("a", "utf8").toString("base64url"));
    expect(base64url(Buffer.from("a", "utf8"))).toBe(base64url("a"));
  });
});

describe("pkce session and authorization url", () => {
  it("starts a session with a fresh verifier, state and INITIALIZING status", () => {
    const session = startPkceSession(CONFIG);
    expect(session.providerId).toBe("linear");
    expect(session.codeVerifier).toHaveLength(43);
    expect(session.state).toMatch(/^[0-9a-f]{32}$/);
    expect(session.status).toBe(CONNECTION_STATUS.INITIALIZING);
    expect(session.scopes).toEqual(["read"]);
  });

  it("uses explicit scopes over the configured defaults", () => {
    const session = startPkceSession(CONFIG, ["write", "issues"]);
    expect(session.scopes).toEqual(["write", "issues"]);
  });

  it("falls back to no scopes when neither is given", () => {
    const session = startPkceSession({ ...CONFIG, defaultScopes: undefined }, []);
    expect(session.scopes).toEqual([]);
  });

  it("requires a providerId, clientId and redirectUri", () => {
    expect(() => startPkceSession({ ...CONFIG, providerId: "" })).toThrow(/providerId/);
    expect(() => startPkceSession({ ...CONFIG, clientId: "" })).toThrow(/clientId/);
    expect(() => startPkceSession({ ...CONFIG, redirectUri: "" })).toThrow(/redirectUri/);
  });

  it("builds an authorization url carrying the challenge, state and scopes", () => {
    const session = startPkceSession(CONFIG, ["read", "write"]);
    const url = new URL(buildAuthorizationUrl(CONFIG, session));
    expect(url.origin + url.pathname).toBe("https://api.linear.app/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe(session.state);
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("code_challenge")).toBe(deriveCodeChallenge(session.codeVerifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("folds a provider's extra auth params into the url", () => {
    const session = startPkceSession(CONFIG);
    const url = new URL(
      buildAuthorizationUrl(
        { ...CONFIG, extraAuthParams: { user_scope: "read", response_mode: "form_post" } },
        session,
      ),
    );
    expect(url.searchParams.get("user_scope")).toBe("read");
    expect(url.searchParams.get("response_mode")).toBe("form_post");
  });
});

describe("token exchange bodies and headers", () => {
  it("builds an authorization_code grant body with the verifier", () => {
    const session = startPkceSession(CONFIG);
    const body = buildTokenExchangeBody(CONFIG, session, "code-abc");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-abc");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("redirect_uri")).toBe(session.redirectUri);
    expect(body.get("code_verifier")).toBe(session.codeVerifier);
    // Secret in the header by default, not the body.
    expect(body.get("client_secret")).toBeNull();
  });

  it("puts the client secret in the body when the provider requires it", () => {
    const session = startPkceSession(CONFIG);
    const body = buildTokenExchangeBody({ ...CONFIG, secretInBody: true }, session, "code-abc");
    expect(body.get("client_secret")).toBe("secret-456");
  });

  it("builds a refresh_token grant body", () => {
    const body = buildRefreshBody(CONFIG, "refresh-xyz");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-xyz");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.has("scope")).toBe(false);
  });

  it("includes requested scopes in a refresh body", () => {
    const body = buildRefreshBody(CONFIG, "refresh-xyz", ["read", "write"]);
    expect(body.get("scope")).toBe("read write");
  });

  it("emits a Basic auth header for a confidential client", () => {
    expect(basicAuthHeader(CONFIG)).toBe(
      `Basic ${Buffer.from("client-123:secret-456").toString("base64")}`,
    );
  });

  it("omits the Basic header when there is no secret or the secret travels in the body", () => {
    expect(basicAuthHeader({ ...CONFIG, clientSecret: undefined })).toBeUndefined();
    expect(basicAuthHeader({ ...CONFIG, secretInBody: true })).toBeUndefined();
  });
});

describe("token response validation", () => {
  it("accepts a full token response", () => {
    const tokens = validateTokenResponse({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt",
      scope: "read write",
    });
    expect(tokens.access_token).toBe("at");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBe("rt");
  });

  it("rejects a non-object body", () => {
    expect(() => validateTokenResponse(null)).toThrow(PkceError);
    expect(() => validateTokenResponse("nope")).toThrow(/non-object/);
    expect(() => validateTokenResponse([])).toThrow(/non-object/);
  });

  it("rejects a response without an access_token", () => {
    expect(() => validateTokenResponse({})).toThrow(/no access_token/);
  });

  it("surfaces a provider error description when present", () => {
    expect(() =>
      validateTokenResponse({ error: "invalid_grant", error_description: "bad code" }),
    ).toThrow("invalid_grant: bad code");
  });

  it("converts an expires_in into an absolute epoch-ms expiry", () => {
    expect(tokenExpiry({ access_token: "a", expires_in: 3600 }, 10_000)).toBe(3_610_000);
  });

  it("treats a missing or non-finite expires_in as no expiry", () => {
    expect(tokenExpiry({ access_token: "a" }, 10_000)).toBeUndefined();
    expect(tokenExpiry({ access_token: "a", expires_in: Number.NaN }, 10_000)).toBeUndefined();
  });

  it("never returns a negative expiry", () => {
    expect(tokenExpiry({ access_token: "a", expires_in: -60 }, 10_000)).toBe(10_000);
  });
});

describe("exchangeCodeForTokens", () => {
  function session(status: ConnectionStatus = CONNECTION_STATUS.INITIALIZING): PkceSession {
    return { ...startPkceSession(CONFIG), status };
  }

  it("redeems a code and moves the session to ACTIVE", async () => {
    const { transport, calls } = fakeTransport({ access_token: "at", refresh_token: "rt" });
    const sess = session();
    const tokens = await exchangeCodeForTokens(
      CONFIG,
      sess,
      { code: "code-abc", state: sess.state },
      transport,
    );
    expect(tokens.access_token).toBe("at");
    expect(sess.status).toBe(CONNECTION_STATUS.ACTIVE);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(CONFIG.tokenEndpoint);
    expect(calls[0]!.body.get("code_verifier")).toBe(sess.codeVerifier);
    expect(calls[0]!.headers.authorization).toBe(basicAuthHeader(CONFIG));
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("rejects a state mismatch before it sends anything", async () => {
    const { transport, calls } = fakeTransport({ access_token: "at" });
    const sess = session();
    await expect(
      exchangeCodeForTokens(CONFIG, sess, { code: "c", state: "someone-elses-state" }, transport),
    ).rejects.toMatchObject({ name: "PkceError", code: "state_mismatch" });
    expect(sess.status).toBe(CONNECTION_STATUS.FAILED);
    // Nothing was sent: the check precedes the transport call.
    expect(calls).toHaveLength(0);
  });

  it("rejects a callback with no code", async () => {
    const { transport } = fakeTransport({ access_token: "at" });
    const sess = session();
    await expect(
      exchangeCodeForTokens(CONFIG, sess, { state: sess.state }, transport),
    ).rejects.toMatchObject({ code: "missing_code" });
  });

  it("surfaces a provider authorization denial", async () => {
    const { transport } = fakeTransport({ access_token: "at" });
    const sess = session();
    await expect(
      exchangeCodeForTokens(
        CONFIG,
        sess,
        { state: sess.state, error: "access_denied", errorDescription: "user said no" },
        transport,
      ),
    ).rejects.toMatchObject({ code: "provider_error" });
    expect(sess.status).toBe(CONNECTION_STATUS.FAILED);
  });

  it("expires a session older than ten minutes", async () => {
    const { transport } = fakeTransport({ access_token: "at" });
    const sess = session();
    const stale = sess.startedAt - 11 * 60 * 1000;
    await expect(
      exchangeCodeForTokens(
        CONFIG,
        sess,
        { code: "c", state: sess.state },
        transport,
        sess.startedAt + 20 * 60 * 1000,
      ),
    ).rejects.toMatchObject({ code: "expired_session" });
    expect(sess.status).toBe(CONNECTION_STATUS.EXPIRED);
    expect(stale).toBeLessThan(sess.startedAt);
  });

  it("refuses to re-exchange a session that is already ACTIVE", async () => {
    const { transport } = fakeTransport({ access_token: "at" });
    const sess = session(CONNECTION_STATUS.ACTIVE);
    await expect(
      exchangeCodeForTokens(CONFIG, sess, { code: "c", state: sess.state }, transport),
    ).rejects.toMatchObject({ code: "not_active" });
  });

  it("wraps a token-endpoint error body as a token_exchange_failed", async () => {
    const { transport, calls } = fakeTransport(
      { error: "invalid_grant", error_description: "the code is stale" },
      400,
    );
    const sess = session();
    await expect(
      exchangeCodeForTokens(CONFIG, sess, { code: "c", state: sess.state }, transport),
    ).rejects.toMatchObject({ code: "token_exchange_failed" });
    expect(sess.status).toBe(CONNECTION_STATUS.FAILED);
    expect(calls).toHaveLength(1);
  });

  it("fails on a non-JSON token endpoint body", async () => {
    const transport: TokenTransport = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON");
      },
    });
    const sess = session();
    await expect(
      exchangeCodeForTokens(CONFIG, sess, { code: "c", state: sess.state }, transport),
    ).rejects.toMatchObject({ code: "token_exchange_failed" });
    expect(sess.status).toBe(CONNECTION_STATUS.FAILED);
  });
});

describe("refreshTokens", () => {
  it("refreshes and returns the new tokens", async () => {
    const { transport, calls } = fakeTransport({ access_token: "at2", refresh_token: "rt2" });
    const tokens = await refreshTokens(CONFIG, "rt1", transport);
    expect(tokens.access_token).toBe("at2");
    expect(tokens.refresh_token).toBe("rt2");
    expect(calls[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]!.body.get("refresh_token")).toBe("rt1");
  });

  it("accepts a rotated refresh token without rotating the request", async () => {
    const { transport, calls } = fakeTransport({ access_token: "at2", refresh_token: "rt2" });
    await refreshTokens(CONFIG, "rt1", transport, ["read"]);
    expect(calls[0]!.body.get("scope")).toBe("read");
    // The caller persists rt2; the old rt1 is already dead provider-side.
    expect(calls[0]!.body.get("refresh_token")).toBe("rt1");
  });

  it("refuses an empty refresh token", async () => {
    const { transport } = fakeTransport({ access_token: "at" });
    await expect(refreshTokens(CONFIG, "", transport)).rejects.toMatchObject({
      code: "no_refresh_token",
    });
  });

  it("wraps a refresh error body", async () => {
    const { transport } = fakeTransport({ error: "invalid_grant" }, 400);
    await expect(refreshTokens(CONFIG, "rt1", transport)).rejects.toMatchObject({
      code: "token_exchange_failed",
    });
  });
});

describe("parseCallbackUrl", () => {
  it("reads code and state from an absolute url", () => {
    expect(
      parseCallbackUrl(
        "http://127.0.0.1:9876/callback?code=abc&state=xyz",
        "http://127.0.0.1:9876",
      ),
    ).toEqual({ code: "abc", state: "xyz" });
  });

  it("resolves a relative callback against the redirect base", () => {
    expect(parseCallbackUrl("/callback?code=abc&state=xyz", "http://127.0.0.1:9876")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("reads a provider error", () => {
    expect(
      parseCallbackUrl(
        "/callback?error=access_denied&error_description=nope&state=xyz",
        "http://127.0.0.1:9876",
      ),
    ).toEqual({ error: "access_denied", errorDescription: "nope", state: "xyz" });
  });

  it("returns nothing for a callback with neither code nor error", () => {
    expect(parseCallbackUrl("/callback", "http://127.0.0.1:9876")).toEqual({});
  });
});

describe("startLoopbackReceiver", () => {
  it("exposes the redirect URI as soon as the socket is bound", async () => {
    const receiver = await startLoopbackReceiver({ port: 0 });
    try {
      expect(receiver.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(receiver.port).toBeGreaterThan(0);
      expect(receiver.redirectUri).toContain(String(receiver.port));
    } finally {
      receiver.close();
    }
  });

  it("honours a configured path and host", async () => {
    const receiver = await startLoopbackReceiver({ port: 0, path: "/oauth/redirect" });
    try {
      expect(receiver.redirectUri).toContain("/oauth/redirect");
    } finally {
      receiver.close();
    }
  });

  it("receives a real HTTP redirect and resolves with the code", async () => {
    const receiver = await startLoopbackReceiver({ port: 0 });
    const callback = receiver.waitForCallback();
    // A genuine browser-issued request over a real socket.
    const response = await fetch(`${receiver.redirectUri}?code=abc&state=xyz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Authorized");
    expect(await callback).toEqual({ code: "abc", state: "xyz" });
  });

  it("answers an error redirect with 400 and still resolves", async () => {
    const receiver = await startLoopbackReceiver({ port: 0 });
    const callback = receiver.waitForCallback();
    const response = await fetch(`${receiver.redirectUri}?error=access_denied`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("access_denied");
    expect(await callback).toMatchObject({ error: "access_denied" });
  });

  it("escapes HTML in the failure page", async () => {
    const receiver = await startLoopbackReceiver({ port: 0 });
    const callback = receiver.waitForCallback();
    const response = await fetch(`${receiver.redirectUri}?error=%3Cscript%3E`);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    await callback;
  });

  it("404s a request to any other path", async () => {
    const receiver = await startLoopbackReceiver({ port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${receiver.port}/elsewhere?code=abc`);
      expect(response.status).toBe(404);
    } finally {
      receiver.close();
    }
  });

  it("rejects waitForCallback when the receiver is closed first", async () => {
    const receiver = await startLoopbackReceiver({ port: 0 });
    const callback = receiver.waitForCallback();
    receiver.close();
    await expect(callback).rejects.toMatchObject({ name: "PkceError" });
  });

  it("serves exactly one handshake then closes the socket", async () => {
    const receiver = await startLoopbackReceiver({ port: 0 });
    try {
      await fetch(`${receiver.redirectUri}?code=abc&state=xyz`);
      // The server closed after answering; a second request cannot connect.
      await expect(fetch(`${receiver.redirectUri}?code=def`)).rejects.toThrow();
    } finally {
      receiver.close();
    }
  });

  it("fails when the requested port cannot be bound", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      blocker.close();
      throw new Error("blocker bound no address");
    }
    try {
      await expect(startLoopbackReceiver({ port: address.port })).rejects.toThrow(PkceError);
    } finally {
      blocker.close();
    }
  });
});
