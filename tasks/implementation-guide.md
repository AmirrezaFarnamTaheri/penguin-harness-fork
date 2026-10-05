# Implementation agent guide

Documentation reconciled on 2026-10-04. Current status and release gates are in
[todo.md](todo.md) and [work-orders.md](work-orders.md); these requirements and historical
observations do not certify the changed working tree.

Use this guide whenever executing a task from [todo.md](todo.md). Read the selected card, its
dependencies, and [contracts.md](contracts.md) sections that apply. Use [tooling-guide.md](tooling-guide.md)
when navigating or editing code. The current human request and applicable repository instructions
take precedence over these documents.

## 1. Establish the work boundary

1. Record the repository root, branch, HEAD, and existing changed/untracked paths. In this checkout,
   prefix shell commands with `rtk`; use `rtk proxy` when the command has no suitable RTK adapter.
2. Read local `AGENTS.md` and any instructions applying to the files being changed. Preserve
   deliberate private state, `.codegraph/`, and the user-owned collage file.
3. Read the task row and whole card. Identify the user-visible outcome, every acceptance case,
   required dependency contract, and rollback. Existing code is the baseline: inspect it before
   deciding what to implement.
4. Claim one numbered work package and a named file set. Check other agents' ownership before
   editing. Shared integration files have one owner, even when many tasks need them.

**Completion of this step:** the handoff/receipt names the exact task package, owner, paths,
baseline commit, prerequisite evidence, and deliverable. A missing prerequisite becomes a
concrete discovery or dependency work order; it does not remove the parent requirement.

## 2. Ground the change in current code

1. With an existing index, query CodeGraph for the named symbols and their producer-to-consumer
   path. Inspect callers, handlers, exports, tests, and failure paths surfaced by the graph.
2. When exposed, use Serena's current symbol body/reference tools for the exact target and edits,
   following its loaded manual. If unavailable or a graph query fails, use the current-source
   fallback in the tooling guide. Follow freshness warnings; read the affected paths.
3. Write a short acceptance map: input/trigger → expected state/output → assertion or observable
   artifact. Include valid, invalid, cancellation, and restart cases required by the card.
4. For a reported defect, reproduce the precise failing case before deciding whether production
   behavior, a fixture, or the test's synchronization is wrong. Preserve correct existing behavior.

**Completion of this step:** every intended edit has a current source anchor and every acceptance
case has a named proof. Discovery ends with a concrete contract, fixture matrix, or call-path map.

## 3. Implement a complete slice

1. Change the real entry point through the consumer: a library export alone does not establish
   runtime integration. If the card deliberately specifies a library, prove that scoped contract.
2. Validate at the trusted boundary; use shared validators, error serializers, and redactors.
   Attest actor/session/project identity from authenticated context rather than payload fields.
3. Implement success, failure, cancellation, cleanup, and bounded-resource behavior together.
   Stateful changes include reader compatibility, atomic acknowledgement, recovery, and rollback.
4. Keep each work package independently reviewable. When its file set grows beyond five files or
   spans multiple persistence/protocol boundaries, split the package and preserve the parent scope.
5. Update the consuming UI/CLI/tool contract and its documentation in the same slice. Trace
   histories remain honest even when the visible UI collapses repeated events.

**Completion of this step:** the required entry point reaches working behavior; required error
paths return the documented result; no remaining package is concealed by a success response.

## 4. Verify proportionately

| Change                         | First proof                                                                      | Broaden when                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Documentation only             | Check IDs, links, dependencies, status consistency, and formatting               | The docs change a machine-checked claim or documented executable command |
| Pure helper or bounded policy  | Existing focused suite plus required boundary cases                              | A caller contract or shared default changes                              |
| HTTP/tool/auth/redaction       | Focused route/tool contract and refusal/privacy cases                            | Integration crosses packages or touches middleware/defaults              |
| Persistence/lifecycle/protocol | Fault, concurrency, cancellation, restart and replay cases specified by the card | The shared store/transport or migration changes                          |
| User interaction               | Focused browser flow including the actual control and observable result          | Shared state, navigation, offline/reconnect or accessibility changes     |

Follow the active human request's verification scope; this guide alone does not authorize adding
or running tests. When verification is requested, use existing tests first. Add meaningful
coverage for new behavior or reproduced defects; avoid
tests that only restate an implementation. Batch related checks after a coherent edit. Repeat a
passing check only after relevant changes, a failure, or an unresolved concern. Run the required
release matrix on the candidate commit before claiming release acceptance.

For an authorized implementation verification, the touched-package static gate includes
Prettier, `oxlint --deny-warnings`, and the package's TypeScript check. Use the current scripts
and package configuration; do not silently downgrade warning handling or bypass a package's
test timeout/isolation configuration with a root invocation. A documentation-only slice needs
document structure/link/format checks; it does not justify a full runtime suite.

Command authority is the current `package.json`, test config, and workflow. Common verified
starting points in this repository:

- `rtk proxy pnpm --dir packages/core exec vitest run test/knowledge/findings-store.test.ts`
- `rtk proxy pnpm --dir packages/server exec vitest run test/cockpit-integrity.test.ts`
- `rtk proxy pnpm --filter @prismshadow/penguin-core build`
- `rtk proxy pnpm --filter @prismshadow/penguin-server typecheck`
- `rtk proxy pnpm exec prettier --check tasks/plan.md tasks/todo.md`

Node must satisfy the repository's `>=24` requirement; the package-manager pin is
`pnpm@11.18.0` at the planning baseline. Re-read the manifests if either changes. Server tests
and cross-package consumers can resolve generated core output: build core after changing its
exported runtime contract, then verify the consumer. A stale `dist` error is an environment
finding until the current source build reproduces it. Root `build` also links the CLI globally;
prefer scoped builds when a global link is outside the work package. Root `typecheck` generates
interfaces before recursive checks, so account for those writes in the changed-file review.

Browser E2E's runner owns temporary data, mock/server processes and cleanup. On this Windows
host, the default `bash` previously selected WSL without Node. Use the available Git Bash runner
or a supported shell with Node/pnpm on PATH; record which shell ran. `SKIP_BUILD=1` is valid only
after confirming all consumed generated outputs match the intended source revision.

## 5. Record evidence and hand off

Every receipt under `docs/audits/` must record these fields:

| Field         | Required content                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Scope         | Parent task and numbered packages completed; all packages remaining                                   |
| Baseline      | Starting SHA, candidate SHA/worktree state, OS, Node and package-manager versions                     |
| Change        | Exact paths, entry point, observable before/after behavior                                            |
| Acceptance    | One result for every criterion: proved, contradicted, incomplete, or missing                          |
| Verification  | Exact commands, exit results, meaningful case counts, fixture/corpus hashes when required             |
| CI            | Candidate head SHA, run/job URLs, required failures/pending checks; historical receipts kept separate |
| Compatibility | Old-reader/client behavior, scope ownership, migration/rollback receipt where required                |
| Residual work | Concrete next work package, owner/path boundary, and dependency or failed criterion                   |

Update the canonical row in [todo.md](todo.md), the relevant card only if its contract changed,
and `docs/status-ledger.json` when a current shipped/experimental claim changes. This JSON
ledger governs runtime claims; the task index governs work state. A prose plan rewrite does not
make implementation complete.

Record `IMPLEMENTED` after the slice exists but acceptance/review remains. Record `VERIFIED`
only with the complete scoped evidence and required review/CI receipt. A denied promotion is a
recorded decision with evidence, affected requirement, and reopen condition; it is not a silent
deletion of an unresolved task.

## 6. Finish the run cleanly

1. Inspect the actual diff and check formatting/whitespace. Before an authorized commit, run the
   repository-required dependency audit; before an authorized push, inspect the diff again.
2. Stop only the processes started by this run. Confirm their handles are terminal. Preserve
   deliberately existing servers and caches.
3. Run `rtk proxy node scripts/clean-workspace.mjs`, inspect its report, then run the same command
   with `--apply` as required by local instructions. Preserve preexisting `dist/` and `target/`;
   report generated outputs retained for verification.
4. Report the completed deliverable, evidence limits, remaining criteria, and next highest-ROI
   ready package. Keep the overall 4+1-phase objective open until its full completion audit passes.
