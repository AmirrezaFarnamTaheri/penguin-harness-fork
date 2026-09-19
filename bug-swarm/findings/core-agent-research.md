# Core Agent Runtime — bug swarm findings

Domain: `packages/core/src/agent/` (incl. `research/`), `packages/core/src/omnimessage/`,
`packages/core/src/trace/`, `packages/core/src/hooks/`, `packages/core/src/state/`,
`packages/core/src/internal/`, plus `session.ts` and `agent.ts`.

## Summary

The runtime's structural core is in good shape. Trace replay (`trace/resume.ts`), the
omnimessage builders and streaming aggregator, the hook runners (`hooks/*.ts`), atomic
writes, memory scoping (`state/memory.ts`) and the research budget/retry layer are all
careful, defensively-written code with the invariants they need stated in comments and
actually upheld. I found no crash-on-corruption, no unbounded recursion, no silent
data-loss bug in those paths.

The defects cluster in two places. First, the **research verification stack**
(`agent/research/`): `evidence-verifier.ts` has a unit-mismatch branch that is a literal
no-op and a polarity-conflict detector that matches cue words as bare substrings, so
"innovation"/"notably" flip verdicts; `research-loop.ts` keys its section→question memo on
the heading string alone, so every paper after the first inherits the first paper's
question mapping, and its fetch-phase target guard can never fire. Second,
**heuristic-index code that the agent uses for code-graph features**
(`symbol-indexer.ts`, `code-graph.ts`) has off-by-design column tracking and
suffix-matching that manufactures graph edges that don't exist. `kanban.ts` has one real
lease-enforcement gap (claimable `review`-state tasks). Everything else is dead code.

No finding requires an architectural change; all are local.

---

## 1. Unit-mismatch detection in `findNumeric` is a no-op

- **File:** `packages/core/src/agent/research/evidence-verifier.ts:324-328`
- **Symptom:** A quantity whose value is found in the source but with an incompatible
  unit (claim "5 %", source says "5 ms") is returned as a match anyway. Numeric distance
  is then computed across units, so 5 vs 5 is distance 0 → the claim is verified as
  **supported** against a source that never stated it. The branch that was written to
  handle this returns the same value both ways.
- **Evidence:**
  ```ts
  if (best && quantity.unit && best.unit && !unitsCompatible(quantity.unit, best.unit)) {
    // Unit mismatch: report the located value so the caller can see the disagreement.
    return best;
  }
  return best;
  ```
- **Fix:** Make the branch consequential — either return `undefined` (treat as not-found,
  which the caller already downgrades to `unsupported`) or return a sentinel that lets
  `verify()` emit a `unit-missing` mismatch. `NumericMismatch.reason` already has a
  `"unit-missing"` variant that nothing currently produces.
- **Confidence:** high — both branches return `best`; the code is unambiguous.

## 2. Polarity cues matched as bare substrings

- **File:** `packages/core/src/agent/research/evidence-verifier.ts:444-448` (cues at `78-92`)
- **Symptom:** `POLARITY_CUES` are tested with `window.includes(cue)`, so the cue `"no"`
  matches "innovation", "know", "knowledge", "now", and `"not"` matches "notably". Any
  claim whose key term sits within 70 chars of such a word *and* a contradiction cue
  ("however", "unlike", …) is reported `contradicted` — a false refutation in the
  synthesis's "Contested findings" section.
- **Evidence:**
  ```ts
  const window = sourceLower.slice(Math.max(0, index - 70), index + 40);
  const hasNegativePolarity = POLARITY_CUES.some((cue) => window.includes(cue));
  const hasContradictionCue = CONTRADICTION_CUES.some((cue) => window.includes(cue));
  if (hasNegativePolarity && hasContradictionCue) return true;
  ```
- **Fix:** Match cues on word boundaries — precompile each cue to
  `(?<!\w)cue(?!\w)` and test with the regex, or tokenize the window and do set
  membership. `"fails to"`, `"does not"` etc. are multi-word, so a token-set approach
  needs phrase handling; the boundary-regex route handles both.
- **Confidence:** high — `"no"`/`"not"` as substrings of common English words is
  straightforwardly a false-positive generator.

## 3. Section→question memo keys on heading text, not on source

- **File:** `packages/core/src/agent/research/research-loop.ts:476-490`
- **Symptom:** `sectionToQuestion` is keyed by the raw section heading string. Headings
  repeat across papers ("Introduction", "Results"), so paper #2's "Introduction" claims
  are attributed to whatever question paper #1's "Introduction" mapped to. Because
  `claimToQuestion` feeds `expandContradiction`, a contradiction in a later paper expands
  the *wrong* plan question, and `verificationSummary`/plan QoS figures inherit the
  misattribution.
- **Evidence:**
  ```ts
  private bindClaim(claim: Claim, source: SourceRecord, section: string): Claim {
    const id = `${source.hit.id}#claim_${this.claimCounter++}`;
    this.claimToSource.set(id, source.hit.id);
    const questionId = this.sectionToQuestion.get(section) ?? this.questionForSection(section);
    if (questionId) {
      this.sectionToQuestion.set(section, questionId);
  ```
- **Fix:** Key the memo on `${source.hit.id}::${section}` (or drop the memo and just call
  `questionForSection` per claim — the scoring loop is cheap and the memo's only purpose
  is avoiding a rescan).
- **Confidence:** high — `section` is the bare heading, `source` is in scope and unused
  in the key.

## 4. Fetch-phase target guard can never fire

- **File:** `packages/core/src/agent/research/research-loop.ts:274-286`
- **Symptom:** `fetchPhase` is meant to stop once `targetPapers` useful papers are in
  hand, but `this.sources` is only populated in `parsePhase`, which runs *after* fetching.
  During `fetchPhase` `this.sources.length` is always 0, so the loop runs until the queue
  empties or the paper budget is exhausted — fetching far more papers than the loop
  intends, and charging the whole paper budget in one phase.
- **Evidence:**
  ```ts
  while (this.queue.length > 0 && this.budget.canFetch()) {
    const hit = this.queue.shift()!;
    ...
    this.rawSources.push({ hit, text });
    ...
    if (this.sources.length >= this.targetPapers) break;   // sources is filled in parsePhase
  }
  ```
- **Fix:** Track the count of fetched raw sources (`this.rawSources.length`) or of
  successfully parsed papers via a counter the parse phase increments as it goes — or
  move the cap into `canFetch`, which already takes a paper count.
- **Confidence:** high — `this.sources.push(record)` appears only in `parsePhase`
  (`:302-304`), and `run()` calls `fetchPhase()` before `parsePhase()`.

## 5. `addNode` preserves `text` but not `fetched`

- **File:** `packages/core/src/agent/research/citation-network.ts:69-76` (with `:108`)
- **Symptom:** Re-adding a paper without text keeps the earlier text (good) but recomputes
  `fetched` from the new, textless write (`fetched: Boolean(paper.text)` → `false`). The
  node then carries full source text while reporting unfetched, so `verifyMarkers`
  reports its citations as `"unfetched-node"` hallucinations and `report().coverage`
  undercounts. Any caller that upserts a node (e.g. metadata first, then text) hits this.
- **Evidence:**
  ```ts
  addNode(node: CitationNode): string {
    const existing = this.nodes.get(node.id);
    this.nodes.set(node.id, { ...node, text: node.text ?? existing?.text });
  ```
  …and the writer:
  ```ts
  fetched: Boolean(paper.text),
  ```
- **Fix:** Preserve `fetched` alongside `text` when the incoming node has no text:
  `fetched: node.fetched || existing?.fetched`, or derive it from the merged text.
- **Confidence:** high — the text-merge line is right there and `fetched` is plainly not
  given the same treatment.

## 6. `claimTask` only protects an in-progress lease

- **File:** `packages/core/src/agent/kanban.ts:363-369`
- **Symptom:** The "already claimed" guard fires only when
  `task.state === "in_progress"`. A task in `review` still holds an `assignee` and a live
  `claimExpires` (completion states clear them; `review` doesn't), so a second worker can
  `claimTask` it out from under the first with no error, bumping `leaseGeneration` and
  silently invalidating the original worker's lease identity.
- **Evidence:**
  ```ts
  if (task.assignee && task.assignee !== assignee && !isExpired && task.state === "in_progress") {
    throw new Error(
      `Task is already claimed by ${task.assignee} until ${new Date(task.claimExpires ?? 0).toISOString()}`,
    );
  }
  ```
- **Fix:** Drop the state conjunct — any task with a live, unexpired lease held by another
  worker should refuse — or enumerate the states that may be re-claimed.
- **Confidence:** medium-high — the guard's state condition looks intentional, but the
  lease-identity contract (`assertActiveLease` in the same file) treats `review` as
  still-leased everywhere else, so this is an inconsistency rather than a deliberate
  policy.

## 7. Block-comment skipping loses column tracking

- **File:** `packages/core/src/agent/symbol-indexer.ts:552-563`
- **Symptom:** While skipping a `/* … */` comment, only `\n` updates `line`/`col`; every
  other consumed character leaves `col` unchanged, so all token columns after a block
  comment are understated by the comment's width. A second defect: `/*/` (a complete
  comment — the closer is at positions 1-2) is scanned as unterminated because the opener
  consumes positions 0-1 first, then looks for `*/` only from position 2.
- **Evidence:**
  ```ts
  if (ch === "/" && content[i + 1] === "*") {
    i += 2;
    while (i < len - 1 && !(content[i] === "*" && content[i + 1] === "/")) {
      if (content[i] === "\n") { line++; col = 1; }
      i++;
    }
    i += 2;
    continue;
  }
  ```
- **Fix:** Increment `col` for each consumed non-newline character, and scan for the
  closer starting at the character after the opener (or check for `*/` before advancing).
- **Confidence:** high — the `\n` branch is the only `col` update inside the loop.

## 8. Import specifier matching is pure suffix comparison

- **File:** `packages/core/src/agent/code-graph.ts:104-110`
- **Symptom:** Non-relative imports are matched to a file when either path is a suffix of
  the other. `import "react"` matches any file named `react.ts` anywhere in the graph;
  `import "@/utils/index"` matches `src/index.ts`. Every such match becomes a real
  `imports` edge in the code graph, so `explainConcept`/`getImpactRadius`/`explore`
  report dependencies that don't exist.
- **Evidence:**
  ```ts
  const normImp = stripExt(normalizePath(imp));
  return (
    normTarget.endsWith(normImp) ||
    normImp.endsWith(normTarget) ||
    normTarget.endsWith(`${normImp}/index`)
  );
  ```
- **Fix:** Require the suffix to align on a path boundary (compare on `"/" + normImp` vs
  `"/" + normTarget`), and for bare specifiers match the last segment only against the
  file basename plus a configured extension set.
- **Confidence:** medium — the looseness is visible, but the surrounding tests may pin
  the behaviour deliberately for workspace-relative resolution; confirm against the
  code-graph test fixtures before tightening.

## 9. Dead `NUMBER_WORD` constant with a malformed alternative

- **File:** `packages/core/src/agent/research/claim-extractor.ts:69-70`
- **Symptom:** `NUMBER_WORD` is declared and never imported or used anywhere in
  `packages/core/src` (grep finds only its own declaration). Its `" hundred"` alternative
  also carries a stray leading space, so it would not match "100" as a word-number even
  if it were wired in.
- **Evidence:**
  ```ts
  const NUMBER_WORD =
    /(?:\d+(?:[.,]\d+)?)|(?:one|two|...|fifty| hundred|thousand|million|billion)/gi;
  ```
- **Fix:** Delete it, or wire it into `extractQuantities` if number-word support is
  intended (fixing the space first).
- **Confidence:** high — grep across `packages/core/src` returns only line 69.

## 10. Dead duplicated verdict return in `decide()`

- **File:** `packages/core/src/agent/research/evidence-verifier.ts:253-255`
- **Symptom:** The last two arms of `decide()` are identical, so the third is unreachable.
  Harmless, but it obscures the actual fallback policy (a claim with zero coverage should
  arguably be `unverifiable`, not `unsupported`).
- **Evidence:**
  ```ts
  if (coverage >= this.coverageThreshold && mismatches.length === 0) return "supported";
  if (coverage > 0 && mismatches.length === 0) return "unsupported";
  return "unsupported";
  ```
- **Fix:** Collapse to two arms, or make the final return `unverifiable` if that is the
  intended semantics for a claim with no overlap with its source at all.
- **Confidence:** high.

## 11. Duplicated abort check in `runHookScript`

- **File:** `packages/core/src/hooks/script-hook.ts:61-63`
- **Symptom:** The `opts.signal?.aborted` guard is written twice around a single
  `JSON.stringify`. Harmless leftover; the second copy is dead.
- **Evidence:**
  ```ts
  if (opts.signal?.aborted) throw new Error("aborted");
  const serializedInput = `${JSON.stringify(input)}\n`;
  if (opts.signal?.aborted) throw new Error("aborted");
  ```
- **Fix:** Remove one. (The post-`addEventListener` recheck at `:125` is a different,
  correct race guard — keep that.)
- **Confidence:** high.

---

## Examined and clean

`trace/resume.ts`, `trace/writer.ts` (pairing backfill, dangling-compaction closure,
tolerant JSONL parse), `omnimessage/builders.ts`, `omnimessage/aggregate.ts`,
`omnimessage/reasoning-normalizer.ts`, `omnimessage/artifact-extractor.ts`,
`hooks/tool-hook.ts`, `hooks/stop-hook.ts`, `hooks/script-hook.ts` (except finding 11),
`internal/atomic-write.ts`, `internal/credential-redactor.ts`, `internal/ports.ts`,
`state/memory.ts`, `agent/research/research-budget.ts`,
`agent/research/hypothesis-planner.ts`, `agent/research/paper-parser.ts`,
`agent/research/citation-network.ts` (except finding 5).

## Not verified this pass

`session.ts` and `agent.ts` were read only in part earlier in the swarm
(`session.ts:440-739`, `agent.ts:985-1224`); the remaining bodies — especially the turn
loop, compaction trigger and subagent spawn paths — were not re-read end to end this
session and are not covered by the findings above. `internal/session-support.ts`,
`internal/server-lifecycle.ts`, `state/agent-state.ts`, `state/paths.ts`,
`state/kernel-update.ts`, `agent/code-graph-watcher.ts` and `agent/skill-engine.ts` were
read earlier but not re-verified; findings from them were excluded rather than reported
from memory.
