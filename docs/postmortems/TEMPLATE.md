# Postmortem template and release/incident checklists

Copy this file to `docs/postmortems/YYYY-MM-DD-<short-name>.md` and fill every field. One file per
incident or release failure; the raw receipts it cites stay untouched. The filled example for this
template is [2026-10-02-ci-lanes-and-gates.md](2026-10-02-ci-lanes-and-gates.md).

A postmortem is a record, not an apology: it separates what was **observed** from what is
**hypothesised**, names an **owner** for every follow-up, and states the **reopen condition** that
would invalidate a closure. A review fails the document when it has a blame-only cause, an
ownerless action, a missing affected SHA or version, a proof link that does not resolve, or a CI
state inferred from an earlier or similar run.

## Required fields

| Field | Required content |
| --- | --- |
| Title | `YYYY-MM-DD — <what broke>`; the date the incident was first observed. |
| Status | `open` · `mitigated` · `closed`, plus the date of the last status change. |
| Severity / impact | What stopped working, who is affected (users, releases, contributors), and what the blast radius excludes. |
| Timeline (timezone) | Ordered entries, each with timestamp **and timezone** (the repository's default is UTC), the actor/source, and what was observed. First entry = first observation. |
| Affected version / scope | Release version or unreleased range, branch(es), and the exact SHA(s) — incident head and any later head named as the fixed candidate. |
| Detection | How it was found (CI lane, user report, reviewer, manual run) with the link or command that first showed it. |
| Causes and contributing factors | Root cause(s) separated from contributing factors (missing local run, no retries, platform semantics, assumption carried over from another component). Contributing factors are not blamed on a person. |
| Response | What was done, in order, with the same timestamp discipline as the timeline. |
| Raw proof | Links to runs, jobs, logs, receipts, and task rows; each CI claim names the SHA and the run/job it was observed on. |
| Follow-ups | One row per action: owner, due date or reopen condition, linked task/work order/package, and the completion condition that can be checked. |
| Rollback | The exact revertible unit(s) and who decides to revert. |
| Acceptance evidence | The command(s) or run(s) that show the incident closed, on the named candidate SHA. |

## Incident checklist

- [ ] Impact and severity stated in user-visible terms; scope excludes are explicit.
- [ ] Timeline complete from first observation to closure, every entry timezoned and sourced.
- [ ] Incident head SHA recorded and reachable in the proof links.
- [ ] Detection source recorded (lane/job/run or command) — not "CI was red" without a link.
- [ ] Causes separated from contributing factors; no person-blame framing.
- [ ] Every CI statement cites an observed run on the SHA it names (no inferred green).
- [ ] Every follow-up has an owner, a due date or a reopen condition, a linked task/work order,
      and a checkable completion condition.
- [ ] Rollback path named per change.
- [ ] Closure states the acceptance evidence on the candidate SHA, and the reopen condition.
- [ ] Proof links resolve at review time.

## Release checklist

Run before tagging; each line names the evidence that closes it. The release rules themselves live
in [CONTRIBUTING.md](../../.github/CONTRIBUTING.md#working-rules); this list is the check order.

- [ ] Repo version bumped in the root and every workspace `package.json` plus core's `VERSION`
      constant (`packages/core/src/index.ts`) — evidence: the bumped manifests and the release PR.
- [ ] `changelog/unreleased/` renamed to the release version; `changelog/<version>/RELEASE.md`
      written **and committed before the tag** — evidence: the commit that contains it, on the tag's
      checkout.
- [ ] Release branch `release/<version>` ran `desktop-build.yml` with macOS and Windows signing
      required on its final commit — evidence: the run link on that exact commit.
- [ ] Exact-candidate CI green on the final commit — evidence: the `ci` aggregate run for that SHA;
      an earlier head's green run does not close this line.
- [ ] Manual smoke notes recorded (install, upgrade path, data-root check if the schema moved).
- [ ] Rollback decided in advance: the tag is never moved; a post-tag failure costs a version — who
      decides and what they announce.
- [ ] Owner and due/reopen condition recorded for every open release follow-up.
