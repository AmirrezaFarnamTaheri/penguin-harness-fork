# E10 — Four lifecycle/resource leaks (2026-10-02)

E10 is four independent repairs, each with its own revert-and-see evidence and its own commit, so
any one can be reverted without touching the others. This receipt is E10.5: for each slice, the
pre-fix failure, the post-fix pass, the controlled revert, and the platform relevance.

| Slice | Defect | Repair | Commit |
| ----- | ------ | ------ | ------ |
| E10.1 | Orphan child: a detached background group survived SIGKILL/crash because cleanup was only a `process.on("exit")` hook | Per-Session parent-death watchdog that sweeps the recorded process groups | `da46a7c0` |
| E10.2 | Hung removal: `disposeRemoved` awaited `entry.running` with no bound, so a never-settling drive meant `session.dispose()` never ran | Bounded cleanup (5 s) that always runs once, reports `disposed` / `disposed-after-timeout`, and counts/logs timeouts | `a2aa1622` |
| E10.3 | Session deletion: a swarm task outlived the Session that started it and ran to its round cap | Owner-tagged swarm tasks + `abortSwarmTasksForSession` wired into `DELETE /api/sessions/:id` | `8b7676e3` |
| E10.4 | Archive capacity: the truncated-output archive was bounded per call (8 MiB−1) but unbounded per Session | Per-Session bound (500 entries / 256 MiB), oldest-first eviction, `ARCHIVE_FULL` instead of writing outside the bound | `a3b60a81` |

## Pre-fix failure / post-fix pass, per slice

**E10.1.** Before: `BackgroundRegistry` installs one `process.on("exit")` listener and nothing
else (`packages/core/src/environment/tools/background/registry.ts`), so a SIGKILLed harness leaves
detached groups running. After: the E10.1 test SIGKILLs a stand-in harness that started a detached
`sleep 120` and a watchdog, and asserts the group is gone within a few polls while a bystander
process in its own group is untouched. Revert-and-see: deleting the watchdog launch from the
manager (mutation 1) and disabling the sweep inside the guardian program (mutation 2) each turn
the suite red (1 failure each). The guardian is exercised exactly as production runs it
(`node -e <PARENT_DEATH_GUARDIAN_SOURCE> …`), not re-implemented in the test.

**E10.2.** Before: `disposeRemoved` did `entry.running.then(dispose, dispose)` unconditionally.
After: the cleanup runs on settle or at `RUNTIME_DISPOSE_GRACE_MS`, the outcome is recorded per
Session and counted, and `shutdown()` uses the same bounded path. Test: a never-settling drive
still disposes and reports `disposed-after-timeout` (count 1); a settled drive disposes promptly
and does not count. Revert-and-see: a drive with a bounded wait vs the unbounded shape is the
difference the test asserts directly (the timeout path fails without the timer).

**E10.3.** Before: `SwarmCoordinator.abort()` existed but nothing in the Session-deletion path
called it, and a task carried no owner, so a project-scoped coordinator could not know which
Session it belonged to. After: `SwarmTaskDefinition.ownerSessionId` +
`abortTasksForSession(sessionId, reason)`, a server helper that walks live project runtimes, and
the delete route calling it. Test: a real `DELETE /api/sessions/:id` stops an owned running task
(round 1, log says `Task interrupted: session deleted`) while another project's task keeps
running and an untagged task is unreachable. Revert-and-see: dropping the delete-route call → 1
failure; dropping the owner check → 2 failures.

**E10.4.** Before: `commit()` wrote `*.log` files with only a per-call budget; nothing ever
removed them but Session deletion. After: capacity is enforced against the directory listing on
every commit (so it survives concurrency and restarts), eviction is oldest-first and only over
regular `*.log` files, and an inadmissible capture is refused with `ARCHIVE_FULL` plus a stderr
line. Revert-and-see: removing the capacity check → 3 failures; reversing the eviction order → 1
failure. B1's valid-ID lifetime is untouched: recall entries live in `recall/` and keep their own
documented bounds, asserted by recalling an entry after three truncation-archive evictions.

## Controlled revert on an isolated fixture

Each commit is a single slice (`git revert <commit>` leaves the other three intact), and each
slice's tests are self-contained: E10.1 in `packages/core/test/parent-death-guardian.test.ts`,
E10.2/E10.3 in `packages/server/test/session-manager.test.ts`,
`cockpit-swarm-owner.test.ts`, `session-delete-scratchpad.test.ts`, E10.4 in
`packages/core/test/truncated-tool-output-archive.test.ts`. The mutation runs above are the
revert-and-see checks, executed against the working tree (files restored byte-identical after
each run — verified by re-reading them, except the one noted below).

## Platform relevance

| Platform | Status |
| -------- | ------ |
| POSIX (Linux/macOS) | Implemented and proven with real processes: detached process groups, `kill(-pgid)`, one watchdog per Session |
| Windows | **Not claimed.** E10.1's equivalent is a Job Object with `KILL_ON_JOB_CLOSE`, which requires a native handle this package does not carry; `guardianSupported()` returns false and no watchdog is started. E10.2/E10.3/E10.4 are platform-neutral and covered by the same tests. Reopen condition: a Windows agent in CI plus a decision about carrying a native dependency |

## Incidents worth keeping

- **A mutation that removes the guardian's pid filter is not a test — it is an incident.** With
  the filter dropped, the "malformed pid file" fixture made the suite itself execute
  `kill(-1, SIGKILL)` and take the whole session down (twice, silently, before the cause was
  found). The dangerous values (`1`, `0`, negative) are therefore asserted only on the pure
  parser, and the real-process fixture contains nothing that could turn into a session-wide kill.
  This is recorded in the source comment at the filter and in the test.
- **A guardian whose polling timer is `unref`'d exits on its first tick** (node has nothing left
  to keep it alive), which is how the first version of E10.1 "passed" nothing at all. The timer is
  deliberately referenced, and the doc comment says why.

## Residual work

- Windows Job Object (above).
- The watchdog is not started when no `sessionScratchpadDir` is configured; embedders in that
  configuration keep the old behavior. Reopen condition: an embedder that spawns background
  commands and wants the guarantee without a scratchpad — the pid file could live in the OS temp
  directory instead.
- Pre-existing, not from this batch: `packages/core/test/command-policy.test.ts` has four red
  Windows command-pattern cases (`windows-recursive-delete` not matching `Remove-Item -Recurse
  -Force …` etc.). Untouched source (`state/command-policy-defaults.ts` is not in this diff);
  owned by the Wave-1 command-policy work, left visible here rather than silently inherited.
