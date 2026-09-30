import { describe, expect, it } from "vitest";
import { FailureStatusTracker } from "../src/llm/failure-status.js";

describe("FailureStatusTracker", () => {
  it("keeps the last non-rate-limit failure over later 429s", () => {
    const tracker = new FailureStatusTracker();

    tracker.note(403);
    tracker.note(429);
    tracker.note(429);

    expect(tracker.finalStatus()).toBe(403);
  });

  it("uses the most recent non-rate-limit failure", () => {
    const tracker = new FailureStatusTracker();

    tracker.note(403);
    tracker.note(500);
    tracker.note(429);

    expect(tracker.finalStatus()).toBe(500);
  });

  it("reports 429 when rate limiting is the only failure", () => {
    const tracker = new FailureStatusTracker();

    tracker.note(429);
    tracker.note(429);

    expect(tracker.finalStatus()).toBe(429);
  });

  it("defaults to 502 when no failure was recorded", () => {
    expect(new FailureStatusTracker().finalStatus()).toBe(502);
  });
});
