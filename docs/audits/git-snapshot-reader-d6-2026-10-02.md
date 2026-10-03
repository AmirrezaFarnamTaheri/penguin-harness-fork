# D6 — Git snapshot reader (2026-10-02)

The reader already existed and already had tests; D6's job was to find out *exactly* what those
tests proved, close the gaps around the `cat-file --batch` path, and prove checkout isolation
against every override Git accepts rather than the two the suite happened to stub.

## D6.1 — Inventory: guarantee → assertion (deliverable)

| Guarantee | Where it lives | Assertion (before → after) |
| --------- | -------------- | -------------------------- |
| revision validation | `resolveTree` rejects empty/oversized/NUL revisions; `OID_PATTERN` (sha1/sha256) on both `rev-parse` outputs | **new**: bogus, 1025-char and NUL revisions → `invalid-revision`, and the repository is untouched |
| file selection | `includePath` filters `ls-tree` entries before blob ids are collected | existed ("selects source files before fetching unrelated binary assets"); a 100-byte binary asset is excluded under a 50-byte object limit and `uniqueBlobCount === 1` |
| oid deduplication | union of both trees' blob ids, one `batch-check` + one `batch` | existed: 6 entries → `uniqueBlobCount === 5`, and the shared blob is *the same Buffer instance* in both snapshots |
| bounded buffers | `maxTreeBytes` (stream), `maxEntries` (count), `maxObjectBytes`/`maxTotalBytes` (metadata, before fetch) | **new**: `maxEntries: 2` over 3 files → `snapshot-too-large`; `maxTreeBytes: 64` over 40 entries → `snapshot-too-large` from the *stream* bound; object limits existed |
| typed failures | `GitSnapshotErrorCode` (12 codes) | existed for `missing-object`, `binary-object`, `object-too-large`, `invalid-object-response`; **new** for `invalid-revision`; `invalid-tree`, `invalid-object-id`, `git-unavailable`, `git-command-failed`, `timeout` remain code-level guards (see residual) |
| environment handling | child env scrubs `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_PREFIX`, `GIT_CONFIG_*`; adds `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`; argv carries `--no-replace-objects` | existed for `GIT_DIR`/`GIT_WORK_TREE` + `git replace`; **new**: all of the above stubbed at once while reading *tag* revisions (a namespace override would hide a tag; an object-directory override would serve the decoy's bytes) → real content |
| checkout isolation | no `checkout`/`worktree`/`update-index`/`update-ref` call anywhere | existed for dirty + untracked file bytes and porcelain status; **new**: `.git/index` bytes are byte-identical after a read, and a **bare repository with no checkout at all** reads fine by ref and by oid |
| cancellation | abort/timeout → SIGKILL, settle on `close` | existed: an in-flight abort rejects `interrupted` — and because the promise only settles on the child's `close`, that rejection *is* the proof the child terminated |

## D6.2 — Gaps closed

Test-only changes (`packages/core/test/codegraph/git-snapshot.test.ts`, 6 → 12 cases, +6):

1. invalid revision (three shapes, incl. before any spawn) — named negative;
2. `maxEntries` bound → typed `snapshot-too-large`;
3. `maxTreeBytes` stream bound → typed `snapshot-too-large` (distinct code path from (2): the count
   is never consulted because the stream overflows first);
4. every inherited Git override at once, read by tag name;
5. bare repository (no worktree, no index) — the "usable without an implicit checkout" proof;
6. index bytes and porcelain status unchanged after a read.

No production source change was needed for the bounded-buffer behaviour: the metadata-before-fetch
check and the stream bound were already correct. The reader gained its **contract block** (D6.4)
instead of new code.

## D6.3 — Isolation evidence (deliverable)

The two-commit fixture is the existing test (base/head/dirty/untracked), now with the index assertion
added; the override fixture stubs `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE` against a decoy
repository and reads revisions **by tag name**, which is the part that makes the overrides
load-bearing: a namespace would hide the tag, an object directory would serve the decoy's files.

## D6.4 — Consumer seam (deliverable)

- Exports are complete and were already reconciled: `GitSnapshotReader`, `GitSnapshotError`, and the
  five types (`GitCommitSnapshot`, `GitSnapshotChange`, `GitSnapshotEntry`, `GitSnapshotErrorCode`,
  `GitSnapshotPair`, `GitSnapshotReaderLimits`) from `codegraph/index.ts`.
- The **reader contract** now lives on the class doc: what is read (four subprocesses + one
  deduplicated batch pair), what is guaranteed (no worktree/index/ref write, override stripping,
  bare-repo capable), the bounds and their error codes, cancellation semantics, and the
  **limitations** a consumer may rely on being absent — submodule gitlink entries are skipped (a
  submodule pointer change is not reported), symlinks are returned as their target text and never
  followed, a NUL-containing blob is refused rather than truncated, and a corrupt object store
  fails the read (contents are re-hashed against the requested oid).
- For D5's diff DTO and D7's revision producers: `readPair(base, head)` is the revision-to-files
  provider. `GitSnapshotPair.changes` carries per-path `before`/`after` entries (content + mode), so
  the graph diff can be built from two committed revisions without a checkout.

## Verification

```
cd packages/core
node ../../node_modules/vitest/vitest.mjs run test/codegraph/    # 8 files / 87 passed
node ../../modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json   # clean
```

`git status`, index bytes and every fixture file are asserted unchanged; the fixtures live in
`os.tmpdir()` and are removed in `afterEach`, so the repository under test is never the repository
running the tests.

## Residual work

- `timeout` has no dedicated case: the only deterministic way to force it is a 1 ms deadline, which
  would assert the clock rather than the code path, and that path is shared with the abort case
  (same `terminate()` → SIGKILL → settle-on-close). Recorded, not silently claimed.
- `invalid-tree`, `invalid-object-id`, `git-unavailable` and `git-command-failed` are covered as
  code-level guards; forcing them would require a wrapper `git` on PATH or a hand-corrupted tree,
  which is D6-adjacent fixture work rather than reader behaviour.
- D5 is not implemented yet, so the seam is delivered as a documented contract plus verified
  bare-repo usage — wiring the diff DTO is D5's own card, and this receipt is its input.
