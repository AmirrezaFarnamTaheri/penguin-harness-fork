# Wave 3 execution cards

Documentation reconciled on 2026-10-04. Current status and release gates are in
[todo.md](todo.md) and [work-orders.md](work-orders.md); these requirements and historical
observations do not certify the changed working tree.

Read [the implementation guide](implementation-guide.md), [contracts](contracts.md), and the
selected row in [todo.md](todo.md). **Current work state is in todo.md; these cards define
acceptance, not completion.** These 50 cards retain
the 43 original Wave 3 IDs and seven promotions. The archived
[requirements](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/tasks/archive/plan-v3-2026-10-02.md) and
[boundary contracts](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/blob/9f589c721a7cf09c9fb7ec116319161e76218f7c/tasks/archive/execution-cards-2-v3-2026-10-02.md) remain historical evidence.

Claim a numbered package and its files. Inspect existing code before rebuilding it; an existing
primitive needs contract reconciliation and consumer proof. Discovery packages can run while
their integration dependencies are being completed. Dispatch independent UI, skills, configuration,
delivery, memory, and graph packages in parallel, prioritizing repaired defaults and usable
existing primitives. A wave number never blocks an otherwise ready package. Promotion, trusted
scope binding, authorization, and measured resource gates apply only to the actions named below.

Source navigation at this planning baseline: `.codegraph/` exists, but the first CodeGraph
explore attempt failed with `UNIQUE constraint failed: schema_versions.version`. The anchors
below were inspected through read-only file/symbol inventory; no index was rebuilt. At execution,
try CodeGraph first, then use the documented read-only fallback if it remains unavailable.

Verification commands below are future execution instructions, not receipts. Run them from the
repository root with Node >=24 and the manifest's pnpm pin. A **required new fixture** is a
deliverable, not a claim that a test already exists. Use the guide's scoped build, formatting,
typecheck, compatibility, audit, cleanup, and exact-candidate CI rules when applicable. External
posting, publishing, pushing, credential changes, and remote dispatch need the user's scoped
authorization. Local fixtures and drafts remain ready work. Split a package that exceeds five
files or crosses multiple persistence/protocol boundaries; retain the parent acceptance.

## Code intelligence

<a id="d1"></a>

### D1 · Optional lazy TS/JS grammar pack and manifest

**Outcome:** A reproducible, opt-in TS/JS AST pack loads only when requested and reports why a
language falls back to regex. The existing parser substrate is the starting point.

**Depends on:** No implementation prerequisite. Default promotion requires D10; additional
languages belong to D3.

**Start here:** [ParserPool](../packages/core/src/codegraph/ast/parser-pool.ts),
[AST exports](../packages/core/src/codegraph/ast/index.ts),
[core manifest](../packages/core/package.json), [AST tests](../packages/core/test/codegraph/ast-layer.test.ts).

1. <a id="d1.1"></a>**D1.1 — Pin the pack:** Inventory optional runtime loading and grammar lookup; deliver a
   TS/JS-only version/compatibility matrix and reproducible asset recipe with upstream provenance,
   source digests, licenses, and compressed/uncompressed byte totals.
2. <a id="d1.2"></a>**D1.2 — Materialize safely:** Package pinned wasm assets and a hash manifest; load from
   absolute paths behind the opt-in tier. Output is a lazy pack that needs no runtime install.
3. <a id="d1.3"></a>**D1.3 — Integrate fallback:** Exercise the actual parser entry point with valid, missing,
   invalid, and incompatible assets. Output names each affected language and fallback reason;
   other languages and the regex index remain usable.
4. <a id="d1.4"></a>**D1.4 — Record resources:** Deliver repeatable cold-start, parse-latency, package-delta, and
   peak-memory probes on each supported platform, with raw environment and asset hashes for D10.

**Acceptance:** Pin/runtime compatibility and manifest hashes reproduce; TS/JS load lazily.
Named negatives: missing wasm, checksum mismatch, incompatible runtime, cwd change, and failed
one-language load. Regex remains default before D10. No mandatory twelve-grammar payload.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/ast-layer.test.ts`.
Required new deliverables: asset-manifest/fallback fixtures and platform resource receipts;
the existing no-grammar test alone does not establish packaged loading.

**Rollback:** Disable the AST flag and remove only the optional pack; retain regex indexes.

<a id="d2"></a>

### D2 · TS/JS query packs and extractor to shared IR

**Outcome:** Versioned `.scm` packs feed the existing graph IR with stable identity, source
ranges, and FQNs; agent and UI keep one engine seam.

**Depends on:** D1 for real-parser integration; query/fixture design is ready independently.

**Start here:** [IR](../packages/core/src/codegraph/ast/ir.ts),
[FQN helpers](../packages/core/src/codegraph/ast/fqn.ts),
[TS extractor](../packages/core/src/codegraph/symbol-extractors/typescript.ts),
[extractor tests](../packages/core/test/codegraph/symbol-extractors.test.ts).

1. <a id="d2.1"></a>**D2.1 — Freeze extraction contract:** Map each shared IR field to TS/JS captures; deliver
   versioned query-pack schema and six prose-derived CONTRACT input/output goldens.
2. <a id="d2.2"></a>**D2.2 — Implement packs:** Add TS/JS captures and one adapter to the existing IR/FQN/id
   builders. Output retains source ranges and distinguishes same-name declarations.
3. <a id="d2.3"></a>**D2.3 — Wire extraction:** Select AST extraction through the existing language seam and
   retain explicit partial/fallback status after syntax errors or unavailable packs.
4. <a id="d2.4"></a>**D2.4 — Reconcile goldens:** Produce exact expected symbols/calls for methods, receiver
   calls, constructors, branches, nested-lambda non-attribution, and ignored computed callees.

**Acceptance:** All six behaviors pass through the real parser. Named negatives: malformed
syntax gives safe partial output; nested lambdas do not inherit the enclosing caller;
computed callees produce no invented edge; Windows separators do not change stable identity.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/ast-layer.test.ts test/codegraph/symbol-extractors.test.ts`.
Required new fixture deliverable: six TS/JS CONTRACT goldens and versioned query-pack tests.

**Rollback:** Disable AST extraction behind its flag; preserve regex and shared IR readers.

<a id="d3"></a>

### D3 · Individual optional Python, Go, Rust, and Java packs

**Outcome:** Each language gains its own lazy asset and validated extraction/resolution path.

**Depends on:** D10's TS/JS promotion decision before expanding shipping assets. Language
inventory, license review, and fixture drafting can proceed independently.

**Start here:** [language detection](../packages/core/src/codegraph/symbol-extractors/language-detect.ts),
[Python](../packages/core/src/codegraph/symbol-extractors/python.ts),
[Go](../packages/core/src/codegraph/symbol-extractors/go.ts),
[Rust](../packages/core/src/codegraph/symbol-extractors/rust.ts),
[extractor tests](../packages/core/test/codegraph/symbol-extractors.test.ts).

1. <a id="d3.1"></a>**D3.1 — Bound four slices:** Deliver separate Python/Go/Rust/Java manifests, license and
   runtime compatibility checks, current extractor inventory, and proposed per-language fixtures.
2. <a id="d3.2"></a>**D3.2 — Add one pack:** Package and wire one language at a time through D1/D2's seam;
   output includes extraction and import/call-resolution goldens for that language.
3. <a id="d3.3"></a>**D3.3 — Repeat the gate:** Re-run both tiers on that frozen language corpus and D10's
   resource fixture; deliver raw bytes/startup/memory and precision/recall/false-edge decisions.
4. <a id="d3.4"></a>**D3.4 — Ship independently:** Expose the approved language flag/status and missing-asset
   fallback; repeat D3.2–D3.4 for all four named languages with separate rollback receipts.

**Acceptance:** Every language is optional and lazy, license checked, and independently gated.
All D10 limits apply: precision no worse; recall loss <=2 points; >=10% fewer false edges, or

> =5-point recall gain with zero new false edges when baseline has none; compressed delta <=5 MiB;
> p95 <=2× regex and <=2 s on 200 files; incremental peak RSS <=256 MiB. Named negatives:
> missing/unsupported pack, failed language gate, and incompatible asset leave that language on
> regex and cannot disable another language.

**Verification:** Existing baseline:
`rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/symbol-extractors.test.ts`.
Required new deliverables: four language AST/resolution goldens and four D10 decision receipts.

**Rollback:** Disable only the failed language's AST flag and pack.

<a id="d4a"></a>

### D4a · Symbol table and import resolution

**Outcome:** Cross-file resolution uses a shared index with FQN/name/package/type hierarchy and
language/path boundaries; existing import behavior is retained where correct.

**Depends on:** D2 for AST records; index inventory and import goldens are ready now.

**Start here:** [SymbolIndex](../packages/core/src/codegraph/symbol-index.ts),
[types](../packages/core/src/codegraph/types.ts),
[incremental cache](../packages/core/src/codegraph/incremental-graph-cache.ts),
[defect goldens](../packages/core/test/codegraph/codegraph-defects.test.ts).

1. <a id="d4a.1"></a>**D4a.1 — Reconcile indexes:** Trace current by-file/name/export resolution; deliver the
   byFqn/byName/byPackage/typeHierarchy schema and language+path-prefix homonym rules.
2. <a id="d4a.2"></a>**D4a.2 — Implement missing maps:** Populate the maps from shared IR and maintain them on
   add/update/remove. Output keeps distinct identity for same-name symbols across modules.
3. <a id="d4a.3"></a>**D4a.3 — Resolve imports:** Add alias-aware and language-scoped import resolution, with
   explicit unresolved results for missing imports and cycles; update reverse dependencies.
4. <a id="d4a.4"></a>**D4a.4 — Prove order independence:** Deliver cold-build and incremental cross-file fixtures
   whose resolved edges agree regardless of registration order and path separator form.

**Acceptance:** All four maps exist; imports honor aliases and language/path scope. Named
negatives: homonyms, absent imports, cycles, out-of-prefix names, and stale removed symbols
never collapse or fabricate edges.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/codegraph-defects.test.ts test/codegraph/symbol-extractors.test.ts`.
Required new fixture deliverable: AST index/alias/homonym/type-hierarchy matrix.

**Rollback:** Keep regex extraction for failed files and report tier; disable new resolver maps
through the adapter without corrupting cached identity.

<a id="d4b"></a>

### D4b · Call-resolution ladder and overload scoring

**Outcome:** A deterministic resolver records which ladder step selected a callee and drops
ambiguous edges; missing edges are preferable to wrong ones.

**Depends on:** D4a for indexed resolution. Ladder fixtures and baseline call-path mapping are ready.

**Start here:** [resolveCalleeIds](../packages/core/src/codegraph/call-hierarchy.ts),
[variable lifecycle](../packages/core/src/codegraph/variable-lifecycle.ts),
[SymbolIndex](../packages/core/src/codegraph/symbol-index.ts),
[defect tests](../packages/core/test/codegraph/codegraph-defects-2.test.ts).

1. <a id="d4b.1"></a>**D4b.1 — Specify the ladder:** Deliver one observable fixture per step: 0 qualified FQN;
   0.5 ctor heuristic to `<init>`; 1 receiver type; 2 receiver expression (local, property,
   statics); 3 bare name (current class, superclass chain); 4 imports; 5 same package plus
   overload selection; 6 wildcards; 7 extensions filtered by receiver; 8 single candidate or
   common ancestor-chain root, otherwise unresolved; 9–10 stdlib tables; then drop the edge.
2. <a id="d4b.2"></a>**D4b.2 — Add traceable resolution:** Implement missing steps over D4a, recording selected
   step/candidate or unresolved reason. Output bounds inheritance traversal and is deterministic.
3. <a id="d4b.3"></a>**D4b.3 — Score overloads:** Preserve +100 exact arity, -1 per extra, +50 fewer; per argument
   +50 equal, +25 compatible, -10 mismatch, with a documented deterministic tie-break.
4. <a id="d4b.4"></a>**D4b.4 — Integrate and challenge:** Feed resolved edges into the shared topology engine;
   deliver false-edge goldens and direct assertions that ambiguity emits no edge.

**Acceptance:** Every named ladder step and score branch is exercised. Named negatives:
unrelated declaring types, overloaded ambiguity, inheritance loop, unknown receiver, computed
callee, and homonyms produce no fake edge. Goldens contain zero false edges.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/codegraph-defects.test.ts test/codegraph/codegraph-defects-2.test.ts test/code-graph-topology.test.ts`.
Required new fixture deliverable: complete ladder/overload matrix with selected-step traces.

**Rollback:** Disable AST edge promotion while retaining parsed symbols and regex edges.

<a id="d5"></a>

### D5 · Callstack diff and graph_diff tool

**Outcome:** Two versioned graphs produce a stable, bounded callstack comparison with complete
addition/removal visibility and inferred entry points.

**Depends on:** D4b for resolved graphs; D6 when the tool compares Git revisions. Current text
diff helpers are reusable primitives, not proof of callstack diff integration.

**Start here:** [diff helpers](../packages/core/src/codegraph/diff-graph.ts),
[call hierarchy](../packages/core/src/codegraph/call-hierarchy.ts),
[code_graph tool](../packages/core/src/environment/tools/code-graph.ts),
[tool tests](../packages/core/test/knowledge/code-graph-tool.test.ts).

1. <a id="d5.1"></a>**D5.1 — Define diff DTO:** Deliver old/new graph version and identity requirements, output
   shape, callstack fixture pairs, and read-only tool compatibility mapping.
2. <a id="d5.2"></a>**D5.2 — Align callstacks:** Implement sibling LCS with removal-first ties; mark every node
   in added/removed subtrees and recursion with `⇄`. Output is stable across input ordering.
3. <a id="d5.3"></a>**D5.3 — Infer entries:** Use fingerprint-seeded reverse BFS to infer entries, with bounded
   cycle traversal and explicit unknown/incomplete cases.
4. <a id="d5.4"></a>**D5.4 — Wire the tool:** Expose `graph_diff` through the actual tool catalog/handler with
   version and truncation metadata; produce before/after callstack artifacts.

**Acceptance:** Reordered siblings, removed subtrees, recursion, same-name symbols, missing
version, and ambiguous entry inference have named fixtures; no deletion vanishes. The action
stays read-only and emits a bounded compatible result.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/codegraph-defects.test.ts test/knowledge/code-graph-tool.test.ts`.
Required new deliverable: callstack LCS/entry-inference goldens and tool consumer fixtures.

**Rollback:** Disable the diff action independently of indexing; keep the existing graph reader.

<a id="d6"></a>

### D6 · Git snapshot reader

**Outcome:** Two Git object snapshots are read without modifying checkout state; bounded,
oid-deduplicated batch reads return typed failures.

**Depends on:** None. Existing GitSnapshotReader and its exported tests must be reconciled first.

**Start here:** [GitSnapshotReader](../packages/core/src/codegraph/git-snapshot.ts),
[exports](../packages/core/src/codegraph/index.ts),
[snapshot tests](../packages/core/test/codegraph/git-snapshot.test.ts).

1. <a id="d6.1"></a>**D6.1 — Inventory current guarantees:** Map limits, revision validation, file selection,
   environment handling, deduplication, and cancellation to existing assertions.
2. <a id="d6.2"></a>**D6.2 — Close reader gaps:** Deliver only missing bounded-buffer/typed-error behavior around
   oid-deduplicated `cat-file --batch`; source filtering occurs before unrelated blob fetch.
3. <a id="d6.3"></a>**D6.3 — Prove isolation:** Record a two-commit diff fixture with checkout bytes/status
   unchanged and original objects used despite inherited Git environment overrides.
4. <a id="d6.4"></a>**D6.4 — Expose the consumer seam:** Reconcile exports and D5's snapshot adapter; deliver
   a reader result/limitation contract usable without an implicit checkout.

**Acceptance:** Named negatives: missing oid, binary blob, oversized object, invalid revision,
interrupted child, and inherited alternate Git directories yield typed errors or documented
selection behavior. Aborted processes terminate; working-tree bytes stay unchanged.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/git-snapshot.test.ts`.
The existing suite includes two-commit, missing/binary/oversized, abort, source-filter, and Git
environment cases; add a fixture only for a criterion the reconciliation shows missing.

**Rollback:** Use committed-head-only diff with an explicit limitation; disable the adapter.

<a id="d7"></a>

### D7 · GraphStore interface and versioning

**Outcome:** The existing graph store owns all serialization, validation, versioning, checksums,
and atomic replacement; handlers receive a valid graph or an explicit rebuildable miss.

**Depends on:** D4a for the final graph schema; existing persistence proof can run independently.

**Start here:** [GraphStore/FileGraphStore](../packages/core/src/codegraph/graph-store.ts),
[TopologyEngine](../packages/core/src/codegraph/topology-engine.ts),
[store tests](../packages/core/test/codegraph/graph-store.test.ts),
[atomic-write tests](../packages/core/test/atomic-write.test.ts).

1. <a id="d7.1"></a>**D7.1 — Reconcile existing implementation:** Trace engine save/load and exports; deliver a
   serialization-owner map plus every current schema/validation/limit guarantee.
2. <a id="d7.2"></a>**D7.2 — Complete consumer ownership:** Remove any handler-owned serialization through the
   GraphStore interface; output preserves version/checksum/value validation at the store seam.
3. <a id="d7.3"></a>**D7.3 — Exercise replacement/rebuild:** Deliver unsupported-version migration, corrupt
   body/checksum, interrupted write, and concurrent-reader receipts; cache misses rebuild safely.
4. <a id="d7.4"></a>**D7.4 — Bind revision producers:** Define content identity/revision data consumed by D5/C11
   and compatibility with old derived snapshots; record rollback and exact-candidate proof.

**Acceptance:** SCHEMA_VERSION drop-and-recreate is proven; unsupported/corrupt data is never
returned valid. Current default byte ceiling is 64 MiB; custom ceilings hold on reads/writes.
Named negatives: invalid value, checksum mismatch, oversized snapshot, aborted replacement,
and reader during replacement leave either a valid old/new graph or a typed rebuildable miss.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/codegraph/graph-store.test.ts test/atomic-write.test.ts`.
Required new fixture only if current tests omit an interruption or actual engine consumer branch.

**Rollback:** Clear and rebuild only the derived cache; preserve source files and repository state.

<a id="d8"></a>

### D8 · Seeded Louvain and god nodes

**Outcome:** Community overlays are reproducible and keep ordinary clusters visible around hubs.

**Depends on:** D4b for graph integration; deterministic clustering fixtures are ready now.

**Start here:** [graph algorithms](../packages/core/src/codegraph/graph-algorithms.ts),
[topology engine](../packages/core/src/codegraph/topology-engine.ts),
[topology tests](../packages/core/test/code-graph-topology.test.ts).

1. <a id="d8.1"></a>**D8.1 — Define cluster policy:** Deliver weighted adjacency inputs, seed contract,
   codepoint insertion order, god-node detection/display rule, and fixture goldens.
2. <a id="d8.2"></a>**D8.2 — Implement seeded Louvain:** Build deterministic passes and tie-breaks with a seeded
   PRNG; output includes stable memberships and the seed used.
3. <a id="d8.3"></a>**D8.3 — Handle hubs/components:** Apply the god-node policy without deleting graph edges;
   deliver isolated-component, giant-hub, empty, and disconnected outputs.
4. <a id="d8.4"></a>**D8.4 — Wire the overlay:** Expose clusters through the shared graph seam; show two complete
   serialized runs on identical inputs and shuffled insertion inputs.

**Acceptance:** Same seed/input produces byte-identical runs in codepoint order. Named
negatives: isolated node, giant hub, disconnected components, and empty graph neither hang
nor hide all ordinary clusters; underlying edges remain intact.

**Verification:** Existing baseline:
`rtk proxy pnpm --dir packages/core exec vitest run test/code-graph-topology.test.ts`.
Required new deliverable: seeded Louvain/god-node determinism goldens and serialized comparisons.

**Rollback:** Hide the cluster overlay and keep graph edges and ordinary topology intact.

<a id="d9"></a>

### D9 · Explore-first, budgeted tool surface and honest tier

**Outcome:** Tool results and topology status expose the actual tier, freshness, and resource
state, with concise bounded formatting and useful empty-result hints.

**Depends on:** D5/D8 for new diff/cluster consumers; R6 resource contracts. Status/budget
discovery and regex-tier adapters can proceed before AST promotion.

**Start here:** [code_graph](../packages/core/src/environment/tools/code-graph.ts),
[cache](../packages/core/src/environment/tools/code-graph-cache.ts),
[tool tests](../packages/core/test/knowledge/code-graph-tool.test.ts),
[topology canvas](../packages/web/src/features/topology/topology-graph-canvas.tsx).

1. <a id="d9.1"></a>**D9.1 — Map consumers/budgets:** Deliver current catalog gating, result format, limits,
   routing-description owner, and tier/status DTO with staleness and cache statistics.
2. <a id="d9.2"></a>**D9.2 — Format bounded output:** Add explore-first catalog guidance, grouped-by-file
   markdown and pipe formatters, plus `… M more (raise limit…)`; enforce byte/token budgets
   with explicit truncation and a versioned adapter for affected consumers.
3. <a id="d9.3"></a>**D9.3 — Surface honest status:** Wire `status` tier/freshness/cache output and an `AST / scan`
   topology header badge; missing grammar and stale cache have visible reasons.
4. <a id="d9.4"></a>**D9.4 — Improve empty results:** Distinguish absent symbols from definitions with no internal
   callers, including `defined at …`; keep routing guidance solely in the tool description.

**Acceptance:** Named negatives: large/multibyte output, stale graph, absent grammar, definition
without callers, unknown symbol, and incompatible old consumer show honest bounded output.
No definition-only result implies a caller. Tier/status agree between tool and UI; graph remains
read-only. R6 single-flight, LRU cap 8, and accurate hit/scan statistics remain valid.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/code-graph-tool.test.ts test/knowledge/code-graph-cache.test.ts`.
Required new deliverables: formatter/budget/status/empty-hint consumer fixtures and badge UI proof.

**Rollback:** Restore the prior read-only contract through its versioned adapter; hide the badge.

<a id="d10"></a>

### D10 · Frozen AST versus regex benchmark and promotion decision

**Outcome:** A reviewer can reproduce the two-tier quality/resource decision; failed metrics
keep AST opt-in and regex as default.

**Depends on:** D9 for the full agent/tool comparison; D1/D2/D4a/D4b for real AST extraction.
Freeze corpus, budgets, and runner design now; execute comparisons when both tiers are ready.

**Start here:** [TopologyEngine](../packages/core/src/codegraph/topology-engine.ts),
[extractors](../packages/core/src/codegraph/symbol-extractors/index.ts),
[benchmark verifier](../scripts/verify-benchmark-data.mjs),
[verifier fixtures](../scripts/verify-benchmark-data.test.mjs).

1. <a id="d10.1"></a>**D10.1 — Freeze before candidates:** Deliver five named scenario corpora/goldens and a
   fixed 200-file fixture with hashes, environment, exact commits, repeated-sample method,
   metrics, budgets, and raw-artifact paths. Scenario names need an explicit recorded choice.
2. <a id="d10.2"></a>**D10.2 — Run both tiers:** Collect precision, recall, false edges, p50/p95 indexing latency,
   incremental peak RSS, compressed/install bytes, and LLM calls/tokens/cost from identical
   inputs and environments; retain per-scenario raw results and failed runs.
3. <a id="d10.3"></a>**D10.3 — Decide quality/resources:** Require precision no worse than regex, recall loss
   <=2 percentage points, and >=10% fewer false edges if regex has any; otherwise require
   > =5-point recall gain and zero new false edges. Require compressed install delta <=5 MiB,
   > p95 indexing <=2× regex and <=2 s on 200 files, and incremental peak RSS <=256 MiB.
4. <a id="d10.4"></a>**D10.4 — Record promotion:** Deliver table, reviewer decision, affected version, flag state,
   and rollback; link raw runs for K17. Raised budgets require a signed-off record and both-tier
   rerun, with original failure retained. D3 repeats the decision per language.

**Acceptance:** Every metric is present and independently evaluated; averaging cannot hide a
failed limit. Named negatives: missing golden/raw artifact, different corpus/commit/environment,
false-edge regression, over-budget resource use, and failed scenario keep regex default.
The stated limits are release gates, not present performance claims.

**Verification:** Existing provenance check:
`rtk proxy node --test scripts/verify-benchmark-data.test.mjs`.
Required new deliverables: two-tier runner, five-scenario goldens, 200-file fixture, raw repeated
samples, and reviewer decision; no existing benchmark script is claimed to prove AST promotion.

**Rollback:** Leave AST opt-in and archive the failed decision; revert only the default switch.

<a id="d11"></a>

### D11 · Impact advisory inside existing write tools

**Outcome:** A write with >=5 known dependents adds at most one advisory line from a fresh
cached graph, without delaying or authorizing the write.

**Depends on:** R6 and D9's freshness/output contract; impact from D4b **or the existing regex
impact tier**. Inspect/reuse the regex cache now; AST promotion is not a blanket prerequisite.

**Start here:** [edit_file](../packages/core/src/environment/tools/edit-file.ts),
[write_file](../packages/core/src/environment/tools/write-file.ts),
[ImpactRadiusEngine](../packages/core/src/codegraph/impact-radius.ts),
[cache tests](../packages/core/test/knowledge/code-graph-cache.test.ts).

1. <a id="d11.1"></a>**D11.1 — Locate write seams:** Deliver touched-symbol lookup, cached freshness/known-count
   rules, and the exact successful write-result insertion point for both tools.
2. <a id="d11.2"></a>**D11.2 — Add cache-only lookup:** Read the existing fresh graph after ordinary write-policy
   authorization; output is an optional advisory result with no scan or waiting for refresh.
3. <a id="d11.3"></a>**D11.3 — Render one line:** Emit `impact: N dependents (code_graph)` only at >=5 known
   dependents, with honest tier semantics; preserve write result/error and machine envelopes.
4. <a id="d11.4"></a>**D11.4 — Prove independence:** Deliver 4/5 threshold and unknown/missing/stale/slow-cache
   fixtures for edit and write, including a failed write that cannot claim success.

**Acceptance:** <=1 line, cache-hit only, threshold >=5. Named negatives: no cache, stale cache,
unknown symbol, slow lookup, denied write, and failed write neither block nor imply graph
precision. `code_graph` stays read-only; this advisory never becomes an approval decision.

**Verification:** Existing baseline:
`rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/code-graph-cache.test.ts`.
Required new deliverable: both write-tool result fixtures covering notice presence/absence and
no scan/latency coupling.

**Rollback:** Disable the advisory independently of write tools and graph indexing.

## Findings and memory

<a id="c1"></a>

### C1 · Findings cockpit and memory transparency

**Outcome:** The Operate-mode cockpit presents authorized scoped findings, evidence, trusted
actor provenance, lifecycle/recovery state, and finite eviction history.

**Depends on:** R2b; integration consumes R0/R2a scope authority, R1b lifecycle, R8 provenance,
R2c recovery, R5 bounded reads, and R1a archive data. UI model and fixtures are ready now.

**Start here:** [findings routes](../packages/server/src/http/routes/findings.ts),
[route tests](../packages/server/test/findings-routes.test.ts),
[readback graph](../packages/core/src/knowledge/findings-graph.ts),
[memory page](../packages/web/src/features/memory/memory-page.tsx),
[a11y flow](../packages/web/e2e/a11y.spec.mjs).

1. <a id="c1.1"></a>**C1.1 — Map the journey:** Deliver Operate-mode view model, active-scope labeling, API
   adapter, and an eight-route matrix for query/report/confirm/refute/supersede/link/events/snapshot;
   include current reopen/recovery/raw/recovery-operation paths where exposed.
2. <a id="c1.2"></a>**C1.2 — Implement scoped views:** Add list/detail/report controls and empty/loading/error/
   read-only-recovery states; render evidence tiers, status, trusted actor, and legacy `unknown`.
3. <a id="c1.3"></a>**C1.3 — Expose bounded history:** Present archive counts/limits and a “why is this memory
   gone” view using R1a tombstones, with honest expiry/rotation and export/recovery affordances.
4. <a id="c1.4"></a>**C1.4 — Prove the user flow:** Deliver session → report → query → cockpit transcript,
   all-eight-route receipts, keyboard/focus/dark/narrow-screen proof, and scope-switch failures.

**Acceptance:** Every original route is exercised and current recovery/lifecycle controls keep
their contract. Named negatives: outsider/cross-project access, unknown workspace binding,
legacy unknown authorship, corrupt store, empty data, stale revision, and small viewport.
Evidence, actor, provenance, and recovery are visible; finite history is never represented as
perpetual retention. R12 accessibility criteria apply.

**Verification:** `rtk proxy pnpm --dir packages/server exec vitest run test/findings-routes.test.ts`.
Required new deliverables: cockpit view/API fixtures and a scoped browser journey; extend
`packages/web/e2e/a11y.spec.mjs` for shipped findings controls and record the guide's browser run.

**Rollback:** Hide the page and new controls; retain API authority, findings, and archive export.

<a id="c2"></a>

### C2 · Frozen recall baseline and opt-in retention boundary

**Outcome:** Recall/storage/latency evidence and a named policy owner determine whether any
future retention consumer is eligible; R7 Option B remains the default.

**Depends on:** R7. Baseline measurement and consumer inventory are ready independently of C3.

**Start here:** [experimental retention](../packages/core/src/memory/retention.ts),
[RecallStore](../packages/core/src/memory/recall-store.ts),
[frozen baseline](../packages/core/test/memory/recall-baseline.fixture.json),
[retention tests](../packages/core/test/memory/retention.test.ts),
[recall tests](../packages/core/test/memory/recall-store.test.ts).

1. <a id="c2.1"></a>**C2.1 — Freeze baseline inputs:** Reconcile the existing fixture and active RecallStore
   consumer/bounds; deliver corpus hashes, pinned items, expected recall/ranking/retained window,
   environment, and repeated-measurement method.
2. <a id="c2.2"></a>**C2.2 — Measure the active path:** Deliver baseline recall, retained bytes, write volume,
   and latency from the real current consumer, distinguishing exported policy from active behavior.
3. <a id="c2.3"></a>**C2.3 — Define an experiment boundary:** Name a future consumer, opt-in flag owner, pinned
   invariant, rollback, and promotion criteria; if none exists, output explicitly keeps policy
   unconsumed and gives C3 a nondestructive scheduling contract.
4. <a id="c2.4"></a>**C2.4 — Compare candidate policy:** On a copied fixture, prove recall or bounded-storage
   improvement without pinned loss, with restart/repeated-decay/toggle rollback receipts before
   permitting consumption.

**Acceptance:** Frozen ranking/window, write/latency table, explicit owner/flag, and pinned
invariant exist. Named negatives: missing production consumer, repeated decay, restart, policy
rollback, and zero-benefit candidate cannot silently enable destructive retention or lose pinned
memory. Existing experimental formulas are not changed merely to make a candidate look better.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/memory/retention.test.ts test/memory/recall-store.test.ts`.
Required new deliverable: reproducible baseline/candidate receipt with fixture hashes and
consumer inventory; the frozen JSON alone is insufficient.

**Rollback:** Leave `retention.ts` unconsumed and preserve the active RecallStore contract.

<a id="c3"></a>

### C3 · Checkpointed consolidation runner

**Outcome:** Consolidation schedules and thresholds produce one durable outcome per logical
run, with explicit opt-in retention consumption.

**Depends on:** C2 baseline/consumer decision. Timer, checkpoint, and nondestructive runner
design are ready; destructive retention consumption requires C2's successful policy gate.

**Start here:** [consolidate/gates](../packages/core/src/memory/retention.ts),
[hierarchical store](../packages/core/src/memory/hierarchical-memory-store.ts),
[retention tests](../packages/core/test/memory/retention.test.ts),
[store tests](../packages/core/test/memory/hierarchical-memory-store.test.ts).

1. <a id="c3.1"></a>**C3.1 — Specify run identity:** Deliver scheduler ownership, durable checkpoint/run key,
   bounded work batches, and Stop-hook adapter; distinguish scheduling from enabling eviction.
2. <a id="c3.2"></a>**C3.2 — Wire exact schedules:** Implement 2-hour pipeline, 5-minute Stop-hook debounce,
   and 24-hour decay sweep with a testable clock and restart-aware scheduling.
3. <a id="c3.3"></a>**C3.3 — Persist threshold outcomes:** Promote semantic facts only at >=5 summaries and
   procedural facts only at >=2 patterns each with frequency >=2; output is idempotent and
   checkpointed, retaining pinned items and existing findings authority.
4. <a id="c3.4"></a>**C3.4 — Prove replay/boundaries:** Deliver below/equal/above-threshold, duplicate trigger,
   restart-mid-run, clock-skew, no-op write, and opt-in flag receipts.

**Acceptance:** Exact 2 h / 5 min / 24 h timings and both gates are observable; rerun commits
one outcome. Named negatives: 4 summaries, one qualifying pattern, frequency 1, duplicate
Stop-hook, interrupted checkpoint, clock rollback, and disabled experiment cannot create
duplicate outcomes or activate unproven destructive retention.

**Verification:** Existing baseline:
`rtk proxy pnpm --dir packages/core exec vitest run test/memory/retention.test.ts test/memory/hierarchical-memory-store.test.ts`.
Required new deliverable: fake-clock scheduler/checkpoint/restart/threshold matrix at the actual
runner entry point.

**Rollback:** Pause the runner, preserve its checkpoint and originals, then resume explicitly.

<a id="c4"></a>

### C4 · Weighted RRF hybrid retrieval

**Outcome:** Deterministic hybrid ranking exposes each hit's rank provenance without changing
finding status or trust.

**Depends on:** C3 for the consolidation-fed integration; existing retrieval fuser inventory
and reference arithmetic fixtures are ready now.

**Start here:** [retrieval fuser](../packages/core/src/memory/retrieval-fuser.ts),
[hierarchical retrieval](../packages/core/src/memory/hierarchical-memory-store.ts),
[fuser tests](../packages/core/test/memory/retrieval-fuser.test.ts),
[server search tests](../packages/server/test/memory-search.test.ts).

1. <a id="c4.1"></a>**C4.1 — Freeze weighted contract:** Map the three producer channels to the preserved
   0.4/0.6/0.3 weights, K=60, +5% agreement bonus, rank base, tie-break, and provenance-rank
   string. Deliver reference arithmetic fixtures; do not silently normalize the weight sum.
2. <a id="c4.2"></a>**C4.2 — Complete fuser behavior:** Reuse existing reciprocalRankFusion and add missing
   channel/bonus/dedup behavior. Output has deterministic scores and per-channel rank provenance.
3. <a id="c4.3"></a>**C4.3 — Wire retrieval consumer:** Feed authorized candidate lists into the real memory
   search path; preserve status/evidence and mark the selected strategy on returned hits.
4. <a id="c4.4"></a>**C4.4 — Reconcile reference outputs:** Deliver exact expected ranks for agreement,
   conflicting order, duplicates, empty stores, unavailable producer, and stale candidates.

**Acceptance:** 0.4/0.6/0.3, K=60, and +5% agreement are demonstrated in reference fixtures;
channel mapping and bonus arithmetic are recorded before integration. Named negatives: empty
store, rank conflict, duplicate identity, failed producer, and stale/open/refuted candidate
cannot launder status or actor trust through ranking.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/memory/retrieval-fuser.test.ts test/memory/hierarchical-memory-store.test.ts`.
Consumer baseline: `rtk proxy pnpm --dir packages/server exec vitest run test/memory-search.test.ts`.
Required new deliverable: weighted/bonus/provenance reference fixtures.

**Rollback:** Use existing retrieval, label its strategy, and retain rank evidence for comparison.

<a id="c5"></a>

### C5 · Bitemporal edges and asOf

**Outcome:** Historical queries reconstruct valid graph state while preserving commit time,
corrections, and supersession identity.

**Depends on:** C4 for retrieval integration. Temporal schema/migration fixtures can be drafted now.

**Start here:** [knowledge graph store](../packages/core/src/memory/knowledge-graph-store.ts),
[findings snapshot](../packages/core/src/knowledge/findings-graph.ts),
[knowledge store tests](../packages/core/test/memory/knowledge-graph-store.test.ts),
[findings store tests](../packages/core/test/knowledge/findings-store.test.ts).

1. <a id="c5.1"></a>**C5.1 — Specify time semantics:** Deliver `tcommit/tvalid/tvalidEnd/version/supersededBy/isLatest`
   field meanings, asOf boundary rules, backward-reader contract, and scoped migration design.
2. <a id="c5.2"></a>**C5.2 — Persist temporal records:** Add append/version and supersession logic under the
   appropriate store boundary; output retains earlier records and a coherent current view.
3. <a id="c5.3"></a>**C5.3 — Query historical state:** Wire `asOf` through retrieval to reconstruct last week's
   graph with explicit commit-time/valid-time selection and no future evidence leakage.
4. <a id="c5.4"></a>**C5.4 — Rehearse migration/rollback:** Deliver legacy, backdated correction, concurrent
   update, supersession-before/at/after, restart, and byte-exact copied-fixture rollback receipts.

**Acceptance:** All six fields participate in historical reconstruction; last-week golden
matches. Named negatives: backdated correction, concurrent versions, future evidence,
unsupported legacy field, and interrupted migration preserve a readable old/current view.
Workspace and project findings stay separate absent R2d's trusted binding.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/memory/knowledge-graph-store.test.ts test/knowledge/findings-store.test.ts`.
Required new deliverable: bitemporal/asOf and migration/restart fixture matrix.

**Rollback:** Keep legacy query behavior and optional new columns until migration passes;
restore copied-fixture bytes without discarding temporal evidence.

<a id="c6"></a>

### C6 · Supersession cascade to stale

**Outcome:** A validated supersession marks dependent claims stale without deleting them;
similarity alone never becomes authority.

**Depends on:** C5 temporal/source revisions; R1b/R1c lifecycle guards for findings mutations.
Similarity boundary and bounded traversal fixtures are ready now.

**Start here:** [similarity helpers](../packages/core/src/memory/similarity.ts),
[findings lifecycle](../packages/core/src/knowledge/findings-graph.ts),
[similarity tests](../packages/core/test/memory/similarity.test.ts),
[lifecycle tests](../packages/core/test/knowledge/findings-graph.test.ts).

1. <a id="c6.1"></a>**C6.1 — Freeze matching inputs:** Deliver canonical subject/evidence identity, tokenization,
   source-revision requirement, and Jaccard band examples with trust/lifecycle boundaries.
2. <a id="c6.2"></a>**C6.2 — Implement two bands:** At Jaccard >0.7 produce a validated supersession candidate;
   at >0.4 produce a hint. Wire actual supersession only through lifecycle/evidence authority.
3. <a id="c6.3"></a>**C6.3 — Cascade bounded staleness:** Traverse directly dependent evidence under scoped
   revisions, write idempotent stale events, and preserve every claim and its prior history.
4. <a id="c6.4"></a>**C6.4 — Challenge boundaries:** Deliver exactly 0.4/0.7, below/above bands, similar-title-only,
   cycle, repeated trigger, and restart outputs with bounded traversal and no deletion.

**Acceptance:** Strict >0.7 and >0.4 comparisons hold, dependents become stale rather than
deleted, and source revision is recorded. Named negatives: title-only similarity, low
similarity, exact threshold, cyclic dependency, invalid replacement, and untrusted candidate
cannot cascade forever or bypass R1b/R1c.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/memory/similarity.test.ts test/knowledge/findings-graph.test.ts`.
Required new deliverable: similarity-band/source-revision/cascade/restart goldens.

**Rollback:** Disable automatic staleness/supersession while retaining events and source revisions.

<a id="c7"></a>

### C7 · Influence receipts

**Outcome:** An agent action can report a receipt and retrieve it as evidence with attested
agent attribution and stable links.

**Depends on:** R1b; R8 trusted provenance for readback. Receipt schema and replay fixtures are ready.

**Start here:** [knowledge_graph tool](../packages/core/src/environment/tools/knowledge-graph.ts),
[finding types](../packages/core/src/knowledge/types.ts),
[tool tests](../packages/core/test/knowledge/knowledge-graph-tool.test.ts),
[audit receipt tests](../packages/server/test/audit-receipts.test.ts).

1. <a id="c7.1"></a>**C7.1 — Define the receipt:** Deliver action/run/finding/evidence identifiers, revision,
   idempotency key, trusted actor source, and report/query representation.
2. <a id="c7.2"></a>**C7.2 — Record through authority:** Persist receipts via the existing finding mutation path;
   actor is host-attested `agent`, not a free-form source label.
3. <a id="c7.3"></a>**C7.3 — Read back evidence:** Expose receipt linkage and provenance in tool query/evidence
   without granting confirmation or human influence from the receipt alone.
4. <a id="c7.4"></a>**C7.4 — Prove the loop:** Deliver action → report → query round trip, duplicate receipt,
   missing target, forged source, and restart fixtures.

**Acceptance:** Receipt round-trips as evidence with actor `agent`. Named negatives: forged
human source, duplicate logical action, unknown target, revoked scope, and malformed receipt
remain explicit and cannot change lifecycle authority or impersonate a human.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/knowledge-graph-tool.test.ts`.
Required new deliverable: influence receipt round-trip/idempotency/actor fixture matrix.

**Rollback:** Stop receipt writing while preserving findings and previously recorded evidence.

<a id="c9"></a>

### C9 · Explicit MEMORY.md and findings interop

**Outcome:** User-requested import/export preserves both surfaces with stable identities,
revision/provenance, and visible conflicts.

**Depends on:** C1 surface and R0/R2a authority; R8 provenance. Schema and round-trip fixtures
are ready; there is no implicit synchronization or cross-scope migration.

**Start here:** [memory state](../packages/core/src/state/memory.ts),
[findings store](../packages/core/src/knowledge/store.ts),
[memory tests](../packages/core/test/memory.test.ts),
[memory transfer](../packages/web/src/features/agents/memory-transfer.ts),
[transfer tests](../packages/web/test/memory-transfer.test.ts).

1. <a id="c9.1"></a>**C9.1 — Freeze an interop format:** Deliver supported MEMORY.md syntax, stable identity,
   source revision, provenance, lifecycle promotion rules, and explicit import/export ownership.
2. <a id="c9.2"></a>**C9.2 — Preview import/conflicts:** Parse without changing originals; output counts and
   per-id conflicts, malformed lines, and rejected/out-of-scope references.
3. <a id="c9.3"></a>**C9.3 — Apply/export explicitly:** Use acknowledged scoped writes for selected imports and
   stable exports; imported claims remain unverified unless existing evidence gates pass.
4. <a id="c9.4"></a>**C9.4 — Prove preservation:** Deliver round-trip/repeated-import/conflict/malformed/denied
   fixtures, unchanged original bytes on failure, and restart/rollback on copied originals.

**Acceptance:** Both surfaces survive round trip; promotion rules and explicit action are
documented. Named negatives: repeated import, same-id conflict, malformed line, permission
denial, source change after preview, and unmapped scope never silently overwrite or merge.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/memory.test.ts test/knowledge/findings-store.test.ts`.
Existing UI baseline: `rtk proxy pnpm --dir packages/web exec vitest run test/memory-transfer.test.ts`.
Required new deliverable: MEMORY.md/findings interop goldens and rollback fixtures.

**Rollback:** Disable interop; retain both original surfaces and explicit conflict artifacts.

<a id="c10"></a>

### C10 · Session-open known-findings briefing

**Outcome:** Authorized confirmed, non-stale findings provide a <=1,200-token lower-trust
briefing with active scope and the exact revision used.

**Depends on:** R0/R2a/R1b/R8/K18. Scope/token/template discovery is ready; injection requires
authorized identity, persisted revision, and verification eligibility. Unknown binding yields
no cross-scope briefing, and R2d is not an implicit prerequisite for separate labeled scopes.

**Start here:** [Agent session assembly](../packages/core/src/agent.ts),
[knowledge_graph readback](../packages/core/src/environment/tools/knowledge-graph.ts),
[findings store](../packages/core/src/knowledge/store.ts),
[output contract tests](../packages/core/test/knowledge/findings-output-contract.test.ts),
[chat context parts](../packages/web/src/features/chat/context-parts.ts).

1. <a id="c10.1"></a>**C10.1 — Specify eligibility/placement:** Deliver session-open scope resolver, K18 eligibility
   selector, lower-trust message position, token counter, and revision/log fields.
2. <a id="c10.2"></a>**C10.2 — Retrieve authorized claims:** Read the mapped active authority once and select
   confirmed/non-stale claims with trusted provenance; reject legacy-unknown eligibility or
   access failure rather than guessing identity.
3. <a id="c10.3"></a>**C10.3 — Bound/sanitize briefing:** Quote only sanitized bounded titles/subjects as data,
   keep bodies out, and cap the final message at 1,200 tokens. Record exact scopeRevision and
   truncation/selection outcome without treating title text as instructions.
4. <a id="c10.4"></a>**C10.4 — Wire session and panel:** Inject at the real session-open path and render the
   “Known findings” panel/orientation with active scope, revision, and on-demand drill-through.

**Acceptance:** <=1,200 tokens, confirmed/non-stale only, bodies excluded, sanitized lower-trust
data, and revision recorded. Named negatives: unmapped scope, authorization failure, stale/open/
refuted/superseded or legacy claim, title prompt injection, and over-budget candidates produce
no ineligible briefing; an assembled message over 1,200 tokens is not injected. Existing
on-demand query result shapes remain version compatible.

**Verification:** Existing contract baseline:
`rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/findings-output-contract.test.ts test/knowledge/knowledge-graph-tool.test.ts`.
Required new deliverables: session-open scope/trust/budget/injection fixtures and panel flow.

**Rollback:** Disable briefing injection/panel; retain manual query and all stored claims.

<a id="c11"></a>

### C11 · Content-revision-driven finding staleness

**Outcome:** Relevant source-content revisions make directly evidenced findings stale;
filesystem notifications only request comparison.

**Depends on:** R0/R2a/R1b and a persisted source-content revision seam from C5/C6 **or a bounded
D7 adapter**. D7 adapter discovery and content-versus-touch fixtures are ready now; a full
bitemporal/retrieval chain is not required for that bounded seam.

**Start here:** [incremental content cache](../packages/core/src/codegraph/incremental-graph-cache.ts),
[GraphStore](../packages/core/src/codegraph/graph-store.ts),
[watcher](../packages/core/src/agent/code-graph-watcher.ts),
[findings graph](../packages/core/src/knowledge/findings-graph.ts),
[watcher tests](../packages/core/test/code-graph-watcher.test.ts).

1. <a id="c11.1"></a>**C11.1 — Define the revision adapter:** Deliver source identity/content digest persistence,
   directly-evidenced relation mapping, rename semantics, and scoped stale-event ownership.
2. <a id="c11.2"></a>**C11.2 — Compare content:** Reuse cached/persisted graph identity and read content revisions
   after notifications; output distinguishes touch-only from relevant content change.
3. <a id="c11.3"></a>**C11.3 — Persist idempotent stale events:** Change stale metadata through finding authority,
   retain lifecycle status/history, and expose stale badges in query rows and cockpit.
4. <a id="c11.4"></a>**C11.4 — Reconcile missed events:** On restart/recheck compare durable revisions and converge
   after content change/rename without requiring every watcher event to have arrived.

**Acceptance:** Persisted content identity governs staleness; events alone cannot change claim
status. Named negatives: touch-only, unrelated file, unknown revision, renamed identity,
missed watcher, duplicate notification, revoked access, and restart yield scoped, idempotent
outcomes and retain claims. New revision data cannot merge workspace/project authorities.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/code-graph-watcher.test.ts test/codegraph/graph-store.test.ts test/knowledge/findings-graph.test.ts`.
Required new deliverable: directly-evidenced content/touch/rename/missed-event/restart matrix
plus query/cockpit stale-badge mapping.

**Rollback:** Disable automatic stale events and badges; retain stored source revisions/history.

<a id="c12"></a>

### C12 · Findings in the chat surface

**Outcome:** Chat offers a composer “log finding” action, count badge, and path:line drill-through
using the cockpit's scoped API authority.

**Depends on:** C1/R8; R0 scope labeling remains binding. Composer model/draft-preservation
fixtures are ready before cockpit integration.

**Start here:** [chat composer](../packages/web/src/features/chat/chat-input.tsx),
[chat page](../packages/web/src/features/chat/chat-page.tsx),
[session-project resolver](../packages/web/src/features/chat/session-project.ts),
[composer tests](../packages/web/test/composer-send.test.ts),
[session-project tests](../packages/web/test/session-project.test.ts).

1. <a id="c12.1"></a>**C12.1 — Define chat context:** Deliver current file/symbol → report-dialog prefill mapping,
   active-scope count selector, and bounded path:line navigation contract.
2. <a id="c12.2"></a>**C12.2 — Wire composer reporting:** Reuse C1 report dialog/API, preserve unsaved chat draft,
   and expose keyboard-accessible open/cancel/submit controls with trusted actor readback.
3. <a id="c12.3"></a>**C12.3 — Add badge/drill-through:** Refresh count only for authorized active scope; link
   findings to safe path:line controls and clear stale count on project change.
4. <a id="c12.4"></a>**C12.4 — Prove the daily flow:** Deliver keyboard-only prefill → report → badge → detail →
   file journey and unavailable-server/unsaved-draft/scope-switch outputs.

**Acceptance:** All three entry points use one API authority and expose active scope. Named
negatives: server unavailable, unsaved draft, cross-project switch, revoked access, invalid
path/line, and unknown binding do not lose text or show another scope's count.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/composer-send.test.ts test/session-project.test.ts`.
Required new deliverables: findings chat fixtures and browser report/badge/drill-through flow,
including a11y keyboard/focus evidence.

**Rollback:** Hide chat entry points and counts without deleting findings or drafts.

<a id="k18"></a>

### K18 · Attested human verification and briefing eligibility

**Outcome:** Confirm/refute controls preserve evidence gating, authenticated user attribution,
explicit override reason, and audit history; only eligible claims enter C10.

**Depends on:** R1b/R8 and current R1c guards. Dialog/eligibility fixture design is ready;
trusted actor comes from authenticated route context, never UI/tool payload.

**Start here:** [confirm/refute routes](../packages/server/src/http/routes/findings.ts),
[lifecycle engine](../packages/core/src/knowledge/findings-graph.ts),
[route tests](../packages/server/test/findings-routes.test.ts),
[tool tests](../packages/core/test/knowledge/knowledge-graph-tool.test.ts).

1. <a id="k18.1"></a>**K18.1 — Reconcile trusted transition:** Map current evidence/override/actor enforcement
   and produce a confirm/refute/reopen distinction plus C10 eligibility table.
2. <a id="k18.2"></a>**K18.2 — Add verification dialog:** Present evidence and provenance; require non-empty reason
   for authenticated user override and capture explicit refutation rationale where requested.
3. <a id="k18.3"></a>**K18.3 — Persist before eligibility:** Commit attested actor, evidence/override reason,
   audit event, and revision through authority before reflecting success or briefing eligibility.
4. <a id="k18.4"></a>**K18.4 — Prove both callers:** Deliver authenticated-human and agent confirmations, spoofed
   actor/override, missing reason, stale claim, revoked access, and write-failure fixture receipts.

**Acceptance:** `confirmed` still requires >=1 runtime/implementation evidence or explicit
authenticated actor=`user` override with reason. Agent evidence-based confirmation stays visibly
agent-attributed; stale claims remain briefing-ineligible. Named negatives: agent actor spoof,
agent override, missing reason, revoked access, stale claim, and failed durable write cannot
yield eligible human confirmation. This preserves legacy confirm; K16b owns the later separate
ten-question `verify` workflow and client migration.

**Verification:** `rtk proxy pnpm --dir packages/server exec vitest run test/findings-routes.test.ts`;
`rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/findings-graph.test.ts test/knowledge/knowledge-graph-tool.test.ts`.
Required new deliverables: override-dialog and strict-briefing eligibility fixtures.

**Rollback:** Disable new verification controls/briefing eligibility while preserving audit events,
legacy evidence-gated confirmation, and open claims.

## Web interactions and extraction

<a id="f2"></a>

### F2 · Shared UI clock

**Outcome:** Relative labels use one shared clock with correct wall-time display and elapsed
time behavior after tab sleep, without a timer per consumer.

**Depends on:** None. Shared timing files have one owner across concurrent UI work.

**Start here:** [LiveDuration](../packages/web/src/features/chat/live-duration.tsx),
[task stats](../packages/web/src/features/chat/task-stats-line.tsx),
[time formatting tests](../packages/web/test/format.test.ts),
[header stats tests](../packages/web/test/header-stats.test.ts).

1. <a id="f2.1"></a>**F2.1 — Inventory consumers:** Deliver every relative-time timer/caller and required cadence,
   identifying wall clock versus monotonic elapsed semantics and cleanup ownership.
2. <a id="f2.2"></a>**F2.2 — Introduce shared clock:** Add a subscribable/injectable abstraction with one active
   timer and visibility wakeup; output has deterministic fake-clock hooks and last-subscriber cleanup.
3. <a id="f2.3"></a>**F2.3 — Migrate consumers:** Move the inventoried relative-time views onto the abstraction
   without changing format/localization or using timezone changes as elapsed duration.
4. <a id="f2.4"></a>**F2.4 — Prove timing lifecycle:** Deliver fake-time, tab-sleep/resume, timezone change,
   repeated mount/unmount, and multiple-subscriber fixtures with timer counts.

**Acceptance:** Relative labels converge after sleep and retain localized formatting. Named
negatives: clock jump, timezone change, hidden tab, duplicate mount, and last unmount do not
create duplicate/orphan timers or negative elapsed duration.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/format.test.ts test/header-stats.test.ts`.
Required new deliverable: shared-clock subscription/sleep/timezone/cleanup tests; then the
manifest's web suite for the migrated shared contract.

**Rollback:** Restore local timing per affected view if behavior regresses, with cleanup intact.

<a id="f4"></a>

### F4 · Nav-collapse preference migration

**Outcome:** Navigation collapse has one persistent source of truth, coherent legacy migration,
and consistent reload/cross-tab layout.

**Depends on:** None. Coordinate ownership with F7a; finish preference behavior before extraction.

**Start here:** [nav preference helpers](../packages/web/src/lib/nav-group-collapse.ts),
[NavCollapse](../packages/web/src/components/layout/nav-collapse.tsx),
[sidebar](../packages/web/src/components/layout/sidebar.tsx),
[nav tests](../packages/web/test/nav-group-collapse.test.ts),
[navigation E2E](../packages/web/e2e/product-navigation.spec.mjs).

1. <a id="f4.1"></a>**F4.1 — Reconcile current migration:** Map personal/company preference keys, current legacy
   reads, writes, sidebar state, and cross-tab events; output distinguishes correct shipped behavior.
2. <a id="f4.2"></a>**F4.2 — Complete the single owner:** Implement missing legacy-to-current conversion with
   documented precedence and safe malformed/unavailable-storage behavior.
3. <a id="f4.3"></a>**F4.3 — Wire reload/tab convergence:** Ensure sidebar initializes from that owner and storage
   events converge without duplicate state or a mount layout jump; collapsed rows remain inert.
4. <a id="f4.4"></a>**F4.4 — Record compatibility:** Deliver old preference, new preference, malformed value,
   reload, two-tab, narrow-screen, and keyboard fixtures.

**Acceptance:** One authoritative preference and stable migration; original ~20-line estimate
is historical, not a size target. Named negatives: corrupt storage, blocked storage, conflicting
old/new values, two tabs, and restored collapsed state neither crash nor expose hidden focus targets.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/nav-group-collapse.test.ts`.
Use existing `packages/web/e2e/product-navigation.spec.mjs` through the guide's browser runner;
add required migration/cross-tab fixtures if the current flow does not cover them.

**Rollback:** Revert the migration adapter and reset only the new preference key after preserving
the user's previous choice; keep navigation operable.

<a id="f5"></a>

### F5 · Dock registry dedup and mounted tab state

**Outcome:** Switching dock tabs preserves component/draft state and registers each logical tab once.

**Depends on:** None. Reconcile existing mounted-body behavior before replacing it; share dock
ownership with other UI work and F7a's integration.

**Start here:** [dock panel](../packages/web/src/features/dock/dock-panel.tsx),
[dock state](../packages/web/src/features/dock/dock-state.ts),
[mount lifecycle](../packages/web/src/features/dock/use-dock-mount.ts),
[dock tests](../packages/web/test/dock-state.test.ts), [dock E2E](../packages/web/e2e/dock.spec.mjs).

1. <a id="f5.1"></a>**F5.1 — Map current lifecycle:** Deliver registry keys, open/close/reorder/switch ownership,
   mounted tab behavior, hidden subscriptions, and draft/terminal lifetime assertions.
2. <a id="f5.2"></a>**F5.2 — Close dedup gaps:** Consolidate duplicate registry definitions through one key/owner;
   output keeps all open bodies mounted and marks covered/hidden views appropriately.
3. <a id="f5.3"></a>**F5.3 — Preserve tab state:** Wire active selection, reorder, close/reopen, and final disposal
   without remount-on-switch; hidden docks avoid unnecessary work without losing drafts.
4. <a id="f5.4"></a>**F5.4 — Prove user state:** Deliver rapid switch/reorder/mount/unmount/reopen fixtures with
   mount counts, preserved drafts, and terminal/session identity.

**Acceptance:** Named negatives: duplicate registration, rapid switch, reorder, collapsed dock,
and reopen do not double-register, drop drafts, or leak subscriptions. Current correct mounted
body semantics survive; historical ~30-line estimate is not a required diff size.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/dock-state.test.ts test/dock-launcher-state.test.ts`.
Use existing `packages/web/e2e/dock.spec.mjs` and `mobile-dock.spec.mjs`; required new fixture:
mounted-state/dedup behavior if absent from those flows.

**Rollback:** Restore the prior mount/registry path behind a scoped flag; preserve tab state.

<a id="f8"></a>

### F8 · Measured contrast and token-color fixes

**Outcome:** Named contrast failures are fixed through scoped component/token changes with
normal, dark, hover, focus, and disabled-state evidence.

**Depends on:** None. F10b token migration remains conditional and cannot block component fixes.

**Start here:** [token colors](../packages/web/src/lib/token-colors.ts),
[usage page](../packages/web/src/features/usage/usage-page.tsx),
[color tests](../packages/web/test/usage-token-colors.test.ts),
[accessibility primitives](../packages/web/test/accessibility-primitives.test.ts),
[a11y E2E](../packages/web/e2e/a11y.spec.mjs).

1. <a id="f8.1"></a>**F8.1 — Measure live sites:** Reconcile the historical 1.67/2.77/2.98/2.15:1 hits against
   current screens/states; deliver foreground/background pairs, ratios, WCAG target per role,
   and normal/dark/narrow screenshots before choosing a fix.
2. <a id="f8.2"></a>**F8.2 — Add contrast primitives:** Reuse existing color helpers or add tested luminance/ratio
   helpers; output covers alpha/background composition and representative token pairs.
3. <a id="f8.3"></a>**F8.3 — Fix components incrementally:** Change only measured tokens/CSS and validate
   interactive states; record each changed component's before/after ratio and screenshot decision.
4. <a id="f8.4"></a>**F8.4 — Review visual/accessibility proof:** Deliver named-screen contrast table, keyboard/
   focus evidence, and reviewed screenshot differences, with an independent rollback per component.

**Acceptance:** Text targets 4.5:1 for ordinary text and 3:1 where large-text criteria apply;
non-text/focus target 3:1 where applicable, with disabled-state applicability explicit.
Named negatives: dark/hover/focus backgrounds, alpha blending, muted/disabled labels, and
mobile layout cannot hide a new contrast failure. Historical ratios are verified, not assumed.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/usage-token-colors.test.ts test/accessibility-primitives.test.ts`.
Required new deliverables: exact ratio fixtures for fixed pairs and R12 browser/screenshots
covering those screens; F10b's >=50% color-site gate is not imposed on F8.

**Rollback:** Revert one component/token fix at a time while retaining the contrast receipt.

<a id="f9"></a>

### F9 · Calendar semantics and ticket activation

**Outcome:** Calendar navigation exposes grid semantics and ticket controls activate once
without nested buttons, including keyboard and mobile interaction.

**Depends on:** None; calendar and ticket packages can have separate file owners.

**Start here:** [calendar page](../packages/web/src/features/company/calendar-page.tsx),
[ticket drawer](../packages/web/src/features/company/ticket-drawer.tsx),
[tickets page](../packages/web/src/features/company/tickets-page.tsx),
[calendar tests](../packages/web/test/calendar-geom.test.ts),
[ticket tests](../packages/web/test/ticket-board.test.ts).

1. <a id="f9.1"></a>**F9.1 — Reproduce current semantics:** Deliver current calendar cell/header/selection tree
   and ticket interactive nesting/click path, noting any already-correct rendering.
2. <a id="f9.2"></a>**F9.2 — Fix calendar grid:** Add coherent grid/row/cell semantics, accessible date/selection
   labels, and keyboard/focus behavior matching actual available actions.
3. <a id="f9.3"></a>**F9.3 — Fix ticket controls:** Separate parent selection from child actions with semantic
   elements and one activation path; output preserves detail opening and secondary actions.
4. <a id="f9.4"></a>**F9.4 — Prove access:** Deliver screen-reader tree, keyboard activation, single-click count,
   mobile hit-target, and narrow-viewport fixtures for both surfaces.

**Acceptance:** Named negatives: nested interactive control, Enter/Space double activation,
focus lost on date change, empty date, narrow grid, and mobile secondary action do not create
duplicate handlers or unreachable controls. R12 target-size/keyboard criteria apply.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/calendar-geom.test.ts test/ticket-board.test.ts`.
Required new deliverable: semantic/keyboard/touch fixtures in the browser a11y flow; geometry
tests alone cannot prove DOM semantics.

**Rollback:** Revert layout changes independently while retaining corrected semantic activation.

<a id="f7a"></a>

### F7a · Sidebar extraction, step 4

**Outcome:** Sidebar responsibilities move into bounded modules while its public state,
navigation, selection, and persistence behavior remain coherent.

**Depends on:** F4/F5 for shared navigation/dock behavior before integration. Extraction map
and baseline proof can run now; coordinate the sidebar file with C12 and other UI owners.

**Start here:** [sidebar](../packages/web/src/components/layout/sidebar.tsx),
[existing group block](../packages/web/src/components/layout/group-block.tsx),
[session row](../packages/web/src/components/layout/session-row.tsx),
[selection tests](../packages/web/test/session-selection.test.ts),
[group order tests](../packages/web/test/group-order.test.ts).

1. <a id="f7a.1"></a>**F7a.1 — Locate remaining step 4:** Map existing extracts and the remaining sidebar seam;
   deliver exact symbol/JSX boundaries, props/state ownership, and baseline bytes for moved bodies.
2. <a id="f7a.2"></a>**F7a.2 — Extract one seam:** Move behavior-free rendering/helpers first, preserving text,
   classes, exports, and callbacks; output has one owner for each state and no duplicate registry.
3. <a id="f7a.3"></a>**F7a.3 — Reconcile integration:** Update imports and wire navigation/persistence/dock
   contracts after F4/F5, with independently reviewable slices rather than a whole-file rewrite.
4. <a id="f7a.4"></a>**F7a.4 — Prove equivalence:** Deliver a verbatim-body comparison script/receipt plus
   selection/navigation/persistence and visual/keyboard before-after proof.

**Acceptance:** Named negatives: duplicate source of truth, changed JSX/class/body during
extraction, lost selection, collapsed reload, and docking switch are caught by the receipt.
Current source boundaries are authoritative; historical audit step numbers do not justify
re-extracting modules already split.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/session-selection.test.ts test/group-order.test.ts test/nav-group-collapse.test.ts`.
Required new deliverable: path-independent verbatim-check script and baseline hashes;
run the web suite after a coherent shared-state extraction.

**Rollback:** Revert the extraction slice independently of F4/F5 behavior fixes.

<a id="f7b"></a>

### F7b · ChatInput extraction

**Outcome:** Composer rendering/state seams become smaller modules with one submit/abort path.

**Depends on:** None. Share chat-input ownership with C12; its feature integration follows a
stable extraction boundary. The historical 2,911-line count needs current reconciliation.

**Start here:** [chat-input](../packages/web/src/features/chat/chat-input.tsx),
[composer-send](../packages/web/src/features/chat/composer-send.ts),
[draft hook](../packages/web/src/features/chat/use-session-draft.ts),
[composer tests](../packages/web/test/composer-send.test.ts),
[draft tests](../packages/web/test/draft-cache.test.ts),
[attachment tests](../packages/web/test/attachments.test.ts).

1. <a id="f7b.1"></a>**F7b.1 — Map actual seams:** Deliver current line/symbol inventory, submit/abort/draft/IME/
   attachment ownership, moved-body baselines, and one behavior-free first extraction.
2. <a id="f7b.2"></a>**F7b.2 — Extract rendering first:** Move a bounded rendering/helper seam verbatim; output
   preserves callbacks, text/classes, public props, and a single state owner.
3. <a id="f7b.3"></a>**F7b.3 — Extract behavior contracts:** Move remaining seams one slice at a time with explicit
   dependencies and fresh closures; preserve the sole submit/abort and draft persistence path.
4. <a id="f7b.4"></a>**F7b.4 — Prove composer behavior:** Deliver verbatim-check receipts and IME composition,
   attachment, multiline, retained draft, abort, and rapid-submit fixtures.

**Acceptance:** Named negatives: composition Enter, double submit, stale closure, attachment
reorder/removal, session switch, and abort cannot lose drafts or invoke a duplicate path.
Any intended behavior change is a separate package, not concealed in extraction.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/composer-send.test.ts test/draft-cache.test.ts test/attachments.test.ts`.
Required new deliverable: verbatim-body checker/baseline and missing IME/rapid-submit browser
fixtures; run the web suite for the completed composer contract.

**Rollback:** Revert one extraction slice, preserving the original submit/abort state owner.

<a id="f7c"></a>

### F7c · Workspace-browser extraction

**Outcome:** Workspace browsing modules preserve stable selection, pagination, and safe path handling.

**Depends on:** None. Current 2,152-line historical estimate is reconciled before slicing.

**Start here:** [workspace browser](../packages/web/src/features/chat/workspace-browser.tsx),
[tree view](../packages/web/src/features/chat/workspace-tree-view.tsx),
[file menu](../packages/web/src/features/chat/workspace-file-menu.tsx),
[tree tests](../packages/web/test/workspace-tree.test.ts),
[path tests](../packages/web/test/file-path.test.ts),
[visual E2E](../packages/web/e2e/workspace-visual.spec.mjs).

1. <a id="f7c.1"></a>**F7c.1 — Map browser state:** Deliver remaining extraction seams, current selection/page/
   request ownership, existing extracted modules, and baseline bytes for moved bodies.
2. <a id="f7c.2"></a>**F7c.2 — Extract rendering/helpers:** Move a bounded behavior-free slice verbatim with stable
   props, rows, menus, and path validation; preserve existing independent modules.
3. <a id="f7c.3"></a>**F7c.3 — Preserve async contracts:** Extract request/selection seams with explicit stale-response
   and pagination ownership; output prevents an old folder request from selecting current rows.
4. <a id="f7c.4"></a>**F7c.4 — Prove equivalence:** Deliver verbatim receipts plus rename/delete/rapid-folder-switch/
   denied-path/pagination fixtures and existing workspace visual comparison.

**Acceptance:** Named negatives: renamed/deleted selection, slow prior folder, denied path,
page boundary, and unmount cannot retain stale selected rows or weaken path guards.
Text/classes/body moves match baseline except explicit reviewed import adapters.

**Verification:** `rtk proxy pnpm --dir packages/web exec vitest run test/workspace-tree.test.ts test/file-path.test.ts test/file-tree.test.ts`.
Required new deliverable: verbatim checker and missing async-selection fixtures; use existing
`packages/web/e2e/workspace-visual.spec.mjs` and web suite after coherent extraction.

**Rollback:** Revert one extraction slice while retaining safe selection/path behavior.

## Skills governance and product visibility

<a id="g2"></a>

### G2 · Frozen skill-routing probes

**Outcome:** Description-routing regressions produce deterministic expected/actual traces and
fail CI, rather than silently selecting a different skill.

**Depends on:** G1 validator output. Prompt/corpus and scoring inventory are ready now.

**Start here:** [skill engine](../packages/core/src/agent/skill-engine.ts),
[engine tests](../packages/core/test/skill-engine.test.ts),
[skill tests](../packages/core/test/agent-skills.test.ts),
[audit script](../scripts/skills/audit.mjs),
[skill CI](../.github/workflows/skill-integrity.yml).

1. <a id="g2.1"></a>**G2.1 — Freeze representative probes:** Deliver prompt/description corpus with expected
   routed IDs, branch coverage, tie/no-match rules, and source hashes.
2. <a id="g2.2"></a>**G2.2 — Exercise actual scoring:** Run probes through the runtime scorer/resolver rather
   than a duplicate mock formula; output records score, selected ID, and expected/actual trace.
3. <a id="g2.3"></a>**G2.3 — Add routing gate:** Connect the deterministic runner to skill CI using G1's bounded
   corpus handling; failure artifact identifies the responsible description and prompt.
4. <a id="g2.4"></a>**G2.4 — Demonstrate regression:** Deliver a routing-breaking description mutation fixture
   that fails, plus equal-score and no-match fixtures with stable outcomes.

**Acceptance:** Named negatives: routing-breaking edit, scoring tie, empty description,
unmatched prompt, invalid skill, and corpus drift have explicit outcomes. A genuine break
fails CI; ties are deterministic. A noisy-probe exception needs named owner and expiry.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/skill-engine.test.ts test/agent-skills.test.ts`.
Required new deliverable: frozen routing corpus/runner and description-mutation CI fixture.

**Rollback:** Disable only an evidenced noisy fixture with owner/expiry; retain other probes.

<a id="g6"></a>

### G6 · Enforced skill capability manifests

**Outcome:** Skill scripts declare actual network/filesystem/environment capabilities and the
trusted execution boundary enforces them.

**Depends on:** G1 corpus/validator. Manifest/schema inventory and named-script audit are ready;
enforcement integrates with current approval policy without creating a second authority.

**Start here:** [skill engine](../packages/core/src/agent/skill-engine.ts),
[agent-skills tests](../packages/core/test/agent-skills.test.ts),
[directory skill service](../packages/server/src/services/directory-skills.ts),
[directory security tests](../packages/server/test/directory-skills-security.test.ts),
[skill audit](../scripts/skills/audit.mjs).

1. <a id="g6.1"></a>**G6.1 — Locate the script boundary:** Deliver all callable skill-script entry points,
   manifest schema for `network/fs/env`, and the audit's named scripts with observed actual needs.
2. <a id="g6.2"></a>**G6.2 — Validate declarations:** Add bounded manifest parsing and capability validation;
   output distinguishes missing/invalid manifest from valid low-risk or declared-risk capability.
3. <a id="g6.3"></a>**G6.3 — Enforce at execution:** Route script requests through existing trusted policy with
   capability context; undeclared network/fs/env access is refused before execution.
4. <a id="g6.4"></a>**G6.4 — Migrate named scripts:** Declare only actual requirements, then deliver declared/
   undeclared/network/path/env/alias fixtures and passing audit for each named script.

**Acceptance:** Named scripts declare and pass; declared capability is not automatic permission.
Named negatives: missing manifest, undeclared network/fs/env, path escape, forged capability,
alias bypass, and denied approval cannot execute the refused operation. G8 consumes stable
validator/risk results; K14 can later adapt vocabulary above the same decision authority.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/agent-skills.test.ts test/skill-engine.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/directory-skills-security.test.ts`.
Required new deliverable: manifest validator, execution-refusal fixtures, and named-script receipt.

**Rollback:** Disable the affected script while retaining capability checks globally.

<a id="g8"></a>

### G8 · Skills doctor and health badges

**Outcome:** `penguin skills doctor` and the skills page share actionable validation codes and
accurate health/risk badges.

**Depends on:** G1/G3 for the doctor validation/lock slice; G2 for routing results and G6 for
capability badges when those producers exist. Doctor model/CLI is ready without the whole
routing/capability chain; missing producer data is labeled unknown.

**Start here:** [CLI registry](../packages/cli/src/penguin.ts),
[skill audit](../scripts/skills/audit.mjs), [lock verifier](../scripts/skills/lock.mjs),
[skills page](../packages/web/src/features/skills/skills-page.tsx),
[lock tests](../scripts/skills/lock.test.mjs),
[skills E2E](../packages/web/e2e/skills.spec.mjs).

1. <a id="g8.1"></a>**G8.1 — Define shared diagnostics:** Deliver stable result codes, exit-code policy, health/
   risk/unknown badge mapping, and remediation text sourced from actual validator outputs.
2. <a id="g8.2"></a>**G8.2 — Add doctor command:** Wire G1/G3 through `skills doctor` with bounded text/JSON
   output and actionable missing dependency, integrity/drift, invalid, and valid results.
3. <a id="g8.3"></a>**G8.3 — Surface badges:** Feed the same result DTO into the skills page; integrate routing
   and capability producers separately, preserving unknown when unavailable.
4. <a id="g8.4"></a>**G8.4 — Prove agreement:** Deliver CLI exit-code and UI badge fixtures for valid skill,
   missing dependency, lock drift, routing failure, declared risk, and absent producer.

**Acceptance:** Doctor code and badge agree, with actionable distinctions. Named negatives:
missing dependency, risky capability, stale lock, invalid manifest, failed routing producer,
and absent capability producer never turn into a false healthy badge. Diagnostics remain
read-only; remediation cannot silently install or rewrite user skills/config.

**Verification:** `rtk proxy node --test scripts/skills/lock.test.mjs`.
Existing UI flow: `packages/web/e2e/skills.spec.mjs` through the guide's browser runner.
Required new deliverables: doctor CLI/exit-code tests and shared badge-mapping fixtures.

**Rollback:** Hide badges/new CLI command as needed; retain validator and lock-verifier output.

## Configuration and CLI

<a id="h1"></a>

### H1 · Foreign-configuration ownership and transaction contract

**Outcome:** Foreign-config changes have explicit ownership, version gating, backup, atomic
write, redacted readback, and recoverable originals.

**Depends on:** H3 atomic write audit. Contract/copied-fixture design is ready; live foreign
config or credentials are changed only with the user's explicit scoped authorization.

**Start here:** [atomic write](../packages/core/src/internal/atomic-write.ts),
[project config](../packages/core/src/state/project-config.ts),
[config CLI](../packages/cli/src/commands/config.ts),
[atomic security tests](../packages/core/test/atomic-write-security.test.ts),
[config format tests](../packages/cli/test/config-format.test.ts).

1. <a id="h1.1"></a>**H1.1 — Define managed ownership:** Deliver foreign-format/provider adapters,
   `is_managed_provider` proof, supported version range, symlink/permission policy, and original
   bytes/hash/metadata recorded at preview.
2. <a id="h1.2"></a>**H1.2 — Implement the transaction:** Route backup → atomic write → version gate/readback
   → restore through H3; output is a typed transaction result with backup location and diagnostics.
3. <a id="h1.3"></a>**H1.3 — Guard concurrent owners:** Check ownership/version and unchanged hash immediately
   before apply; output refuses an external owner or changed file rather than overwriting it.
4. <a id="h1.4"></a>**H1.4 — Prove restoration:** Deliver successful write/readback and failed-stage/rename/
   external-edit fixtures with byte-exact restore and preserved permissions/managed state.

**Acceptance:** Backup/atomic/version/restore sequence and redacted readback are observable.
Named negatives: unmanaged provider, unsupported version, changed file since preview,
permission denial, failed rename, and symlink target ambiguity preserve recoverable originals.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/atomic-write.test.ts test/atomic-write-security.test.ts`;
`rtk proxy pnpm --dir packages/cli exec vitest run test/config-format.test.ts`.
Required new deliverable: foreign-config ownership/version/write/restore fixture matrix on
Windows and POSIX; current ordinary config tests do not establish foreign ownership.

**Rollback:** Restore byte-exact backup and mark managed ownership false where the adapter no
longer owns the file; preserve diagnostics.

<a id="h2"></a>

### H2 · YAML edit round trip

**Outcome:** Programmatic edits preserve comments, indentation, and indentless sequence style.

**Depends on:** None. Work only on copied fixtures unless an actual config edit is authorized.

**Start here:** [kernel YAML update](../packages/core/src/state/kernel-update.ts),
[agent config state](../packages/core/src/state/agent-state.ts),
[kernel generational tests](../packages/core/test/kernel-generational.test.ts),
[config format tests](../packages/cli/test/config-format.test.ts).

1. <a id="h2.1"></a>**H2.1 — Freeze style fixtures:** Deliver commented documents, indentless sequences,
   nested maps, quoted scalars, empty files, duplicate keys, and unsupported syntax fixtures.
2. <a id="h2.2"></a>**H2.2 — Reconcile existing parser:** Reuse parseDocument's current edit path; define targeted
   node changes and style/unchanged-byte expectations rather than full parse/stringify rewriting.
3. <a id="h2.3"></a>**H2.3 — Implement safe edits:** Preserve formatting/comments for supported shapes; return
   a non-mutating refusal/preview for duplicate keys or syntax the adapter cannot preserve.
4. <a id="h2.4"></a>**H2.4 — Prove round trip:** Deliver edited expected bytes/semantic values and unchanged
   originals for refusals; feed the adapter contract into H1/H4.

**Acceptance:** Comments and indentless-sequence style survive the supported edit fixture.
Named negatives: duplicate key, unsupported syntax, malformed YAML, unexpected root type,
and unrelated comments produce safe refusal or preserve untouched content.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/kernel-generational.test.ts`.
Required new deliverable: YAML style/refusal byte goldens; existing kernel behavior tests are
baseline compatibility proof rather than complete style coverage.

**Rollback:** Leave foreign YAML read-only and retain original bytes/preview.

<a id="h4"></a>

### H4 · Redacted preview and reversible configuration apply

**Outcome:** A concrete ownership-aware preview precedes an explicit reversible apply.

**Depends on:** H1/H2/H3 for apply; preview DTO/UI and copied fixtures are ready. Actual user
configuration/credential changes require explicit scoped authorization; preparing the draft does not.

**Start here:** [config command](../packages/cli/src/commands/config.ts),
[credential redactor](../packages/core/src/internal/credential-redactor.ts),
[atomic write](../packages/core/src/internal/atomic-write.ts),
[config tests](../packages/cli/test/config-format.test.ts),
[redactor tests](../packages/core/test/credential-redactor.test.ts).

1. <a id="h4.1"></a>**H4.1 — Define the preview:** Deliver target path, ownership/version result, permissions,
   backup path, original hash, and redacted before/after diff from H1/H2 adapters.
2. <a id="h4.2"></a>**H4.2 — Wire dry run:** Present readable text/structured preview without modifying bytes;
   sanitize secrets before diff, logs, diagnostics, and saved artifacts.
3. <a id="h4.3"></a>**H4.3 — Apply transactionally:** On explicit apply authorization, recheck original hash and
   ownership then use H1/H3's atomic path; success requires redacted readback and durable result.
4. <a id="h4.4"></a>**H4.4 — Prove faults/rollback:** Deliver forced fault at each write stage and Windows/POSIX
   receipts showing original bytes, comments/style, permissions, and ownership restored.

**Acceptance:** Dry run changes no bytes; secret values never enter preview/log; apply exposes
the reviewed target/backup and has a reversible receipt. Named negatives: secret nested field,
external edit, mid-write/rename/readback failure, permission failure, and unsupported style
restore or refuse with readable diagnostics.

**Verification:** `rtk proxy pnpm --dir packages/cli exec vitest run test/config-format.test.ts test/config-vault.test.ts`;
`rtk proxy pnpm --dir packages/core exec vitest run test/credential-redactor.test.ts test/atomic-write.test.ts`.
Required new deliverable: preview/apply/rollback fixture suite on Windows and POSIX.

**Rollback:** Restore byte-exact backup, permissions, and ownership; disable apply independently
of read-only preview.

<a id="h5"></a>

### H5 · Simple, default, and full CLI help

**Outcome:** Help offers a usable concise default and explicit simple/full modes with consistent
localized command guidance.

**Depends on:** None. Keep one CLI registry owner across H6/H7/G8 changes.

**Start here:** [penguin registry](../packages/cli/src/penguin.ts),
[usage errors](../packages/cli/src/usage-error.ts),
[root options](../packages/cli/src/root-option.ts),
[usage tests](../packages/cli/test/usage-error.test.ts),
[i18n tests](../packages/cli/test/i18n.test.ts).

1. <a id="h5.1"></a>**H5.1 — Define mode contract:** Deliver simple/default/full command inventories, invocation
   syntax, terminal-width policy, and localized expected output from the current registry.
2. <a id="h5.2"></a>**H5.2 — Render concise defaults:** Add registry-derived mode filtering with explicit full
   help access; output keeps `--help`, bare invocation, and `--version` exit semantics.
3. <a id="h5.3"></a>**H5.3 — Preserve errors/guidance:** Ensure unknown command/option and nested subcommand
   errors provide the correct mode/usage without echoing user values.
4. <a id="h5.4"></a>**H5.4 — Snapshot modes:** Deliver all-three-mode, nested-command, EN/ZH, narrow-terminal,
   unknown-command, bare invocation, and version snapshots.

**Acceptance:** Simple/default/full all exist, default is short, and full mode is explicit.
Named negatives: narrow terminal, unknown command, malformed mode, nested context, and long
localized text retain usable guidance; help/version continue to exit 0.

**Verification:** `rtk proxy pnpm --dir packages/cli exec vitest run test/usage-error.test.ts test/i18n.test.ts`.
Required new deliverable: three-mode CLI snapshots and invocation/width fixtures.

**Rollback:** Retain the existing full help renderer as the fallback.

<a id="h6"></a>

### H6 · Command-hint graph

**Outcome:** Related-command hints derive from one registry and remain accurate after commands
or aliases change.

**Depends on:** H5 help contract; registry/graph fixtures are ready now.

**Start here:** [command registry](../packages/cli/src/penguin.ts),
[usage renderer](../packages/cli/src/usage-error.ts),
[localized text](../packages/cli/src/i18n.ts),
[usage tests](../packages/cli/test/usage-error.test.ts).

1. <a id="h6.1"></a>**H6.1 — Model relationships:** Deliver related-command/alias edges from the current
   registry and the points where simple/default/full help may show a hint.
2. <a id="h6.2"></a>**H6.2 — Resolve hints:** Add cycle-safe, deduplicated registry lookup and stable ordering;
   output contains only registered accessible commands.
3. <a id="h6.3"></a>**H6.3 — Render actionable hints:** Integrate context-appropriate usage examples/localized
   labels with H5, keeping one authoritative command vocabulary.
4. <a id="h6.4"></a>**H6.4 — Prove graph changes:** Deliver removed-command, alias, cycle, unknown context,
   nested-command, and narrow-output fixtures with exact expected hint text.

**Acceptance:** Named negatives: deleted command, dangling edge, alias cycle, duplicate target,
and unknown current command never show a misleading or repeated hint. Registry is the single
source of truth and normal help remains usable when no hint exists.

**Verification:** `rtk proxy pnpm --dir packages/cli exec vitest run test/usage-error.test.ts`.
Required new deliverable: command-hint graph/rendering fixtures.

**Rollback:** Omit hints while retaining H5/help and parse-error behavior.

<a id="h7"></a>

### H7 · Bounded argument suggestions

**Outcome:** Existing typo suggestions remain command-scoped, unique, bounded, and secret safe.

**Depends on:** None. Inspect existing implementation and tests before adding a replacement.

**Start here:** [suggestKnownToken/boundedLevenshtein](../packages/cli/src/arg-suggestions.ts),
[commandForArgv](../packages/cli/src/usage-error.ts),
[usage tests](../packages/cli/test/usage-error.test.ts).

1. <a id="h7.1"></a>**H7.1 — Reconcile current bounds:** Map active command vocabulary, option arity, inline
   value stripping, safe-token grammar, unique-best selection, and existing case coverage.
2. <a id="h7.2"></a>**H7.2 — Close parser ownership gaps:** Preserve the deepest registered command and known
   option arity so positional/option values cannot change vocabulary ownership.
3. <a id="h7.3"></a>**H7.3 — Preserve privacy/bounds:** Retain current input bound >32 => no suggestion, distance
   2 for normalized length >=7 otherwise 1, safe registered candidates only, and tie refusal;
   strip values after `=` before matching and never echo original unknown tokens/paths/secrets.
4. <a id="h7.4"></a>**H7.4 — Produce acceptance receipt:** Reconcile typo/ambiguity/distance/no-echo/arity cases
   and add only missing command-scope or privacy regression fixtures.

**Acceptance:** Named negatives: ambiguous tie, distant token, >32-character input, path,
secret, inline value, option value resembling a command, and unknown flag yield generic safe
guidance or one correct registered suggestion. No user value is echoed.

**Verification:** `rtk proxy pnpm --dir packages/cli exec vitest run test/usage-error.test.ts`.
Current suite names typo, ambiguity, distance, no-echo, and commandForArgv/arity cases;
record full reconciliation rather than rebuilding proven behavior.

**Rollback:** Disable suggestions and retain generic localized parse errors.

## Security and delivery

<a id="i6"></a>

### I6 · Redact first, compact audit payloads

**Outcome:** Compact audit payloads preserve event type, structure, correlation, and integrity
after I1 redaction, with an explicit byte ceiling.

**Depends on:** I1 for every emitting/export path. Schema/cap and fixture inventory are ready;
do not claim complete privacy while I1's trace/export consumers remain unreconciled.

**Start here:** [AuditRecorder](../packages/server/src/sandbox/audit.ts),
[audit reader](../packages/server/src/sandbox/read-audit.ts),
[credential redactor](../packages/core/src/internal/credential-redactor.ts),
[redaction tests](../packages/core/test/redaction-completions.test.ts),
[audit signing tests](../packages/server/test/audit-signing.test.ts).

1. <a id="i6.1"></a>**I6.1 — Freeze compact schema:** Inventory payload emitters/exports and current reader
   limits; deliver preserved type/correlation/sequence fields, byte-cap policy, and compatibility.
2. <a id="i6.2"></a>**I6.2 — Redact before shrinking:** Apply shared structural/header/error redactors before
   truncation, hashing, logs, or export; preserve I1's 14-header allowlist contract.
3. <a id="i6.3"></a>**I6.3 — Compact deterministically:** Bound serialized UTF-8 payload bytes with explicit
   omitted/truncated metadata and structural summaries; compute integrity over the stored form.
4. <a id="i6.4"></a>**I6.4 — Prove privacy/readback:** Deliver nested-error, large/multibyte body, secret/header
   variants, correlation round-trip, export, and signing/readback fixture receipts.

**Acceptance:** Event type/correlation and parseable structure survive; cap and exact treatment
of oversized fields are documented before implementation. Existing audit read bounds remain
1 MiB tail and 50 receipts unless a separately reviewed change is needed. Named negatives:
nested credential, truncated secret, unknown header, large multibyte body, invalid integrity,
and export cannot leak or claim a complete omitted payload.

**Verification:** `rtk proxy pnpm --dir packages/core exec vitest run test/credential-redactor.test.ts test/redaction-completions.test.ts`;
`rtk proxy pnpm --dir packages/server exec vitest run test/audit-signing.test.ts test/read-audit-signing.test.ts test/audit-receipts.test.ts`.
Required new deliverable: compact-schema/byte-cap/redact-before-sign/export fixtures.

**Rollback:** Disable the verbose payload event while retaining minimal type/correlation records.

<a id="j2"></a>

### J2 · Immutable external Actions

**Outcome:** Workflows use verified immutable external action commits and a reproducible update
procedure while retaining minimal permissions.

**Depends on:** None. Pin inventory and local workflow patch are ready; updating remote CI
configuration or pushing requires the user's scoped authorization.

**Start here:** [CI](../.github/workflows/ci.yml),
[desktop build](../.github/workflows/desktop-build.yml),
[Docker workflow](../.github/workflows/docker.yml),
[shared setup](../.github/actions/setup/action.yml).

1. <a id="j2.1"></a>**J2.1 — Inventory external refs:** Deliver every workflow/composite external action owner,
   mutable ref, existing permission, and verified upstream release-to-commit mapping.
2. <a id="j2.2"></a>**J2.2 — Pin locally:** Replace external mutable refs with full immutable SHAs and readable
   release comments; retain local `./` actions and current functional inputs/permissions.
3. <a id="j2.3"></a>**J2.3 — Add policy scanner:** Validate action references and deny mutable/unknown external
   actions; deliver an explicit allow/update policy instead of trusting SHA-shaped text alone.
4. <a id="j2.4"></a>**J2.4 — Review workflow behavior:** Deliver parsed workflow/actionlint receipt, mutable-ref/
   unknown-action fixtures, and a narrow update/rollback procedure with verified upstream hashes.

**Acceptance:** Named negatives: mutable tag, unknown owner/action, malformed SHA, nested
composite ref, and permission expansion fail review/scanner. Pins map to actual upstream
commits and do not hide functional or permission changes.

**Verification:** Existing actionlint recipe is in `.github/workflows/ci.yml`; execute its
declared version/arguments when running the workflow check. Required new deliverable:
workflow-pin scanner plus mutable/unknown/nested-action fixtures and per-pin provenance table.

**Rollback:** Revert one pin only after an evidenced upstream breakage; preserve the pin policy.

<a id="j3"></a>

### J3 · Coverage instrumentation and critical-module thresholds

**Outcome:** V8 coverage measures named critical modules and a deliberately uncovered branch
makes the coverage gate fail.

**Depends on:** None. Threshold design and instrumentation can proceed beside implementation;
shared workflow/test-config ownership is claimed separately from J2/J4/J12.

**Start here:** [core Vitest config](../packages/core/vitest.config.ts),
[server Vitest config](../packages/server/vitest.config.ts),
[web Vitest config](../packages/web/vitest.config.ts),
[CI shards](../.github/workflows/ci.yml), [root scripts](../package.json).

1. <a id="j3.1"></a>**J3.1 — Freeze the threshold matrix:** Deliver named critical modules, statement/branch/
   function/line numerical thresholds, baseline coverage, generated/platform exclusions, and
   exclusion reasons. Historical requirements specify stable gates but no exact percentages.
2. <a id="j3.2"></a>**J3.2 — Instrument V8:** Add compatible coverage dependency/config and shard report outputs;
   output accounts for source maps and avoids double-counting generated files or retry attempts.
3. <a id="j3.3"></a>**J3.3 — Gate critical modules:** Wire fixed per-module thresholds and coverage artifacts
   through existing CI shards/aggregate; failure names module, metric, actual, and target.
4. <a id="j3.4"></a>**J3.4 — Prove a real failure:** Deliver a deliberate uncovered-branch fixture that fails
   the selected gate, then a restored passing report; record excluded platform branches explicitly.

**Acceptance:** Threshold numbers are frozen before the candidate and all named critical
modules report them. Named negatives: uncovered critical branch, missing report, bad source
map, unsupported exclusion, and shard omission cannot produce a false green. An exception
is scoped to one module with owner and reason, not blanket disabling.

**Verification:** Existing suite entry points are each package's `test` and Vitest config;
after J3.2, required command deliverable is the exact `vitest run --coverage` package/shard
invocation plus its failing/passing fixture receipts. No present coverage command or percentage
is asserted here as already configured.

**Rollback:** Narrow an evidenced failing module threshold with owner/decision; preserve
instrumentation and reports for other critical modules.

<a id="j4"></a>

### J4 · Scheduled retry-zero flake lane

**Outcome:** A separate scheduled lane records first-attempt failures, reproducible seeds,
artifacts, and a flake owner without retry masking.

**Depends on:** None. Existing platform retry behavior is the baseline; scheduling is a
separate operational slice with shared workflow ownership.

**Start here:** [core retries](../packages/core/vitest.config.ts),
[server retries](../packages/server/vitest.config.ts),
[CI shell retry](../.github/workflows/ci.yml),
[browser config](../packages/web/e2e/playwright.config.mjs).

1. <a id="j4.1"></a>**J4.1 — Define lane ownership:** Deliver schedule, suite/platform scope, seed/repetition
   policy, artifact retention, alert/flake owner, and relationship to the required aggregate gate.
2. <a id="j4.2"></a>**J4.2 — Force retry zero:** Add lane-only config/invocations that disable Vitest/Playwright
   retries and any whole-command shell retry; output proves effective retry:0 on every selected suite.
3. <a id="j4.3"></a>**J4.3 — Capture failures:** Record first attempt, seed, environment, logs, trace/screenshot
   where applicable, and owner without re-labeling a flaky run as passing.
4. <a id="j4.4"></a>**J4.4 — Demonstrate detection:** Deliver an injected intermittent fixture with deterministic
   reproduction that the lane catches; restore fixture and retain the discovery receipt.

**Acceptance:** Scheduled run configuration exists and effective retry is 0. Named negatives:
inherited platform retries, shell rerun, missing seed, missing artifact, and ownerless failure
cannot mask detection; required main CI remains independently authoritative.

**Verification:** Required new deliverables: retry-zero effective-config fixture, deterministic
flake reproduction, parsed scheduled workflow, and its exact suite commands/artifact receipt.
Existing configs currently set Windows retry 2/macOS retry 1 for core/server, so changing only
one config value cannot establish this lane.

**Rollback:** Disable the scheduled lane independently; preserve the main test matrix.

<a id="j5"></a>

### J5 · Packaged Electron essential-flow smoke

**Outcome:** Playwright `_electron` launches the packaged app and proves an essential real user
flow on supported operating systems, with useful failure logs.

**Depends on:** Current desktop packaging/preflight contract; no other wave gate blocks smoke
design. Browser tool availability does not justify substituting a web-only fixture.

**Start here:** [desktop main](../packages/desktop/src/main.ts),
[preflight](../packages/desktop/scripts/preflight.mjs),
[desktop manifest](../packages/desktop/package.json),
[launcher tests](../packages/desktop/test/launcher.test.ts),
[desktop CI](../.github/workflows/desktop-build.yml).

1. <a id="j5.1"></a>**J5.1 — Freeze the essential journey:** Deliver packaged executable locator per OS,
   isolated temporary data, startup/readiness expectation, and one named user flow/assertions.
2. <a id="j5.2"></a>**J5.2 — Launch the real app:** Add `_electron` harness against packaged output, capturing
   main/renderer/server logs and process handles; use the app's actual entry point.
3. <a id="j5.3"></a>**J5.3 — Exercise/clean up:** Complete the named flow, capture visible outcome, close all
   app/helper processes, and preserve failure artifacts within bounded retention.
4. <a id="j5.4"></a>**J5.4 — Integrate OS matrix:** Deliver missing-binary/startup-crash/renderer-error fixtures
   and Linux/macOS/Windows receipts for supported packaging variants.

**Acceptance:** A real packaged `_electron` flow is observed, not inferred from launch tests.
Named negatives: missing binary, startup crash, renderer error, readiness timeout, and leaked
child fail visibly with logs; clean shutdown is recorded on each supported OS.

**Verification:** Existing baseline:
`rtk proxy pnpm --dir packages/desktop exec vitest run test/launcher.test.ts test/web-dist.test.ts test/server-process-stop.test.ts`.
Required new deliverable: packaged Electron smoke spec/runner, exact packaging/launch commands,
and supported-OS matrix; no nonexistent smoke script is presented as existing.

**Rollback:** Retain package/startup smoke while isolating an evidenced flaky UI step.

<a id="j7"></a>

### J7 · Three independently defined Docker image variants

**Outcome:** Three named image variants build from pinned bases and satisfy their stated
health, architecture, secret, and non-root contracts.

**Depends on:** Existing server/image packaging and E8 health semantics. Local recipe/fixture
work is ready; publishing images requires the user's scoped authorization.

**Start here:** [current Dockerfile](../Dockerfile),
[Docker workflow](../.github/workflows/docker.yml),
[Docker quickstart](../packages/docs/content/quickstart-docker.en.md),
[server config tests](../packages/server/test/config.test.ts).

1. <a id="j7.1"></a>**J7.1 — Define exactly three variants:** Deliver names, purpose, runtime contents, entrypoint,
   users/volumes, architecture matrix, secret needs, health/smoke assertions, and support owner.
   The current Dockerfile's three build stages are not evidence of three product variants;
   archived requirements do not provide the variant names.
2. <a id="j7.2"></a>**J7.2 — Implement reproducible recipes:** Create each variant as a reviewable recipe/target
   with verified base digests, compatible Node/native dependency architecture, and deterministic
   workspace/deploy inputs; output is three locally buildable recipes.
3. <a id="j7.3"></a>**J7.3 — Exercise runtime contracts:** Build/run all three variants and test readiness,
   writable-volume/non-root permissions, missing secret, and wrong architecture; cleanup containers.
4. <a id="j7.4"></a>**J7.4 — Record release artifacts:** Deliver per-variant digest, SBOM, compressed/uncompressed
   size, architecture/health receipt, rollback mapping, and authorized publication draft.

**Acceptance:** All three build and satisfy their frozen contracts; bases are pinned. Named
negatives: missing secret, wrong architecture, native binary mismatch, non-root unwritable volume,
and unhealthy server fail visibly. A failed tag/digest is not represented as shipped.

**Verification:** Current local baseline recipe:
`rtk proxy docker build -t penguin-harness:dev .`.
Required new deliverable: three-variant exact build/run command matrix and health/SBOM/size
receipts; running only the current default recipe is insufficient.

**Rollback:** Use the previously approved digest per variant; never reuse a failed published tag.

<a id="j8"></a>

### J8 · Four-rule tracked contributor agent constitution

**Outcome:** Four enforceable repository rules are available in tracked contributor guidance
and do not depend on this machine's ignored root AGENTS.md.

**Depends on:** None. Local/user-owned AGENTS.md and private configuration are preserved.

**Start here:** [tracked contributor guide](../.github/CONTRIBUTING.md),
[porting/refusals policy](../docs/policies/porting-and-refusals.md),
[implementation guide](implementation-guide.md),
[docs content tests](../packages/docs/test/content.test.ts),
[ignore rules](../.gitignore).

1. <a id="j8.1"></a>**J8.1 — Select the four enforceable rules:** Deliver exactly four rule statements mapped
   to canonical repository policy/current user instructions, with trigger, required behavior,
   and completion evidence. Historical prose gives the count but not their original wording;
   record the selected wording as a current decision, not a recovered quote.
2. <a id="j8.2"></a>**J8.2 — Publish a tracked draft:** Put the constitution in tracked contributor guidance
   with a stable pointer and minimal duplication; preserve ignored local AGENTS.md/private state.
3. <a id="j8.3"></a>**J8.3 — Ground commands/links:** Validate every referenced path and command against the
   manifests, boundary policies, and guide; output keeps external-action authorization explicit.
4. <a id="j8.4"></a>**J8.4 — Review enforceability:** Deliver four scenario examples where each rule changes
   an agent action, plus a clean-checkout readability/link receipt.

**Acceptance:** Exactly four explicit rules, source mappings, triggers, and evidence exist in
tracked guidance. Named negatives: ignored-only guidance, broken link, nonexistent command,
contradictory rule, and private-state dependency fail review. A missing historical source is
not silently filled by invented quotation.

**Verification:** Existing docs baseline:
`rtk proxy pnpm --dir packages/docs exec vitest run test/content.test.ts`.
Required new deliverable: tracked-guidance link/command and four-rule scenario receipt.

**Rollback:** Revert only the new tracked guidance/pointer; preserve local handbook and user files.

<a id="j9"></a>

### J9 · Postmortem template and release checklists

**Outcome:** Incidents and release follow-ups record evidence, causes, owners, and completion
checks in a reusable tracked template.

**Depends on:** None. Use the current incident as a draft example without altering historical
receipts or claiming its repair complete.

**Start here:** [release incident/orders](work-orders.md),
[CI receipt](../docs/audits/pr-12-ci-2026-09-30.md),
[contributor guide](../.github/CONTRIBUTING.md),
[docs tests](../packages/docs/test/content.test.ts).

1. <a id="j9.1"></a>**J9.1 — Define evidence fields:** Deliver timeline/timezone, affected version/scope,
   impact, detection, causes/contributing factors, response, and linked raw proof fields.
2. <a id="j9.2"></a>**J9.2 — Add actionable checklists:** Define incident/release checks with named owner,
   due/reopen condition, exact-candidate CI reference, rollback, and acceptance evidence.
3. <a id="j9.3"></a>**J9.3 — Fill an example:** Produce an evidence-backed current-incident or copied historical
   example distinguishing observed facts, hypotheses, and pending repairs.
4. <a id="j9.4"></a>**J9.4 — Review/validate:** Deliver link/field completeness and checklist review; every
   follow-up points to a concrete task/work order and a checkable completion condition.

**Acceptance:** Template includes timeline, impact, detection, causes, and follow-up owner.
Named negatives: blame-only cause, ownerless action, missing affected SHA, broken proof link,
and inferred green CI are detected in the filled example.

**Verification:** `rtk proxy pnpm --dir packages/docs exec vitest run test/content.test.ts`.
Required new deliverable: postmortem template, release/incident checklists, filled example,
and field/link review receipt.

**Rollback:** Keep the template as an independent docs-only change; remove a defective pointer.

<a id="j12"></a>

### J12 · PR annotations for coverage, stale claims, and findings

**Outcome:** Reviewers receive bounded actionable annotations for J3/J11 results and eligible
findings on touched lines, with plain artifacts retained when delivery is unavailable.

**Depends on:** J3/J11/R1b; scoped findings require R0/R2a/R8 provenance and relevant file/revision
mapping. Converter/fork/path fixtures and local draft are ready before remote delivery. Posting
annotations or changing third-party resources requires explicit scoped authorization.

**Start here:** [CI](../.github/workflows/ci.yml),
[docs-claim checker](../scripts/check-doc-claims.mjs),
[checker fixtures](../scripts/check-doc-claims.test.mjs),
[finding readback](../packages/core/src/knowledge/findings-graph.ts),
[diff citation helpers](../packages/core/src/codegraph/diff-graph.ts).

1. <a id="j12.1"></a>**J12.1 — Define annotation DTO:** Deliver coverage delta/threshold, stale-doc claim, and
   confirmed evidence-gated/non-stale finding shapes with repo-relative path, current changed
   line, severity, source revision, provenance, and byte/count limits.
2. <a id="j12.2"></a>**J12.2 — Convert safely:** Read actual J3/J11 outputs and authorized mapped findings;
   validate diff line/path and sanitize multiline/control text before emitting local annotations.
3. <a id="j12.3"></a>**J12.3 — Deliver with scoped permissions:** Integrate annotation/artifact output into CI;
   fork/no-token/no-write-permission cases keep useful plain artifacts and truthful gate outcome.
   External posting is enabled only in an authorized trusted context.
4. <a id="j12.4"></a>**J12.4 — Prove adverse paths:** Deliver untrusted path/text, outside-diff line, cross-scope
   finding, stale/unverified claim, fork permission, missing token, and delivery-failure fixtures.

**Acceptance:** Coverage/stale-doc/finding annotations point to actual touched lines and explain
the result; gate state remains truthful independently of annotation delivery. Named negatives:
path traversal, control-character injection, fork code/token misuse, unavailable token, unrelated
scope, stale/open/refuted claim, and failed delivery cannot write outside the PR or claim a pass.
Current findings labels derive from trusted lifecycle/evidence, not caller-provided `verified` text.

**Verification:** Existing checker baseline:
`rtk proxy node --test scripts/check-doc-claims.test.mjs`.
Required new deliverable: annotation converter/path/fork-permission fixture suite and exact CI
command/artifact mapping; record authorized candidate-head annotation proof separately.

**Rollback:** Disable delivery and retain plain CI artifacts/gates without false annotation success.

## Contract choices that require a concrete receipt

The promotion dependencies above reconcile the compact index with the wider contract: C11
may use C5/C6 revisions or the bounded D7 adapter; D11 may use fresh regex impact with R6/D9;
G8 ships the G1/G3 doctor slice before optional G2/G6 result integration. Each adapter has its
own fixture proof and leaves the original producer requirement intact.

The archive does not supply D10's five scenario names, C4's three weight-channel names/bonus
arithmetic, I6's exact compact byte cap, J3's threshold percentages, J7's three variant names,
or J8's four rule wording. Their first packages deliver frozen decision/fixture contracts
before dependent implementation. Preserve the supplied counts, weights, bonuses, and gates;
record a new scoped choice rather than presenting a guessed historical contract as fact.

Wave 3 acceptance requires D10's raw two-tier decision and D4b's per-step fixtures, C1's scoped
session → findings → query → UI demonstration, accessibility receipts for shipped surfaces,
and required Linux/macOS/Windows CI on the candidate head. A failed AST gate leaves regex
default. A denied conditional visual-token migration does not block F8's component fixes.
