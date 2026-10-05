# A1 — Promote the typed failure classifier (2026-10-02)

## Scope

One package, both consumers the card names: the LLM error chain
(`packages/core/src/llm/generative-model.ts` + the `GenerativeModelConfig` field in
`packages/core/src/interfaces/llm.ts`) and the credential rotator's reason classifier
(`packages/core/src/fleet/credential-rotation.ts`), with the decision machinery in
`packages/core/src/fleet/provider-gateway.ts` and its exports in `packages/core/src/fleet/index.ts`.

The card's "shadow corpus" is the fixture census below: this repository has no release log to
freeze, and the card allows fixtures when they demonstrate coverage. What it does *not* allow is a
silent corpus, so the census is hashed and each divergence is enumerated with its owner.

## Baseline

| Observable | Before |
| ---------- | ------ |
| selector | none — the classifier could only report (`observeFailure`), shadow was the only state |
| decision surface | two vocabularies in one record (`legacy` + `recovery`), no single action a call site could obey |
| precedence | implied by `classifyFailure`'s if-order, documented in prose in the module header |
| rotator reason | `classifyRateLimitReason` reads the body as prose (`text.includes("quota")`), with no way to accept structured evidence |
| measurement | "no counter is incremented and nothing is exported" (the shadow release's deliberate choice) — fine before promotion, insufficient after it |

## Change

1. **Selector (A1.3, reversible).** `FAILURE_POLICY` (`shadow` | `active`), `FAILURE_POLICY_ENV`
   (`PENGUIN_FAILURE_CLASSIFIER`) and `resolveFailurePolicy(env)` — only the exact string `active`
   promotes; anything else (including a typo) stays `shadow`. `GenerativeModel` freezes the
   resolved policy at construction and also accepts an explicit `failurePolicy`.
2. **One decision (A1.4).** `decideFailure(failure, legacy, policy)` returns a `FailureDecision`
   carrying both vocabularies and the single `action` the caller obeys — the legacy action under
   `shadow` (so the pre-promotion branch is reproduced exactly), the classifier's recovery under
   `active`. `decideAndReport` adds the counters and the one log line; the sink record is unchanged
   in shape, so an operator watching `agrees=false` sees the same evidence as before.
3. **Counters (A1.4).** `failureClassificationSnapshot()` / `resetFailureClassificationCounters()`
   report totals by kind, by action, by policy, and the agreement/disagreement split — the
   classification rate the card asks to monitor.
4. **Precedence as data (A1.2).** `CLASSIFICATION_PRECEDENCE` is the typed table (ten rows), each
   asserted against `classifyFailure` by the new suite. The resolution it states:
   **a named credential wins** (a declared credential code on any status, or a bare 401), then the
   ambiguous 403 is disambiguated by code (quota → quota, capacity → provider unavailable, bare →
   request), then quota, then rate limit, then capacity/5xx/408, then other 4xx, then `unknown`.
   Provider detail (`status`, and the evidence token naming the rule that fired) rides the result.
5. **Both consumers wired.** The real catch chain derives the legacy action from the existing
   exported predicates (`legacyProviderAction`) and dispatches on `decision.action` — one decision
   per failure, no prose consulted. The one state change the promotion introduces: under `active`,
   the classifier's `ignore` means a provider outage is **not** recorded against the credential
   (the pre-promotion `else` branch counted every 5xx against the key). `shadow` never returns
   `ignore`, so nothing changes there. `classifyRateLimitReason` gains an optional
   `(structured, policy)` pair: under `active` with structured evidence it maps the typed kind
   (`rate_limited` → `RateLimitExceeded`, `quota_exhausted` → `QuotaExhausted`,
   `credential_rejected` → `AuthFailure`, `provider_unavailable` → `ServerError`,
   `request_rejected` → `Unknown`), and falls back to the prose port only for `unknown`.

## Acceptance — evidence

### A1.1 — the census (hashed)

`decisionCorpusHash(CENSUS) === "ada6536ebea92dd2"` — 15 frozen rows, each naming its owning
decision. Divergent rows (the only ones where the classifier's implied action differs from the
legacy action), each with its reason in the fixture:

| # | row | kind | legacy | classifier recovery | owning decision / reason |
| - | --- | ---- | ------ | ------------------- | ------------------------ |
| 1 | `500` | `provider_unavailable` | observe | ignore | **intentional**: the provider is down; the old `else` counted it against the key |
| 2 | `503` | `provider_unavailable` | observe | ignore | same, pinned separately so a 502-only regression is visible |
| 3 | `overloaded_error` type | `provider_unavailable` | observe | ignore | capacity with no status code; the vocabulary refuses to blame the key |

Thirteen further rows agree at the action level, including the shapes that look divergent by name:
a bare 403 (legacy fatal-rejection `none`, classifier `request_rejected` → both leave the
credential alone), a network drop with no status (`unknown` → observe), and the quota-coded 403
that must never become an auth verdict.

### A1.2 — precedence, asserted against the table

Ten table rows, ten cases, in order: `credential code on a 429` → `credential_rejected`;
`bare 401` → `credential_rejected`; `403 + insufficient_user_quota` → `quota_exhausted`;
`403 + model_capacity_exhausted` → `provider_unavailable`; `bare 403` → `request_rejected`;
`400 + insufficient_quota` → `quota_exhausted`; `429` → `rate_limited`; `503` →
`provider_unavailable`; `404` → `request_rejected`; `{}` → `unknown`. The non-rate-limit classes
are distinct from `rate_limited` in every row (the card's acceptance), and prose is never an input:
two errors differing only in message text classify identically.

### A1.3 — wiring, driven through the real catch chain

| case | policy | outcome | credential state |
| ---- | ------ | ------- | ---------------- |
| 503 (`service unavailable`) | shadow (default) | retryable/network | marked `other` — pre-promotion behaviour |
| 503 | active | retryable/network | **not** marked; both keys still working |
| 401 (`invalid api key`) | active | retryable/auth (rotation) | key evicted, one key left |
| 429 | active | retryable/network | rate-limit path, both keys working |
| 400 | active | fatal/rejected | untouched |

Reversibility is asserted directly: `decideFailure` under `active` then back under `shadow` returns
the legacy action, kind and agreement bit-for-bit; the env resolver rejects `ACTIVE` and `yes`.

### A1.4 — promotion evidence

One decision per failure (the reporter does not re-classify), counted: after four failures the
snapshot reports 2× `rate_limited`, 1× `credential_rejected`, 1× `provider_unavailable`,
`byPolicy {active: 3, shadow: 1}`, and the agreement split. No credential ever appears in a record
(pinned by the pre-existing shadow tests, unchanged).

## Verification

```
node ../../node_modules/vitest/vitest.mjs run test/fleet/ test/llm/ test/engine/
→ Test Files 38 passed (38) | Tests 906 passed (906)

node ../../node_modules/vitest/vitest.mjs run   (whole core package)
→ Test Files 1 failed | 267 passed | 2 skipped (270)
  Tests 4 failed | 5126 passed | 6 skipped (5136)
  the only failures are the pre-existing `test/command-policy.test.ts` Windows
  counterparts (Wave-1 work owns them), unrelated to this change
```

New suite `packages/core/test/fleet/classifier-promotion.test.ts` (20 cases:
census hash + enumeration, precedence table, policy resolution/reversibility, rotator mapping,
counters, and four end-to-end drives of the real catch chain).

Mutations (each applied alone and reverted; a run that reuses a warm transform cache can hide a
kill, so the surviving-looking rows below were each re-checked in a fresh single-file run):

| Mutation | Result |
| -------- | ------ |
| `resolveFailurePolicy` always returns `active` | 2 failed |
| active mode still returns the legacy action (`decideFailure`) | 3 failed |
| the rotator never consults structured evidence | 1 failed |
| disagreements never counted | 1 failed |
| the LLM chain hardcodes the legacy action to `observe` | 1 failed |
| the cool-down dispatch loses the legacy `cool_down` case | 4 failed |
| `ignore` still records a strike against the credential | 1 failed |

One regression this battery was written to catch, and did: an edit intended to drop a
tautological comparison in the dispatch condition silently removed the whole `cool_down` arm, so
every 429 took the fallback branch (retryable, no cooldown, no rotation). `test/llm.test.ts`'s four
rotation/cooldown cases caught it — they are the reason the LLM chain is exercised by the full
suite, not just the new one. The fixture that made the two `ignore`-related kills possible asserts
the credential's failure *count*, not just its key count: `recordFailure(key, "other")` leaves the
pool size unchanged, so a weaker assertion would have let both mutations survive.

`tsc --noEmit -p packages/core/tsconfig.json` clean; `prettier --check` clean on the touched files.

## Compatibility

- Default is `shadow`: every existing caller behaves exactly as before, including the rotator's
  prose path (pinned: the structured argument is ignored under `shadow`) and the key marking for
  5xx (pinned through the real catch chain).
- `ObserveFailure`/`ShadowRecord` are unchanged, so existing log consumers keep working; the new
  counters are additive and process-wide with an explicit reset.
- No new dependency: `provider-gateway.ts` still imports nothing (the corpus fingerprint is an
  inline FNV-1a, not `node:crypto`).

## Residual work

- The shadow release window over **real** traffic has not run (no release logs exist in the repo);
  the census is fixture-based per the card's allowance, and the three enumerated divergences are
  the ones a window would have to confirm.
- `WeightedKeyRotator` and `KeyFleetMonitor` remain un-wired (the card names two consumers; those
  are separate classes with their own indexes) — a follow-up, noted here so the gap is visible.
- `K4` (self-diagnosing failure mode) depends on A1 and can now consume `decideFailure`'s result.
