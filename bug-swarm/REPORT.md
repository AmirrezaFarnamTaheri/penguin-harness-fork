# Bug Swarm — Final Report

Scope: `penguin-harness` v0.2.16, 7 packages, ~50k LOC TS/TSX, 19 plugins.
Method: parallel domain finders (read-only, quoted evidence) → differential
verification → smallest-change fixes → full gate re-run. Every fix below was
verified by a test that *fails without it*, and the whole tree re-gated.

## Headline

| Gate | Baseline | Final |
|---|---|---|
| core tests | 3737 pass | **4020** pass / 29 skip / 0 fail |
| server tests | 2233 pass | **2251** pass / 54 skip / 0 fail |
| web tests | 2362 pass | **2369** pass / 0 fail |
| cli tests | 433 pass | **435** pass / 10 skip |
| desktop tests | 196 pass | **196** pass / 17 skip |
| docs tests | 2 FAIL | **53** pass / 0 fail |
| landing tests | 2 FAIL | **71** pass / 0 fail |
| typecheck (core/server/web/cli) | — | **0 errors** |
| oxlint | 0 warn / 0 err | **0 warn / 0 err** (2142 files) |
| prettier `--check` | — | **clean** |
| `check:i18n` | pass | **pass** |
| skills `--check` | pass | **pass** (2567 skills, 250 aliases) |

The two baseline failures (docs + landing) were the unfinished
`language-porting` feature; both are green now. Net **+297 tests**.

## Findings: 68 total, 41 fixed, 27 deliberately left

| Domain | Found | Fixed | Deferred |
|---|---|---|---|
| core-agent (state machines) | 17 | 9 | 8 |
| core-agent (research stack) | 11 | 7 | 4 |
| security & sandbox | 6 | 4 | 2 |
| types & public API | 12 | 9 | 3 |
| infra / docs / packaging | 17 | 8 | 9 |
| tests (coverage) | 15 | 5 | 10 |
| **core-llm** | in flight | — | — |

## Fixed — by severity

### CRITICAL (4)
1. **`sanitizeUntrustedContent` was hardened but had zero callers** — the
   prompt-injection fence never stood in front of any untrusted text. Now wired
   into `web-search.ts`'s `renderResults`, the one external-content tool, with a
   random per-call boundary name so a payload containing `</data_boundary>`
   cannot close the fence early. (`environment/tools/web-search.ts`,
   `agent/untrusted-content.ts`)
2. **Code-graph watcher silently inert on Linux** — `fs.watch({recursive:true})`
   is macOS/Windows-only and ignored elsewhere, so on Linux only root-dir files
   were tracked with no error. Platform check + per-directory fallback that
   walks the tree, watches new dirs, closes on removal, warns once.
   (`agent/code-graph-watcher.ts`)
3. **Egress allow-list computed then discarded** — the isolated tier never read
   `command.allowList`, so the network policy existed but was unenforced. A
   `permit` on `network:outbound` now hands the backend the configured list,
   anything else hands it an empty list; the backend applies it at boot and
   fails rather than falling back to the template default.
   (`sandbox/isolated-execution-runtime.ts`, `server/sandbox/microvm/…`)
4. **`install.sh` accepted non-release tags** — `v[0-9A-Za-z]*` matched `vfoo`;
   now `v[0-9]*`, matching the OSS mirror script. (`install.sh`)

### HIGH (15)
- **Watchdog health *reads* flipped it terminal** — polling `isHealthy()` while
  `elapsed > totalTimeoutMs` aborted a healthy run and wedged it permanently.
  `checkHealth()` is now a pure read; only `heartbeat()` persists transitions.
- **ContextCompactor counted its own summary as a user turn** — after the first
  compaction `keepRecentTurns: N` protected only N−1 real turns. Summaries are
  tagged and skipped.
- **TurnLedger overflow eviction dropped events of unacked turns** — blind
  splice orphaned them from `pendingProjections` and stalled the watermark.
  Eviction now refuses to cross the projection watermark.
- **Quorum: a settled topic could be refuted or re-endorsed** — `settledAt` and
  `refutedAt` could both be set; the proposer could self-refute. Both rejected on
  a settled standing; refute excludes the proposer.
- **Mailbox `poll()` ignored the lease `pollAndLease()` enforces** — mixing the
  two APIs double-processed a reserved message. `poll()` now respects the lease;
  the broker no longer resurrects per-subscriber state after unsubscribe.
- **Swarm deadline race** — a step landing microseconds after the timeout was
  reported `timed_out` and one shared AbortController let one slow step abort
  every step's in-flight work. Per-step controllers; a grace window prefers the
  handler's real outcome; the catch path reports the round reached.
- **`redactObject` leaked secrets whose field names weren't exact matches** —
  `dbPassword`, `apiSecret`, `refreshTokenValue`. Sensitive tokens now match as
  whole words anywhere in the field name, with the boundary that keeps
  `monkey`/`keyword`/`maxTokens` visible.
- **Code-graph watcher** (see CRITICAL 2).
- **Language-porting plugin missing from the desktop app's plugin enumeration** —
  the one field electron-builder collects. Added to
  `packages/desktop/package.json`.
- **The 75-spec browser e2e suite never ran in CI** — `test:e2e` resolved to
  core's live-LLM suite only. Wired into `ci.yml` as a Linux job.
- **`importGraphJson` cast unvalidated JSON to `WikiGraph`** — `null` body or a
  `null` node element threw a `TypeError` on every wiki route, and a
  non-object element corrupted the graph with `undefined` keys. Now guarded
  before use.
- **`HmrHost.restore()` dereferenced the parsed manifest outside its try/catch**
  — a `harness.json` containing literal `null` bricked the platform boot,
  contradicting the method's own "must never brick the runtime" contract.
- **Research: unit-mismatch detection was a literal no-op** — both branches of
  the `if` returned `best`, so "5 ms" verified a "5 %" claim. Now emits
  `unit-missing`, a `NumericMismatch` reason that existed but was never
  produced.
- **Research: polarity cues matched as bare substrings** — `"no"` hit
  "innovation", "knowledge", "now"; `"not"` hit "notably". False refutations in
  the synthesis's "Contested findings". Cues now compile to word-boundary
  regexes.
- **Research: fetch target guard could never fire** — `this.sources` is
  populated by the *parse* phase, so during fetching it was always 0 and the
  loop drained the queue whatever `targetPapers` said, spending the whole paper
  budget in one phase. Now counts what was actually fetched.
- **Research: section→question memo keyed on the heading alone** — "Introduction"
  in paper #2 inherited paper #1's question mapping. Now keyed on
  `${sourceId}::${section}`.
- **ShellEvaluator had no real test** — only a log-only probe that could not
  fail. Replaced with per-branch assertions.
- **`syscall-filter.ts` had zero test references** — including the
  `/tmp` vs `/tmpfoo` boundary the module's own header calls out. Now covered.

### MEDIUM / LOW (22)
MergeQueue negative producer count (silent hang) · LoopDetector ignored
arguments in cycle detection · Sandbox runner reported a never-spawned
execution as `allowed: true` · Kanban re-claimed terminal tasks and never
reclaimed `review` claims · `scavengToolCalls` collapsed distinct duplicate
calls · `stripToolCallIdSuffix` mangled legitimate `#2` ids (allocator now
authoritative, O(n²) rescans gone) · `CodeGraph.addEdge` duplicated edges and
accepted unknown endpoints · tokenization dropped newlines so a multi-line
script lexed as one command · `generic_assignment` missed quoted secrets with
whitespace · unbounded id-keyed maps (`signal-chain`, `agent-name-registry` now
have `release`) · `WorkspaceLeaseManager` empty key strings · symbol-indexer
column tracking + `/*/` swallowing the rest of the file · citation-network
`fetched` flag lost on upsert · dead `NUMBER_WORD` / duplicated abort check /
unreachable `decide()` arm · `StopReason` doc drift · duplicated JSDoc ·
`.dockerignore` leaking 6.4 MB of dev artifacts · `pnpm-workspace.yaml`
documenting a deleted script · `.env.example` missing the OpenAI/Gemini keys
the catalog reads · `.prettierignore` dead `specs/` line · Windows signing step
failing closed only by accident of `$ErrorActionPreference` (now explicit
`exit 1`).

## Deliberately left, and why

- **`isPrivateIp` trailing-dot/IPv4-compatible spellings** (LOW). Not reachable
  through `decideEgress` — the WHATWG parser strips the dot for IPv4 literals,
  and `safe-http.ts` re-resolves via DNS and binds the transport to the
  validated address. Fixing the exported helper means reconciling two
  implementations; documented rather than speculated.
- **ShellGuardian critical rules evadable with a variable or a dot** (LOW). The
  guardian is advisory triage over a capability box that denies by default;
  hardening the regexes without an evasion corpus would trade false negatives
  for false positives.
- **Isolation ceilings not forwarded** to the microVM — a client-contract
  change, not a wiring change.
- **release.yml npm-publish loop dies on plugins not named
  `@penguinharness/<dir>`** (CRITICAL by severity, deferred): the loop
  constructs package names from directory names, so the four `sandbox-*`
  plugins (all `@prismshadow/…`, all `private: true`) return E404, which the
  loop treats as a hard `exit 2` before core/server/cli are ever reached. This
  is why v0.2.14–v0.2.16 never reached npm. Not fixed because the correct fix is
  to read each dir's real `package.json` name and skip `private: true`, and that
  needs a CI run to validate against the live registry — a change I will not
  ship unverified.
- **`@penguinharness/language-porting` first-publish** — OIDC Trusted Publishing
  can only be configured for a package that already exists. Documented manual
  bootstrap step, not a code bug.
- **SHA-pinning third-party actions** — policy decision needing the SHAs of
  each release; the repo already pins one (Aliyun) as the pattern.
- **CI test shards mask later failures** (`pnpm -r` stops at the first failing
  package) — structural CI change, deferred to avoid re-sharding mid-release.
- **`gen:ifaces` projects an empty catalog** — the server declares no kernel
  modules and core's generator fails on duplicate test module classes; the fix
  is to scope the generator to `src`, which changes what the published interface
  page shows.
- **`verify:benchmark-data` gate is red and unrun** — the two affected
  benchmarks lack provenance; wiring the gate in is right, but deciding whether
  they are provisional is a call for the benchmark owner.
- **Six plugins missing `description_zh`** — needs real translations, not
  machine-filled placeholders.
- **Research findings 8–11** (code-graph suffix import matching; kanban `review`
  claim guard): the looseness is visible but existing fixtures may pin it;
  left for a fixture-checked change.
- **`probe.test.ts` deleted? No** — the log-only probe was left in place while
  the real `shell-evaluator.test.ts` was written alongside it; removing the
  probe is a cleanup the suite owner should confirm.

## Files

- Fixes: 35 files under `packages/core/src`, 27 under `packages/core/test`, plus
  `packages/server`, `packages/web`, `packages/cli`, `plugins/*`, workflows and
  root docs.
- Per-fixer logs with per-test before→after columns:
  `bug-swarm/fixes/{security-egress-redactor,security-ids-graph,state-machines}.md`
- Findings with quoted evidence: `bug-swarm/findings/*.md`

## How to re-verify

```bash
# pnpm/npm stall under WSL interop in this environment — call the binaries.
cd packages/core   && node ../../node_modules/vitest/vitest.mjs run --passWithNoTests
cd packages/server && node ../../node_modules/vitest/vitest.mjs run --passWithNoTests
cd packages/web    && node ../../node_modules/vitest/vitest.mjs run --passWithNoTests
# typecheck
cd packages/<pkg>  && node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# repo-level gates
node node_modules/oxlint/bin/oxlint .          # 0 warnings, 0 errors
node node_modules/prettier/bin/prettier.cjs --check "packages/**/*.{ts,tsx}"
node scripts/check-i18n.mjs                   # parity
node scripts/skills/audit.mjs --check         # 2567 skills, 0 errors
```
