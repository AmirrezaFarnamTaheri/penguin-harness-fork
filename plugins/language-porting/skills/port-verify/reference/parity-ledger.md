# Parity ledger template

Paste this into `PARITY.md` beside the ported module at the start of the port, in Phase A of `code-port`. Fill rows as you go — a ledger written at the end, from memory, is a fiction.

The ledger is the single source of truth for a port's state. One row per **observable behavior**, not per function: a function with three distinct outcomes gets three rows.

## Header — pin the oracle

```markdown
# Parity ledger — <module>

- Original: <repo> @ <commit sha> (<path in the source repo>)
- Port:     <repo> @ <commit sha> (<path in the target repo>)
- Original runtime: node <version> / python <version>
- Port runtime:     <runtime + version>
- Environment: TZ=UTC, LC_ALL=C.UTF-8, <any other pins>
- Fixture manifest: sha256sum fixtures/* | tee fixtures.sha256  → <sha of the manifest itself>
- Oracle: outputs captured from the original, committed at <path>; committed <date>
- Acceptance: 100% of rows with source evidence at `verified`;
  zero open P1 or P2 deviations; every `no-source-test` row carries a written test.
- Last differential run: <date>, <command>, <exit status>
```

Pin the original's commit and the environment **before** the first comparison. If either moves, every `verified` row is stale and must be re-run — that is the rule that keeps a ledger honest six months later.

## Row format

```markdown
| # | Behavior | Source evidence | Status | Severity | Notes |
| --- | --- | --- | --- | --- | --- |
```

- **#** — stable id. Never renumber; a row's id is what a deviation report references.
- **Behavior** — the observable outcome, written so a reader who has never seen the source can tell whether the port does it. "Returns the parsed AST for valid input", not "handles parse".
- **Source evidence** — the file and line in the *original* that shows the behavior: a test, a call site, or the implementation line. A row without evidence is a guess.
- **Status** — one of `ported`, `verified`, `deviates`, `no-source-test`, `not-applicable`. Nothing else. A row that is "mostly done" is `ported`.
- **Severity** — only meaningful for `deviates`. P1 / P2 / P3 (see below).
- **Notes** — the deviation's actual behavior on both sides, the decision taken, and the decision's owner.

## Status values — exactly five

| Status | Meaning | What it is evidence of |
| --- | --- | --- |
| `ported` | Implemented in the target language. | Nothing. Not compared yet. |
| `verified` | Ran differentially against the original on real inputs and matched; command and fixture recorded. | Parity, for those inputs, under that environment. |
| `deviates` | Ran and differs. Carries a severity, both behaviors, and a decision. | A known, owned difference. |
| `no-source-test` | The original has no test for this behavior. | A coverage gap. Needs a test written from observed behavior before it can move to `verified`. |
| `not-applicable` | The behavior genuinely does not cross the port. | Nothing — but the one-line reason is required. |

A ledger full of `ported` is a to-do list. A ledger full of `verified` with no `deviates` rows usually means the behavior inventory was too narrow — go back to the public surface and the side effects.

## Severity

| Severity | Meaning | Rule |
| --- | --- | --- |
| P1 | Differs on valid input in a way a user or caller observes. | Never closed by accepting it. Fix it, or the port does not have parity. |
| P2 | Differs on invalid, boundary, or unusual-but-legal input. | Must be fixed, or explicitly owned with a recorded decision and a reviewer. |
| P3 | Cosmetic: log wording, whitespace, ordering of unrelated output. | May ship if recorded and owned. |

## Deviation entry — the required fields

When a row goes to `deviates`, the Notes must carry all five, in this order:

```markdown
1. Original does: <behavior, with the source line>
2. Port does:     <behavior, with the target line>
3. Why:           <root cause — the mapping decision that produced it>
4. Decision:      fix / accept-and-record / escalate
5. Evidence:      <command run, fixture id, both outputs' sha256>
```

A deviation without a root cause is a mystery that will recur elsewhere in the port for the same reason.

## Closing rules

- `ported` → `verified` requires a differential run, not a unit test pass.
- A green unit suite never moves a row to `verified`.
- An oracle is never regenerated from the port. If the golden file must be updated, the row goes back to `ported` and the differential run is redone.
- Changing the original's commit invalidates every `verified` row; re-run them and re-date the header.
- Deleting a row because nobody could verify it is forbidden — it moves to `no-source-test` and stays visible.
