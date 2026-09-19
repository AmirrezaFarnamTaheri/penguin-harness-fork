---
name: port-architecture
description: Decide which subsystems of a whole repository port to which target language and where the interop seams go — decision criteria, a per-language fit table, an FFI-versus-IPC-versus-WASM boundary guide, and the seam map plus stub-first integration order that lets ported pieces replace TypeScript incrementally behind stable interfaces.
---

# Port Architecture

Decide, for a whole repository, **which piece becomes which language, and where the seam between them runs**. This is the decision that determines whether the port is six weeks of incremental, verifiable progress or a year-long rewrite that nobody can safely ship. `code-port` moves a module across; `port-verify` proves it landed. This skill decides the board they play on.

The governing insight: a port that replaces a subsystem *in place, behind the existing interface* is reviewable, testable and reversible at every step. A port that requires the whole system to be rebuilt in the new language before any of it runs is a gamble — and the gamble is usually lost to integration work nobody estimated.

## Before you start

- If the message only names this skill without a repository to plan, ask for the repo and the porting goal (performance, safety, platform reach, team change) before designing anything. The goal determines the criteria weights; without it you are ranking languages by taste.
- Read the repository, not a summary of it: entry points, the call graph's hot paths, the test layout, the build, the deploy target, the CI. Architecture decided from a README is an architecture decided from marketing.
- Inventory the hard constraints first — these narrow the solution space before any ranking happens: a platform the product must run on, a library with no substitute, a team's existing competence, a deployment constraint (single binary, browser, mobile store, embedded target).
- Talk to whoever runs it in production about where the latency, the crashes and the operational pain actually are. Their answers reorder the criteria more reliably than profiling does.

## When to use

- A whole repo (or a large subsystem) is moving from TypeScript to one or more other languages.
- The question is "what do we port to what", or "how do the pieces talk to each other during the port".
- Do **not** use for a single module — that is `code-port`. Do not use it to pick a language for greenfield work either: this is a *porting* architecture, defined by the existing system it must stay compatible with.

## The output: the seam map

Everything in this skill exists to produce one artifact — the **seam map**. Write it as a markdown table in the repo (`PORT-ARCHITECTURE.md`), one row per boundary between languages:

| Boundary | Mechanism | Data format | Owner | Replaces |
| --- | --- | --- | --- | --- |
| kernel → sandbox-runner | FFI (C ABI) | MsgPack over a shared buffer | kernel team | `sandboxRunner.ts` |
| web UI → kernel | gRPC / protobuf | `.proto`, codegen both sides | platform team | REST handlers |
| parser → kernel | in-process call (same language) | native types | parser team | n/a (stays) |
| CLI → core | stdio JSON lines | JSON Lines over stdin/stdout | CLI team | `cli-commands.ts` |

Then, below the table, the **stub-first integration order** (see the end of this skill): the sequence in which ported subsystems replace TypeScript, each behind an interface that already exists.

A seam map with an empty "Replaces" column is a new system, not a port.

## Decision criteria, and how to weigh them

Score each candidate subsystem per language on these. Weights come from the porting goal — a performance port weights 1 and 6 heavily; a safety port weights 2 and 4; a platform-reach port weights 5 and 7.

1. **Performance curve.** Where is the actual time spent — a hot loop, allocation churn, startup, or wall-clock I/O? Profile, do not assume. Port the hot loop to the language whose generated code is fastest *for that shape*; port the I/O-bound glue to whichever language has the best async ergonomics and the cheapest maintenance.
2. **Memory and type safety.** Does this subsystem process untrusted input, parse untrusted file formats, run third-party code, or touch raw memory? Safety-critical surfaces earn a memory-safe language regardless of performance — a Rust or C# port of a parser is a security fix, not a perf project. Conversely, do not pay the safety tax on code that only reads trusted config.
3. **Concurrency model.** Fan-out I/O, pipeline parallelism, CPU-bound parallelism, or fine-grained shared state? Different languages win at different shapes: goroutines and channels for fan-out; `tokio` for cooperative pipelines; data-parallel arrays for CPU work. Match the language's strongest concurrency shape to the subsystem's actual workload shape.
4. **FFI and native needs.** Does it have to call into a C library, a syscall, a PTY, a device, or an existing native module? A subsystem that is 40% FFI glue is often better written in the language whose FFI story is native rather than a bridge — and a language with a poor FFI story is disqualified outright, however nice the rest of it is.
5. **Ecosystem fit.** Are there mature libraries for *this* subsystem's actual needs — tree-sitter bindings, a PTY library, a protobuf stack, a UI framework, the specific file formats it must read? Absence of one critical library is disqualifying; abundance of them is worth more than a point of language elegance.
6. **Team competence and hiring.** Who maintains this for the next three years? A language nobody on the team can review is a port that rots on arrival. Existing competence is a hard constraint, not a soft preference — but it is *a* constraint, so name it rather than quietly working around it.
7. **Deploy target.** Browser, mobile store, single static binary, container, embedded image, or a locked-down corporate desktop? The deploy target eliminates candidates outright (no JVM where a single binary is required; no Rust in the browser without a WASM path) and it constrains binary size and startup budget.
8. **Migration cost and reversibility.** How much of the surrounding system must change for this subsystem to move? Prefer subsystems with a narrow, already-existing interface — they are cheap to port, cheap to verify, and cheap to abandon if the port fails. Subsystems that require touching twenty callers are last, not first.

## Per-language fit table

| Language | Fits | Does not fit |
| --- | --- | --- |
| Rust | hot loops; sandboxes and untrusted-code execution; parsers and tree-sitter work; terminal/PTY handling; file formats; anything where a segfault is a security finding; WASM targets | glue code that changes weekly; small scripts; teams with no reviewer; systems needing fast initial delivery over correctness |
| Go | network gateways and proxies; CLIs and single-binary ops tools; concurrency fan-out (many workers, channels); services whose operational story matters more than their peak throughput | compute-bound numeric kernels; memory-safety audits of untrusted formats; code that needs fine-grained generics or inheritance-heavy modeling |
| C# / .NET | enterprise and desktop cross-platform apps; strongly typed services; anything already in the .NET orbit; tooling-rich teams; gRPC services | minimal single-binary deployments (trimming helps, still not Go-sized); browser code; embedded targets |
| C++ / Zig / C | PTY and terminal internals; microVMs; syscall filters and seccomp; low-level device and OS work; existing native libraries; performance kernels with an established C++ toolchain | anything that processes untrusted input without a hardened audit (unless Zig/C++ with strict boundaries); services where time-to-correctness matters |
| Python | data science and ML pipelines; RAG and eval glue; scripting over the source repo; build/tooling automation; prototyping a numeric algorithm before porting it to a faster language | hot loops; long-running services with tight memory budgets; anything where startup latency matters; code that must be memory-safe against untrusted input |
| TypeScript / React | web UI; UI state management; anything that ships to a browser; serverless functions; code whose whole value is shared types with the frontend | compute-heavy kernels; sandboxes; low-latency paths; systems where runtime type errors are unacceptable |
| Swift | native macOS/iOS UI and system integration; native desktop apps on Apple platforms; anything needing Metal/CloudKit/AppKit | server-side cross-platform work; anything that must also run on Linux/Windows with equal fidelity |
| Kotlin | native Android UI and system integration; JVM-server work where the team already knows the platform | Apple-platform UI; browser code; minimal single-binary ops tools |
| Java / Scala | large-scale JVM services; big-data pipelines on existing JVM infrastructure | single-binary deployment; browser and mobile UI; memory-constrained targets |

A language not in the table can still be chosen — but the seam map then owes an explicit paragraph on why its ecosystem and team competence clear the bar.

## The interop boundary guide

Once the languages are chosen, every boundary between two languages needs a mechanism. Pick by the shape of the traffic:

**FFI / C ABI** — wins when the two sides are in one process, the call is on a hot path, latency budgets are microseconds, and the data is naturally native (buffers, handles, structs). Costs: a segfault on either side takes the whole process; lifetime and ownership across the boundary are the bug class; error propagation is manual; cross-language test coverage is hard.
*Typical use:* core engine called by a UI shell; a native plugin host; a sandbox runner.

**gRPC / protobuf (or another typed RPC)** — wins when the sides are separate processes or separate deploy units, the schema is a contract many consumers share, and you want versioning and codegen on every side. Costs: process startup and IPC round-trips (milliseconds, not microseconds); schema churn becomes a release coordination problem; a schema that cannot express your data shape forces awkward workarounds.
*Typical use:* kernel service ↔ UI; a service split across teams; anything that must be independently deployed.

**WASM** — wins when the ported code must run sandboxed in a browser, in an edge worker, or inside a host that only speaks WASM; when you want one artifact to run everywhere; or when the language compiles to WASM and the host needs a hard capability boundary. Costs: no direct filesystem or syscall access without explicit host imports; slower than FFI, and the boundary is a copy boundary; debugging is poor.
*Typical use:* a parser or kernel ported to run inside a web UI; a sandboxed evaluator; edge-deployed logic.

**stdio JSON (or JSON Lines over a pipe)** — wins when the subsystem is a CLI by nature, when the protocol is trivially serializable, when you want to keep the sides fully decoupled and debuggable by hand, and when performance does not matter. Costs: the slowest mechanism here; JSON serialization is the bottleneck for any non-trivial payload; error semantics are ad hoc (exit codes and stderr text become the error channel).
*Typical use:* tooling wrappers; a ported CLI invoked by the shell; glue between a Python eval harness and a native binary.

**Shared database or queue** — wins when the sides already share the store, when the boundary is naturally asynchronous, and when decoupling lifetimes is the point. Costs: the schema is now the API, and migrating it is a whole project; transactions across the boundary are not possible.

Choose by the traffic shape, then write the choice into the seam map with its data format and its owner. A boundary whose mechanism is "we'll decide later" is a boundary that will be re-written twice.

## Where to draw the seams

- **Prefer existing interfaces.** The cheapest seam is an interface the code already has — a module's exported API, a CLI's argument contract, an HTTP route set, a file format. Port behind it and nothing else has to change.
- **Draw seams on narrow, stable data, not on rich object graphs.** A boundary that passes a few plain records is a boundary that survives; one that passes live callbacks, shared mutable state, or a deep object hierarchy will leak both languages' internals into each other until the seam is gone.
- **Version every schema that crosses a language line.** A versioned schema with codegen on both sides turns "the port changed a field" into a compile error instead of a runtime mismatch.
- **Keep error semantics explicit at the boundary.** Exceptions do not cross FFI or IPC; decide per boundary whether errors become result codes, error values in the payload, or non-zero exits, and write the decision down. Most cross-language incidents are error-semantics ambiguity.
- **Put the seam where tests can sit on it.** A boundary with a differential test harness on both sides is a verifiable port; a boundary nobody can exercise independently is an article of faith.
- **One language per process per boundary.** Do not fan out into three languages in one process unless the FFI story is genuinely simple — the combinatorics of debugging across two boundaries at once are brutal.

## A worked seam map, on this product

For concreteness — porting PenguinHarness itself out of TypeScript, where the goal is a safer and faster core without abandoning the TypeScript/React UI or the Python eval glue:

| Boundary | Mechanism | Data format | Owner | Replaces |
| --- | --- | --- | --- | --- |
| kernel → sandbox runner | FFI (C ABI) | MsgPack over a shared buffer | kernel | `sandboxRunner.ts` |
| kernel → session store | in-process (same language) | native types | kernel | n/a (stays TS) |
| parser / tree-sitter → kernel | in-process (Rust) | native types | parser | `parser/index.ts` |
| browser UI → kernel | gRPC / protobuf | `.proto`, codegen both sides | platform | REST + IPC bridge |
| CLI → kernel | stdio JSON Lines | JSON Lines over stdin/stdout | CLI | `cli-commands.ts` |
| eval / benchmark harness → kernel | stdio JSON Lines | JSON Lines | eval | `eval-runner.ts` |

Reasoning the table encodes: the sandbox runner becomes Rust because it executes untrusted code and a memory-safety finding there is a security issue, and FFI because it is on the hot path in-process. The browser UI stays TypeScript/React — porting a UI to gain nothing is not a port, it is a rewrite. The eval harness stays Python, because the RAG and eval ecosystem is there and it is glue, not a hot path. The CLI stays a thin wrapper over stdio JSON Lines, which means the CLI can be ported last and independently, and the gRPC seam between UI and kernel is where the schema gets versioned.

Integration order, read off the table: parser first (leaf dependency, pure, exhaustively testable), then the sandbox runner behind an FFI stub with a shadow flag, then the kernel internals it calls, then the gRPC seam with the UI switched behind it, and the CLI last. Each step ends with a deletion and a green differential run.

## Signs the seam map is wrong

Catch these while the plan is still cheap to change:

- **A boundary's "Replaces" column is empty for every row.** You have designed a parallel system, not a port. Go back and name the TypeScript each row retires.
- **A seam passes a rich object graph or a live callback.** That boundary will leak both languages into each other within a month. Redraw it on plain records, or move it to a process boundary where serialization enforces the discipline.
- **The first integration step requires three subsystems to be ported before anything runs.** The order is wrong — reorder so the first step is one leaf module behind an existing interface, end to end.
- **The map has a language that appears in exactly one row.** Either that subsystem has a genuinely unique requirement worth a paragraph, or you chose a language you will regret maintaining. Say which one it is.
- **Every row is a different mechanism.** Each mechanism is a schema, a codegen pipeline, an error-semantics decision and a debugging mode the team has to learn. Three mechanisms across eight boundaries is a tax; consolidate where the traffic shape allows.
- **No row has a test harness on it.** Boundaries without a differential harness on both sides are articles of faith — assign the harness before the port starts, not after.

A seam map is wrong most often not in *which language* but in *where the seam runs*. Languages are reversible; a seam drawn through the wrong module means the whole interface is rewritten, twice.

## Stub-first integration order

The seam map's order is the difference between a port that ships and one that stalls. Order the replacements so that each step is independently verifiable and independently reversible:

1. **Define the interface.** Write the target-language interface (types, errors, versioning) *before* porting anything — from the existing TypeScript module's public surface, not from aspirations.
2. **Stand up a stub.** Ship the new interface with a pass-through implementation that delegates to the existing TypeScript module, and wire every caller to it. Nothing changes behavior; everything now goes through a seam you control.
3. **Port one subsystem behind the stub.** Replace the stub's delegate with the ported implementation for that subsystem only, gated by a flag. Run both paths in production shadow if possible — same inputs, compared outputs. This is where `port-verify`'s differential harness earns its keep.
4. **Promote, then delete the TypeScript.** Promotion is a *deletion event*: the old module is removed and the stub is gone. A port that leaves the original in place "just in case" is not finished — two implementations of one behavior will drift, and nobody will know which one is right.
5. **Then, and only then, the next subsystem.** One port in flight at a time per seam. Parallel ports across coupled subsystems produce an unreviewable integration.

## Milestones, and the order they enforce

The seam map is a plan, and a plan nobody can see progressing gets abandoned. Structure the milestones so each one is a *deliverable a user can observe*, not an internal completion:

1. **The seam exists and is inert.** Every caller routes through the stub, which delegates to TypeScript. Behavior unchanged; the whole system is still the original. This is the checkpoint where you find out the seam is in the wrong place — cheaply.
2. **One subsystem ported and shadow-verified.** The first end-to-end differential run, on real fixtures, against the pinned original. This milestone proves the *method* works, not just the code.
3. **The hot or risky path ported.** The subsystem that motivated the port — performance-critical, security-critical, or both — is promoted and the TypeScript deleted. This is where the port pays for itself, and it should happen well before the port is "finished".
4. **All P1-parity subsystems ported.** Everything with user-visible behavior is on the target language; remaining TypeScript is glue, UI, or tooling that was deliberately kept (and named in the map as kept).
5. **Cleanup.** Dead interfaces removed, the last of the glue deleted, docs updated. A port that never reaches cleanup carries a second implementation forever.

Report against these milestones, not against "percent ported". Percent ported measures lines moved; milestones measure risk retired.

## Handoff

- Deliver `PORT-ARCHITECTURE.md`: the criteria and their weights (with the profiling or production evidence behind the top three decisions), the per-language fit reasoning, the seam map table, and the stub-first integration order with each step's verification plan.
- Name the decisions you are least sure of, with what would change your mind — the goal that reweights the criteria, the library that would unlock a language, the hire that changes the team constraint.
- State the boundaries you deliberately left in TypeScript, and why. A porting architecture that moves everything is usually one that has not been scrutinized.
- Hand the first seam to `code-port` and the harness to `port-verify`; the seam map is a plan until a module crosses it and the ledger proves it landed.
