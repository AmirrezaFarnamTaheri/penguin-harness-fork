# Bug Swarm — Security / IDS / Graph Fixer Log

Owner: fixer (security-ids-graph). Files touched: the 9 below + their tests only.
Brief: `bug-swarm/findings/core-agent.md` (original pass records, lead-verified).

| # | File | Bug | Fix (one line) | Tests added | Before → After |
|---|------|-----|---------------|-------------|----------------|
| 1 | `agent/untrusted-content.ts` | [CRITICAL] payload containing `</data_boundary>` closes the fence early; `sourceLabel` interpolated unescaped | Random per-call boundary name (`randomBytes`), neutralize any embedded closing delimiter, escape `&`/`<`/`>`/`"` in the label | 7 (new `test/untrusted-content.test.ts`) | breakout reachable → fence only ever closes once, at the end |
| 2 | `agent/code-graph-watcher.ts` | [CRITICAL] `fs.watch({recursive:true})` silently ignored on Linux → only root-dir files tracked, no error | Platform check; per-directory fallback that walks the tree, watches new dirs on creation, closes watchers on removal; one-shot `warn` | 4 | blind to subdirs on Linux with no signal → subdirs tracked, degradation announced |
| 3 | `agent/sandbox-runner.ts` | [MEDIUM] catch branch returns `allowed:true` + `exitCode:1`, so a spawn failure == a command that ran and failed; fixed shared seatbelt path, dangling on write failure | `allowed:false` + `spawnFailed` + `error` (no `exitCode`); plan resolved inside the guard; per-process `pid`+random profile path, `mode 0o600`; `null` on write failure throws | 4 | ledger would record a never-run command as a failed run → two outcomes distinguishable |
| 4 | `llm/tool-call-repair.ts` | [MEDIUM] dedup key is global, so two legitimate same-name/same-args calls collapse to one | Signature keyed by *first source*: a repeat from a different source is re-extraction (collapsed), from the same source is a distinct call (kept) | 3 | parallel identical calls dropped → both survive; cross-pass dupes still collapse |
| 5 | `llm/tool-call-ids.ts` | [MEDIUM] shape-only `stripToolCallIdSuffix` mangles a legit `…#2` id; `used` never prunes; `allocate` rescans from `#2` (O(n²)) | Allocator is now authoritative (`originalIdOf`) via a reverse index; `rotate()` retires ids at compaction; per-base suffix cursor | 6 | 400 colliding ids rescanned from `#2` each time → monotonic, gap-free; round-trip is exact |
| 6 | `agent/code-graph.ts` | [MEDIUM] `addEdge` neither dedups nor validates endpoints → duplicate edges and dangling adjacency | Dedup on `(source,target,kind,line)` upsert; refuse unknown endpoints; `addEdge` returns `boolean` | 6 | duplicate imports corrupt degree/paths/articulation-points → one edge, broken `fromJSON` edges refused |
| 7 | `agent/signal-chain.ts` | [LOW] `sources`/`signals`/`actions` grow for the life of the process | `releaseSource(sourceId)`: prunes the chain's actions, signals and the source; returns count | 2 | unbounded per-task maps → a retired task's chain is freed, unrelated chains untouched |
| 8 | `agent/agent-name-registry.ts` | [LOW] no `release`; docstring promises names free on release | `release(ownerId)`: frees name + affinity, returns whether it existed; shuffled pool keeps a freed name out of the current cycle | 2 | decorative names accumulate per agent → freed for later cycles, revived owner gets a fresh one |
| 9 | `state/workspace-lease.ts` | [LOW] empty key strings participate in overlap matching and count toward `keys.length` | `normalizeKeys()` normalizes then drops empties in all three entry points; grant-vs-timeout ordering comment + guard | 2 | `""` acts as a wildcard / flips whole-scope logic → all-empty reads as whole-scope, `""` never matches |

## Shape notes

- `CodeGraph.addEdge` changed its return type `void → boolean`. Every internal caller already
  ignored the result; `fromJSON` now silently skips broken edges instead of building dangling
  adjacency. No external API surface changed.
- `stripToolCallIdSuffix(id, allocator?)` — the second parameter is optional, so the two existing
  call sites in `generative-model.ts` keep their shape-only behavior. Passing the allocator is the
  accurate path; wiring it in is a caller decision, not made here.
- `sanitizeUntrustedContent` still has zero callers; the fence contract is pinned but it is **not**
  wired into the tool pipeline by this batch — that is a separate design call for the lead.
- `SignalChainManager.releaseSource` and `AgentNameRegistry.release` are new public methods with no
  callers yet; the lifecycle owner (swarm-coordinator, owned by the state-machines fixer) is the
  intended caller. Kept out of that file per the file ownership split.

## Verification

- Per-file: all 9 test files pass individually (36 new tests total: 2+6+4+4+2+6+3+2+7).
- Full core suite: **3779 passed | 29 skipped | 0 failed** (207 files: 205 passed, 2 skipped), 46s.
- Typecheck: `tsc --noEmit -p tsconfig.json` — exit 0, clean.
- Prettier: `--check` clean on all 18 touched files (9 source + 8 existing test files + `untrusted-content.test.ts` new).

Commands (pnpm/npm stall in this environment — call the binaries directly):

```bash
cd packages/core
node ../../node_modules/vitest/vitest.mjs run test/<file>.ts                          # one file
node ../../node_modules/vitest/vitest.mjs run --passWithNoTests                       # full suite
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json                   # typecheck
cd /d/GitHub/penguin-harness-fork && ./node_modules/.bin/prettier --check <files>      # format
```
