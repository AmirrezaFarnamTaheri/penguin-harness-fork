import { describe, expect, it } from "vitest";
import {
  LOGGABLE_SESSION_HEADERS,
  REDACTED_MARKER,
  maskEmail,
  redactSessionHeaders,
  sanitizeErrorForLog,
} from "../src/internal/credential-redactor.js";

describe("I1 session header allowlist", () => {
  it("keeps exactly the fourteen allowlisted headers and removes every other value", () => {
    expect([...LOGGABLE_SESSION_HEADERS].sort()).toEqual([
      "accept",
      "accept-encoding",
      "accept-language",
      "anthropic-beta",
      "anthropic-version",
      "cache-control",
      "connection",
      "content-encoding",
      "content-length",
      "content-type",
      "host",
      "openai-beta",
      "user-agent",
      "x-request-id",
    ]);
    const allowed = Object.fromEntries(
      [...LOGGABLE_SESSION_HEADERS].map((name) => [name, `value-${name}`]),
    );
    const sensitive = {
      Authorization: "Bearer sk-live-secret-value-123456789",
      Cookie: "session=cookie-secret",
      "X-Api-Key": "key-secret",
      "X-Goog-Api-Key": "goog-secret",
      "X-Vendor-Session": "vendor-secret",
      Referer: "https://app.test/?token=referer-secret",
    };

    const redacted = redactSessionHeaders({ ...allowed, ...sensitive });

    for (const name of LOGGABLE_SESSION_HEADERS) expect(redacted[name]).toBe(`value-${name}`);
    for (const name of Object.keys(sensitive))
      expect(redacted[name.toLowerCase()]).toBe(REDACTED_MARKER);
    expect(JSON.stringify(redacted)).not.toMatch(/secret/);
  });

  it("accepts Headers, tuple lists and records, joins repeats, and redacts inside allowed values", () => {
    const headers = new Headers({
      "User-Agent": "cli/1.0 (ops@example.com)",
      "Content-Type": "application/json",
      Authorization: "Basic dXNlcjpwYXNz",
    });
    expect(redactSessionHeaders(headers)).toEqual({
      authorization: REDACTED_MARKER,
      "content-type": "application/json",
      "user-agent": "cli/1.0 (o***@example.com)",
    });

    const tuples = redactSessionHeaders([
      ["Accept", "text/plain"],
      ["accept", "application/json"],
      ["X-Request-Id", "Bearer abcdefghijklmnop"],
      ["__proto__", "polluted"],
    ]);
    expect(tuples.accept).toBe("text/plain, application/json");
    expect(tuples["x-request-id"]).toBe(`Bearer ${REDACTED_MARKER}`);
    expect(Object.hasOwn(tuples, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(tuples)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const record = redactSessionHeaders({
      "Accept-Language": ["en", "zh"],
      "Content-Length": 42,
      Host: undefined,
    });
    expect(record).toEqual({ "accept-language": "en, zh", "content-length": "42" });
  });
});

describe("I1 e-mail masking", () => {
  it("masks addresses to their first local character and domain", () => {
    expect(maskEmail("contact alice.smith+tag@mail.example.co.uk now")).toBe(
      "contact a***@mail.example.co.uk now",
    );
    expect(maskEmail("a@b.io and x@localhost")).toBe("a***@b.io and x@localhost");
    expect(maskEmail("no address here")).toBe("no address here");
    expect(maskEmail("")).toBe("");
  });

  it("stays linear on a long address-character run without an @", () => {
    const started = performance.now();
    expect(maskEmail("a".repeat(200_000))).toHaveLength(200_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("I1 sanitizeErrorForLog", () => {
  it("redacts credentials and e-mail across a nested cause chain and never includes a stack", () => {
    const root = new Error("db login failed password=hunter2-secret for dba@corp.example");
    Object.assign(root, { code: "EAUTH" });
    const middle = new Error("request failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz", {
      cause: root,
    });
    const top = new TypeError(`upstream sk-ant-api03-${"x".repeat(30)} rejected`, {
      cause: middle,
    });

    const sanitized = sanitizeErrorForLog(top);
    const text = JSON.stringify(sanitized);

    expect(sanitized.name).toBe("TypeError");
    expect(sanitized.cause?.cause?.code).toBe("EAUTH");
    expect(text).toContain("d***@corp.example");
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("x".repeat(30));
    expect(text).not.toContain("dba@corp.example");
    expect(text).not.toContain("stack");
  });

  it("bounds cyclic and deep cause chains and long messages", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;
    expect(sanitizeErrorForLog(second).cause?.cause?.message).toBe("[circular cause]");

    let chain = new Error("level-0");
    for (let level = 1; level < 10; level++) {
      chain = new Error(`level-${level}`, { cause: chain });
    }
    const deep = sanitizeErrorForLog(chain);
    expect(deep.cause?.cause?.cause?.cause?.message).toBe("[cause depth limit]");

    const long = sanitizeErrorForLog(new Error("m".repeat(5000)));
    expect(long.message.length).toBeLessThanOrEqual(2000 + "…[truncated]".length);
  });

  it("structurally redacts thrown non-Error values", () => {
    expect(sanitizeErrorForLog({ apiKey: "obj-secret-value", detail: "x" })).toEqual({
      name: "NonError",
      message: `{"apiKey":"${REDACTED_MARKER}","detail":"x"}`,
    });
    expect(sanitizeErrorForLog("api_key=abcdefghijk")).toEqual({
      name: "NonError",
      message: `api_key=${REDACTED_MARKER}`,
    });
    expect(sanitizeErrorForLog(undefined)).toEqual({ name: "NonError", message: "undefined" });
  });
});
