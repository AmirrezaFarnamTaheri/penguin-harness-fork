# Agent contribution rules (J8) — tracked four-rule constitution

**Package:** J8 (Wave 3) — four-rule tracked contributor agent constitution.
**Date:** 2026-10-03 (Asia/Tehran).

## Scope

- **Parent task:** J8, all four sub-requirements (J8.1 selection, J8.2 tracked publication,
  J8.3 grounding, J8.4 enforceability review).
- **Deliverable:** a tracked, clean-checkout-readable four-rule constitution for agents, a stable
  pointer from the contributor guide and the development skill, and this receipt.
- **Not in scope:** the ignored root `AGENTS.md` (a local symlink into the design repository is
  preserved untouched), any change to `tasks/` contracts, and CI wiring for an automated link gate
  (recorded as residual work).

## Baseline

- Branch `arena/01a0fd8a-penguin-harness-fork`, starting HEAD `6a7db4a10324e3af06cd6633ee8efe4b8dd92ac5`.
- Node `v22.22.3`, pnpm `11.18.0`, Linux sandbox (`/usr/bin/git`).
- Before this package the repository had **no** tracked statement of agent rules: the root
  `AGENTS.md` is git-ignored (`.gitignore` line 42, `/AGENTS.md`) and absent from any clean
  checkout; `.github/CONTRIBUTING.md` carried human working rules only. The task archive fixes the
  count (four rules) but records no historical wording, so the selection below is a **current
  decision, not a recovered quote**.

## Change

| Path | Change |
| --- | --- |
| `docs/policies/agent-contribution-rules.md` (new) | The four rules, each with trigger, required behavior, completion evidence, and source mapping; the clean-checkout guarantee; the five review negatives. |
| `.github/CONTRIBUTING.md` | New section *Rules for agent contributors*: the four rule statements plus a link to the policy page. |
| `.github/CONTRIBUTING.zh.md` | The same section in Chinese, same position. |
| `.agents/skills/penguin-harness-dev/SKILL.md` | Stable pointer to the constitution from the skill that a pure-clean checkout carries. |
| `.agents/skills-lock.json` | Re-pinned digest for that skill (`pnpm skills:lock:pin`, 2567 skills). |

The constitution file is the single authority; the guide and the skill carry one-line statements
and pointers only, so the rules exist once and are referenced, not duplicated.

## J8.1 — The four rules as selected (decision record)

| # | Rule | Trigger | Required behavior | Completion evidence | Source |
| --- | --- | --- | --- | --- | --- |
| 1 | Declare the boundary before you edit | Starting any change or review | Read the request/card/local `AGENTS.md`; state branch, `HEAD`, paths; one package = one observable boundary (split at 5 files / 3 acceptance bullets); record a missing prerequisite instead of widening; read private state, never edit/delete/require it | Receipt `Scope`/`Baseline`; `git status` before and after | `tasks/implementation-guide.md` §1; `tasks/contracts.md` *L-scope creep*; `.gitignore` |
| 2 | Never claim more than you ran | Any "done/verified/fixed/passing" statement | Run the scoped check on the named revision; quote command and result; cite CI only from a run observed on that commit; keep unmet criteria and residual work visible | Receipt `Verification`/`CI`/`Residual work` (§5 fields); PR `## Verification` | `tasks/implementation-guide.md` §5–6; `CONTRIBUTING.md` *Pull requests* |
| 3 | Land each green package; external actions only when authorized | A package turns green; or a push/external/destructive command is next | Commit + push the named branch immediately, one package per commit, task row updated in the same change; no shared-history rewrite, no other branch; publishing/tagging/releasing/merging/deploying/mass deletion/spending/long-lived services need explicit authorization; never ask for or store credentials | Commit SHA + pushed ref; updated task row; authorizing instruction and command output | Standing instruction to commit incrementally; `CONTRIBUTING.md` *Pull requests* |
| 4 | Reuse has provenance; refusals are absolute | Copying, adapting, vendoring, or citing external material | Establish repository, commit, scope, license, notices, dependency terms; record ADOPT/ADAPT/REIMPLEMENT/INSPIRE/REFUSE; unclear license means do not copy; digests for vendored assets; hard refusals never routed around | Provenance row (source, commit, license, notices) in receipt or changelog | `docs/policies/porting-and-refusals.md` |

The four statements are non-contradictory by construction: rule 1 bounds the work, rule 2 bounds
claims about it, rule 3 bounds what leaves the working tree, rule 4 bounds what enters it. Rule 3's
immediate push does not conflict with rule 2's check-first requirement, because the trigger is the
package being green.

## J8.2 — Publication and stable pointers

- Canonical text: `docs/policies/agent-contribution-rules.md` — tracked (the `docs/policies/`
  directory already holds the porting/refusal policy linked from `README.md`).
- Pointers: `.github/CONTRIBUTING.md` → the policy page; `.github/CONTRIBUTING.zh.md` →
  the same; `.agents/skills/penguin-harness-dev/SKILL.md` → the same. The skill is the file a
  clean checkout carries (`.claude` is a committed symlink to `.agents`), so an agent with no
  `AGENTS.md` still reaches the rules.
- Private state preserved: no file under `/design`, no root `AGENTS.md`, and no local config was
  created, edited, or removed; `git status` shows only the five paths listed under *Change*.

## J8.3 — Grounding: links, paths, commands

Checker (scratch at the time of the run; full source in [Appendix A](#appendix-a--grounding-checker)
so the check can be reproduced): resolves every relative Markdown link against the file's
directory, matches `#anchor` against GitHub-style heading slugs or explicit `id="…"` anchors, and
verifies every backticked repository path against the tree, with absent-by-design tokens declared
on the command line. Run from the repository root:

```console
$ node /home/user/wip-j8/links.mjs . docs/policies/agent-contribution-rules.md \
    .github/CONTRIBUTING.md .github/CONTRIBUTING.zh.md \
    .agents/skills/penguin-harness-dev/SKILL.md \
    --absent AGENTS.md .codegraph/ CLAUDE.md .env .assets/ .zh.md \
      packages/cli/dist/penguin.js design/AGENTS.md \
      changelog/unreleased/YYYY-MM-DD-backward-compatibility.md
checked 39 links, 8 anchors, 27 paths in 4 files under .
OK: every link resolves, every anchor exists, every referenced path is present
```

| Grounding check | Result |
| --- | --- |
| Relative links (incl. `../…` from both the policy page and the two `.github` guides) | 39 resolve |
| Heading anchors (`#hard-refusals`, `#1-establish-the-work-boundary`, `#5-…`, `#6-…`, `#pull-requests`) | 8 match a real heading |
| Backticked repository paths | 27 present |
| Absent-by-design tokens (declared, each explained by the text that names it) | `AGENTS.md`/`.codegraph/`/`CLAUDE.md` (ignored local state, explicitly described as absent or private); `.env`, `.assets/`, `.zh.md`, `packages/cli/dist/penguin.js`, `design/AGENTS.md`, `changelog/unreleased/YYYY-MM-DD-…` — all pre-existing placeholders or generated/absent artifacts in text this change did not author |
| Commands named by the constitution | exactly one: `git status` (verified on PATH at `/usr/bin/git` and run below) |
| External-action authorization | kept explicit: rule 3 lists each action class that requires an instruction in the current request and states the credential rule; no command in the constitution is presented as pre-authorized |

Clean-checkout readability (only files `git ls-files` reports; the new page staged intent-to-add so
it appears, then unstaged again):

```console
$ git add -N docs/policies/agent-contribution-rules.md
$ git ls-files -z | tar --null -T - -cf - | tar -xf - -C /home/user/wip-j8/clean
$ git reset -q -- docs/policies/agent-contribution-rules.md
$ ls /home/user/wip-j8/clean/AGENTS.md
ls: cannot access '/home/user/wip-j8/clean/AGENTS.md': No such file or directory
$ node /home/user/wip-j8/links.mjs /home/user/wip-j8/clean docs/policies/agent-contribution-rules.md \
    .github/CONTRIBUTING.md .github/CONTRIBUTING.zh.md \
    .agents/skills/penguin-harness-dev/SKILL.md --absent <same list>
checked 39 links, 8 anchors, 27 paths in 4 files under /home/user/wip-j8/clean
OK: every link resolves, every anchor exists, every referenced path is present
```

So the rules are readable and reachable with no `AGENTS.md`, no design repository, and no local
state of any kind.

## J8.4 — Four scenarios where a rule changes an agent action

1. **Rule 1 (boundary).** While closing I7, the production injection point for the write-pressure
   gate was unknown — nothing constructed it outside tests. Without the rule the natural move was
   to widen I7 into session/scratchpad wiring in `packages/core/src/state/…` and the server route.
   The rule required naming the boundary and recording the unknown as a dependency: I7 shipped its
   policy, enforcement, grant store, and route with a receipt whose *Residual work* field names the
   injection question, instead of a silently expanded edit.
2. **Rule 2 (evidence).** A package's focused suite can pass locally while the aggregate CI job on
   the same SHA is still red — the current release incident is exactly that state (the aggregate
   `ci` job failed because required lanes failed, `tasks/work-orders.md`). The rule forbids writing
   "CI green" from a local run or from an earlier head: the row stays `IMPLEMENTED` with the
   observed run linked, and only an observed passing run on the candidate head can move it. That is
   also why this receipt records commands and outputs rather than adjectives.
3. **Rule 3 (landing).** In this working session the workspace reverted to a previous commit nine
   times, each time taking uncommitted work with it; the H5 package only survived its last revert
   because its delta was reconstructed by hand and then committed as `6a7db4a1`. Under the rule,
   the package is committed and pushed the moment it is green — one commit, named branch, task row
   updated in the same change — so a revert can no longer reach finished work. An agent asked to
   "also bump the version and publish" without such an instruction in the request must not: tagging,
   releasing, and publishing are in the opt-in list.
4. **Rule 4 (provenance).** D1 (a lazy tree-sitter grammar pack) was deferred because the packaged
   WASM assets had no recorded upstream provenance or digests; the rule converts that into a
   recorded REFUSE/defer with a reopen condition (provenance + digest manifest) instead of a vendored
   payload. Symmetrically, a request to add a free-API bridge or quota rotation is answered by the
   refusal list — the work is refused, not routed around through another vendor.

## Verification

| Command | Result |
| --- | --- |
| `pnpm --dir packages/docs exec vitest run test/content.test.ts` (card baseline) | 1 file, 7 tests passed |
| `pnpm --dir packages/docs exec vitest run` (full docs package) | 7 files, 53 tests passed |
| `pnpm skills:lock:pin` then `pnpm skills:lock:verify` | `Pinned 2567 skills`; `Verified 2567 pinned skills` |
| `pnpm skills:audit --check` | `Skills: 2567; aliases: 250; errors: 0; warnings: 0` |
| `prettier --check` on the four edited/added Markdown files and the lock | `All matched files use Prettier code style!` |
| `node links.mjs …` over the four guidance files (working tree and clean checkout) | 39 links, 8 anchors, 27 paths — OK in both trees |
| Same checker including this receipt (`--absent … /AGENTS.md`, the ignored path the `.gitignore` citation names) | 40 links, 9 anchors, 56 paths in 6 files — OK |
| Same checker including `tasks/todo.md` (7 files) | 228 links and 165 anchors resolve; the only path notes are five pre-existing package-relative test paths in `todo.md` text this change did not author |
| `sha256sum docs/policies/agent-contribution-rules.md` | `e90c5b37cbc076ba7a244f81ad8523ef31b3f03e474f18d23692e331101f3345` |

## CI

- Candidate head: `6a7db4a1` baseline; the package head is the commit that adds this receipt (see
  the dispatch note in `tasks/todo.md` for the SHA).
- No CI job covers Markdown link integrity for this file; the checks above are local. The GitHub
  checks for the pushed head are the authoritative record and are not claimed green here until
  observed on that SHA.
- `skill-integrity.yml` runs `pnpm skills:lock:verify`, which passes locally for the re-pinned
  digest.

## Compatibility

- Docs-only change: no runtime, API, or on-disk behavior; no migration.
- The ignored root `AGENTS.md`, `/design`, and any user-owned local instructions are untouched and
  remain the more specific authority where they exist; the constitution states that precedence.
- Rollback: revert the five files (the policy page, its two guide pointers, the skill pointer, and
  the lock digest) — no other artifact depends on them.

## Acceptance

| Criterion | Result |
| --- | --- |
| J8.1 exactly four explicit rules with source mapping, trigger, required behavior, evidence | Proved (policy page §1–4; decision table above) |
| J8.2 tracked publication with a stable pointer, minimal duplication, ignored local state preserved | Proved (three pointers; `git status` shows no private path touched) |
| J8.3 every referenced path/command grounded; external-action authorization explicit | Proved (grounding table; one command, verified) |
| J8.4 four scenarios where a rule changes an action + clean-checkout receipt | Proved (four scenarios; clean-tree checker output) |
| Negative: ignored-only guidance | Absent — canonical text is tracked; the ignored `AGENTS.md` is described as *absent*, never required |
| Negative: broken link | Absent — 39/39 resolve in both trees, anchors included |
| Negative: nonexistent command | Absent — one command named, on PATH |
| Negative: contradictory rule | Absent — see the non-contradiction note under J8.1 |
| Negative: private-state dependency | Absent — the clean-checkout run contains no private file |

## Residual work

- **No automated guard.** Link/path/command grounding is a manual receipt check; the repo has no
  Markdown link gate outside `packages/docs/content/`. Owner: J11/J12 (CI gates) or a new package.
  Reopen when a link checker for `.github/` and `docs/policies/` is proposed.
- **Rule adoption beyond this repo's agents.** Nothing enforces the four rules mechanically; the
  pointer exists in the skill and the guide only. Owner: release/first-run checks if a stronger
  hook is wanted.
- **Historical wording remains unrecovered** by design; the decision record here is the authority.

## Appendix A — grounding checker

The checker used for the runs above, verbatim. Save it anywhere and run it as
`node links.mjs <tree-root> <files…> --absent <tokens…>`.

````js
#!/usr/bin/env node
/**
 * Scratch J8 grounding verifier (not committed): resolves every relative Markdown link in the
 * given files under the given tree root, checks heading anchors, and checks that backticked
 * repository paths exist. Absent-by-design paths (the git-ignored local instructions) must be
 * declared on the command line after `--absent`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const [root, ...rest] = process.argv.slice(2);
const absentAt = rest.indexOf("--absent");
const files = absentAt === -1 ? rest : rest.slice(0, absentAt);
const absent = new Set(absentAt === -1 ? [] : rest.slice(absentAt + 1));

const slug = (heading) =>
  heading
    .trim()
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");

const failures = [];
const checked = { links: 0, anchors: 0, paths: 0 };

for (const file of files) {
  const abs = join(root, file);
  const text = readFileSync(abs, "utf8");

  for (const [, label, target] of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [rawPath, anchor] = target.split("#");
    const targetAbs = rawPath === "" ? abs : resolve(dirname(abs), rawPath);
    checked.links += 1;
    if (!existsSync(targetAbs)) {
      failures.push(`${file}: link "${label}" -> ${target} does not resolve (${targetAbs})`);
      continue;
    }
    if (anchor) {
      checked.anchors += 1;
      const targetText = statSync(targetAbs).isFile() ? readFileSync(targetAbs, "utf8") : "";
      const headings = targetText
        .split("\n")
        .filter((line) => /^#{1,6} /.test(line))
        .map(slug);
      const explicit = new RegExp(`id=["']${anchor}["']`);
      if (!headings.includes(anchor) && !explicit.test(targetText)) {
        failures.push(`${file}: anchor "#${anchor}" not found in ${rawPath}`);
      }
    }
  }

  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    if (!/^(?:\.{0,2}\/)?[\w.@-][\w.@/-]*$/.test(token)) continue;
    const looksLikePath =
      (token.includes("/") || token.startsWith(".")) &&
      /\.(md|json|mjs|mts|ts|yml|yaml|tsx|js)$|^\.\w+\/?$/.test(token);
    if (!looksLikePath) continue;
    if (absent.has(token)) continue;
    checked.paths += 1;
    const candidates = [join(root, token), resolve(dirname(abs), token)];
    if (!candidates.some((candidate) => existsSync(candidate))) {
      failures.push(`${file}: path "${token}" does not exist (looked in ${candidates.join(", ")})`);
    }
  }
}

console.log(`checked ${checked.links} links, ${checked.anchors} anchors, ${checked.paths} paths in ${files.length} files under ${root}`);
if (failures.length > 0) {
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("OK: every link resolves, every anchor exists, every referenced path is present");
````
