# J2 — Immutable external Actions (2026-10-02)

## Scope

- `.github/workflows/{ci,desktop-build,docker,oss-staging,pages,release,skill-integrity}.yml` and
  `.github/actions/setup/action.yml` — every external ref repinned (45 `uses:` sites);
- `scripts/check-actions-pins.mjs` + `scripts/actions-pins.json` — the policy scanner and its
  allow-list, new;
- `scripts/check-actions-pins.test.mjs` + `scripts/fixtures/actions-pins/` — 9 fixtures and the
  cases that drive them, new;
- `package.json` (`check:actions-pins`), `.github/workflows/ci.yml` (the gate step),
  `.github/workflows/skill-integrity.yml` (an explicit read-only permission block).

## Baseline — J2.1 inventory

15 distinct external actions across 45 call sites; every one was a mutable tag, and only the
aliyun action was already SHA-pinned (with no release comment). Local `./.github/actions/setup`
was and remains a relative ref. There are no `docker://` action images.

| # | owner/action | was | pinned commit | release | uses |
| - | ------------ | --- | ------------- | ------- | ---- |
| 1 | `actions/checkout` | `@v5` | `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09` | `v5.0.0` | 18 |
| 2 | `actions/setup-node` | `@v5` | `a0853c24544627f65ddf259abe73b1d18a591444` | `v5.0.0` | 5 |
| 3 | `actions/cache` | `@v4` | `0057852bfaa89a56745cba8c7296529d2fc39830` | `v4.3.0` | 2 |
| 4 | `actions/upload-artifact` | `@v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `v4.6.2` | 3 |
| 5 | `actions/download-artifact` | `@v4` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | `v4.3.0` | 1 |
| 6 | `actions/upload-pages-artifact` | `@v3` | `56afc609e74202658d3ffba0e8f6dda462b719fa` | `v3.0.1` | 1 |
| 7 | `actions/deploy-pages` | `@v4` | `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` | `v4.0.5` | 1 |
| 8 | `pnpm/action-setup` | `@v6` | `0977fd99725f1db4007ccb2928dbb4e90d06cc86` | `v6` | 4 |
| 9 | `docker/setup-buildx-action` | `@v3` | `8d2750c68a42422c14e847fe6c8ac0403b4cbd6f` | `v3.10.0` | 2 |
| 10 | `docker/build-push-action` | `@v6` | `10e90e3645eae34f1e60eeb005ba3a3d33f178e8` | `v6.18.0` | 2 |
| 11 | `docker/setup-qemu-action` | `@v3` | `c7c53464625b32c7a7e944ae62b3e17d2b600130` | `v3.6.0` | 1 |
| 12 | `docker/login-action` | `@v3` | `c94ce9fb468520275223c153574b00df6fe4bcc9` | `v3.4.0` | 1 |
| 13 | `docker/metadata-action` | `@v5` | `c299e40c65443455700f0fdfc63efafe5b349051` | `v5.8.0` | 1 |
| 14 | `softprops/action-gh-release` | `@v3` | `efb35369e0ad2afab669f228072c1b0d510eae64` | `v3` | 1 |
| 15 | `aliyun/configure-aliyun-credentials-action` | SHA (no comment) | `1e5248c8d5d93a8781ac344a68e19a43341e79e6` | `v1.1.0` | 2 |

Every mapping was produced by dereferencing the tag through the GitHub API
(`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, and `git/tags/<sha>` again when the tag is
annotated), and recorded per action in `scripts/actions-pins.json` with the command that verified
it. The one pre-existing SHA pin was matched to its tag the same way (its tag list shows
`refs/tags/v1.1.0` at that exact commit).

## Change

1. **J2.2 — pins.** All 45 external `uses:` sites now carry the full 40-character commit plus a
   readable `# vX.Y.Z` release comment. Local actions, functional inputs (`with:`, `env:`,
   `if:`) and every existing permission are byte-identical apart from the ref: `git diff` over
   `.github/` removes nothing but `uses:` lines (audited mechanically — see Verification).
2. **J2.3 — scanner + allow-list.** `scripts/check-actions-pins.mjs` enforces, in order: local
   `./` actions are fine; an external ref must be a full lowercase 40-hex commit; it must carry a
   release comment; and it must match the allow-list entry for that repository exactly. It also
   polices permissions: a workflow without a `permissions:` block fails (the grant would come from
   repository settings, not the file), `write-all` always fails, and a `*: write` scope fails
   unless the allow-list names it for that workflow. Composite actions are scanned for refs but
   not permissions (they inherit the caller's grant).
3. **J2.4 — fixtures + gate.** `scripts/fixtures/actions-pins/` holds the card's named negatives as
   real files — mutable tag, unknown owner/action, malformed SHA, missing release comment, nested
   composite ref, permission expansion, `write-all`, implicit permissions — plus one control
   fixture that must pass. `ci.yml` runs the scanner and the fixture cases in the `checks` job,
   next to the documentation-claims gate.

## Acceptance — the named negatives

| Negative (card) | Fixture | Scanned result |
| --------------- | ------- | -------------- |
| mutable tag | `mutable-tag.yml` (`actions/checkout@v5`) | `ref "v5" is not a full 40-character commit SHA` |
| malformed SHA | `malformed-sha.yml` (`@fbc6f399`) | `ref "fbc6f399" is not a full 40-character commit SHA` |
| unknown owner/action | `unknown-owner.yml` (`evil/typosquat@<40hex>`) | `repository "evil/typosquat" is not in the allow-list` |
| nested composite ref | `nested-composite/action.yml` (`actions/cache@v4`) | `ref "v4" is not a full 40-character commit SHA` |
| permission expansion | `permission-expansion.yml` (`id-token: write` undeclared) | `"id-token: write" is not declared for permission-expansion.yml in the allow-list` |
| permission expansion (extreme) | `write-all.yml` (`permissions: write-all`) | `write-all grants every scope` |
| implicit grant | `implicit-permissions.yml` (no block) | `no explicit permissions block: the workflow would inherit the repository default` |
| control | `pinned-ok.yml` | passes both the ref and the permission policy |

Pins map to actual upstream commits (table above) and hide no functional or permission change:
the only permission edit in this package is the *tightening* of `skill-integrity.yml` from an
implicit grant to an explicit `contents: read`.

## Verification

```
node scripts/check-actions-pins.mjs
→ actions pins: 45 pinned, 12 local, 0 docker images, 6 allow-listed write scope(s), 0 violation(s)

node --test scripts/check-actions-pins.test.mjs
→ # tests 15  # pass 15  # fail 0

actionlint (npm actionlint@2.0.6, WASM build, run locally with the CI recipe's `-shellcheck=`)
→ ci, desktop-build, docker, oss-staging, pages, release, skill-integrity, setup: 0 errors

yaml parse of all 7 workflows + the composite action
→ clean (no `errors` on any document)

git diff audit over .github/: every removed line is a `uses:` line
→ no comment, input, condition or permission was altered by accident
```

The CI step runs the native `actionlint` v1.7.12 exactly as the pre-existing recipe declares
(`./actionlint -shellcheck=`), which is unchanged by this package.

## Compatibility / update procedure

- **Revert one pin** only on evidenced upstream breakage: restore the previous commit and its
  comment in the workflow, update the allow-list entry in the same PR, and say what broke in the
  commit message. The policy — full SHA + release comment + allow-list — stays.
- **Update** an action: `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (dereference annotated
  tags through `git/tags/<sha>`), replace the pin and comment in every call site, update
  `scripts/actions-pins.json` (tag, commit, verification note), then run the scanner and the test.
- **Add a new action**: same steps; until the allow-list has an entry, the scanner rejects it by
  design. That is the "explicit allow policy" rather than trusting SHA-shaped text.
- **Add a write scope**: add it to `permissions.writeScopes` for that workflow with a reason.
  Widening a grant is now a reviewed diff line, not a side effect.

## Residual work

- `release-assets.githubusercontent.com` is unreachable from this sandbox, so the native
  `actionlint` binary could not be downloaded here; the local receipt uses the WASM build of
  actionlint (npm `actionlint@2.0.6`, same program) and CI runs the pinned native v1.7.12. The two
  agree on the fixtures exercised, but only CI's run is authoritative.
- The allow-list is updated by hand. If Dependabot is enabled later, it must be configured to pin
  SHAs, or its `@vN`-style PRs will fail this gate — which is the intended outcome, and noted here
  so the first such PR is understood rather than reverted.
- `scripts/check-actions-pins.mjs` reads `permissions:` line-wise and does not model `${{ }}`
  expressions inside a scope value. GitHub does not accept expressions there, so the parse is
  exact for the construct; a future workflow that tries one will fail `actionlint` first.
