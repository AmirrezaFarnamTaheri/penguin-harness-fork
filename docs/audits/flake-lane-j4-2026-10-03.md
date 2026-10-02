# Scheduled retry:0 flake lane (J4) — receipt

**Package:** J4 (Wave 3) — a scheduled, retry-zero lane that records first-attempt failures without
retry masking. **Date:** 2026-10-03 (Asia/Tehran).

## Scope

- **Parent task:** J4, all four sub-requirements (J4.1 ownership, J4.2 effective retry 0, J4.3
  failure capture, J4.4 detection demonstration).
- **Deliverables:** `.github/workflows/flake-lane.yml`; the retry probe
  (`scripts/flake-lane/retry-probe.{test.ts,config.mts}`); the lane checker and its 18 cases
  (`scripts/check-flake-lane.{mjs,test.mjs}`, gated from `ci.yml`'s style job); this receipt; the
  `tasks/todo.md` row.
- **Not in scope:** changing the required lanes' retry policy (deliberate, documented in the
  configs), and merging the lane into the required `ci` aggregate — the card requires the main gate
  to stay independently authoritative.

## Baseline

- Starting HEAD `fbe16690` (J9), Node `v22.22.3`, pnpm `11.18.0`, Linux sandbox.
- Entry state finding: `pnpm check:i18n` was red on that baseline (the I7 route's two error
  codes had no UI messages), so the required `style` job could not have been green. Repaired
  first, in its own commit `04de60ad`, before this package's own checks; the J4 lane changes no
  dictionary.
- Before this package: no scheduled workflow existed; retries were nonzero on two platforms
  (`packages/core/vitest.config.ts` and `packages/server/vitest.config.ts` set `retry: 2` on win32,
  `retry: 1` on darwin, `0` on POSIX) and `ci.yml`'s Windows job re-runs the whole command once for
  a pool-teardown crash; nothing recorded a first-attempt failure anywhere.

## J4.1 — Lane ownership (the frozen decision)

| Decision | Choice |
| --- | --- |
| Schedule | `cron: "40 3 * * *"` (UTC, daily) plus `workflow_dispatch`; a scheduled workflow runs from the default branch, so on this branch it is dispatchable only — the first scheduled run is the post-merge evidence (residual work below) |
| Suite / platform scope | Linux: core, server, web, cli unit shards + browser e2e. macOS and Windows: **core only** — those are the platforms whose configs set a nonzero `retry`, so they are where inheritance would hide a flake; the rest of the matrix is already retry-free on Linux |
| Seed / repetition policy | Vitest shuffle stays off (default order), so there is no random seed to lose; Playwright runs `--repeat-each=1`; the retry probe is the deterministic repetition: it fails attempt 1 and passes attempt 2 |
| Artifact retention | First-attempt logs (one per shard, `tee`d), Playwright log + `test-results/` + `playwright-report/` (traces retained on failure); `retention-days: 14`, uploaded only when the step failed, names carry `github.run_attempt` |
| Alert / flake owner | `# Owner:` line names the release owner (the role in `docs/postmortems/TEMPLATE.md`'s release checklist); GitHub notifies the workflow file's last committer on a scheduled failure; attribution rules are J4's |
| Relationship to the required gate | Not required, not in the `ci` aggregate. A red run here is a finding to record and route (J4 owns attribution); `ci` remains authoritative and unchanged as a gate |

## J4.2 — Effective retry is zero (proof, not assertion)

The probe fails its first attempt and passes its second under a config whose `retry` is 2 — a
stand-in for the Windows/Darwin value the platform configs inherit. Vitest re-runs a failed test in
the same module instance, so the counter survives exactly one attempt boundary and the reproduction
is deterministic.

```console
$ node node_modules/vitest/vitest.mjs run --config scripts/flake-lane/retry-probe.config.mts
 Test Files  1 passed (1);  Tests  1 passed (1)            exit 0   # inherited retry: MASKED
$ node node_modules/vitest/vitest.mjs run --config scripts/flake-lane/retry-probe.config.mts --retry=0
 Test Files  1 failed (1);  Tests  1 failed (1)            exit 1   # lane invocation: CAUGHT
$ RUNNER_TEMP=… bash -c '<the retry-zero-proof step, verbatim>'
 retry probe failed as required: retries are effectively 0  exit 0   # the lane's own gate
$ pnpm --filter @prismshadow/penguin-cli exec vitest run --retry=0 --passWithNoTests
 471 passed (471)                                          exit 0   # the lane's exact command form
```

`scripts/check-flake-lane.mjs` keeps it that way on every required-CI run: it parses the lane and
rejects a missing cron or dispatch trigger, a missing `permissions:` block, a missing `# Owner:`
line, any vitest invocation (in a `run:` body *or* a `strategy.matrix` `tests:` command) without
`--retry=0`, any Playwright invocation without `--retries=0`, any nonzero `--retry=<n>` /
`--retries=<n>`, `continue-on-error: true`, a loop inside a test step, the same suite invoked twice
in one step, a missing `--repeat-each` pin, an artifact upload without `retention-days`, a
retry-probe step without the flag, and a probe config that stopped simulating an inherited retry
(reading the setting, not its mention in prose).

| Command | Result |
| --- | --- |
| `node scripts/check-flake-lane.mjs` | `.github/workflows/flake-lane.yml: retries are zero, no re-run path, artifacts retained` (exit 0) |
| `node --test scripts/check-flake-lane.test.mjs` | 18 tests, 18 passed — 17 mutations of the real lane + the control |
| `node scripts/check-actions-pins.mjs` (J2 policy over the new workflow) | 54 pinned, 16 local, 0 violations |
| actionlint (WASM 2.0.6) on `flake-lane.yml` and the edited `ci.yml` | 0 results each |

## J4.3 — Failure capture

- Every unit shard pipes its single attempt through `tee` into `$RUNNER_TEMP/flake-lane-<shard>.log`
  and uploads it on failure (`flake-lane-<shard>-<run_attempt>`); the browser job uploads its log,
  `packages/web/test-results/` and `packages/web/playwright-report/` with traces forced by
  `--trace=retain-on-failure`.
- The artifact name carries `github.run_attempt`, and the lane never re-labels a failed attempt:
  there is no retry, no `continue-on-error`, and no second invocation of any suite.

## J4.4 — Detection demonstrated

- The fixture is the probe described above; running it under the inherited-retry config passes
  (the flake is masked — what the required lanes do today on Windows/macOS) and under the lane's
  invocation fails (caught). The lane runs it as `retry-zero-proof`, which fails the job if the
  probe ever passes.
- The fixture is deliberately **retained** rather than injected and removed: it lives under
  `scripts/flake-lane/`, which no package's vitest `include` pattern reaches, so it cannot fail a
  package suite; keeping it turns the one-off injection into a permanent self-check that also
  guards the probe config against being weakened to `retry: 0` (checker rule 10).
- Limitation recorded honestly: this sandbox cannot run macOS/Windows or trigger the scheduled
  workflow, so the platform proof is the A/B above (which forces the inherited value through a
  config) plus the lane's own self-check; the first scheduled run on those runners is pending.

## Acceptance

| Criterion | Result |
| --- | --- |
| Scheduled run configuration exists | Proved — `schedule: cron "40 3 * * *"` + `workflow_dispatch`; actionlint clean; the checker rejects its removal or a malformed cron |
| Effective retry is 0 | Proved — probe A/B (masked vs caught, exit 0 vs 1), lane self-check, CLI shard run, static checker over both invocation forms |
| Negatives: inherited platform retries | Rejected — every invocation carries the flag and the probe forces a nonzero config |
| Negatives: shell rerun / whole-command retry | Rejected — the lane has no loop and no second invocation; both are checker rules with fixtures |
| Negatives: missing seed | Rejected — shuffle off, no seed to lose; the probe is the deterministic repetition |
| Negatives: missing artifact | Rejected — first-attempt logs, traces, and 14-day retention on every failure path |
| Negatives: ownerless failure | Rejected — `# Owner:` line, scheduled-failure notification to the last committer, J4 attribution |
| Required main CI stays independently authoritative | Proved — the lane is a separate workflow, not in the `ci` aggregate; `ci.yml` only gained a checker step |

## Verification

| Command | Result |
| --- | --- |
| Probe A/B (above) | exit 0 masked / exit 1 caught |
| Lane self-check step, verbatim | exit 0, "retries are effectively 0" |
| `pnpm --filter @prismshadow/penguin-cli exec vitest run --retry=0 --passWithNoTests` | 471 passed |
| `node scripts/check-flake-lane.mjs` / `node --test scripts/check-flake-lane.test.mjs` | clean / 18 passed |
| `node scripts/check-actions-pins.mjs` | 0 violations |
| actionlint WASM 2.0.6 on both workflows | 0 results |
| `prettier --check` on the lane, scripts, probe, `ci.yml`, `package.json` | clean |
| `pnpm check:i18n` | was red on entry (the I7 route's two codes had no UI messages — repaired in `04de60ad`, see the I7 receipt addendum); passes now: “i18n parity check passed” |
| `pnpm --dir packages/web exec vitest run` | 212 files, 2593 tests passed (after the i18n repair) |
| `node scripts/check-doc-claims.mjs` | “Documentation status claims have valid paths and runtime evidence.” |

## CI

- Package head pushed on `arena/01a0fd8a-penguin-harness-fork`; the new gate runs in the `style`
  job of the next required `ci` run, which is the authoritative record.
- The scheduled lane itself cannot be exercised from this sandbox (no `actions:write` token, and a
  scheduled workflow runs from the default branch): no run is claimed. Its first scheduled run
  after merge is the platform proof.

## Compatibility

- Additive: no production code, no package suite change, no retry policy change in the required
  lanes. The probe is excluded from every package's vitest `include`; the root `check:flake-lane`
  script only runs the checker.
- `ci.yml` gains one step in the already-required `style` job; its aggregate `ci` gate semantics are
  unchanged.
- Rollback: delete the workflow, the probe, the checker and its test; revert the `ci.yml` step,
  the `package.json` script line and the `tasks/todo.md` row.

## Residual work

- **First scheduled run unobserved.** Scheduled workflows execute from the default branch; once
  this branch is merged, the first 03:40 UTC run is the macOS/Windows platform evidence and the J4
  row can move from IMPLEMENTED to VERIFIED. Owner: release owner. Reopen if that run does not
  appear (cron disabled on the repository) or shows an inherited retry (the self-check would fail).
- **No notification channel beyond GitHub's scheduled-failure e-mail.** If flakes need to page
  someone, an issue-opening step with `issues: write` is the next step; it was left out because the
  J2 permission policy allows write scopes only when named per workflow, and the card does not ask
  for paging.
- **The browser lane still cannot run in this sandbox** (Chromium unavailable); that limitation is
  the same one recorded in `docs/audits/ci-repair-2026-10-02.md`.
