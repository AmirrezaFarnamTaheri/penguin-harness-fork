# Infra / CI / Docs / Packaging — bug-swarm findings

Domain: build, CI, Docker, installers, scripts, docs, plugin packaging. Everything below was
verified against the working tree at HEAD `26d60a00f` (v0.2.16) plus the untracked
`plugins/language-porting/` feature. Read-only checks were run where they exist:
`node scripts/check-i18n.mjs` → **passes** ("i18n parity check passed"); `node scripts/skills/audit.mjs
--check` → **passes** ("Skills: 2567; aliases: 250; errors: 0; warnings: 0"); `bash -n install.sh` and
`sh -n install.sh` → **OK**; `node scripts/gen-ifaces.mjs --project packages/server/tsconfig.json`
writes **0 interfaces, 0 types** (correct — `grep -c '@Module|@Component' packages/server/src` is 0);
`gen-ifaces` on core's tsconfig errors loudly and exits 1 (real, not silent); `node
scripts/verify-benchmark-data.mjs` exits 1 with `[MISSING_PROVENANCE] DATA_BENCH/CODE_BENCH`.

The dominant theme: **the release path is broken and nothing notices**. The npm publish step cannot
run today without dying mid-loop, and three of the last four releases are in fact absent from npm.
The second theme is the `language-porting` feature being packaging-incomplete in exactly the places
no test looks: it is absent from the one field the Electron app enumerates plugins from, and it is a
brand-new npm package that this repo's own workflow cannot first-publish.

---

### [CRITICAL] release.yml's npm publish loop dies on any plugin whose package name is not `@penguinharness/<dir>`
- File: `.github/workflows/release.yml:664-672` (loop), `:636-639` (registry query)
- Symptom: `for dir in plugins/*/; do name="@penguinharness/$(basename "$dir")"` assumes every
  directory under `plugins/` publishes under the `@penguinharness` scope. The four `sandbox-*`
  directories do not — their real names are `@prismshadow/penguin-plugin-sandbox-{bwrap,dsh,mxc,seatbelt}`,
  all `"private": true`. `npm view @penguinharness/sandbox-bwrap` answers E404, which makes
  `package_version_exists` return 2, and the loop's error arm `exit`s the whole step before
  `@prismshadow/penguin-{core,server,cli}` are ever reached (they publish after the plugin loop by
  design, line 675). A 404 is a registry failure, not a "version absent", and it is treated as fatal.
- Evidence:
  ```yaml
  for dir in plugins/*/; do
    name="@penguinharness/$(basename "$dir")"
    if package_version_exists "$name" "$V"; then
      ...
    else
      status="$?"
      [ "$status" -eq 1 ] || exit "$status"     # <- 404 → status 2 → step dies
    fi
  ```
  Reproduced verbatim against the live registry (`sh` extract of the loop, `V=0.2.16`):
  `WOULD EXIT 2 here (dir=plugins/language-porting/ name=@penguinharness/language-porting)`,
  script exit 2 — and with the feature's dir absent, the first casualty is
  `plugins/sandbox-bwrap/`. Corroborating registry state: `npm view @prismshadow/penguin-cli
  versions` tops out at **0.2.13**; `@penguinharness/agent-company` likewise has only **0.2.13**.
  v0.2.14, v0.2.15 and v0.2.16 were never published to npm, and `plugins/sandbox-bwrap` was already
  `@prismshadow/penguin-plugin-sandbox-bwrap` + private at v0.2.13.
- Fix: iterate the actual package names instead of constructing them — e.g. `node -e` emitting
  `name` from each dir's `package.json`, skip `private: true` packages, and only then fall back to
  the `@penguinharness/$(basename "$dir")` spelling. Separately, distinguish "registry lookup failed"
  (return 2, hard stop) from "package or version absent" (return 1, proceed) by testing the E404
  shape rather than the exit code of `npm view`.
- Confidence: high

---

### [HIGH] The `language-porting` feature is missing from the one field the desktop app enumerates plugins from
- File: `packages/desktop/package.json:19-32` (omission); `packages/core/package.json:87` (added)
- Symptom: the feature added `@penguinharness/language-porting` to **core's** dependencies and to the
  loader's expectations (`packages/core/test/plugins.test.ts:41` 14→15 plugins), but not to
  **desktop's**. Desktop is the package whose `dependencies` is the plugin enumeration source for the
  packaged Electron app, so the installer will not carry the new plugin — and no check can notice,
  because both the preflight and the packed-tree verifier derive their *expected* list from the same
  field that is missing the entry.
- Evidence:
  ```jsonc
  // packages/desktop/package.json — 14 entries, no language-porting
  "@penguinharness/humanizer": "workspace:*",
  "@penguinharness/model-development": "workspace:*",   // language-porting belongs between these two
  ```
  ```js
  // packages/desktop/scripts/preflight.mjs:30-33   — checks every DECLARED @penguinharness/* dep
  ...Object.keys(pkg.dependencies)
    .filter((dep) => dep.startsWith("@penguinharness/"))
    .map((dep) => [`the plugin package ${dep}`, `node_modules/${dep}/plugin.json`]),
  ```
  ```js
  // packages/desktop/scripts/verify-packed-cli.mjs:27-30
  /** The plugin packages the bundled loader will look for: every @penguinharness/* in this package's dependencies (the one field the packaged manifest keeps). */
  const pluginNames = Object.keys(ownPkg.dependencies ?? {}).filter((name) =>
    name.startsWith("@penguinharness/"),
  );
  ```
  `packages/desktop/electron-builder.yml:5`: *"The one dependency tree electron-builder collects is
  the @penguinharness/* plugin packages this package.json declares."* The tests that do cover the
  feature (`plugins.test.ts`) call `loadLibraryPlugins()`, which scans `plugins/` off disk in the
  repo — a different enumeration path from the packed app, so they stay green.
- Fix: add `"@penguinharness/language-porting": "workspace:*"` to
  `packages/desktop/package.json` `dependencies` (alphabetically between `humanizer` and
  `model-development`), matching the 14 existing entries, and regenerate `pnpm-lock.yaml`.
- Confidence: high

---

### [HIGH] `@penguinharness/language-porting` is a new npm package this repo's workflow cannot first-publish
- File: `.github/workflows/release.yml:24-34` (checklist comment), `:520` (`if:` guard), `:673`
- Symptom: the feature ships a never-published plugin package. `npm view @penguinharness/language-porting`
  answers E404. The workflow documents that OIDC Trusted Publishing can only be configured for a
  package that *already exists*, so the next tag push hits this before the bootstrap has happened —
  and per the CRITICAL finding above, the failure is now a hard `exit 2` that also blocks
  core/server/cli.
- Evidence:
  ```
  $ npm view @penguinharness/language-porting versions --json
  npm error code E404 ... The requested resource '@penguinharness/language-porting@*' could not be found
  ```
  ```yaml
  # .github/workflows/release.yml:26-30
  # A Trusted Publisher can only be configured in the settings page of a package that ALREADY
  # EXISTS on the registry, so a brand-new package cannot be first-published by this workflow.
  ```
- Fix: before the next tag, bootstrap-publish `@penguinharness/language-porting` once with a
  one-off granular token (the workflow's own checklist), then configure it as a Trusted Publisher.
  This is documentation of a known manual step, not a code bug — but the feature is not
  release-ready without it, and it is invisible to every test in the repo.
- Confidence: high

---

### [HIGH] Tag-pinned third-party actions in the release workflow (SHA pinning applied to only one)
- File: `.github/workflows/release.yml:403` (`softprops/action-gh-release@v3`), `:120` (`pnpm/action-setup@v6`),
  `:122` (`actions/setup-node@v5`), `:347` (`actions/download-artifact@v4`); also
  `desktop-build.yml`, `docker.yml`, `pages.yml`, `ci.yml` throughout
- Symptom: the workflow that creates an *immutable* Release using the run's `contents: write` token
  depends on third-party actions pinned to moving tags. The repo already demonstrates the
  alternative it wants — `aliyun/configure-aliyun-credentials-action@1e5248c8d5d93a8781ac344a68e19a43341e79e6`
  is SHA-pinned — but applies it to exactly one action. A tag can be repointed by its maintainer
  (or a compromised account) after review, and `action-gh-release` is the one that publishes the
  assets users install.
- Evidence:
  ```yaml
  - name: Publish GitHub Release
    uses: softprops/action-gh-release@v3          # moving tag
  ...
  uses: aliyun/configure-aliyun-credentials-action@1e5248c8d5d93a8781ac344a68e19a43341e79e6   # SHA
  ```
- Fix: pin every third-party action in `release.yml` (and `desktop-build.yml`) to a full commit SHA
  with the version recorded in a comment; keep the one Aliyun pin as the pattern. Consider
  `renovate`/`dependabot` to keep the SHAs current.
- Confidence: medium

---

### [HIGH] CI test shards run several packages in ONE pnpm invocation, so the first failure masks the rest
- File: `.github/workflows/ci.yml:92-97` (ubuntu `rest`), `:152-156` (macOS `rest`), `:199-203` (Windows `rest`), `:90-92` (`web-cli`)
- Symptom: the caller's `pnpm -r test` blind spot is not confined to the root script — it is baked
  into the shard matrix. The `rest` shards pass two to six package filters to a single `pnpm test`
  invocation, and pnpm stops at the first package whose script fails. A red `desktop` suite
  therefore hides every `landing` and `docs` failure (and on macOS/Windows, everything outside
  core/server). `web-cli` has the same shape for `web` + `cli`.
- Evidence:
  ```yaml
  # ci.yml:93-97 — one invocation, three packages
  - shard: rest
    build: "@prismshadow/penguin-desktop..."
    tests: >-
      pnpm --filter @prismshadow/penguin-desktop --filter @prismshadow/penguin-landing
      --filter @prismshadow/penguin-docs test
  # ci.yml:152-156 / 199-202 — one invocation over every package except core and server
  tests: >-
    pnpm -r --filter '!@prismshadow/penguin-core' --filter '!@prismshadow/penguin-server' test
  ```
  Contrast the single-package shards (`:86`, `:89`, `:146`, `:150`, `:189`), which are one package
  per invocation and have no blind spot.
- Fix: emit one `pnpm --filter <pkg> test` per package in the shard (a generated step list, or a
  small runner script that records each package's exit code and re-exits non-zero at the end), or
  run the multi-filter form under `pnpm -r --workspace-concurrency=1` with `--continue-on-error`
  semantics pnpm does not natively provide.
- Confidence: medium

---

### [MEDIUM] Every plugin's `files` allowlist declares entries that do not exist on disk
- File: all 15 `plugins/*/package.json` `files` arrays (e.g. `plugins/language-porting/package.json:14-21`)
- Symptom: each content plugin declares `"files": ["plugin.json","icon.svg","skills","hooks","LICENSE"]`.
  13 of the 15 have no `hooks/` directory and none has a `LICENSE` file; `continual-learning` and
  `goal` (the two hook plugins) have `hooks/` but no `skills/`. npm does not error on a `files`
  entry that is absent — it silently ships nothing for it — so the published tarball carries no
  license even though the allowlist claims one. (CI publishes anyway because `release.yml:657-659`
  `cp LICENSE "$dir/LICENSE"` into each `plugins/*/` immediately before publishing; a local
  `pnpm pack` or `pnpm publish` from a checkout does not.)
- Evidence (mechanical sweep over `plugins/*/`):
  ```
  === agent-company ===        MISSING files-entry: "hooks"  MISSING files-entry: "LICENSE"
  === continual-learning ===   MISSING files-entry: "skills" MISSING files-entry: "LICENSE"  NO skills/ dir
  === goal ===                 MISSING files-entry: "skills" MISSING files-entry: "LICENSE"  NO skills/ dir
  ... (identical for all 15 content plugins; "LICENSE" absent in all 15)
  ```
  `plugins/language-porting` — the feature under audit — conforms exactly to this broken invariant:
  it declares `hooks` and `LICENSE` it does not have, and has no defect the other 14 do not.
- Fix: generate `files` per plugin from what the directory actually contains (or drop `hooks`/`LICENSE`
  from the 13 and `skills` from the 2), and make the root LICENSE copy a committed per-plugin file so
  the allowlist is truthful locally as well as in CI.
- Confidence: high

---

### [MEDIUM] Six plugins omit `description_zh`, so Chinese users see the English blurb
- File: `plugins/{data-analysis,humanizer,skill-porting,use-bento-slides,use-claude-code,use-firecrawl}/plugin.json`
- Symptom: the manifest field is optional (`packages/core/src/plugins/index.ts:32` `description_zh?: string`),
  9 of the 15 plugins supply it, and 6 do not — including `skill-porting`, which is the closest
  sibling of the new `language-porting` plugin. The Chinese plugin catalog and the Web UI's plugin
  listing fall back to English for those six. The feature itself is compliant:
  `plugins/language-porting/plugin.json` has both `description_zh` and `short_description_zh`.
- Evidence:
  ```
  === data-analysis ===   MISSING plugin.json field: description_zh
  === humanizer ===       MISSING plugin.json field: description_zh
  === skill-porting ===   MISSING plugin.json field: description_zh
  === use-bento-slides === MISSING plugin.json field: description_zh
  === use-claude-code ===  MISSING plugin.json field: description_zh
  === use-firecrawl ===    MISSING plugin.json field: description_zh
  ```
- Fix: either require `description_zh` in the loader (and add the six) or add the six translations
  to reach parity with the other nine.
- Confidence: high

---

### [MEDIUM] `pnpm-workspace.yaml` documents a script that does not exist
- File: `pnpm-workspace.yaml:3-6`
- Symptom: the comment explaining why `plugins/*` sits at the top level names
  `scripts/build-plugins.mjs` as the thing that ships plugins. No such file exists anywhere in the
  repo and nothing references it. Whoever reads this comment to understand plugin packaging is
  pointed at a deleted script.
- Evidence:
  ```yaml
  # them is scripts/build-plugins.mjs, which packs each self-contained.
  ```
  ```
  $ ls scripts/build-plugins.mjs
  ls: cannot access 'scripts/build-plugins.mjs': No such file or directory
  $ grep -rn "build-plugins" . --exclude-dir=node_modules   # one hit: the comment above
  ```
- Fix: reword to describe the real mechanism (`electron-builder` collecting desktop's
  `@penguinharness/*` deps; `release.yml`'s `plugins/*/` publish loop), or restore the script.
- Confidence: high

---

### [MEDIUM] The public interface catalog is generated from the one package that has no interfaces
- File: `package.json:44-46` (`gen:ifaces`, `ifaces:page`), `.github/workflows/pages.yml`
- Symptom: `gen:ifaces` is wired to `packages/server/tsconfig.json` only, and the server genuinely
  projects nothing — `grep -c '@Module|@Component' packages/server/src` = 0, so the generated
  `packages/server/src/ifaces.json` is legitimately `{"ifaces":{},"types":{},"modules":{}}` and
  `iface-page.mjs` renders "0 nodes, 0 interfaces". The packages that *do* declare kernel modules
  are core (6 hits) and the plugin packages, but `gen-ifaces.mjs` on core's tsconfig hard-fails on
  duplicate module classes in `packages/core/test/kernel-modules.test.ts`, so core cannot be the
  source either. Net effect: the published interface documentation is empty and nothing in CI
  catches it — `ifaces:page` is not invoked by any workflow (`grep -rn "ifaces:page" .github` → none).
- Evidence:
  ```
  $ node scripts/gen-ifaces.mjs --project packages/server/tsconfig.json --out /tmp/ifaces-server.json
  gen-ifaces: wrote .../ifaces-server.json (0 interfaces, 0 types)
  $ node scripts/iface-page.mjs --in packages/server/src/ifaces.json --out /tmp/ifaces-page
  iface-page: wrote .../index.html + ifaces.json (c78b52872e2d, 0 nodes, 0 interfaces)
  $ node scripts/gen-ifaces.mjs --project packages/core/tsconfig.json --out /tmp/ifaces-core.json; echo exit=$?
  gen-ifaces: error: packages\core\test\kernel-modules.test.ts: module 'SchedulerModule' is defined twice
  gen-ifaces: error: packages\core\test\kernel-modules.test.ts: module 'PlatformModule' is defined twice
  exit=1
  ```
  (The generator's own exit code is correct — the failure is loud, not silent.)
- Fix: either point `gen:ifaces` at the packages that actually declare modules (excluding test
  files from the tsconfig `include`, or scoping the generator to `src`), or drop the empty
  `ifaces:page` script and the page it produces. If kept, wire it into `pages.yml`.
- Confidence: medium

---

### [MEDIUM] `.dockerignore` leaks ~6.4 MB of dev/audit artifacts into every build context
- File: `.dockerignore` (whole file), `Dockerfile:106` (`COPY . .`)
- Symptom: the build stage copies the entire working tree. `.dockerignore` excludes dependencies and
  build output, but not the repository's audit/porting debris nor `artifacts/` — which is 4.8 MB of
  tracked screenshots and 46 tracked files written by the skill-integrity workflow. Several
  `.gitignore` entries (`cache/`, `dist-ifaces/`, `/_port_staging`, `.serena/`, `.cocoindex_code/`)
  have no `.dockerignore` counterpart, so a developer's dirty tree silently changes what the image
  builds from. `.gitattributes` and `.github` are correctly excluded.
- Evidence:
  ```
  4.8M  artifacts/                    # tracked, NOT excluded
  496K  2026-09-17-hport-porting-master-plan.md
  360K  AGORA_Master_Specification_Engineering_Final.md
  340K  hport-existing-exports.txt
  116K  porting_progress.json  ...    total 6.4M
  $ for d in artifacts out dist-artifacts payloads dist-ifaces cache; do git check-ignore -q "$d" \
      && echo IGNORED || echo NOT-gitignored; done     # all NOT-gitignored; none dockerignored
  ```
- Fix: add `artifacts/`, `out/`, `payloads/`, `dist-artifacts/`, `dist-ifaces/`, `cache/`, the
  `hport-*`/`plan-*.txt`/`*-Master-*.md` audit files, `bug-swarm/` to `.dockerignore`, or derive it
  from `.gitignore` plus the build outputs.
- Confidence: high

---

### [MEDIUM] Two verification gates exist as npm scripts but are wired into no workflow
- File: `package.json:14` (`check:i18n`), `package.json:15` (`verify:benchmark-data`);
  `grep -rn "benchmark\|check:i18n" .github/workflows/` → none
- Symptom: `check:i18n` (en↔zh parity for `packages/web/src/lib/strings*.ts`) and
  `verify:benchmark-data` (provenance for the published benchmark claims) are real, correctly
  non-zero-exiting gates — `verify-benchmark-data.mjs` exits 1 with `[MISSING_PROVENANCE] DATA_BENCH`
  and `CODE_BENCH` in this very tree — but nothing in CI ever runs them. A key added to `strings-en.ts`
  and forgotten in `strings-zh.ts`, or an unprovenanced benchmark claim, ships green.
- Evidence:
  ```
  $ node scripts/verify-benchmark-data.mjs; echo exit=$?
  [MISSING_PROVENANCE] DATA_BENCH: No claim-linked run outcomes/scoring ...
  Benchmark integrity BLOCKED (2 errors); no results certified.   exit=1
  $ grep -rn "verify:benchmark-data\|check:i18n" .github/workflows/
  (no output)
  ```
- Fix: add both to the `style` or `typecheck` job in `ci.yml` (they need no build), and decide
  whether the benchmark gate is meant to pass today — if the missing provenance is expected, mark
  the two affected benchmarks as provisional in its own config rather than leaving the gate red
  and unrun.
- Confidence: high

---

### [MEDIUM] `.env.example` does not document the OpenAI/Gemini provider keys the model catalog reads
- File: `.env.example:1-12`; `packages/core/src/state/model-catalog.ts:216-317`
- Symptom: `.env.example` documents `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `DEEPSEEK_API_KEY`,
  `DEEPSEEK_BASE_URL` and states "e2e picks a Provider by available key, in order: Claude →
  DeepSeek". The catalog's `envKey` rows also bind `OPENAI_API_KEY` (six rows) and `GEMINI_API_KEY`
  (one), and `packages/core/test/llm.e2e.test.ts:72-73` explicitly opts into a Gemini leg when
  `GEMINI_API_KEY` is set — so both are live configuration a user would put in `.env`, and neither
  is mentioned.
- Evidence:
  ```ts
  // packages/core/src/state/model-catalog.ts:258
  envKey: "GEMINI_API_KEY",
  ```
  ```
  $ grep -c "GEMINI\|OPENAI" .env.example   →  0
  ```
- Fix: add commented `OPENAI_API_KEY` / `OPENAI_BASE_URL` and `GEMINI_API_KEY` entries to
  `.env.example`, and amend the e2e-order comment to name the Gemini leg.
- Confidence: high

---

### [LOW] Root `link:cli` masks its own failure with `|| echo`
- File: `package.json:35`; consumed by `package.json:34` (`"build": "pnpm -r build && pnpm link:cli"`)
- Symptom: the global `penguin` symlink is best-effort, and the `|| echo` makes it unconditionally
  exit 0, so `pnpm build` can never fail because of it. That is deliberate for the message it
  prints, but it also swallows every other failure mode (a broken `packages/cli` dist, a permission
  error) under the same "not configured" wording.
- Evidence:
  ```json
  "link:cli": "pnpm --dir packages/cli link --global || echo '[link:cli] pnpm global directory not configured; ...'"
  ```
- Fix: distinguish the two cases — exit 0 only for the specific "global directory not configured"
  failure, and let anything else propagate.
- Confidence: medium

---

### [LOW] Windows signing-credential step fails closed only by accident of `$ErrorActionPreference`
- File: `.github/workflows/desktop-build.yml:249-258`
- Symptom: when `REQUIRE_WINDOWS_SIGNING=true` and `EVSIGN_KEY` is missing, the step prints
  `Write-Error` and then unconditionally `exit 0`. It only fails the job because
  `$ErrorActionPreference = "Stop"` was set two lines earlier turns `Write-Error` into a
  terminating error. The macOS arm of the same policy (`:206-209`) is explicit with `exit 1`;
  a future edit that moves or relaxes the preference silently converts this into a pass-while-unsigned
  in a release that requires signing.
- Evidence:
  ```pwsh
  if ([string]::IsNullOrWhiteSpace($env:EVSIGN_KEY)) {
    if ($env:REQUIRE_WINDOWS_SIGNING -eq "true") {
      Write-Error "Missing EVSIGN_KEY secret required for Windows release signing."   # relies on Stop
    }
    "EVSIGN_REQUIRE=false" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
    exit 0
  }
  ```
- Fix: `exit 1` inside the `REQUIRE_WINDOWS_SIGNING` branch, mirroring the macOS step.
- Confidence: high

---

### [LOW] EVSign signing client is fetched from a `-latest` URL in the release path
- File: `.github/workflows/desktop-build.yml:269-270`
- Symptom: the Windows signing step downloads `evsign-client-cli-windows-latest` rather than a
  pinned version, then hands it `EVSIGN_KEY`. It is authenticated afterwards — Authenticode
  signature validity plus an expected-publisher check (`Keroro Software Ltd`) — which is a real
  mitigation, but the download still happens *before* the secret is passed and the URL is the one
  thing the check cannot pin. `release.yml` pins MinGit and the Node runtime to exact versions for
  reproducibility; the signing tool is the exception.
- Evidence:
  ```pwsh
  Invoke-WebRequest -Uri "https://mc.evsign.cn/evsign-client-cli-windows-latest" -OutFile $client ...
  $signature = Get-AuthenticodeSignature -LiteralPath $client
  ```
- Fix: pin a versioned CLI URL and record its SHA256 in the workflow alongside `MINGIT_VERSION`.
- Confidence: medium

---

### [LOW] `.prettierignore` `*.md` excludes every markdown file, including the READMEs it looks like it means to keep
- File: `.prettierignore:16-18`
- Symptom: the `# docs-only area (mostly Chinese; not machine-formatted)` block lists `specs/` then
  `*.md`, and `specs/` does not exist in this tree — so the only operative entry is `*.md`, which
  excludes every Markdown file repo-wide (README.md, README.zh.md, CHANGELOG.md, plugins/README.md,
  all skill `SKILL.md`). `pnpm format:check` therefore never touches prose. This is consistent with
  the repo's intent (skills are imported/formatted upstream), but the `specs/` line is dead and the
  blanket `*.md` hides that the root READMEs are unformatted by design rather than by oversight.
- Evidence:
  ```
  # docs-only area (mostly Chinese; not machine-formatted)
  specs/
  *.md
  ```
- Fix: drop the `specs/` line and say plainly that all Markdown is excluded by design.
- Confidence: high

---

### [LOW] `install.sh`'s `is_release_tag` accepts non-numeric tags like `vlatest`
- File: `install.sh:87-96` (cf. `scripts/publish-release-to-oss.sh:55-63`)
- Symptom: the OSS mirror script requires `v[0-9]*`; the installer only requires `v` followed by an
  alphanumeric, so `PENGUIN_VERSION=vlatest` / `PENGUIN_VERSION=vfoo` pass validation and are used
  to build a URL that 404s with a confusing "download failed" rather than "invalid release version".
- Evidence:
  ```sh
  is_release_tag() {
    case "$1" in
      v[0-9A-Za-z]* ) ;;          # accepts vlatest
  ```
- Fix: tighten to `v[0-9]*` to match the mirror script.
- Confidence: high
