# Wave 2 — Core hardening execution cards

Documentation reconciled on 2026-10-04. Current status and release gates are in
[todo.md](todo.md) and [work-orders.md](work-orders.md); these requirements and historical
observations do not certify the changed working tree.

Read [implementation-guide.md](implementation-guide.md) first. State is recorded only in
[todo.md](todo.md). Inspect existing implementations before extending them. Dependencies gate
consumer integration; independent discovery and fixtures may run across all phases in parallel.
Current release repairs are recorded separately in [work orders](work-orders.md#review-repair-orders).

## Verification lanes used below

Use `rtk proxy pnpm --dir packages/core exec vitest run test/<named-suite>` for core cases,
and the corresponding server/web/cli directory for their cases; package-local configuration
controls timeouts, retries and isolation. Split mixed-package verification into separate lanes.
New cases belong in the indicated owning suite or a named new suite created by the package.
Re-read package scripts/config before execution. Build current core runtime exports
before testing server consumers; run touched-package static checks once per coherent slice.
Required full CI and review apply at task/release acceptance, not after every edit.

<a id="a1"></a>

## A1 — Promote the typed failure classifier

**Depends on:** A2, A3 and an explained shadow corpus. **Start here:**
`packages/core/src/fleet/provider-gateway.ts`, `packages/core/src/llm/`,
`packages/core/test/fleet/`, `packages/core/test/llm/`.
**Outcome:** one typed classifier controls active credential/retry decisions.

1. <a id="a1.1"></a>**A1.1 — Census:** freeze a full-release log/fixture window; record traffic coverage, corpus
   hash, all `agrees=false` cases, `KNOWN_DIVERGENCES`, reasons and owning decision. Empty logs
   qualify only with demonstrated traffic/fixture coverage.
2. <a id="a1.2"></a>**A1.2 — Precedence:** map `generative-model` and credential-rotation decisions for
   400/401/403/429, malformed responses and conflicting signals. Resolve rate-limit-first versus
   auth-first precedence in one typed table; preserve actual provider error detail.
3. <a id="a1.3"></a>**A1.3 — Wiring:** route both consumers through the accepted classifier. Gate/remove shadow
   diagnostics after comparison and retain a reversible active-policy selector.
4. <a id="a1.4"></a>**A1.4 — Promotion:** prove zero unexplained disagreements, one decision per response,
   correct retry/disable outcomes and changed classification-rate monitoring; attach the exact
   candidate receipt and rollback flag.

**Acceptance:** prose never selects failure kind; non-rate-limit errors remain distinct from
429; every explained divergence has a stable fixture and reason. **Verify:** owning LLM/fleet
suites plus the hashed disagreement table. **Rollback:** select the previous classifier;
retain trace/corpus for comparison without exposing credentials.

<a id="a4"></a>

## A4 — Pool-aware bounded retry policy

**Depends on:** A3. **Start here:** `packages/core/src/llm/retry-policy.ts`, engine/model account
selection; `packages/core/test/llm/retry-policy.test.ts`, `retry-runtime.test.ts`.
**Outcome:** one bounded budget owns retry attempts and per-account grace.

1. <a id="a4.1"></a>**A4.1 — Branch table:** enumerate pool sizes 0/1/2/3+, 429/non-429, short/long delays,
   available/cooling accounts, exhausted budgets and cancellation. Record source-to-row mapping.
2. <a id="a4.2"></a>**A4.2 — Policy:** retain attempts `pool<=1 ? 3 : clamp(pool*2,4,12)`, first-round 50 ms fast
   rotation, <=5 s grace in place, >5 s rotation when pool>2, linear 2 s fallback capped at 5 s,
   and single-account 429 capped at 10 s. Grace is consumed once per account within the budget.
   An empty pool cannot manufacture an account or issue a request.
3. <a id="a4.3"></a>**A4.3 — Consumers:** verify ordinary turns, account selection and compaction use one budget
   for transport failures and unusable summaries. Apply the repository's declared jitter after
   determining the policy delay; document units and final ceilings.
4. <a id="a4.4"></a>**A4.4 — Timers:** prove every row with fake timers, bounded total attempts, no repeated 50 ms
   exhaustion loop, cancellation during cooldown, and no retry after budget end.

**Acceptance:** parsed A3 delay retains provenance; grace cannot be spent twice on one account;
termination is observable and the legacy selector is reversible. **Verify:** the two named
suites and relevant engine cases; record the complete table. **Rollback:** select the prior
policy; no persisted-state migration is required.

<a id="a5"></a>

## A5 — Snapshot-to-delta reassembly

**Depends on:** stable stream adapter contract; discovery is ready. **Start here:**
`packages/core/src/llm/stream-reassembler.ts`, `packages/core/test/llm/stream-reassembler.test.ts`.
**Outcome:** snapshot rewrites yield a correct visible view and Unicode-safe deltas.

1. <a id="a5.1"></a>**A5.1 — Reference:** map existing `apply(target)`/`finalize()` behavior: extension emits
   suffix; prefix truncation emits nothing; rewrite uses a rune-safe LCP and explicit view
   resynchronization where append-only deltas cannot represent the target.
2. <a id="a5.2"></a>**A5.2 — Boundaries:** preserve surrogate-clamped UTF-16/byte conversion,24-rune hold-back,
   incomplete `<details`/quote holds and release of reasoning before content overtakes it.
3. <a id="a5.3"></a>**A5.3 — Corpus:** run 500 seeded edit sequences including prefix deletion, astral text,
   partial delimiters and reasoning/content crossing; retain seed and target/output hashes.
4. <a id="a5.4"></a>**A5.4 — Integration:** inventory actual provider consumers. Prove the exported utility's
   scoped contract; integrate an adapter only through a recorded compatible reset/delta seam.
   Record clearly whether runtime consumption has been established.

**Acceptance:** finalized view equals target; emitted bytes are valid UTF-8; incompatible
rewrites explicitly reset/resync. **Verify:** named suite plus adapter fixture when wired.
**Rollback:** preserve the old adapter selector until real-stream corpus equivalence is proved.

<a id="a6"></a>

## A6 — Bounded length-prefixed frame parser

**Depends on:** no other task. **Start here:** `packages/core/test/llm/frame-parser.test.ts`
and its imported parser. **Outcome:** a reusable parser has bounded buffer and explicit terminal states.

1. <a id="a6.1"></a>**A6.1:** reconcile the existing parser/export and completed scoped receipt; map framing
   markers, length units, maximum size, EOF and malformed-frame semantics.
2. <a id="a6.2"></a>**A6.2:** preserve cross-chunk length/payload handling, astral payload, resync, EOF flush,
   and marker-not-length reference shapes.
3. <a id="a6.3"></a>**A6.3:** cover over-limit frames, EOF inside length/payload and recovery after malformed
   frames; prove a terminal error cannot continue growing the buffer.
4. <a id="a6.4"></a>**A6.4:** record optional provider-consumer integration separately from this library task.

**Acceptance:** the five reference shapes and bounded/error cases pass; parser modes remain
explicit. **Verify:** named suite. **Rollback:** use the old parser only for its proven framing
mode. The existing verified task is not reopened merely to rebuild its module.

<a id="b1"></a>

## B1 — Session-owned output spill and opaque recall

**Depends on:** B2. **Start here:** `packages/core/src/environment/environment.ts`,
`truncated-tool-output-archive.ts`, `tools/recall-output.ts`; environment, engine and archive tests.
**Outcome:** oversized tool text remains useful inline and recoverable without exposing file paths.

1. <a id="b1.1"></a>**B1.1 — Threshold:** verify configured inline `maxOutputLength`, including an explicit 40 KiB
   boundary fixture and agent-origin inline behavior. Preserve complete terminal failure evidence
   and useful failure head/tail; binary files remain outside this text contract.
2. <a id="b1.2"></a>**B1.2 — Archive:** redact recognized credentials before persistence/display; store under
   owning Session and emit opaque `{recallId,sizeBytes,tokenCount}` metadata. `tokenCount` is an
   identified bytes/4 estimate. Freeze the tool outcome before auxiliary archive I/O.
3. <a id="b1.3"></a>**B1.3 — Recall:** verify bounded pages, the actual offset unit, surrogate-safe progress,
   Session ownership, expiry and stable issued IDs across restart. HTTP/CLI consumers enforce
   the same authenticated session/project scope; an ID does not replace authorization.
4. <a id="b1.4"></a>**B1.4 — Failures:** exercise long non-zero stderr, NUL/control text, split multibyte data,
   denied archive writes, expired/wrong-Session IDs and capacity. Capacity preserves still-valid
   issued IDs; archive failure remains explicit and the original tool outcome stays truthful.
5. <a id="b1.5"></a>**B1.5 — End to end:** the Agent calls `recall_output` on a later turn and reconstructs the
   persisted redacted text. Refresh default-tool hash/version when the actual default changes.

**Acceptance:** no archive path reaches model metadata/query strings; paged recall reconstructs
the promised bounded archive after redaction; failed commands never appear successful.
**Verify:** `packages/core/test/environment.test.ts`, `engine.test.ts`,
`truncated-tool-output-archive.test.ts` and kernel-version guards. **Rollback:** stop new spill
writes while existing issued IDs remain readable through expiry.

<a id="b3"></a>

## B3 — Measured opt-in tool-output compression

**Depends on:** B1. **Start here:** `packages/core/test/environment/output-compression.test.ts`
and its implementation; [Q3](contracts.md#selected-decisions-q1q8).
**Outcome:** eligible outputs save >=10% without losing failure evidence or original access.

1. <a id="b3.1"></a>**B3.1 — Freeze:** version raw test-runner/build/log fixtures with hashes, output class,
   command and exit code. Define eligible classes before measuring; default remains raw.
2. <a id="b3.2"></a>**B3.2 — Strategies:** assess filter, group, truncate and dedup-counts independently,
   including failures-only test-runner collapse. Preserve ordering, command, exit code,
   complete promised failure evidence and B1 recall access.
3. <a id="b3.3"></a>**B3.3 — Proof:** encode the three non-negotiables: failure signal remains complete/useful,
   output cannot turn failure into success, and original redacted artifacts remain recoverable.
4. <a id="b3.4"></a>**B3.4 — Decision:** publish bytes/tokens, latency and savings per strategy/class. Drop and
   document strategies below 10% or failing privacy/failure gates. Ship only accepted opt-in classes.

**Acceptance:** deterministic transformations, honest savings/drop table, no false success.
**Verify:** named suite and reproducible raw measurement artifacts. **Rollback:** choose raw
output by class; old recall IDs remain valid.

<a id="b4"></a>

## B4 — Transactional compaction and prune frontier

**Depends on:** no parent task; preserve existing compactor boundaries. **Start here:**
`packages/core/src/agent/resource/compaction/`, `packages/core/test/compaction.test.ts`.
**Outcome:** failed compaction preserves acknowledged context byte-for-byte.

1. <a id="b4.1"></a>**B4.1:** trace candidate construction, summary generation, serialization and commit; list
   source IDs/frontier values which must survive each stage.
2. <a id="b4.2"></a>**B4.2:** build and validate a candidate copy, then commit by one swap; include cancellation
   and write failure in that transaction boundary.
3. <a id="b4.3"></a>**B4.3:** persist/track a prune frontier and kept IDs so repeated pruning never rereads an
   oversized skipped block; demonstrate forward progress without dropping retained context.
4. <a id="b4.4"></a>**B4.4:** inject summarize/write/swap failures and cancellation; compare original bytes and
   IDs, then restart/retry the valid path and verify the frontier's no-reread behavior.

**Acceptance:** failure leaves identical context; successful swap retains required IDs and
valid state. **Verify:** named suite plus frontier assertions. **Rollback:** select the previous
compactor and retain the pre-swap snapshot.

<a id="c8"></a>

## C8 — Offline cached-chat and recovery flow

**Depends on:** shared integration contract with F17; prepare concurrently. **Start here:**
`packages/web/e2e/`, current chat cache/send/connectivity paths.
**Outcome:** cached content remains readable and attempted actions recover honestly.

1. <a id="c8.1"></a>**C8.1:** identify the real seeded-chat cache and isolate browser-offline, server-down and
   online-but-reconnecting states. Define when attempted writes fail or queue in current product.
2. <a id="c8.2"></a>**C8.2:** add a named browser fixture using `setOffline(true)`; capture cached render timing
   from the same seeded state with a <100 ms target and declared measurement start/end.
3. <a id="c8.3"></a>**C8.3:** exercise offline reload, attempted write, browser restoration with server still
   down, then server restoration. Assert no duplicate send and no unhandled rejection.
4. <a id="c8.4"></a>**C8.4:** integrate F17's evidence-based banner and retry path, then obtain the browser CI receipt.

**Acceptance:** no invented availability/sync guarantees; cached view and send state agree with
actual local-server reachability. **Verify:** named new offline E2E flow through the existing
runner. **Rollback:** banner can be disabled separately from safe cached reads.

<a id="e1"></a>

## E1 — Explicit cockpit runtime dependencies

**Depends on:** no parent task. **Start here:** `packages/server/src/cockpit/ws.ts`,
cockpit runtime boundary/runtime/ws tests. **Outcome:** project root and guardian come from the host.

1. <a id="e1.1"></a>**E1.1:** map every coordinator/runtime constructor, production host injection and test host.
   Record remaining implicit cwd or guardian-less paths with their actual callers.
2. <a id="e1.2"></a>**E1.2:** require trusted project root and guardian at production construction; a deliberate
   test-only adapter is explicit and documented, not a production fallback.
3. <a id="e1.3"></a>**E1.3:** verify reap/recreate identity, injected root equivalence and construction failure
   when dependencies are absent; cover disconnect and cancellation cleanup.

**Acceptance:** no production guardian-less coordinator or implicit cwd root; recreation uses
the same ownership key. **Verify:** existing cockpit runtime/boundary suites. **Rollback:**
compatibility construction is test-only and explicitly selected.

<a id="e2"></a>

## E2 — Eight-claim ACP adjudication

**Depends on:** no parent task. **Start here:** `packages/core/src/kernel/acp.ts`,
`packages/core/test/acp-connection.test.ts`.
**Outcome:** each historical defect is confirmed and fixed or refuted by current evidence.

1. <a id="e2.1"></a>**E2.1:** create an eight-row receipt for transport-error latch recovery/reset; line-buffer
   cap/max frame; late-response counter; parse-error recording; write-queue ordering; parallel
   notification handlers; handshake/liveness; and disposal notification. Cite the two already
   documented repairs and preserve their correct behavior.
2. <a id="e2.2"></a>**E2.2:** give each row a triggering input and pre-fix observable outcome. Mark confirmed
   versus refuted with current symbol/test evidence; historical prose is not the reproducer.
3. <a id="e2.3"></a>**E2.3:** fix confirmed rows in independently reversible packages; preserve ordering,
   bounded buffers and error/cancellation propagation through the real transport.
4. <a id="e2.4"></a>**E2.4:** include cancellation/disposal, malformed input and late-response cases; attach a
   result for all eight rows and the existing ACP suite before E3 consumes the contract.

**Acceptance:** no unadjudicated row, swallowed failure or blanket transport rewrite justified
only by the report. **Verify:** named ACP suite and receipt table. **Rollback:** revert one
confirmed-defect repair independently and keep correct existing fixes.

<a id="e3"></a>

## E3 — ACP resume with generation and replay

**Depends on:** accepted E2 transport contract. **Start here:** ACP transport and its callers,
current web reconnect state; ACP and cockpit resume suites.
**Outcome:** a reconnect converges by bounded replay or explicit fresh snapshot/gap.

1. <a id="e3.1"></a>**E3.1:** specify ACP generation identity, monotonic cursor, replay retention/bound and
   acknowledgement timing. Record exact units and expired/old-generation behavior.
2. <a id="e3.2"></a>**E3.2:** implement handshake/replay ownership and repository-style reconnect jitter;
   suppress duplicates without silently skipping acknowledged records.
3. <a id="e3.3"></a>**E3.3:** map ACP state to the UI behind/resync surface. Keep ACP and cockpit SSE cursors
   distinct; show snapshot loading on a gap and a numeric events-behind count only when known.
4. <a id="e3.4"></a>**E3.4:** disconnect at each handshake/replay boundary, expire cursors, inject duplicate
   frames and rapid reconnect/cancellation; prove convergence and bounded memory.

**Acceptance:** no silent loss, stale-generation acceptance or fabricated backlog count.
**Verify:** ACP fixtures plus actual resume UI/integration cases. **Rollback:** disable resume
and request an explicitly fresh authoritative snapshot.

<a id="e4"></a>

## E4 — Durable cockpit event tail and gap signal

**Depends on:** E3 composition contract. **Start here:** `packages/server/src/cockpit/event-log.ts`,
`ws.ts`, server cockpit-resume and web cockpit-stream-resume tests.
**Outcome:** socket restart/reconnect replays within a documented bound or reports a gap.

1. <a id="e4.1"></a>**E4.1:** define durable event generation/cursor and retention independently of ACP. Map
   `safeSend` failure, persistence acknowledgement, replay and `caught_up` ordering.
2. <a id="e4.2"></a>**E4.2:** persist the tail/cursor atomically; send bounded replay and explicit gap when a
   requested point is unavailable. Preserve the current successful event payload contract.
3. <a id="e4.3"></a>**E4.3:** wire a resync action to authoritative snapshot loading, then fresh tail consumption.
   Cancel old-generation handlers/timers when replacing the connection.
4. <a id="e4.4"></a>**E4.4:** kill the socket mid-event and restart the server; assert ordering, no double-apply,
   bounded replay, gap recovery and `caught_up` at the actual convergence point.

**Acceptance:** clients distinguish caught-up from a gap; cursor reuse cannot cross protocols.
**Verify:** server/web resume suites and restart integration flow. **Rollback:** full snapshot
on each reconnect with visible status; preserve durable history for recovery.

<a id="e5"></a>

## E5 — Non-simulated swarm reaches a real handler

**Depends on:** actual runtime handler availability. **Start here:** cockpit HTTP/WS action
dispatch and cockpit-probe/integrity/task-handoff suites.
**Outcome:** a non-simulated request executes or receives a documented boundary refusal.

1. <a id="e5.1"></a>**E5.1:** map route/socket input through validation, task dispatch, configured handler and
   completion/error response; identify any accepted-but-unexecuted branch.
2. <a id="e5.2"></a>**E5.2:** wire the real handler where configured. An absent handler returns the documented 400
   boundary error before a task is reported accepted; simulation remains explicit.
3. <a id="e5.3"></a>**E5.3:** prove actual side-effect invocation/completion and all unsuccessful outcomes;
   cancellation/session deletion must terminate the real task and surface its result.

**Acceptance:** no dead success path or imaginary execution. **Verify:** owning route/socket
tests with handler absent/present and cancellation. **Rollback:** disable the affected action
until a real handler exists, preserving read-only cockpit operations.

<a id="e6"></a>

## E6 — Unified cockpit error responses

**Depends on:** shared server error contract. **Start here:**
`packages/server/src/http/routes/cockpit.ts`, shared `errorBody`/`handleError`,
`packages/server/test/cockpit-integrity.test.ts`.
**Outcome:** every cockpit failure has `{error:{code,message}}` and consistent HTTP status.

1. <a id="e6.1"></a>**E6.1:** inventory every route/exception and explicit unsuccessful key/mailbox/swarm result.
   Record status, code and existing successful body; include malformed JSON and invalid IDs.
2. <a id="e6.2"></a>**E6.2:** route errors through the shared serializer. Preserve additive `success:false` and
   existing shared metadata such as `i18nKey`; keep success payload fields unchanged.
3. <a id="e6.3"></a>**E6.3:** prove invalid/auth/provider/domain/internal cases. Unexpected exceptions return
   safe generic 500 detail while the diagnostic logger receives a sanitized cause.
4. <a id="e6.4"></a>**E6.4:** inspect existing frontend consumers and update only legacy failure parsing needed
   for the unified contract. Attach exact status/body assertions, not loose truthiness checks.

**Acceptance:** stable nested codes/messages; internal database/credential/stack details never
reach the client; success remains compatible. **Verify:** named integrity suite and affected
route/client tests. **Rollback:** use one explicit compatibility serializer if a demonstrated
legacy client requires it; retain the shared nested contract.

<a id="e7"></a>

## E7 — Gateway identifiers validated before lookup/launch

**Depends on:** no parent task. **Start here:** gateway URL/body/approval dispatch boundaries
and their existing server tests.
**Outcome:** invalid identifiers never reach project/session lookup or spawn.

1. <a id="e7.1"></a>**E7.1:** map URL, JSON and approval-session inputs to the shared ID grammar and limits;
   inventory legitimate underscore/hyphen cases from real project creation.
2. <a id="e7.2"></a>**E7.2:** bound and normalize `projectPath` while preserving its display-only status;
   authenticate project/session ownership from trusted context.
3. <a id="e7.3"></a>**E7.3:** refuse empty/overlong/encoded-traversal/non-normalized inputs at the first boundary.
   Verify valid Unicode/path display cases without widening the identifier grammar accidentally.
4. <a id="e7.4"></a>**E7.4:** prove no lookup/spawn on rejected cases and valid existing project IDs continue.

**Acceptance:** one grammar governs URL/body IDs; display paths do not grant file access.
**Verify:** owning gateway and approval route suites. **Rollback:** relax a new restrictive
limit only after a concrete legitimate fixture proves the false positive.

<a id="e8"></a>

## E8 — Cheap liveness and truthful readiness

**Depends on:** server database lifecycle. **Start here:** health routes beside version routes,
`packages/server/test/health.test.ts`.
**Outcome:** serving responds 200; a closed database causes readiness 503 while liveness responds.

1. <a id="e8.1"></a>**E8.1:** map startup/serving/degraded/DB-closed/recovery states and which dependencies are
   required to serve traffic. Define cheap liveness separately from readiness work.
2. <a id="e8.2"></a>**E8.2:** verify route mounting, bounded readiness probes and safe public response fields;
   exclude secret/config/database-path disclosure.
3. <a id="e8.3"></a>**E8.3:** drive serving→DB-closed→recovered and dependency degradation; assert statuses,
   liveness independence and readiness recovery without process restart where supported.

**Acceptance:** health never claims ready from a dead DB; diagnostics stay bounded and safe.
**Verify:** named suite plus route mounting assertion. **Rollback:** preserve liveness while
removing only new readiness wiring.

<a id="e9"></a>

## E9 — Structured logging and rejection metrics

**Depends on:** accepted I1 log-redaction contract; remaining trace/export packages may run
independently. **Start here:** `packages/server/src/runtime/logger.ts`, process/error wiring,
structured-logger, plugin and health suites.
**Outcome:** bounded JSON records correlate requests/Sessions and one handler pair counts rejections.

1. <a id="e9.1"></a>**E9.1:** inventory executable server `console.*` calls and route diagnostics through the
   logger. Keep the one-time first-login URL as a trusted operator notice outside diagnostics.
2. <a id="e9.2"></a>**E9.2:** verify request-ID response header, trusted request/session correlation and I1's
   bounded error `name/message/code/cause` shape. Mask credential/email/header variants and omit
   stack disclosure where the shared sanitizer requires it.
3. <a id="e9.3"></a>**E9.3:** ensure exactly one process-level unhandled-rejection/exception listener pair
   across repeated setup/dispose; provide total and rolling-minute `/health/metrics` values.
4. <a id="e9.4"></a>**E9.4:** inject one rejection, primary sink failure and repeated initialization. Require
   one fixed bounded emergency record, no recursive logging/sink call and no raw secret.

**Acceptance:** zero executable server `console.*`; exact structured/error output; monotonic
total and bounded minute accounting. **Verify:**
`packages/server/test/structured-logger.test.ts`, `plugin.test.ts`, `health.test.ts`.
**Rollback:** use stderr with the same schema and retain the bounded emergency sink.

<a id="e10"></a>

## E10 — Four independent lifecycle/resource leak fixes

**Depends on:** each current reproducer; reserve each file boundary separately.
**Outcome:** each leak has its own repair and negative/restart proof.

1. <a id="e10.1"></a>**E10.1 — Orphan child:** trace spawn and parent-death behavior; prove cleanup beyond a normal
   exit hook through the supported watchdog/Windows Job Object boundary. Test actual process
   termination on parent death and preserve unrelated user processes.
2. <a id="e10.2"></a>**E10.2 — Hung removal:** bound `disposeRemoved` waiting on never-settling `entry.running`;
   prove cancellation, timeout result and cleanup without reporting an uncompleted dispose as success.
3. <a id="e10.3"></a>**E10.3 — Session deletion:** connect deletion to `SwarmCoordinator.abort()`; prove the actual
   running task aborts, callbacks settle and no orphan worker remains.
4. <a id="e10.4"></a>**E10.4 — Archive capacity:** enforce the per-Session truncated-output archive cap with B1
   valid-ID lifetime and useful failure evidence preserved. Exercise capacity/restart/write failure.
5. <a id="e10.5"></a>**E10.5 — Receipt:** for each slice, demonstrate pre-fix failure, post-fix pass and a
   controlled revert-and-see check on a copied/isolated fixture; record Windows/POSIX relevance.

**Acceptance:** all four rows complete; each repair is independently revertible and leaves no
owned process/file resource leak after failure. **Verify:** traced owners' focused suites plus
actual process/archive fixtures. **Rollback:** revert one numbered slice, never a combined lifecycle rewrite.

<a id="g1"></a>

## G1 — Skill integrity and changed-skill line budget

**Depends on:** current rule/corpus baseline. **Start here:** `.github/workflows/skill-integrity.yml`,
`scripts/skills/`, existing line-budget tests.
**Outcome:** new violations fail with precise findings while inherited debt is explicitly inventoried.

1. <a id="g1.1"></a>**G1.1:** enumerate frontmatter, taxonomy, references/link, executable command/resource and
   <=80-line rules from current validators; map each to a planted violation and diagnostic.
2. <a id="g1.2"></a>**G1.2:** verify grandfathered long skills have individual path/count/SHA-256 receipts and
   triage ownership, expiry and a concrete reopen/remediation condition. New over-limit skills
   and growth of existing exceptions fail; historical
   debt cannot be hidden by a global opt-out.
3. <a id="g1.3"></a>**G1.3:** integrate strict checks and taxonomy/readiness reports into CI; validate command
   declarations/liveness without executing unsafe or paid scripts.
4. <a id="g1.4"></a>**G1.4:** attach corpus pass/triage artifacts, each rule's negative result and candidate workflow receipt.

**Acceptance:** new offenses identify file/line; changed-skill debt does not increase.
**Verify:** `scripts/skills/line-budget.test.mjs` and the actual integrity workflow.
**Rollback:** a rule-scoped dated exception with owner; preserve the remaining gate.

<a id="g3"></a>

## G3 — Skill source pin and offline drift refusal

**Depends on:** corpus identity contract. **Start here:** `scripts/skills/lock.mjs`, `lock.test.mjs`.
**Outcome:** resolver verifies source path/digest before execution and refuses drift.

1. <a id="g3.1"></a>**G3.1:** inspect current lock format, canonical source path, name grammar and SHA-256 rules;
   preserve deterministic serialization and existing-reader compatibility.
2. <a id="g3.2"></a>**G3.2:** prove pin→verify→tamper→deny, unpinned/missing source and path-shaped-name refusal
   with offline lookup. Resolve exactly one accepted source identity.
3. <a id="g3.3"></a>**G3.3:** verify Skill Integrity consumes the lock before a changed source can execute;
   record regeneration/update procedure and migrate readers before a format change.

**Acceptance:** missing/drifted entries have explicit failure; offline operation needs no remote
fallback. **Verify:** named lock suite and workflow step. **Rollback:** retain the prior reader
during an explicit format migration, preserving digest refusal.

<a id="g4"></a>

## G4 — Patch and supersession ledger

**Depends on:** current resolver/source inventory. **Start here:** skill source references,
all `local.patch` and superseded artifacts located through scoped inventory.
**Outcome:** every artifact has an owner/base/purpose and one explicit apply/retain/remove decision.

1. <a id="g4.1"></a>**G4.1:** inventory references, source identity, base revision, purpose and active resolver
   for each patch/superseded artifact. Produce a versioned disposition table.
2. <a id="g4.2"></a>**G4.2:** retain deliberately referenced/superseded sources with their resolution path;
   remove only copies proved unused by source/runtime/config references.
3. <a id="g4.3"></a>**G4.3:** prove each retained skill resolves once, each live patch still applies to its
   declared base, and each removal is independently recoverable through Git.

**Acceptance:** zero ambiguous `local.patch`; deliberate supersession remains functional.
**Verify:** reference/resolver fixtures plus human-reviewed deletion table. **Rollback:**
restore the individual removed artifact and its declared resolution.

<a id="h3"></a>

## H3 — Atomic credential writer audit

**Depends on:** no parent task. **Start here:** `packages/core/src/internal/atomic-write.ts`,
`packages/core/test/atomic-write.test.ts`, `atomic-write-security.test.ts`.
**Outcome:** credentials are protected from creation and prior bytes survive every failed commit stage.

1. <a id="h3.1"></a>**H3.1:** map exclusive `create_new` temporary creation,0600 from birth, existing permission
   inheritance, descriptor permissions, sync-before-rename and owned-temp cleanup.
2. <a id="h3.2"></a>**H3.2:** fault each post-create stage and collision; prove original bytes survive, errors
   propagate and only this operation's owned temp is removed.
3. <a id="h3.3"></a>**H3.3:** obtain native Windows/POSIX permission receipts. State what Node mode bits and actual
   platform access prove; avoid treating POSIX mode alone as Windows access-control proof.
4. <a id="h3.4"></a>**H3.4:** verify real credential consumers use the writer and retain reader/rollback compatibility.

**Acceptance:** no permissive intermediate credential or success-on-rename failure.
**Verify:** both named suites and consumer fixtures. **Rollback:** keep the old path read-only
while changing writer behavior; preserve prior credentials.

<a id="i1"></a>

## I1 — Redaction across logs, trace and export

**Depends on:** trusted boundary inventory. **Start here:**
`packages/core/src/internal/credential-redactor.ts`, `packages/core/test/redaction-completions.test.ts`,
server logger and `packages/server/test/trace-import-export.test.ts` consumers.
**Outcome:** shared safe headers/errors reach every required diagnostic/trace/export boundary.

1. <a id="i1.1"></a>**I1.1:** enumerate the actual 14-header allowlist from the canonical fixture and every
   consumer. Map log/trace/export producers, serialization and downloads; retain credentials
   needed only for authenticated execution outside these diagnostic payloads.
2. <a id="i1.2"></a>**I1.2:** reconcile existing email mask and structured error sanitizer for nested cause,
   string/numeric code, bounded name/message and stack handling; test recognized credential variants.
3. <a id="i1.3"></a>**I1.3:** complete trace/export routing through the same helpers. Serialize from a redacted
   copy so diagnostics cannot mutate the active credential/config object.
4. <a id="i1.4"></a>**I1.4:** assert exact allowed header keys and scan final emitted/exported artifacts with
   secret sentinels, nested causes and control/overlong data; verify safe non-secret fields remain useful.

**Acceptance:** raw sentinel secrets absent from all three boundary types; model-authored
fields cannot attest identity; privacy failures propagate safely. **Verify:** named redaction,
structured-logger and trace/export suites. **Rollback:** disable extra diagnostics/export fields
rather than bypassing redaction. Current logger wiring does not complete trace/export scope.

<a id="i2"></a>

## I2 — Final executable validation and hidden Windows launch

**Depends on:** actual sandbox/spawn adapter. **Start here:** command session/spawn policy,
`packages/core/test/command-spawn.test.ts`.
**Outcome:** the final rewritten executable argument is checked before a hidden native launch.

1. <a id="i2.1"></a>**I2.1:** trace original input, sandbox rewrite and the final executable/argv passed to
   Node. Identify the exact enforcement point and supported Windows launch path.
2. <a id="i2.2"></a>**I2.2:** refuse dangerous executable-path metacharacters at that point before spawn;
   retain ordinary spaces, Unicode, drive letters, Windows separators and `(x86)` paths.
3. <a id="i2.3"></a>**I2.3:** verify Node's `windowsHide` is supplied by every launch adapter, matching the
   intended Windows no-visible-window behavior; test both allowed and rejected actual arguments.

**Acceptance:** no spawn on refusal; rewrites cannot bypass validation; legitimate paths
remain valid. **Verify:** named suite and adapter-focused cases. **Rollback:** restore only a
documented false-positive case while preserving the authoritative pre-spawn check.

<a id="i3"></a>

## I3 — Safe skill/hook archive extraction

**Depends on:** canonical extraction boundary. **Start here:** skill/hook import handlers,
`packages/server/test/zip-entry-types.test.ts`, related import/security suites.
**Outcome:** symlinks, escapes and normalized collisions are refused before destination mutation.

1. <a id="i3.1"></a>**I3.1:** map entry metadata/type, decoded path normalization, destination resolution,
   decompression budgets and skill/hook consumers before any write.
2. <a id="i3.2"></a>**I3.2:** reject symlink metadata, traversal/absolute escapes, duplicate normalized names
   and over-budget archives; use the canonical resolved destination rather than string prefix alone.
3. <a id="i3.3"></a>**I3.3:** test malicious entries plus legitimate archives and overwrite paths; rejected
   imports leave existing destination bytes unchanged and clean only owned staging files.
4. <a id="i3.4"></a>**I3.4:** obtain Windows/POSIX boundary evidence, including separators/case collisions relevant
   to the supported platform; document normalized-name behavior and atomic apply.

**Acceptance:** no external path mutation or partial install on rejection. **Verify:** named
entry/import/security suites and unchanged-destination fixtures. **Rollback:** disable the
affected import path until the refusal contract is restored.

<a id="i4"></a>

## I4 — Effective authentication-mode matrix

**Depends on:** current bind-address/config contract. **Start here:** server authentication-mode
resolver and existing auth/health route fixtures.
**Outcome:** one pure resolver determines effective mode from trusted bind and configured policy.

1. <a id="i4.1"></a>**I4.1:** enumerate loopback/LAN/unspecified/IPv4/IPv6 bind classes and `Auto`, `Off`,
   `AllExceptHealth`; record effective mode and endpoint authentication requirements.
2. <a id="i4.2"></a>**I4.2:** retain `Auto→Off` on loopback and `Auto→AllExceptHealth` on LAN. Map any supported
   proxy trust configuration explicitly; untrusted forwarded data cannot change auth mode.
3. <a id="i4.3"></a>**I4.3:** route middleware through the same resolver and test ordinary, health and proxied
   requests at boundary cases; missing/invalid configuration fails safely.

**Acceptance:** deterministic matrix, no divergent health/auth shortcuts or spoofed mode.
**Verify:** pure table fixtures and owning route suite. **Rollback:** retain the existing
config parser while calling one accepted resolver.

<a id="f17"></a>

## F17 — Evidence-based offline posture banner

**Depends on:** C8 integration contract; implement concurrently. **Start here:** web connectivity
state, cached-chat/send flow and offline E2E fixture.
**Outcome:** the user sees browser/server availability and a working retry action.

1. <a id="f17.1"></a>**F17.1:** define browser offline, local server unreachable, reconnecting and recovered
   states using actual evidence; keep cached-content availability separate from write status.
   Use a bounded local-server health probe with timeout, cancellation and capped retries;
   one transient request failure must not establish a persistent offline banner.
2. <a id="f17.2"></a>**F17.2:** render accessible state text and retry control from the shared connectivity model;
   clear the banner only after real recovery, not a browser-online event alone.
   Add matching en/zh locale strings for each posture and recovery action through the existing i18n path.
3. <a id="f17.3"></a>**F17.3:** pair C8's cached/read/write/reload cases with banner assertions and keyboard access.
   Include transient probe failure, sustained outage, bounded manual retry, real recovery and
   unmount cancellation; clear the banner after successful reachability and recovery.

**Acceptance:** no false offline indication while the server is reachable, no unsupported promise
that synchronization never occurs. **Verify:** connectivity unit cases and C8 browser flow.
**Rollback:** hide the banner separately while preserving safe cached reads.

<a id="f18"></a>

## F18 — Recall chip and CLI retrieval

**Depends on:** B1. **Start here:** tool-output rendering, CLI command registry and the actual
Session-authorized recall consumer seam.
**Outcome:** the user can access bounded archived output through an opaque ID.

1. <a id="f18.1"></a>**F18.1:** define the chip/CLI DTO from B1 metadata and the existing session/project
   authorization context; raw paths and path-shaped IDs are invalid inputs.
2. <a id="f18.2"></a>**F18.2:** render a keyboard/screen-reader accessible chip and register `penguin recall`
   through actual CLI vocabulary; page/stream large text without unbounded buffering.
3. <a id="f18.3"></a>**F18.3:** cover valid, expired, cross-project/Session, traversal-shaped and interrupted
   retrieval; display explicit safe errors and leave original inline failure text usable.

**Acceptance:** neither UI nor CLI turns an ID into arbitrary file access. **Verify:** owning
renderer/CLI cases and authenticated recall integration. **Rollback:** hide the affordance;
retain issued-ID retrieval through its promised lifetime.

<a id="i7"></a>

## I7 — Pressure-aware policy for nonessential writes

**Depends on:** trusted target-volume probe and authoritative command-policy/write-boundary inventory.
**Start here:** existing pressure probe, command-policy guard and nonessential write-capable commands.
**Outcome:** warn below 200 MiB and block below 50 MiB; trusted override is recorded.

1. <a id="i7.1"></a>**I7.1:** inventory targeted nonessential writes and their resolved target volumes. Record
   byte units used by the existing probe and convert the thresholds explicitly:
   200 MiB = 209,715,200 bytes; 50 MiB = 52,428,800 bytes. At either threshold, the stricter
   below-threshold rule has not fired. Preserve any existing warning as a separately named signal;
   read-only operations, export, deletion, cleanup and recovery remain available. Enumerate
   each exemption in the policy fixture instead of classifying all filesystem writes as blocked.
2. <a id="i7.2"></a>**I7.2:** enforce warning/block at the trusted write boundary, using measured target volume
   and an observable warning when the probe is unavailable; never invent zero free bytes or
   claim a threshold refusal without a valid measurement. Keep the `resource_pressure` tool observational.
3. <a id="i7.3"></a>**I7.3:** make user override an authenticated, recorded action scoped to the write; model
   payload fields cannot forge it or widen another Session's allowance.
4. <a id="i7.4"></a>**I7.4:** test above/at/below thresholds, wrong-volume readings, unavailable probes,
   read-only/export/deletion/cleanup/recovery exemptions and forged/valid override; prove denied
   nonessential writes do not mutate destinations.

**Acceptance:** no hidden global disk-policy flip and no loss of recovery path. **Verify:**
named pressure-policy matrix and producer boundary fixtures with exact byte values.
**Rollback:** disable this write policy without changing the probe or pressure-tool behavior.
