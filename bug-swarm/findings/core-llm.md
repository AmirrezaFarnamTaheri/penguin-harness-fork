# Bug-swarm findings — `core-llm` (`packages/core/src/llm/`)

Read-only finder pass over `context-limits.ts`, `generative-model.ts` (the quota/key-rotation
paths), `key-fleet-monitor.ts`, `key-rotator.ts`, `list-models.ts`, `model-combos.ts`,
`pricing-catalog.ts`, `proxy-pool.ts`, `quota-parser.ts`, `tool-call-ids.ts`,
`tool-call-repair.ts`, and `speculative/` (draft-acceptance, parallel-speculator,
speculative-rollback, token-throughput-tracker, index), plus their tests.

Every behavioural claim below was either executed against the real module (probe harness through
vitest) or is a direct reading of the quoted lines. Two pre-existing test files already cover
this surface and pin several of the hazards as documented behaviour:
`packages/core/test/llm/quota-parser.test.ts` and `packages/core/test/pricing-catalog.test.ts`
(the latter prescribed by `bug-swarm/findings/tests.md:104`). Where a hazard is already pinned,
that is noted rather than re-reported as new.

---

### [MEDIUM] `resolve()` fuzzy fallback lands a short model id on the wrong tier — or on a zero-priced entry

Location: `packages/core/src/llm/pricing-catalog.ts:194-199`

The fallback is a symmetric substring test with no length or boundary guard, and `find` returns
the first catalog entry that matches. A provider/model pair that misses the exact pass is priced
by substring containment alone, so a short or fragmentary `modelId` silently resolves to an
unrelated — usually cheaper — tier, and even to the zero-priced experimental Gemini entry. Since
`calculateCost` reports `priced: true` for that entry, a billable request surfaces as a real
`$0.00` rather than as "unknown". Verified by probe: `resolve("google", "2.0")` returns
`gemini-2.0-flash-thinking-exp` (0.0/0.0), and `calculateCost("google", "2.0", …)` returns
`{priced: true, totalCost: 0}`; `resolve("openai", "o")` returns `gpt-4o` at $2.50/$10 rather than
`o1` at $15/$60. The live `POST /cost` endpoint (`packages/server/src/http/routes/gateway.ts:293`)
takes `provider`/`modelId` straight off the request body, so this is reachable over HTTP.

```ts
    return DEFAULT_PRICING_CATALOG.find(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() &&
        (modelId.toLowerCase().includes(entry.modelId.toLowerCase()) ||
          entry.modelId.toLowerCase().includes(modelId.toLowerCase())),
    );
```

Verdict: CONFIRMED. The quoted code is exactly what executes, and the outcomes above were
observed by running it. `packages/core/test/pricing-catalog.test.ts:72-115` already pins each of
these cases as "documented, not endorsed", so this is a known-and-pinned hazard rather than an
oversight — but nothing on the read path guards a caller against it.

---

### [MEDIUM] `calculateCost` applies no bounds to token counts, so negatives and NaN poison the breakdown

Location: `packages/core/src/llm/pricing-catalog.ts:218-237`

Every token field is multiplied straight through. A negative count produces a negative cost
component (and a `totalCost` that no longer means "spend"); a `NaN` propagates into
`promptCost`/`totalCost`/`savingsFromCache`, which JSON-serialise as `null` — a field declared
`number` in `CostBreakdown` silently carrying `null`. Verified by probe:
`calculateCost("openai","gpt-4o",{promptTokens:-1e6,completionTokens:1e6})` → `promptCost: -2.5,
totalCost: 7.5`; the same call with `promptTokens: NaN` → `totalCost: null`. The arithmetic
itself is not wrong; the gap is that a cost figure is derived from unvalidated input.

```ts
    const promptTokens = usage.promptTokens;
    const completionTokens = usage.completionTokens;
    const reasoningTokens = usage.reasoningTokens ?? 0;
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

    const promptCost = (promptTokens / 1_000_000) * pricing.promptPerMillion;
```

Verdict: CONFIRMED. The numbers above come from executing the function. Severity is held to
MEDIUM rather than HIGH because the only live caller guards at the boundary:
`tokenCount()` in `packages/server/src/http/routes/gateway.ts:65-72` rejects anything that is not
a non-negative safe integer, so the endpoint cannot be driven into these states. The class API
itself is unguarded.

---

### [MEDIUM] `DetailedUsageCounts` is five additive buckets, while the runtime's own token convention is three — the mapping is unspecified and double-counting is easy

Location: `packages/core/src/llm/pricing-catalog.ts:15-21`, `218-237`

`totalCost` is a plain sum of five independently priced buckets, and `savingsFromCache` assumes
`promptTokens` are the *uncached* input only (`fullUncachedCost` adds `cacheReadTokens` back in
as if they were prompt tokens). But the runtime's token shape is three buckets —
`usageToTokenCounts` (`packages/core/src/llm/generative-model.ts:260-273`) returns
`cache_read = cached_tokens`, `cache_write = prompt_tokens`, `output = thoughts + response`, and
`packages/core/src/state/model-catalog.ts:24-29` documents that three-bucket convention as the
single source of truth. Nothing in the repo defines how those three map onto these five, and
every plausible mapping is wrong somewhere: passing total input as `promptTokens` (the shape
`packages/web/src/features/traces/trace-ingest.ts:98-100` builds for display) bills the cached
tokens once at the prompt rate and again at the cache-read rate; passing reasoning tokens that
are already inside `completionTokens` (OpenAI's `completion_tokens_details` convention) bills
them twice.

```ts
export interface DetailedUsageCounts {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

Verdict: PLAUSIBLE. The additive sum and the three-vs-five mismatch are confirmed by reading;
no in-repo caller currently double-bills — the web client prices its live estimate through a
separate `bucketCostUsd` on the three-bucket shape, and the `/cost` endpoint receives the five
fields directly from its request body. The hazard is a contract gap that the first caller to
translate buckets will hit, not a present mis-billing.

---

### [LOW] Catalog provider keys disagree with `PROVIDER_ALIASES` canonical names, so an alias-normalised lookup prices nothing

Location: `packages/core/src/llm/pricing-catalog.ts:148-164` vs `packages/core/src/llm/model-combos.ts:162-175`

`normalizeProvider` maps `kimi → moonshotai`, `qwen → alibaba`, `glm → zai`, `gemini → google`,
but the catalog keys those providers as `kimi`, `qwen`, `xai`, `ollama`, `local`. Both resolve
passes require the provider string to match a catalog provider, so a caller that normalises first
gets `undefined` and an unpriced result for a model the catalog does list. Verified by probe:
`resolve("moonshotai", "moonshot-v1-8k")` returns `undefined` while `resolve("kimi",
"moonshot-v1-8k")` returns the $1.20/$1.20 entry.

```ts
  { provider: "kimi", modelId: "moonshot-v1-8k", promptPerMillion: 1.2, completionPerMillion: 1.2 },
  {
    provider: "kimi",
    modelId: "moonshot-v1-32k",
    promptPerMillion: 2.4,
    completionPerMillion: 2.4,
  },
  { provider: "kimi", modelId: "kimi-k1.5", promptPerMillion: 1.5, completionPerMillion: 4.5 },
```

Verdict: CONFIRMED. The divergence is between two static tables and was observed by execution.
Rated LOW because it is latent: `PricingCatalog` has no production caller that normalises the
provider (`normalizeProvider` is used only inside `model-combos.ts` and by its own tests), and
`/cost` takes the provider verbatim from the request body. It becomes a real gap the moment a
caller routes pricing through the alias table.

---

### [MEDIUM] Two rate-limit classifiers with disjoint wordings: the runtime and the cascade disagree about the same error

Location: `packages/core/src/llm/generative-model.ts:884-910` vs `packages/core/src/llm/quota-parser.ts:27-39`

`isRateLimitError` is what `GenerativeModel` uses to decide retryability and to cool a key
(`generative-model.ts:1380-1386` → `keyRotator.recordFailure(activeKey, "rate_limit")`).
`detectQuotaExhaustion` is what the combo cascade reads (`model-combos.ts:61-64` →
`shouldTriggerFallback`). Their tables are not subsets of each other: the spaced phrase "rate
limit" and the codes `rate_limit` / `requests_exceeded` / `tokens_exceeded` exist only in
`isRateLimitError`, while "usage limit reached", "tokens per minute", "requests per minute",
"requests per day" and "exceeded your current quota" exist only in `QUOTA_PATTERNS`. So a
provider sending "Usage limit reached" is treated as a generic network error by the runtime —
the key is never cooled, so rotation keeps handing it back — while the cascade sees no quota
failure at all; and "Rate limit exceeded" (spaced) is retryable per the runtime but
`isQuota: false` per the cascade, as `packages/core/test/llm/quota-parser.test.ts:259-268` pins.

```ts
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  "rate_limit_exceeded",
  "resource_exhausted",
  "rate_limit",
  "insufficient_quota",
  "requests_exceeded",
  "tokens_exceeded",
]);
```
```ts
const QUOTA_PATTERNS = [
  /RESOURCE_EXHAUSTED/i,
  /rate_limit_exceeded/i,
  /quota_exceeded/i,
  /insufficient_quota/i,
  /too many requests/i,
  /\b429\b/,
  /exceeded your current quota/i,
  /usage limit reached/i,
  /tokens per minute/i,
  /requests per minute/i,
  /requests per day/i,
];
```

Verdict: CONFIRMED. Both tables were read in full and the set differences are as stated; the
"Rate limit exceeded" asymmetry is already pinned by the existing quota-parser test. The
*consequence* (an exhausted key never being cooled) is PLAUSIBLE — it follows from the table gap
plus the `recordFailure(activeKey, "rate_limit")` call only for wording that reaches that branch,
but no test exercises the end-to-end rotation path for those wordings.

---

### [LOW] `extractCode` reads only top-level status keys, so a nested provider envelope classifies by text but reports no code

Location: `packages/core/src/llm/quota-parser.ts:100-105`

Many providers nest the status inside an `error` object (`{ "error": { "code":
"rate_limit_exceeded", "message": "…" } }`). Such a body is classified correctly, because the
whole object is JSON-stringified and the text patterns match; but `code` is looked up only at the
top level, so the result carries no `code`. Verified by probe:
`detectQuotaExhaustion({ error: { code: "rate_limit_exceeded", message: "too many requests" } })`
returns `isQuota: true` with no `code` field.

```ts
function extractCode(input: unknown): number | string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const code = record.code ?? record.status ?? record.statusCode;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}
```

Verdict: CONFIRMED. The probe output shows the classification with an absent `code`. Consumers
that switch on `result.code` (rather than on the boolean flags) silently see "unknown" for the
most common provider error shape.

---

### [LOW] `detectQuotaExhaustion` throws on circular input instead of returning a non-quota verdict

Location: `packages/core/src/llm/quota-parser.ts:108-113`

A non-string, non-`Error` object is scanned via `JSON.stringify(input ?? "")`. A circular
structure makes that call throw `TypeError`, so the classifier — which every other input shape
handles by returning a result — propagates an exception into the caller's error path. Verified
by probe: a self-referencing object raises `TypeError: Converting circular structure to JSON`.
Fetch/SDK errors that keep a reference to the request or response can carry such cycles.

```ts
  const text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? `${input.name}: ${input.message}`
        : JSON.stringify(input ?? "");
```

Verdict: CONFIRMED. The throw was observed. Rated LOW because the documented contract is a
verdict per input, not a throw, and the inputs that reach it in practice are strings and
`Error`s.

---

### [LOW] A genuine zero reset window is falsy, so "resets now" is replaced by the 60s default

Location: `packages/core/src/llm/quota-parser.ts:146-180`

When a quota message carries an explicit window that parses to `0` ("Resets in 0h0m0s"), the code
sets `resetText` and `resetMs = 0`, then `if (!resetMs)` treats that as "no window found" and
falls through to the 60s default. `parseResetDuration` deliberately distinguishes 0 from
undefined (pinned at `packages/core/test/llm/quota-parser.test.ts:37-43`), but the detection path
conflates them again. Verified by probe:
`detectQuotaExhaustion("quota_exceeded. Resets in 0h0m0s")` returns `resetMs: 60000, resetText:
"60s"`. A provider reporting an already-expired limit therefore produces a backoff 60s longer
than the one it asked for.

```ts
  const resetMatch = RESET_DURATION_RE.exec(text);
  if (resetMatch?.[1]) {
    resetText = resetMatch[1];
    resetMs = parseDurationToMs(resetText);
  }

  if (!resetMs) {
    const retryAfterMatch = RETRY_AFTER_RE.exec(text);
```

Verdict: CONFIRMED by execution. The same falsy check absorbs `retry-after: 0` and
`reset_after: 0` (both probed → `resetMs: 60000`), which is defensible for a bare zero, but for a
window the provider spelled out explicitly the information is discarded.

---

### [LOW] `parseResetDuration` returns seconds, not milliseconds, and has no caller in the repo

Location: `packages/core/src/llm/quota-parser.ts:21-25`

The sibling `parseDurationToMs` (lines 72-84) returns milliseconds for the same h/m/s grammar;
`parseResetDuration` returns seconds. It is not exported from the barrel (`index.ts:66` exports
`detectQuotaExhaustion`, `parseDurationToMs`, `formatDurationMs` only) and the only references in
the repo are its own test. A name that differs from its sibling only in the unit it returns is a
trap for the first caller that wires it into a millisecond countdown.

```ts
export function parseResetDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
```

Verdict: CONFIRMED — the unit difference is in the quoted arithmetic, and a repo-wide search
found no caller outside `test/llm/quota-parser.test.ts`. The existing test header documents the
unit split, so callers of that test file are warned.

---

### [LOW] `slimModelCatalog` drops every model that shares a base id, and which one survives is decided by sort order

Location: `packages/core/src/llm/model-combos.ts:215-231`

`baseModelId` strips the vendor prefix and the `:tag` suffix, and the loop keeps the first entry
per base id. That is a deliberate dedup for `openai/gpt-4o` vs `gpt-4o`, but "first" is whatever
`localeCompare` orders first, not a preferred source — so for two gateway listings of the same
base id with different metadata, the survivor depends on the string sort, and the other is
dropped with no record of it. A bare trailing slash makes this worse: `baseModelId("openai/")`
returns `""` (see the next finding), and such an entry collides on the empty key.

```ts
    for (const [modelId, model] of Object.entries<any>(rawModels).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const id = baseModelId(modelId);
      if (models[id] !== undefined) continue;
```

Verdict: PLAUSIBLE. The dedup and its sort-dependence are confirmed by reading; whether two
real catalog entries collide depends on the catalog contents, which this pass did not exercise
against live data.

---

### [LOW] `baseModelId` returns the empty string for an id that ends in a separator

Location: `packages/core/src/llm/model-combos.ts:182-185`

`"openai/".split("/").pop()` is `""`, and `"".split(":")[0]` is `""`, so the empty string becomes
a model id. It then keys `models[""]` in `slimModelCatalog` and can be returned to a caller
asking for a model list. `!` asserts the result is non-undefined, which is true, but it is the
empty string rather than a usable id.

```ts
export function baseModelId(modelId: string): string {
  const withoutVendor = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return withoutVendor.toLowerCase().split(":")[0]!;
}
```

Verdict: CONFIRMED by reading the two-line function. Rated LOW: the input has to be malformed,
and no catalog in the repo writes such an id.

---

### [MEDIUM] `nextKey`'s documented fallback does not exist: all keys cooling returns `undefined`, not the earliest expiry

Location: `packages/core/src/llm/key-rotator.ts:172-204`

The JSDoc for `nextKey` states "If all working keys are currently in cooldown, falls back to the
one with the earliest cooldown expiry." The code does no such thing: the round-robin scan only
accepts keys with `cooldownUntil <= now`, and when none qualify it falls through to an explicit
`return undefined`. The inline comment two lines below the docstring describes the real behaviour
correctly, so the contract a caller reads and the contract the code keeps are opposite. A caller
written against the docstring (expecting always-a-key) will pass `undefined` into a key lookup
instead of waiting out the cooldown. `getEarliestAvailableTime`/`getEarliestCooldownMs` exist
precisely to support the waiting strategy the docstring describes.

```ts
   * 1. Filters for keys that are not permanently failed and not currently in cooldown.
   * 2. If all working keys are currently in cooldown, falls back to the one with the earliest cooldown expiry.
   * 3. Returns undefined if all keys have permanently failed or if no keys are configured.
   */
  nextKey(now: number = Date.now()): string | undefined {
    if (this.keys.length === 0) return undefined;
    const workingKeys = this.keys.filter((k) => !k.isFailed);
    if (workingKeys.length === 0) return undefined;

    const len = this.keys.length;

    // Search round-robin starting from currentIndex + 1
    for (let i = 1; i <= len; i++) {
      const idx = (this.currentIndex + i) % len;
      const candidate = this.keys[idx];
      if (candidate && !candidate.isFailed && candidate.cooldownUntil <= now) {
```

Verdict: CONFIRMED. The docstring and the implementation are both quoted and they contradict each
other; the fallthrough at line 203-204 is `return undefined`. Fix the docstring, not the code —
the "wait for cooldown" behaviour is what `getEarliestCooldownMs` is for.

---

### [LOW] `updateKeys` leaves `leasedKey` pointing at a KeyStatus that may no longer be in the pool

Location: `packages/core/src/llm/key-rotator.ts:339-362`

`updateKeys` rebuilds `this.keys` (preserving existing `KeyStatus` references by raw key) and
resets `currentIndex = -1`, but never clears `this.leasedKey`. If the leased key was dropped from
the new set, the next `nextKey` decrements a detached key's `activeLeases` (line 194) — a number
`activeLeases` no longer sums over — and `allocateSubagentRotator`'s lease count leaks until
`releaseLease`. Newly added keys are also pushed without an `activeLeases` field (lines 351-357),
so the field is `undefined` until first leased.

```ts
    this.keys.length = 0;
    for (const key of newKeys) {
      const existing = existingMap.get(key);
      if (existing) {
        this.keys.push(existing);
      } else {
        this.keys.push({
          key,
          isFailed: false,
          cooldownUntil: 0,
          successCount: 0,
          failureCount: 0,
        });
      }
    }
    this.currentIndex = -1;
```

Verdict: CONFIRMED that `leasedKey` is untouched here while `this.keys` is rebuilt; the leak
consequence is PLAUSIBLE (it needs a key-set change while a subagent lease is held, which no test
in this pass exercised).

---

### [MEDIUM] `maskApiKey` collides for every key of 8 characters or fewer, and mask-based lookups then resolve to the last such key

Location: `packages/core/src/llm/key-fleet-monitor.ts:93-99` and `172-182`

`maskApiKey` returns the fixed string `"key-***"` for any key up to 8 characters, and for a
9-character key reveals 8 of its 9 characters (`min(7, floor(9/2))` = 4 prefix + 4 suffix).
`registerProvider` keys `keyByMask` by that mask with last-write-wins, so a model with two short
keys has one mask entry pointing at the second key, and every mask-based operation —
`probeKey`, `reviveKey`, `cooldownKey`, `evictKey`, `hasKey` — silently targets the wrong key
when given the mask. Two 9-character keys from different providers can collide the same way.

```ts
export function maskApiKey(key: string): string {
  if (!key) return "empty-key";
  if (key.length <= 8) return "key-***";
  const prefix = key.slice(0, Math.min(7, Math.floor(key.length / 2)));
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}
```
```ts
    reg.keys.forEach((k, index) => {
      const baseKeyId = `${provider}-key-${index + 1}`;
      const keyId = this.hasKeyIdInOtherModels(baseKeyId, modelRef)
        ? `${provider}-${modelId.replace(/[^a-zA-Z0-9_-]/g, "-")}-key-${index + 1}`
        : baseKeyId;
      const masked = maskApiKey(k);
      const entry = { keyId, maskedKey: masked, rawKey: k };
      keyById.set(keyId, entry);
      keyByMask.set(masked, entry);
      rawToId.set(k, keyId);
    });
```

Verdict: CONFIRMED. The collision is deterministic in the quoted code (identical mask strings
under a `Map.set`), and the mask is one of the two documented lookup keys for the fleet's
key-targeted operations. Real provider keys are long enough that this is rare, but a test fixture
or a local gateway token of 8 characters hits it.

---

### [LOW] `probeFleet` awaits each key probe in sequence, so one hung probe stalls the whole sweep

Location: `packages/core/src/llm/key-fleet-monitor.ts:324-334`, `572-578`

`probeFleet` iterates every key of every model and `await`s each probe before starting the next,
with no per-probe timeout. `startAutoProbing` puts that whole sweep on an interval with no
deadline, so a single unresponsive endpoint blocks the sweep (and, since `notifyListeners` runs
only after the loop, blocks fleet health updates) until it resolves. The probes are independent
per key — the same independence `runBatchRound` exploits in `parallel-speculator.ts:380-386`.

```ts
  public async probeFleet(): Promise<KeyProbeResult[]> {
    const results: KeyProbeResult[] = [];
    for (const [ref, meta] of this.modelMeta) {
      for (const keyId of meta.keyById.keys()) {
        const res = await this.probeKey(ref, keyId);
        results.push(res);
      }
    }
    this.notifyListeners();
    return results;
  }
```

Verdict: CONFIRMED by reading — the sequential `await` inside the nested loop is unbounded by any
timeout in this module or in `startAutoProbing`.

---

### [LOW] `recordSuccess` throws on a bad latency while every sibling tolerates bad input

Location: `packages/core/src/llm/proxy-pool.ts:321-343`

`recordSuccess` validates its `latencyMs` and throws on non-finite or negative values. Nothing
else in the pool throws on bad input: `recordFailure` silently ignores an unknown id,
`addProxies` silently skips malformed URLs, `getNextProxy` returns `undefined` when no candidate
qualifies. A recorder that can throw turns a telemetry callback into a failure path in the
caller, and the asymmetry is invisible from the type (`void`).

```ts
  public recordSuccess(idOrUrl: string, latencyMs: number): void {
    const entry = this.findProxyEntry(idOrUrl);
    if (!entry) return;
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new Error("Proxy latency must be a non-negative finite number");
    }
```

Verdict: CONFIRMED — the throw is in the quoted code, and the siblings' silent tolerances are
visible in the same file. Whether the strictness is desirable is a judgement call; the
inconsistency is the finding.

---

### [LOW] An auth failure marks a proxy dead for `deadCooldownMs * 6`, an unconfigurable magic factor

Location: `packages/core/src/llm/proxy-pool.ts:359-363`

A rate-limited proxy cools for exactly `rateLimitCooldownMs` and an exhaustion proxy for
`deadCooldownMs`. An auth failure alone multiplies the dead cooldown by 6 with no option, no
constant name, and no comment explaining the factor — so a caller that sets `deadCooldownMs:
600_000` gets an hour for a 401 from a rotating credential. The status is `"dead"` in both cases,
so nothing downstream distinguishes them either.

```ts
    if (options.isAuthFailure) {
      entry.status = "dead";
      entry.cooldownUntil = Date.now() + this.deadCooldownMs * 6;
      return;
    }
```

Verdict: CONFIRMED by reading. `ProxyPoolOptions` (lines 41-48) exposes every other cooldown but
this one.

---

### [LOW] `importEntries` trusts the stored `url` as the map key instead of re-canonicalising

Location: `packages/core/src/llm/proxy-pool.ts:465-478`

`addProxy` keys the pool by `parseProxyUrl(rawUrl).canonicalUrl`, but `importEntries` keys by
`source.url` verbatim. An imported entry whose stored url is not the canonical spelling (a
missing explicit standard port, an un-bracketed IPv6 host, a mixed-case scheme) therefore does
not merge with a later `addProxy` of the same proxy, and the pool holds two entries for one
destination — each with its own health, latency and lease counters, and `getStats` counting it
twice.

```ts
  public importEntries(entries: ProxyEntry[]): void {
    for (const source of entries) {
      if (!source?.url) continue;
      const entry: ProxyEntry = {
        ...source,
        weight: normalizeWeight(source.weight),
        auth: source.auth ? { ...source.auth } : undefined,
        tags: Array.isArray(source.tags) ? [...source.tags] : [],
      };
      this.proxies.set(entry.url, entry);
```

Verdict: PLAUSIBLE. The two keying strategies are confirmed by reading; the duplicate requires a
non-canonical stored url, which depends on whatever wrote the export.

---

### [LOW] An image payload's text parts are uncounted, under-estimating input in the direction the module calls unsafe

Location: `packages/core/src/llm/context-limits.ts:158-172`

`approximateMessagesTokens` gives an image payload a flat `IMAGE_TOKEN_ESTIMATE` and returns,
without estimating the text that rides in the same payload. The module's own invariant (lines
129-133) is that the character heuristic errs *high*, because a low input estimate inflates the
derived output cap and risks the provider 400 the margin exists to avoid. A multimodal message
with a long text part alongside the image is counted as 1600 tokens regardless of its text, so
the estimate errs low precisely for the inputs the margin was sized against.

```ts
  for (const msg of messages) {
    const p = msg.payload as { type?: string; images?: unknown };
    if (p.type === "image_url" || p.type === "inline_data") {
      total += IMAGE_TOKEN_ESTIMATE;
    } else if (Array.isArray(p.images)) {
```

Verdict: PLAUSIBLE. The branch is confirmed; whether a payload of `type === "image_url"` also
carries a counted text part depends on the OmniMessage shapes this pass did not enumerate
end-to-end. The `images`-array branch handles the tool-output shape correctly by serialising
`rest`; this branch is the one that skips text.

---

### [MEDIUM] `report().speedup` is computed with a hardcoded window of 4, ignoring the window the rounds actually used

Location: `packages/core/src/llm/speculative/token-throughput-tracker.ts:162-165`, `178-185`

`report()` calls `this.speedup(acceptanceRate)`, whose `gamma` defaults to 4, so the headline
speedup figure always assumes γ=4. `record()` receives the real window per round as
`metrics.proposed` and never threads it into the model. Verified by probe: a tracker fed rounds
with `proposed: 8, accepted: 8` (acceptance rate 1.0, γ=8) reports `speedup: 2.0833` — that is
`(1+4)/(1+4·0.35)`, the γ=4 figure — while `speedup(1, 8)` on the same instance returns `2.368`.
Any deployment running a window other than 4 reports a speedup that is not its own, in either
direction.

```ts
      tokensPerSecond: this.verifyTimeNs > 0 ? (this.committed / this.verifyTimeNs) * 1e9 : 0,
      meanVerifyLatencyNs: meanLatency,
      p95VerifyLatencyNs: p95Latency,
      speedup: this.speedup(acceptanceRate),
```
```ts
  speedup(acceptanceRate: number, gamma = 4): number {
    if (acceptanceRate <= 0) return 1;
    const a = acceptanceRate > 1 ? 1 : acceptanceRate;
    const expectedAccepted = a >= 1 ? gamma : (a * (1 - Math.pow(a, gamma))) / (1 - a);
    const expectedCommitted = 1 + expectedAccepted;
    const cost = 1 + gamma * this.draftCostWeight;
    return expectedCommitted / cost;
  }
```

Verdict: CONFIRMED by execution — the two figures above both come from the same tracker
instance. `predictedSpeedup` (`parallel-speculator.ts`'s import from here) takes `gamma`
explicitly, so only the report path is affected.

---

### [LOW] `acceptanceProbability` returns 1 when both models assign ~0 probability, but the acceptance test then necessarily rejects

Location: `packages/core/src/llm/speculative/draft-acceptance.ts:118-120`, `292-299`

In `logAcceptanceRatio`, a draft probability at or below `LOG_EPSILON` with a target probability
also at or below the threshold returns `0` — i.e. log-ratio 0, acceptance probability 1. That is
the degenerate 0/0 case, and it disagrees with the actual sampling rule in `verifyWindow`, which
accepts only when `u * p < q`; with `p = 0` and `q = 0` that is `0 < 0`, always false. So a
position that is necessarily rejected is reported in `acceptanceProbabilities` as certainly
accepted, and `expectedAcceptCount` — which uses `acceptanceProbability` directly — adds 1 for
it. Verified by probe: `acceptanceProbability(0, 0, "stochastic", id, id)` returns `1`. The
mismatch is reachable in practice: `padRow` (lines 247-258) zero-fills absent draft ids, so a
draft token outside both rows' support has `p = 0` and `q = 0` exactly.

```ts
  if (draftProb <= LOG_EPSILON) return targetProb > LOG_EPSILON ? Number.POSITIVE_INFINITY : 0;
  if (targetProb <= LOG_EPSILON) return -Infinity;
  return Math.log(targetProb) - Math.log(draftProb);
```
```ts
      const probability = acceptanceProbability(q, p, "stochastic", targetId, comparedDraftId);
      probabilities.push(probability);
      if (u * p < q) {
        tokenIds.push(draftId);
      } else {
        firstRejection = position;
        break;
      }
```

Verdict: CONFIRMED. The `1` was observed by execution and the reject-branch follows from the
quoted comparison. Severity LOW: the sampling decision (the correctness-critical part) is right;
only the reported probabilities and the expected-count helper are wrong.

---

### [LOW] The draft-quality KL gate is computed over the overlapping vocabulary only, understating divergence for the subset case it exists for

Location: `packages/core/src/llm/speculative/draft-acceptance.ts:406`, `417-425`

`verifyWindow` pads draft rows into target-vocabulary width and maps draft ids through
`draftToTargetMap` precisely because the draft vocabulary can be a subset. `draftQualityGate`
instead takes `width = Math.min(targetProbs.length, draftProbs.length)` and sums KL over that
overlap, dropping every target token outside the draft's support — which is exactly where
divergence lives. A draft that is silent on half the target's vocabulary can measure KL ≈ 0 over
the overlap and be gated out as "nothing speculative to gain", or pass a window a fuller
comparison would reject.

```ts
  const width = Math.min(targetProbs.length, draftProbs.length);
  const epsilon = 1e-12;
```
```ts
  for (let i = 0; i < width; i++) {
    const pE = (targetProbs[i] ?? 0) + epsilon;
    const pA = (draftProbs[i] ?? 0) + epsilon;
    kl += pA * Math.log(pA / pE);
```

Verdict: PLAUSIBLE. The truncated loop is confirmed by reading; whether it mis-gates depends on
real probability rows, which no probe in this pass supplied.

---

### [MEDIUM] The fail-soft path is not fail-soft: a demoted stream whose target then fails throws out of `runRound`

Location: `packages/core/src/llm/speculative/parallel-speculator.ts:248-283`, contrasted with `289-311`

The module's stated design (its own header, lines 15-17) is that "a failed speculation must not kill the serving loop", and the speculative path honours it: `target.verify` is wrapped so a failure rolls the staged suffix back and returns a `verify-failed` outcome. The target-only branch — reached when the draft already failed and the stream was demoted — calls the same `target.verify` with **no guard at all**. So the combination "draft fails, then target fails" (a degraded stream hitting a genuinely overloaded endpoint, the exact case fail-soft exists for) throws `target forward failed` out of `runRound` instead of returning an outcome. Verified by probe: `runRound` on a demoted stream with a throwing target raises `Error: target forward failed` and resolves to no outcome, while the same stream with a working target returns `{demoted: true, committed: [token]}`. It is also the one path `runBatchRound` cannot absorb: its `Promise.all` rejects, so every other healthy stream in that batch loses its round too.

```ts
    if (draft.tokenIds.length === 0) {
      // Target-only round: one token, no speculation.
      const target = await this.target.verify({
        streamId,
        context,
        draftTokens: [],
        draftPointMass: true,
      });
```
```ts
    let target: TargetWindow;
    try {
      target = await this.target.verify({
        streamId,
        context,
        draftTokens: draft.tokenIds,
        draftPointMass: draft.pointMass,
      });
    } catch (error) {
      // A verification failure must not leak the staged suffix.
      ledger.rollbackAll("budget-exceeded");
```

Verdict: CONFIRMED by execution — the throw and the missing guard are both directly observable. The existing test at
`packages/core/test/llm/speculative/parallel-speculator.test.ts:119-131` covers a failing target only behind a *working*
draft (the guarded path); the demoted-draft combination is untested. Rated MEDIUM rather than HIGH because
`ParallelSpeculator` has no production caller in this repo — it is exercised by `runSynthetic` and its own tests, with
injected model seams — but the broken contract is the one the module documents as its purpose.

---

### [LOW] `runBatchRound`'s docstring claims verification is batched; every stream gets its own forward

Location: `packages/core/src/llm/speculative/parallel-speculator.ts:374-386`

The docstring says "Proposals are issued concurrently — the draft forwards are independent per stream — while
verification is batched by the target seam." The implementation maps each stream to its own `runRound`, and each
`runRound` awaits its own `target.verify` as soon as its own proposal resolves. There is no batch entry point:
`TargetModel.verify(request: VerifyRequest)` takes one stream's request, so the seam cannot batch even if it wanted to.
Verified by probe: a batch round over 3 streams makes exactly 3 `verify` calls. The performance model the docstring
invokes — one target forward per round, the whole reason speculation pays off — does not hold across streams; only the
per-stream "one forward per window" invariant does.

```ts
  async runBatchRound(): Promise<RoundOutcome[]> {
    const ids = [...this.streams.keys()];
    const outcomes = new Map<string, RoundOutcome>();
    const pending = ids.map((id) => this.runRound(id).then((outcome) => outcomes.set(id, outcome)));
    await Promise.all(pending);
    return ids.map((id) => outcomes.get(id)!);
  }
```

Verdict: CONFIRMED by execution (the call count was observed) and by reading the seam's signature. Rated LOW: this is a
documentation/implementation mismatch with no behavioural consequence, but a caller sizing a deployment on the
docstring's batching claim would be mistaken.

---

## Checked and clean

- `packages/core/src/llm/list-models.ts` — the wrapper declares `Promise<string[]>` and
  AgentHub's `AutoLLMClient.listModels(): Promise<string[]>`
  (`node_modules/@prismshadow/agenthub/dist/autoClient.d.ts:90`) matches; the credential/URL
  conditionals and the "caller bounds the call" contract are as documented.
- `packages/core/src/llm/tool-call-ids.ts` — the allocator/suffix round-trip is sound: a
  provider id legitimately ending in `#2` that passed through untouched is returned intact by
  `originalIdOf` (it is in `used` but not `suffixedToBase`), `markUsed` only advances the
  per-base cursor from a suffix it actually saw, and `rotate`'s cohort rule (`gen < retired`)
  keeps the just-ended generation's ids reserved.
- `packages/core/src/llm/tool-call-repair.ts` — `scanJsonStructure` handles escapes and
  mismatched brackets conservatively, `repairTruncatedJSON` re-verifies with a real `JSON.parse`
  before claiming `fixed`, and `scavengeToolCalls`' signature/source dedup (same signature from a
  *different* source is collapsed, from the *same* source survives) matches its comment.
- `packages/core/src/llm/speculative/speculative-rollback.ts` — the rollback-before-commit
  ordering and the comment explaining why are consistent; after a full accepted or rejected round
  `ledger.reserved` returns to exactly 0, so `leakReport` is meaningful rather than reporting
  mid-round reservations as leaks. `rollback` clamps `firstRejection` to the pending window.
- `packages/core/src/llm/proxy-pool.ts:93-118` — `extractExplicitPort` deliberately preserves an
  explicit standard port that WHATWG normalisation would drop, handles IPv6 brackets and
  credentials containing `@` (via `lastIndexOf`), and validates the range.
- `packages/core/src/llm/quota-parser.ts` — the `\b429\b` over-match on prose ("room 429" is a
  quota failure) is real but already pinned as current behaviour at
  `packages/core/test/llm/quota-parser.test.ts:100-116`; the auth-over-quota precedence and the
  overload/context flags carried alongside an auth verdict are likewise pinned and correct.
- `packages/core/src/llm/pricing-catalog.ts` — the `savingsFromCache` clamp, the fallback rates
  for missing columns (cache read 0.1×, cache write 1.25×, reasoning = completion), and the
  custom-override precedence are all correct against hand-computed figures and pinned by
  `packages/core/test/pricing-catalog.test.ts:117-294`.
- `packages/core/src/llm/speculative/parallel-speculator.ts` (continuation-token accounting) — the
  `result.tokenIds[result.acceptCount]` lookup in the partial-acceptance branch looks like an
  off-by-one but is correct in every `verifyWindow` exit: the greedy-rejection branch pushes the
  target's token at the rejection position (`draft-acceptance.ts:285`), the stochastic-rejection
  branch pushes `resampledTokenId` (`draft-acceptance.ts:341`), and the all-accepted branch pushes
  the bonus — so index `acceptCount` is the continuation in each, which the comment there
  correctly describes as required to preserve the target's output distribution. The throughput
  `committed`/`discarded` buckets and the rollback-before-commit ordering agree with it.
- `packages/core/src/llm/speculative/index.ts` — a pure re-export barrel; its export list matches
  the public names of the four modules it aggregates, with values and types separated correctly.
- `packages/core/src/llm/generative-model.ts` (conversion helpers) — `parseToolArguments`
  (`:92-96`) documents its decision to let bad JSON throw and degrades a non-object parse to `{}`;
  `groupHistoryToUniMessage`'s `groups[groups.length - 1]!` (`:211`) is total because the first
  iteration always opens a group, and `mergeOmniToUniMessage`'s `payloads[0]!` (`:230`) sits below
  an explicit empty-input guard.
- `packages/core/src/llm/key-rotator.ts` — round-robin scanning, the weighted selection's
  floating-point fallback, and `KeyRotatorRegistry`'s scope-keyed singleton are as documented;
  `WeightedKeyRotator.selectKey` returns the earliest-expiry non-failed key when all are cooling,
  which is the fallback `nextKey`'s docstring wrongly claims for itself.
