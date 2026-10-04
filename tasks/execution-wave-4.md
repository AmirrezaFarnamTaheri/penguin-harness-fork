# Wave 4 execution cards

Documentation reconciled on 2026-10-04. Current status and release gates are in
[todo.md](todo.md) and [work-orders.md](work-orders.md); these requirements and historical
observations do not certify the changed working tree.

Read [the task index](todo.md), [implementation guide](implementation-guide.md), and
[contracts and selected Q1–Q8 decisions](contracts.md) before claiming a package. Requirements
come from the [v3 strategic inventory](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/tasks/archive/plan-v3-2026-10-02.md) and
[v3 acceptance cards](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/tasks/archive/execution-cards-2-v3-2026-10-02.md); historical upstream labels
are provenance, not permission to copy encumbered source. Follow the
[porting boundary](../docs/policies/porting-and-refusals.md).

The cards define work packages and acceptance; [todo.md](todo.md) owns current task state.
No package completion is asserted here. Existing helpers,
interfaces, tests, and product paths are starting anchors; their presence does not prove the
new acceptance. Required new fixtures below are deliverables, not claims that files exist.

## Dispatch and shared completion rules

- Run independent investigation, fixture design, and reviewed contract work across Waves R–4
  concurrently. A prerequisite gates the package that consumes it, not the earlier investigation.
  Release repairs and findings safety retain priority; Wave 4 does not bypass their gates.
- Ready Wave 4 starts with the usage seam (`A7.1`, `A8.1`), schema/permission trace (`K5.1`,
  `K14a.1`), current fleet lifecycle (`K9.1`), and export privacy boundary (`F13a.1`). These
  unblock several consumers. Color inventory (`F10a.1`), topology identity (`F11a.1`), and
  contract notes (`K11a.1`) can run in their own owned paths at the same time.
- Dependencies below name **integration gates**. Confirm the prerequisite's scoped receipt
  before consuming it; an `IMPLEMENTED` row alone is insufficient. Inherited dependencies
  remain effective: E3 includes E2, C4 includes C2/C3's opt-in policy boundary, C1 includes R2b,
  and K14b includes K5/K14a. Preserve the failed-gate fallback.
- Query CodeGraph first for each named current source and producer→consumer path. The anchors
  below were located against the planning baseline; recheck current symbols and test commands
  when claiming work. Split any package exceeding five owned files or a persistence/protocol seam.
- Verification commands below are instructions for implementation, not checks run by this
  planning rewrite. Required new fixture deliverables must join the owning package's existing
  test runner. Add exact commands, case results, corpus hashes, candidate SHA, compatibility,
  rollback, and all remaining packages to the [receipt](implementation-guide.md#5-record-evidence-and-hand-off).
  UI slices include keyboard, focus, dark mode, narrow viewport, and meaningful failure recovery.
- Q1 keeps follow-up slices reversible; Q2 retains one approval authority; Q3 keeps compression
  opt-in with its ≥10% corpus gate; Q4 keeps lazy opt-in grammar/resource gates; Q5 leaves
  destructive retention unconsumed; Q6 gates token migration; Q7 preserves separate findings
  authorities; Q8 requires durable acknowledgements and read-only corruption recovery.

## Usage, replay, and failure explanation

<a id="a7"></a>

### A7 — CanonicalUsage and Anthropic healing

**State:** [canonical index](todo.md#wave-4). **Outcome:** one normalized usage record explains provider input, output,
cache, and thinking counts without charging overlapping categories twice.
**Dependencies:** normalization discovery is ready; consumer integration uses I1's redaction
contract for raw diagnostic usage. A8 estimates remain distinguishable from provider counts.
**CodeGraph anchors:** [GenerativeModel](../packages/core/src/llm/generative-model.ts),
[TokenCounts/TokenUsagePayload](../packages/core/src/omnimessage/types.ts),
[usage recorder](../packages/server/src/runtime/usage-recorder.ts);
[token accounting tests](../packages/core/test/llm/token-accounting.test.ts).

1. <a id="a7.1"></a>**A7.1 — Freeze the mapping:** inventory current adapters and emit a reviewed table of the
   required seven canonical fields and twelve aliases, including overlapping Anthropic shapes,
   units, missing-value handling, and source precedence. Preserve raw input in the fixture corpus.
2. <a id="a7.2"></a>**A7.2 — Normalize at ingress:** implement the shared conversion at the real usage producer,
   with explicit invalid/unknown results and Anthropic healing; emit provenance for derived values.
3. <a id="a7.3"></a>**A7.3 — Carry the record:** wire the normalized event through usage recording/read-back,
   preserving legacy TokenCounts consumers and exposing provider versus estimated origin.
4. <a id="a7.4"></a>**A7.4 — Prove accounting:** deliver alias, malformed, overflow, missing, and overlapping-cache
   fixtures plus a before/after per-provider accounting receipt.

**Acceptance:** positive — all twelve aliases yield the reviewed seven-field record and an
Anthropic-shaped response is healed once; negative — negative/non-finite/overflow counts and
missing usage never become a plausible billable zero; compatibility — old event and persisted
usage readers still parse, and raw values remain available for explaining normalization.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/llm/token-accounting.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/usage.test.ts`; required new `canonical-usage` fixture matrix joins those suites.
**Rollback:** stop emitting the derived extension; retain raw usage and the old event reader.

<a id="a8"></a>

### A8 — Token estimator and calibration

**State:** [canonical index](todo.md#wave-4). **Outcome:** prompt estimates state model/provider calibration and uncertainty.
**Dependencies:** baseline and estimator work are ready; A7 integration waits for its origin/unit
contract. Recorded actual usage calibrates estimates without turning them into billing authority.
**CodeGraph anchors:** [token math](../packages/core/src/memory/token-math.ts),
[prompt estimator](../packages/core/src/prompts/prompt-fingerprint.ts),
[context limits](../packages/core/src/llm/context-limits.ts);
[token math tests](../packages/core/test/memory/token-math.test.ts).

1. <a id="a8.1"></a>**A8.1 — Capture the baseline:** freeze empty, ASCII, multilingual, image, cached, and tool-heavy
   prompts with actual provider counts; publish existing-estimator error by model and prompt class.
2. <a id="a8.2"></a>**A8.2 — Add calibrated estimates:** define versioned provider/model calibration, confidence
   bounds, and explicit fallback for absent or stale calibration; preserve the source prompt class.
3. <a id="a8.3"></a>**A8.3 — Wire consumers:** expose estimate/origin/uncertainty to context budgeting and A7's
   extension without substituting estimated counts into recorded provider cost.
4. <a id="a8.4"></a>**A8.4 — Record the gate:** deliver deterministic fixtures, held-out error table, calibration
   version, and a decision on each supported provider/model pair.

**Acceptance:** positive — supported classes produce bounded, reproducible estimates tied to
their calibration; negative — missing calibration, empty prompts, unusual Unicode, and unknown
models cannot emit false precision or billable truth; compatibility — existing budgeting remains
usable with the documented fallback and calibration upgrades do not rewrite historical usage.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/memory/token-math.test.ts test/prompts/prompt-fingerprint.test.ts`; deliver new calibration/held-out fixtures.
**Rollback:** select the existing estimator and show raw provider counts for accounting.

<a id="a9"></a>

### A9 — Content-addressed session fingerprinting

**State:** [canonical index](todo.md#wave-4). **Outcome:** stable canonical session material can be recognized across restart
without merging unrelated sessions or exposing secret values.
**Dependencies:** ready; integration supplies K1a a versioned identity contract. Operation-sharing
fingerprints and prompt fingerprints are separate domains from session identity.
**CodeGraph anchors:** [session entry point](../packages/core/src/session.ts),
[prompt fingerprints](../packages/core/src/prompts/prompt-fingerprint.ts),
[sharing fingerprints](../packages/core/src/agent/sharing/fingerprint.ts);
[prompt fingerprint tests](../packages/core/test/prompts/prompt-fingerprint.test.ts).

1. <a id="a9.1"></a>**A9.1 — Define identity material:** produce an ordered canonical representation, domain/version
   tag, secret-omission rule, and collision behavior; distinguish logical session id from digest.
2. <a id="a9.2"></a>**A9.2 — Implement digest boundaries:** compute the content address from that representation,
   recording canonicalization version and refusing ambiguous or incomplete identity material.
3. <a id="a9.3"></a>**A9.3 — Integrate read-back:** persist optional fingerprint metadata and compare it during
   session load/resume while keeping original ids authoritative for ownership and authorization.
4. <a id="a9.4"></a>**A9.4 — Prove independence:** deliver restart, reordered-object/ordered-message, omitted-secret,
   canonicalization-upgrade, and injected-collision fixtures with digest receipts.

**Acceptance:** positive — identical ordered material yields the same versioned digest after
restart; negative — different message order or a collision cannot merge sessions, and secret
omission does not erase necessary identity distinctions; compatibility — legacy sessions without
fingerprints remain readable and digest lookup never replaces project/session authorization.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/prompts/prompt-fingerprint.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/session-loader.test.ts`; required new session-fingerprint fixture matrix.
**Rollback:** ignore new fingerprint metadata and resolve sessions by their original ids.

<a id="k4"></a>

### K4 — Self-diagnosing failureTrace

**State:** [canonical index](todo.md#wave-4). **Outcome:** UI and `penguin why` explain the actual failed attempt, retry/rotation
history, and retained head/tail while distinguishing observed cause from inference.
**Dependencies:** A1, A2, B2 gate final trace composition; I1 gates sensitive trace/display paths.
The failure-story format and fixture corpus can be prepared now; CLI composition coordinates K2.
**CodeGraph anchors:** [failure status](../packages/core/src/llm/failure-status.ts),
[GenerativeModel](../packages/core/src/llm/generative-model.ts),
[trace panel](../packages/web/src/features/traces/trace-panel.tsx);
[failure tests](../packages/core/test/failure-status.test.ts),
[error E2E](../packages/web/e2e/llm-errors.spec.mjs).

1. <a id="k4.1"></a>**K4.1 — Map the failure story:** trace classified attempts and bounded capture to current
   serialized errors; define attempt ordering, cause provenance, absent-body, and account labels.
2. <a id="k4.2"></a>**K4.2 — Emit failureTrace:** attach the redacted typed trace from A1/A2/B2 at failure completion,
   preserving actual HTTP status and head/tail references across rotation and cancellation.
3. <a id="k4.3"></a>**K4.3 — Render explanation:** add UI drill-through and the shared `why` output section with
   observed cause, attempt count, inferred context, and bounded capture access.
4. <a id="k4.4"></a>**K4.4 — Demonstrate diagnosis:** deliver the “400 on attempt 3 after rotation” story, all-429,
   no-response, redaction, and incomplete-capture fixtures through engine, CLI, and web.

**Acceptance:** positive — the story identifies the retained actionable failure and real retry
history; negative — later 429s, missing bodies, or inferred text cannot overwrite observed cause,
and secrets never appear; compatibility — old typed errors remain parseable and capture absence
has a usable fallback. A1 active promotion still requires its disagreement census.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/failure-status.test.ts`; extend
`llm-errors.spec.mjs` and deliver CLI failure-story fixtures under the existing runners.
**Rollback:** hide failureTrace consumers and render the original typed error.

<a id="k2"></a>

### K2 — Cost ledger and penguin why

**State:** [canonical index](todo.md#wave-4). **Outcome:** a per-turn explanation attributes prompt/cache-miss/thinking/output
cost to source counts and price assumptions; cache effectiveness is queryable.
**Dependencies:** A7/A8 gate new decomposition; I1 gates stored/displayed diagnostics. Existing
usage/pricing inventory and `why` command design are ready. Coordinate CLI ownership with K4.
**CodeGraph anchors:** [usage service](../packages/server/src/services/usage-service.ts),
[usage repository](../packages/server/src/db/repos/usage.ts),
[cost CLI](../packages/cli/src/commands/cost.ts);
[usage tests](../packages/server/test/usage.test.ts).

1. <a id="k2.1"></a>**K2.1 — Reconcile accounting:** map provider counts, current pricing tiers, and unknown-price
   behavior to turn identity; deliver a decomposition table and cache-effectiveness data contract.
2. <a id="k2.2"></a>**K2.2 — Persist attributable rows:** add compatible ledger/cache-effectiveness storage with
   source-count, estimate, pricing-version, and partial-unknown provenance; avoid overlapping charges.
3. <a id="k2.3"></a>**K2.3 — Wire penguin why:** expose an authorized turn explanation and CLI human/JSON modes,
   composing K4's failure section through one command owner.
4. <a id="k2.4"></a>**K2.4 — Record the demo:** deliver cache hit/miss, thinking, price change, missing usage,
   missing price, and mixed known/unknown model examples with source arithmetic.

**Acceptance:** positive — rows and CLI decomposition reproduce the recorded source arithmetic;
negative — missing counts/prices remain unknown or an explicitly partial lower bound, and cache
read/write never double bill; compatibility — existing cost summaries, genuine recorded zero,
old usage rows, and historical pricing assumptions remain interpretable.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/usage.test.ts`; required new
turn-cost/cache-effectiveness repository fixtures and CLI `why` human/JSON snapshots.
**Rollback:** hide new estimates/explanations; retain raw usage and existing cost command.

<a id="k3"></a>

### K3 — Trustworthy CLI configurator

**State:** [canonical index](todo.md#wave-4). **Outcome:** a user reviews scoped ownership, a secret-safe diff, backup, and
restore path before the configurator applies an approved change.
**Dependencies:** H1/H2/H3/H4 gate application; wizard flow, fixture files, and preview design
are ready. Existing explicit config commands stay available during the new workflow.
**CodeGraph anchors:** [config command](../packages/cli/src/commands/config.ts),
[project config](../packages/core/src/state/project-config.ts),
[approval prompt](../packages/cli/src/approval.ts);
[config tests](../packages/cli/test/config-model.test.ts),
[vault tests](../packages/cli/test/config-vault.test.ts).

1. <a id="k3.1"></a>**K3.1 — Design the review journey:** specify target/version/owner selection, redacted preview,
   backup destination, cancellation, and restore output using H1/H4's contract.
2. <a id="k3.2"></a>**K3.2 — Build read/preview flow:** connect H2 style-preserving edits and H4 redacted diff,
   validating supported schema and ownership without persisting before review.
3. <a id="k3.3"></a>**K3.3 — Apply through the writer:** bind approval to preview hash, recheck external edits,
   execute H1/H3 atomic write, and expose byte-exact restore with truthful write failures.
4. <a id="k3.4"></a>**K3.4 — Demonstrate reversibility:** deliver temporary-config E2E for accept/cancel,
   changed-since-preview, unsupported version, every writer fault, and restored bytes/permissions.

**Acceptance:** positive — reviewed scoped edits preserve style and can restore the original;
negative — concurrent external change, wrong owner/version, missing approval, or write fault
refuses or restores, and previews/logs contain no secret; compatibility — existing config/vault
commands and foreign comments/permissions survive. Frozen configs remain explicitly migrated.
**Verify:** `rtk proxy pnpm --dir packages/cli exec vitest run test/config-model.test.ts test/config-vault.test.ts test/approval.test.ts`; deliver configurator E2E.
**Rollback:** restore the verified backup and disable the new configurator entry point.

<a id="k1a"></a>

### K1a — Turn ledger core

**State:** [canonical index](todo.md#wave-4). **Outcome:** durable prompts, tool decisions, normalized deltas, and cursor state
support crash-safe `resumeFrom(ledger)` without replaying a side effect.
**Dependencies:** A5/A9 gate normalized replay/identity; I1 gates persisted secrets. Existing
TurnLedger is the baseline, not proof of durable cross-protocol resume.
**CodeGraph anchors:** [TurnLedger](../packages/core/src/agent/turn-ledger.ts),
[SwarmCoordinator](../packages/core/src/agent/swarm-coordinator.ts),
[session manager](../packages/server/src/runtime/session-manager.ts);
[turn-ledger tests](../packages/core/test/turn-ledger.test.ts).

1. <a id="k1a.1"></a>**K1a.1 — Audit existing ledger:** document current persistence, append/ack, projection,
   compaction, ordering, and gap behavior; define the compatible resume record/cursor schema.
2. <a id="k1a.2"></a>**K1a.2 — Make writes durable:** persist redacted ordered records and acknowledgements through
   the selected atomic storage seam, retaining unacknowledged records and explicit capacity failure.
3. <a id="k1a.3"></a>**K1a.3 — Implement resumeFrom:** reconstruct normalized turn state from A5/A9 plus ledger,
   deduplicating logical turns/tool results and returning an explicit gap or unsupported version.
4. <a id="k1a.4"></a>**K1a.4 — Prove replay:** deliver append-before/after-ack crashes, interrupted compaction,
   duplicate replay, stale cursor, restart, corruption, cancellation, and redaction fixtures.

**Acceptance:** positive — restart resumes the same logical turn at the correct projection
watermark; negative — append failure receives no durable acknowledgement, and replay cannot
execute a completed tool twice or silently skip a gap; compatibility — existing TurnLedger
callers/events and legacy snapshots read successfully or stop with a documented migration path.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/turn-ledger.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/session-manager.test.ts`; required durable resume/fault fixture matrix.
**Rollback:** disable resume; retain readable ledger records and export for manual recovery.

<a id="k1b"></a>

### K1b — Cross-protocol resume demo

**State:** [canonical index](todo.md#wave-4). **Outcome:** one session safely continues after a provider/protocol switch,
with preserved transcript and explicit stops for unsupported state.
**Dependencies:** K1a gates live resume. Protocol capability mapping and demo fixtures are ready;
do not replace original provider configuration before the selected compatibility path is proven.
**CodeGraph anchors:** [LLMInterface](../packages/core/src/interfaces/llm.ts),
[GenerativeModel](../packages/core/src/llm/generative-model.ts),
[session](../packages/core/src/session.ts);
[LLM tests](../packages/core/test/llm.test.ts),
[session-loader tests](../packages/server/test/session-loader.test.ts).

1. <a id="k1b.1"></a>**K1b.1 — Map protocol capabilities:** specify roles, reasoning/content, tool-call/result ids,
   approval state, and partial-stream mappings for two concrete supported protocols.
2. <a id="k1b.2"></a>**K1b.2 — Adapt replay:** translate K1a's normalized records at the provider boundary and
   expose stop reasons for unsupported roles, unresolved tool execution, or missing ledger evidence.
3. <a id="k1b.3"></a>**K1b.3 — Wire explicit switching:** add the selected session control with capability preview,
   preserved logical ids, original provider rollback, and authenticated ownership checks.
4. <a id="k1b.4"></a>**K1b.4 — Capture the journey:** deliver deterministic mock-provider demo and failure fixtures
   for switch at terminal turn, partial stream, pending tool, restart, and unmappable role.

**Acceptance:** positive — a recorded session continues on the second protocol with equivalent
prior transcript/tool results; negative — unsupported or uncertain pending action produces an
explicit safe stop, never transcript loss or duplicate execution; compatibility — unchanged
sessions stay on the existing provider and ledger/version/auth boundaries are preserved.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/llm.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/session-loader.test.ts`; required cross-protocol replay/demo fixture.
**Rollback:** pin the session to its original provider and retain the normalized ledger.

## Schema and permission plane

<a id="k5"></a>

### K5 — Tool-schema normalization surface

**State:** [canonical index](todo.md#wave-4). **Outcome:** provider schemas preserve supported meaning, round-trip sanitized
keys, and report unsupported constructs instead of silently accepting altered tools.
**Dependencies:** ready. Shared schema changes coordinate R10's schema-size measurement; optional
output compression remains under Q3, and approval semantics are owned by K14.
**CodeGraph anchors:** [tool definitions](../packages/core/src/interfaces/environment.ts),
[MCP provider](../packages/core/src/environment/mcp/provider.ts),
[GenerativeModel](../packages/core/src/llm/generative-model.ts);
[LLM tests](../packages/core/test/llm.test.ts).

1. <a id="k5.1"></a>**K5.1 — Freeze the schema corpus:** record current provider/MCP shapes and expected semantics
   for nested `$ref`, scored `anyOf`, strict mode, key sanitation, duplicates, and cycles.
2. <a id="k5.2"></a>**K5.2 — Implement normalization:** add bounded reference expansion, explicit union-selection
   rationale, strict-mode capability reporting, and reversible original↔sanitized key mapping.
3. <a id="k5.3"></a>**K5.3 — Wire tools end-to-end:** normalize the emitted provider schema and restore inbound
   argument keys before shared validation; preserve identity/approval target across aliases.
4. <a id="k5.4"></a>**K5.4 — Prove the surface:** deliver provider-shaped corpus goldens, cyclic/refusal cases,
   sanitized-key round trips, payload-size comparison, and active-call argument assertions.

**Acceptance:** positive — supported schemas and arguments retain their meaning across round
trip; negative — cycle, ambiguous union, duplicate normalized key, unsupported strict construct,
or budget exhaustion returns explicit `unsupported`/refusal; compatibility — existing provider
schema paths remain selectable and normalizer changes never alter permission identity.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/llm.test.ts`; required new
tool-schema corpus suite and live mock-provider argument round-trip fixture.
**Rollback:** select the previous provider-specific schema path and retain unsupported reports.

<a id="k14a"></a>

### K14a — Permission adapter design note

**State:** [canonical index](todo.md#wave-4). **Outcome:** a reviewable adapter places one permission vocabulary above the
current authoritative approvals enforcement point, as selected by Q2.
**Dependencies:** current enforcement tracing is ready; final schema/alias mapping depends on K5.
The reviewed trace and deny/allow matrix gate K14b implementation.
**CodeGraph anchors:** [approval target](../packages/core/src/interfaces/environment.ts),
[environment](../packages/core/src/environment/environment.ts),
[server approvals](../packages/server/src/runtime/approvals.ts),
[CLI approval](../packages/cli/src/approval.ts);
[approvals tests](../packages/server/test/approvals.test.ts).

1. <a id="k14a.1"></a>**K14a.1 — Trace existing authority:** produce source-linked direct, aliased, retried, resumed,
   and delegated call paths, identifying where identity is attested and execution is withheld.
2. <a id="k14a.2"></a>**K14a.2 — Specify adapter vocabulary:** define action/target/context and existing decision
   mapping, missing-context refusal, alias restoration, cancellation, and approval freshness.
3. <a id="k14a.3"></a>**K14a.3 — Publish the matrix:** write the design note with allow/deny/forbidden traces for
   every entry class, one-enforcement assertions, fixture ownership, and old-path rollback.
4. <a id="k14a.4"></a>**K14a.4 — Record review:** resolve counterexamples with a concrete path/fixture or an
   evidence-backed Q2 exception proposal; deliver the approval record before routing code begins.

**Acceptance:** positive — every action class has exactly one attested authoritative decision;
negative — missing context, alias drift, replay, or delegated identity loss denies execution;
compatibility — existing CLI/server approval vocabulary and enforcement remain the authority,
with no second policy engine introduced by the note.
**Verify:** source-linked note/matrix review; `rtk proxy pnpm --dir packages/server exec vitest run test/approvals.test.ts`;
`rtk proxy pnpm --dir packages/cli exec vitest run test/approval.test.ts` is the baseline for
the implementation receipt, supplemented by required entry-class trace fixtures.
**Rollback:** retain the reviewed note as design-only and leave execution on the current path.

<a id="k14b"></a>

### K14b — ToolRouter and permission vocabulary

**State:** [canonical index](todo.md#wave-4). **Outcome:** routing uses K14a's adapter and observes the same approval decision
through every tool entry point.
**Dependencies:** reviewed K14a/K5 gate adapter implementation; baseline fixture preparation is
ready. Resume/delegation integrations consume their actual runtime contracts, not invented peers.
**CodeGraph anchors:** [session approval target](../packages/core/src/session.ts),
[environment](../packages/core/src/environment/environment.ts),
[subagent session](../packages/core/src/environment/tools/subagent/session.ts),
[server approvals](../packages/server/src/runtime/approvals.ts);
[approval tests](../packages/server/test/approvals.test.ts).

1. <a id="k14b.1"></a>**K14b.1 — Build the adapter seam:** implement the reviewed context/action representation and
   original-target mapping with typed missing-context refusal.
2. <a id="k14b.2"></a>**K14b.2 — Route through authority:** integrate direct and aliased tools, then retry/resume/
   delegation entry points; call the existing enforcement point once for the logical action.
3. <a id="k14b.3"></a>**K14b.3 — Preserve lifecycle:** propagate denial, cancellation, expired approval, and audit
   correlation to consumers before execution; bind retries to unchanged authorized action material.
4. <a id="k14b.4"></a>**K14b.4 — Prove the ladder:** deliver the full K14a matrix as executable route tests, including
   invocation counters showing one decision and zero execution after denial at every entry point.

**Acceptance:** positive — identical actions receive identical decisions and an allowed call
reaches the actual tool; negative — aliases/retry/resume/delegation cannot bypass denial or reuse
approval for changed material; compatibility — legacy decision/event consumers and CLI modes keep
their existing contract, and the router adds no independent authorization authority.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/approvals.test.ts`;
`rtk proxy pnpm --dir packages/cli exec vitest run test/approval.test.ts`; required new ToolRouter entry-class/gate-ladder fixtures.
**Rollback:** disable new routing and dispatch through the current approvals path.

## Notifications, fleet, evaluation, and orchestration

<a id="k6"></a>

### K6 — Interruption politeness

**State:** [canonical index](todo.md#wave-4). **Outcome:** session-scoped digest, conditions, and preferences coalesce events
into actionable interruptions with explicit recovery and delivery state.
**Dependencies:** E9 gates correlated event intake; notification-policy design is ready. J13's
health producer integrates through this plane after E8/E9, not directly into duplicate UI alerts.
**CodeGraph anchors:** [completion notifications](../packages/web/src/state/use-completion-notifications.ts),
[organization notices](../packages/web/src/features/company/channel-notices.ts),
[logger](../packages/server/src/runtime/logger.ts);
[notice tests](../packages/server/test/organization-notices.test.ts).

1. <a id="k6.1"></a>**K6.1 — Define event policy:** inventory interruption sites; specify session/source dedupe key,
   digest windows, ConditionsFilter, opt-out/quiet-hours, severity, and recovery semantics.
2. <a id="k6.2"></a>**K6.2 — Implement digest/preferences:** coalesce ordered events in bounded state, persist the
   selected preferences, and expose suppression/delivery reasons for audit.
3. <a id="k6.3"></a>**K6.3 — Wire delivery:** adapt current completion/notice consumers and J13 producer contract,
   preserving actionable failure/recovery and canceling timers/subscriptions on unmount/dispose.
4. <a id="k6.4"></a>**K6.4 — Prove timing:** deliver fake-clock burst, quiet-hours, opt-out, recovery, duplicate,
   delivery-failure, and teardown fixtures with actual interruption counts.

**Acceptance:** positive — a rapid related burst becomes one correct digest and recovery is
represented once; negative — flapping, reconnect replay, or failed delivery cannot spam, loop,
or silently erase an actionable state change; compatibility — current completion behavior remains
available with default preferences and project/session boundaries never coalesce unrelated runs.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/organization-notices.test.ts`;
required new digest/ConditionsFilter/preference and web notification-teardown fixtures.
**Rollback:** disable new delivery and preserve event/health data for manual inspection.

<a id="k7"></a>

### K7 — HITL suspend/resume plane

**State:** [canonical index](todo.md#wave-4). **Outcome:** a durable verdict/form request suspends a run, releases capacity,
and resumes only the same authorized pending action.
**Dependencies:** E3, including E2's transport adjudication, gates reconnect/resume integration;
existing approvals remain the authority. Suspension state/fixture design is ready.
**CodeGraph anchors:** [server approvals](../packages/server/src/runtime/approvals.ts),
[session manager](../packages/server/src/runtime/session-manager.ts),
[tool breakpoint panel](../packages/web/src/features/cockpit-widgets/tool-breakpoint-panel.tsx);
[approvals tests](../packages/server/test/approvals.test.ts),
[cockpit resume tests](../packages/server/test/cockpit-resume.test.ts).

1. <a id="k7.1"></a>**K7.1 — Specify durable suspension:** define request/action identity, form schema, owner,
   authenticated verdict, expiry, resume cursor, and one-time terminal transitions.
2. <a id="k7.2"></a>**K7.2 — Persist and release:** record suspension before acknowledging it, release the worker
   slot, and rebuild pending requests after restart without executing the action.
3. <a id="k7.3"></a>**K7.3 — Wire verdict/resume:** render form/reason, validate current authorization and action
   identity, consume the verdict once, then reconnect through E3's generation/cursor contract.
4. <a id="k7.4"></a>**K7.4 — Demonstrate recovery:** deliver suspend→slot release→restart→verdict→resume E2E,
   plus denial, timeout, duplicate verdict, changed form/action, and revoked-access cases.

**Acceptance:** positive — approved durable suspension resumes once and capacity is released;
negative — stale auth, duplicate/expired verdict, denied action, or resume gap cannot execute;
compatibility — existing approvals and transport cursors keep their own schemas and generation
domains, and old clients receive an explicit waiting/restart state.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/approvals.test.ts test/cockpit-resume.test.ts`; required new HITL restart/slot and browser form E2E.
**Rollback:** stop automatic resumption and leave the durable request available for manual restart.

<a id="k8"></a>

### K8 — Eval plane, loop guards, and skill evaluations

**State:** [canonical index](todo.md#wave-4). **Outcome:** deterministic evaluations distinguish scored/notScorable/error,
apply reviewed thresholds, and guard WorkRouter goals using reproducible corpus evidence.
**Dependencies:** C4 gates retrieval-scoring integration and inherits C2/C3 policy gates. Eval
schema, deterministic sampling, four-tier skill-eval rubric, and fixtures can be prepared now.
**CodeGraph anchors:** [ResearchEvalHarness](../packages/core/src/agent/research/eval-harness.ts),
[eval manifest](../packages/core/src/agent/research/eval-manifest.ts),
[WorkRouter](../packages/core/src/engine/swarm/work-router.ts);
[eval tests](../packages/core/test/agent/research/eval-harness.test.ts).

1. <a id="k8.1"></a>**K8.1 — Freeze evaluation contracts:** inventory current scorer outputs; record numeric
   thresholds, tri-state semantics, corpus hashes, and the source-derived four-tier skill rubric.
2. <a id="k8.2"></a>**K8.2 — Make runs reproducible:** implement SHA-256 keyed sampling and versioned manifests,
   storing scorer version, target/corpus revision, artifacts, and explicit notScorable reasons.
3. <a id="k8.3"></a>**K8.3 — Guard loops:** compose scorer outcomes with WorkRouter goal transitions and C4
   retrieval results; stop gated loops on missing goldens, scorer error, or unaccepted threshold.
4. <a id="k8.4"></a>**K8.4 — Evaluate the corpus:** deliver one meaningful fixture per skill-eval tier, boundary
   threshold tests, sampler replay, failure/no-golden traces, and a corpus result table.

**Acceptance:** positive — same seed/input produces the same samples and gate outcomes at the
recorded thresholds; negative — missing golden, NaN/invalid score, scorer fault, or notScorable
never counts as pass; compatibility — existing research eval reports remain readable and scores
cannot silently enable destructive retention or promote AST without their own gates.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/agent/research/eval-harness.test.ts test/agent/research/eval-manifest.test.ts`; required four-tier/loop-guard fixtures.
**Rollback:** disable automatic loop gating and retain explicit evaluation reports.

<a id="k9"></a>

### K9 — Fleet state machine and worktree per agent

**State:** [canonical index](todo.md#wave-4). **Outcome:** one state machine owns slot/worktree assignment, cancellation,
reaping, and restart reconciliation while preserving user-owned checkouts.
**Dependencies:** ready. Existing SwarmCoordinator/WorktreeManager behavior must be reconciled,
not replaced by a second allocator. E10's cleanup fixes apply at shared lifecycle seams.
**CodeGraph anchors:** [SwarmCoordinator](../packages/core/src/agent/swarm-coordinator.ts),
[WorktreeManager](../packages/core/src/environment/worktrees.ts),
[WorkRouter](../packages/core/src/engine/swarm/work-router.ts);
[swarm tests](../packages/core/test/swarm-coordinator.test.ts),
[worktree tests](../packages/core/test/worktrees.test.ts).

1. <a id="k9.1"></a>**K9.1 — Map ownership/transitions:** inventory current slot/assignment/worktree records;
   publish the transition table, managed-versus-user-owned identity rules, and recovery receipts.
2. <a id="k9.2"></a>**K9.2 — Implement atomic assignment:** reserve slot and managed worktree through one owner,
   reject conflicting assignments, and publish durable generation/idempotency state.
3. <a id="k9.3"></a>**K9.3 — Reconcile lifecycle:** implement completion, abort, abandoned worker, and restart
   transitions; stop owned processes and release only resources with proved ownership.
4. <a id="k9.4"></a>**K9.4 — Prove exclusivity:** deliver concurrent assignment, failed setup, crash/restart,
   cancellation/reaping, and preexisting user-worktree fixtures with before/after ownership maps.

**Acceptance:** positive — each running agent owns one slot/worktree and restart reconciles it;
negative — duplicate dispatch, setup failure, abandoned process, or missing owner cannot leak
capacity or delete user state; compatibility — existing router/coordinator limits, registered
worktrees, and user checkouts remain usable and distinguishable.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/swarm-coordinator.test.ts test/worktrees.test.ts test/swarm-task-bounds.test.ts`; required fleet
slot-state/concurrent-restart fixture matrix.
**Rollback:** stop scheduling, preserve managed registrations, and recover worktrees explicitly.

<a id="k10"></a>

### K10 — Rules, context providers, and system-message tools

**State:** [canonical index](todo.md#wave-4). **Outcome:** the three planes have distinct precedence, provenance, failure
behavior, and bounded context contribution through the active session path.
**Dependencies:** ready for plane inventory/design; I1 redaction and R8/C10 lower-trust context
contracts govern sensitive provider material where consumed. A system-message tool cannot create
higher instruction authority from untrusted content.
**CodeGraph anchors:** [ContextEngine](../packages/core/src/engine/context-engine.ts),
[session](../packages/core/src/session.ts),
[environment services](../packages/core/src/interfaces/environment.ts);
[context tests](../packages/web/test/context.test.ts),
[context-mode tests](../packages/core/test/memory/context-mode.test.ts).

1. <a id="k10.1"></a>**K10.1 — Define the three planes:** map existing instruction/context hooks, precedence,
   source trust, activation conditions, token bounds, and errors into separate typed contracts.
2. <a id="k10.2"></a>**K10.2 — Implement rules/providers:** add deterministic rule resolution and bounded provider
   collection with source/revision metadata, cancellation, and explicit unavailable results.
3. <a id="k10.3"></a>**K10.3 — Wire message tools:** integrate the reviewed system-message operation at the real
   session boundary, preserving caller authority and quoting provider content as lower-trust data.
4. <a id="k10.4"></a>**K10.4 — Prove precedence:** deliver per-plane valid/conflict/unknown/provider-failure,
   prompt-injection, over-budget, cancellation, and old-session fixtures plus final context traces.

**Acceptance:** positive — the active session context records the correct precedence and source;
negative — contradictory rules, provider failures, or malicious content cannot silently override
higher authority or exceed bounds; compatibility — existing prompt/context behavior remains
the default until explicit activation, with readable old sessions and unchanged tool approvals.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/memory/context-mode.test.ts`;
`rtk proxy pnpm --dir packages/web exec vitest run test/context.test.ts`; required new three-plane precedence/injection fixture suite.
**Rollback:** disable the affected provider/tool and retain the stable rule set.

<a id="k11a"></a>

### K11a — Orchestration contract note

**State:** [canonical index](todo.md#wave-4). **Outcome:** a reviewed transition contract composes routing, tri-state goals,
scorer guards, ownership, and human handoff without hiding side-effect uncertainty.
**Dependencies:** current call-path/design investigation is ready; K8's reviewed gate contract
is required for final note approval. K9 ownership is consumed where worktree scheduling is used.
**CodeGraph anchors:** [WorkRouter](../packages/core/src/engine/swarm/work-router.ts),
[WorkflowPipeline](../packages/core/src/agent/workflow-pipeline.ts),
[SwarmCoordinator](../packages/core/src/agent/swarm-coordinator.ts);
[router tests](../packages/core/test/engine/swarm/work-router.test.ts).

1. <a id="k11a.1"></a>**K11a.1 — Map current composition:** produce a source-linked routing/pipeline/goal/scorer
   diagram, including local/delegated/network routes and the preserved dispatch rules.
2. <a id="k11a.2"></a>**K11a.2 — Define transitions:** specify tri-state goal/scorer combinations, owner/cursor/
   side-effect identity, bounded iteration, missing verdict, cycles, timeout, and handoff outcomes.
3. <a id="k11a.3"></a>**K11a.3 — Publish executable examples:** deliver a design note and fixture matrix for
   successful delegation, local fallback, unscorable guard, duplicate dispatch, and crash uncertainty.
4. <a id="k11a.4"></a>**K11a.4 — Resolve review:** record approval of the transition table and explicit decisions
   for every counterexample before K11b implementation starts.

**Acceptance:** positive — each dispatch rule has a concrete transition, owner, and observable
result; negative — cycle, missing owner, or unknown verdict yields a safe stop rather than a new
side effect; compatibility — existing WorkRouter local fallback, bounded slots, and report paths
are preserved or explicitly migrated in the reviewed contract.
**Verify:** reviewed source/transition/fixture matrix; baseline command `rtk proxy pnpm --dir packages/core exec vitest run test/engine/swarm/work-router.test.ts test/workflow-pipeline.test.ts`.
**Rollback:** retain this as a design artifact; the existing single-agent/routing path stays usable.

<a id="k11b"></a>

### K11b — Orchestration implementation

**State:** [canonical index](todo.md#wave-4). **Outcome:** reviewed K11a transitions execute bounded work with durable events,
reliable reports, and human handoff through current routing/pipeline entry points.
**Dependencies:** K11a approval and K8 scorer behavior gate execution; K9 gates new worktree
assignment integration. Fixture and event-schema preparation can start from the reviewed draft.
**CodeGraph anchors:** [WorkRouter](../packages/core/src/engine/swarm/work-router.ts),
[WorkflowPipeline](../packages/core/src/agent/workflow-pipeline.ts),
[pipeline routes](../packages/server/src/http/routes/pipelines.ts);
[pipeline tests](../packages/core/test/workflow-pipeline.test.ts).

1. <a id="k11b.1"></a>**K11b.1 — Implement transition core:** encode the reviewed table with bounded step/iteration
   limits, typed stop reasons, stable dispatch ids, and persisted compatible event records.
2. <a id="k11b.2"></a>**K11b.2 — Compose real execution:** wire router allocation, scorer guards, run completion,
   and report return; new worktree usage goes through K9's owner rather than a parallel allocator.
3. <a id="k11b.3"></a>**K11b.3 — Add recovery/handoff:** restore run state, reconcile uncertain effects, release
   capacity on cancellation/timeout, and expose a human handoff with actionable context.
4. <a id="k11b.4"></a>**K11b.4 — Prove composition:** deliver duplicate dispatch, crash-before/after-effect,
   unknown verdict, cycle/step bound, missing owner, and successful routing/report fixtures.

**Acceptance:** positive — the reviewed successful journey reaches execution and its requester
receives the durable result; negative — replay/duplicate/timeout cannot execute a side effect
twice and uncertain state stops explicitly; compatibility — existing pipeline API/readers,
single-agent fallback, and WorkRouter reporting continue to operate.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/workflow-pipeline.test.ts test/engine/swarm/work-router.test.ts`; required orchestration composition/restart suite.
**Rollback:** disable orchestration dispatch and route work through the existing single-agent path.

<a id="k12"></a>

### K12 — Agent-ops dashboards

**State:** [canonical index](todo.md#wave-4). **Outcome:** a scoped dashboard exposes actual run/health/findings state,
provenance, lag, and actionable recovery with honest unknown values.
**Dependencies:** C1 gates findings UI composition; E8/E9 supply health/correlation, and K9 gates
new fleet-state fields if exposed. Existing telemetry inventory and UI states are ready.
**CodeGraph anchors:** [agent cockpit](../packages/web/src/features/agent/agent-cockpit.tsx),
[telemetry hook](../packages/web/src/features/agent/use-cockpit-telemetry.ts),
[health route](../packages/server/src/http/routes/health.ts);
[cockpit telemetry E2E](../packages/web/e2e/cockpit-telemetry.spec.mjs).

1. <a id="k12.1"></a>**K12.1 — Inventory observables:** map each proposed count/status to its scoped producer,
   authorization, timestamp/generation, missing-data state, and user action.
2. <a id="k12.2"></a>**K12.2 — Build the scoped projection:** adapt events/health/findings into bounded dashboard
   data with lag and provenance; reject cross-project input and distinguish unknown from zero.
3. <a id="k12.3"></a>**K12.3 — Render operational journeys:** implement empty/loading/error/lag/recovery states,
   accessible drill-through to run details and C1 findings using the same scope authority.
4. <a id="k12.4"></a>**K12.4 — Demonstrate usability:** deliver actual telemetry/denied-scope fixtures plus keyboard,
   narrow viewport, reconnect, and stale-event journeys with truthful displayed counts.

**Acceptance:** positive — each displayed datum has an authorized producer and recovery control;
negative — denied scope, lag, missing health, or stale stream never fabricates a live count;
compatibility — existing cockpit/run views and separate workspace/project findings scopes remain
accessible, with no inferred binding or silent cross-scope aggregation.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/cockpit-integrity.test.ts`;
extend cockpit telemetry E2E and deliver dashboard scope/state/a11y fixtures.
**Rollback:** hide the dashboard route while retaining existing event and health APIs.

<a id="k13"></a>

### K13 — PiX graph of turns and patch codec

**State:** [canonical index](todo.md#wave-4). **Outcome:** turn ancestry and attributed edits survive replay/provider switch,
and a patch codec can export/reconstruct supported edits with explicit conflicts.
**Dependencies:** K1b gates replay integration. Codec specification/fixtures and license review
are ready; modified MPL-2.0 files require their recorded source/license obligations.
**CodeGraph anchors:** [TurnLedger](../packages/core/src/agent/turn-ledger.ts),
[session fork routes](../packages/server/src/http/routes/sessions.ts),
[session fork tests](../packages/server/test/session-fork.test.ts),
[trace export tests](../packages/server/test/trace-import-export.test.ts).

1. <a id="k13.1"></a>**K13.1 — Specify graph/codec:** define stable turn ancestry, actor/provider/revision provenance,
   patch version, file identity, conflict semantics, and applicable MPL notice/source obligations.
2. <a id="k13.2"></a>**K13.2 — Implement round trip:** encode/decode text edits, renames, newline forms, binary
   references, and partial-patch boundaries without silently applying conflicting material.
3. <a id="k13.3"></a>**K13.3 — Wire ledger ancestry:** project K1b replay into graph-of-turns and authorized export,
   preserving branch/fork identity and original linear ledger access.
4. <a id="k13.4"></a>**K13.4 — Prove portability:** deliver binary/text/CRLF/rename/conflict/partial fixtures,
   provider-switch ancestry assertions, and license/export receipts.

**Acceptance:** positive — supported patches and ancestry round-trip with exact bytes and actor
attribution; negative — partial, conflicting, missing binary, or unsupported codec input fails
explicitly without changing the target; compatibility — linear ledger and ordinary patches remain
usable, old codec versions have an explicit reader path, and scope authorization survives forks.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/turn-ledger.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/session-fork.test.ts test/trace-import-export.test.ts`;
required patch-codec golden/round-trip and graph-of-turns fixture suite.
**Rollback:** export the linear ledger and ordinary patch while disabling the graph projection.

## Audit verification and benchmark ledger

<a id="k16a"></a>

### K16a — Audit-protocol mapping

**State:** [canonical index](todo.md#wave-4). **Outcome:** the audit protocol maps onto existing finding status, evidence,
actor, hypothesis kind, derived confidence labels, and ten-question checklist data.
**Dependencies:** R1b gates lifecycle integration. Mapping/legacy-fixture design is ready;
R0/Q7 scope and R8 provenance rules remain effective. A new candidate status is not the default.
**CodeGraph anchors:** [Finding types](../packages/core/src/knowledge/types.ts),
[FindingsGraph](../packages/core/src/knowledge/findings-graph.ts),
[finding routes](../packages/server/src/http/routes/findings.ts);
[graph tests](../packages/core/test/knowledge/findings-graph.test.ts).

1. <a id="k16a.1"></a>**K16a.1 — Write the mapping:** map candidate investigation to `kind=hypothesis`, current
   statuses/evidence/actors, display-only confidence, and each of the ten quality questions.
2. <a id="k16a.2"></a>**K16a.2 — Define versioned data:** specify checklist version/answers/evidence/override fields,
   derived label rules, unknown legacy data, and a reader-compatible extension.
3. <a id="k16a.3"></a>**K16a.3 — Add mapping helpers:** implement derivation and checklist inspection without adding
   caller-controlled authority or changing legacy confirmation behavior.
4. <a id="k16a.4"></a>**K16a.4 — Prove compatibility:** deliver old snapshots/tool/route response fixtures and every
   evidence/status/actor label row, including unknown and spoofed caller metadata.

**Acceptance:** positive — checklist inspection and confidence display derive from stored facts;
negative — a caller-supplied label/status cannot grant authority or create a verified label;
compatibility — legacy snapshots and consumers parse without status migration, and hypotheses
continue through the existing lifecycle/evidence gates.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/findings-graph.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/findings-routes.test.ts`; required audit mapping/legacy snapshot matrix.
**Rollback:** hide new display labels and preserve the existing finding lifecycle/data.

<a id="k16b"></a>

### K16b — Versioned checklist verification

**State:** [canonical index](todo.md#wave-4). **Outcome:** a new verified label requires the ten-question checklist plus
attested actor/evidence or a specifically audited human override.
**Dependencies:** K16a and R1b/R8 contracts gate new verify ingress. Tool/route/UI compatibility
inventory and negative fixtures are ready; retiring legacy confirm is a separate migration release.
**CodeGraph anchors:** [FindingsGraph](../packages/core/src/knowledge/findings-graph.ts),
[finding routes](../packages/server/src/http/routes/findings.ts),
[Finding types](../packages/core/src/knowledge/types.ts);
[tool tests](../packages/core/test/knowledge/knowledge-graph-tool.test.ts).

1. <a id="k16b.1"></a>**K16b.1 — Freeze ingress compatibility:** enumerate tool/route/UI confirm consumers and old
   snapshots; specify new verify request/version, checklist completeness, evidence, and override.
2. <a id="k16b.2"></a>**K16b.2 — Enforce new verification:** attest actor at trusted ingress, validate all ten answers,
   bind checklist to finding/evidence revision, and append the audit event before success.
3. <a id="k16b.3"></a>**K16b.3 — Wire visible trust:** add tooling/UI verification and display `checklistVerified:false`
   for legacy evidence-gated confirm; keep its behavior during the versioned client migration.
4. <a id="k16b.4"></a>**K16b.4 — Prove both paths:** deliver missing/unsupported answer, stale revision, forged actor,
   failed write, audited override, and old-tool/route/UI fixtures plus a real verification journey.

**Acceptance:** positive — complete supported checklist/evidence produces an attributed verified
label; negative — missing answer, stale checklist, agent spoofing, unsupported claim, or failed
durable write cannot verify; compatibility — legacy confirm remains R1b evidence-gated and visibly
unverified, old snapshots/clients read, and no retirement occurs without its separate release gate.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/knowledge-graph-tool.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/findings-routes.test.ts`; required versioned verify/legacy client and UI fixtures.
**Rollback:** disable new verify action while preserving confirmation, checklist audit data, and claims.

<a id="k17"></a>

### K17 — Benchmark ledger and README section

**State:** [canonical index](todo.md#wave-4). **Outcome:** reproducible benchmark outcomes are queryable by scenario and
README entries derive from a ledger linked to raw artifacts.
**Dependencies:** D10/C4 gate result integration; R0/R2a/R1b/R8 gate scoped, durable, attributed
auto-findings, and I1 gates privacy/redaction of sensitive artifact material. Ledger schema,
artifact validation, and renderer design are ready now.
**CodeGraph anchors:** [eval manifest](../packages/core/src/agent/research/eval-manifest.ts),
[FindingsGraph](../packages/core/src/knowledge/findings-graph.ts),
[finding routes](../packages/server/src/http/routes/findings.ts);
[benchmark validator](../scripts/verify-benchmark-data.mjs), [README](../README.md).

1. <a id="k17.1"></a>**K17.1 — Define run identity:** specify scenario/corpus/tool/source hashes, artifact locations,
   quality/resource result, run key, authority, and latest-valid-run selection in a versioned ledger.
2. <a id="k17.2"></a>**K17.2 — Ingest benchmark outcomes:** validate referenced artifacts and persist idempotent
   ledger rows plus run-keyed **open** findings, including failed/declined promotion outcomes.
3. <a id="k17.3"></a>**K17.3 — Render the README:** generate its Benchmark section from valid ledger data with
   exact raw links, unknown/failed state, and D10 quality/resource decisions preserved.
4. <a id="k17.4"></a>**K17.4 — Prove reproducibility:** deliver repeated-run, missing/tampered artifact, failed run,
   scoped denial, corrupt-store/read-only, and README regeneration fixtures with raw hashes.

**Acceptance:** positive — D10's frozen table is represented as linked open findings and README
regenerates deterministically; negative — replay, missing artifact, failed run, or store failure
cannot create confirmation or a stale green badge; compatibility — existing benchmark reports,
separate findings authorities, Q4 budgets, and human/evidence confirmation remain authoritative.
**Verify:** `rtk proxy pnpm verify:benchmark-data`; required ledger/idempotency/README fixtures
under the existing runner and findings write/read contract suites. Record full raw D10/C4 receipts.
**Rollback:** stop ledger ingestion/generation and retain the previous static report and raw artifacts.

## Visual tokens and graph surfaces

<a id="f10a"></a>

### F10a — Semantic-token measurement

**State:** [canonical index](todo.md#wave-4). **Outcome:** live color-site count, contrast, screenshots, and migration cost
determine whether semantic-token work has a measured benefit under Q6.
**Dependencies:** inventory/prototype measurement is ready; F8's measured component fixes gate
the final comparison baseline. A negative decision preserves F8 and leaves F10b conditional.
**CodeGraph anchors:** [styles](../packages/web/src/styles.css),
[token colors](../packages/web/src/lib/token-colors.ts),
[usage charts](../packages/web/src/features/usage/usage-charts.tsx);
[token color tests](../packages/web/test/usage-token-colors.test.ts),
[a11y E2E](../packages/web/e2e/a11y.spec.mjs).

1. <a id="f10a.1"></a>**F10a.1 — Count live sites:** inventory hard-coded colors including `text-gray-*`, dynamic
   class builders, state variants, and third-party themes; record a reproducible count by family.
2. <a id="f10a.2"></a>**F10a.2 — Measure alternatives:** compare incremental F8 fixes with a representative token
   prototype in normal/dark/mobile and hover/focus/disabled states; record contrast and edit cost.
3. <a id="f10a.3"></a>**F10a.3 — Publish the decision:** deliver site count, ratios, reviewed screenshot differences,
   candidate-family scope, and an explicit Q6 pass/decline/reopen decision.

**Acceptance:** positive — a repeatable report names live sites and first-family migration cost;
negative — worsened contrast, migration cost without benefit, or unreviewed visual drift declines
promotion; compatibility — F8 fixes ship independently and existing themes retain their baseline.
Q6 requires the first family to cut hard-coded color sites by **≥50%**, introduce **no contrast
failure**, and have **zero unreviewed screenshot differences** in normal/dark/mobile states.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/usage-token-colors.test.ts`;
required color-site inventory, ratio table, and reviewed normal/dark/mobile screenshot receipt.
**Rollback:** retain the measurement artifact; keep production on F8's incremental fixes.

<a id="f10b.1"></a>

### F10b.1 — Conditional semantic token map

**State:** [canonical index](todo.md#wave-4). **Outcome:** a small, reviewed semantic map specifies light/dark/interaction
states and alias/contrast behavior for the approved first family.
**Dependencies:** F10a's evidence-backed Q6 decision gates adoption; alias/reference inventory
can start now. Q6's ≥50%/no-contrast-failure/zero-unreviewed-difference gate remains binding.
**CodeGraph anchors:** [styles](../packages/web/src/styles.css),
[token colors](../packages/web/src/lib/token-colors.ts),
[chart SVG](../packages/web/src/features/usage/chart-svg.tsx);
[token color tests](../packages/web/test/usage-token-colors.test.ts).

1. <a id="f10b.1.1"></a>**F10b.1.1 — Specify the map:** enumerate semantic purpose, alias target, light/dark values,
   hover/focus/disabled states, and first-family ownership from F10a's selected candidate.
2. <a id="f10b.1.2"></a>**F10b.1.2 — Introduce compatible aliases:** add the scoped map alongside current tokens,
   with a cycle/unresolved-alias validator and explicit contrast requirements per text/control use.
3. <a id="f10b.1.3"></a>**F10b.1.3 — Prove the map:** deliver alias resolution/cycle/state fixtures, contrast receipts,
   and reviewed first-family reference screenshots; record the approved adoption boundary.

**Acceptance:** positive — every selected alias resolves deterministically in all theme/states;
negative — alias cycle, missing target, failing ratio, or absent Q6 approval prevents adoption;
compatibility — old tokens resolve throughout rollout and third-party themes keep supported hooks.
The card may be conditionally declined only with F10a's evidence and a stated reopen condition.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/usage-token-colors.test.ts`;
required semantic alias/state/contrast fixtures and token-map review receipt.
**Rollback:** disable the new map and retain F8/current token definitions.

<a id="f10b.2"></a>

### F10b.2 — Component-family migration

**State:** [canonical index](todo.md#wave-4). **Outcome:** one component family per reversible slice uses the approved map
and improves live color drift without unreviewed visual or interaction changes.
**Dependencies:** F10b.1 gates migration; first-family before/after inventory is ready after its
map is reviewed. Coordinate touched components with F7/F8/F15 owners before editing.
**CodeGraph anchors:** [usage charts](../packages/web/src/features/usage/usage-charts.tsx),
[chart SVG](../packages/web/src/features/usage/chart-svg.tsx),
[token colors](../packages/web/src/lib/token-colors.ts);
[usage chart tests](../packages/web/test/usage-charts.test.ts),
[a11y E2E](../packages/web/e2e/a11y.spec.mjs).

1. <a id="f10b.2.1"></a>**F10b.2.1 — Freeze family baseline:** claim one F10a-approved family and record its live
   site count, normal/dark/mobile renderings, ratios, focus path, and unchanged public props.
2. <a id="f10b.2.2"></a>**F10b.2.2 — Migrate the family:** replace only measured sites with approved semantic tokens,
   including dynamic/state classes; maintain the old token fallback for other families.
3. <a id="f10b.2.3"></a>**F10b.2.3 — Review the result:** recompute site reduction and ratios, review every screenshot
   difference, exercise keyboard/focus, and deliver the family-specific rollback receipt.
4. <a id="f10b.2.4"></a>**F10b.2.4 — Expand by evidence:** propose the next owned family only after the first meets
   ≥50% reduction, no contrast failure, and zero unreviewed normal/dark/mobile differences.

**Acceptance:** positive — first-family live hard-coded sites fall **≥50%** with reviewed states;
negative — a new contrast failure, unreviewed screenshot difference, or global replacement stops
that rollout; compatibility — unmigrated families and third-party themes retain their styling,
and interaction/public component contracts remain unchanged.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/usage-charts.test.ts test/usage-token-colors.test.ts`; required per-family count/contrast/keyboard/screenshot receipt.
**Rollback:** revert the selected family's migration independently and preserve the compatible map.

<a id="f10b.3"></a>

### F10b.3 — Obsolete-token cleanup

**State:** [canonical index](todo.md#wave-4). **Outcome:** proven unused color aliases are removed after migrated-family
evidence and complete live/dynamic/theme usage accounting.
**Dependencies:** F10b.2 gates deletion; usage inventory can start earlier. Retain aliases with
unmigrated or external consumers; cleanup does not waive the Q6 visual gate.
**CodeGraph anchors:** [styles](../packages/web/src/styles.css),
[token colors](../packages/web/src/lib/token-colors.ts),
[chart geometry/view](../packages/web/src/features/usage/chart-svg.tsx);
[token color tests](../packages/web/test/usage-token-colors.test.ts).

1. <a id="f10b.3.1"></a>**F10b.3.1 — Account for references:** map static and dynamic class generation, alias chains,
   theme exports, fixtures, and third-party hooks to each proposed removal.
2. <a id="f10b.3.2"></a>**F10b.3.2 — Remove proved dead aliases:** delete only aliases with no supported consumer,
   retaining a reversible removal list and updating the theme/token compatibility contract.
3. <a id="f10b.3.3"></a>**F10b.3.3 — Prove cleanup:** deliver zero remaining unresolved references, dynamic/theme
   fixtures, and reviewed normal/dark/mobile renderings against the accepted family baseline.

**Acceptance:** positive — each removed alias has a complete no-consumer proof; negative —
dynamic usage, external-theme compatibility, unresolved mapping, or visual drift blocks that
removal; compatibility — supported theme hooks and unmigrated components still resolve, with no
new contrast failure or unreviewed screenshot change.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/usage-token-colors.test.ts`;
required removal/reference matrix, dynamic-theme fixtures, and visual review receipt.
**Rollback:** restore the named removed aliases independently.

<a id="f11a"></a>

### F11a — Topology signals and store

**State:** [canonical index](todo.md#wave-4). **Outcome:** topology updates preserve stable node/edge/selection identity
through one store adapter over the existing graph data.
**Dependencies:** ready; graph extraction/promotion remains under D9/D10 and Q4. A topology
store does not create a second graph engine; new state primitives require package/license review.
**CodeGraph anchors:** [topology types](../packages/web/src/features/topology/topology-types.ts),
[graph factory](../packages/web/src/features/topology/topology-graph-factory.ts),
[topology page](../packages/web/src/features/topology/topology-page.tsx),
[topology engine](../packages/core/src/codegraph/topology-engine.ts);
[topology tests](../packages/core/test/code-graph-topology.test.ts).

1. <a id="f11a.1"></a>**F11a.1 — Define identity/update rules:** map current node/edge producers and consumers,
   stable keys, source revision, selection, duplicate handling, and stale/missing-data states.
2. <a id="f11a.2"></a>**F11a.2 — Add the store adapter:** normalize updates into bounded state, derive selection,
   and retain engine tier/provenance; document the selected licensed state primitive.
3. <a id="f11a.3"></a>**F11a.3 — Wire page/inspector:** consume one authoritative store for canvas/matrix/inspector,
   preserve selection across compatible refreshes, and clear it explicitly when its node disappears.
4. <a id="f11a.4"></a>**F11a.4 — Prove updates:** deliver rapid/incremental/out-of-order/duplicate-id, removal,
   scope-switch, and stale-revision fixtures with stable identity assertions.

**Acceptance:** positive — shared consumers converge on stable nodes, edges, and selection;
negative — duplicate ids, late updates, or removed nodes cannot create phantom graph entries;
compatibility — current topology API/types, matrix/inspector behavior, and AST/scan provenance
remain readable; the product's `code_graph` surface stays read-only.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/code-graph-topology.test.ts`;
`rtk proxy pnpm --dir packages/web exec vitest run test/agent-topology.test.ts`; required topology-store/update fixture suite.
**Rollback:** route topology consumers through the existing graph factory/view.

<a id="f11b"></a>

### F11b — Topology culling and camera

**State:** [canonical index](todo.md#wave-4). **Outcome:** bounded rendering and camera controls keep large topology graphs
navigable, including keyboard and reduced-motion use.
**Dependencies:** F11a gates stable data/selection integration. Viewport/camera fixtures and
performance baseline are ready; implementation follows the clean-room porting boundary.
**CodeGraph anchors:** [TopologyGraphCanvas](../packages/web/src/features/topology/topology-graph-canvas.tsx),
[memory canvas consumer](../packages/web/src/features/memory/memory-graph-canvas.tsx),
[topology page](../packages/web/src/features/topology/topology-page.tsx);
[inspection E2E](../packages/web/e2e/inspection-pages.spec.mjs).

1. <a id="f11b.1"></a>**F11b.1 — Measure/render contract:** freeze small/large graphs and record node/render cost;
   define camera bounds, visibility margin, selection recovery, keyboard pan, and reduced motion.
2. <a id="f11b.2"></a>**F11b.2 — Implement independent slices:** add deterministic visibility culling and camera
   state/controls with resize handling, bounded work, and separate rollback switches.
3. <a id="f11b.3"></a>**F11b.3 — Preserve navigation:** keep selected offscreen nodes discoverable with fit/focus,
   maintain accessible node labels/list access, and clean up input/resize listeners.
4. <a id="f11b.4"></a>**F11b.4 — Prove usability/performance:** deliver large-graph resource table, zoom/resize,
   edge-boundary, offscreen-selection, keyboard, reduced-motion, and unmount fixtures.

**Acceptance:** positive — visible geometry is correct at zoom/resize and offscreen selection
can be recovered; negative — large inputs, invalid camera values, rapid resizing, or reduced
motion cannot hang layout or conceal the only accessible path; compatibility — shared memory
canvas and existing node selection/inspection keep equivalent behavior.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/agent-topology.test.ts`; required
camera/culling geometry suite and inspection-pages large-graph/keyboard/reduced-motion E2E.
**Rollback:** disable culling or new camera behavior independently and use the current canvas.

<a id="f11c"></a>

### F11c — Topology elbow routing

**State:** [canonical index](todo.md#wave-4). **Outcome:** visible edges use deterministic elbow geometry with readable
loop/overlap/disconnected cases and a safe straight-edge fallback.
**Dependencies:** F11b gates camera/culling geometry integration; pure routing fixtures are ready
once the viewport coordinate contract is recorded.
**CodeGraph anchors:** [topology canvas](../packages/web/src/features/topology/topology-graph-canvas.tsx),
[agent layout](../packages/web/src/features/chat/agent-topology.ts),
[topology types](../packages/web/src/features/topology/topology-types.ts);
[agent topology tests](../packages/web/test/agent-topology.test.ts).

1. <a id="f11c.1"></a>**F11c.1 — Specify coordinates:** define node anchors, routing order, bend rules, loops,
   overlaps, disconnected endpoints, camera transforms, and bounded fallback conditions.
2. <a id="f11c.2"></a>**F11c.2 — Implement pure geometry:** derive stable paths from sorted ids/coordinates,
   handling malformed/missing endpoints explicitly and limiting per-edge routing work.
3. <a id="f11c.3"></a>**F11c.3 — Wire visible routing:** render the routed visible edges under F11b transforms,
   maintain selected/highlighted edge semantics, and surface fallback without layout failure.
4. <a id="f11c.4"></a>**F11c.4 — Prove determinism:** deliver geometry goldens for reordering, loops, overlap,
   disconnection, extreme coordinates, culling, and repeated same-input rendering.

**Acceptance:** positive — repeated equivalent graph/viewport input produces byte-identical
geometry and correct highlighted edges; negative — missing endpoints, cycles, invalid coordinates,
or pathological density cannot hang routing; compatibility — camera/selection and matrix view
semantics remain valid, with straight edges available for unsupported geometry.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/agent-topology.test.ts`; required
elbow-routing golden suite and reviewed inspection-page loop/overlap visual fixtures.
**Rollback:** select straight-edge rendering while retaining node/camera/store improvements.

<a id="f12a"></a>

### F12a — Workflow graph model

**State:** [canonical index](todo.md#wave-4). **Outcome:** typed workflow states/events become stable visual graph data,
with explicit incomplete state and the text timeline as the authority.
**Dependencies:** K11b gates final event mapping; inventory and fixtures may use K11a's reviewed
draft. Existing WorkflowPipeline/pipeline studio are the baseline, not a substitute for new events.
**CodeGraph anchors:** [WorkflowPipeline](../packages/core/src/agent/workflow-pipeline.ts),
[pipeline routes](../packages/server/src/http/routes/pipelines.ts),
[pipeline page](../packages/web/src/features/pipelines/pipelines-page.tsx);
[workflow tests](../packages/core/test/workflow-pipeline.test.ts).

1. <a id="f12a.1"></a>**F12a.1 — Map event/state contracts:** enumerate K11b transitions, stable run/node/edge ids,
   provenance/generation, missing events, late delivery, loops, and authorized scope changes.
2. <a id="f12a.2"></a>**F12a.2 — Build graph projection:** implement deterministic replay/update from events,
   preserving text-timeline references and explicit incomplete/unknown states.
3. <a id="f12a.3"></a>**F12a.3 — Wire the data consumer:** connect authorized run reads and reconnect snapshots to
   the projection, refusing stale generations and preserving selected run identity.
4. <a id="f12a.4"></a>**F12a.4 — Prove mapping:** deliver every transition, replay/duplicate, missing/late event,
   cyclic graph, scope denial, and restart fixture with expected graph plus authoritative timeline.

**Acceptance:** positive — complete event history yields the expected stable graph; negative —
missing events, cycles, or late generations show explicit incomplete state without fabricating
completion; compatibility — current pipeline definitions/runs and text timeline remain readable,
and graph projection never becomes execution authority.
**Verify:** `rtk proxy pnpm --dir packages/core exec vitest run test/workflow-pipeline.test.ts`;
required workflow-graph state/event projection fixtures under the web runner.
**Rollback:** disable graph projection and show the existing text timeline/run data.

<a id="f12b"></a>

### F12b — Workflow renderer

**State:** [canonical index](todo.md#wave-4). **Outcome:** workflow graph state is usable through keyboard navigation,
accessible labels, bounded layout, and narrow screens with a timeline fallback.
**Dependencies:** F12a gates model integration. Layout/accessibility fixtures and existing studio
inventory are ready; reusable topology changes consume their reviewed contracts if selected.
**CodeGraph anchors:** [pipeline studio canvas](../packages/web/src/features/pipelines/pipeline-studio-canvas.tsx),
[pipeline page](../packages/web/src/features/pipelines/pipelines-page.tsx),
[pipeline studio E2E](../packages/web/e2e/pipeline-studio.spec.mjs),
[a11y E2E](../packages/web/e2e/a11y.spec.mjs).

1. <a id="f12b.1"></a>**F12b.1 — Define navigation/layout:** record node focus order, selected/detail behavior,
   accessible status labels, viewport bounds, large-DAG fallback, and incomplete/error copy.
2. <a id="f12b.2"></a>**F12b.2 — Render the model:** adapt F12a graph data to bounded canvas/layout with visible
   state labels and reliable focus/selection; preserve the authoritative text timeline.
3. <a id="f12b.3"></a>**F12b.3 — Add resilient states:** implement loading/empty/error/incomplete/reconnect paths,
   narrow-screen list access, reduced motion, and teardown of event/camera listeners.
4. <a id="f12b.4"></a>**F12b.4 — Demonstrate access:** deliver small/large DAG, cycle/incomplete, keyboard-only,
   screen-reader labels, narrow viewport, dark mode, and error-recovery journeys.

**Acceptance:** positive — a keyboard user reaches every actionable node and reads its actual
status; negative — large/malformed graph, missing event, or narrow viewport cannot create an
unbounded layout or hidden-only status; compatibility — existing studio controls and timeline
remain usable when graph rendering fails or is disabled.
**Verify:** extend `pipeline-studio.spec.mjs` and `a11y.spec.mjs` under
`rtk proxy pnpm --filter @prismshadow/penguin-web test:e2e`; required layout/focus fixtures.
**Rollback:** select the existing list/timeline while retaining the typed graph model.

## Authorized export and cowork surfaces

<a id="f13a"></a>

### F13a — Authorized export DTO

**State:** [canonical index](todo.md#wave-4). **Outcome:** a versioned export snapshot captures only authorized data with
provenance, revision, redaction, and explicit missing/stale content.
**Dependencies:** inventory/design is ready; I1 gates redaction at all export paths. R0/R8/Q7
govern any included findings. Existing trace export is the baseline and requires scope checks.
**CodeGraph anchors:** [trace service](../packages/server/src/services/trace-service.ts),
[trace panel](../packages/web/src/features/traces/trace-panel.tsx),
[credential redactor](../packages/core/src/internal/credential-redactor.ts);
[trace export tests](../packages/server/test/trace-import-export.test.ts).

1. <a id="f13a.1"></a>**F13a.1 — Define DTO/version:** inventory exported chat/trace/graph/chart data, scope ownership,
   source revisions, field allowlist, redaction, complete/partial labels, and supported format inputs.
2. <a id="f13a.2"></a>**F13a.2 — Build authorized snapshot:** collect a consistent server-side revision under current
   project/session access; sanitize nested errors/headers/text before DTO acknowledgement.
3. <a id="f13a.3"></a>**F13a.3 — Wire the export boundary:** expose the versioned DTO through current export control,
   with no raw filesystem paths or inferred workspace↔project merge and clear stale/partial policy.
4. <a id="f13a.4"></a>**F13a.4 — Prove privacy/compatibility:** deliver cross-project, revoked-access, secret/header,
   stale revision, partial load, old DTO reader, and corruption/refusal fixtures.

**Acceptance:** positive — authorized snapshot reproduces its recorded revisions/provenance;
negative — denied/revoked scope or missing consistency refuses, while permitted partial output is
visibly labeled and secret-free; compatibility — current single-view export remains available,
DTO versions have an explicit reader contract, and findings authorities remain separate.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/trace-import-export.test.ts`;
`rtk proxy pnpm --dir packages/core exec vitest run test/redaction-completions.test.ts`; required export DTO/scope/redaction fixture suite.
**Rollback:** disable the new DTO surface and retain the existing authorized single-view export.

<a id="f13b"></a>

### F13b — PPTX, PDF, and print renderers

**State:** [canonical index](todo.md#wave-4). **Outcome:** all three formats render the same authorized DTO with readable
pagination, charts, long text, RTL, and explicit font/asset fallback.
**Dependencies:** F13a gates renderer input integration. Format/library/license inventory and
synthetic layout fixtures are ready; paid jobs or remote publication require separate authorization.
**CodeGraph anchors:** [trace panel](../packages/web/src/features/traces/trace-panel.tsx),
[chart SVG](../packages/web/src/features/usage/chart-svg.tsx),
[chart data table](../packages/web/src/features/usage/chart-data-table.tsx),
[styles](../packages/web/src/styles.css);
[trace export tests](../packages/server/test/trace-import-export.test.ts).

1. <a id="f13b.1"></a>**F13b.1 — Specify render contracts:** choose reviewed format libraries, licensing/size budget,
   page/slide rules, RTL/font fallback, charts/tables, provenance, and missing-data labels.
2. <a id="f13b.2"></a>**F13b.2 — Render the same DTO:** implement PPTX/PDF/print adapters with deterministic layout
   decisions, no extra unauthorized fetches, and format-specific failure reporting.
3. <a id="f13b.3"></a>**F13b.3 — Wire format selection:** connect the export control to the three adapters and preserve
   authorized snapshot identity; support cancellation and a truthful unsupported-format state.
4. <a id="f13b.4"></a>**F13b.4 — Review artifacts:** deliver golden/reviewed small/large, long-text, RTL, chart,
   absent-font/asset, and partial-data artifacts with pagination and actual print review.

**Acceptance:** positive — each format preserves authorized content, readable pagination, and
provenance from the same DTO; negative — font absence, overflow, RTL, missing assets, or renderer
failure cannot silently omit material or report success without an artifact; compatibility —
old export stays usable and unsupported DTO/format versions fail explicitly.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/trace-import-export.test.ts`;
required three-format artifact/golden fixtures, text/content comparison, and print review receipt.
**Rollback:** disable the failing format independently and keep proven export formats available.

<a id="f13c"></a>

### F13c — Export queue

**State:** [canonical index](todo.md#wave-4). **Outcome:** scoped exports report progress, survive restart, remain cancellable,
and retain/download artifacts under bounded ownership and authorization.
**Dependencies:** F13b gates renderer dispatch; F13a/I1 privacy and snapshot contracts remain
effective. Queue state/retention design and restart fixtures are ready.
**CodeGraph anchors:** [trace service](../packages/server/src/services/trace-service.ts),
[trace export tests](../packages/server/test/trace-import-export.test.ts),
[session manager](../packages/server/src/runtime/session-manager.ts),
[trace panel](../packages/web/src/features/traces/trace-panel.tsx).

1. <a id="f13c.1"></a>**F13c.1 — Define queue policy:** specify job/snapshot/idempotency keys, state transitions,
   owner/auth checks, concurrency/storage ceilings, retention/expiry, and restart recovery.
2. <a id="f13c.2"></a>**F13c.2 — Persist dispatch/progress:** enqueue through the authorized DTO boundary, claim jobs
   once, record progress/artifact metadata durably, and recover interrupted jobs truthfully.
3. <a id="f13c.3"></a>**F13c.3 — Wire cancel/download/retention:** expose scoped controls, reauthorize downloads,
   remove only queue-owned expired files, and preserve evidence on failure until the stated policy.
4. <a id="f13c.4"></a>**F13c.4 — Prove lifecycle:** deliver duplicate request, restart mid-render, cancel race, revoked
   access, wrong project, storage ceiling, expiry, and orphan-cleanup fixtures.

**Acceptance:** positive — one logical request yields one authorized artifact or terminal failure,
with usable progress/cancel; negative — crash, duplicate, cancellation, or retention fault cannot
leak an artifact, orphan unbounded files, or falsely complete; compatibility — small synchronous
export remains usable and old DTO/artifact downloads keep their documented expiry/auth contract.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/trace-import-export.test.ts`;
required durable export-queue restart/cancel/auth/retention fixtures and browser progress flow.
**Rollback:** stop queued dispatch, retain authorized existing jobs/artifacts, and use small sync export.

<a id="f14"></a>

### F14 — Cowork badge, reconciliation, warmup, and queue

**State:** [canonical index](todo.md#wave-4). **Outcome:** users see actual fleet/run state, warmup progress, and cancellable
queued commands with reliable stream reconciliation.
**Dependencies:** K9 gates fleet state/ownership integration; E3/E4 generation/gap contracts gate
reconnect behavior where used. UI-state inventory and fixture design are ready.
**CodeGraph anchors:** [agent cockpit](../packages/web/src/features/agent/agent-cockpit.tsx),
[telemetry hook](../packages/web/src/features/agent/use-cockpit-telemetry.ts),
[chat stream](../packages/web/src/features/chat/use-session-stream.ts);
[session status tests](../packages/web/test/session-status-events.test.ts),
[handoff E2E](../packages/web/e2e/cockpit-task-handoffs.spec.mjs).

1. <a id="f14.1"></a>**F14.1 — Map actual states:** define badge/warmup/queued/running/terminal display from K9,
   event generations, authoritative reconciliation, pending command ids, and user actions.
2. <a id="f14.2"></a>**F14.2 — Implement badge/reconciliation:** render source-timed states and recover missed/stale
   stream data from an authoritative snapshot, exposing unknown/resync rather than invented status.
3. <a id="f14.3"></a>**F14.3 — Wire warmup/queue controls:** show real warmup, accept commands through the existing
   authorized path, preserve idempotency, and permit cancellation before execution.
4. <a id="f14.4"></a>**F14.4 — Prove the journey:** deliver rapid transitions, stale/disconnected stream, restart,
   duplicate enqueue, cancel/execute race, failed warmup, keyboard, and narrow viewport cases.

**Acceptance:** positive — displayed state converges on the authoritative run and queued commands
remain actionable; negative — stale websocket, warmup failure, duplicate, or canceled command
cannot claim running/finished falsely or execute twice; compatibility — current run detail and
approval behavior remain usable and unknown gap counts stay unnumbered unless proved by server.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/session-status-events.test.ts`;
extend cockpit-task-handoffs E2E and deliver cowork reconciliation/queue fixture suite.
**Rollback:** hide new queue/warmup controls and keep the existing run-detail surface.

<a id="f15"></a>

### F15 — Chart architecture and palettes

**State:** [canonical index](todo.md#wave-4). **Outcome:** shared scales/palettes render accurate accessible charts with
table fallback and consistent normal/dark/color-vision behavior.
**Dependencies:** F8 gates measured contrast integration; architecture/data fixture work is ready.
F10b is conditional and does not gate incremental chart improvements.
**CodeGraph anchors:** [chart geometry](../packages/web/src/features/usage/chart-geom.ts),
[chart SVG](../packages/web/src/features/usage/chart-svg.tsx),
[chart table](../packages/web/src/features/usage/chart-data-table.tsx),
[sankey chart](../packages/web/src/features/cockpit-widgets/sankey-spend-chart.tsx);
[usage chart tests](../packages/web/test/usage-charts.test.ts).

1. <a id="f15.1"></a>**F15.1 — Freeze data/scale contract:** inventory chart consumers, shared axes/units, zero/
   negative/missing semantics, precision, accessible labels, and palette/contrast baseline.
2. <a id="f15.2"></a>**F15.2 — Implement shared geometry/palette:** centralize scales and state/theme palettes,
   preserving data provenance and distinguishing missing from zero; use non-color cues.
3. <a id="f15.3"></a>**F15.3 — Migrate one chart family:** adapt real cockpit/usage charts with equivalent values,
   accessible table fallback, focus interaction, and explicit empty/error states.
4. <a id="f15.4"></a>**F15.4 — Prove representation:** deliver zero/negative/missing/extreme fixtures, common-scale
   comparisons, dark/color-vision/contrast review, keyboard/table journeys, and next-family boundary.

**Acceptance:** positive — charts and tables show the same units/values and shared scales remain
comparable; negative — missing/negative/extreme values or dark/color-vision states cannot mislead,
overflow, or hide the only information channel; compatibility — current chart APIs and per-chart
fallback remain usable, and semantic-map adoption still requires Q6 if chosen.
**Verify:** `rtk proxy pnpm --dir packages/web exec vitest run test/usage-charts.test.ts test/sankey-spend-chart.test.ts test/chart-view.test.ts`;
required shared-scale/palette/contrast and accessible-table fixtures.
**Rollback:** revert each migrated chart independently to its existing implementation.

<a id="j13"></a>

### J13 — Health degradation alerts

**State:** [canonical index](todo.md#wave-4). **Outcome:** disk, DB, kernel-version skew, and eviction-archive growth produce
deduplicated actionable degradations and recovery through the K6 notification plane.
**Dependencies:** E8/E9/K6 gate alert delivery; health-signal inventory and fixtures are ready.
Wave 2 health endpoints remain independently useful and do not depend on Wave 4 alerts.
**CodeGraph anchors:** [health route](../packages/server/src/http/routes/health.ts),
[logger](../packages/server/src/runtime/logger.ts),
[notification consumer](../packages/web/src/state/use-completion-notifications.ts);
[health tests](../packages/server/test/health.test.ts),
[logger tests](../packages/server/test/structured-logger.test.ts).

1. <a id="j13.1"></a>**J13.1 — Define degradation events:** inventory actual health probes and available archive/
   kernel signals; specify stable source/severity keys, change/recovery rules, scope, and unknown state.
2. <a id="j13.2"></a>**J13.2 — Adapt health transitions:** emit correlated bounded transition events asynchronously,
   distinguishing persistent degradation from flapping/repeated polling and retaining endpoint latency.
3. <a id="j13.3"></a>**J13.3 — Deliver through K6:** connect digest/preferences/conditions, show actionable recovery,
   and isolate sink/notification failure from liveness/readiness and probe execution.
4. <a id="j13.4"></a>**J13.4 — Prove alert behavior:** deliver DB close/recover, disk/probe unavailable, version skew,
   archive growth, flapping, duplicate replay, quiet/opt-out, delivery failure, and teardown fixtures.

**Acceptance:** positive — one meaningful degradation and its recovery yield correct scoped K6
events; negative — flapping/repeated polls/sink failure cannot spam or take down health, and
unavailable probes never imply healthy; compatibility — E8's serving/DB/degraded readiness and
E9's metrics/log correlation remain unchanged, with no new authority in resource_pressure.
**Verify:** `rtk proxy pnpm --dir packages/server exec vitest run test/health.test.ts test/structured-logger.test.ts`; required K6-linked alert/dedupe/recovery fixtures.
**Rollback:** disable alert delivery while preserving health checks, metrics, and diagnostic events.

## Wave 4 closure

Keep every remaining package visible in its receipt. Demonstrate K4/K2 explanations, K3
reversible apply, K1b provider switch, K14 one-authority enforcement, K16 versioned verification,
K17 reproducible artifact ledger, and every shipped product flow. Promotion/default changes
require their selected decision evidence and candidate-SHA release checks. A conditional decline
records the failed criterion, evidence, owner, and reopen condition; it does not fabricate
implementation or mark unrelated work complete.
