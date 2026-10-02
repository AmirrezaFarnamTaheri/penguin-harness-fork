# B4 — Transactional compaction + prune frontier (2026-10-02)

## Scope

One package, two boundaries, both named by the card:

- the **compaction commit transaction** — `packages/core/src/engine/context-engine.ts` (the swap in
  `startNewContext`, guarded by a new `validateOpenedContext` candidate check);
- the **prune frontier** — new `packages/core/src/internal/prune-frontier.ts`, wired into the
  bounded archive's capacity path in `packages/core/src/environment/truncated-tool-output-archive.ts`.

The card's start path `packages/core/src/agent/resource/compaction/` does not exist in this tree;
the real compactor boundary is the engine file above, and it is where the transaction was pinned.
`packages/core/src/agent/tool-result-retention.ts` (the other prune-side module) is **not** the
frontier surface: it computes a *score*, has no directory, no persistence and no "skipped block"
to re-read — the bounded store's eviction loop is the only place a repeated prune can re-scan.

## Baseline

| Observable | Before |
| ---------- | ------ |
| invalid opener result | adopted blindly: `startNewContext` assigned whatever `openNextContext` resolved, then moved `pendingTraceRotation`, `sessionTurns` and `lastRequestTotal`. A non-context (`{ llm: null }`) surfaced later as an unrelated `TypeError` from the next request, with the rotation flag already set |
| repeated oversized archive write | every attempt re-listed the archive directory and re-`lstat`ed every `.log` file to reach the same `ARCHIVE_FULL` |
| prune decision memory | none; kept/derived decisions were re-derived per call |
| compaction stage contract | implied by tests, never stated as a survivable-IDs inventory (B4.1) |

## Change

1. **`validateOpenedContext`** (context-engine.ts, module level): refuses a candidate that is not an
   object, whose `llm` is missing or cannot `streamGenerate`, whose `sessionMeta` is not an
   OmniMessage, whose `maxTurns` is not a finite number, or whose `compaction` is not a settings
   object — thrown with the `openNextContext returned an invalid context: …` prefix, **before** the
   swap block runs. The swap is documented as synchronous-by-contract (no `await` inside it), and the
   `startNewContext` doc block now carries the B4.1 inventory: per stage (trigger → fold →
   generation → serialization → commit) the source IDs / frontier values that must survive, plus the
   failure rule for each stage.
2. **`prune-frontier.ts`**: a pure decision function (`planPrune`) over an explicit directory listing
   — `fits` / `drop` / `blocked` / `cached-blocked` — with `kept` (retained context that is never a
   drop candidate), `examined`, `passes`, and an optionally persisted
   (`serializePruneFrontier` / `parsePruneFrontier`) frontier keyed on the **directory mtime**.
   Requirements are monotone, so a recorded block answers any *larger or equal* requirement without
   listing anything; a smaller requirement or a changed directory forces a real scan.
3. **Archive wiring** (`truncated-tool-output-archive.ts`): `makeRoomFor` now consults and updates the
   frontier; eviction still unlinks oldest-first and still refuses a write that cannot fit; the
   frontier is loaded/persisted through a new optional `pruneFrontierPath`. The archive root is
   deliberately not used as a default location — an existing E10.4 test pins that directory to the
   `.log` files the class writes, and the directory listing remains the authority for the byte bound.

## Acceptance — evidence

Named suites (all green after the changes, run from `packages/core`):

```
node ../../node_modules/vitest/vitest.mjs run \
  test/compaction.test.ts test/prune-frontier.test.ts test/truncated-tool-output-archive.test.ts
→ Test Files 3 passed (3) | Tests 81 passed (81)
```

- `test/compaction.test.ts` 49 → **52** cases:
  - *a malformed opener result is refused before the swap, and the retry commits it* — two refusals
    (missing `llm`; present but not streamable), each asserted to happen with the old object still
    current, zero calls on the candidate, the same Trace path and a single file on disk; then the
    valid third candidate commits exactly one swap, the summary is what the new context receives,
    and the deferred rotation splits the file on the next write (B4.2/B4.4);
  - *a Trace write/rotate failure during compaction does not change the outcome or tear the swap* —
    a `TraceSink` whose writes fail from the compaction on and whose `rotate` always throws: the
    compaction still completes, the summary still reaches the new context, the acknowledged bytes on
    disk are append-only, and the file index never moves (B4.4 write failure);
  - *a failed compaction attempt resends the byte-identical folded input, tool ids included* — the
    failed attempt and its retry produce `JSON.stringify`-identical inputs, the folded tool call id
    (`c1`) is present in both, and only the committed summary feeds the new context (B4.1/B4.4).
- `test/prune-frontier.test.ts` (**new**, 16 cases): fits/drop/blocked algebra; oldest-first order;
  a kept name never dropped even when oldest and largest; retained context survives later passes
  without being re-declared; a blocked requirement is answered with `examined: 0` and **no listing
  at all**; a larger requirement is answered from the same decision; a smaller one rescans and
  clears the block; a changed directory mtime invalidates the cache; forward progress past a kept
  oversized block; pass counting; round-trip + rejection of malformed/foreign-version frontier data;
  deterministic serialization. Two end-to-end cases drive the real archive: a restart reuses the
  persisted frontier (second refusal adds nothing to `examined`, then a fitting write still saves),
  and the failure-injection case (`ENOTDIR` frontier path) keeps the bound's refusal honest and the
  valid path working.
- `test/truncated-tool-output-archive.test.ts` unchanged, 13 cases still green — the E10.4
  oldest-first/restart/refusal contract is intact under the new capacity path.

Mutations (each reverted after the run; all four B4-specific ones red):

| Mutation | Result |
| -------- | ------ |
| kept names become droppable (`if (false) continue`) | 4 failed |
| cached-blocked fast path removed | 3 failed |
| pre-scan block for over-budget requirements removed | 2 failed |
| untrusted frontier version accepted | 1 failed (fixture strengthened for this) |
| opener `llm` presence check removed | 1 failed |
| opener `streamGenerate` check removed | 1 failed |
| `validateOpenedContext` call removed | 1 failed |

## Verification

`node node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json` → clean.
`prettier --check` on the five touched/added files → clean (each file `--write`n first).

## Compatibility

- `validateOpenedContext` only rejects results that were already unusable; every valid `OpenedContext`
  (all optional fields absent included) passes unchanged, so existing openers — including the ones
  that return `{ llm }` and nothing else — keep working.
- The frontier is off by default: without `pruneFrontierPath` it lives in memory, and the directory
  remains the authority for the bound, so a restart without a persisted frontier behaves exactly as
  before. `ARCHIVE_LIMITS`, the drop log (`RECALL_DROPPED_LOG_LIMIT`), the recall store's own
  lifetime and every drop reason are unchanged.
- No new dependency; the frontier module imports nothing.

## Residual work

- The frontier does not yet cover the **recall** store's eviction (`enforceRecallBounds`), which
  refuses rather than evicts and so has no "blocked repeat" to memoize; worth revisiting only if a
  recall-side scan cost shows up.
- `drop_call`-style retention scoring (`tool-result-retention.ts`) is still untested and still only a
  score; connecting it to the frontier would need a caller that owns a directory.
- A persisted frontier is only produced where a host passes `pruneFrontierPath`; no host does yet
  (the archive is constructed by `Environment`, which has the Session scratchpad to place it in).
