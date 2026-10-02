# G4 — Patch and supersession ledger (2026-10-02)

Two artifact families in `.agents/skills` looked ambiguous: 57 `local.patch` files whose
filename says nothing about whether the patch is applied or pending, and 14
`SKILL.superseded.md` sidecars whose "superseded" status is only meaningful if the redirect
resolves. G4 asks for one explicit disposition per artifact, a resolution proof for every
retained supersession, and removals only where unused copies are *proved* dead.

The ledger is `scripts/skills/patch-ledger.mjs`; the versioned table is
`artifacts/skill-patch-ledger.json` (regenerate with `--json`). The gate is
`node scripts/skills/patch-ledger.mjs --check`, which exits non-zero on any artifact that is
neither applied, pending, nor resolving.

## G4.1 — Inventory and dispositions

| Family | Count | Disposition |
| ------ | ----- | ----------- |
| `local.patch`, applied (patch reverses cleanly) | 56 | **retain**: stale record of an already-applied localization |
| `local.patch`, pending (patch applies forward) | 1 — `.agents/skills/db2-rhel/local.patch` | **retain**: live patch, verified to apply to this base |
| `local.patch`, unresolved (neither direction) | 0 | — |
| `SKILL.superseded.md` sidecars | 14 | **retain**: deliberate supersession, redirect + alias resolve |
| Ambiguous artifacts | **0** | — |

Each row records the skill, the artifact path, the state, the target files named by the diff, the
files that reference it outside its own skill directory, and the disposition. The classification
is a dry run, never a guess: `patch --dry-run -R -p2` proves "already applied" and
`patch --dry-run -p2` proves "still applies" — a patch that does neither is reported as
`unresolved` and fails `--check`.

Base revision: the working tree at the ledger commit; each patch's own headers declare no
revision (`2000-01-01` timestamps, `--- a/<skill>/…` prefixes relative to the skill directory),
so the base is recorded as the ledger's `generatedAt` plus the Git revision the ledger ran
against. That is the honest statement of identity here: these are localization records, not
upstream-tracking patches, and the tree they were made against is recoverable from Git
(`git log -p -- .agents/skills/<skill>`).

### External references

`git grep -F <path>` (excluding each patch's own skill directory) finds **zero** external
references for all 57 patches: nothing sources, includes, configures or resolves a `local.patch`
at runtime. They are provenance records, not build inputs.

## G4.2 — Retain, do not remove

Every artifact is retained, and the reason is recorded per row rather than left implicit:

- The 56 applied patches are the only record of what was localized in each upstream skill. They
  are not referenced, but "unreferenced" is not "dead" — their purpose is to explain the current
  content of the skill files to a future maintainer (and to make re-syncing from upstream
  reviewable).
- The one pending patch (`db2-rhel`) is live: it still applies to this base, and removing it
  would lose a localization that has not been written into the tree yet.
- The 14 sidecars are the verbatim originals of consolidated skills; the consolidation mechanism
  (`scripts/skills/consolidate.mjs`) requires them (`verify-consolidations.mjs` fails when a
  sidecar is missing).

**Removal decision (recorded, not deferred):** no artifact is removed in this package. The
repository's own rule is that consolidation deletions are human-reviewed, and the value of these
files is provenance rather than load. A removal would trade a small repository-size win for the
loss of the only localization record; that trade is not worth making unilaterally. Reopen
condition: if a future packager needs the skill corpus without provenance, the ledger already
gives the exact candidate set (`applied` + zero references) and the Git revision each file can be
recovered from.

## G4.3 — Resolution and applicability proofs

**Each retained skill resolves once.** For every sidecar the ledger checks three things, and any
one failing marks the row `escalate` (and fails `--check`):

| Superseded skill | Canonical | Redirect matches | Canonical exists | Alias registered |
| ---------------- | --------- | ---------------- | ---------------- | ---------------- |
| animations-emil-design-eng | emil-design-eng | ✅ | ✅ | ✅ |
| animations-review-animations | review-animations | ✅ | ✅ | ✅ |
| codex-linear | linear | ✅ | ✅ | ✅ |
| codex-security-best-practices | security-best-practices | ✅ | ✅ | ✅ |
| codex-security-ownership-map | security-ownership-map | ✅ | ✅ | ✅ |
| codex-security-threat-model | security-threat-model | ✅ | ✅ | ✅ |
| codex-vercel-deploy | deploy-to-vercel | ✅ | ✅ | ✅ |
| minimax-android-native-dev | android-native-dev | ✅ | ✅ | ✅ |
| minimax-fullstack-dev | fullstack-dev | ✅ | ✅ | ✅ |
| minimax-gif-sticker-maker | gif-sticker-maker | ✅ | ✅ | ✅ |
| minimax-ios-application-dev | ios-application-dev | ✅ | ✅ | ✅ |
| minimax-pptx-generator | pptx-generator | ✅ | ✅ | ✅ |
| minimax-react-native-dev | react-native-dev | ✅ | ✅ | ✅ |
| minimax-shader-dev | shader-dev | ✅ | ✅ | ✅ |

Cross-checked against the existing corpus gate: `artifacts/skill-consolidations.json` is the
plan of record and `scripts/skills/verify-consolidations.mjs` asserts the same three properties
from the other direction (it reads the plan and fails on a missing canonical, a missing sidecar
or a redirect that does not resolve through the alias table). The ledger and that verifier agree
on all 14.

**Each live patch still applies to its declared base.** The single pending patch,
`.agents/skills/db2-rhel/local.patch` (targets `install-admin.md`,
`security-backup-recovery.md`), dry-runs clean forward with `patch -p2` from its skill
directory; the ledger's `pending` state for it *is* that proof, reproduced on every run.

**Each removal is recoverable through Git.** No removal is made here; for the recorded candidate
set, recovery is `git checkout <revision> -- <path>` from a tracked-file history, which `--check`
cannot quietly invalidate because it never deletes.

## Verification

```
node scripts/skills/patch-ledger.mjs              # table + summary; 0 ambiguous
node scripts/skills/patch-ledger.mjs --check       # exit 0
node scripts/skills/patch-ledger.mjs --json > artifacts/skill-patch-ledger.json
node scripts/skills/verify-consolidations.mjs      # (existing corpus gate; see residual)
```

## Residual work

- `scripts/skills/verify-consolidations.mjs` imports its helper with a hardcoded Windows path
  (`file:///D:/GitHub/penguin-harness-fork/scripts/skills/lib.mjs`), so it cannot run on
  Linux/macOS CI as written. The ledger validates the same consolidation invariants from the
  repository root, which is why G4 could be completed without it; repairing that import belongs
  to the skill-integrity workstream (G1/G3) and is recorded here rather than silently patched.
- The ledger is not yet wired into `skill-integrity.yml`; G1.3 owns CI integration. The `--check`
  mode is the intended hook.
