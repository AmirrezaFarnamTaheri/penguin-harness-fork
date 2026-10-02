# Workspace builds and dependency links

Server, web and CLI consume the built core package. After changing core source or pulling a
lockfile change, run `pnpm --filter @prismshadow/penguin-core --filter @prismshadow/penguin-cli build`.
The core build writes `dist/workspace-sentinel.json` with its source, checkout revision and
export fingerprints.

Run `pnpm check:workspace-deps` to inspect the exact core exports resolved by all three
consumers. The checker only reads files and resolves modules. A stale build or copied package
prints the consumer and resolved file paths and exits unsuccessfully. Restore links through
`pnpm install --force`, then rerun the build command above. The checker does not edit package
manager internals or local agent instructions. Reinstallation alone may leave injected
outputs unchanged; the build command uses `syncInjectedDepsAfterScripts` to refresh them.
See the [pnpm workspace documentation](https://pnpm.io/workspaces).

## Documentation status claims

`docs/status-ledger.json` is the versioned, machine-checked inventory for new status claims.
Run `node scripts/check-doc-claims.mjs` before documenting a feature as `Shipped`. Each claim
names an implementation and evidence links, including optional Markdown heading anchors.
A shipped claim provides a source chain from a declared build entry to a consumer that calls
the imported implementation symbol. Same-package calls are supported. Type-only exports and
unused imports cannot establish shipment.

Use `Experimental/unconsumed` for exported primitives awaiting production integration, and
include a reason. The existing historical status table in `tasks/plan.md` still needs migration
into this inventory; the gate currently covers the entries explicitly recorded in the JSON.

For workspace cleanup, `pnpm clean` reports disposable outputs. `pnpm clean -- --apply`
removes the reported disposable files while preserving tracked files and intentional user
data. Build directories and Rust caches remain opt-in.
