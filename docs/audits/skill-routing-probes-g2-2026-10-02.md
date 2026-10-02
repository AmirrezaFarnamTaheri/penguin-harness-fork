# G2 — Frozen skill-routing probes (2026-10-02)

## Scope

- `packages/core/test/fixtures/skill-routing/` — the frozen corpus: `probes.json` plus 8 fixture
  `SKILL.md` files (7 candidates + 1 deliberately invalid), new;
- `packages/core/test/skill-routing-probes.test.ts` — the deterministic runner, new (21 cases);
- `.github/workflows/skill-integrity.yml` — the routing gate step, added.

Nothing in `packages/core/src/agent/` changed: this package freezes the *observed* routing
behaviour of the shipped resolver and makes a change to it visible.

## Baseline

Routing had unit coverage of the pieces (`skill-engine.test.ts`, `agent-skills.test.ts`) but no
frozen end-to-end corpus: nothing recorded which skill a given prompt actually routes to, no
description was hashed, and a rewrite of a skill's description could move routing without any
test noticing. There was also no CI signal for routing at all — `skill-integrity.yml` validated
identities, metadata, resources and aliases, never behaviour.

## Change

1. **G2.1 — corpus.** 12 probes with expected routed ids, the scored leader, a named scoring
   branch, and a note explaining the arithmetic. Candidates are *bounded per probe*: each probe
   declares the skills it routes among, so adding an unrelated skill cannot silently change an
   outcome, and a probe that should see a new skill is a deliberate corpus edit. Every corpus file
   is pinned by sha256 — 7 synthetic skills, 4 repository skills (`ab-test-setup`,
   `analytics-tracking`, `accessibility-review`, `changelog-automation`) and the invalid fixture.
   The routing rules the probes rely on (ordering, floor, tie, no-match, invalid, fan-out clamp)
   are recorded in the corpus and asserted to be the rules the suite exercises.
2. **G2.2 — real scorer.** Probes run through `SkillRegistry.match`, and the synthetic candidates
   are parsed by `parseSkillMarkdown` from their bytes — no mock formula anywhere. Failure output
   is a trace: probe id and branch, prompt, candidate set, expected, actual, the per-skill score
   with its matched keywords, and the note.
3. **G2.3 — CI gate.** `skill-integrity.yml` runs the suite right after the metadata audit, with
   `--reporter=default --reporter=json --outputFile.json=$GITHUB_WORKSPACE/artifacts/skill-routing-report.json`.
   The default reporter puts the trace in the log; the JSON report is written even on failure and
   is picked up by the existing `artifacts/skill-*.json` upload, so the artifact names the failing
   probe, its prompt and its branch.
4. **G2.4 — sensitivity.** Four mutation fixtures, applied in memory against the frozen skills:
   two that must move routing, one that must not, and the invalid-skill refusal.

## Acceptance — the named outcomes

| Named negative (card) | Where it lands | Outcome |
| --------------------- | -------------- | ------- |
| routing-breaking edit | `mut/description-drops-vocabulary` (widget-sync loses "compare … spaces") | probe `syn/description-tokens-decide` goes 0.21 → no match; the fixture asserts the change |
| benign edit (control) | `mut/description-adds-filler` | routing unchanged — the gate fails on a break, not on any edit |
| scoring tie | `syn/tie-deterministic` (0.37 / 0.37) | stable name ordering, identical with the candidate list reversed; every other routed id sorts ascending |
| empty description | `syn/empty-description` | still routes by name at 0.94; the description branch contributes nothing and does not throw |
| unmatched prompt | `real/no-match`, `real/description-only-below-floor` | empty result; asserted that *no* probe with an empty expectation routes anywhere |
| invalid skill | `broken.md` (frontmatter without `name`) | `parseSkillMarkdown` returns `null` and a candidate naming it fails loudly instead of crashing the registry |
| corpus drift | the hash check over all 12 files | a one-byte fixture edit fails with a message naming the file and telling the reader to update the expectations deliberately |

## Verification

```
node ../../node_modules/vitest/vitest.mjs run test/skill-routing-probes.test.ts
→ Test Files 1 passed (1) | Tests 21 passed (21)

pnpm --dir packages/core exec vitest run test/skill-routing-probes.test.ts \
  --reporter=default --reporter=json --outputFile.json=…/artifacts/skill-routing-report.json
→ 21 passed, JSON report written (the exact CI invocation)
```

Mutations, each applied alone to the shipped scorer or the frozen corpus and reverted:

| Mutation | Result |
| -------- | ------ |
| scorer drops the tag contribution (`score += 0.14` → `0.0`) | 4 failed |
| scorer drops the fan-out clamp (`Math.min(score, 0.19)` → `1`) | 2 failed |
| scorer drops description tokens | 4 failed |
| tie-breaker loses its name comparison | **0 failed — equivalent mutation** |
| a frozen description is edited by one character | 1 failed (drift check) |

The surviving mutation is equivalent on this path, and deliberately recorded rather than papered
over: `SkillRegistry.match` builds its candidate list through `list()`, which already sorts by
name, so removing the name comparison from the tie-breaker cannot change any observable order. The
contract that ties are name-ordered regardless of insertion order is still asserted directly (the
reversed-candidate probe plus the ascending-order check).

## Compatibility / rollback

- The corpus only reads: fixtures, the repository skills tree, and the shipped resolver. No
  product code, no runtime configuration.
- **Rollback for one noisy probe** (owner + expiry, as the card requires): disable that single
  entry in `probes.json` with an `owner` and `expiresOn` field and a note, keep the rest running.
  There is no such entry today, and the corpus contains no probe that is flaky by construction:
  every expectation is a pure function of the frozen bytes.
- Updating a real skill's description means updating its hash and, if the routing moved, the
  probed expectation in the same change — which is the point of freezing both.

## Residual work

- The bounds are deliberate: 4 real skills out of ~2 500, chosen for distinctive names
  (`ab-test-setup`, `analytics-tracking`). Widening to a broader sample is a corpus edit; a
  full-tree probe would be slow and would fail on unrelated additions.
- `real/description-only-below-floor` records a property rather than a defect: description
  vocabulary alone (capped at 0.10) cannot reach the 0.2 floor, so this resolver cannot route on
  description text alone. If that is ever revisited, this probe is the place the change is
  declared.
- Latency is not asserted; the suite runs in well under a second against the bounded corpus.
