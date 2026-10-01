# Execution Cards — Vol. 2: Waves 2–4

Companion to [plan.md](plan.md) and [todo.md](todo.md). These are implementation contracts,
not an instruction to ship every idea. Before starting any row, name the user journey, current
failure/baseline, owner, exact package command, and rollback. If a candidate has no observable
benefit or lacks a safe ownership boundary, mark it `deferred` with evidence.

## Wave 2 — core hardening

### LLM resilience and context economy

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| A1 | Shadow classifier replaces the active branch only after a full-release disagreement census; keep a typed decision trace and a divergence allowlist with owner. | Feed the captured `agrees=false` corpus plus 400/401/403/429 and malformed bodies; prove one classifier decides and a non-rate-limit error is not relabelled 429. | Flag back to old classifier; retain trace to compare. |
| A4 | Retry policy consumes A3's parsed delay and a per-account grace receipt; one retry budget owns all attempts. | Table every pool size 0/1/2/3+, 429/non-429, short/long delay, retry exhaustion and cancellation; fake timers prove no 50 ms exhaustion loop or retry past budget. | Select previous policy by version; no persisted state migration. |
| A5 | A stream reassembler emits monotonic user-visible deltas from snapshot rewrites, with explicit reset when a rewrite cannot be represented as append-only. | 500 seeded edit sequences, astral text, partial quotes/details, prefix deletion, reasoning/content crossing; final view equals target and bytes remain valid UTF-8. | Keep old adapter behind a flag until real-stream corpus matches. |
| A6 | Frame parser has a single bounded buffer and explicit end-of-stream/error states. | Cross-chunk length, astral payload, bogus marker, over-limit frame, EOF halfway through length/payload, recovery after malformed frame. | Fall back to the existing parser only for its proven framing mode. |
| B1 | Tool text over its configured inline budget spills to a protected, Session-owned archive and returns an opaque recall id; failures stay uncompressed and useful inline. | Explicit 40 KiB boundary, non-zero exit with long stderr, UTF-8 text containing NUL/control characters and split multibyte sequences, archive failure, expired id, wrong Session id; paged recall reproduces persisted text after credential redaction. Arbitrary binary files are outside the tool-text contract. | Disable new spill writes; previously issued ids remain readable until expiry. |
| B3 | Each compressor is independent and opt-in by output class; keep command, exit code, tail of failure and recall link. | Frozen test-runner/build/log corpus; exact failure evidence preserved, ordering stable, savings ≥10% on eligible cases, no false success. Drop any strategy failing the gate. | Select raw output per class; old recall ids still work. |
| B4 | Compaction builds a candidate context copy, validates invariants, then swaps once; pruning records a frontier and kept ids. | Inject failure at summarize/write/swap; original bytes and ids unchanged; repeated pruning never rereads an oversized skipped block; cancellation leaves valid state. | Feature flag to previous compactor; retain the pre-swap snapshot. |
| C8 | Offline E2E covers a cached chat, attempted write, and recovery to the local server; pair with F17's honest status banner. | Browser offline with server alive, browser online with server down, reload while offline, restore after queued/failed action; no duplicate send or unhandled rejection. | Banner can be disabled independently of cached-read behavior. |

**A1 release gate:** record the shadow log search window, corpus hash, number of disagreements,
every allowlisted reason, and the commit being promoted. Zero *unexplained* disagreement is
required; an empty log is not evidence unless traffic/fixture coverage is shown. On active
rollout, monitor changed error-classification rates and provider disable/retry outcomes.

**B1/B3 privacy gate:** archive ownership and retention must be explicit. A recall id is an
opaque capability only after the server checks the same session/project authorization as the
original output. Redact secrets before display, and do not put filesystem paths in model-visible
metadata or query strings. The failure-preservation test is a release gate for compression.

### Server and protocol boundaries

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| E1 | Remove or document the last guardian-less coordinator constructor and cwd fallback; dependency injection owns project root. | New runtime without guardian or project root fails at construction; reap/recreate uses the same key. | Restore old constructor only with a test-only explicit option. |
| E2 | Adjudicate eight ACP claims one by one; fix only reproduced defects while preserving existing correct behavior. | For each: original reproducer, pre-fix failure, post-fix pass, outcome `confirmed/refuted`, and cancellation/dispose case; no blanket rewrite of transport. | Revert per defect; keep the table and passing existing ACP suite. |
| E3 | ACP connection resume has generation + monotonic cursor + bounded replay and explicit gap; UI behind-state reflects the real generation. | Disconnect at every handshake/replay boundary; old generation, expired cursor, duplicate frame, and rapid reconnect all converge without silent loss. | Disable resume and force a visibly fresh snapshot. |
| E4 | Durable SSE tail persists replay cursor and emits `caught_up` or explicit gap; resync button requests a fresh snapshot. | Kill socket mid-event and during a server restart; tests prove ordering, replay bound, gap recovery, and no double-apply. | Fall back to full snapshot on every reconnect, with visible status. |
| E5 | Non-simulated `trigger_swarm` either reaches a real handler or returns a documented boundary error. | Request it when handler is absent and when configured; no accepted-but-never-executed task. | Disable the route action until a handler exists. |
| E6 | Cockpit errors share `{error:{code,message}}` without altering successful response bodies. | Invalid id/auth/provider errors have stable codes; old clients still parse success. | Compatibility serializer for one release if clients require it. |
| E7 | Bound gateway identifiers and project paths at the first trusted boundary. | Empty, overlong, encoded traversal, non-normalized separators, and Unicode edge cases fail before spawn; valid project ids continue. | Revert only a newly restrictive limit after a fixture proves legitimate use. |
| E8 | Readiness distinguishes serving, DB closed, and dependency degraded; liveness stays cheap. | DB closure → readiness 503 while liveness responds; no secret/config disclosure in payload. | Keep prior liveness route while removing new readiness wiring. |
| E9 | Structured logger preserves request/session correlation and counts unhandled rejections without double handlers. | Inject rejection and logger failure; one bounded record, no recursive logging, no raw secret. | Route sink back to stderr with same structured schema. |
| E10 | Split into four PRs: orphan child reaping, hung `disposeRemoved`, session-delete abort, archive size cap. | Each gets a real reproducer, bounded wait/cancellation, restart and Windows/POSIX case where relevant; no process or file leak after failure. | Revert one fix independently; avoid one broad lifecycle patch. |

**E3/E4 composition rule:** ACP generation/cursor and cockpit SSE generation/cursor are separate
protocols. Document their mapping at the UI boundary; never reuse one cursor in the other
stream. On a gap, show the user that an authoritative snapshot is loading; do not claim a
numeric “events behind” count unless the server knows it.

### Skills, configuration, security, and operations

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| G1 | Validator checks frontmatter, taxonomy, links, and executable commands against a versioned rule set; grandfathered corpus violations have an allowlist with expiry. | Plant one violation per rule; CI fails only the new offense and prints file/line. | Rule-level opt-out with a dated owner, never disable the whole gate. |
| G3 | Skill lock pins source identity and digest; resolver refuses drift before execution. | Pin→verify→tamper→deny; offline lookup and missing source are explicit. | Prior lock reader remains during format migration. |
| G4 | Every `local.patch` and superseded skill has an owner, base, purpose, and apply decision; delete only proven dead copies. | Referenced patch cannot be removed; deliberate supersession still resolves once. | Git restore of each removed artifact. |
| H3 | Atomic credential writer proves exclusive temp creation, permissions from birth, sync, rename, and cleanup. | Crash/fault after each step; original bytes survive and no permissive temp remains on Windows/POSIX. | Keep old path read-only while writer is changed. |
| I1 | Central redactor applies a small allowlist to session headers and errors before logs/trace/export. | 14-header fixture, email/credential variants, nested error cause; no raw secret in output. | Disable extra logging rather than bypass redaction. |
| I2 | Command policy validates the actual spawn arguments and Windows process flags before launch. | Dangerous path/metacharacters, quoted paths, and Windows path separators; no spawn on reject. | Restore prior policy only for a documented false positive. |
| I3 | Archive extractor refuses symlink entries and escapes after canonical path resolution. | Symlink, traversal, duplicate normalized name and archive bomb fixture; destination unchanged. | Disable affected import path until fixed. |
| I4 | Effective auth mode derives from bind address and configured policy through one pure function. | Loopback/LAN, `Auto`, `Off`, `AllExceptHealth`, proxy and health endpoint matrix. | Keep the old config parser but call the new pure resolver. |
| F17 | Offline status uses browser + server evidence and a retry path (see C8). | No false “offline” when local server is reachable; no promise that sync never occurs. | Hide banner only; preserve cached content. |
| F18 | Recall chip and CLI consume B1's opaque id, not a raw path. | Cross-project, expired, traversal and large-stream cases; keyboard/screen-reader access. | Hide affordance; retain recall endpoint until ids expire. |
| I7 | Write guard measures the target volume and protects only nonessential new writes; resource-pressure tool remains observational. | Threshold/wrong-volume/unavailable-probe/cleanup/user-override matrix; model cannot forge override. | Turn off policy gate without changing the pressure probe. |

Wave 2 checkpoint: a full required CI matrix, a recorded A1 decision trace, the E2 adjudication
table, B3 raw savings artifacts, and one end-to-end failure/recovery demonstration. A local
targeted pass does not close the checkpoint.

## Wave 3 — expansion cards

### Code intelligence: deliver the TS/JS slice before additional languages

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| D1 | Reproducible, lazy TS/JS wasm pack with pinned runtime, source digests, licenses and compressed/uncompressed byte totals. Regex remains the default. | Missing, invalid, or incompatible asset degrades that language only; cold-start and peak-memory probes run on each supported platform. | Disable the AST flag and retain regex indexes. |
| D2 | Versioned TS/JS query packs produce the shared IR with source ranges, FQNs and stable identities. | Six CONTRACT behavior fixtures cover methods, receiver calls, constructors, branches, lambda attribution and computed callees; syntax errors yield partial safe output. | Keep extractor behind the AST flag. |
| D4a | Symbol table indexes FQN, name, package and type hierarchy; imports resolve by language scope. | Same-name symbols in different modules never collapse; aliases, cycles and missing imports remain unresolved rather than inventing an edge. | Fall back to regex for failed files and mark tier. |
| D4b | Deterministic call-resolution ladder and overload scoring with traceable selected step. | One fixture per ladder step, overloaded/ambiguous calls, inheritance loops and false-edge goldens; ambiguity drops the edge. | Turn off AST edge promotion while retaining parsed symbols. |
| D5 | `graph_diff` compares two versioned graphs with removal-first LCS and recursion markers. | Reordered siblings, removed subtree, recursion and same-name symbols produce stable output and no missing deletions. | Disable diff action independently of indexing. |
| D6 | Read two Git object snapshots through oid-deduped `cat-file --batch`, with bounded buffers and no checkout mutation. | Missing oid, binary, oversized object and interrupted process return typed errors; working tree bytes stay unchanged. | Use committed-head-only diff with an honest limitation. |
| D7 | `GraphStore` owns schema version, checksum, value validation and atomic snapshot replacement; handlers do not serialize graphs. | Unsupported version is a rebuildable miss; corrupt body, interrupted write and concurrent reader cannot return a false valid graph; size limits are enforced. | Drop and rebuild only the derived graph cache; never drop source files. |
| D8 | Seeded community detection with deterministic insertion order and god-node policy. | Same seed/input is byte-identical; isolated components and giant hubs do not hide all ordinary clusters. | Hide cluster overlay and preserve graph edges. |
| D9 | Explore-first tool surface, byte/token budget, honest AST/scan tier badge, bounded formatter and empty-result hints. | Truncation is explicit; no graph result implies a caller when only a definition exists; stale tier and missing grammar are visible. | Restore prior read-only tool contract with a versioned adapter. |
| D10 | Frozen five-scenario two-tier benchmark with raw corpus, goldens, environment, repeated samples and §6's declared promotion limits. | Record precision/recall, false edges, p50/p95, peak memory, package delta and cost; a failed metric keeps regex default and cannot be hidden by averaging. | Leave AST opt-in; archive the failed run and decision. |
| D3 | Add Python, Go, Rust and Java as separate optional packs after D10's TS/JS gate. | Each has parser/extractor/resolver goldens and repeats D10 including license, byte and startup checks; a bad language cannot disable another. | Turn off that language's AST flag. |
| D11 | Existing write tools add at most one advisory line from a fresh cached graph when ≥5 dependents are known. | Missing/stale graph, unknown symbol and slow graph read do not block the write or imply precision the tier lacks. | Disable advisory independently of write tools. |

**D10 promotion rule:** freeze corpus and budgets before candidate runs; compare exact same
commits and environment. Require precision no worse, recall loss ≤2 points, and ≥10% fewer
false edges when baseline has any (otherwise ≥5-point recall gain with zero new false edges).
Require ≤5 MiB compressed install delta, p95 index ≤2× regex and ≤2 s on the 200-file fixture,
and incremental peak RSS ≤256 MiB. A result that
fails stays opt-in. D3 repeats this for each language. The benchmark report links raw artifacts
and includes a reviewer decision; a pretty graph is not promotion evidence.

### Findings and memory: authority remains scoped

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| C2 | Frozen recall baseline, named future policy consumer, opt-in flag owner and pinned-item invariant. R7 Option B remains the default. | Restart, repeated decay and rollback toggles never silently delete pinned memory; no consumer means no production policy. | Keep `retention.ts` unconsumed. |
| C3 | Idempotent consolidation runner with persisted checkpoint, 2h pipeline, 5min debounce and 24h sweep. | Duplicate trigger, restart mid-run, threshold boundary and clock skew produce one outcome; retention cannot turn destructive by accident. | Pause runner and resume from checkpoint. |
| C4 | RRF retrieval with fixed documented weights, K=60, agreement bonus and provenance per hit. | Empty store, conflicting ranks, duplicate item and stale candidate fixtures yield deterministic order without laundering claim status. | Route to existing retrieval and mark strategy. |
| C5 | Bitemporal edges preserve commit and valid time plus supersession links. | Backdated corrections, concurrent updates and `asOf` before/after a supersession reconstruct the expected graph; current view never leaks future evidence. | Keep old queries and treat new columns as optional until migration passes. |
| C6 | Supersession marks dependent claims stale using explicit similarity bands and source revision. | Similar title alone does not supersede; cyclic dependencies and low-similarity input cannot cascade forever or delete claims. | Disable automated stale marking and keep event history. |
| C1 | Findings cockpit reads authorized scoped routes and exposes evidence, actor, status and recovery state. | Cross-project access, legacy-unknown provenance, corruption recovery, empty/loading/error states, keyboard/focus and small viewport tested. | Hide new page route; API stays available. |
| C7 | Influence receipt links agent action to report and later evidence query with a trusted actor. | Forged free-form source cannot claim human influence; duplicate receipt and missing target are explicit. | Stop receipt writing; do not alter findings. |
| C9 | Explicit `MEMORY.md` import/export contract with provenance, source revision and stable identity. | Round trip, repeated import, conflict, malformed line and permission denial preserve original bytes and surface conflicts. | Disable sync, keep both originals. |
| C10 | Session-open briefing reads only authorized, confirmed, non-stale findings in the mapped scope; cap 1,200 tokens and quote titles as untrusted data. | Unmapped scope, stale/legacy claim, prompt injection, over-budget and authorization failure yield no briefing; log revision used. | Turn off briefing injection, retain manual query. |
| C11 | Content-revision comparison marks directly evidenced findings stale; file-watch notifications trigger recheck only. | Touch-only change leaves status; content change, rename and missed watcher event converge after restart. | Disable automatic stale event, retain source revision. |
| C12 | Chat composer report action, count badge and drill-through use the same API authority as cockpit. | Unavailable server, unsaved draft, cross-project switch and keyboard-only flow cannot lose text or show another scope's count. | Hide entry points without deleting findings. |
| K18 | Human verification UI records attested actor, evidence/override reason and audit event before briefing eligibility. | Agent spoofing, missing reason, stale claim and revoked access cannot produce an eligible human confirmation. | Disable briefing eligibility while preserving audit events. |

**Findings release rule:** no migration is implicit. R2d remains conditional until an
authenticated workspace-to-project binding is represented in durable product data. C10/C12
must show the active scope; if the identity is unknown, they show no cross-scope result.

### Web, skills, configuration, and delivery

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| F2 | One shared monotonic-aware clock abstraction for relative UI time. | Fake clock, tab sleep and timezone change update labels without duplicate timers. | Restore local timers only if behavior regresses. |
| F4 | Complete nav-collapse state migration with one persistent source of truth. | Old preference, malformed storage, reload and two tabs converge without layout jump. | Reset only the new preference key. |
| F5 | Preserve dock tab component state while switching tabs; deduplicate tab registry. | Rapid switch, reorder and unmount/reopen do not double-register or lose drafts. | Restore prior tab mount path behind flag. |
| F8 | Fix measured contrast failures through scoped tokens/component CSS. | Normal, dark, hover, focus and disabled states meet target ratios on named screens; screenshot diff reviewed. | Revert one component token at a time. |
| F9 | Correct calendar grid semantics and remove nested ticket buttons. | Screen-reader navigation, keyboard activation and mobile hit targets pass; no duplicate click handler. | Restore earlier rendering with fixed semantics. |
| F7a | Extract sidebar step 4 without changing its public state contract. | Snapshot, navigation and persistence tests pass before/after; no duplicate source of truth. | Revert extraction independently. |
| F7b | Split ChatInput by state/behavior seams, preserving one submit/abort path. | IME, draft, attachment, multiline and rapid submit fixtures pass; no stale closure. | Revert one extraction slice. |
| F7c | Split workspace browser with stable selection and pagination contract. | Rename, delete, rapid folder switch and denied path do not select stale rows. | Revert one extraction slice. |
| G2 | Frozen skill-routing probes exercise description scoring on representative prompts. | A routing-breaking description edit fails with expected/actual trace; ties deterministic. | Disable only a noisy fixture with owner and expiry. |
| G6 | Capability manifest declares network/filesystem/environment needs at script boundary. | Undeclared capability denies execution; trusted corpus scripts declare only actual needs. | Disable affected script, not capability checking globally. |
| G8 | Doctor CLI and skills-page badges share validator result codes. | Missing dependency, risky capability and valid skill map to distinct actionable states; badge and exit code agree. | Hide badges; keep validator output. |
| H1 | Foreign-config contract owns backup, atomic write, version gate and ownership proof. | External owner, changed file since preview and failed rename leave original bytes recoverable. | Restore backup and mark managed state false. |
| H2 | YAML edit preserves comments, indentation and sequence style on fixtures. | Duplicate keys and unsupported syntax refuse with a preview, not a destructive rewrite. | Keep foreign config read-only. |
| H4 | Redacted dry-run preview precedes reversible apply through H1/H3. | Secret values never enter preview/log; fault at each write stage preserves original style and permissions. | Restore byte-exact backup. |
| H5 | Tiered CLI help defaults to short list with explicit full mode. | Unknown command and narrow terminal show usable guidance; snapshots cover all modes. | Retain full help as fallback. |
| H6 | Command-hint graph derives related commands from one registry. | Removed command cannot leave dangling hint; cycles and aliases render once. | Omit hints, keep help. |
| H7 | Argument typo suggestion uses bounded Levenshtein distance and the active command's registered vocabulary only; known option arity keeps values from changing the vocabulary owner. | Secret/path values are never echoed; ambiguous or far-away tokens receive no misleading suggestion; option values after `=` are stripped before matching. | Disable suggestions and retain generic parse errors. |
| I6 | Compact audit payloads after I1 redaction, with structure and correlation preserved. | Nested error, large body and secret variants never leak or exceed size cap; no loss of event type. | Disable verbose payload event. |
| J2 | Pin external Actions by immutable commit and keep update procedure. | Workflow scanner rejects mutable tags and unknown actions; permissions remain minimal. | Revert one workflow pin after verified upstream breakage. |
| J3 | Instrument critical modules with stable coverage thresholds and exclusions. | Deliberately uncovered branch makes gate fail; generated files and unreachable platform branches documented. | Narrow threshold per module with owner, not blanket disable. |
| J4 | Scheduled retry-zero lane emits failure artifacts and flake owner. | An injected flaky fixture is detected without masking required CI; one-off red has a reproducible seed. | Disable scheduled lane, keep main tests. |
| J5 | Electron smoke launches packaged app and verifies one essential user flow. | Missing binary, crash and renderer error fail with logs on supported OSes. | Keep package smoke while isolating flaky UI step. |
| J7 | Three image variants build from pinned bases and run health/smoke contracts. | Missing secret, wrong architecture and non-root permissions fail visibly; SBOM/size recorded. | Publish previous digest, never reuse a failed tag. |
| J8 | Tracked contributor agent guidance states four enforceable repo rules. | Guidance does not depend on git-ignored local `AGENTS.md`; links and commands validated. | Revert only the new tracked doc. |
| J9 | Postmortem template names timeline, impact, detection, causes and follow-up owner. | Filled example has evidence and no blame-only or ownerless action items. | Keep template as docs-only change. |
| J12 | PR annotations translate J3/J11 failures and verified findings on changed lines. | Fork permissions, untrusted path text and missing token cannot write outside the PR or falsely claim a pass. | Keep plain CI artifacts if annotations fail. |

Wave 3 checkpoint: D10 raw two-tier evidence, per-step D4b fixtures, a scoped findings
journey, accessibility receipts, and the required CI matrix on the exact head. A failed AST
gate leaves regex as default; a failed visual measurement declines F10b without blocking F8.

## Wave 4 — strategic cards

### Agent, model and control planes

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| A7 | CanonicalUsage preserves input/output/cache/thinking units across provider adapters with one normalized record. | Twelve alias fixtures, missing values, negative/overflow and Anthropic-shaped response heal without double counting. | Keep raw usage alongside derived value. |
| A8 | Token estimator records provider/model calibration and uncertainty. | Empty, multilingual, tool-heavy and cached prompts bounded against actual usage; never present estimate as billable truth. | Show raw provider count only. |
| A9 | Content-addressed session fingerprint uses stable canonical input and version. | Same content across restart matches; reorder, secret omission and collision fixture do not merge unrelated sessions. | Ignore fingerprint and retain original session ids. |
| K1a | Append-only turn ledger stores prompts, tool decisions and normalized deltas with resumable cursor. | Crash between append/ack and duplicate replay yield exactly one logical turn; secrets follow redaction contract. | Disable resume and retain ledger for export. |
| K1b | Switch provider/protocol mid-session through K1a's replay contract. | Tool-call pending, partial stream and unsupported role map to an explicit stop or safe resume, never silent transcript loss. | Pin session to original provider. |
| K2 | Cost ledger explains per-turn usage and `penguin why` cites source counts and assumptions. | Missing provider price or usage produces unknown, not zero; cache accounting avoids double billing. | Hide cost estimate and retain raw usage. |
| K4 | FailureTrace links classifier decisions, bounded stream capture and real provider error to a readable story. | Redaction, rotated accounts, retries and missing body distinguish cause from inference; UI/CLI never expose secrets. | Show original typed error. |
| K5 | Tool-schema normalizer reports unsupported constructs and round-trips sanitized keys. | Nested `$ref`, `anyOf`, cycles, strict-mode incompatibility and duplicate keys cannot silently alter meaning. | Use provider-specific schema path. |
| K14a | Design record places permission vocabulary above the existing approvals plane. | Direct, alias, retry, resume and delegated calls each show one authoritative allow/deny path; absent context denies. | No implementation until trace is complete. |
| K14b | ToolRouter uses K14a adapter without a second policy authority. | Same action through every entry point yields same decision; denial cannot be bypassed by routing or retry. | Disable router and use existing approval path. |
| K6 | Notification digest coalesces interruptions by session and preferences. | Rapid events, recovery, quiet hours and opt-out do not spam or suppress critical state changes. | Disable notifications; health data remains. |
| K7 | Human-in-loop suspension stores durable verdict request and releases worker capacity. | Restart, timeout, denial, duplicate verdict and stale auth cannot resume an unauthorized action. | Pause run for manual restart. |
| K8 | Eval plane stores scorable/not-scorable outcomes, thresholds and deterministic sampling. | Missing goldens never pass by default; scorer failure halts a gated loop with reason. | Disable auto-gate and retain eval reports. |
| K9 | Fleet state machine owns slot/worktree lifecycle with idempotent transitions. | Concurrent assignment, abandoned worker and restart reconcile one owner per worktree; no delete of user state. | Stop scheduling and recover worktrees manually. |
| K10 | Rules, context providers and system-message tools have distinct precedence and provenance. | Contradictory rule, provider failure and untrusted content cannot silently override higher authority. | Disable one provider, keep stable rules. |
| K11a | Contract maps WorkRouter goals, scorer loops and network routing to one transition table. | Cycles, missing owner and unknown verdict produce a safe stop; no implementation before review. | Design-only artifact. |
| K11b | Implement K11a with bounded steps, durable events and human handoff. | Duplicate dispatch, timeout and crash/restart do not execute a side effect twice. | Disable orchestration and use single-agent path. |
| K13 | Graph-of-turns and patch codec preserve edits and attribution across K1b resume. | Binary, conflict, newline, rename and partial patch round-trip; MPL obligations recorded for modified files. | Export linear ledger and ordinary patch. |
| K16a | Map audit checklist and confidence display to existing finding status; candidate uses `kind=hypothesis`. | Legacy snapshot and clients still parse; label is derived, never caller-controlled authority. | Hide labels, keep lifecycle. |
| K16b | New `verify` workflow requires ten-question checklist data and trusted actor/evidence from R1b; legacy `confirm` remains evidence-gated and visibly `checklistVerified: false` until a separate client-migration release. | Missing answer, unsupported claim and agent spoofing cannot produce a verified label; legacy tool/route/UI clients and snapshots keep their existing contract. | Disable new verification action, preserve existing confirmation and open claims. |
| K17 | Benchmark run writes an idempotent open finding linked to raw artifacts; README table derives from ledger. | Repeat run, missing artifact and failed benchmark cannot create a confirmed claim or stale green badge. | Keep static benchmark report until ledger recovers. |
| J13 | Health degradations feed K6 digest with dedupe and recovery event. | Flapping, DB outage and notification failure do not take down health endpoint or spam users. | Disable delivery, retain health checks. |

### Product, visual systems and export

| ID | Smallest deliverable and invariant | Negative case and proof | Rollback |
|---|---|---|---|
| K3 | CLI configurator previews ownership, redacted diff, backup and reversible apply through H1/H4. | External edit after preview, unsupported version and write fault refuse or restore byte-exact data. | Restore backup and disable configurator. |
| K12 | Agent-ops dashboard reads scoped event/health data and names unknown state honestly. | Cross-project auth, lag, empty state, keyboard and mobile views tested; no fabricated live count. | Hide page, keep event API. |
| F10a | Count live hard-coded color sites and compare representative contrast/screenshots with token alternatives. | A proposed overlay that worsens contrast, drift or migration cost is declined with evidence. | Docs-only measurement. |
| F10b.1 | Conditional: define semantic token map with light/dark/interaction states and contrast receipts. | Token alias cycles or failing contrast block adoption. | Keep F8 component fixes. |
| F10b.2 | Conditional: migrate one component family per PR under screenshot and keyboard review. | Unmigrated components retain old styling; no global class replacement or surprise theme drift. | Revert that family. |
| F10b.3 | Conditional: remove obsolete color twins only after usage search and visual pass. | Dynamic class references and third-party themes remain valid. | Restore removed aliases. |
| F11a | Topology signals/store adapter owns stable nodes, edges and derived selection. | Rapid updates and duplicate ids do not create phantom nodes. | Keep current topology view. |
| F11b | Culling/camera slice respects zoom, viewport and reduced motion. | Large graph, resize and keyboard pan stay responsive; offscreen selection can be recovered. | Disable culling or camera slice independently. |
| F11c | Elbow routing calculates deterministic visible edge geometry. | Overlap, loop and disconnected cases remain readable; no pathological layout hang. | Fall back to straight edges. |
| F12a | Workflow visualizer graph model maps K11b states/events to stable typed nodes. | Cycles, missing events and late updates show an explicit incomplete state. | Text timeline remains authoritative. |
| F12b | Renderer provides keyboard navigation, accessible labels and bounded layout. | Large DAG, error and narrow viewport remain usable; no hidden-only status. | Fall back to list/timeline. |
| F13a | Export DTO version captures authorized snapshot, provenance and redaction policy. | Cross-project, stale or partially loaded export refuses or labels missing data. | Keep existing single-view export. |
| F13b | PPTX/PDF/print render the same DTO with readable pagination. | Large text, RTL, charts and font absence have golden or reviewed artifacts. | Disable affected format. |
| F13c | Export queue owns progress, cancellation and bounded artifact retention. | Restart, duplicate request and unauthorized download cannot leak or orphan output. | Synchronous small export only. |
| F14 | Cowork UX shows fleet badge, reconciled run state, warmup and queued commands. | Rapid transition and stale websocket do not claim running/finished falsely; queued commands remain cancellable. | Hide queue controls, retain run detail. |
| F15 | Shared chart scales and palette tokens with accessible table fallback. | Zero, negative, missing values, dark mode and color-blind palette pass named fixtures. | Restore existing chart per component. |

Wave 4 checkpoint: demonstrate K1b provider switch, K14 one-authority enforcement, K16
checklist-gated finding, K17 reproducible ledger, K3 reversible config write, and each shipped
product surface in keyboard and narrow-viewport tests. Conditional tasks may be explicitly
declined with the §11 evidence; they are not silently marked done.
