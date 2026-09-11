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
  });
});

describe("redactCredentials", () => {
  it("redacts bearer tokens and authorization headers", () => {
    const raw = "Sending request with Bearer secretToken9876543210 and Authorization: Basic dXNlcjpwYXNz";
    const redacted = redactCredentials(raw);
    expect(redacted).not.toContain("secretToken9876543210");
    expect(redacted).toContain(`Bearer ${REDACTED_MARKER}`);
    expect(redacted).toContain(`Authorization: ${REDACTED_MARKER}`);
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
    expect(redacted.auth.headers[0]).toContain(`Bearer ${REDACTED_MARKER}`);
    expect(redacted.apiKey).toBe(REDACTED_MARKER);
  });
});
