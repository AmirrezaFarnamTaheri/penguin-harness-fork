# Agent contribution rules

Four rules govern work an AI agent performs in this repository. They are published in a tracked
file so a clean checkout carries them: the root `AGENTS.md` is git-ignored (it is a symlink into
the design repository, and a clone without that repository beside it has none at all), and no rule
here may depend on private, ignored, or machine-local state.

The wording is a **current decision, not a recovered quote**: an earlier task archive fixed only the
count (four) and recorded no original text, so this page chooses the wording rather than pretending
to recover it. A local `AGENTS.md`, a work order, or the current human request may narrow these
rules; where two instructions conflict, the more specific and more recent one wins — except that
the [hard refusals](porting-and-refusals.md#hard-refusals) are absolute.

## 1. Declare the boundary before you edit

- **Trigger:** starting any change or review, before the first edit.
- **Required behavior:** read the current request, the task card or issue, and any `AGENTS.md` or
  guide that applies to the files in question. State the branch, the `HEAD` commit, and the exact
  paths before editing, and treat the existing code as the baseline. Keep one package to one
  observable boundary; split work that reaches five files or three acceptance bullets. A missing
  prerequisite becomes its own recorded dependency, never a silently widened edit. Read private or
  local state when it applies — `AGENTS.md`, `.codegraph/`, user data, uncommitted work — and never
  edit, delete, overwrite, or require it.
- **Completion evidence:** the receipt's `Scope` and `Baseline` fields (branch, `HEAD`, paths) and
  `git status` before and after the change.
- **Source:** [implementation guide](../../tasks/implementation-guide.md#1-establish-the-work-boundary)
  §1; [contracts](../../tasks/contracts.md) risk row *L-scope creep*; `.gitignore`.

## 2. Never claim more than you ran

- **Trigger:** any statement that work is done, verified, fixed, or passing — a receipt, a task row,
  a changelog entry, a commit message, or a pull-request body.
- **Required behavior:** run the scoped check on the exact revision being named, and quote the
  command with its result (case counts, and fixture or corpus hashes where a card requires them).
  Cite CI only from a run observed on that commit, never inferred from an earlier or similar run.
  Keep unmet criteria and residual work visible as open items; a denied or conditional item keeps
  its disposition and its reopen condition instead of disappearing.
- **Completion evidence:** the `Verification`, `CI`, and `Residual work` receipt fields defined by
  [implementation guide](../../tasks/implementation-guide.md#5-record-evidence-and-hand-off) §5, and
  the `## Verification` list in the pull-request body.
- **Source:** [implementation guide](../../tasks/implementation-guide.md#6-finish-the-run-cleanly)
  §6; [contributor guide](../../.github/CONTRIBUTING.md#pull-requests) — list what you actually ran.

## 3. Land each green package; external actions only when authorized

- **Trigger:** a package turns green; or you are about to push, or to run any external or
  destructive command.
- **Required behavior:** commit the package to the branch the task names and push it as soon as it
  is green — never leave finished work uncommitted, because uncommitted work is the state most
  easily lost. One package per commit, with the tracked task row updated in the same change. Never
  rewrite shared history and never push to a branch the task did not name. Publishing, tagging,
  releasing, merging, deploying, mass-deleting user data, spending money, and starting long-lived
  services each need an explicit instruction in the current request; the authorizing instruction is
  quoted where the action is recorded. Never ask for or store credentials: secrets stay out of the
  repository, the receipt, and the conversation.
- **Completion evidence:** the commit SHA and the pushed ref; the updated task row; for an
  authorized external action, the authorizing instruction and the command's output.
- **Source:** the standing instruction to commit incrementally;
  [contributor guide](../../.github/CONTRIBUTING.md#pull-requests) (branch, review, release rules).

## 4. Reuse has provenance; refusals are absolute

- **Trigger:** about to copy, adapt, vendor, or reference external code, assets, text, prompts,
  reports, fixtures, or checkouts outside this repository.
- **Required behavior:** establish the source repository, commit, file scope, license, notices, and
  dependency terms before reusing anything, then record one decision — **ADOPT**, **ADAPT**,
  **REIMPLEMENT**, **INSPIRE**, or **REFUSE** — with the evidence that decision requires. Unclear
  license or provenance means do not copy and record the uncertainty; pinned assets keep their
  notice and a digest. Never route around a hard refusal: free-API bridges and quota rotation,
  fingerprint spoofing or tunnel impersonation, WAF or prompt-sanitizer stripping, vendored
  `.assets/` bundles, and proprietary or otherwise incompatible source stay out of this project.
- **Completion evidence:** a provenance row naming source, commit, license, and notices (plus
  digests for vendored files) in the receipt or changelog entry.
- **Source:** [porting, absorption, and refusal policy](porting-and-refusals.md).

## Reviewing these rules

A change that publishes or edits this constitution is read against five named negatives: guidance
that lives only in an ignored file, a link that does not resolve, a command that does not exist in
the manifests, a rule that contradicts another rule or a canonical policy, and a rule that depends
on private state. Any one of them fails review. The four statements above are the whole list; adding
a fifth rule means editing this page, its pointers, and the receipt together.
