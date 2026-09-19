# Core Agent Runtime — Bug Swarm Findings (original pass)

Domain: `packages/core/src/agent/`, `omnimessage/`, `trace/`, `hooks/`, `state/`,
`internal/`, `session.ts`, `agent.ts`, and the `llm/tool-call-*` helpers.

Summary: the runtime is defensively written and clearly hardened by prior bug work
(trace resume, watchdog lease-generation accounting, mailbox lease machinery). The
recurring failure mode that survived hardening is **stateful machinery whose read
paths mutate state, and shared id-keyed maps written but never pruned**: the
watchdog's health *check* flips it terminal, the compactor's own output counts as a
user turn, the ledger's overflow path evicts events for turns whose projection never
caught up, quorum lets a settled topic be un-settled, and the code-graph watcher is
silently inert on Linux. A second cluster is **units mismatch and guard-bypass
surface**: `poll()` ignoring the lease it shares with `pollAndLease()`, the loop
detector keying only on name+canonical-args, and the untrusted-content boundary that
can be closed early by the payload it is supposed to contain.

> Note: this file was overwritten once by a second pass over the research stack; that
> pass is preserved as `core-agent-research.md`. The 17 records below are the original
> pass and are the ones the state-machines and security-ids-graph fixers were briefed
> from. Evidence quotes for each are reproduced in the fixer briefs.

---

### [CRITICAL] Data-boundary wrapper can be closed early by the payload it wraps
- File: `packages/core/src/agent/untrusted-content.ts:46-51`
- Symptom: `sanitizeUntrustedContent` advertises a `<data_boundary>` that makes the
  model treat external content as passive data. A payload containing the literal
  `</data_boundary>` terminates the boundary early, so everything after it reads as
  top-level conversation — the prompt-injection defense is bypassed by exactly the
  untrusted text it exists to fence. `sourceLabel` is also interpolated unescaped,
  so a label containing `"` or `>` breaks the opening tag. LEAD-VERIFIED: the function
  is exported but has ZERO callers and ZERO tests anywhere in the repo.
- Fix: neutralize closing delimiters in the payload; escape `"`/`>`/`&` in
  `sourceLabel`; add tests. (Fix applied: see `bug-swarm/fixes/security-ids-graph.md`.)
- Confidence: high

### [CRITICAL] Code-graph watcher silently inert for every file outside the root dir on Linux
- File: `packages/core/src/agent/code-graph-watcher.ts:271-273`
- Symptom: `fs.watch(this.rootDir, { recursive: true })` — Node documents `recursive`
  as macOS/Windows-only and silently ignores it elsewhere, so on Linux only files
  directly in the workspace root are watched. The knowledge graph drifts out of sync
  with no error and no fallback. LEAD-VERIFIED: no platform check, no fallback, no probe.
- Fix: detect the unsupported case, walk the tree and install one watcher per
  directory, warn once when the capability is unavailable.
- Confidence: high

### [HIGH] Watchdog health *reads* flip it to a permanent terminal state
- File: `packages/core/src/agent/task-watchdog.ts:171-192` (with `126`, `76-78`)
- Symptom: `checkHealth()` calls `terminalStatus(...)` on the total-timeout and
  step-timeout branches, writing `this.terminalState`/`this.abortReason`.
  `isHealthy()`/`getStatusSummary()` invoke it, so a host polling `isHealthy()` while
  `elapsed > totalTimeoutMs` aborts a run whose every step was healthy; once terminal,
  `heartbeat()` short-circuits and the run can never report recovery. LEAD-VERIFIED.
- Fix: `checkHealth()` becomes a pure read returning a derived status; only
  `heartbeat()` transitions to terminal.
- Confidence: high

### [HIGH] ContextCompactor counts its own summary as a user turn
- File: `packages/core/src/agent/context-compactor.ts:165-169` (with `77-87`)
- Symptom: the folded summary is emitted `role: "user"` and `recentTurnStart` counts
  any `role === "user"` as a turn start, so after the first compaction
  `keepRecentTurns: N` protects only N−1 real turns; each further compaction shrinks
  the window, and once only the summary plus one real turn remain the compactor
  reports `skipped` permanently — auto-compaction stops exactly when it is needed.
  LEAD-VERIFIED: `recentTurnStart(pool)` at line 119 is called on the list that
  contains the prior summary.
- Fix: tag summaries and skip them in `recentTurnStart`.
- Confidence: high

### [HIGH] TurnLedger overflow eviction drops events of turns whose projection never acked them
- File: `packages/core/src/agent/turn-ledger.ts:198-211`
- Symptom: when `records.length > maxRecords` and compaction to the projection
  watermark is not enough, the code blindly splices the oldest records — precisely the
  events of completed-but-not-acknowledged turns. `pendingProjections()` groups from
  `this.records`, so those turns can never be replayed, and
  `advanceProjectionWatermark()` breaks at the gap, so the watermark stalls and the
  ledger keeps growing anyway.
- Fix: bound eviction by turn acknowledgment; refuse to evict past the safe point;
  prune `projectionAcks`.
- Confidence: high

### [HIGH] Quorum: a settled topic can be refuted or re-endorsed after settlement; proposer can self-refute
- File: `packages/core/src/agent/quorum-consensus.ts:183-210` (and `140-181`)
- Symptom: `refuteTopic` only guards "not found / empty agent / empty grounds" and never
  checks `standing.status`, so a `settled` topic can be flipped to `refuted` (both
  `settledAt` and `refutedAt` end up set). `endorseTopic` only blocks `refuted`.
  `refuteTopic` also never excludes `proposerId` (endorse does) and counts dead/
  duplicate agents. LEAD-VERIFIED asymmetric guards.
- Fix: reject refutations/endorsements on a settled standing; exclude `proposerId`
  from refuters; make settle/refute mutually exclusive.
- Confidence: high

### [HIGH] `Mailbox.poll()` ignores the lease that `pollAndLease()` enforces; broker resurrects per-subscriber state
- File: `packages/core/src/agent/mailbox.ts:206-215` (lease bypass), `348-386` (resurrection)
- Symptom: `pollAndLease` deliberately returns null while a lease is held, but `poll()`
  shifts the message and increments `attempts` with no lease check, so any consumer
  mixing the two double-processes a reserved message. Separately,
  `EventBroker.enqueueDelivery`'s `.finally` re-creates `pendingBuffers` entries for a
  subscriber whose `subscribe()` cleanup already deleted them.
- Fix: make `poll()` respect an active lease; re-check registration before writing the
  decremented depth.
- Confidence: high

### [HIGH] Swarm step deadline race: a step that succeeds after the timeout is reported as a timeout
- File: `packages/core/src/agent/swarm-coordinator.ts:412-429`
- Symptom: `runWithDeadline` races the handler against a setTimeout and aborts the
  shared `taskAbortController` when the timer wins. If the handler resolves
  microseconds after the timeout rejects, the result is discarded and the task is
  reported `timed_out`; if the handler later rejects the error is swallowed. The same
  controller is shared by every step, so one slow step aborts in-flight work for all.
- Fix: after the timeout wins, await the handler with a short grace window and prefer
  its real outcome; give each step its own AbortController.
- Confidence: high

### [MEDIUM] Swarm catch path reports `rounds: 0` for failures deep in the deliberation loop
- File: `packages/core/src/agent/swarm-coordinator.ts:771-780`
- Symptom: every error/timeout return hard-codes `rounds: 0` although `currentRound` is
  in scope and may be 3 of 4 (compare the success path at `746-755`).
- Fix: return `rounds: currentRound`.
- Confidence: high

### [MEDIUM] MergeQueue: producer count can go negative and permanently hang the consumer
- File: `packages/core/src/internal/merge-queue.ts:23-26`, `43-51`
- Symptom: `removeProducer()` unconditionally decrements; a double deregister drives
  `producers` below zero so `producers === 0` is never true again and `next()` awaits a
  `wake` that never comes — a silent hang. A second consumer also overwrites
  `this.wake`, losing the first waiter's wakeup.
- Fix: clamp with `Math.max(0, ...)` and surface underflow; make waiter registration
  safe against a second consumer.
- Confidence: medium

### [MEDIUM] LoopDetector's cycle detection ignores arguments, so distinct calls are flagged as an infinite cycle
- File: `packages/core/src/agent/loop-detector.ts:184-191` (with `92-94`)
- Symptom: `detectCycle` matches on `toolName` only, so
  `read_file(a) -> grep(x) -> read_file(b) -> grep(y) -> ...` is reported as an
  alternating cycle and `shouldStop: true`, killing a healthy run. `inputHash` is
  computed and stored but never consulted. The history buffer is hardcoded to 20 while
  `maxRepeats` is configurable, so a configured larger value can never fire.
- Fix: compare `toolName` plus `inputHash`; size the history window from the config.
- Confidence: high

### [MEDIUM] Sandbox runner reports a failed/never-spawned execution as `allowed: true`
- File: `packages/core/src/agent/sandbox-runner.ts:183-202`, `85-99`
- Symptom: in the catch branch every result is `allowed: true` with
  `exitCode: (err as any)?.exitCode ?? 1`, so a spawn failure, a missing bwrap binary,
  or a profile error is indistinguishable from a command that ran and exited 1 — and
  `SwarmCoordinator.executeCommand` records exactly that into the turn ledger.
  `ensureSeatbeltProfile` also writes to the constant `os.tmpdir()/penguin-seatbelt.sb`
  (shared across users, a symlink target) and on write failure still returns that path.
- Fix: distinguish "execution failed" from "executed and exited non-zero"; randomized
  per-process profile name with `mode: 0o600`; return null on write failure.
- Confidence: high

### [MEDIUM] Kanban: terminal and non-in_progress tasks can be re-claimed; expired claims in `review` are never reclaimed
- File: `packages/core/src/agent/kanban.ts:352-399` (claim), `457-484` (reclaim)
- Symptom: `claimTask` only refuses a live competing claim when
  `task.state === "in_progress"`, so a `done`/`failed`/`archived`/`review` task can be
  handed a fresh lease (un-completing its assignee while `completedAt` stays set).
  `reclaimExpiredLeases` only inspects `state === "in_progress"`, so a task parked in
  `review` with a dead worker's expired claim is stuck forever, blocking its
  dependency chain.
- Fix: refuse to claim terminal tasks; extend the live-lease guard to any state;
  reclaim any task with an expired `claimExpires` regardless of state.
- Confidence: high

### [MEDIUM] `scavengToolCalls` collapses genuinely distinct duplicate calls into one
- File: `packages/core/src/llm/tool-call-repair.ts:135-137`
- Symptom: dedup key is `${name}::${JSON.stringify(args)}` across the whole message, so
  two legitimate parallel calls with the same name and args (a retry after a transient
  error, or two `read_file` calls on the same path from different branches) are silently
  dropped to one — the exact failure sibling `tool-call-ids.ts` was written to prevent.
- Fix: scope `seenCalls` per source block rather than across the whole message.
- Confidence: medium

### [MEDIUM] `stripToolCallIdSuffix` strips any trailing `#<digits>`; `used` set never prunes
- File: `packages/core/src/llm/tool-call-ids.ts:49-51`, `33-40`
- Symptom: on resume the strip is by shape alone, so a provider id that legitimately
  ends in `#2` is restored to a different id than the registry allocated and pairing
  fails. `ToolCallIdAllocator.used` accumulates for the whole session with no pruning at
  compaction-rotation, and `allocate` rescans from `#2` on every collision (O(n²)).
- Fix: only strip on a resolvable collision (record the mapping at allocation);
  prune `used` when the owning history is compacted away.
- Confidence: medium

### [MEDIUM] `CodeGraph.addEdge` neither deduplicates nor validates endpoints
- File: `packages/core/src/agent/code-graph.ts:310-330`
- Symptom: `updateFile` rebuilds `imports` edges from `summary.imports` and from every
  other file's stored `imports` on each change. A file with two import statements
  resolving to the same module produces duplicate edges that accumulate in
  `outgoing`/`incoming` and corrupt `getAllEdges()`, `shortestPath`, impact radius and
  `findArticulationPoints`. `addEdge` also accepts endpoints with no node, leaving
  dangling adjacency that `removeNode` never cleans up.
- Fix: dedup on `(source, target, kind)` (upsert); refuse edges with unknown endpoints.
- Confidence: high

### [LOW] Unbounded id-keyed maps across the runtime
- Files: `signal-chain.ts:84-86`, `agent-name-registry.ts:8-12` (docstring promises
  "reservations survive release" but no release method exists), `mailbox.ts:75`
  (`deadLetters`), `quorum-consensus.ts:71` (`standings`)
- Symptom: for a long-lived swarm/coordinator process these grow monotonically with the
  number of tasks, agents and dead-lettered messages; nothing bounds them.
- Fix: add an LRU/retention bound or an explicit `release`/`prune` per completed task.
- Confidence: medium

### [LOW] `WorkspaceLeaseManager` empty key strings participate in matching
- File: `packages/core/src/state/workspace-lease.ts:147-171`, `314-342`
- Symptom: a request whose `keys` array contains `""` (a caller bug or empty path)
  silently participates in key-overlap matching, and `""` counts toward `keys.length`,
  flipping whole-scope vs per-key conflict logic; `tryAcquire`/`acquire` never filter.
- Fix: drop empty normalized keys before conflict matching; treat an all-empty array as
  whole-scope. (Secondary: grant-vs-timeout ordering — add a test.)
- Confidence: medium
