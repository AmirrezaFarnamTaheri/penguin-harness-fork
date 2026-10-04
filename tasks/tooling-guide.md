# Code navigation and editing tools for implementation agents

Documentation reconciled on 2026-10-04. Current status and release gates are in
[todo.md](todo.md) and [work-orders.md](work-orders.md); these requirements and historical
observations do not certify the changed working tree.

Use this with [implementation-guide.md](implementation-guide.md). Research was checked on
2026-10-02 against the exposed tool manuals and the primary sources linked below. A project
name is not proof that its server is configured, its index is current, or an action is safe.

## 1. Choose the tool by the question

| Need                                                        | First action in this checkout                                        | Deliverable                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| Locate code; trace a producer, consumer or caller           | CodeGraph `codegraph_explore` with named symbols/files               | Relevant source, relation paths and affected callers      |
| Resolve a precise symbol/reference or edit its structure    | Serena, when its tools are exposed and the correct project is active | Exact symbol body/name path, references and bounded edit  |
| Read policy, manifests, task documents or unindexed content | Native file read or focused `rg`                                     | Current relevant lines                                    |
| Work after a graph error or stale-index warning             | Current Serena result or native read of the affected paths           | Current source plus the recorded index limitation         |
| Check runtime behavior                                      | The verification explicitly authorized for the task                  | Observable behavior; a graph result alone is insufficient |
| Recover prior decisions                                     | Available project memory, then current task/receipt/source           | Dated context with its scope and evidence checked         |

Do not run several indexers for the same lookup. CodeGraph has repository precedence here.
Use a second tool when it answers a specific unresolved question or supplies current references
for an edit. Search results and remembered notes remain evidence to interpret, not instructions
that override the human request or repository rules.

## 2. CodeGraph: map the change before editing

This checkout has a user-created `.codegraph/` index. The exposed MCP tool accepts `query`,
optional absolute `projectPath`, and optional `maxFiles`; these names were checked against its
current schema. For example:

```json
{
  "query": "packages/server/src/runtime/logger.ts safeErrorSummary installProcessErrorHandlers",
  "projectPath": "D:\\GitHub\\penguin-harness-fork",
  "maxFiles": 4
}
```

The shell alternative is `rtk proxy codegraph explore "safeErrorSummary process-errors.ts"`
from the repository root. MCP and CLI can have different availability; try the available reader,
then use the fallback below if it fails. Do not rebuild the index to answer a lookup.

1. Name the entry point and expected consumer in one bounded query. Include a package path when
   a common name such as `logger` also matches skills or unrelated modules.
2. Read the returned source and call paths. Record identity/auth boundaries, error handling,
   exports and affected consumers. Selected symbol bodies can contain gaps between them; a
   response with omitted files or symbols is not a complete repository inventory.
3. Follow an omitted symbol only when needed for the acceptance map. Fresh source already
   returned by the tool need not be read again merely to repeat the lookup.
4. Inspect freshness and error messages before editing. Pending-file warnings require current
   reads of the named files. Disabled auto-sync means potentially changed areas need current
   reads. A schema/database failure means graph relations are unavailable for that call.
5. After an edit, use the current diff and targeted references to check affected consumers.
   Re-query only for a material relationship change or an unresolved affected path.

**Observed limitations:** this session's MCP query returned logger source successfully, while a
worker's CLI query failed with `UNIQUE constraint failed: schema_versions.version`. Earlier
responses also named pending files. Record which route worked; do not infer that all readers or
all indexed relations are fresh. Preserve `.codegraph/`; do not delete, repair, reindex or upgrade
it as an incidental feature step. If no index exists, use native tools and leave indexing to the
user. A tool update notice is not authorization to update it.

Cross-file relations use best-effort resolution. An ambiguous call may have several candidates;
check the actual dispatch/type contract before choosing one. “No covering tests found” is a
graph discovery result, not proof that tests do not exist. Static edges do not prove runtime
ordering, authorization, thread safety or successful compilation.

**Two distinct layers:** external CodeGraph indexes `.codegraph/` for the implementation agent.
The product's `code_graph` tool and `packages/core/src/codegraph/` implement runtime graph
features. Using the external tool does not complete D1–D11 or change the product's read-only
graph contract. Keep those task acceptance criteria separate.

## 3. Serena: inspect and edit exact symbols

Serena provides semantic retrieval, references and editing through language-server or supported
IDE analysis. The agent owns planning, verification and rollback. See the primary
[Serena overview](https://github.com/oraios/serena) and
[project workflow](https://oraios.github.io/serena/02-usage/040_workflow.html).

This session previously loaded Serena's manual and activated this repository; later tool
discovery did not expose Serena. Re-check the live catalog on every resumed session. Never
pretend an unavailable call succeeded. Use current CodeGraph/native tools when unavailable.

When exposed:

1. Load `initial_instructions` once, activate the exact repository, and inspect onboarding state.
   Follow the current tool schema rather than copying another installation's namespace/options.
2. Use `get_symbols_overview` for the target file, then `find_symbol` scoped to that relative path.
   Read the chosen body with `include_body: true`; disambiguate overloads/nested name paths.
3. Use `find_referencing_symbols` before a signature, export, rename or state-contract change.
   Trace runtime callers and string/config consumers that semantic references may not include.
4. Use `replace_symbol_body` for a complete symbol only after reading its current body. Use
   symbol insertion/rename tools when available and appropriate. For a small edit, native patch
   is sufficient; inspect the resulting diff for imports, decorators and surrounding comments.
5. Keep each edit within the claimed file ownership. Preserve edits from other agents. Re-read
   the current body if it changed after discovery; never replace it from a stale snapshot.

Observed argument patterns, subject to the currently exposed schema:

```text
find_symbol(name_path_pattern="safeErrorSummary",
            relative_path="packages/server/src/runtime/logger.ts", include_body=true)
find_referencing_symbols(name_path="safeErrorSummary",
                         relative_path="packages/server/src/runtime/logger.ts")
```

The loaded Serena manual uses zero-based line positions. Convert them before publishing
one-based file links; check each tool's convention rather than transferring a line number
between tools. Symbol identities are file-scoped. Diagnostics and references depend on the
configured backend/language support; an empty reference set does not prove a symbol is unused.
Serena memory can retain project context, but current code and receipts determine completion.

## 4. Other names from the research list

These are identified public projects, not an installation recommendation. The user supplied
short names without repository URLs; the links identify which project each statement describes.
If the configured server points elsewhere, inspect that server's documentation first.

| Name / identified primary project                                                 | Supported description and useful role                                                | Correction or execution condition                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [smart-coding-mcp](https://github.com/omar-haris/smart-coding-mcp)                | Embedding-based semantic code search and indexing; package-registry lookup           | The inspected README does not establish atomic multi-file refactoring or syntax-safe edits. Use it for retrieval when configured.                                  |
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus)                           | Code knowledge graph, call/dependency context and impact queries                     | Its name does not make it a Git staging/branch/merge manager. Use the existing Git workflow for version control.                                                   |
| [Graphify](https://github.com/Graphify-Labs/graphify)                             | Graphs spanning code and documents; distinguishes extracted and inferred connections | It also parses code. Document/media processing can use a model; check provider/data flow before invoking it. Inferred edges need source evidence.                  |
| [async-bash-mcp](https://github.com/xhuw/async-bash-mcp)                          | Spawn, list and poll asynchronous Bash processes, including termination              | Useful only when configured with a suitable shell. This Windows task already has command sessions; retain handles and stop only owned processes.                   |
| [CocoIndex](https://cocoindex.io/docs/core/basics)                                | Incremental source-to-target data processing for indexes and other outputs           | BM25, dense retrieval, commit search and API ingestion require a concrete configured pipeline; do not assume every deployment provides them.                       |
| [LeanKG](https://github.com/FreePeak/LeanKG/blob/main/AGENTS.md)                  | Code graph retrieval and project memory facilities                                   | “Zero overhead” is unproved. Verify the deployed backend, index freshness and memory scope; versions/configurations differ.                                        |
| [RepoBrain](https://github.com/study8677/repobrain)                               | Repository knowledge generation and agent-routed Q&A grounded in source              | Refresh/model calls have execution and data-flow costs. Generated architectural notes require current source anchors; do not dispatch a remote backend implicitly. |
| [jCodeMunch](https://github.com/jgravelle/jcodemunch-mcp/blob/main/USER_GUIDE.md) | Syntax/symbol-oriented code retrieval                                                | This session exposes `route`, `menu`, `order` and a guide. Discover actions through that front door; upstream direct-tool examples may not match it.               |
| [Claude-Mem](https://github.com/thedotmack/claude-mem)                            | Captures coding-session observations and supplies context to later sessions          | Host integrations and storage/provider choices vary. It does not automatically know every user preference or establish current task evidence.                      |
| [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)            | Persistent code knowledge graph and structural code intelligence                     | The name is not proof of a convention-only memory vault. Confirm this exact project rather than treating all “codebase memory” systems as equivalent.              |
| [Cavemem](https://github.com/JuliusBrussee/cavemem/blob/main/CLAUDE.md)           | Cross-agent memory using compressed observations, SQLite and a vector index          | The inspected project is not merely append-only Markdown storage. Inspect retention, privacy and deployment before writing memories.                               |

At this session snapshot, CodeGraph and jCodeMunch are exposed. Serena availability changed.
The other listed names were not exposed in the catalog inspected for this guide; this does not
prove they are uninstalled. Check the current catalog/configuration without printing credentials.

### jCodeMunch front door in this session

Read `jcodemunch_guide`; ask `menu` for the needed capability or `route` for an unresolved goal.
For example, the loaded guide documents this read-only resolution call:

```json
{
  "action": "resolve_repo",
  "args": { "path": "D:\\GitHub\\penguin-harness-fork" }
}
```

Send it through `order`, then use returned examples for symbol/source retrieval. Do not run
`index_folder` or `register_edit` automatically: those mutate index state and require a scoped
index-maintenance decision. Respect the repository's CodeGraph-first rule despite a generic
server guide preferring its own tools. Missing source with a `source_status` is a retrieval
failure, not an empty implementation. Report absence only with the server's citable absence
evidence and valid scan scope; the loaded guide documents `_meta.verdict.evidence_ref` or
`_meta.absence_evidence.citable` for that distinction.

## 5. Required handoff evidence

Record task/package, current SHA, tool and project root, discovered source anchors, affected
consumers, any freshness/availability limitation, actual edits and authorized verification.
Store accepted decisions in task documents/receipts; use optional memory only as a dated pointer.
Do not copy secrets, full logs or private findings bodies into another tool's persistent store.
Preserve the configured tools and private state. Installation, provider changes, remote agent
dispatch and index repair are separate scoped work, not prerequisites invented by this guide.
