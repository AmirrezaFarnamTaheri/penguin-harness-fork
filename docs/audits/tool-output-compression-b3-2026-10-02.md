# B3 — Measured opt-in tool-output compression (2026-10-02)

## Scope

Three files, one boundary (the tool-output compression path):

- `packages/core/test/fixtures/output-compression/` — the frozen corpus (8 fixtures +
  `manifest.json`), new;
- `packages/core/test/environment/output-compression-corpus.test.ts` — the corpus suite, new;
- `scripts/measure-output-compression.mts` + `artifacts/output-compression-savings.json` — the
  reproducible measurement and its committed output, new;
- `packages/core/src/environment/output-compression/strategies.ts` — one behaviour fix (the
  log-dedup tail reservation) and the doc table replaced with the reproducible numbers;
- `packages/core/test/environment/output-compression.test.ts` — the one existing assertion that
  pinned the old (head-only) cut updated to the new guarantee.

No new strategy was added and no class was enabled that was not already shipped: B3's job here was
to *measure* the shipped set, freeze the inputs, and fix what the measurement exposed.

## Baseline

| Observable | Before |
| ---------- | ------ |
| fixtures | inline string builders inside the test file: no hashes, no command/exit-code metadata, no way to tell whether a fixture had drifted |
| savings table | a hand-written table in the module doc, from captures that are not in the repository — unreproducible |
| per-class floor | asserted per fixture in prose, not mechanically against a frozen corpus |
| failure gate under budget pressure | **broken for logs**: `fitToBudget` kept leading lines only, so a unique trailing `ERROR` line was cut from a deduplicated log and replaced with `[N more log-dedup lines not shown]` — the exact line a model needs |

The last row was found by the corpus on its first run, not by inspection: the 87 812-byte log
fixture compresses to 15 953 characters and the trailing `ERROR [pool] upstream timeout` was
among the dropped lines.

## Change

1. **B3.1 freeze.** Eight raw outputs committed as files, each pinned by sha256 and byte size in
   `manifest.json`, with its class, command, exit code, expected decision, per-fixture saving floor
   and a note; a 400-character fixture that must *not* compress is included so the floor's lower
   edge is part of the corpus rather than an anecdote.
2. **B3.3 fix — the failure signal must survive the budget, not just the dedup.** `fitToBudget`
   gained an optional tail reservation (`finish(..., reserveTailChars)`), used by `log-dedup` with a
   fifth of the budget. The visible text is still the original lines in their original order:
   head, then the counted gap marker, then the tail. The regression test asserts the trailing
   `ERROR` line is the last visible line and that the head half still carries the deduplicated
   count.
3. **B3.3 proof.** The corpus suite encodes the three non-negotiables as tests: promised failure
   markers survive every failing fixture; a compressed body may never read as a clean run
   (asserted against success-shaped summaries) while the exit code stays outside the compressible
   text; and the transformation is deterministic (two runs produce identical bytes) with the
   original recoverable through the recall handle the collector attaches.
4. **B3.4 decision.** `scripts/measure-output-compression.mts` recomputes bytes/chars, the
   bytes/4 token *estimate* (labelled as an estimate — the module ships no tokenizer), median warm
   latency, per-class savings and the ship/drop verdict, writes
   `artifacts/output-compression-savings.json`, and exits non-zero if any shipped class falls under
   10 %. The module's doc table now cites these corpus numbers and names the command that
   regenerates them.

## Acceptance — the measured table (frozen corpus, 16 000-character budget)

| class | chars in | chars out | saved | shipped |
| ----- | -------: | --------: | ----: | ------- |
| `git-log` | 72 982 | 7 668 | 89.5 % | yes |
| `test-runner` | 93 975 | 15 673 | 83.3 % | yes |
| `log-dedup` | 87 812 | 15 910 | 81.9 % | yes |
| `git-status` | 7 829 | 1 744 | 77.7 % | yes |
| `git-diff` | 18 942 | 7 536 | 60.2 % | yes |
| `lint` | 10 472 | 9 200 | 12.2 % | yes |

Every shipped class clears the card's 10 % floor; nothing was dropped, so the drop list is empty.
One fixture (`small-passing-vitest.txt`, 88 chars) is a documented **pass-through**: the strategy
declines rather than announcing a loss that would cost more than the text it replaced. The
rejected *context-trimming* transform for `git diff` remains rejected and documented in the module
(the `@@` counts would become lies).

## Verification

```
node ../../node_modules/vitest/vitest.mjs run test/environment/
→ Test Files 6 passed (6) | Tests 117 passed (117)      (corpus suite: 8 of them)

node --import tsx scripts/measure-output-compression.mts
→ writes artifacts/output-compression-savings.json; exit 0 (all classes >= 10%)
```

Mutations (each applied alone and reverted):

| Mutation | Result |
| -------- | ------ |
| `log-dedup` loses its tail reservation | 2 failed |
| the tail window is not subtracted from the head budget | 1 failed |

`tsc --noEmit -p packages/core/tsconfig.json` clean; `prettier --check` clean.

## Compatibility

- The default remains raw: `compressOutput` returns `null` for anything unclassified, below the
  win floor, or over budget, and the caller ships the text unchanged. Nothing in the tool-result
  path changed except the log-dedup fit.
- The tail reservation changes the *shape* of an over-budget log-dedup result (head + marker +
  tail instead of head + marker). That is a visible change for that one class, which is why the
  existing assertion was updated rather than left to fail; recall ids and their contents are
  untouched, so previously issued ids keep working.
- Latency is reported but never asserted: it is machine noise, and the corpus floor is the
  contractual part.

## Residual work

- The corpus is representative, not exhaustive: it does not include CRLF fixtures, a
  `read_file`-guttered *failing* run, or a runner whose format changed. Each is a candidate
  addition; the freeze makes adding one a deliberate act.
- Latency numbers in `artifacts/output-compression-savings.json` are regenerated by the script and
  will differ between machines — the artifact is advice, the corpus and the floor are the contract.
- `lint` ships at 12.2 %, close to the floor; a future format change that removes the stripping
  opportunity should fail the corpus run rather than ship a net loss (that is the intended
  behaviour, noted here because it is the class most likely to trip it).
