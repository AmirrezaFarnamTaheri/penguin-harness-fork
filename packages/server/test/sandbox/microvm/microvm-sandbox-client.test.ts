import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRIES,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  KEEPALIVE_PING_HEADER,
  KEEPALIVE_PING_INTERVAL_SEC,
  MicrovmAuthenticationError,
  MicrovmError,
  MicrovmFileNotFoundError,
  MicrovmInvalidArgumentError,
  MicrovmNotFoundError,
  MicrovmRateLimitError,
  MicrovmSandboxClient,
  MicrovmSandboxNotFoundError,
  MicrovmServiceBusyError,
  MicrovmTemplateError,
  MicrovmTimeoutError,
  REQUEST_TIMEOUT_MS,
  parseRetryAfter,
  resolveRetries,
  withRateLimitRetry,
} from "../../../src/sandbox/microvm/microvm-sandbox-client.js";

/** One canned fetch call: the input, the init, and the order it arrived in. */
type FetchCall = { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] };

/**
 * A fetch stand-in that replays a canned response sequence and records every call, so
 * a test asserts on the wire — URL, method, headers, and how many attempts there were.
 *
 * The recorder and the fetch are produced together and the array never leaves the pair,
 * so an inline client construction can never hand the client an undefined call log.
 */
function recordingFetch(responses: Response[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const recorded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) throw new Error("test fetch ran out of canned responses");
    return response;
  };
  return { fetch: recorded as typeof fetch, calls };
}

/** A client wired to one canned response sequence, with its call log exposed. */
function cannedClient(
  responses: Response[],
  overrides: Partial<ConstructorParameters<typeof MicrovmSandboxClient>[0]> = {},
): { client: MicrovmSandboxClient; calls: FetchCall[] } {
  const recorder = recordingFetch(responses);
  return {
    client: new MicrovmSandboxClient(config(overrides), recorder.fetch, async () => {}),
    calls: recorder.calls,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function config(overrides: Partial<ConstructorParameters<typeof MicrovmSandboxClient>[0]> = {}) {
  return {
    apiUrl: "https://controlplane.test",
    apiKey: "key",
    defaultTemplate: "base",
    ...overrides,
  };
}

describe("microvm-sandbox-client", () => {
  describe("connection constants", () => {
    it("keeps the donor's values, including the sub-60s keepalive interval", () => {
      // The ping interval must stay under the 60s proxy idle timeout.
      expect(KEEPALIVE_PING_INTERVAL_SEC).toBeLessThan(60);
      expect(REQUEST_TIMEOUT_MS).toBe(60_000);
      expect(DEFAULT_RETRIES).toBe(3);
      expect(DEFAULT_SANDBOX_TIMEOUT_MS).toBe(300_000);
      expect(KEEPALIVE_PING_HEADER).toBe("Keepalive-Ping-Interval");
    });
  });

  describe("resolveRetries", () => {
    it("accepts a non-negative integer", () => {
      expect(resolveRetries(0)).toBe(0);
      expect(resolveRetries(5)).toBe(5);
    });

    it("rejects negative, fractional and non-integer budgets", () => {
      [-1, 1.5, NaN, Infinity, "3" as unknown as number].forEach((bad) => {
        expect(() => resolveRetries(bad)).toThrow(MicrovmInvalidArgumentError);
      });
    });
  });

  describe("parseRetryAfter", () => {
    it("parses a decimal delta-seconds value", () => {
      expect(parseRetryAfter("5")).toBe(5);
      expect(parseRetryAfter(" 12 ")).toBe(12);
    });

    it("refuses an HTTP-date form, which the protocol must not honour", () => {
      expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
    });

    it("refuses malformed and empty values", () => {
      expect(parseRetryAfter("soon")).toBeUndefined();
      expect(parseRetryAfter("")).toBeUndefined();
      expect(parseRetryAfter(null)).toBeUndefined();
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter("-5")).toBeUndefined();
    });

    it("refuses a delta too large to honour safely", () => {
      // One past the signed 31-bit ceiling the donor clamps at.
      expect(parseRetryAfter("2147483648")).toBeUndefined();
    });
  });

  describe("withRateLimitRetry", () => {
    it("replays a 429 carrying a decimal Retry-After", async () => {
      const recorder = recordingFetch([
        json(429, {}, { "Retry-After": "1" }),
        json(200, { ok: true }),
      ]);
      const wrapped = withRateLimitRetry(
        recorder.fetch,
        2,
        10_000,
        () => 0,
        async () => {},
      );

      const response = await wrapped("https://x.test/req");

      expect(response.status).toBe(200);
      expect(recorder.calls).toHaveLength(2);
    });

    it("does not replay a 429 with a malformed Retry-After", async () => {
      const recorder = recordingFetch([json(429, {}, { "Retry-After": "soon" })]);
      const wrapped = withRateLimitRetry(
        recorder.fetch,
        2,
        10_000,
        () => 0,
        async () => {},
      );

      const response = await wrapped("https://x.test/req");

      expect(response.status).toBe(429);
      expect(recorder.calls).toHaveLength(1);
    });

    it("stops replaying once the retry budget is spent", async () => {
      const recorder = recordingFetch([
        json(429, {}, { "Retry-After": "0" }),
        json(429, {}, { "Retry-After": "0" }),
      ]);
      const wrapped = withRateLimitRetry(
        recorder.fetch,
        1,
        10_000,
        () => 0,
        async () => {},
      );

      const response = await wrapped("https://x.test/req");

      // One original attempt plus one replay.
      expect(response.status).toBe(429);
      expect(recorder.calls).toHaveLength(2);
    });

    it("refuses to wait past the deadline even with budget left", async () => {
      const recorder = recordingFetch([json(429, {}, { "Retry-After": "30" })]);
      let now = 0;
      const wrapped = withRateLimitRetry(
        recorder.fetch,
        3,
        1_000,
        () => now,
        async () => {
          now += 30_000;
        },
      );

      const response = await wrapped("https://x.test/req");

      // A 30s wait would blow a 1s deadline, so the 429 is returned as-is.
      expect(response.status).toBe(429);
      expect(recorder.calls).toHaveLength(1);
    });

    it("gives a streaming body exactly one attempt, never a replay", async () => {
      const recorder = recordingFetch([json(429, {}, { "Retry-After": "1" })]);
      const wrapped = withRateLimitRetry(
        recorder.fetch,
        3,
        10_000,
        () => 0,
        async () => {},
      );

      // A stream body is unreplayable, so the wrapper must send it once and return
      // whatever came back rather than tee and resend it. Node's fetch requires
      // `duplex: "half"` alongside a stream body.
      const body = new ReadableStream({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode("payload"));
          controller.close();
        },
      });
      const response = await wrapped("https://x.test/req", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit);

      expect(response.status).toBe(429);
      expect(recorder.calls).toHaveLength(1);
    });

    it("does not retry a success or a non-429 error", async () => {
      for (const canned of [json(200, {}), json(500, {}), json(403, {})]) {
        const recorder = recordingFetch([canned]);
        const wrapped = withRateLimitRetry(
          recorder.fetch,
          3,
          10_000,
          () => 0,
          async () => {},
        );
        await wrapped("https://x.test/req");
        expect(recorder.calls).toHaveLength(1);
      }
    });
  });

  describe("client construction", () => {
    it("requires an API URL and a key", () => {
      expect(() => new MicrovmSandboxClient(config({ apiUrl: "" }))).toThrow(
        MicrovmInvalidArgumentError,
      );
      expect(() => new MicrovmSandboxClient(config({ apiKey: "" }))).toThrow(
        MicrovmInvalidArgumentError,
      );
    });

    it("strips trailing slashes from the API URL", async () => {
      const { client, calls } = cannedClient([json(200, { sandboxId: "sb1" })], {
        apiUrl: "https://controlplane.test//",
      });
      await client.create();
      // The recorder sees the Request the retry wrapper built, so the URL is on it.
      // Duck-typed rather than `instanceof Request`: under a worker/vm realm the recorded
      // Request is cross-realm, so the prototype check fails and String(sent) would yield
      // "[object Request]" instead of the URL we actually want to assert on.
      const sent = calls[0]!.input;
      const sentUrl =
        sent && typeof sent === "object" && "url" in sent ? (sent as Request).url : String(sent);
      expect(sentUrl).toBe("https://controlplane.test/sandboxes");
    });

    it("rejects a negative retry budget at construction", () => {
      expect(() => new MicrovmSandboxClient(config({ retries: -1 }))).toThrow(
        MicrovmInvalidArgumentError,
      );
    });
  });

  describe("request wire", () => {
    it("sends the auth header and the keepalive ping header", async () => {
      const { client, calls } = cannedClient([json(200, { sandboxId: "sb1" })]);
      await client.create();

      const headers = new Headers(calls[0]!.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer key");
      expect(headers.get(KEEPALIVE_PING_HEADER)).toBe(String(KEEPALIVE_PING_INTERVAL_SEC));
      expect(headers.get("Content-Type")).toBe("application/json");
    });

    it("composes the caller's abort signal with the timeout", async () => {
      const { client, calls } = cannedClient([json(200, { sandboxId: "sb1" })]);
      const controller = new AbortController();
      await client.create({}, { signal: controller.signal });
      expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("error taxonomy", () => {
    it("maps each status to its typed error", async () => {
      const cases: Array<[number, new (m: string) => Error]> = [
        [400, MicrovmInvalidArgumentError],
        [404, MicrovmNotFoundError],
        [408, MicrovmTimeoutError],
        [502, MicrovmTimeoutError],
        [504, MicrovmTimeoutError],
        [429, MicrovmRateLimitError],
        [503, MicrovmServiceBusyError],
        [500, MicrovmError],
      ];
      for (const [status, ErrorType] of cases) {
        const { client } = cannedClient([json(status, {})]);
        await expect(client.getInfo("sb1")).rejects.toBeInstanceOf(ErrorType);
      }
    });

    it("surfaces 401/403 as an authentication error that is not a base error", async () => {
      for (const status of [401, 403]) {
        const { client } = cannedClient([json(status, {})]);
        const error = await client.getInfo("sb1").catch((error) => error);
        expect(error).toBeInstanceOf(MicrovmAuthenticationError);
        expect(error).not.toBeInstanceOf(MicrovmError);
      }
    });

    it("names a sandbox on a 404 against a sandbox-scoped call", async () => {
      const { client } = cannedClient([json(404, {})]);
      await expect(client.getInfo("sb-missing")).rejects.toBeInstanceOf(
        MicrovmSandboxNotFoundError,
      );
    });

    it("carries the Retry-After delta on a rate-limit error", async () => {
      // Two identical 429s: the client replays once within its budget, then returns
      // the second, and the delta survives onto the error a caller sees.
      const { client } = cannedClient(
        [json(429, {}, { "Retry-After": "7" }), json(429, {}, { "Retry-After": "7" })],
        { requestTimeoutMs: 1_000 },
      );
      await expect(client.getInfo("sb1")).rejects.toMatchObject({
        name: "MicrovmRateLimitError",
        retryAfterSeconds: 7,
      });
    });

    it("keeps every typed error's name set for error-path switches", () => {
      expect(new MicrovmTimeoutError("t").name).toBe("MicrovmTimeoutError");
      expect(new MicrovmInvalidArgumentError("a").name).toBe("MicrovmInvalidArgumentError");
      expect(new MicrovmNotFoundError("n").name).toBe("MicrovmNotFoundError");
      expect(new MicrovmFileNotFoundError("f").name).toBe("MicrovmFileNotFoundError");
      expect(new MicrovmSandboxNotFoundError("s").name).toBe("MicrovmSandboxNotFoundError");
      expect(new MicrovmServiceBusyError("b").statusCode).toBe(503);
      expect(new MicrovmTemplateError("t").name).toBe("MicrovmTemplateError");
    });
  });

  describe("lifecycle", () => {
    it("creates a sandbox from the default template", async () => {
      const { client } = cannedClient([
        json(200, { sandboxId: "sb1", templateId: "base", status: "running" }),
      ]);
      await expect(client.create()).resolves.toMatchObject({
        id: "sb1",
        templateId: "base",
        status: "running",
      });
    });

    it("falls back to the documented defaults when the plane omits fields", async () => {
      const { client } = cannedClient([json(200, { id: "sb1" })]);
      await expect(client.getInfo("sb1")).resolves.toMatchObject({
        templateId: "base",
        status: "unknown",
        timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
        envdPort: 49983,
        mcpPort: 50005,
      });
    });

    it("exists() reports false only for a not-found", async () => {
      const missing = cannedClient([json(404, {})]);
      await expect(missing.client.exists("sb1")).resolves.toBe(false);

      const live = cannedClient([json(200, { sandboxId: "sb1" })]);
      await expect(live.client.exists("sb1")).resolves.toBe(true);

      const broken = cannedClient([json(500, {})]);
      await expect(broken.client.exists("sb1")).rejects.toBeInstanceOf(MicrovmError);
    });

    it("kill() is idempotent over a 404", async () => {
      const { client } = cannedClient([json(404, {})]);
      await expect(client.kill("sb-gone")).resolves.toBeUndefined();
    });

    it("resume() rejects an unknown mode", async () => {
      const { client } = cannedClient([]);
      await expect(client.resume("sb1", "fast" as never)).rejects.toBeInstanceOf(
        MicrovmInvalidArgumentError,
      );
    });

    it("setTimeout() rejects a negative budget", async () => {
      const { client } = cannedClient([]);
      await expect(client.setTimeout("sb1", -1)).rejects.toBeInstanceOf(
        MicrovmInvalidArgumentError,
      );
    });

    it("reads a snapshot id from either the nested or the flat shape", async () => {
      const nested = cannedClient([json(200, { snapshot: { id: "snap1" }, createdAtMs: 1 })]);
      await expect(nested.client.createSnapshot("sb1")).resolves.toMatchObject({
        id: "snap1",
        sandboxId: "sb1",
        createdAtMs: 1,
      });

      const flat = cannedClient([json(200, { id: "snap2" })]);
      await expect(flat.client.createSnapshot("sb1")).resolves.toMatchObject({ id: "snap2" });
    });

    it("reports metrics with zeros when the plane sends nothing", async () => {
      const { client } = cannedClient([json(200, {})]);
      await expect(client.getMetrics("sb1")).resolves.toMatchObject({
        sandboxId: "sb1",
        cpuCount: 0,
        memMiB: 0,
      });
    });

    it("runs a command and captures its output", async () => {
      const { client } = cannedClient([json(200, { exitCode: 0, stdout: "hi", stderr: "" })]);
      const result = await client.runCommand("sb1", { cmd: "echo hi" });
      expect(result).toMatchObject({ exitCode: 0, stdout: "hi", stderr: "" });
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("refuses an empty command", async () => {
      const { client } = cannedClient([]);
      await expect(client.runCommand("sb1", { cmd: "" })).rejects.toBeInstanceOf(
        MicrovmInvalidArgumentError,
      );
    });
  });
});
