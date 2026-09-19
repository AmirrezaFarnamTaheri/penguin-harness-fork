---
name: port-verify
description: Prove a port behaves like its original — build a parity ledger covering every public behavior, run the port against the ORIGINAL on the same inputs with byte-identical fixtures, compare per case, record each deviation with source evidence, and define what verified means before anyone is allowed to call the port done.
---

# Port Verify

The gate that stops a false "done". A compiled port with green tests has proven only that the target language can run — it has not proven the port behaves like the original, because the port's own tests were written for the port and would pass equally against a subtly different program. Verification here is **differential**: the original and the port are fed identical inputs, and their outputs are compared. Nothing else counts as parity evidence.

The discipline is adversarial, not optimistic. Your default assumption is that the port diverges somewhere you have not looked, and the job is to find that place before a user does — in production, where the input was never in the test suite.

## Before you start

- If the message only names this skill without a ported module to verify, ask for both sides: the original source and the ported target. Verifying a port against nothing but its own tests is not verification.
- Establish what "the original" means exactly: the source at which commit. Pin it, record the commit hash in the ledger, and never verify against a moving target.
- Agree the acceptance bar up front, in writing, before the first comparison — see "Acceptance" below. A bar set after seeing the results is not a bar.
- Confirm the environment the original ran in: Node/Python version, timezone, locale, environment variables, and any fixture paths. The port runs under the *same* conditions, or the comparison measures the environment, not the code.

## The parity ledger

The ledger is the single source of truth for the port's state. Start it in Phase A of `code-port` and keep it current; a ledger written at the end, from memory, is a fiction. One row per *observable behavior*, not per function:

| # | Behavior | Source evidence | Status | Notes |
| --- | --- | --- | --- | --- |
| 1 | `parse(input)` returns the AST for valid input | `test/parse-valid.test.ts:12` | verified | |
| 2 | `parse(broken)` throws `ParseError` with line and column | `test/parse-errors.test.ts:40` | verified | |
| 3 | `parse(broken)` includes the offending byte offset | `test/parse-errors.test.ts:58` | **deviates** | port reports code-point offset; source is byte offset. Fix, or accept P2 |
| 4 | integer keys of an object iterate ascending | `test/order.test.ts:9` | ported | not yet differentially run |

Status values, and no others:

- **ported** — implemented in the target; not yet compared. Not evidence of anything.
- **verified** — ran differentially against the original on real inputs and matched, with the command and fixture recorded.
- **deviates** — ran and differs. Carries a severity, the source evidence of what the original does, and the port's actual behavior.
- **no-source-test** — behavior the original has no test for. Requires a test written from observed behavior before it can move to verified.
- **not-applicable** — the behavior genuinely does not cross the port (a debug helper used only by the source's tooling). Requires a one-line reason.

The template, ready to paste, is in [`reference/parity-ledger.md`](reference/parity-ledger.md).

Build the ledger from the module's public surface, not from your reading of its internals: every exported function, every documented error condition, every observable side effect (stdout text, stderr text, exit codes, file writes, log lines), and every behavior a test asserts even if it looks accidental. The behaviors no test covers are the ones the port breaks first.

## Differential testing

1. **Take cases from the real source test suite.** Its tests encode what actually matters to the system. Ported-from-scratch cases encode what the porter thought mattered. The first is evidence; the second is narrative.
2. **Fixtures must be byte-identical across both sides.** Copy the fixture file; never re-type it, never re-serialize it through either language's JSON, and never generate it twice. Record each fixture's SHA-256 in the ledger — `sha256sum fixtures/*.json | tee fixtures.sha256` — so a fixture that drifts is caught rather than silently re-baselined.
3. **Run the original first, capture its output, and commit the capture.** The capture is the oracle. If the original changes, the comparison becomes meaningless; a committed oracle is what makes a run repeatable next month.
4. **Run the port on the same inputs, byte for byte, and compare per case.** Not in aggregate — a pass rate hides the one case that differs, and the differing case is the entire point.
5. **Normalize only what is genuinely environmental, and record every normalization.** Absolute paths, timestamps, process IDs, temp directory names, random seeds. If you normalize a field, the ledger says which field and why; an unrecorded normalization is an assumption that the port matches where it does not.
6. **Assert on the oracle's bytes, not on a re-parsed interpretation.** Compare the raw output buffers. Re-parsing both sides through the port's types silently forgives every difference the port's type system cannot express.
7. **Run the boundary cases deliberately, in both harnesses**: empty input, single-element input, maximum-size input, Unicode beyond the BMP, negative and zero numbers, paths with spaces and with non-ASCII, the exact error paths, and a timeout case if the subsystem has timing semantics. These are where ports diverge and where test suites are thinnest.
8. **Seed every source of randomness** in both harnesses, or assert on a distribution. Unseeded nondeterminism converts real parity failures into flakes and flakes into ignored failures.

## Golden and golden-differential

- **Golden test** — the port's output is compared against a committed expected-output file. Fast, local, catches regressions in the port. Its weakness: the golden file was generated by the port itself at some point, so it blesses whatever the port did then, right or wrong.
- **Golden-differential test** — the port's output is compared against the *original's* output on the same input, either captured-ahead (committed oracle) or live (both binaries invoked in the test). This is the only form that detects a port which is self-consistent and wrong.
- Ship both: golden tests for fast regression coverage in CI, golden-differential for the parity claim. Never let the golden file be regenerated by the port and then counted as evidence — regenerating the oracle from the thing under test is how a whole port goes wrong quietly.
- **A green test suite is never promoted into a completion claim.** "All tests pass" is a statement about the tests you wrote, not about parity. The completion claim cites the ledger: N behaviors verified, M deviations at stated severities, and the acceptance bar met.

## The differential run, concretely

The harness is small and it should be — anything large enough to have its own bugs becomes the thing you are debugging instead of the port. Shape:

```bash
# 1. Pin the fixtures, once. This file is committed; it is what makes a
#    drifted fixture visible instead of silently re-baselined.
sha256sum fixtures/* | tee fixtures.sha256

# 2. Capture the oracle from the ORIGINAL at the pinned commit.
#    Commit the capture. It is now the thing the port is measured against.
node --version                       # pinned in the ledger header
pnpm test -- --reporter json > oracle.json     # or the source's own runner
sha256sum oracle.json                # recorded in the ledger

# 3. Run the PORT on the same fixtures, under the same environment pins.
TZ=UTC LC_ALL=C.UTF-8 cargo run --release -- fixtures/ > port.json
sha256sum port.json

# 4. Compare raw bytes first; only fall back to structured comparison if
#    the two formats genuinely differ (then compare fields, not re-serialized).
diff oracle.json port.json && echo PARITY || echo DIVERGENCE
```

Four properties the harness must have, and losing any one of them silently destroys the evidence:

- **Reproducible** — the ledger header alone is enough to rerun the comparison: the original's commit, the runtimes, the environment pins, the fixture manifest, the commands. A harness that needs you to remember a flag is not evidence next month.
- **Per-case** — an aggregate pass/fail hides the one divergent case, and that case is the entire finding. Report per-fixture status, and surface the first divergence rather than soldiering on.
- **Byte-faithful** — compare raw output; normalize nothing without recording it in the ledger. Re-serializing both sides through the port's types forgives every difference the port's type system cannot express.
- **Adversarial** — the fixtures include the boundary cases from the divergence catalog below, not only the ones the source's test suite happened to cover. A harness built from the existing tests measures coverage transfer, not parity.

When a run diverges, the harness owes you the *case*, not just a failure: fixture id, both outputs, both shas, and the ledger row id. A harness that reports "1 of 47 failed" without naming which one costs more time than it saves.

## Verifying a partially-ported system

The port is being verified while both implementations are live — that is the whole point of the stub-first order, and it is what makes a false "done" tempting. Three regimes, in escalating order of evidence:

- **Shadow mode** — the seam routes every input to both the original and the port, the original's answer is served, and the port's answer is logged for comparison. Zero user risk; collects parity evidence on real production traffic. Requires that the comparison be async and never on the user's path, and that you diff the logs per case rather than eyeballing them.
- **Canary** — a fraction of traffic is served by the port, with a kill switch and a monitored error budget. Evidence about *behavior under load and under real input distribution*, which fixtures rarely reproduce. A canary without a defined rollback trigger is not a canary, it is a launch.
- **Full cutover with the original retained read-only** — the port serves everything; the original is kept for differential questions for one release cycle, then deleted. Retaining it longer is not caution — two implementations of one behavior drift, and the drift is invisible because nobody compares them.

In every regime, the ledger stays the arbiter. Production telemetry tells you the port does not crash; it does not tell you the port matches. Only the differential comparison does.

## How ports silently diverge

The catalog. Each entry says how it hides and how to catch it. Read it before writing the harness, and read it again when a run is "almost clean".

- **Integer and float width.** `number` is f64 and Python `int` is unbounded; `i32` truncates, `f32` loses precision, `usize` is platform-dependent. *Hides:* values only exceed the range on large production inputs. *Catch:* fixtures with values near every width boundary, negative numbers, and a precision-sensitive float case; assert on the serialized value, not the in-memory type.
- **Error versus exception.** The port returns a recoverable error where the original threw, or vice versa; callers that used to crash now continue on garbage. *Hides:* the difference only shows when the caller's behavior depends on it, and unit tests rarely cover the error path. *Catch:* run error-path cases end-to-end through a caller, not just the function; assert the *outcome* (exit code, returned value, continued state) rather than the error type.
- **`null` vs `undefined` vs `None`.** Collapsed into one sentinel during the port; a caller that distinguished them now takes the wrong branch. *Hides:* both branches look correct in isolation. *Catch:* fixtures that exercise all three states explicitly, with assertions on which branch ran.
- **`NaN`, `Infinity`, signed zero.** Comparison and sort behavior differs across languages; `NaN !== NaN` in one language and sorts first or last depending on the comparator. *Hides:* no fixture ever includes NaN. *Catch:* put NaN, `Infinity`, `-0.0` and `-Infinity` in the sort and comparison fixtures deliberately.
- **Ordering and nondeterminism.** Map iteration, `Promise.all` completion, set iteration, stable vs unstable sort, tie-break order. *Hides:* correct on small inputs, divergent on inputs with hash collisions or ties. *Catch:* fixtures with ties and with many keys; assert full output order, not a set; pin the iteration unit (byte vs code point vs UTF-16 code unit).
- **Off-by-one on ranges and slices.** Half-open vs closed intervals, inclusive `..=` vs exclusive, end-of-string slicing, and the index *unit* for text. *Hides:* only at boundaries — empty range, single element, last element, one-past-the-end. *Catch:* fixtures at exactly 0, 1, and the full length, plus every boundary on a multi-byte-string fixture.
- **Locale and timezone.** Sort order for strings, number formatting, date formatting, day-of-week, first-day-of-week, case folding. *Hides:* correct in the developer's locale, wrong elsewhere. *Catch:* pin `TZ` and locale identically in both harnesses and run at least one case under a non-default locale; never let either harness inherit the ambient environment.
- **Async timing and scheduling.** Which task completes first, whether cancellation actually stops work, whether a timeout fires. *Hides:* timing-dependent behavior under load. *Catch:* deterministic seeded scheduler where the runtime allows it; otherwise assert on observable side effects (did the cancelled task write the file?) rather than on timing.
- **Resource lifetimes and cleanup order.** File descriptors and locks released at GC vs at scope exit; destructor order; temp-file cleanup. *Hides:* fd exhaustion or a locked file on Windows, only after many iterations. *Hides harder:* the port passes every functional test. *Catch:* run the long-lived loop case and the many-iterations case, and assert the system-level side effects (open handle count, files present after exit).
- **Side-channel output.** Log text, stdout/stderr split, exit codes, progress output, file permissions. *Hides:* nobody asserts on them, so they drift freely. *Catch:* capture and compare stdout, stderr and the exit code as separate fields in the differential harness; they are part of the contract.
- **Precision of the comparison itself.** Comparing floats with `==`, comparing structured output after re-serialization, normalizing a field that actually differed. *Hides:* the harness reports parity because the harness was built to. *Catch:* compare raw bytes where possible; for floats, compare with a tolerance you chose and recorded, and report the case's actual max delta.

## Performance is behavior, when the contract says so

If the port's stated goal includes performance — it usually does — then latency and throughput are part of the parity ledger, not a separate concern. But they are unlike functional behavior in one way: they are distributions, not values. Comparing single timings is comparing noise.

- Assert on a **distribution** under a fixed, recorded methodology: p50/p95/p99 over N iterations after a warmup, with the machine, the CPU governor state, and the concurrency level recorded in the ledger header.
- Compare against the **original measured on the same machine, same conditions, interleaved** — run both in the same session, alternating, so drift during the run hits both.
- Treat a big-O regression as a parity bug even when the constant factor improves: a port that is faster at n=100 and quadratic where the original was linear has changed behavior, and the ledger row says so.
- Record the measurement of the **original before the port is measured against it** — the same committed-oracle discipline as functional output. A perf number regenerated later, on a warmer or busier machine, is not comparable.
- Never report a speedup that is within the measurement noise as a speedup. If the confidence interval overlaps, the port is *equal*, and saying otherwise is how ports get shipped for no gain and a maintenance cost.

## Acceptance

Define before the first run, in the ledger's header:

- **Parity threshold** — the fraction of ledger rows at `verified`, e.g. "100% of rows with source evidence, and every remaining row either `deviates` at P3 or lower or `no-source-test` with a written test". A percentage without a denominator definition is decoration.
- **Deviation budget** — no P1 (behavioral difference visible to users on valid input) and no P2 (difference on invalid or boundary input) unfixed-and-unowned. P3 (cosmetic: log wording, whitespace) may ship if recorded and owned.
- **A P1 is never closed by accepting it.** If a P1 cannot be fixed, the port does not have parity; the ledger records it as an open blocker, and the completion claim says the port is *not* verified. Accepting a P1 silently is how a port ships wrong on purpose.
- **What "verified" means for this module** — spelled out, per module: which fixtures, which commands, which environment, and the commit hash of the original. Future-you should be able to rerun the exact comparison from the ledger alone.

## Handoff

- Deliver the ledger: counts by status, every `deviates` row with its severity, source evidence, the port's actual behavior, and the decision on it.
- Deliver the differential harness as a thing that runs: the commands, the fixture SHA-256 manifest, the pinned original commit, and the environment flags. A verifier who cannot rerun your comparison has your word, not evidence.
- Report the checks you actually ran with their outcomes and exit statuses. Never report an unobserved check as passed, and never report a suite as green when a case was skipped to make it so.
- State what is **not** verified, first in the list: behaviors at `ported` or `no-source-test`, paths with no differential coverage, and any case that flaked during the run. The unverified list is the honest deliverable; a ledger with no open rows usually means the ledger is incomplete.
- "The port is verified" is a claim about the ledger, not a feeling. If the bar is not met, say so plainly and name what remains — that answer is more useful than a premature "done".
