import { describe, it, expect } from "vitest";
import {
  redactCredentials,
  containsCredentials,
  redactObject,
  REDACTED_MARKER,
} from "../src/internal/credential-redactor.js";

describe("containsCredentials", () => {
  it("returns false for plain non-sensitive text", () => {
    expect(containsCredentials("Hello world, this is a normal test")).toBe(false);
    expect(containsCredentials("The quick brown fox jumps over the lazy dog")).toBe(false);
    expect(containsCredentials("")).toBe(false);
  });

  it("detects sensitive tokens and credentials", () => {
    expect(containsCredentials("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID")).toBe(true);
    expect(containsCredentials("Authorization: Bearer mySecretToken1234567890")).toBe(true);
    expect(containsCredentials("sk-ant-api03-abcdef1234567890abcdef1234567890")).toBe(true);
    expect(containsCredentials("ghp_1234567890abcdef1234567890abcdef123456")).toBe(true);
    expect(containsCredentials("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(containsCredentials("Cookie: session=opaque-value")).toBe(true);
    expect(containsCredentials("X-Api-Token: opaque-value")).toBe(true);
  });
});

describe("redactCredentials", () => {
  it("redacts bearer tokens and authorization headers", () => {
    const raw =
      "Sending request with Bearer secretToken9876543210 and Authorization: Basic dXNlcjpwYXNz";
    const redacted = redactCredentials(raw);
    expect(redacted).not.toContain("secretToken9876543210");
    expect(redacted).toContain(`Bearer ${REDACTED_MARKER}`);
    expect(redacted).toContain(`Authorization: ${REDACTED_MARKER}`);
  });

  it("redacts opaque auth and cookie headers", () => {
    const raw = [
      "Cookie: session=opaque-session; csrf=opaque-csrf",
      "Set-Cookie: session=rotated; HttpOnly; Secure",
      "X-Api-Token: opaque-token",
      "X-Auth-Key: opaque-key",
    ].join("\n");
    const redacted = redactCredentials(raw);
    expect(redacted).not.toContain("opaque-session");
    expect(redacted).not.toContain("rotated");
    expect(redacted).not.toContain("opaque-token");
    expect(redacted).not.toContain("opaque-key");
    expect(redacted).toContain(`Cookie: ${REDACTED_MARKER}`);
    expect(redacted).toContain(`Set-Cookie: ${REDACTED_MARKER}`);
  });

  it("redacts OpenAI and Anthropic API keys", () => {
    const raw = "sk-proj-abc12345678901234567890 and sk-ant-api03-12345678901234567890";
    const redacted = redactCredentials(raw);
    expect(redacted).not.toContain("abc12345678901234567890");
    expect(redacted).not.toContain("ant-api03-12345678901234567890");
    expect(redacted).toContain(`sk-${REDACTED_MARKER}`);
  });

  it("redacts GitHub and GitLab tokens", () => {
    const raw = "Cloning with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 and glpat-12345678901234567890";
    const redacted = redactCredentials(raw);
    expect(redacted).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(redacted).toContain(`ghp_${REDACTED_MARKER}`);
    expect(redacted).toContain(`glpat-${REDACTED_MARKER}`);
  });

  it("redacts AWS access key IDs", () => {
    const raw = "Using AWS credentials AKIAIOSFODNN7EXAMPLE for S3 bucket";
    const redacted = redactCredentials(raw);
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).toContain(`AKIA${REDACTED_MARKER}`);
  });

  it("redacts credentials embedded in URIs", () => {
    const raw = "Connecting to https://admin:superSecretPass123@api.example.com/v1";
    const redacted = redactCredentials(raw);
    expect(redacted).not.toContain("superSecretPass123");
    expect(redacted).toContain(`https://admin:${REDACTED_MARKER}@api.example.com/v1`);
  });

  it("redacts PEM private key blocks", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1u...secret...
-----END RSA PRIVATE KEY-----`;
    const redacted = redactCredentials(pem);
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain(`[${REDACTED_MARKER}]`);
  });

  it("redacts secrets whose value contains whitespace", () => {
    // The value must be allowed to run to its closing quote: a passphrase or a generated token
    // containing spaces is a real secret, and the old rule backed out of it entirely — leaving
    // both redactCredentials and containsCredentials reporting the line as clean.
    const cases = ['password: "hunter2 traced"', 'api_key="my key value"', "PASSWORD='a b c d e'"];
    for (const raw of cases) {
      expect(containsCredentials(raw), `containsCredentials(${raw})`).toBe(true);
      const redacted = redactCredentials(raw);
      expect(redacted, redacted).not.toContain("hunter2 traced");
      expect(redacted, redacted).not.toContain("my key value");
      expect(redacted, redacted).not.toContain("a b c d e");
      expect(redacted).toContain(REDACTED_MARKER);
    }
  });

  it("leaves an unquoted short value alone", () => {
    // The {8,} floor is deliberate: `password: hi` is not a secret worth a marker.
    expect(redactCredentials("the password: short")).toBe("the password: short");
  });
});

describe("redactObject", () => {
  it("recursively redacts nested objects and arrays", () => {
    const obj = {
      user: "alice",
      auth: {
        token: "sk-ant-api03-secretkey12345678901234567890",
        headers: ["Bearer token9876543210"],
      },
      apiKey: "super_secret_api_key_value_12345",
      count: 42,
    };

    const redacted = redactObject(obj);
    expect(redacted.user).toBe("alice");
    expect(redacted.count).toBe(42);
    expect(redacted.auth.token).toBe(REDACTED_MARKER);
    expect(redacted.auth.headers[0]).toBe(REDACTED_MARKER);
    expect(redacted.apiKey).toBe(REDACTED_MARKER);
  });

  it("redacts opaque structured HTTP and application secret fields", () => {
    const obj = {
      headers: {
        Cookie: "session=opaque",
        "Set-Cookie": "session=rotated",
        "X-Api-Token": "opaque-token",
        "X-Auth-Key": "opaque-auth-key",
      },
      config: {
        signingSecret: "opaque-signing-secret",
        webhook_secret: "opaque-webhook-secret",
      },
      safe: "visible",
    };

    const redacted = redactObject(obj);
    expect(redacted.headers.Cookie).toBe(REDACTED_MARKER);
    expect(redacted.headers["Set-Cookie"]).toBe(REDACTED_MARKER);
    expect(redacted.headers["X-Api-Token"]).toBe(REDACTED_MARKER);
    expect(redacted.headers["X-Auth-Key"]).toBe(REDACTED_MARKER);
    expect(redacted.config.signingSecret).toBe(REDACTED_MARKER);
    expect(redacted.config.webhook_secret).toBe(REDACTED_MARKER);
    expect(redacted.safe).toBe("visible");
  });

  it("redacts sensitive fields whose names carry a prefix or suffix", () => {
    // The field-name table used to require an exact match, so every prefixed spelling fell
    // through and its scalar was returned verbatim — the normal shape inside a provider block.
    const obj = {
      db: {
        dbPassword: "postgres://user:hunter2@db:5432/app",
        userPassword: "hunter2",
        admin_password: "godmode",
      },
      providers: {
        apiSecret: "sk-live-abcd1234",
        refreshTokenValue: "rt_abcdef123456",
        stripeSigningSecret: "whsec_abcdef123456",
        anthropicKey: "opaque-token-not-a-format-rule",
      },
      benign: { monkey: "see no evil", tokenCount: 4, publicKey: "not-a-secret" },
    };

    const redacted = redactObject(obj) as typeof obj;
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(JSON.stringify(redacted)).not.toContain("godmode");
    expect(JSON.stringify(redacted)).not.toContain("sk-live-abcd1234");
    expect(JSON.stringify(redacted)).not.toContain("rt_abcdef123456");
    expect(JSON.stringify(redacted)).not.toContain("whsec_abcdef123456");
    expect(JSON.stringify(redacted)).not.toContain("opaque-token-not-a-format-rule");
    expect(redacted.providers.anthropicKey).toBe(REDACTED_MARKER);

    // The matcher keys on whole words, so a benign word that merely contains the letters is
    // spared (`monkey` is one word, `keyword` is one word) while `publicKey` — two words, the
    // second of which is `key` — is censored on the fail-closed side of the trade.
    expect(redacted.benign.monkey).toBe("see no evil");
    expect(redacted.benign.publicKey).toBe(REDACTED_MARKER);
    expect(redacted.benign.tokenCount).toBe(REDACTED_MARKER);
  });

  it("spares benign names and censors compound ones", () => {
    const kept = redactObject({
      keyword: "ranking",
      keywords: ["a", "b"],
      hotkey: "F5",
      maxTokens: 4096,
      replayTokenBucket: "unchanged",
    }) as Record<string, unknown>;
    expect(kept.keyword).toBe("ranking");
    expect(kept.keywords).toEqual(["a", "b"]);
    expect(kept.hotkey).toBe("F5");
    expect(kept.maxTokens).toBe(4096);
    // `token` is a whole word here, so it fails closed.
    expect(kept.replayTokenBucket).toBe(REDACTED_MARKER);
  });
});
