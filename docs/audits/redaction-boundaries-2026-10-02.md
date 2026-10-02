# I1 — Redaction across logs, traces and exports (2026-10-02)

I1 required the same safe-header/error helpers to reach every diagnostic boundary, not just the
logger. The logger side was wired in the Wave-1/2 pass (E9). This receipt records the completed
package: the enumerated allowlist and consumers (I1.1), the sanitizer/email reconciliation
(I1.2), trace read/export routing through the shared redactor (I1.3), and the sentinel scans on
final artifacts (I1.4).

## Scope

| Item | Surface |
| ---- | ------- |
| I1.1 allowlist + consumers | `packages/core/src/internal/credential-redactor.ts` (`LOGGABLE_SESSION_HEADERS`, `redactSessionHeaders`), `packages/server/src/runtime/logger.ts` (`Headers`/record/iterable consumers) |
| I1.2 error/email reconciliation | `sanitizeErrorForLog` and `maskEmail` in the same core module |
| I1.3 trace/export routing | `packages/core/src/internal/credential-redactor.ts` (`redactTraceRecord`, `redactTraceContent`), `packages/server/src/services/trace-service.ts` (`readEvents`, `readFileRaw`), `packages/server/src/http/routes/agent-traces.ts` (contract comment) |
| I1.4 fixtures | `packages/core/test/redaction-completions.test.ts` (9 cases) and `packages/server/test/trace-import-export.test.ts` (13 cases, incl. the sentinel scan) |

Remaining Wave-2 packages: E10, F17/C8, I4, I7, and the Wave-3/4 sets. Used by other packages:
I4 (this session), F13a/K1a display surfaces.

## Baseline

- Parent commit `8cd688e4` (E4 VERIFIED). Linux x64, Node v22.22.3, pnpm 11.18.0, vitest 4.1.11.
- Before this slice the redactor itself was complete and unit-tested, but the trace boundary was
  **not** routed through it: `readEvents` returned raw parsed records and `readFileRaw` returned
  the file's bytes verbatim, so any credential recorded while a Session ran (tool output, a
  provider error, a prompt) was re-published to every member who could read that Project's
  Traces and left the install through the download.

## I1.1 — Allowlist and consumers

The canonical fixture is the exact 14-key set asserted in
`packages/core/test/redaction-completions.test.ts` (`accept`, `accept-encoding`,
`accept-language`, `anthropic-beta`, `anthropic-version`, `cache-control`, `connection`,
`content-encoding`, `content-length`, `content-type`, `host`, `openai-beta`, `user-agent`,
`x-request-id`). Every other header is replaced in full, so an unnamed vendor credential header
fails closed. Consumers are the three input shapes the helper accepts and the logger's rules:

| Consumer | Shape | Behavior |
| -------- | ----- | -------- |
| `logger.ts` `safeValue` | `Headers` instance | routed through `redactSessionHeaders` |
| `logger.ts` `safeValue` | `headers` field on a plain object | routed through `redactSessionHeaders` |
| `logger.ts` `safeValue` | tuple/record iterables (already supported by the helper) | covered by the core fixtures |
| Trace read/export (this slice) | records and JSONL lines | `redactTraceRecord` / `redactTraceContent` |

Credentials needed for authenticated execution are untouched by any of this: they live in the
credential store and the process environment, and only *diagnostic* copies are redacted.

## I1.2 — Error and e-mail handling

`sanitizeErrorForLog` (already present) yields `{name, message, code?, cause?}`: bounded
name (80) and message (2000), string-or-number `code`, a depth-4 cycle-safe `cause` chain, and no
stack. `maskEmail` maps `local@domain` to `l***@domain`. Both are applied before truncation, so a
cut cannot leave the visible half of a secret behind, and both are now also applied to trace
content by `redactTraceRecord`.

## I1.3 — Trace and export routing

Two new helpers in the shared core module:

- `redactTraceRecord(record)` — deep copy with credential patterns and e-mail masking on every
  string, and whole-value removal for credential-named fields (so `{"apiKey":"…"}` is caught even
  though the JSON quote hides it from the text rules). Returning a copy is the point: the caller
  serializes the copy, and the live object — including a replay-critical `fidelity` blob — is
  never mutated.
- `redactTraceContent(content)` — line-preserving JSONL redaction for downloads. A line that needs
  no redaction is emitted byte-for-byte (whitespace, key order, number formatting), so an ordinary
  export is still exactly the file and re-imports unchanged; only a line that actually carries a
  secret, an address or a credential-named field is re-serialized from its redacted copy. A
  non-JSON line (a torn tail) is passed through the text rules rather than returned raw.

`TraceService.readEvents` maps every returned record through `redactTraceRecord`;
`TraceService.readFileRaw` returns `redactTraceContent` of the file. The file on disk is never
rewritten — it remains the byte-exact resume source, which the new fixture asserts explicitly.

## Acceptance

| Criterion | Result | Evidence |
| --------- | ------ | -------- |
| Raw sentinel secrets absent from logs | PASS | `structured-logger.test.ts` (5 cases) plus the shared sanitizer fixtures; environment-secret scan, `token$` field rule, header allowlist |
| Raw sentinel secrets absent from trace reads | PASS | New I1 fixture: `sk-ant-api03-S…` and a credential-named JSON field are absent from `GET …/traces/:id/:index`; mutation M1 (no mapping) turns it red |
| Raw sentinel secrets absent from exports | PASS | Same fixture on `…/download`; mutation M2 (raw buffer) and M3/M4 (core helper holes) each turn their named cases red |
| Safe non-secret fields remain useful | PASS | Fixture asserts `command: "echo hi"`, `role: "user"`, `status`, `durationMs`, `tool_name`, model ids and structure survive; a clean record is byte-identical |
| Model-authored fields cannot attest identity | PASS (by construction, recorded) | Identity correlation comes from trusted ingress only: `requestLogContext` takes `requestId` from a validated header and `sessionId` from the URL path, never from a body or a message payload. Trace content is data: the import path validates a `session_meta.session_id` only as a filename and rejects duplicates install-wide, so a model-authored record cannot claim another Session's identity (existing `trace-import-export` cases) |
| Privacy failures propagate safely | PASS | `sanitizeErrorForLog` returns bounded `[unavailable]`/`[circular cause]` markers instead of throwing; `redactTraceContent` falls back to text rules on unparseable lines; the logger's emergency sink never recurses |

## Verification

```
cd packages/core
node ../../node_modules/vitest/vitest.mjs run test/redaction-completions.test.ts test/credential-redactor.test.ts   # 28 passed
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json                                               # clean
cd ../server
node ../../node_modules/vitest/vitest.mjs run test/trace- test/structured-logger.test.ts                            # 67 passed
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json                                                # clean
node <prettier store>/bin/prettier.cjs --check <the six touched files>                                              # clean
```

Revert-and-see (one edit each, restored afterwards; server mutations run against the built core,
so the M3/M4 core mutations are exercised by the core suite):

| Mutation | Intent | Cases that failed |
| -------- | ------ | ----------------- |
| `readEvents` returns raw records | trace read leaks | the I1 sentinel case (1) |
| `readFileRaw` returns raw bytes | export leaks | the I1 sentinel case (1) |
| `redactTraceRecord` drops e-mail masking | address leak | core trace case (1) |
| `redactTraceRecord` skips field-name rules | credential-named field leaks | core trace + JSONL cases (2) |

## CI

Exact-commit runs are created per push on this branch; the I1 head is pushed with the package and
the verdict is recorded in the CI-repair receipt when the run completes. Local lanes above cover
the same suites CI runs (`test (core)`, `test (server)`, `typecheck`, `style`).

## Compatibility

- **Additive helpers**: two new exports from the core barrel; no signature changed.
- **Read-path behavior change (intended)**: trace reads/downloads now redact. A client that
  previously relied on a raw download being byte-identical to the stored file will see redacted
  values exactly where secrets/addresses are present; clean records keep their bytes, and a
  redacted download remains valid Trace JSONL that re-imports.
- **Stored files unchanged**: resume, analysis, context breakdown and the Trace index read the
  original file; `fidelity`/`system_prompt` are not mutated in storage.
- **Rollback per the card**: disable the extra diagnostic fields rather than bypassing redaction.
  Reverting this slice is two call sites plus two helpers; the file format did not change.
- Field rule trade-off: a non-secret field literally named `key` (or `auth`) is redacted in
  diagnostics — asserted in the core fixture as the documented price of never emitting
  `{"key": "<credential>"}`.

## Residual work

- I1 does not redact the **agent's own live context** (that is not a diagnostic boundary) and does
  not scrub already-written trace files (they stay replayable; redaction happens on read/export).
- K1a/K2/K4/F13a display surfaces still need their own I1 integration tests when they land; the
  shared helpers they must call now exist.
- Exact-commit CI verdict recorded in [ci-repair-2026-10-02.md](ci-repair-2026-10-02.md).
