import { describe, it, expect } from "vitest";
import {
  ADVISORY_REASONS,
  AdvisoryActivityRecorder,
  bucketReason,
  type AdvisoryReason,
} from "../src/jev/activity.js";
import { JevClient } from "../src/jev/client.js";
import { JevToolAdvisor } from "../src/jev/advisor.js";

describe("advisory activity recorder", () => {
  it("keeps its key space closed, whatever it is handed", () => {
    // The whole safety argument of this module is that nothing free-form enters it. A caller
    // passing a provider string, a tool argument, or a prompt must land in a known bucket.
    const recorder = new AdvisoryActivityRecorder();
    for (const hostile of [
      "https://attacker.example/leak?token=abc",
      "tool argument text",
      '{"decision":"allow"}',
      "provider_http_999",
      "x".repeat(5000),
    ]) {
      recorder.record({ advised: false, reason: hostile });
    }
    const snapshot = recorder.snapshot();
    for (const reason of snapshot.byReason.keys()) {
      expect(ADVISORY_REASONS).toContain(reason as AdvisoryReason);
    }
    // The only free-ish data is a number the host produced, and it is range-checked.
    for (const status of snapshot.providerHttpStatuses.keys()) {
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThanOrEqual(599);
    }
    expect(JSON.stringify(snapshot)).not.toContain("attacker.example");
  });

  it("splits an HTTP status out of the diagnostic instead of making it a key", () => {
    expect(bucketReason("provider_http_429")).toEqual({ reason: "provider_http", httpStatus: 429 });
    // A status outside the HTTP error range is dropped rather than recorded.
    expect(bucketReason("provider_http_999")).toEqual({ reason: "provider_http" });
    expect(bucketReason("timeout")).toEqual({ reason: "timeout" });
    expect(bucketReason("something unrecognised")).toEqual({ reason: "unavailable" });
  });

  it("counts answers, failures and skips separately", () => {
    const recorder = new AdvisoryActivityRecorder();
    recorder.record({ advised: true, reason: "advised", latencyMs: 10 });
    recorder.record({ advised: false, reason: "timeout" });
    recorder.record({ advised: false, reason: "timeout" });
    recorder.recordSkipped("policy");
    recorder.recordSkipped("decided");
    recorder.recordSkipped("disabled");
    const snapshot = recorder.snapshot();
    expect(snapshot.answered).toBe(1);
    expect(snapshot.unavailable).toBe(2);
    expect(snapshot.byReason.get("timeout")).toBe(2);
    expect(snapshot.skippedPolicy).toBe(1);
    expect(snapshot.skippedDecided).toBe(1);
    expect(snapshot.skipped).toBe(1);
  });

  it("bounds the latency samples it keeps", () => {
    const recorder = new AdvisoryActivityRecorder();
    for (let i = 0; i < 1000; i += 1) {
      recorder.record({ advised: true, reason: "advised", latencyMs: i });
    }
    // A sample ring, not an audit log: the recorder must not become the leak it exists to avoid.
    const percentiles = recorder.latencyPercentiles();
    expect(percentiles).not.toBeNull();
    expect(percentiles?.p50).toBeGreaterThan(0);
    expect(percentiles?.p95).toBeGreaterThanOrEqual(percentiles?.p50 ?? 0);
  });

  it("ignores a nonsensical latency rather than recording it", () => {
    const recorder = new AdvisoryActivityRecorder();
    recorder.record({ advised: true, reason: "advised", latencyMs: -5 });
    recorder.record({ advised: true, reason: "advised", latencyMs: Number.NaN });
    recorder.record({ advised: true, reason: "advised", latencyMs: Number.POSITIVE_INFINITY });
    expect(recorder.latencyPercentiles()).toBeNull();
    expect(recorder.snapshot().answered).toBe(3);
  });

  it("reports nothing for latency when nothing has answered", () => {
    expect(new AdvisoryActivityRecorder().latencyPercentiles()).toBeNull();
  });

  it("counts through the real advisor without changing what it returns", () => {
    const activity = new AdvisoryActivityRecorder();
    const ok = (async () =>
      new Response(
        JSON.stringify({
          model: "probe/model",
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: {
            tool_fit: { type: "choice", choice: "matches", confidence: 0.9, probabilities: {} },
            risk: { type: "score", score: 1, confidence: 0.9, legend: {}, probabilities: {} },
            needs_tool: { type: "noul", noul: 0.9 },
            arguments_complete: { type: "noul", noul: 0.9 },
            requires_approval: { type: "noul", noul: 0.1 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const advisor = new JevToolAdvisor({
      client: new JevClient({ apiKey: "k", maxRetries: 0, fetch: ok }),
      activity,
    });
    const result = advisor.advise({ toolName: "read_file", argumentsJson: "{}" });
    expect(activity.snapshot().answered).toBe(0);
    return result.then((advisory) => {
      expect(advisory.status).toBe("advised");
      expect(activity.snapshot().answered).toBe(1);
      // The counters changed nothing about the answer: still exactly the advisory fields.
      expect(
        Object.keys(advisory).every((key) => !["decision", "tool", "arguments"].includes(key)),
      ).toBe(true);
    });
  });
});
