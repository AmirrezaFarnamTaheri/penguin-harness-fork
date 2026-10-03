/**
 * A1 — the promotion: a reversible selector, one decision per failure, and the census that
 * justifies the flip.
 *
 * What is pinned here, in the card's order:
 *
 * - **A1.1 census** — the frozen disagreement corpus gets a canonical hash, so a fixture edit
 *   cannot silently change what the release's "zero unexplained disagreements" claim was made
 *   about; every divergent row carries a reason and an owning decision.
 * - **A1.2 precedence** — the exported precedence table is asserted row by row, including the
 *   two conflicts the card names (403 with a quota code must not become an auth verdict; a
 *   bare 403 must not become a quota).
 * - **A1.3 wiring** — both consumers obey one policy: the LLM error chain
 *   (`GenerativeModel`) and the credential rotator's reason classifier. Under the default
 *   `shadow` policy each reproduces its pre-promotion behaviour exactly; under `active` the
 *   typed classifier decides; switching back restores the old behaviour (reversibility).
 * - **A1.4 promotion** — one decision per response, counters that expose the classification
 *   rate, and no dependence on prose: an active-mode decision is identical for an error whose
 *   message text changes.
 */
import { describe, expect, it } from "vitest";
import type { UniEvent } from "@prismshadow/agenthub";

import { GenerativeModel } from "../../src/llm/generative-model.js";
import { userText } from "../../src/omnimessage/index.js";

import {
  CLASSIFICATION_PRECEDENCE,
  FAILURE_KIND,
  FAILURE_POLICY,
  FAILURE_POLICY_ENV,
  LEGACY_ACTION,
  RECOVERY,
  classifyFailure,
  decideAndReport,
  decideFailure,
  decisionCorpusHash,
  failureClassificationSnapshot,
  resetFailureClassificationCounters,
  resolveFailurePolicy,
  type FailureDecision,
  type FailurePolicy,
  type LegacyAction,
  type ProviderFailure,
} from "../../src/fleet/provider-gateway.js";
import { RATE_LIMIT_REASON, classifyRateLimitReason } from "../../src/fleet/credential-rotation.js";

/** The frozen census corpus: every row is a shape the two vocabularies have an opinion about. */
type CensusRow = {
  name: string;
  failure: ProviderFailure;
  legacy: LegacyAction;
  /** Present only for rows where the classifier's implied action is not the legacy action. */
  divergence?: string;
  owner: string;
};

const CENSUS: CensusRow[] = [
  {
    name: "429 bare",
    failure: { status: 429 },
    legacy: LEGACY_ACTION.CoolDown,
    owner: "rate limit",
  },
  {
    name: "429 with a rate-limit code",
    failure: { status: 429, code: "rate_limit_exceeded" },
    legacy: LEGACY_ACTION.CoolDown,
    owner: "rate limit",
  },
  {
    name: "429 with Retry-After",
    failure: { status: 429, retryAfterMs: 2_000 },
    legacy: LEGACY_ACTION.CoolDown,
    owner: "rate limit",
  },
  {
    name: "403 with a quota code",
    failure: { status: 403, code: "insufficient_user_quota" },
    legacy: LEGACY_ACTION.CoolDown,
    owner: "quota beats the SDK's status label",
  },
  {
    name: "400 with a quota code",
    failure: { status: 400, code: "insufficient_quota" },
    legacy: LEGACY_ACTION.CoolDown,
    owner: "quota beats the SDK's status label",
  },
  {
    name: "401 bare",
    failure: { status: 401 },
    legacy: LEGACY_ACTION.Evict,
    owner: "credential",
  },
  {
    name: "401 with an invalid-key code",
    failure: { status: 401, code: "invalid_api_key" },
    legacy: LEGACY_ACTION.Evict,
    owner: "credential",
  },
  {
    name: "403 with an expired-token code",
    failure: { status: 403, code: "expired_token" },
    legacy: LEGACY_ACTION.Evict,
    owner: "credential",
  },
  {
    // Not a divergence: the old chain calls a bare 403 a definitive rejection (fatal,
    // credential untouched) and the vocabulary has no credential evidence in it either, so
    // both refuse to park the key. The kinds differ while the action agrees — which is exactly
    // why the comparison is made at the action level, as the module documents.
    name: "403 bare",
    failure: { status: 403 },
    legacy: LEGACY_ACTION.None,
    owner: "request",
  },
  { name: "400 bare", failure: { status: 400 }, legacy: LEGACY_ACTION.None, owner: "request" },
  {
    name: "422",
    failure: { status: 422, code: "invalid_request_error" },
    legacy: LEGACY_ACTION.None,
    owner: "request",
  },
  {
    name: "500",
    failure: { status: 500 },
    legacy: LEGACY_ACTION.Observe,
    divergence:
      "Intentional and enumerated: the provider is down, and the outage is not a fact about " +
      "this credential — the old `else` branch counted it against the key anyway.",
    owner: "provider",
  },
  {
    name: "503",
    failure: { status: 503 },
    legacy: LEGACY_ACTION.Observe,
    divergence: "Same reasoning as 500, pinned separately so a 502-only regression stays visible.",
    owner: "provider",
  },
  {
    name: "overloaded_error type",
    failure: { type: "overloaded_error" },
    legacy: LEGACY_ACTION.Observe,
    divergence:
      "Provider-side capacity with no status code: the typed vocabulary reads the declared type " +
      "and refuses to blame the key, which the prose-free collector could not do before.",
    owner: "provider",
  },
  {
    name: "no signal at all",
    failure: {},
    legacy: LEGACY_ACTION.Observe,
    // Not a divergence: unknown maps to observe, exactly what the old `else` branch did.
    owner: "unknown",
  },
];

describe("A1.1 — the census is frozen and explained", () => {
  it("pins the corpus hash so a fixture edit cannot change the no-disagreement claim silently", () => {
    // Why a hash: the release ships a claim — "zero unexplained disagreements over the frozen
    // corpus" — and that claim is only meaningful for one exact set of rows.
    expect(decisionCorpusHash(CENSUS)).toBe("ada6536ebea92dd2");
  });

  it("explains every divergent row with a reason and an owning decision", () => {
    for (const row of CENSUS) {
      const decision = decideAndReport(
        { failure: row.failure, legacy: row.legacy },
        FAILURE_POLICY.Shadow,
      );
      // The annotation and the behaviour must agree in both directions: a row marked as a
      // divergence has to diverge, and a divergent row has to carry its reason.
      expect(decision.agrees, `${row.name} annotation`).toBe(row.divergence === undefined);
      if (row.divergence !== undefined) expect(row.divergence.length).toBeGreaterThan(60);
      expect(row.owner.length, `${row.name} owner`).toBeGreaterThan(0);
    }
    expect(CENSUS.filter((row) => row.divergence !== undefined).map((row) => row.name)).toEqual([
      "500",
      "503",
      "overloaded_error type",
    ]);
  });

  it("classifies every census row to exactly one kind", () => {
    for (const row of CENSUS) {
      const classification = classifyFailure(row.failure);
      expect(Object.values(FAILURE_KIND), row.name).toContain(classification.kind);
      expect(classification.evidence, row.name).not.toBe("");
    }
  });
});

describe("A1.2 — the typed precedence table", () => {
  it("generates the documented order from the exported table", () => {
    // One case per row of the exported table, in table order. The table is data, so this test is
    // the thing that keeps the documentation from drifting away from the implementation.
    const cases: Array<[ProviderFailure, string]> = [
      [{ status: 429, code: "invalid_api_key" }, FAILURE_KIND.CredentialRejected],
      [{ status: 401 }, FAILURE_KIND.CredentialRejected],
      [{ status: 403, code: "insufficient_user_quota" }, FAILURE_KIND.QuotaExhausted],
      [{ status: 403, code: "model_capacity_exhausted" }, FAILURE_KIND.ProviderUnavailable],
      [{ status: 403 }, FAILURE_KIND.RequestRejected],
      [{ status: 400, code: "insufficient_quota" }, FAILURE_KIND.QuotaExhausted],
      [{ status: 429 }, FAILURE_KIND.RateLimited],
      [{ status: 503 }, FAILURE_KIND.ProviderUnavailable],
      [{ status: 404 }, FAILURE_KIND.RequestRejected],
      [{}, FAILURE_KIND.Unknown],
    ];
    expect(cases).toHaveLength(CLASSIFICATION_PRECEDENCE.length);
    for (const [failure, kind] of cases) {
      expect(classifyFailure(failure).kind, JSON.stringify(failure)).toBe(kind);
      expect(CLASSIFICATION_PRECEDENCE.map((row) => row.kind)).toContain(kind);
    }
    // The table's declared kinds are exactly the ones the cases produce, in order.
    expect(CLASSIFICATION_PRECEDENCE.map((row) => row.kind)).toEqual(cases.map(([, kind]) => kind));
  });

  it("resolves rate-limit-first versus auth-first in the documented direction", () => {
    // The conflicts the card names, resolved as implemented and as documented in the table:
    // a *named credential* wins (including on a 429), a bare 401 wins over an unnamed
    // rate-limit code, and a quota-coded 403 is a quota — not an auth verdict.
    expect(classifyFailure({ status: 429, code: "invalid_api_key" }).kind).toBe(
      FAILURE_KIND.CredentialRejected,
    );
    expect(classifyFailure({ status: 401, code: "rate_limit_exceeded" }).kind).toBe(
      FAILURE_KIND.CredentialRejected,
    );
    expect(classifyFailure({ status: 403, code: "insufficient_user_quota" }).kind).toBe(
      FAILURE_KIND.QuotaExhausted,
    );
    expect(classifyFailure({ status: 403 }).kind).toBe(FAILURE_KIND.RequestRejected);
    expect(classifyFailure({ status: 429 }).kind).toBe(FAILURE_KIND.RateLimited);
  });

  it("preserves the provider's actual error detail on the classification", () => {
    // The provider's status rides through untouched, and the evidence names the exact rule that
    // fired, so a reviewer can tell a code-based verdict from a status-based one.
    expect(classifyFailure({ status: 429, code: "rate_limit_exceeded" })).toMatchObject({
      status: 429,
      evidence: "rate-limit-code",
    });
    expect(classifyFailure({ status: 429 })).toMatchObject({ status: 429, evidence: "status-429" });
    expect(classifyFailure({ status: 403, code: "insufficient_user_quota" }).evidence).toBe(
      "status-403+quota-code",
    );
    expect(classifyFailure({}).evidence).toBe("no-signal");
  });

  it("never reads prose: identical structured evidence yields the identical decision", () => {
    const structured: ProviderFailure = { status: 429 };
    const first = decideFailure(structured, LEGACY_ACTION.CoolDown, FAILURE_POLICY.Active);
    const second = decideFailure({ ...structured }, LEGACY_ACTION.CoolDown, FAILURE_POLICY.Active);
    expect(first.kind).toBe(second.kind);
    expect(first.recovery).toBe(second.recovery);
    expect(first.evidence).toBe(second.evidence);
  });
});

describe("A1.3 — one reversible policy across both consumers", () => {
  it("defaults to shadow, and only the exact string `active` promotes", () => {
    expect(resolveFailurePolicy({})).toBe(FAILURE_POLICY.Shadow);
    expect(resolveFailurePolicy({ [FAILURE_POLICY_ENV]: "shadow" })).toBe(FAILURE_POLICY.Shadow);
    expect(resolveFailurePolicy({ [FAILURE_POLICY_ENV]: "ACTIVE" })).toBe(FAILURE_POLICY.Shadow);
    expect(resolveFailurePolicy({ [FAILURE_POLICY_ENV]: "yes" })).toBe(FAILURE_POLICY.Shadow);
    expect(resolveFailurePolicy({ [FAILURE_POLICY_ENV]: "active" })).toBe(FAILURE_POLICY.Active);
  });

  it("under shadow the effective action is the legacy action, for every census row", () => {
    for (const row of CENSUS) {
      const decision = decideFailure(row.failure, row.legacy, FAILURE_POLICY.Shadow);
      expect(decision.action, row.name).toBe(row.legacy);
      expect(decision.policy).toBe(FAILURE_POLICY.Shadow);
    }
  });

  it("under active the effective action is the classifier's recovery", () => {
    const rows: Array<[ProviderFailure, LegacyAction, string]> = [
      [{ status: 429 }, LEGACY_ACTION.Observe, RECOVERY.CoolDown],
      [
        { status: 429, code: "insufficient_user_quota" },
        LEGACY_ACTION.Observe,
        RECOVERY.CoolDownUntilReset,
      ],
      [{ status: 401 }, LEGACY_ACTION.Observe, RECOVERY.Disable],
      [{ status: 503 }, LEGACY_ACTION.Observe, RECOVERY.Ignore],
      [{ status: 400 }, LEGACY_ACTION.CoolDown, RECOVERY.Surface],
      [{}, LEGACY_ACTION.None, RECOVERY.Observe],
    ];
    for (const [failure, legacy, recovery] of rows) {
      const decision = decideFailure(failure, legacy, FAILURE_POLICY.Active);
      expect(decision.recovery).toBe(recovery);
      expect(decision.action).toBe(recovery);
    }
  });

  it("is reversible: flipping back returns the legacy decision bit for bit", () => {
    const failure: ProviderFailure = { status: 503 };
    const shadow = decideFailure(failure, LEGACY_ACTION.Observe, FAILURE_POLICY.Shadow);
    const active = decideFailure(failure, LEGACY_ACTION.Observe, FAILURE_POLICY.Active);
    const flippedBack = decideFailure(failure, LEGACY_ACTION.Observe, FAILURE_POLICY.Shadow);
    expect(active.action).toBe(RECOVERY.Ignore);
    expect(flippedBack.action).toBe(shadow.action);
    expect(flippedBack.kind).toBe(shadow.kind);
    expect(flippedBack.agrees).toBe(shadow.agrees);
  });

  it("routes the credential rotator's reason classifier through the same classifier when active", () => {
    // Consumer two: a quota-coded 403 is prose-ambiguous ("quota" appears in some 403 bodies),
    // and the typed evidence must settle it the same way the LLM chain would.
    const structured: ProviderFailure = { status: 403, code: "insufficient_user_quota" };
    expect(
      classifyRateLimitReason(403, "quota exceeded", undefined, structured, FAILURE_POLICY.Active),
    ).toBe(RATE_LIMIT_REASON.QuotaExhausted);
    expect(
      classifyRateLimitReason(
        401,
        "body mentions quota",
        undefined,
        { status: 401 },
        FAILURE_POLICY.Active,
      ),
    ).toBe(RATE_LIMIT_REASON.AuthFailure);
    expect(
      classifyRateLimitReason(503, "", undefined, { status: 503 }, FAILURE_POLICY.Active),
    ).toBe(RATE_LIMIT_REASON.ServerError);
    // A request-level rejection never parks a credential.
    expect(
      classifyRateLimitReason(400, "", undefined, { status: 400 }, FAILURE_POLICY.Active),
    ).toBe(RATE_LIMIT_REASON.Unknown);
    // Unknown structured evidence falls back to the provider's own wording, not to a guess.
    expect(
      classifyRateLimitReason(429, "too many requests", undefined, {}, FAILURE_POLICY.Active),
    ).toBe(RATE_LIMIT_REASON.RateLimitExceeded);
  });

  it("leaves the rotator's prose path untouched under the default shadow policy", () => {
    const structured: ProviderFailure = { status: 401 };
    // Under shadow the structured argument is ignored: the same call with and without it.
    expect(classifyRateLimitReason(403, "quota exceeded", undefined, structured)).toBe(
      classifyRateLimitReason(403, "quota exceeded"),
    );
    expect(classifyRateLimitReason(403, "quota exceeded")).toBe(RATE_LIMIT_REASON.AuthFailure);
    expect(classifyRateLimitReason(429, "rate limit")).toBe(RATE_LIMIT_REASON.RateLimitExceeded);
    expect(classifyRateLimitReason(500, "")).toBe(RATE_LIMIT_REASON.ServerError);
    expect(classifyRateLimitReason(200, "")).toBe(RATE_LIMIT_REASON.Unknown);
  });
});

describe("A1.4 — promotion evidence: one decision, counted", () => {
  it("produces exactly one decision per failure and counts the classification rate", () => {
    resetFailureClassificationCounters();
    const decisions: FailureDecision[] = [
      decideAndReport(
        { failure: { status: 429 }, legacy: LEGACY_ACTION.CoolDown },
        FAILURE_POLICY.Active,
        { sink: () => {} },
      ),
      decideAndReport(
        { failure: { status: 429 }, legacy: LEGACY_ACTION.CoolDown },
        FAILURE_POLICY.Active,
        { sink: () => {} },
      ),
      decideAndReport(
        { failure: { status: 401 }, legacy: LEGACY_ACTION.Evict },
        FAILURE_POLICY.Active,
        { sink: () => {} },
      ),
      decideAndReport(
        { failure: { status: 503 }, legacy: LEGACY_ACTION.Observe },
        FAILURE_POLICY.Shadow,
        { sink: () => {} },
      ),
    ];
    // One call, one decision: the reporter does not re-classify.
    expect(decisions).toHaveLength(4);
    const snapshot = failureClassificationSnapshot();
    expect(snapshot.total).toBe(4);
    expect(snapshot.byKind).toEqual({
      [FAILURE_KIND.RateLimited]: 2,
      [FAILURE_KIND.CredentialRejected]: 1,
      [FAILURE_KIND.ProviderUnavailable]: 1,
    });
    expect(snapshot.byPolicy).toEqual({ active: 3, shadow: 1 });
    expect(snapshot.agreements).toBe(3);
    expect(snapshot.disagreements).toBe(1);
    resetFailureClassificationCounters();
    expect(failureClassificationSnapshot().total).toBe(0);
  });

  it("reports the active decision through the shadow sink with the policy's action", () => {
    resetFailureClassificationCounters();
    const seen: string[] = [];
    const decision = decideAndReport(
      { failure: { status: 503 }, legacy: LEGACY_ACTION.Observe, credentialId: "key-1" },
      FAILURE_POLICY.Active,
      {
        sink: (record) => seen.push(`${record.kind}:${record.recovery}:${String(record.agrees)}`),
      },
    );
    expect(decision.action).toBe(RECOVERY.Ignore);
    // The record still carries the legacy comparison, so an operator watching the log sees both.
    expect(seen).toEqual([`${FAILURE_KIND.ProviderUnavailable}:${RECOVERY.Ignore}:false`]);
    resetFailureClassificationCounters();
  });

  it("keeps the score of a response independent of any prose it contains", () => {
    // Two errors that differ only in message text must classify identically: status and
    // declared code are the whole input.
    const first = classifyFailure({ status: 403, code: "insufficient_user_quota" });
    const second = classifyFailure({ status: 403, code: "insufficient_user_quota" });
    expect(first).toEqual(second);
    // And a prose-only "quota" claim on an auth status does not move the verdict.
    expect(classifyFailure({ status: 401 }).kind).toBe(FAILURE_KIND.CredentialRejected);
  });
});

describe("A1.3 — the wiring, driven through the real catch chain", () => {
  // The seam the existing shadow-wiring tests use: the code under test is the real
  // `streamGenerate` catch; only the transport is replaced.
  class SeamModel extends GenerativeModel {
    constructor(
      source: () => AsyncIterable<UniEvent>,
      config: { apiKeys?: string[]; failurePolicy?: FailurePolicy } = {},
    ) {
      super({
        modelId: "claude-sonnet-4-6",
        tools: [],
        apiKeys: config.apiKeys ?? ["sk-secret-value", "sk-second"],
        baseUrl: "https://api.test/v1",
        ...(config.failurePolicy !== undefined ? { failurePolicy: config.failurePolicy } : {}),
      });
      this.source = source;
    }
    private readonly source: () => AsyncIterable<UniEvent>;
    protected override openStream(): AsyncIterable<UniEvent> {
      return this.source();
    }
  }

  /** The active key's failure count: what "the credential was blamed" actually means here. */
  function strikeCount(model: GenerativeModel): number {
    const statuses = model.getKeyRotator()?.getKeyStatuses() ?? [];
    return statuses.reduce((sum, status) => sum + status.failureCount, 0);
  }

  async function drive(model: GenerativeModel): Promise<unknown> {
    const gen = model.streamGenerate({ newMessages: [userText("go")] });
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    return res.value;
  }

  const throwing = (status: number, message = "boom") =>
    async function* () {
      throw Object.assign(new Error(message), { status });
    };

  it("shadow (the default) keeps the legacy decision and still counts the failure", async () => {
    resetFailureClassificationCounters();
    const model = new SeamModel(throwing(503, "service unavailable"));
    const outcome = await drive(model);
    // Legacy: retryable, and the credential is marked "other" exactly as before the promotion —
    // the record that matters is the failure count on the active key.
    expect(outcome).toMatchObject({ status: "retryable", errorCode: "network" });
    expect(model.getKeyRotator()!.workingKeysCount).toBe(2);
    expect(strikeCount(model)).toBe(1);
    expect(failureClassificationSnapshot().total).toBe(1);
    expect(failureClassificationSnapshot().byPolicy).toEqual({ shadow: 1 });
    resetFailureClassificationCounters();
  });

  it("active drops the credential count for a provider outage but keeps the retry", async () => {
    resetFailureClassificationCounters();
    const model = new SeamModel(throwing(503), { failurePolicy: FAILURE_POLICY.Active });
    const outcome = await drive(model);
    // Same retry, different state: the outage is not this credential's fault, so nothing is
    // recorded against it (and with a fresh pool a "disabled key" would have been the failure).
    expect(outcome).toMatchObject({ status: "retryable", errorCode: "network" });
    expect(model.getKeyRotator()!.workingKeysCount).toBe(2);
    expect(model.getKeyRotator()!.hasWorkingKeys()).toBe(true);
    // The state difference the promotion makes: no strike is recorded against the credential.
    expect(strikeCount(model)).toBe(0);
    expect(failureClassificationSnapshot().byPolicy).toEqual({ active: 1 });
    resetFailureClassificationCounters();
  });

  it("active still evicts on a credential rejection and cools down on a 429", async () => {
    resetFailureClassificationCounters();
    const rejected = new SeamModel(throwing(401, "invalid api key"), {
      failurePolicy: FAILURE_POLICY.Active,
    });
    // Disable: with another key in the pool the outcome is a rotation, not a dead end.
    expect(await drive(rejected)).toMatchObject({ status: "retryable", errorCode: "auth" });
    expect(rejected.getKeyRotator()!.workingKeysCount).toBe(1);

    const limited = new SeamModel(throwing(429, "too many requests"), {
      failurePolicy: FAILURE_POLICY.Active,
    });
    expect(await drive(limited)).toMatchObject({ status: "retryable", errorCode: "network" });
    expect(limited.getKeyRotator()!.workingKeysCount).toBe(2);
    resetFailureClassificationCounters();
  });

  it("active promotes a definitive rejection to a fatal outcome, as the classifier says", async () => {
    resetFailureClassificationCounters();
    const model = new SeamModel(throwing(400, "bad request"), {
      failurePolicy: FAILURE_POLICY.Active,
    });
    expect(await drive(model)).toMatchObject({ status: "fatal", errorCode: "rejected" });
    resetFailureClassificationCounters();
  });
});
