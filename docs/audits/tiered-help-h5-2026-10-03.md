# Tiered CLI help (H5) — receipt

**Package:** H5 (Wave 3) — tiered help with a short default, an explicit full inventory, and a
documented middle depth. **Commit:** `6a7db4a1`. **Date:** 2026-10-03 (Asia/Tehran).

## Scope

- **Deliverable:** `--help-mode simple|default|full` over the single existing command registry, the
  width-adaptive layout, one real bug fix in the unknown-command path, tests, and the user-facing
  docs for the three depths.
- **Not in scope:** H6's command-hint graph (depends on this package) and any change to command
  behavior or option parsing other than the `usage-error` walk fixed here.

## Baseline

- Starting HEAD `8f9de2c9` (I7 receipt); Node `v22.22.3`, pnpm `11.18.0`.
- Before this package every `--help` invocation printed the same flat inventory: no mode flag, no
  tiering, no width handling; `usage-error` skipped a registered option's *flag* but not its
  *value* when walking argv for an unknown command.

## Change

| Path | Change |
| --- | --- |
| `packages/cli/src/help-modes.ts` (new) | `HELP_MODE_FLAG`, mode parsing, `COMMAND_TIERS`, `helpWidth` (56–100, default 80), `commandInMode` (fails **open** for unclassified commands, with `unclassifiedCommands` for review), `fitDescription`, `ancestorOptions`/`NAVIGATIONAL_OPTIONS`, `wrapText` |
| `packages/cli/src/index.ts` | Applies the mode before `parse`; a malformed mode prints the localized `invalidMode` plus a usage hint, exits 1, and never echoes the offending value; `--help`, bare invocation and `-v, --version` exit 0 |
| `packages/cli/src/i18n.ts` | `help` block (labels, `moreCommands`, `invalidMode`) + `globalOptionsLabel` (en “Global options:” / zh “全局选项：”) |
| `packages/cli/src/usage-error.ts` | Unknown-command walk consumes a registered option's value, so `--help-mode simple logss` still suggests `logs` |
| `packages/cli/test/help-modes.test.ts` (new) | 13 cases: mode parsing, width clamps, live-registry tier filtering + `unclassifiedCommands` fixture, description truncation, en/zh labels, 50-column terminal, nested command page, inherited-options fixture, exit semantics, unknown command in every mode |
| `packages/docs/content/cli.{en,zh}.md` | “Help has three depths” bullet documenting simple/default/full |

Tier shape: `simple` = `auth, server, chat, run, logs, recall, version`; `default` adds
`web, ls, input, agent, project, config, cost, schedule, org, update`; `full` adds every remaining
command plus a “Global options:” section listing inherited root options (minus the navigational
`-h, --help`, `-v, --version`, `--help-mode <mode>`) and a wrapped pointer to the other depths.

## Acceptance

| Criterion | Result |
| --- | --- |
| Three depths, one registry (no duplicated command list) | Proved — tier filter reads the live registry; the fixture-only section proves inherited-option rendering |
| Unclassified commands never disappear from `default`/`full` | Proved — `commandInMode` fails open; `unclassifiedCommands` is asserted against the real registry |
| Width-adaptive output with clamps | Proved — 56–100 clamp, default 80; 50-column terminal case |
| Malformed mode is rejected without echoing input, exit 1 | Proved — case asserts stderr label + exit code |
| Unknown-command suggestion survives an option value | Proved — `--help-mode simple logss` → suggests `logs` (bug fixed in `usage-error.ts`) |
| Docs describe all three depths in both languages | Proved — `cli.en.md` / `cli.zh.md` |

## Verification

| Command | Result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run test/help-modes.test.ts` (in `packages/cli`) | 1 file, **13 tests passed** |
| `node node_modules/vitest/vitest.mjs run` (full `packages/cli`) | 34 files, **471 tests passed** |
| `node node_modules/typescript/bin/tsc --noEmit -p packages/cli/tsconfig.json` | clean |
| `node scripts/check-doc-claims.mjs` | “Documentation status claims have valid paths and runtime evidence.” |
| `prettier --check` on the seven changed paths | clean |
| Mutation battery M1–M5 (no tier filtering / unclassified hidden / clamp removed / malformed silently defaulted / descriptions never shortened) | 2 / 2 / 1 / 1 / 2 cases red — every mutant killed, sources restored |

## CI

- Package head `6a7db4a1` pushed to `arena/01a0fd8a-penguin-harness-fork`; the GitHub checks for
  that exact SHA are the authoritative record and were not re-queried here. `packages/cli` is
  covered by the repo's `web/CLI` lane; no CI claim is made beyond the observed runs above.

## Compatibility

- Additive CLI surface: without `--help-mode`, output is the `default` depth, which for the real
  registry is a subset of the previous flat inventory (commands the tier table classifies as
  advanced move behind `--help-mode full`, and the pointer names that flag).
- No config, API, or on-disk behavior changes; no migration. `usage-error`'s walk fix only makes a
  previously lost suggestion appear.
- Rollback: revert the two new/changed source files, the test, the i18n block and the two docs
  bullets; nothing else imports `help-modes.ts`.

## Residual work

- **H6 (command-hint graph)** is unblocked by this package and remains OPEN.
- No snapshot test of the rendered `full` page against a frozen registry dump; the live-registry
  assertion covers tier membership, and a frozen golden would need a registry fixture.
- Tier table is hand-maintained in `COMMAND_TIERS`; the fail-open default plus
  `unclassifiedCommands` is the guard, but a new command lands in `default` only when classified.
