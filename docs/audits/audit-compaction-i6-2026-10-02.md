# I6 — Redact first, compact audit payloads (2026-10-02)

The audit log is a signed receipt of *what happened*, and its standing invariant — pinned by the
I1-era signing test — is that a tool call's arguments never appear in it. Before this package that
invariant was kept by storing only hashes of a message, which left no room to record what an event
*was*; the alternative someone would eventually reach for is storing bodies, which is unbounded and
unsafe. This package is the documented middle: a bounded **structural digest** with correlation kept
verbatim and bodies stored as size-and-hash only.

Scope note: the I6 deliverable is the compaction contract and its evidence. **No reader change** —
`read-audit.ts` still verifies `payloadHash`/signature over the stored JSON, still allows exactly the
same payload fields, and its bounds (1 MiB tail, 50 receipts) are untouched, because the new
`details`/`detailsMeta` fields are additive and covered by the existing hash.

## I6.1 — Schema and cap, decided before implementation (deliverable)

Inventory: the only audit emitter is `AuditRecorder.record` (three event types: `tool_call`,
`tool_call_output`, `approval_decision`); the only reader is `readAuditReceipts`; the redactors are
I1's `redactTraceRecord` / `redactSessionHeaders` / `sanitizeErrorForLog` / `redactCredentials` /
`maskEmail`; `generateAuditReceipt` is a separate receipt helper and is untouched.

The stored payload keeps every field the reader verifies (`version: 1`, `projectId`, `agentId`,
`sessionId`, `origin`, `timestamp`, `type`, `eventHash`) and gains:

| Field | Meaning |
| ----- | ------- |
| `details` | the redacted structural digest: field names, types, sizes, content hashes; correlation fields verbatim |
| `detailsMeta.bytes` | UTF-8 bytes of the serialized `details` |
| `detailsMeta.truncated` | true when the digest is **not** the complete payload (any digest, shortening or summary) |
| `detailsMeta.shortened` / `detailsMeta.omitted` | counts of shortened strings / digested values |

Byte-ceiling policy (`AUDIT_DETAILS_MAX_BYTES = 2048`, `maxStringChars = 256`, `maxDepth = 4`,
`maxChildren = 24`, `AUDIT_VERBATIM_MAX_BYTES = 512`), and the exact treatment of oversized fields:

1. a value under a **correlation field name** (`type`, `kind`, `role`, `name`, `id`, `tool_call_id`,
   `status`, `stop_reason`, `decision`, `mode`, `provider`, `model`, `origin`, `session_id`, … — 24
   names, `_`/`-`/case insensitive) is kept verbatim, redacted first; over 512 bytes it is digested
   like a body, because a 2 KB "name" is a body in disguise;
2. every other **scalar** becomes `{"<digest>": {type, bytes, sha256}}` — 16 hex characters;
3. objects/arrays are walked so the stored JSON mirrors the payload's shape, up to depth
   (`<structure>` summary beyond it) and children (`<structure>` summary for wider nodes);
4. strings are shortened longest-first (path order for equal lengths) with `…[truncated]` appended,
   always on a UTF-8 code-point boundary;
5. if the ceiling still cannot be met after 64 rounds (only reachable when kept values are already at
   the shortening floor), the details fall back to a single `<structure>` summary of the whole value.

## I6.2 — Redact before shrinking (deliverable)

Order, enforced by construction: `redactAuditValue` runs before any length is measured and before any
hash is taken, and `AuditRecorder.eventHash` is now taken over `redactTraceRecord(msg)` instead of the
raw message — a hash of unredacted bytes is an oracle for content the log deliberately removes.

Two robustness findings from the named negatives (both fixed here, both would have lost audit events):

- **nested errors** — an `Error`'s properties are not enumerable, so `redactTraceRecord` turned a
  nested error into `{}` and its name/message/cause vanished. Errors (root and nested) are now
  wrapped as `{"<error>": sanitizeErrorForLog(error)}` before redaction and unwrapped verbatim in the
  digest, so the cause chain survives, redacted and bounded by I1.
- **circular values** — the shared redactor recurses by value, so a self-referencing payload
  overflowed the stack and the audit event was lost entirely. A cycle-safe pre-pass replaces a
  repeated reference with `[circular]` and bounds depth/node count, reporting each as omitted.

Header maps keep I1's contract: a field named `headers` goes through `redactSessionHeaders`, so
`accept`/`content-type` stay readable and every other header name — including an unknown vendor
header — is replaced in full.

## I6.3 — Deterministic compaction (deliverable)

Deterministic: traversal order, the longest-first shortening order (path order for ties) and the
digest picks are all functions of the value, so the same payload compacts to the same bytes (asserted).
Integrity is computed over the stored form: `auditStoredPayloadHash(payload)` hashes the exact
serialized JSON that is written, and `auditStoredPayloadSignature` HMACs that hash — tampering with
`details` breaks both, which the reader rejects.

## I6.4 — Privacy and readback fixtures (deliverable)

`packages/server/test/audit-compaction.test.ts` — 20 cases:

| Card negative | Case |
| ------------- | ---- |
| nested credential | credential three levels deep: no secret, structure and field names readable |
| truncated secret | a secret at the head of a 4 KB body: no prefix, no `sk-live`, only size + hash (and the same for an ordinary, non-secret argument, which the I1 signing test requires) |
| unknown header | vendor header fails closed, I1's allowlisted protocol headers stay readable |
| large multibyte body | 2,000 CJK/emoji repetitions: details ≤ ceiling, no `U+FFFD`, lossless UTF-8 re-encode; plus a dedicated shortening-on-code-point-boundary case |
| invalid integrity | tampered `details` → hash and signature both differ; the real reader skips the tampered line |
| export cannot leak or claim a complete payload | the log bytes contain no secret; `truncated`/`omitted` are set and the summary has no `value` field, so nothing claims to be content it is not |
| correlation round-trip | a real `AuditRecorder` → real `readAuditReceipts`: type/session/origin/`executingSessionId` intact, `eventHash` over the redacted message |
| bounded on disk | five 50 KB payloads → five lines under 4 KB each |

Mutations: `bodies stored verbatim instead of digested` → 9 failed; `nested error loses its
message/cause` → 1 failed; `header allowlist skipped` → 2 failed; `eventHash over the unredacted
message` → 1 failed. One mutation is **equivalent by design**: removing the loop's no-progress guard
is unobservable because the 64-round cap terminates the same spin (defence in depth; recorded rather
than claimed as a kill).

## Verification

```
cd packages/server && node ../../node_modules/vitest/vitest.mjs run \
  test/audit-signing.test.ts test/read-audit-signing.test.ts \
  test/audit-receipts.test.ts test/audit-compaction.test.ts      # 4 files / 39 passed
cd packages/core && node ../../node_modules/vitest/vitest.mjs run \
  test/credential-redactor.test.ts test/redaction-completions.test.ts   # 28 passed (I1 baseline)
node node_modules/typescript/bin/tsc --noEmit -p packages/server/tsconfig.json   # clean
```

## Compatibility

- `version` stays `1`; the reader accepts the line because every field it checks is unchanged, and it
  verifies the digest for free (the hash covers whatever the payload contains).
- The reader's 1 MiB tail and 50-receipt bounds are unchanged, as the card requires.
- Rollback: stop emitting `details`/`detailsMeta`. The compaction module is additive, so the verbose
  event can be dropped while type/correlation records remain (the card's own rollback).

## Residual work

- The digest is *lossy by design*; a consumer that needs argument bodies must read the trace, which is
  where I1 keeps them. This is now stated in the recorder's doc comment rather than implied.
- `detailsMeta.truncated` is set for every ordinary tool call (the arguments are always digested).
  That is the honest reading of "this is not the complete payload", but a consumer that wants
  "was a *kept* value cut?" should read `detailsMeta.shortened`.
- No reader-side surfacing yet: `readAuditReceipts` returns the receipt view without `details`, so the
  digest is available in the log file and to any future export path, not through the API. Wiring it
  into an API response is a server-surface change with its own review.
