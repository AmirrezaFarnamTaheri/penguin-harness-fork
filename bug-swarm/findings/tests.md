# TEST QUALITY & COVERAGE — findings

Domain: test-suite weaknesses across `packages/core/test`, `packages/server/test`,
`packages/web/test`, `packages/cli/test`, and the e2e suites (`packages/core/test/llm.e2e.test.ts`,
`packages/core/test/agent-stream.e2e.test.ts`, `packages/web/e2e/run.sh` + 75 specs).

Summary: the unit suites are unusually strong — a full sweep for tautologies (`expect(x).toBe(x)`),
`expect(true)`, empty test bodies, snapshot bloat, and stale module imports came back **clean**:
there are zero snapshot tests in the repo, zero zero-assertion files except one, and every
`catch` block I inspected feeds a real assertion. The damage is concentrated elsewhere. One
file, `packages/core/test/sandbox/probe.test.ts`, is a leftover manual probe: 84 lines, not one
assertion, every outcome swallowed into `console.log` — and it is the *only* test file in the
repo that imports `ShellEvaluator`, a 720-line security-critical sandbox classifier. That single
file is both "a test that cannot fail" and "the missing coverage" for the module, at once. Beyond
it, coverage gaps cluster on exactly the bug-prone areas named in the brief: the sandbox's shell
evaluator and syscall filter, the LLM fleet's pricing/quota path, and two agent modules
(`untrusted-content.ts`, `steer-reminder.ts`) that are publicly exported and shipped in `dist` but
have neither tests nor any runtime caller — a prompt-injection defense that nothing applies. The
widest hole is structural: the entire 75-spec Playwright browser suite never runs in CI, because
the root `test:e2e` script resolves to `pnpm --filter @prismshadow/penguin-core test:e2e` (live LLM
only) and no workflow calls `bash e2e/run.sh`, so "all e2e passed" in CI means the browser suites
never ran. Note also that `pnpm`/`vitest` could not be executed for this pass (`node_modules`
absent, deps still installing), so every verdict below rests on reading source against test — no
runtime confirmation was possible.

---

### [CRITICAL] probe.test.ts cannot fail, and it is the only test ShellEvaluator has
- Test file: `packages/core/test/sandbox/probe.test.ts:1-85` (uncovered prod file:
  `packages/core/src/sandbox/shell-evaluator.ts:219,269-720`)
- Symptom: The whole file is one `it("clock")` that wraps every code path in `try/catch` and
  prints the result. There is not a single `expect`. Any regression in `ShellEvaluator` — a
  mis-classified construct that now runs in-memory instead of escalating to the hardware sandbox,
  a broken execution-limit check, a wrong `$?`/`${VAR:-x}` expansion — prints a different log line
  and still passes. It is the only zero-assertion test file in the repo, and grep confirms it is
  the only file importing `ShellEvaluator`:
  ```
  $ grep -rln "ShellEvaluator" test/
  test/sandbox/probe.test.ts
  ```
- Evidence:
  ```ts
  try {
    const r = await ev.evaluate("pwd");
    console.log("CONSTANT-CLOCK exit", r.exitCode, "dur", r.durationMs, "now-calls", calls.length);
  } catch (e) {
    console.log("CONSTANT-CLOCK THREW", (e as Error).message, "calls", calls.length);
  }
  ```
  ...repeated for 12 more expansion cases, ending with a bare
  `console.log("STATUS after false, then X=$? =>", r.exitCode);` and no `expect` anywhere.
- Fix: Replace with a real `shell-evaluator.test.ts`. Assert `classifyScript` returns
  `inMemorySafe:false` with the right `UnsupportedReason` for each of the 12 unsafe token types
  (map at `shell-evaluator.ts:71-96`); assert `evaluate` throws `ExecutionLimitError` with the
  right `kind` ("time"/"commands"/"output") at lines 320-350; assert `${VAR:-d}`, `${VAR-d}`,
  `${VAR:+a}`, `${VAR+a}`, `${VAR:?}` behaviour at lines 528-537; assert `&&`/`||` short-circuit
  (365-380) and that a non-builtin command raises `UnsupportedConstructError` (451-454). Delete
  `probe.test.ts`.
- Confidence: high

### [CRITICAL] The 75-spec browser e2e suite never runs in CI
- Test file: `packages/web/e2e/run.sh` + `packages/web/e2e/*.spec.mjs` (75 specs); gap in
  `.github/workflows/ci.yml`
- Symptom: `pnpm test:e2e` — the only e2e entrypoint the workflows call — resolves to core's live
  LLM e2e only:
  ```
  root package.json:  "test:e2e": "pnpm --filter @prismshadow/penguin-core test:e2e"
  ```
  and `grep -rn "playwright\|run.sh" .github/workflows/*.yml` returns nothing. So every browser
  spec (chat + tool approval, session fork, traces, workspace preview, subagent, compaction,
  steer/abort, cockpit telemetry, malformed-input handling) is un-gated. A regression that
  completely breaks the chat UI ships green. The specs themselves are thorough; they are simply
  never run by the gate that is trusted to catch this class.
- Evidence: `ci.yml:119-127` runs `pnpm test:e2e` in the `installer-e2e` job with
  `if [ -z "$DEEPSEEK_API_KEY" ]; then ... exit 0; fi`; the macOS/Windows shards run
  `Unit tests (vitest)` only; `packages/web/package.json` `"test:e2e": "bash e2e/run.sh"` has no
  caller anywhere in `.github/`.
- Fix: Add a Linux job to `ci.yml` running `pnpm --filter @prismshadow/penguin-web test:e2e` with
  `SKIP_BUILD=1` after a build step, plus `npx playwright install --with-deps chromium`. Gate it
  so it fails the build rather than skipping.
- Confidence: high

### [HIGH] PricingCatalog.resolve's fuzzy substring fallback and the whole cost arithmetic are untested
- Uncovered prod file: `packages/core/src/llm/pricing-catalog.ts:167-259`; wired at
  `packages/server/src/http/routes/gateway.ts:24,306-310`
- Symptom: The `/cost` endpoint is live and computes money. Its only test
  (`gateway-validation.test.ts:29-58`) asserts the *negative* paths (400 on negative tokens,
  `priced:false` → `"Unknown"`) — never a single numeric dollar figure. So the entire
  `calculateCost` arithmetic is unverified: the `?? promptPerMillion * 1.25` cache-write fallback,
  `?? promptPerMillion * 0.1` cache-read fallback, `reasoningPerMillion ?? completionPerMillion`,
  and `savingsFromCache = Math.max(0, fullUncachedCost - (promptCost + cacheReadCost))`. Most
  dangerously, `resolve` has a *fuzzy substring fallback* with no test:
  ```ts
  return DEFAULT_PRICING_CATALOG.find(
    (entry) =>
      entry.provider.toLowerCase() === provider.toLowerCase() &&
      (modelId.toLowerCase().includes(entry.modelId.toLowerCase()) ||
        entry.modelId.toLowerCase().includes(modelId.toLowerCase())),
  );
  ```
  A model named `"flash"` matches catalog `"gemini-2.5-flash"` (`entry.modelId.includes(modelId)`),
  and `"o"` matches `"o1"` ($15/$60 per million) — a wrong-tier price chosen silently. A refactor
  that dropped the provider clause would pass every existing test.
- Fix: Add `packages/core/test/pricing-catalog.test.ts`: assert exact-match resolution,
  case-insensitivity, custom `setOverride` precedence over the default catalog, the substring
  fallback's actual over-match behaviour (document it explicitly), `priced:false` for an unknown
  provider, and hand-computed costs for a model with and without cache/reasoning fields. Add one
  server test asserting a real `$` figure from `POST /cost` for `openai`/`gpt-4o`.
- Confidence: high

### [HIGH] ShellEvaluator / classifyScript — 720 lines of sandbox classification with no real test
- Uncovered prod file: `packages/core/src/sandbox/shell-evaluator.ts:219-720`
  (test that should cover it: `packages/core/test/sandbox/probe.test.ts`)
- Symptom: Same root cause as the CRITICAL finding, stated as a coverage gap. The module's own
  docstring calls out that "approximating a shell is how sandboxes die" — every construct outside
  the supported subset must be reported `unsupported` so the runtime escalates to a
  hardware-isolated sandbox. None of that classification is asserted anywhere. Specifically
  uncovered: `classifyScript`'s brace-depth / unbalanced-group detection (228-262), the
  command-position external-command detector (240-250), and the four resource ceilings at
  320-350 (abort, wall-clock, command count, output size on both stdout and stderr).
- Evidence: the only exercise is the log-only probe; see the CRITICAL record for the quoted lines.
- Fix: as in the CRITICAL record — a real `shell-evaluator.test.ts` with per-branch assertions.
- Confidence: high

### [HIGH] syscall-filter.ts — 541 lines of sandbox policy, zero test references
- Uncovered prod file: `packages/core/src/sandbox/syscall-filter.ts:1-541`
- Symptom: The seccomp-policy port: the disposition table (virtualize / passthrough / deny_eperm /
  deny_enosys / unsupported), the path router deciding which filesystem backend owns a path, and
  the component-boundary prefix matching. The module's own header states the invariant that must
  not regress — "`/tmpfoo` is not treated as a child of `/tmp`" — and it is exactly the kind of
  off-by-a-slash bug that ships silently when nothing tests it. `grep -rl "src/sandbox/syscall-filter" test/`
  returns nothing; the module is not even imported indirectly.
- Fix: Add `packages/sandbox/test/syscall-filter.test.ts`: assert each disposition category
  (network is outbound-only — `bind`/`listen`/`accept` denied while `connect` passes; every
  privilege-raising syscall denied; unimplemented fails closed as ENOSYS); assert the path router's
  `/tmp` vs `/tmpfoo` boundary, `/proc` routing, and the block/handle union; assert a trailing-slash
  and a `..` traversal cannot escape the cow backend.
- Confidence: high

### [HIGH] sanitizeUntrustedContent — the prompt-injection defense is exported but never applied or tested
- Uncovered prod file: `packages/core/src/agent/untrusted-content.ts:24-58`
- Symptom: A security function that strips zero-width steganographic characters, matches six
  injection patterns ("ignore previous instructions", jailbreak modes, `<system_instructions>`,
  `[system]`), and wraps content in a `<data_boundary>` block. `grep -rn "sanitizeUntrustedContent"
  packages plugins` finds it in exactly two places: the module itself and the
  `export * from "./untrusted-content.js"` re-export — plus the compiled `dist`. **No caller, no
  test.** So the harness ships an advertised injection defense that is not in the message path,
  and its regexes can rot undetectably. (The *enforced* policy lives separately in
  `sandbox-policy-box.ts:instructionAuthority`, which is well tested — the two are not connected.)
- Evidence:
  ```ts
  // the whole detection surface, applied by nobody:
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) { hasSuspiciousContent = true; warnings.push(...); }
  }
  ```
- Fix: Either wire `sanitizeUntrustedContent` into the tool-result/file-content path it is meant to
  guard and test it there, or delete it. If kept, add a test asserting each of the six patterns
  sets `hasSuspiciousContent`, that zero-width chars are stripped and warned, and that a benign
  tool result round-trips unchanged inside the boundary block.
- Confidence: high

### [HIGH] steer-reminder.ts — SteeringReminderEngine is exported, untested, and unused
- Uncovered prod file: `packages/core/src/agent/steer-reminder.ts:19-50`
- Symptom: Same shape as `untrusted-content`: `grep` shows it only in its own file, the
  `agent/index.ts` re-export, and `dist/index.*`. The periodic steering reminder it implements is
  not attached to any turn loop. Untested and unreachable — a change to its interval logic cannot
  be caught because nothing runs it.
- Fix: Wire it into the turn loop (if the feature is live) and test the interval/dedup behaviour,
  or remove the export. Do not leave a shipped-but-dead module as implied coverage.
- Confidence: high

### [HIGH] quota-parser.ts — 218 lines of quota/auth/overload classification with no test
- Uncovered prod file: `packages/core/src/llm/quota-parser.ts:21-218`
- Symptom: Classifies an LLM error as quota / auth / overloaded / context-length-exceeded, parses
  reset durations, and computes cooldowns — the input to key rotation and retry/backoff decisions.
  `grep -rl "src/llm/quota-parser" test/` returns nothing; it is consumed by `model-combos.ts` and
  re-exported from `llm/index.ts`. A regex that silently stops matching a provider's 429 wording
  turns a backoff into a hard failure, and no test notices.
- Evidence: four pattern tables (`QUOTA_PATTERNS`, `AUTH_PATTERNS`, `OVERLOAD_PATTERNS`,
  `CONTEXT_LENGTH_PATTERNS`) plus `RESET_DURATION_RE` / `RETRY_AFTER_RE` / `SECONDS_RESET_RE`,
  none exercised. `parseResetDuration` (`/^((\d+)h)?((\d+)m)?((\d+)s)?$/`) has no test for the
  empty-string / all-zero / malformed cases.
- Fix: Add `test/llm/quota-parser.test.ts`: one case per pattern table (including `\b429\b` vs a
  false-positive like "room 429"), precedence when a message matches both quota and auth,
  `parseResetDuration("1h30m")` → 5400 and `parseResetDuration("")` → undefined, and cooldown
  clamping at `DEFAULT_COOLDOWN_SEC`.
- Confidence: high

### [HIGH] model-combos.ts — only ModelComboRegistry is tested; the catalog normalizers are not
- Uncovered prod file: `packages/core/src/llm/model-combos.ts:177-234`
  (test present: `packages/core/test/model-combo-fallback.test.ts` — covers `ModelComboRegistry` only)
- Symptom: `model-combo-fallback.test.ts` exercises fallback routing well, but the three pure
  functions that shape the whole provider/model catalog are untouched: `normalizeProvider`
  (alias table: `glm`→`zai`, `kimi-cn`→`moonshotai-cn`), `baseModelId` (strips vendor prefix on `/`
  **and** a `:` variant suffix), and `slimModelCatalog` (merges `provider/model:v1` and
  `provider/model:v2` onto one base id, dropping `text` from input modalities, first-wins). An
  alias typo or a `:`-split regression silently re-keys or drops models from every catalog the UI
  renders. `baseModelId("a/b:c")` → `"b"` (the `!` at line 182 is load-bearing) is one off-by-one
  from returning `""`.
- Fix: Add `test/llm/model-combos.test.ts` covering each alias, unknown-alias passthrough,
  `baseModelId` for the four shapes (`x`, `p/x`, `x:v`, `p/x:v`), and a `slimModelCatalog` fixture
  where two variant ids collapse and a duplicate after normalisation is skipped.
- Confidence: high

### [MEDIUM] Two independent pricing implementations; only one is tested
- Prod files: `packages/core/src/llm/pricing-catalog.ts:194-232` vs
  `packages/server/src/services/usage-service.ts:146-153`
- Symptom: `UsageService` prices rows with its own
  `(cacheRead*r.cacheRead + cacheWrite*r.cacheWrite + output*r.output) / 1e6`, tested to 12 decimals
  in `usage.test.ts:168-260`. `PricingCatalog.calculateCost` is a *different* formula with more
  fields (reasoning, cache-write at 1.25×, savings), wired into the `/cost` endpoint, with no
  numeric test. The two can drift — e.g. cache-write costed 1.25× prompt on one path and 1× on the
  other — and no test constrains them to agree, so the CLI `cost` view and the server usage view
  can report different totals for the same tokens.
- Fix: Add a shared golden-cases table (same usage row → both implementations) and assert the two
  totals match for models without reasoning/cache fields, or delete one implementation.
- Confidence: medium

### [MEDIUM] llm.e2e: round-3 assertion is an OR-sum that passes on a tool-id regression
- Test file: `packages/core/test/llm.e2e.test.ts:143`
- Symptom: `expect(r3.calls.length + r3.text.length).toBeGreaterThan(0)` passes when the model
  replies with text only. The case's purpose is that a `tool_result` carrying a `#2`-suffixed id is
  accepted and the provider finishes — if the outbound restoration broke and the provider errored
  into a text apology, the test still passes. (Opt-in and Gemini-keyed, so low reach, but the one
  assertion that matters is the weak one.)
- Fix: Assert on the discriminating signal — `expect((res.value as {status}).status).toBe("completed")`
  already exists in `round()`; add `expect(r3.calls.length).toBeGreaterThanOrEqual(0)` as an explicit
  "either is acceptable, but status must be completed" and drop the sum, or assert that no
  `error` payload appears in the round.
- Confidence: medium

### [MEDIUM] Wall-clock budget assertion on a real 1000-node layout
- Test file: `packages/core/test/canvas/node-graph-layout.test.ts:237-245`
- Symptom: `const start = Date.now(); ... expect(Date.now() - start).toBeLessThan(20_000);` after
  1000 layout iterations. This is a real-timer performance gate on a machine whose variance the
  repo's own `vitest.config.ts` documents at length (a cold Windows CI runner pushed a 1.4s test to
  35.7s). It is also the kind of test that *hides* a real O(n²) regression when the budget is
  generous, and flakes when it is not — a perf test that neither reliably fails on regression nor
  reliably passes.
- Fix: Move to a benchmark-style assertion (iterations per second, or a fixed iteration count with
  the expected layout positions asserted, which is the actual correctness property), or raise the
  budget only on `win32` like the config does. At minimum, assert the layout *result* is stable,
  not just that it returned quickly.
- Confidence: medium

### [MEDIUM] Tautological `>= 0` assertions on structurally non-negative values
- Test files: `packages/core/test/agent/research/eval-harness.test.ts:242`
  (`result.durationNs`), `packages/core/test/agent/research/evidence-verifier.test.ts:252`
  (`summary.meanLatencyNs`), `packages/core/test/mcp-tools.test.ts:1483` (`duration_ms`)
- Symptom: A nanosecond duration from `process.hrtime` and a `Date.now()` difference cannot be
  negative; `toBeGreaterThanOrEqual(0)` cannot fail. In `mcp-tools` the real property worth checking
  is that the fatal connect actually took measurable time or at least populated the field — the
  assertion as written would pass if `duration_ms` were `undefined`... it would not (NaN ≥ 0 is
  false), but it also does not pin the field's meaning. Weakest leg of otherwise-strong tests.
- Evidence: `expect(result.durationNs).toBeGreaterThanOrEqual(0);`
- Fix: For the research modules, assert a realistic upper bound or that the value is a finite
  number plus the neighbouring field that matters. For `mcp-tools`, assert
  `typeof results[1]!.duration_ms === "number"` and that the *completed* server's duration is
  positive.
- Confidence: medium

### [LOW] Live e2e retries can mask a real flake as green
- Test file: `packages/core/test/llm.e2e.test.ts:29` (`retry: 2`),
  `packages/core/test/agent-stream.e2e.test.ts:32` (`retry: 1`)
- Symptom: Both live suites retry failing cases against a real network. That is defensible for
  inherent jitter (the comment says so), but it means a genuine intermittent failure in the
  streaming/usage path can pass on attempt 2 and never surface as a regression signal.
- Fix: Keep the retry but log which attempt passed (`onConsole`/reporter), or count retries and fail
  when a case needed all N attempts twice in a row.
- Confidence: low

### [LOW] e2e suites are `it.skip` by default — correctly, but the skip is invisible in output
- Test file: `packages/core/test/llm.e2e.test.ts:22-24`,
  `packages/core/test/agent-stream.e2e.test.ts:23-24`
- Symptom: `runLive` requires `PENGUIN_E2E === "1"` **and** a key; without both, the case is
  `it.skip`. This is the intended design (documented in the header comment) and CI does set the
  secret — so this is *not* a silent skip. Flagged only because the suite title already reports
  the state (`(skipped)` / `(gemini-3.5-flash: ..., skipped)`), which is good practice and should
  be preserved if the gating ever changes.
- Fix: none required; consider asserting in `test:e2e` that `DEEPSEEK_API_KEY` is set so a CI
  misconfiguration fails loudly instead of running zero cases.
- Confidence: high (as a non-issue)
