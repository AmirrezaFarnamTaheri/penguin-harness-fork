# H1 — Foreign-configuration ownership and transaction contract (2026-10-02)

## Scope

- `packages/core/src/state/foreign-config.ts` — the contract module, new (~600 lines);
- `packages/core/src/state/index.ts` — re-export;
- `packages/core/test/foreign-config.test.ts` — the fixture matrix, new (21 cases).

The three files the card names (`internal/atomic-write.ts`, `state/project-config.ts`,
`cli/src/commands/config.ts`) are the *subjects*, not the changes: the transaction builds on H3's
`atomicWriteFile` unchanged, and `PROJECT_CONFIG_ADAPTER` is the first adapter written against the
new contract. No CLI command was changed and no live foreign config was touched — per the card,
live foreign configuration is only changed with explicit authorization.

## Baseline

There was no ownership model for files the Harness did not author. `saveProjectConfig` writes
`.project_config.toml` with a whole-file render, which is correct for a file the Harness owns and
wrong for anything else: an unmarked file presented to it would have its unknown top-level keys
dropped, its format normalised, and no backup taken. `atomicWriteFile` made each replacement
atomic but said nothing about *whether* the replacement should happen, and nothing about how to get
the previous bytes back.

## Change

1. **H1.1 — ownership and version.** A `ForeignConfigAdapter` declares the marker key/value that
   proves the Harness manages the file, the version key, and the inclusive supported range.
   `previewForeignConfig` records bytes, sha256, permission bits, mtime, version, marker, the
   managed verdict, whether the target is a regular file, and the symlink chain (hops + resolved
   path) — everything a caller needs to show the user what a write would replace. Two adapters
   ship: `jsonConfigAdapter` (any provider `settings.json`-shaped file) and
   `PROJECT_CONFIG_ADAPTER` (the Harness's own TOML config, line-edited and conservative).
2. **H1.2 — the transaction.** `applyForeignConfig` runs `inspect → gate → backup → write →
   readback`, and every stage is named in the result. The write goes through H3's
   `atomicWriteFile`, so the previous bytes stay readable until the replacement is published. The
   readback re-inspects what actually landed and returns a **redacted** view (`****last4` for keys
   that look secret). A failure after the backup restores the original and says
   `originalPreserved`; a failure before it never touched the file.
3. **H1.3 — concurrent owners.** Ownership, version and the caller's `expectedSha256` are checked
   at the gate, and the hash is checked **again immediately before the rename**, so a write that
   loses a race is refused rather than clobbering the other writer. Adoption is a normal
   transaction (empty patch, purpose = marker + version) and refuses an already-managed file.
4. **H1.4 — restoration.** `restoreForeignConfig` restores the backup atomically, falls back to an
   in-place copy when the rename is the thing that is failing, and verifies the bytes on disk
   equal the backup before returning success.

## Acceptance

| Named negative | Fixture | Result |
| -------------- | ------- | ------ |
| unmanaged provider | `settings.json` without the marker | `unmanaged-provider`, no backup, bytes unchanged |
| unsupported version | `configVersion: 2` against `1-1` | `unsupported-version`, message names the range |
| changed file since preview | another writer saves after the preview | `changed-since-preview`, the *other* writer's bytes kept |
| changed between gate and rename | file written during the gate | `changed-since-preview`, `second check` in diagnostics |
| permission denial | rename raises `EPERM` | `permission-denied`, original restored |
| failed rename | rename raises `ENOSPC` | `write-failed`, backup kept, no `.tmp-` leftovers |
| symlink target ambiguity | 40-hop cycle; link to a directory | `symlink-target-ambiguous` (a *dangling* link is fine: nothing is there) |
| write not reading back | adapter that does not write the marker | `readback-mismatch`, original restored |

Plus the positive paths: a managed JSON write keeps every unknown key and the file's `0640` mode,
backs up the original byte-for-byte at the original mode, and reports `["inspect","gate","backup",
"write","readback"]`; adoption marks an unmanaged file while keeping its keys; a managed TOML
config is edited line-wise with its tables, arrays and array-of-tables untouched.

## Verification

```
node ../../node_modules/vitest/vitest.mjs run test/foreign-config.test.ts
→ Test Files 1 passed (1) | Tests 21 passed (21)
```

Mutations, each applied alone and reverted:

| Mutation | Result |
| -------- | ------ |
| ownership gate removed | 2 failed |
| version gate removed | 1 failed |
| pre-write re-check removed | 1 failed |
| readback gate removed | 1 failed |
| restore falls back to "claim success" | equivalent (the copy already ran; the verification only decides a case this fixture set cannot fake) |

`tsc --noEmit -p packages/core/tsconfig.json` clean; `prettier --check` clean.

## Compatibility / rollback

- Additive: nothing existing calls the module yet, and `saveProjectConfig` is unchanged. A
  project config written by earlier releases inspects as **unmanaged** on purpose — those files are
  owned by `saveProjectConfig`, and this adapter must not claim it can round-trip a file it did not
  model.
- Rollback is per-file, not per-feature: restore `backupPath` byte-for-byte and mark managed
  ownership false where the adapter no longer owns the file. The diagnostics that say which stage
  failed are preserved in the result either way.
- Windows and POSIX: the tests are platform-agnostic except the permission-denial fixture, which is
  skipped on Windows (`chmod` on a directory does not deny writes there); the `EPERM`-from-rename
  case is the Windows-shaped equivalent and runs everywhere.

## Residual work

- `PROJECT_CONFIG_ADAPTER` is not yet wired into `saveProjectConfig` or the config CLI: an existing
  `.project_config.toml` has no marker, so adoption would be the first step, and changing that
  write path is its own package with its own migration story.
- `jsonConfigAdapter` merges top-level keys only. Nested patches are a later adapter's job; the
  contract requires that a format the adapter cannot rewrite returns `unsupported-syntax` instead
  of a partial write, which is what the TOML adapter does today.
- The readback redaction is key-name based (the same rule the rest of the codebase uses). A secret
  in a key the pattern does not recognise would still be shown; the pattern is exported for reuse
  and extension.
