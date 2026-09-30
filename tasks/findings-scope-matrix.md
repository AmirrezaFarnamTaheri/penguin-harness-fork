# Findings scope and authority matrix

Status: implemented and covered locally; the product contract still needs review in PR #12 before
R2a (scope-aware persistence or migration) begins. This document describes the current authorities,
not a promise that they share data.

## Current authorities

| Scope key | Owner | Authority path | Readers and writers | Authorization check | Backup and recovery | Equivalence proof | Unmapped behavior |
|---|---|---|---|---|---|---|---|
| Canonical workspace directory from `ToolExecutionContext.workspaceDir` | The host process that supplies the workspace context | `<realpath(workspaceDir)>/.penguin/knowledge/findings-graph.json` | Core `knowledge_graph` builtin tool; core cache is keyed by the canonical workspace directory | The model cannot supply the path; the host supplies it in tool context. No server project membership is implied. | Atomic temp-file rename. No findings-specific generation history or backup is provided by this store; recovery depends on the operator's workspace backup/version-control policy. | None. A path or display-name match is not proof that this is a server project. | Remains an isolated workspace graph. It is not queried, mutated, labeled, or migrated as a project graph. |
| Opaque `projectId` accepted by the server project service | Project owner and authorized members recorded in the project database | `projectDir(config.root, projectId)/.findings_graph.json` | Findings HTTP routes through `ProjectJsonStore` | Every route calls `requireProjectAccess(userId, projectId)` before reading or mutating. Unauthorized and unknown projects both return 404. | Atomic project-file persistence; no findings-specific history or backup is defined. Operators must include the project data root in their backup policy. | None. `ProjectRow` has no trusted workspace-directory mapping. Duplicate display names still have distinct project IDs and stores. | Remains an isolated project graph; no workspace path is guessed and no builtin-tool file is read or written. |

The workspace tool resolves an existing directory through `realpath` before using it as a cache or
store key. This makes symlink aliases of the same workspace converge on one in-process graph. If a
workspace does not exist yet, it uses its absolute lexical path; non-`ENOENT` resolution failures
surface instead of creating a second authority. The server store continues to use validated opaque
project IDs under the configured project root.

## Evidence in the repository

- `packages/core/src/environment/tools/knowledge-graph.ts` supplies the builtin's workspace path,
  canonical cache key, and workspace-local file path.
- `packages/core/test/knowledge/knowledge-graph-tool.test.ts` verifies a real workspace and its
  directory symlink cannot produce stale, competing cached graphs.
- `packages/server/src/http/routes/findings.ts` creates the project store and checks access on
  route operations; `packages/server/src/services/project-json-store.ts` resolves each file from
  the configured project root and project ID.
- `packages/server/test/findings-routes.test.ts` verifies the two files remain independent, a
  workspace rename retains only its workspace graph, same-name projects remain isolated, and an
  unrelated user cannot read or mutate the project graph.

## Binding and migration requirements

There is no binding today. Any future binding must be an explicit, audited server operation backed
by trusted project and workspace identities; it must never be inferred from a model argument,
display name, basename, current working directory, or path similarity. Before a binding can read or
write shared data, it must:

1. Prove the project owner/member authorization and the host's authority to bind the workspace.
2. Resolve the workspace with `realpath`, verify it remains under an allowed root, and record the
   stable workspace identity plus the actor, old and new canonical paths, and binding revision.
3. Define sharing explicitly. The default is one project to one workspace; any shared workspace
   must prove every participant's access and cannot widen privileges across owners or tenants.
4. Fail closed when a binding is missing, ambiguous, inaccessible, stale, or points outside its
   allowed root. Do not treat an inaccessible store as an empty graph and then overwrite it.
5. Treat workspace renames as explicit rebinds. Preserve the old mapping until the new mapping is
   authorized and verified; never bind by matching a new path or name automatically.
6. Keep project deletion, workspace deletion, unbinding, and graph retention independent. One
   authority's deletion must not remove the other's data; record an audited detach/tombstone before
   any retention cleanup.
7. Before migration, run a dry-run fixture for equal content, distinct content, corrupt source,
   missing source, symlink aliases, rename, inaccessible path, same-name projects, and shared-owner
   denial. Record hashes and counts; make backup and rollback steps executable before enabling
   writes through a binding.

## Required negative cases

The existing integration fixture establishes that matching names and a workspace rename do not
merge the authorities, while server authorization remains enforced. A future binding change must
add negative coverage for path escape, revoked membership, ambiguous many-to-one mapping, failed
`realpath`, corrupt or truncated source data, and rollback after a partially completed migration.
