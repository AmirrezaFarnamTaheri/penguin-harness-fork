import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createStructuredLogger,
  requestLogContext,
  unhandledRejectionMetrics,
  withLogContext,
} from "../src/runtime/logger.js";
import { installProcessErrorHandlers } from "../src/runtime/process-errors.js";

describe("structured server logging", () => {
  it("emits bounded JSON with async request/session context and removes credential-shaped text", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ sink: (line) => lines.push(line) });
    const context = requestLogContext(
      new Request("http://localhost/api/sessions/session_123/messages", {
        headers: { "x-request-id": "req-123" },
      }),
    );

    withLogContext(context, () => {
      logger.info("provider failed api_key=super-secret", {
        detail: "Bearer bearer-secret",
        apiKey: "field-secret",
      });
      logger.warn("x".repeat(10_000));
    });

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({ requestId: "req-123", sessionId: "session_123" });
    expect(JSON.stringify(first)).not.toContain("super-secret");
    expect(JSON.stringify(first)).not.toContain("bearer-secret");
    expect(JSON.stringify(first)).not.toContain("field-secret");
    expect(Buffer.byteLength(lines[1]!, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("redacts token-named fields and token assignments without hiding token counters", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({ sink: (line) => lines.push(line) });
    logger.info("refresh failed token=message-secret session_token=other-secret", {
      token: "plain-token-secret",
      authToken: "auth-token-secret",
      headers: { "x-auth-token": "header-token-secret" },
      tokenCount: 42,
      maxTokens: 1024,
    });

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    const text = JSON.stringify(record);
    for (const secret of [
      "message-secret",
      "other-secret",
      "plain-token-secret",
      "auth-token-secret",
      "header-token-secret",
    ])
      expect(text).not.toContain(secret);
    expect(record).toMatchObject({ tokenCount: 42, maxTokens: 1024 });
  });

  it("turns one rejection into one bounded record when the primary logger sink fails", () => {
    const emitter = new EventEmitter();
    const emergency: string[] = [];
    const recorded: Error[] = [];
    const logger = createStructuredLogger({
      sink: () => {
        throw new Error("sink credential=logger-secret");
      },
      emergencySink: (line) => emergency.push(line),
    });
    const dependencies = {
      record: (error: Error) => recorded.push(error),
      shutdown: vi.fn(async () => {}),
      logger,
    };
    const before = unhandledRejectionMetrics();

    installProcessErrorHandlers(dependencies, emitter as unknown as NodeJS.Process);
    const listenerCount = emitter.listenerCount("unhandledRejection");
    const uncaughtListenerCount = emitter.listenerCount("uncaughtException");
    installProcessErrorHandlers(dependencies, emitter as unknown as NodeJS.Process);
    expect(emitter.listenerCount("unhandledRejection")).toBe(listenerCount);
    expect(emitter.listenerCount("uncaughtException")).toBe(uncaughtListenerCount);

    emitter.emit("unhandledRejection", new Error("api_key=event-secret"));

    expect(unhandledRejectionMetrics()).toMatchObject({
      total: before.total + 1,
      lastMinute: before.lastMinute + 1,
      perMinute: before.perMinute + 1,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.message).not.toContain("event-secret");
    expect(emergency).toHaveLength(1);
    expect(emergency[0]).toContain('"event":"logger_sink_failed"');
    expect(emergency[0]).not.toContain("event-secret");
    expect(emergency[0]).not.toContain("logger-secret");
    expect(Buffer.byteLength(emergency[0]!, "utf8")).toBeLessThanOrEqual(4096);
  });
});
