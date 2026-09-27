/**
 * The surface-advisory invariants, as executable assertions.
 *
 * These follow jev-invariants.test.ts's rule: the properties that make the advisory safe to
 * ship are written as tests, so a failure names the rule that broke rather than "something
 * about JEV went wrong". The three that matter for a NON-TOOL-CALL surface are sharper than
 * for the tool advisor, because these fire from places with no user waiting:
 *
 *   1. a failed observation does not fail the operation it observed;
 *   2. a failed observation does not DELAY it either — the turn-end path must be unaffected;
 *   3. the provider's answer cannot become a control-flow input, structurally.
 *
 * (3) is the one worth reading twice. The tool advisor proves non-authorization by showing the
 * hook's return type has no `decision`. Here the call is fire-and-forget, so there is no
 * return value at all to inspect — the guarantee comes from `notify` returning `void` plus the
 * absence of any consumer. Both halves are asserted below, because either alone is weaker
 * than the property: a `void` return with a global "last observation" would be a back door,
 * and an unused return type with a reachable consumer would be a lie.
 */
import { describe, expect, it, vi } from "vitest";
import { AdvisoryActivityRecorder, ADVISORY_SURFACES } from "../src/jev/activity.js";
import { JevClient } from "../src/jev/client.js";
import {
  buildJevSurfaceState,
  JEV_MAX_PENDING_SURFACE_OBSERVATIONS,
  JEV_SURFACE_DEADLINE_MS,
  JEV_SURFACE_QUESTIONS,
  JevSurfaceAdvisor,
} from "../src/jev/surfaces.js";
import type { JevSurfaceFacts } from "../src/jev/surfaces.js";

const TURN: JevSurfaceFacts = {
  surface: "turn",
  durationMs: 4200,
  outcome: "completed",
  messageCount: 31,
  subagentsSpawned: 2,
  contextAvailability: "ok",
  provider: "anthropic",
  modelId: "claude-sonnet-4",
};

/**
 * A manually-released promise. Typed with a definite-assignment assertion on the resolver
 * because TypeScript cannot see that the Promise executor runs synchronously, and would
 * otherwise narrow `release` to `never` at every call site.
 */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A transport that answers a well-formed surface response, optionally overridden per test. */
function answeringFetch(answer?: (body: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(parsed);
    const payload = answer
      ? answer(parsed)
      : {
          model: "probe/model",
          usage: { input_tokens: 8, output_tokens: 3 },
          answers: {
            turn_read: { type: "choice", choice: "routine", confidence: 0.8, probabilities: {} },
            session_read: {
              type: "choice",
              choice: "ordinary",
              confidence: 0.8,
              probabilities: {},
            },
            context_read: {
              type: "choice",
              choice: "comfortable",
              confidence: 0.8,
              probabilities: {},
            },
            worth_review: { type: "noul", noul: 0.1 },
          },
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function advisorWith(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof JevSurfaceAdvisor>[0]> = {},
): JevSurfaceAdvisor {
  return new JevSurfaceAdvisor({
    client: new JevClient({ apiKey: "host-key", maxRetries: 0, fetch: fetchImpl }),
    ...extra,
  });
}

describe("invariant: a surface observation has no decision field, on any answer", () => {
  it("answers with a closed vocabulary and no actionable key", async () => {
    const { fetchImpl } = answeringFetch();
    const advisory = await advisorWith(fetchImpl).observe({ ...TURN, key: "s1" });
    expect(advisory.status).toBe("advised");
    // Nothing here can be branched on to change what the harness does. `read` names a
    // description and `worthReviewProbability` is a number on a chart; there is no severity,
    // no verdict, and above all no decision.
    expect(Object.keys(advisory).sort()).toEqual([
      "inputTokens",
      "latencyMs",
      "model",
      "outputTokens",
      "read",
      "status",
      "surface",
      "worthReviewProbability",
    ]);
    expect(JSON.stringify(advisory)).not.toMatch(/decision|verdict|severity|should|block|deny/i);
  });

  it("keeps a maximally alarming answer as a description", async () => {
    const { fetchImpl } = answeringFetch(() => ({
      model: "probe/model",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        turn_read: {
          type: "choice",
          choice: "stalled_or_failing",
          confidence: 1,
          probabilities: {},
        },
        session_read: {
          type: "choice",
          choice: "ended_unexpectedly",
          confidence: 1,
          probabilities: {},
        },
        context_read: {
          type: "choice",
          choice: "under_pressure",
          confidence: 1,
          probabilities: {},
        },
        // "certainly worth a human" is not "stop the run".
        worth_review: { type: "noul", noul: 1 },
        // A hostile extra field, which must be ignored rather than forwarded.
        decision: "abort_the_session",
        severity: "critical",
      },
    }));
    const advisory = await advisorWith(fetchImpl).observe({ ...TURN, key: "s1" });
    expect(advisory.read).toBe("stalled_or_failing");
    expect(advisory.worthReviewProbability).toBe(1);
    expect(Object.keys(advisory)).not.toContain("decision");
    expect(Object.keys(advisory)).not.toContain("severity");
  });

  it("rejects an answer outside the surface's closed vocabulary", async () => {
    // A provider that invents a category is a protocol error, not a value to pass through:
    // widening the vocabulary at runtime is how an observation turns into a decision.
    const { fetchImpl } = answeringFetch(() => ({
      model: "probe/model",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        turn_read: { type: "choice", choice: "you_should_retry", confidence: 1, probabilities: {} },
        worth_review: { type: "noul", noul: 1 },
      },
    }));
    const advisory = await advisorWith(fetchImpl).observe({ ...TURN, key: "s1" });
    expect(advisory.status).toBe("unavailable");
    expect(advisory.reason).toBe("invalid_response");
  });

  it("states the non-authorizing rule in the state the provider reads", () => {
    for (const surface of ADVISORY_SURFACES) {
      const state = JSON.parse(
        buildJevSurfaceState({ ...TURN, surface } as JevSurfaceFacts),
      ) as Record<string, unknown>;
      expect(state.advisory_only).toBe(true);
      expect(String(state.authorization)).toMatch(/does not read it/i);
      expect(state.surface).toBe(surface);
    }
  });
});

describe("invariant: the provider's answer is structurally unavailable as control flow", () => {
  it("notify returns void, so a caller cannot obtain an observation to branch on", () => {
    const { fetchImpl } = answeringFetch();
    // The return value is undefined at the type level and at runtime. There is no "last
    // observation" out-param and no static counter a caller could read instead — the
    // observer's only outputs are the injected recorder and the optional sink.
    const result = advisorWith(fetchImpl).notify({ ...TURN, key: "s1" });
    expect(result).toBeUndefined();
  });

  it("exposes no readable pending state beyond a count", () => {
    const { fetchImpl } = answeringFetch();
    const advisor = advisorWith(fetchImpl);
    expect(Object.keys(advisor)).toEqual([
      "options",
      "activity",
      "deadlineMs",
      "onObservation",
      "now",
      "pending",
    ]);
    expect(typeof advisor.pendingCount).toBe("number");
  });

  it("routes the answer to a sink that can only be read, not acted on", async () => {
    const { fetchImpl } = answeringFetch();
    const seen: unknown[] = [];
    const advisory = await advisorWith(fetchImpl, {
      onObservation: (a) => seen.push(a),
    }).observe({ ...TURN, key: "s1" });
    expect(seen).toEqual([advisory]);
  });
});

describe("invariant: a failed observation does not fail or delay the observed operation", () => {
  it("returns synchronously while the provider is still hanging", () => {
    // A transport that never settles. If notify() ever became async-awaited by a caller, or
    // started doing work before returning, this is the test that catches it: the caller must
    // be back long before any provider deadline could have elapsed.
    const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;
    const advisor = advisorWith(hanging, { deadlineMs: 5_000 });
    const startedAt = performance.now();
    advisor.notify({ ...TURN, key: "s1" });
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(50);
    // ...and it really is in flight, so the assertion above is not passing because nothing
    // happened at all.
    expect(advisor.pendingCount).toBe(1);
  });

  it("converts every provider failure into an observation instead of throwing", async () => {
    for (const [label, fetchImpl] of [
      [
        "transport throws",
        (() => {
          throw new Error("provider exploded: https://attacker.example/secret-body");
        }) as typeof fetch,
      ],
      ["provider returns 500", (async () => new Response("nope", { status: 500 })) as typeof fetch],
      [
        "malformed body",
        (async () =>
          new Response("<html>not json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })) as typeof fetch,
      ],
    ] as const) {
      const advisory = await advisorWith(fetchImpl).observe({ ...TURN, key: "s1" });
      expect(advisory.status, label).toBe("unavailable");
      // The reason is a bucket. An error body must never reach a reader through a metric.
      expect(advisory.reason, label).not.toContain("attacker.example");
      expect(advisory.reason, label).not.toContain("secret-body");
      expect(advisory.read, label).toBe("unknown");
      expect(advisory.worthReviewProbability, label).toBeNull();
    }
  });

  it("survives a host sink that throws", async () => {
    const { fetchImpl } = answeringFetch();
    const activity = new AdvisoryActivityRecorder();
    const advisory = await advisorWith(fetchImpl, {
      activity,
      onObservation: () => {
        throw new Error("host sink bug");
      },
    }).observe({ ...TURN, key: "s1" });
    // The observation still resolved: a host's rendering bug cannot become the advisory's
    // failure, and certainly cannot propagate into whatever produced the surface.
    expect(advisory.status).toBe("advised");
    expect(activity.snapshot().unavailableBySurface.get("turn")).toBeUndefined();
  });

  it("does not reject when a provider fails after notify returned", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const broken = (() => {
        throw new Error("down");
      }) as typeof fetch;
      const activity = new AdvisoryActivityRecorder();
      advisorWith(broken, { activity }).notify({ ...TURN, key: "s1" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
      expect(activity.snapshot().unavailableBySurface.get("turn")).toBe(1);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("invariant: observations in flight are bounded and coalesced, never queued", () => {
  it("drops rather than queues once the cap is reached", async () => {
    const gate = deferred();
    const hanging = (async () => {
      await gate.promise;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const activity = new AdvisoryActivityRecorder();
    const advisor = advisorWith(hanging, { activity });
    for (let i = 0; i < JEV_MAX_PENDING_SURFACE_OBSERVATIONS; i += 1) {
      advisor.notify({ ...TURN, key: `s${i}` });
    }
    expect(advisor.pendingCount).toBe(JEV_MAX_PENDING_SURFACE_OBSERVATIONS);
    // One past the cap: refused, not queued. Queuing here is the unbounded-growth failure —
    // a burst of surfaces would become a burst of provider calls.
    advisor.notify({ ...TURN, key: "one-too-many" });
    expect(advisor.pendingCount).toBe(JEV_MAX_PENDING_SURFACE_OBSERVATIONS);
    expect(activity.snapshot().droppedBySurface.get("turn")).toBe("at_capacity");
    gate.release();
    await gate.promise;
  });

  it("releases the slot when an observation settles, so the cap is not a lifetime budget", async () => {
    const { fetchImpl } = answeringFetch();
    const advisor = advisorWith(fetchImpl);
    for (let i = 0; i < JEV_MAX_PENDING_SURFACE_OBSERVATIONS * 2; i += 1) {
      advisor.notify({ ...TURN, key: `s${i}` });
    }
    await vi.waitFor(() => expect(advisor.pendingCount).toBe(0), { timeout: 10_000 });
  });

  it("coalesces a second observation for a key already in flight", async () => {
    const gate = deferred();
    const hanging = (async () => {
      await gate.promise;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const activity = new AdvisoryActivityRecorder();
    const advisor = advisorWith(hanging, { activity });
    advisor.notify({ ...TURN, key: "same" });
    advisor.notify({ ...TURN, key: "same" });
    advisor.notify({ ...TURN, key: "same" });
    expect(advisor.pendingCount).toBe(1);
    expect(activity.snapshot().droppedBySurface.get("turn")).toBe("coalesced");
    gate.release();
    await gate.promise;
  });
});

describe("invariant: the state sent to the provider carries no run content", () => {
  it("is a closed set of counts, durations and enums per surface", () => {
    expect(Object.keys(JSON.parse(buildJevSurfaceState(TURN)) as object).sort()).toEqual([
      "advisory_only",
      "authorization",
      "model",
      "surface",
      "turn",
    ]);
    expect(
      Object.keys(
        JSON.parse(
          buildJevSurfaceState({
            surface: "session",
            event: "long_silence",
            idleMs: 1_800_000,
            backgroundProcesses: 1,
            backgroundSubagents: 0,
          }),
        ) as object,
      ).sort(),
    ).toEqual(["advisory_only", "authorization", "session", "surface"]);
    expect(
      Object.keys(
        JSON.parse(
          buildJevSurfaceState({
            surface: "context",
            trigger: "compaction_requested",
            availability: "just_compacted",
          }),
        ) as object,
      ).sort(),
    ).toEqual(["advisory_only", "authorization", "context", "surface"]);
  });

  it("clamps a hostile or malformed fact set instead of forwarding it", () => {
    // A session id or model name is host config, so it is redacted and bounded. A count that
    // is not a number is replaced by 0 rather than being passed through as NaN/Infinity,
    // which JSON turns into null and which would make the question unanswerable.
    const state = JSON.parse(
      buildJevSurfaceState({
        ...TURN,
        durationMs: Number.NaN,
        messageCount: -5,
        subagentsSpawned: Number.POSITIVE_INFINITY,
        provider: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        modelId: "m".repeat(500),
      }),
    ) as { turn: Record<string, number>; model: Record<string, string | undefined> };
    expect(state.turn.duration_ms).toBe(0);
    expect(state.turn.messages_published).toBe(0);
    expect(state.turn.subagents_spawned).toBe(0);
    expect(state.model.provider).not.toContain("sk-ant-api03");
    expect((state.model.model_id ?? "").length).toBeLessThanOrEqual(128);
  });

  it("asks only description-shaped questions", () => {
    // No question may ask what to DO. A question that asks for a recommendation is a
    // decision in waiting, however carefully the result is later typed.
    const text = JSON.stringify(JEV_SURFACE_QUESTIONS);
    expect(text).not.toMatch(/\byou should\b|\bmust\b|\brecommend/i);
    expect(text).toMatch(/Do not propose any action/);
  });
});

describe("invariant: the default deadline is a short, bounded wait", () => {
  it("is under a second and inside the advisor's accepted range", () => {
    expect(JEV_SURFACE_DEADLINE_MS).toBeLessThan(1_000);
    const { fetchImpl } = answeringFetch();
    const advisor = new JevSurfaceAdvisor({
      client: new JevClient({ apiKey: "k", maxRetries: 0, fetch: fetchImpl }),
      // A hostile host asking for a 60s wait is clamped, not honoured: a surface
      // observation that can hold a slot for a minute is a slot not available to observe
      // anything else.
      deadlineMs: 60_000,
    });
    expect(Object.keys(advisor)).toContain("deadlineMs");
  });
});
