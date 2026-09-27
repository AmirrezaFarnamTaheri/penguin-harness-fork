# JEV-Family provenance

What this module took from `JEV-Family/`, what it deliberately left, and how a future
reader can check the claim. Written 2026-09-27.

`JEV-Family/` is a gitignored, 824 MB directory of extracted archives of third-party
projects that all speak the TypeSafe "Jev" / System One decision API. It is **reference
material, not a dependency**: nothing in `packages/` imports from it, it is not in any
`package.json`, and the build does not see it. Every idea below was reimplemented in this
module's own shape.

## The one non-negotiable rule

**Nothing absorbed here may gate, veto, block, or add latency to a request.** The advisory
observes; it never authorizes. Most of the family is built the other way round — several
projects exist *specifically* to make a model's answer control what happens — so most of
the family is reference-only by construction, not by choice. Every SKIP below cites the
code that proves the point.

## Licensing status of the material — read this before copying

The licences actually present on disk, verified by reading each `LICENSE` file:

| Licence | Projects |
|---|---|
| MIT | `fast-jev-compaction`, `hyperedit`*, `jev-gateway`, `jevgrep`, `jev-pruner`, `jev-review` (both vintages), `jev-router`, `jev-router-master` (JevRouter), `jev-search`, `jev-ultrafast`, `jev-visual`, `JevRev`, `NanoJev`, `OpenJev` (`LICENSE.md`) |
| Apache-2.0 | `agent-jev`, `AnyJev`, `kev`, `simple-jev` |
| CC0-1.0 | `awesome-jev` |
| **No licence file at any depth** | `jev-experiments`*, `hyperedit`*, `jev-workflow-builder`* (its `package.json` *claims* Apache-2.0 but ships no licence text) |

\* The three starred projects have no licence file. **On 2026-09-27 the project owner stated
that all of this material is theirs and is MIT from now on, including the unlicensed
projects, and accepted responsibility for that claim.** The decisions in this file are made
on that basis. This note exists so a future reader can see exactly what was asserted and by
whom: it is a declaration by the owner, not a licence file found in the archive. If that
declaration is ever withdrawn, every decision below that rests on a starred project must be
revisited — they are the only ones not backed by a licence text on disk.

## Auditable fact about the material

- **26 extractions, 21 distinct projects.** Five are re-extracted copies, identified by a
  content hash of every source file (build artifacts, `.git`, `node_modules` and venvs
  excluded) so that two archives of the same commit at different depths collapse:

  | Redundant extraction | Identical to | Distinct state |
  |---|---|---|
  | `fast-jev-compaction-main (1)` | `fast-jev-compaction-main/fast-jev-compaction-main` | same tree |
  | `jev-review-main (1)` | `jev-review-main-1` | v0.1.1, includes `dist/` |
  | `jev-review-main (2)` | `jev-review-main/jev-review-main` | v0.1.0, source only |
  | `JevRev-main (1)` | `JevRev-main/JevRev-main` | same tree |
  | `JevRouter-main (1)` | `JevRouter-main/JevRouter-main` | same tree |

  So `jev-review` was extracted four times and is **two** distinct trees (v0.1.0 and
  v0.1.1), not four. Most archives additionally carry a mirror of their own `src/` and
  `tests/` at the top level, which is why naive file counts overstate them — `jevgrep` is
  "114 `.ts`" but `src/` is 42.

- **No shared authored source.** Hashing every `.ts/.tsx/.js/.mjs/.py/.go` file in the
  tree and normalising the outer/inner mirror path leaves no byte-identical *authored* file
  between any two projects. The only substantive cross-project duplicate is
  `types/claude-code.d.ts` (428,783 bytes, sha256 `1de8b590ce51c31a…`), shared by
  `fast-jev-compaction` and `jev-pruner` — and it is **machine-generated**, whose own header
  reads *"Written by Claude Code 2.1.274 … written by `/plugin-types`; regenerate with that
  command after an update rather than editing"*. It is an ambient type declaration the tool
  emits, not code either author wrote. What the family shares is the System One wire
  contract, reimplemented independently (TypeScript SDK, hand-rolled `fetch`, Python
  `requests`/FastAPI/HF), plus independently re-derived idioms (`Ring`, `percentile`,
  `RateMeter`, `Limiter`).

## Taken, with licence and decision

| Idea | Source | Licence | Decision |
|---|---|---|---|
| Fixed-capacity ring + monotonic-sequence `since()` cursor for a bounded event log | `jev-gateway/src/events.ts` | MIT, © 2026 Vinicius Lana | **ADAPT** → `JevObservationJournal` |
| Field-by-field record construction so payload text cannot reach an export | `jev-gateway/src/events.ts` (same file) | MIT, © 2026 Vinicius Lana | **ADAPT** → `JevObservation` has no string field |
| Closed-vocabulary classification of an observation into a small fixed word set | `jev-pruner/src/retention.ts` | MIT, © 2025 | **ADAPT** → `ObservationGrade`, applied to structured fields rather than text (see below) |
| Honest accounting for entries lost to a bound | `JevRev/src/long/signals.ts` (`MAX_OPEN_TOOL_CALLS = 512`) | MIT, © 2026 JevRev contributors | **ADAPT** → `JevObservationSummary.dropped` |
| Reported-but-never-enforced spend, separated from the transport that does enforce | `JevRev/src/long/policy.ts` alert raise/recover | MIT, © 2026 JevRev contributors | **ADAPT** → `JevBudget` |
| Canonical content hashing (key-sorted, `sha256:`-prefixed) for change detection | `JevRouter/src/utils.ts` (`stableJson`/`sha256`) | MIT, © 2026 JevRouter contributors | **ADAPT** → `observationFingerprint` (FNV-1a inline, not `node:crypto`, so it loads in a browser bundle) |
| Content fingerprint over semantic state to detect "nothing changed" | `jev-ultrafast/browser.py::fingerprint` | MIT, © 2026 Browser Use | **ADAPT** → `isRedundant` |
| Observe only the opening of a turn, not every request in it — the family's single biggest cost control | `jev-router/src/proxy.mjs::newTurnPrompt` | MIT, © 2026 Jev Router contributors | **ADAPT** → `isRedundant`, as a predicate a caller may consult and the module never does |
| Reason-intersection classifier: a dominant cause requires that EVERY failure shared it | `JevRev/src/policy.ts` ("why the run ended") | MIT, © 2026 JevRev contributors | **ADAPT** → `explainObservations`, `offline` vs `unavailable` |
| Time-windowed event correlation into bounded, max-severity-wins groups | `jev-experiments/log-sentinel/server/incidents.ts` | owner-declared MIT | **ADAPT** → `correlateIncidents` |
| "Least one always survives" bounded walk with the omitted count reported in-band | `jev-gateway/src/state.ts::buildState` | MIT, © 2026 Vinicius Lana | **ADAPT** → `summary().dropped` / `oldestSeq`; the journal never returns an empty `latest()` for a non-empty ring |

All ten are reimplemented. No code was copied verbatim, so no attribution is legally
required; the table is here so a reviewer can check the reasoning, not so a licence file can
be satisfied after the fact.

**The one substantive design change** is the grade vocabulary. `jev-pruner` classifies *text*
(bash output) into `reference | diagnostic | result | progress | unknown`. This module
refuses to retain text at all — that is `activity.ts`'s central privacy rule and it is
load-bearing — so the same idea is applied to the advisory's **structured** fields instead:
a 1–5 risk score becomes `routine | elevated | high | critical | unknown`. An observation
that carries no usable risk score grades `unknown` rather than being guessed at. Applying
the classifier to retained text here would have undone the privacy property.

## Rejected, with the reason

| Rejected | Source | Licence | Why |
|---|---|---|---|
| `trimOutput` — chunking, scoring and **dropping** output the model never sees | `jev-pruner/src/output.ts` | MIT | It is a content filter on the model's context. A gate by construction. |
| `fitState` / `estimateTokens` | `fast-jev-compaction/src/state.ts` | MIT | `fitState` shrinks what the model reads — a gate. `estimateTokens` is a decent tokenizer-free estimator but we already have `approximateTokens` in `src/llm/context-limits.ts`; a second one is a duplicate, not a gain. |
| `decide()` / `applyTier()` / `adapter.apply()` — model and `tool_choice` rewriting | `jev-gateway/src/{decide,app}.ts`, `src/adapters/*` | MIT, © 2026 Vinicius Lana | The gateway answers the request itself in `direct` mode (`app.ts`) and can force `tool_choice: "none"`. The definition of a gate. |
| `body.model` substitution on the live request | `jev-router/src/proxy.mjs` | MIT, © 2026 Jev Router contributors | Rewrites the in-flight request and adds a blocking round-trip per turn. Violates the rule twice. |
| Candidate selection + `allowed_risk_levels` / permission filters | `JevRouter/src/router.ts` | MIT, © 2026 JevRouter contributors | Sets `selected = null` on three paths; the skill file says "execute only that available capability". A gate. |
| `BLOCKING_SEVERITY` / `SCREEN_THRESHOLD` — findings that request changes | `jev-review/src/domain/config.ts` | MIT, © 2026 Dev Agrawal | A veto, by its own comment. |
| `{"continue": false, "stopReason": "AgentJev 安全拦截"}` | `agent-jev/agentjev_hook.py` | Apache-2.0 | A blocking PreToolUse hook that stops the agent. The exact opposite of this module. |
| `JudgePool` stale-shedding | `jev-experiments/…/pool.ts` | **none** | Unlicensed → reference only; also a gating decision. |
| `Incidents`, `LineGrouper`, `RateMeter`, `Rolling`, `BM25`, `parseUnifiedDiff` | `jev-experiments/`, `commit-sentry/src/diff.ts` | **none** | `jev-experiments` has no licence file at any depth. Useful shapes, reimplemented from description if ever needed. |
| Everything in `hyperedit` | `hyperedit-main` | **none** | No licence file — and it is not a Jev project at all: `package.json` names it `mocha-app`, a Remotion video editor. Jev appears only in one 67-line script. |
| Everything in `jev-workflow-builder` | `jev-workflow-builder-main` | claims Apache-2.0 in `package.json`, **no licence text** | A claim with no licence and no provenance. Treated as unlicensed. Its `executor.ts` is also a DAG runtime — control flow. |
| `measureSerializedBatch()` returning `fits: false` | `jevgrep/src/evaluation/policy.ts` | MIT, © 2026 Nassim Arifette | Decides whether a request is dispatched. A gate. |
| `response_scoring.py` — softmax/entropy over label logits | `simple-jev/common/response_scoring.py` | Apache-2.0, © Featherless AI / Recursal AI | Correct and pure, but it needs **logits**. This module only ever sees probabilities the SDK already extracted, so there is nothing to apply it to. |
| `kev/metrics.py` and `AnyJev/bench/metrics.py` (ECE, Brier, NLL) | `kev`, `AnyJev` | Apache-2.0 | Duplicate of each other — pick one if ever wanted. They calibrate a *model*; this module never runs one, so there is nothing to calibrate. |
| `parseHunks` / `parseUnifiedDiff` | `jev-review`, `jev-experiments` | MIT / **none** | Real and pure, but the harness already has diff handling, and the second copy is unlicensed. |
| `stable-order.ts`, `merge.ts`, `rank.ts` | `jev-search/src/lib/` | MIT, © 2026 Search1API | Good, pure, deterministic. Nothing in the advisory currently produces a list that grows under a reader, so there is no caller. Rejected on YAGNI, not on quality. |
| `profiling.ts` (AsyncLocalStorage) | `jevgrep/src/profiling.ts` | MIT, © 2026 Nassim Arifette | Excellent, and genuinely zero-cost when off. But it needs `node:async_hooks` in a module that must stay importable from a browser bundle, and this module already measures latency per observation. |
| `status.mjs` bounded 20-entry decision history | `jev-router/src/status.mjs` | MIT, © 2026 Jev Router contributors | Its shape is the ring we already reimplemented from `jev-gateway`; the file writes to disk, which a core module should not do. |
| `ScoreCache` | `jevgrep/src/evaluation/cache.ts` | MIT, © 2026 Nassim Arifette | Its two in-memory maps are bounded only transitively by an on-disk `maxBytes`. This codebase has been bitten by unbounded growth twice; a cache with derived bounds is not a thing to import into core. |
| `memoryCache()` | `jev-search/src/lib/cache.ts` | MIT, © 2026 Search1API | An unbounded `Map`, in a module that otherwise fails open correctly. Explicitly not copied. |
| `RateMeter` from `jev-firehose/src/stats.ts` | `jev-experiments` | **none** | Prunes stale marks only when `rate()` is called, so it grows without bound in a caller that marks but never polls. Unlicensed anyway. |

## Corrections to the prior audit

The prior audit concluded the six JEV repos "share only SystemOne" and that several are not
what their blueprints claim. Re-verified rather than trusted:

- **"Share only SystemOne" is right about authored code, and the one exception is not
  code.** The only cross-project byte-identical file is the 428 KB machine-generated
  `claude-code.d.ts` described above. Five independent passes over the tree — by file hash,
  by distinctive identifier, and by prompt prose — found no shared authored source. The
  conclusion stands, with the nuance that the projects also share a *generated* ambient
  type artifact.
- **The family is much larger than six.** 21 distinct projects, 26 extractions. The brief
  that prompted this work named ten; the remaining eleven include the two largest trees on
  disk (`kev` at 245 MB, `NanoJev` at 236 MB — both almost entirely `evals/`, `runs/`,
  `research/` and media rather than code).
- **`hyperedit` is not a Jev project at all**, and is unlicensed. Its own `package.json`
  calls it `mocha-app`.
- **`agent-jev` is literally a blocking gate** — its hook emits `{"continue": false}` and
  names itself a "安全拦截" (security interception). The prior audit's framing of it as an
  observation system would have been backwards.
- **`JevRouter` and `jev-router` are not the same project**, and neither is related to
  `JevRev`. Three different authors, three repositories, and two different languages
  (`JevRouter` is TypeScript and routes *capabilities*; `jev-router` is plain `.mjs` and
  proxies the real `claude`/`codex` binaries to swap `body.model`). The version numbers
  0.1.0 and 0.3.0 are a coincidence, not a lineage. No `.git` directory exists anywhere in
  `JEV-Family`, so this is established from package metadata and content, not from refs.
- **`jev-review` is not an earlier `JevRev`.** Different holders, different repositories,
  1,260 vs 8,768 LOC, zero tests vs 34, and no cross-reference in either direction.

## What is still on disk, and whether it should stay

Everything. Nothing was deleted, moved or edited inside `JEV-Family/`, and nothing in the
repository references it. It is gitignored, so it costs disk and nothing else.

If the disk has to be reclaimed, the honest ordering is by evidence value, not by size:
`kev`, `NanoJev` and `simple-jev` together are 564 MB and hold very little reusable code
between them (their `metrics.py` files duplicate each other, and none of it applies to a
module that never runs a model). The five redundant extractions are the cheapest real win —
about 12 MB, and each one's identity has been recorded above. But there is no reason to
delete any of it while the directory is gitignored and unimported, and the provenance table
above is only auditable as long as the sources are still there to compare against.
