# Wave 1 acceptance reconciliation — 2026-10-05

Baseline: `9472091d6` (`codex/pr-15-review-fixes`, PR #15 head). Scope: the five Wave 1 rows the task
register carried as IMPLEMENTED — F1, F3, F6, G5, J11 — plus a re-check of G7's N/A disposition.

Every verdict below cites a file, line, or command observed on this revision.

## What ran

| Check | Command | Result |
| --- | --- | --- |
| Web unit suite | `packages/web` → `vitest run` | 213 files, **2598 passed** |
| Docs-claims gate | `node scripts/check-doc-claims.mjs` | `Documentation status claims have valid paths and runtime evidence.` (exit 0) |
| Docs-claims fixtures | `node --test scripts/check-doc-claims.test.mjs` | 1 passed — `same-package runtime calls pass; unused imports and broken evidence fail` |
| G5 TLS matrix | purpose-built harness against the real downloader | see [G5](#g5--tls-verification-fix) |

## Criterion reconciliation

### F1 · Input focus rings — remains IMPLEMENTED

All three edit groups are present in source:

| Site | Evidence |
| --- | --- |
| `components/ui/input.tsx:135-141` | `menuSearchClass` and `panelSearchClass` both carry `focus-visible:ring-2 focus-visible:ring-[var(--accent-bg)]`; the panel class also changes its border |
| `features/guardian/rule-policy-editor.tsx:125` | `focus-visible:ring-2 focus-visible:ring-[var(--accent-bg)]` replaces `focus:ring-0` |
| `components/ui/field.tsx:20,22` | `controlBase` ring, plus the dark variant |

One deviation from the card, recorded rather than papered over: the card specified
`ring-[var(--accent-bg)]/50`, the code ships a **solid** ring. That is a strengthening, not a
shortcut, and the accessibility audit states the change explicitly
(`docs/audits/web-accessibility-2026-09-30.md:56`).

The R12 evidence is real: five surfaces, zero axe violations, zero missing visible focus, and full
keyboard coverage in both themes (`web-accessibility-2026-09-30.md:61-67`) — 43/43 chat+sidebar,
27/27 system settings, 22/22 mobile.

**Why this row does not close.** That same audit ends with
"This is local worktree evidence; it is not a new exact-head CI receipt" (line 73), and no workflow
job exercises accessibility — `grep -rn a11y .github/workflows/*.yml` returns nothing. The card's
acceptance is met by a dated browser audit; the register's exact-head gate cannot be discharged by
CI as the pipeline currently stands. Closing it needs one decision, not more analysis: add a
Playwright `a11y.spec.mjs` job to CI, or accept the 2026-10-01 audit as final evidence. The first
costs a Chromium install and a long-running job; the second is a judgement call that belongs to the
owner, not to this pass.

### F3 · Comment-lies, dead code, cockpit rename — VERIFIED

| Sub-task | Evidence |
| --- | --- |
| Correct the `/usage` access comment | `router.tsx:427-433` now names the real gate (`requireProjectAccess` on `projectId`, with the genuinely cross-tenant part admin-gated inside the handler) and records that the previous "admin-only server-side (403 otherwise)" claim was false in both halves |
| Remove the phantom-route claim | `lib/nav-group-collapse.ts:58-63` retracts it with specifics — `router.tsx` has no `/machines`, the catch-all sends it to `/chat`, nothing imports `MachinesPage` |
| Delete `features/canvas/` | the directory is gone; zero live importers |
| Rename `features/cockpit/` → `features/cockpit-widgets/` | `features/cockpit-widgets` exists and no source file references the old `features/cockpit/` path |

No touched comment contradicts behaviour, compilation and the affected web flows are covered by the
2598-test run, and the human deletion review the card requires predates this push and is recorded in
the register.

### F6 · STREAM_BANNER_FRAME — VERIFIED

Exactly one definition, at `features/chat/disclosure-row.tsx:101`. Exactly six consumers:

`attached-files-banner.tsx` · `goal-banner.tsx` · `handoff-banner.tsx` · `org-trigger-banner.tsx` ·
`scheduled-banner.tsx` · `skills-banner.tsx`

Each keeps its own layout/animation prefix (`anim-msg my-2 flex w-fit`, `anim-fade mb-2 flex`, …) and
appends the shared frame, which is what the card specifies. The three interactive disclosure surfaces
— `harness-banner`, `mcp-connect-banner`, `step-banner` — do not reference the token, so their
contracts are untouched.

### G5 · TLS verification fix — VERIFIED

The bypass inventory is clean. Four `rejectUnauthorized` hits remain under `.agents/`, and none is an
executable bypass:

| Path | Content | Why it is not a bypass |
| --- | --- | --- |
| `skills/bgm-library/scripts/downloader.js` | none | uses global `fetch` (line 41); custom roots documented via `NODE_EXTRA_CA_CERTS` (line 9) |
| `skills/codex-render-deploy/references/configuration-guide.md:348` | `rejectUnauthorized: true : false` | documentation snippet that *enables* verification in production |
| `skills/dashboard-builder/DATA_INTEGRATION.md:174` | same shape | documentation snippet |
| `skills/elasticsearch-esql/local.patch:71`, `skills/elasticsearch-file-ingest/local.patch:11` | `-config.tls = { rejectUnauthorized: false };` | the `-` prefix means the patch **deletes** the bypass |

G5.3 asked for three demonstrated outcomes. The first was already recorded; the other two were
proven this pass by driving the real `downloadTrack()` against a self-signed HTTPS origin:

| Outcome | Environment | Observed |
| --- | --- | --- |
| Normal HTTPS succeeds | default trust | `https://example.com/` → `200` |
| Invalid certificate is refused | default trust, self-signed cert | **refused** — `DEPTH_ZERO_SELF_SIGNED_CERT` |
| Custom trust root works | `NODE_EXTRA_CA_CERTS=cert.pem` | **downloaded** — 960 bytes, byte-exact |

That is the full acceptance sentence: validation stays on by default, custom roots enter only through
`NODE_EXTRA_CA_CERTS`, and the CLI's Axios client is a separate surface this change never touched.

### J11 · Docs claim consistency gate — VERIFIED

The gate is real, wired, and green:

- `scripts/check-doc-claims.mjs` → `Documentation status claims have valid paths and runtime evidence.`
- `scripts/check-doc-claims.test.mjs` proves both directions in one case: a same-package runtime
  consumer passes while unused imports and broken evidence fail.
- `ci.yml:54-55` runs the checker *and* its fixture test on every push; the job was green on
  `9472091d6`. That is the exact-head receipt this row was waiting on.
- `docs/status-ledger.json` holds 6 claims — 2 `Shipped`, 4 `Experimental/unconsumed`. The checker
  accepts both statuses, which is what the card requires of R7's Option B: experimental and
  unconsumed is an honest distinct status, not a synonym for shipped.

## G7 · Anti-slop installer — N/A disposition re-confirmed

The applicability evidence still holds at this revision: no `install.mjs` anywhere in the repo, no
`rules-src/`, no `assets/anti-slop/`. The active plugin tree is `tools/oxlint/anti-slop/` with
`rules/`. The disposition stays N/A with its reopen condition (re-audit if the vendored skill is ever
restored). Nothing was fabricated to fill the gap, which is the point the card makes.

## What this receipt does not establish

- **F1** has no exact-head accessibility receipt, and no CI job can produce one today.
- The CLI Axios client is preserved by construction — no change touched it — but it was not
  separately exercised.