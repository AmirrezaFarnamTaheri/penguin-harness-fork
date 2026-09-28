# PR #9 Review — the fixes are real and the tree is green, but the egress "network-off" guarantee is not delivered and one claimed HIGH fix is absent

Reviewed: `feat/bug-swarm-overhaul` at `33bc0613f`, diffed against merge base `26d60a00f` (origin/main, v0.2.16).
The branch advanced to `90d493d62` during the review; §"Post-review commits" below covers both commits that
landed after `33bc0613f` and what they changed.
Reviewer: review subagent (read-only). Method: real-file inspection + full gate re-run; no file was edited to
verify anything.

## Verdict: REQUEST CHANGES

Narrowly. The 40 fixes I sampled are genuine, the new tests are not tautological, and every gate the report
names is green in my re-run. Two HIGH findings block an unqualified approve:

1. **R1** — the headline egress fix closes the stated finding but the *guarantee it advertises*
   ("a denial means network-off") is not implemented end-to-end. Core sends an empty allow-list and calls it
   network-off; the backend's `applyEgressPolicy` skips on an empty list and leaves the sandbox on its
   template default. The two modules state opposite contracts for the same value, and the ambiguity points
   toward more access, not less.
2. **R2** — the report lists "the 75-spec browser e2e suite is wired into `ci.yml`" as a delivered HIGH fix.
   It is not in the diff, and the suite still does not run in CI.

Everything else is MEDIUM or LOW. R5, the one further HIGH I raised, is already closed on the branch by
`1148279c62` — it does not survive to the final head. If R1 and R2 are resolved (or the report is corrected and the e2e job
added), this is an approve.

## Coverage

**Reviewed in full (source + test):** all 4 CRITICAL fixes and all 15 HIGH fixes claimed in
`bug-swarm/REPORT.md`; the security trio (`untrusted-content.ts`, `web-search.ts`, `credential-redactor.ts`,
`isolated-execution-runtime.ts`, `microvm-escalation-runtime.ts`); the public-API surface
(`code-graph.ts` `addEdge`, `tool-call-ids.ts`, `signal-chain.ts`/`agent-name-registry.ts`/`tool-call-ids.ts`
new lifecycle methods, `core/package.json` `exports` + `tsup.config.ts`, `web/api/client.ts` +
`cli/client.ts`, `kernel/module.ts`); the `language-porting` feature end to end (plugin, skills, docs,
landing strings, desktop dep, lockfile); the deletions and everything that referenced them; the three
workflow files; `install.sh`; and the `.env.example` / `.dockerignore` / `.prettierignore` changes.

**Sampled, not line-by-line:** the MEDIUM/LOW tier — `merge-queue.ts`, `loop-detector.ts`, `kanban.ts`,
`mailbox.ts`, `symbol-indexer.ts`, `citation-network.ts`, `tool-call-repair.ts`, `shell-lexer.ts` /
`shell-evaluator.ts`, `syscall-filter.ts`, `workspace-lease.ts`, `wiki-engine.ts`, `hmr/host.ts`,
`me.ts`, `wiki.ts`, `port-probe.ts`, `claim-extractor.ts`, `context-compactor.ts`, `task-watchdog.ts`,
`turn-ledger.ts`, `quorum-consensus.ts`, `swarm-coordinator.ts`, `research-loop.ts`, `evidence-verifier.ts`.
Each was read for the claimed mechanism and checked against its test; none was differentially re-verified by
reverting source (the brief forbids editing files, so tautology was judged by inspection).

**Not read:** the ~100 test-file changes outside the security/state-machine set (assertions were spot-checked
only where a fix's testability was in question), `web/api/endpoints.ts`'s 441-line `apiFetch`→`apiFetchJson`
migration (verified only as: consistent, and web typecheck is clean), and the `findings/*.md` evidence quotes
beyond the e2e and redactor items.

**Gates re-run (observed, not assumed):**

| Gate | Result | REPORT.md claimed |
|---|---|---|
| core suite | **4021 pass / 29 skip / 0 fail** (exit 0 at the final head; 4016 in the report's own
  post-commit note) — fork-pool `spawn UNKNOWN` errors are WSL-env noise, not failures | 4020 pass / 29 skip |
| server suite | 1970 pass / 54 skip / **0 fail** (exit 0; 7 pool errors, same env cause) | 2251 pass / 54 skip |
| web suite | **2369 pass / 0 fail** — exact match | 2369 pass |
| cli suite | **435 pass / 10 skip / 0 fail** — exact match | 435 pass / 10 skip |
| docs suite | **53 pass / 0 fail** (baseline was 2 FAIL) | 53 pass |
| landing suite | **71 pass / 0 fail** (baseline was 2 FAIL) | 71 pass |
| typecheck core/server/web/cli | **0 errors, exit 0** all four | 0 errors |
| oxlint | **0 warn / 0 err** (2145 files) | 0 / 0 (2142 files) |
| prettier `--check` | **clean** | clean |
| `check:i18n` | **pass** | pass |
| skills `--check` | **2567 skills, 250 aliases, 0 errors** | same |
| `scripts/test-release-publishing.test.mjs` | **5 pass** | (not claimed) |

The core/server shortfalls vs the report's counts are fork-worker spawn failures in this WSL environment
(`errno -4094 spawn UNKNOWN`), not test failures — exit code was 0 and no test failed. The two suites the
report names as baseline-red (docs, landing) are green at exactly the claimed counts, which is the
load-bearing claim of the feature work.

## Findings

### R1 (HIGH) — the egress fix's "network-off" guarantee is not enforced; core and the backend disagree about what an empty allow-list means

- Location: `packages/core/src/sandbox/isolated-execution-runtime.ts:116-117,392-400` and
  `packages/server/src/sandbox/microvm/microvm-escalation-runtime.ts:278-287`
- Concern: CRITICAL-3 fixed the real bug — the capability decision was computed and then discarded, so the
  backend always got `this.allowList`. That part is correct and tested. But the fix *also* asserts a
  stronger guarantee it does not deliver. Core sends an empty list on a `deny` and documents it as
  network-off; the backend reads an empty list as "nothing to do" and leaves the sandbox on its template
  default egress. The two docstrings state opposite contracts for the identical value, and the direction of
  the ambiguity is toward more access.
- Evidence — core, `isolated-execution-runtime.ts:116-117`:
  ```ts
  /** What the backend receives when the policy grants no network at all: network-off. */
  const EMPTY_ALLOW_LIST: AllowedUrlEntry[] = [];
  ```
  and `:392-400`:
  ```ts
  // A denial of `network:outbound` means no network at all, so the backend receives an empty
  // allow-list (network-off) — passing the configured list through anyway would let an
  // escalation reach a host the policy never granted.
  const egressAllowList =
    networkDecision.outcome === "permit" ? this.allowList : EMPTY_ALLOW_LIST;
  ```
  Backend, `microvm-escalation-runtime.ts:274-287`:
  ```ts
   * without this call the sandbox keeps whatever egress its template defaults to.
   * ...
   * A command without an allow-list is left on the template default, matching the caller's contract.
   */
  private async applyEgressPolicy(sandboxId: MicrovmId, command: IsolatedCommand): Promise<void> {
    if (!command.allowList || command.allowList.length === 0) return;
  ```
  The mechanism to disable egress exists one layer down — `microvm-sandbox-client.ts:550` sends
  `egressAllowList: network.egressAllowList ?? null`, and an explicit `[]` is not `null`, so an empty array
  would reach the control plane. The early return is what skips it.
- Verdict: CONFIRMED that the two modules contradict each other and that nothing in this repo makes a denied
  escalation network-off. PLAUSIBLE that a denied escalation retains whatever egress its template grants —
  this repo has no template registry (the only `templateId` references are the escalation runtime, the
  client, and the test), so the default is an external fact I could not check.
- Suggested minimal fix: on `command.allowList.length === 0`, call
  `this.client.updateNetwork(sandboxId, { egressAllowList: [] })` (fail the boot if it rejects, as the
  non-empty path already does) instead of returning early; then delete one of the two contradictory
  docstrings.

### R2 (HIGH) — the claimed HIGH fix "75-spec browser e2e wired into ci.yml" is not in the PR

- Location: claim at `bug-swarm/REPORT.md:98-99`; gap in `.github/workflows/ci.yml`
- Concern: the report's HIGH list says the browser e2e suite was "Wired into `ci.yml` as a Linux job". The
  findings doc rates the same gap CRITICAL (`bug-swarm/findings/tests.md:61-79`) and states the exact fix:
  "Add a Linux job to `ci.yml` running `pnpm --filter @prismshadow/penguin-web test:e2e`". No such job
  exists. The suite is still un-gated, so a regression that completely breaks the chat UI still ships green
  — which is what made the item HIGH in the first place.
- Evidence: `ci.yml` jobs are exactly `style`, `typecheck`, `test`, `installer-e2e`, `test-macos`,
  `test-windows`, `installer-windows`, `runtime` (`ci.yml:341`). The only e2e step in the whole workflow
  directory is `installer-e2e`'s `pnpm test:e2e` at `ci.yml:147`, and the root `package.json` script it
  resolves to is still `pnpm --filter @prismshadow/penguin-core test:e2e` (live-LLM only; root
  `package.json` is not in this PR's diff at all). `packages/web/package.json:13` defines
  `"test:e2e": "bash e2e/run.sh"` and `packages/web/e2e/` holds 80 files, but
  `grep -rn "playwright|run.sh" .github/` returns only two CONTRIBUTING.md mentions. The entire `ci.yml`
  diff is 47 lines: two new `style`-job steps (i18n parity, benchmark provenance) and per-package loops in
  two shards — none of which is e2e.
- Verdict: CONFIRMED.
- Suggested minimal fix: add the job the findings doc specifies (`pnpm --filter @prismshadow/penguin-web
  test:e2e` with `SKIP_BUILD=1` after a build, plus `npx playwright install --with-deps chromium`, gated to
  fail rather than skip), or move the item to the deferred list.

### R3 (MEDIUM) — egress is a property of the sandbox's boot, so a session's later commands keep the first command's network policy

- Location: `packages/server/src/sandbox/microvm/microvm-escalation-runtime.ts:179-189,246-248`
- Concern: `applyEgressPolicy` runs only from `bootSandbox`, and a sandbox is reused across the commands of
  one session keyed by `sessionKey`. So the egress decision of the *first* command governs every later
  command in that session, including a later command whose capability decision is a `deny`. The code
  documents this as intended, but it means R1's (and the fix's) per-command semantics hold only for the
  first command of a session.
- Evidence, `:179-189`:
  ```ts
  const sessionKey =
    (command as IsolatedCommand & { sessionKey?: string }).sessionKey ?? "default";
  let sandbox = this.live.get(sessionKey);
  ...
  if (!sandbox || sandbox.dead) {
    const info = await this.bootSandbox(command, startedAt);
  ```
  and `:246-248` — "a sandbox reused across commands keeps the policy of its boot" — with `applyEgressPolicy`
  called only inside `bootSandbox`.
- Verdict: CONFIRMED as a limitation; the security impact is bounded by R1 (if the boot-time policy were
  actually enforced, the residual exposure would be a session-scope policy stickiness).
- Suggested minimal fix: re-apply the egress policy on every command when it differs from the sandbox's
  recorded policy, or boot a fresh sandbox when the network decision changes.

### R4 (MEDIUM) — `ToolCallIdAllocator.rotate()` resets every held id, contradicting its own docstring

- Location: `packages/core/src/llm/tool-call-ids.ts:87-101`
- Concern: the new public method claims cohort semantics — "Ids seeded or allocated since the last rotation
  survive" — but `this.generation += 1` makes `gen < this.generation` true for *every* existing entry, so
  `rotate()` clears `used`, `suffixedToBase` and `nextSuffix` outright. It has no callers today (verified:
  only `originalIdOf` is reached, and only from `stripToolCallIdSuffix`), so it is inert. The hazard is in
  wiring it: a caller reading the docstring and calling `rotate()` after compaction would free ids that are
  still referenced by surviving history, after which `allocate` can hand out a duplicate `tool_call_id` and
  tool-response matching breaks — precisely what this module exists to prevent.
- Evidence, `:87-96`:
  ```ts
  rotate(): void {
    this.generation += 1;
    for (const [id, gen] of this.used) {
      if (gen < this.generation) this.used.delete(id);
    }
  ```
  Docstring at `:83-86`: "Ids seeded or allocated since the last rotation survive; the compactor re-seeds
  the survivors of the compacted context via `markUsed`/`setHistory` immediately afterwards."
- Verdict: CONFIRMED (logic is unambiguous); impact is latent because nothing calls it.
- Suggested minimal fix: either tag newly-seeded/allocated ids with the current generation and delete only
  entries strictly older than the previous one, or rename the method and rewrite the docstring to say it is
  a full reset that requires the caller to re-seed.

### R5 (HIGH at `33bc0613f`, CLOSED at `90d493d62`) — `packages/desktop` declared `language-porting` but the lockfile's desktop importer did not, so every CI job died at `pnpm install --frozen-lockfile`

- Location: `packages/desktop/package.json:30` vs `pnpm-lock.yaml` importer `packages/desktop` at commit
  `33bc0613f`
- Concern: the PR adds `@penguinharness/language-porting` to `packages/desktop`'s `dependencies` — the one
  field electron-builder collects, and the whole point of the HIGH fix that ships the plugin in the
  installer. At the reviewed commit the lockfile recorded the dependency only under the `packages/core`
  importer (`pnpm-lock.yaml:163`); the `packages/desktop` importer listed `humanizer` and `model-development`
  with no `language-porting` between them. `pnpm install --frozen-lockfile` rejects that state, so the
  entire matrix goes red at the install step before any build or test runs. This is a CI-blocking defect in
  exactly the item the report presents as finished.
- Evidence — at `33bc0613f`, `git show 33bc0613f:pnpm-lock.yaml` around the desktop importer:
  ```
  228:  packages/desktop:
  ...
        '@penguinharness/humanizer':
          specifier: workspace:*
          version: link:../../plugins/humanizer
        '@penguinharness/model-development':        <- no language-porting before this
  ```
  whereas `packages/core` at line 163 does carry it. The hunk list of
  `git diff 26d60a00f 33bc0613f -- pnpm-lock.yaml` confirms a single importer addition (`@@ -160,6 +160,9 @@`).
- Verdict: CONFIRMED at `33bc0613f`. **Closed by `1148279c62`** ("fix(desktop): record language-porting in the
  lockfile's desktop importer"), which is in the ancestry of the final head `90d493d62`: it adds the missing
  entry (`@@ -248,6 +248,9 @@`), and `git diff 33bc0613f HEAD -- pnpm-lock.yaml` is exactly those three
  lines plus the watcher commit's no-op. **Merge `90d493d62` or later and this finding is resolved; merge
  `33bc0613f` and it must go in.**
- Suggested minimal fix: none required past `1148279c62`. For the future, `pnpm install --frozen-lockfile`
  in CI is the gate that catches this — the report's own headline table does not include it, so the
  lockfile/manifest consistency was never verified by any gate named in `bug-swarm/REPORT.md`.

### R6 (LOW) — the deletions left orphaned generators that still read the deleted files

- Location: `audit-donors.cjs:5`, `audit-porting.cjs:2,8`, `build-inventory.cjs:5,25`,
  `extract-giants.cjs:7`, `extract-small.cjs:9`, `scripts/refresh-porting-progress.mjs:28,315,337,432-433`,
  `.dockerignore:60`
- Concern: the PR deletes `porting_progress.json`, `PORTING_MANIFEST.md`, `hport-inventory.json`,
  `hport-audit.json` and the two porting-plan docs, but the scripts that produce and consume them are still
  tracked. None is wired into any `package.json` script or workflow (verified against the root
  `package.json` script list and `.github/`), so nothing breaks today — but the cleanup is half-finished and
  a future `node audit-porting.cjs` dies with ENOENT.
- Evidence: `audit-donors.cjs:5` —
  ```js
  const inv = JSON.parse(fs.readFileSync("hport-inventory.json", "utf8"));
  ```
  with a hardcoded `ROOT = "D:/GitHub/HPORT/extracted"` at line 3, i.e. local scaffolding, not product code.
  `.dockerignore:60` still lists `porting_progress.json`.
- Verdict: CONFIRMED; harmless.
- Suggested minimal fix: delete the five root `.cjs` audit scripts, `plan-refs.txt` and
  `scripts/refresh-porting-progress.mjs` (or move them under `bug-swarm/` with the rest of the porting
  debris, which the PR already excludes from the Docker image), and drop the `.dockerignore` line.

### R7 (LOW) — `bug-swarm/REPORT.md` understates the PR in several places

- Location: `bug-swarm/REPORT.md:98,161-168,188-190,183-184` (and the headline counts)
- Concern: none of these is a code defect; all of them make the report *more* pessimistic than the diff, so
  the risk is a reviewer trusting the report over the code. (a) The release.yml npm-publish E404 loop is
  listed under "deliberately left (CRITICAL by severity, deferred)" with the reason "a change I will not
  ship unverified" — but the fix is shipped, and well: `release.yml:676-706` now reads each dir's real
  package name and skips `private: true`, and `package_version_exists` at `:633-663` distinguishes E404
  (absent → publish) from registry-unreachable (→ `exit 2`). (b) R2 above. (c) The report says
  `probe.test.ts` was left in place for the suite owner; it was deleted (85 lines, `557ad0c2f`), which is
  the better call. (d) "Six plugins missing `description_zh`" is deferred, but all 15 plugins carrying a
  `plugin.json` now have a real Chinese description. (e) "CI test shards mask later failures" is listed as
  deferred, yet the per-package `failed=0; for pkg in …; do …; exit $failed` loops are implemented at
  `ci.yml:103-118`. (f) The core (4020) and server (2251) pass counts do not match my re-run (3999 / 1970);
  the difference is fork-pool spawn failures in this environment, so this is informational, not a
  discrepancy in the PR.
- Verdict: CONFIRMED (each checked against the diff or the tree).
- Suggested minimal fix: reconcile the report with the shipped diff before merge — it is the artifact a
  reviewer will trust.

### R8 (LOW) — `[a-zd]` where `\d` was evidently intended in the new field-name word splitter

- Location: `packages/core/src/internal/credential-redactor.ts:164-173`
- Concern: the docstring says the splitter breaks "at separators, digit runs and camelCase / acronym
  transitions", but both character classes use a literal `d`, not `\d`. It is harmless — `d` is already
  inside `a-z`, and digits are still split out by the `split` (verified by running the function: `password1`
  → `["password"]`, `apiKey2` → `["api","Key"]`) — so this is a typo with no behavioural consequence, not a
  redaction gap.
- Evidence, `:170` and `:172`:
  ```ts
  .replace(/([a-zd])([A-Z])/g, "$1 $2")
  ...
  .split(/[^A-Za-zd]+/)
  ```
- Verdict: REFUTED as a bug; LOW as a typo.
- Suggested minimal fix: `\d` in both classes, or drop the claim about digit runs from the docstring.

### R9 (LOW) — the redactor's "fails closed" choice censors any field whose name contains `key`/`token`/`secret` as a whole word

- Location: `packages/core/src/internal/credential-redactor.ts:148,181-189`; blast radius at
  `packages/server/src/cockpit/ws.ts:468,480-481,784,871,882,940-941`,
  `packages/core/src/fleet/tool-mesh-registry.ts:395,492`, `encrypted-credential-store.ts:353`
- Concern: adding a bare `key` to `DEFAULT_SENSITIVE_FIELDS` is a deliberate design decision ("a redactor
  fails closed") and I am not disputing it. Flagging only the blast radius: `redactObject` wraps cockpit
  WebSocket events, fleet snapshots and tool-invocation audits, so ordinary fields like `primaryKey`,
  `tokenType`, `user_key_id` and a DB row's `key` are now `<redacted>` in operator-facing output. The
  boundary the fix claims does hold exactly as stated — I ran the splitter: `monkey`, `keyword`, `hotkey`,
  `maxTokens`, `keyboard`, `contentType` are NOT censored, while `dbPassword`, `apiSecret`,
  `refreshTokenValue`, `stripeSigningSecret`, `dbKey` are. One genuine narrow regression vs the removed
  anchored regexes: the all-lowercase concatenation `openaiapikey` is no longer matched (it was before);
  `openaiApiKey` still is.
- Verdict: CONFIRMED as described; LOW because it is an intentional, documented tradeoff.
- Suggested minimal fix: none required; if operator noise appears, scope `key` to names ending in `Key`/`key`
  rather than any word.

### R10 (LOW) — stale "not wired" note in the untrusted-content test header

- Location: `packages/core/test/untrusted-content.test.ts:8-11`
- Concern: the test file's opening comment says the sanitizer is "deliberately NOT wired into the tool
  pipeline here — that is a separate design decision for the lead". The lead then wired it into
  `web-search.ts:152` (`renderResults` now returns the sanitized, per-call-fenced block), so the note
  contradicts the shipped state.
- Verdict: CONFIRMED; cosmetic.
- Suggested minimal fix: rewrite the header to say the fence contract is pinned here and enforced at
  `environment/tools/web-search.ts`.

## Post-review commits (`33bc0613f` → `90d493d62`)

The branch advanced twice while I reviewed. Both are reviewed below; neither changes the verdict.

**`1148279c62` — lockfile desktop importer.** Closes R5. Three lines added to `pnpm-lock.yaml`; verified as
the whole of `git diff 33bc0613f HEAD -- pnpm-lock.yaml`.

**`90d493d62` — watch the long form of a directory to avoid libuv's short-name abort.** A real product fix, not
a CI workaround, and correctly scoped. `resolveWatchDir` (`code-graph-watcher.ts:84-107`) translates only the
argument handed to `fs.watch`, via `fs.realpathSync.native()` (the POSIX-style `realpathSync` does not expand
8.3 names). I confirmed the separation claim against both call sites: the recursive path (`:348-358`) still does
its path arithmetic off `this.rootDir` and the fallback (`:408-411`) off `dir`, so map keys, relative paths and
caller-facing event paths keep the caller's own spelling. Non-win32 is a fast `return dir`; a missing directory
falls back to the caller's path and `startWatching` still re-checks existence. The new test is not a self-skip
here — I ran its own `GetShortPathName` helper and this volume *does* generate 8.3 names
(`...\LongWatcherRootName-YG4t3X` → `...\LONGWA~2`, differ=true), so the test built a real short-named root,
wrote a file through it, and asserted the watcher survived (`10/10` pass in `code-graph-watcher.test.ts`; the
core suite at the final head is `4021 pass / 29 skip / 0 fail`, exit 0). That the fix prevents the abort rests
on libuv's `GetLongPathNameW` prefix check (libuv/libuv#5010, nodejs/node#63638) rather than on anything
observable from this repo without reverting, so I mark the mechanism CONFIRMED-present and the abort-prevention
claim PLAUSIBLE-but-unverified. Two nits, neither blocking: the test's `shortPathOf` interpolates the temp path
into a PowerShell command string (safe — `mkdtempSync` emits only hex — but it would break on a quoted path),
and the `if (process.platform !== "win32") return` / `if (shortParent === longParent) return` early exits make
a no-op run report as *passed* rather than skipped, so CI on a volume with 8.3 disabled would silently report
green coverage.

## Spot-checks that PASSED

Each of these I read against the real source and its test; the claimed mechanism is present and the test
would fail without the fix.

- **CRITICAL 1 — sanitizer wired in** (`environment/tools/web-search.ts:140-152`): `renderResults` returns
  `sanitizeUntrustedContent(...).content`; the new assertions (`/^<data_boundary_[0-9a-f]+ source="web_search
  results">/` and a matching close at end) fail outright against the old advisory-text return. Not
  tautological.
- **CRITICAL 1 — the fence itself** (`agent/untrusted-content.ts:63-82`): boundary name is
  `data_boundary_${randomBytes(12).toString("hex")}`; embedded exact-close and any `</…data_boundary`
  case/whitespace variant are entity-mangled; the source label is escaped. 7 tests cover the breakout,
  case/whitespace variants and label escaping; all 192 tests in the security trio's files pass.
- **CRITICAL 2 — Linux watcher fallback** (`agent/code-graph-watcher.ts:271-446`): platform check, one
  non-recursive watcher per directory, runtime directory discovery with a one-time sweep, close-on-removal,
  `node_modules`/`.git`/`dist` etc. excluded from the walk so the fan-out is bounded.
- **CRITICAL 4 — install.sh** (`install.sh:89`): `v[0-9A-Za-z]*` → `v[0-9]*`, so `vfoo` is refused.
- **HIGH — watchdog** (`agent/task-watchdog.ts:94-107,115-134`): `terminalStatus` no longer writes;
  `checkHealth` is a pure read; only `heartbeat()` persists. Polling `isHealthy` can no longer abort a run.
- **HIGH — context compactor** (`agent/context-compactor.ts:33-39,95-105`): summaries tagged
  `compaction-summary-` and skipped. The fixer's own log candidly documents that the summary only ever sits
  at the front of the pool where the fix is inert, and placed the test mid-list where it is load-bearing —
  the correct call, honestly reported.
- **HIGH — turn ledger** (`agent/turn-ledger.ts:327-365`): `trimRecords` refuses to evict past the projection
  watermark; `compact` uses `safeLimit = min(throughSeq, projectionCommittedThroughSeq)`; `pruneStaleAcks`
  only drops acks whose records are already gone.
- **HIGH — quorum** (`agent/quorum-consensus.ts:149-152,193-207`): endorse and refute both reject a settled
  standing; refute rejects refuted and excludes the proposer.
- **HIGH — mailbox** (`agent/mailbox.ts:211-218,369-386`): `poll()` honours a live lease; delivery
  bookkeeping and `deliveryTails` are written only while the subscriber is still registered.
- **HIGH — swarm deadline race** (`agent/swarm-coordinator.ts:417-456`): one `AbortController` per step, a
  100 ms grace window that prefers the handler's real outcome and surfaces its rejection, `rounds:
  currentRound` in the catch path, and all step controllers aborted in `finally`.
- **HIGH — redactor quoted values** (`internal/credential-redactor.ts:82-92`): the value branch now runs to
  the matching closing quote and the quoting is preserved, so `api_secret="a b c d e f g h"` is redacted
  (and no longer reported clean by `containsCredentials`).
- **HIGH — desktop plugin enumeration** (`packages/desktop/package.json:30`): `@penguinharness/language-porting`
  added to `dependencies`, which is exactly what `electron-builder.yml:45` collects into the installer.
- **HIGH — wiki import** (`state/wiki-engine.ts:508-530`, `server/http/routes/wiki.ts:15-29`): null body,
  non-object and id-less elements are rejected; the route degrades to an empty graph instead of 500ing.
- **HIGH — HmrHost.restore** (`server/hmr/host.ts:336-343`): literal-null manifest now returns instead of
  dereferencing outside the try.
- **HIGH — research** (`evidence-verifier.ts:153-161,338-341,461-464`, `research-loop.ts:284-287,482-487`):
  unit-mismatch now emits the previously-dead `unit-missing` reason; polarity/contradiction cues compile to
  `(?<!\w)…(?!\w)` regexes; the fetch cap counts `rawSources.length` (the parse-phase `sources` was always 0
  mid-fetch); the section→question memo is keyed `${sourceId}::${section}`.
- **HIGH — shell-evaluator test / syscall-filter test**: both suites now exist (`192 tests passed` across the
  six security/state files I ran together); the log-only probe is gone.
- **API surface**: `CodeGraph.addEdge` returns `boolean` with dedup + endpoint validation (`code-graph.ts:316-340`);
  all 11 internal call sites ignore the result. `stripToolCallIdSuffix(id, allocator?)` is optional-second-param
  compatible. `@prismshadow/penguin-core/canvas` and `/terminal` are in **both** `package.json` exports and
  `tsup.config.ts`, the barrels re-export only modules that exist, and no package still reaches into
  `core/src` by relative path (git grep finds none). `apiFetch`/`request` widening to `T | undefined` with the
  new `apiFetchJson`/`requestJson` failing on an empty body is a genuine hardening, and web + cli typecheck
  at 0 errors, so the ~230 call-site migration is complete.
- **language-porting**: `plugin.json` category `software-development` exists in `PLUGIN_CATEGORIES`
  (`core/src/plugins/index.ts:345-353`); skill frontmatter names match directory names; the docs table row,
  both READMEs, the landing skills list and the desktop dep all carry the same three skill names; the
  `description_zh` / `short_description_zh` strings are real, natural Chinese, not placeholders; and
  `check:i18n` + `skills --check` both pass. (The lockfile is a separate matter — see R5: at the reviewed
  commit the desktop importer was missing the entry, which `check:i18n` and the skills audit do not and
  cannot catch.)
- **release.yml hardening**: the E404/registry-unreachable split at `:633-663` and the real-name + skip-private
  loop at `:676-706` are correct, including the `else status=$?; [ "$status" -eq 1 ] || exit "$status"`
  handling that makes an unreachable registry fatal while an absent package publishes. The five
  `test-release-publishing.test.mjs` assertions pass.
- **install.sh / desktop signing**: `exit 1` replaces `Write-Error` (`desktop-build.yml:253-258`), and the
  regression test's expectation was updated in the same commit.

## False alarms I checked and dismissed

- **The redactor now over-redacts ordinary words.** Checked by running `splitFieldNameWords` + `isSensitiveField`
  over 24 names: `monkey`, `keyword`, `hotkey`, `maxTokens`, `keyboard`, `contentType`, `HTTPSResponse` all
  read as not sensitive, exactly as the fix claims. The word boundary does the work.
- **`sanitizeUntrustedContent`'s second neutralization pass is redundant with the random boundary.** It is
  defense-in-depth, not dead code: the regex `/<\/\s*data_boundary/gi` also covers the documented constant
  prefix and any case/whitespace variant, and the exact-match pass runs first so the two cannot double-encode.
- **The per-directory watcher will fan out over `node_modules`.** `DEFAULT_IGNORES` excludes `node_modules`,
  `.git`, `dist`, `build`, `target`, `.next`, `.turbo`, `.cache`, `coverage`, `.venv`, `__pycache__` and
  friends, and `collectWatchedDirectories`/`discoverDirectory` both filter through `isPathIgnored`.
- **The egress `EMPTY_ALLOW_LIST` module constant is shared and could be mutated.** It is a `const` array of
  a readonly-shaped type passed to a backend that maps it to strings; no code path mutates it.
- **`rotate()`'s full reset is what the compactor needs.** It is not: the docstring's "survivors" language
  implies selectivity the code does not have. Filed as R4 rather than dismissed, but its severity is capped
  by having zero callers.
- **Deleting `porting_progress.json` breaks `refresh-porting-progress` / the docs or landing builds.** Nothing
  in `package.json` scripts, `.github/`, or any `packages/` source reads it; the only references are the
  orphaned porting scripts in R6. The docs and landing suites — the two that were red on this file — now pass
  at exactly the claimed counts.
- **`apiFetch`'s type widening is a breaking change for consumers.** It is a workspace-internal client, the
  call-site migration is complete (0 typecheck errors), and the new `apiFetchJson` restores the strict
  contract for routes that promise a body. Net hardening.
- **`shell-evaluator`'s `exit` builtin still collapses codes to 0/1.** True, and the new comment overstates
  ("the status survives"), but the behaviour is unchanged from before this PR — pre-existing, not a
  regression.
