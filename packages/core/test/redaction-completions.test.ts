import { describe, expect, it } from "vitest";
import {
  LOGGABLE_SESSION_HEADERS,
  REDACTED_MARKER,
  maskEmail,
  redactSessionHeaders,
  redactTraceContent,
  redactTraceRecord,
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

describe("I1 trace/export redaction", () => {
  it("redacts credential variants and addresses inside recorded records, by value and by field", () => {
    const record = {
      timestamp: "2026-10-02T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "tool_call",
        // A JSON-quoted credential-named field: the text rules cannot see through the quote
        // between the name and the colon, so only the structural pass catches this one.
        apiKey: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        headers: "Authorization: Basic dXNlcjpwYXNzd29yZA==\r\nX-Trace: keep",
        url: "https://user:sup3r-secret@internal.test/v1",
        note: "contact ops@example.com or rotate the password=hunter2-swordfish",
        nested: [{ access_token: "opaque-token-value" }, "Bearer abcdefghijklmnopqrstuvwxyz"],
        // Non-secret fields must survive: a viewer still has to be able to read the Trace.
        model_id: "m",
        status: "completed",
        durationMs: 12,
        tool_name: "read_file",
        key: "ordinary-map-key",
      },
    };

    const safe = redactTraceRecord(record);
    const text = JSON.stringify(safe);
    expect(text).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(text).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(text).not.toContain("sup3r-secret");
    expect(text).not.toContain("hunter2-swordfish");
    expect(text).not.toContain("opaque-token-value");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("ops@example.com");
    expect(text).toContain("o***@example.com");
    // Structure and safe detail survive; the source object is untouched.
    expect(safe.payload).toMatchObject({
      model_id: "m",
      status: "completed",
      durationMs: 12,
      tool_name: "read_file",
    });
    expect(Array.isArray((safe.payload as { nested: unknown[] }).nested)).toBe(true);
    // The documented trade-off: the shared field rule fails closed on a bare `key`, so a
    // non-secret field with that exact name is redacted in diagnostics. That is the price of
    // never emitting `{"key": "<credential>"}`; dashboards should name fields descriptively.
    expect((safe.payload as { key: unknown }).key).toBe(REDACTED_MARKER);
    expect(record.payload.apiKey).toBe("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(record.payload.note).toContain("hunter2-swordfish");
  });

  it("redacts a credential that appears in a field name, not just in a value", () => {
    const record = {
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz": "carried as a key",
      "ops@example.com": "carried as a key as well",
      kept: { "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": 1 },
    };
    const safe = redactTraceRecord(record);
    const text = JSON.stringify(safe);
    // The key is content: redacting the value alone would still export the credential.
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("ops@example.com");
    expect(text).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(Object.keys(safe)).toContain("kept");
    // Two different keys that redact to the same name both survive, under distinct names. The
    // keys are not credential-shaped themselves (so their values pass through), but both mask to
    // the same address -- which is the collision the suffix exists for.
    const colliding = redactTraceRecord({
      "contact ops@example.com": 1,
      "contact ops@example.com ": 2,
    });
    expect(Object.keys(colliding)).toHaveLength(2);
    expect(Object.values(colliding).sort()).toEqual([1, 2]);
    expect(Object.keys(colliding).every((key) => key.includes("o***@example.com"))).toBe(true);
  });

  it("redacts a quoted credential field in a torn JSONL tail", () => {
    // The line never parses, so the object path cannot help: this is the text path's job, and a
    // JSON-quoted field name (`"apiKey":`) puts a quote between the name and the colon.
    const torn = '{"apiKey":"my-secret-value",';
    const safe = redactTraceContent(`${torn}\n`);
    expect(safe).not.toContain("my-secret-value");
    expect(safe).toContain("<redacted>");
    // The same shape inside a complete line still works, and a quoted AWS secret too.
    expect(
      redactTraceContent('{"aws_secret_access_key":"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd"}'),
    ).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd");
  });

  it("preserves clean JSONL lines byte-for-byte and only re-serializes changed ones", () => {
    const clean = JSON.stringify({ a: 1, text: "plain", list: [1, 2, 3] });
    const dirty = JSON.stringify({ password: "value-of-secret" });
    const torn = '{"a":1,"torn"';
    const content = `${clean}\n${dirty}\n${torn}\n`;
    const safe = redactTraceContent(content);
    const lines = safe.split("\n");
    expect(lines[0]).toBe(clean);
    expect(lines[1]).not.toContain("value-of-secret");
    expect(JSON.parse(lines[1]!)).toEqual({ password: REDACTED_MARKER });
    expect(lines[2]).toBe(torn);
    expect(lines[3]).toBe("");
  });
});
