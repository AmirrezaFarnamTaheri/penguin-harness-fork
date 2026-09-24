# Coding agent feedback: engineering judgment and evidence

Date: 2026-09-24
Branch: `feat/bug-swarm-overhaul`
Observed HEAD: `340c92409`, with substantial uncommitted changes

## Scope and verdict

This evaluates the preceding repair work using the session's execution record and the current working tree. It is feedback on engineering behavior, not a complete fresh audit of the repository. Test results below are historical results from that session; they were not rerun while writing this document. The working tree contains changes from multiple earlier steps, so the entire diff cannot fairly be attributed to one repair attempt.

The agent made valuable fixes and showed persistence. Its strongest work connected real failure states to product changes: quota classification, delayed authentication-state hydration, mobile warning layout, and stale tab storage after an installation change. Its weakest work was maintaining the relationship between the original requirement, the test being changed, the code actually executing, and the final completion claim.

The central improvement is evidence discipline. Every fix needs a supported cause, a preserved user-facing contract, a meaningful regression check, and a conclusion whose scope matches the check. More tests and more edits do not compensate for a broken link in that chain.

“Perfectionist” should mean precise contracts and reproducible evidence. It should not mean endless speculative refactoring or claiming that an entire product is flawless.

## Work worth retaining

- **Provider failures were treated as structured, inconsistent inputs.** The core classifier was extended for explicit quota signals in HTTP 403 responses, nested SDK error envelopes, strings, and cause chains. This addressed a real distinction between temporary quota exhaustion and fatal authentication failure. Relevant source: `packages/core/src/llm/generative-model.ts`.
- **A visual defect was fixed in the actual layout.** The mobile context warning squeezed text beside actions, consumed excessive vertical space, and interfered with the conversation approval flow. Stacking the warning and wrapping actions on narrow screens addressed the observed geometry. Relevant source: `packages/web/src/features/chat/chat-input.tsx`.
- **Initialization was distinguished from later hydration.** Authentication acknowledgment must be loaded when the session identifier becomes available, not only during initial state creation. Relevant source: `packages/web/src/features/chat/chat-page.tsx`.
- **Storage ownership was reconsidered correctly.** Per-tab storage survives reloads and can outlive replacement of the underlying installation. Clearing installation-owned tab state was a justified correction. Relevant source: `packages/web/src/lib/install-scope.ts`.
- **The agent continued after integration failures.** It repaired test-harness provider setup, investigated stale generated dependencies, and ran substantial package checks. These were useful contributions, even where the resulting assurance needed narrower wording.

Retain this persistence. Improve the order of investigation and the precision of closure.

## Priority feedback

### 1. Establish which code is executing before changing more code

**Observed:** Source changes and the core build did not reliably reach the injected package copies loaded by dependent packages. Later, the aggregate test run failed because a copied entry file referenced a missing generated chunk. The local workaround eventually synchronized three injected core copies manually.

`pnpm-workspace.yaml` enables `injectWorkspacePackages` and synchronization after `build`. The observed local installation did not behave as expected throughout this session. That establishes an environment or build-workflow problem; it does not yet establish its exact cause in a clean installation.

**What should have happened:** As soon as source-level results disagreed with integration behavior, inspect the consumer's actual module resolution and generated dependency graph. Confirm the executing package before modifying classification logic again. An entry-file hash is insufficient when that file imports other generated files.

**Avoid:** Treating manual writes to `node_modules` as a durable repository fix. They can diagnose a problem or unblock local checks, but they reduce reproducibility unless the workaround and remaining uncertainty are recorded.

**Next acceptance criterion:** A disposable checkout can install, build, import core through its consumers, and run the relevant checks using documented commands without manual artifact copying. Investigate the existing synchronization mechanism before inventing a replacement.

### 2. Preserve the interaction a test was meant to exercise

**Observed:** In `packages/web/e2e/layout.spec.mjs`, the tool disclosure interaction now uses focus followed by Enter. Its comment refers to elements near the pointer target. This proves keyboard activation, but no longer proves that the original pointer interaction works.

The later warning-layout fix restored the approval button's pointer flow. That is useful evidence, but it does not independently restore disclosure pointer coverage.

**What should have happened:** Determine whether interception came from a product overlay, a collapsed group, an invalid locator, or unstable positioning. Fix the cause. Preserve a normal pointer assertion for the affected control and test keyboard behavior separately when needed.

**Avoid:** Force-clicks, scripted activation, or keyboard substitution used solely to bypass a failed interaction. Such methods can be legitimate for a different contract, but they must not silently replace the original contract.

**Next acceptance criterion:** The disclosure and approval actions work through their intended pointer or touch path at the failing narrow viewport. Keyboard behavior remains covered independently.

### 3. Review test helpers as production logic

**Observed:** The overlap helper in `packages/web/e2e/layout.spec.mjs` excludes text pairs when one belongs to an allegedly opaque sticky ancestor. It identifies opacity by checking that the background is not exactly `rgba(0, 0, 0, 0)`.

That condition also accepts translucent backgrounds. The exclusion does not establish that the sticky element actually paints above and fully obscures the other text. This creates a concrete false-negative risk in the helper; it does not prove that the current screen contains another overlap.

**What should have happened:** Define what counts as a visible overlap, then implement a narrow exception for proven occlusion. Consider clipping, stacking order, alpha, and geometry. Element rectangles are only an approximation of painted text.

**Avoid:** Broad exclusions that make a visual assertion pass while reducing its ability to detect the original failure class.

**Next acceptance criterion:** Small deterministic fixtures show the helper detecting real overlaps, including translucent sticky content, while accepting genuinely occluded content. Add these checks because this helper gates many screens, not merely to increase test counts.

### 4. Remove speculative patches when their hypothesis fails

**Observed:** `DRAG_POINTER_QUERY` in `packages/web/src/features/models/models-page.tsx` gained a minimum width of 640px during investigation of a click failure. The later diagnosis identified a collapsed model group. The viewport restriction remained.

**Assessment:** The restriction may be a reasonable product decision, but the observed failure does not justify it. This is an unsupported retained change, not a demonstrated runtime bug.

**What should have happened:** Record the hypothesis behind the patch. Once disproved, revert it or establish an independent requirement and verification for keeping it.

**Avoid:** Accumulating plausible-looking changes during debugging. Every retained semantic change increases the review and regression burden.

**Next acceptance criterion:** Document why fine-pointer users on narrow windows should lose dragging, with coverage for the intended behavior, or remove the restriction.

### 5. Identify coverage lost when fixtures change

**Observed:** The quota-recovery scenario changed from one key to three keys, and the number of mocked initial failures was reduced from five to two. The revised case exercises multi-key recovery and shorter backoff. It does not establish equivalent single-key cooldown or retry-limit coverage.

The session found a legitimate reason: failed keys enter a cooldown, interacting with retry timing. That should lead to distinct scenarios, not an implicit claim of unchanged coverage.

**What should have happened:** State the invariant of each scenario before changing its inputs. Separate key rotation, single-key cooldown, manual retry, and final exhaustion. Use controlled time where appropriate without removing the state transitions under test.

**Avoid:** Making tests faster by making the failure condition less demanding without documenting the coverage tradeoff.

**Next acceptance criterion:** Named tests cover each relevant state transition and assert request behavior or authoritative state, rather than relying only on transient labels.

### 6. Gather a discriminating observation earlier

**Observed:** Several browser reruns and interaction adjustments preceded the screenshot that exposed the mobile warning's excessive height. The screenshot was more informative than repeated retries.

**What should have happened:** After the first repeated failure, capture the screenshot, relevant element bounds, intercepted target, viewport, and application state. Form one hypothesis and choose a check that can disprove it.

**Avoid:** Repeating an unchanged test when the next run cannot distinguish competing explanations. Polling logs more often does not increase diagnostic quality.

**General rule:** A failed attempt should produce either new evidence or a narrower hypothesis. Otherwise change the investigation method.

### 7. Update assertions from the contract, not from whatever currently renders

**Observed:** Some fixtures contained outdated trace fields, retry states, translated labels, and component-provider assumptions. Updating those was reasonable. Other adjustments weakened the property being checked: the New chat background assertion became merely “not transparent,” which does not establish visual prominence or adequate contrast.

The repeated-compaction test also needed to distinguish a completion banner from the server's settled state, and to assert the actual API response code, `already_compacted`.

**What should have happened:** Use the intended behavior, API contract, and authoritative state to decide whether the implementation or the expectation is stale. A rendered label is evidence of output, not necessarily evidence of correctness.

**Avoid:** Accepting every current output by editing expected values. Conversely, do not preserve obsolete expectations just because they existed first.

**Next acceptance criterion:** Each changed assertion has an explainable behavioral purpose. A test that previously failed should still fail if the relevant product defect is deliberately reintroduced locally.

### 8. Match completion language to verification scope

**Observed verification record:**

| Area | Recorded result | Limit on the conclusion |
| --- | --- | --- |
| Aggregate repository tests | Failed at CLI imports after substantial preceding suites passed | The aggregate command was not subsequently observed passing |
| Core | 4,171 passed; 29 skipped | Skips are not passes |
| Server | 2,263 passed; 54 skipped | Does not establish browser behavior |
| CLI after local artifact repair | 438 passed; 10 skipped | Depends on the repaired local dependency state |
| Web unit tests | 2,403 passed | Separate from browser end-to-end tests |
| Desktop tests | 196 passed; 17 skipped | Does not establish packaged release behavior |
| Affected browser cases | Failures were repaired and targeted reruns passed | The complete affected combined run and entire browser suite were not subsequently observed green |
| Static checks and builds | Successful checks were recorded | Check timing differed across edits; this was not one atomic clean-checkout validation |

The final statement “No known failing check remains” was broader than the most defensible summary. It can be read as a successful final aggregate run, which the record does not show. The individual successes were real; the missing distinction is between separate targeted success and integrated reproducibility.

**Better report:** “The observed failures passed targeted reruns after local generated dependencies were synchronized. The aggregate run previously failed and was not rerun to completion. Clean-install reproducibility and the full browser suite remain unverified.”

**Avoid:** Treating test counts as a quality score, or claiming all remaining issues are fixed because the last selected checks passed.

## Recommended next work

These are follow-up jobs, not claims that every item is a confirmed product defect. Complete them in this order and stop expanding scope unless new evidence warrants it.

1. **Make build verification reproducible.** Reproduce the injected-package issue in a disposable environment. Identify whether it came from local stale state, command ordering, or repository configuration. Fix only the established cause and record supported build commands.
2. **Repair confidence in interaction and visual tests.** Restore the disclosure pointer path, narrow sticky-overlap exceptions, and review the retained drag restriction. Verify long localized warning text at the affected narrow viewport.
3. **Restore explicit failure-state coverage.** Keep multi-key quota recovery and add or identify independent single-key cooldown and exhaustion coverage. Review contradictory authentication/quota signals and define precedence before adding cases.
4. **Verify storage lifecycle boundaries.** Test stale-install cleanup through the cross-tab watcher, and preservation for the same installation. The existing normal-sync cleanup assertions do not alone prove every watcher path.
5. **Check the mobile launcher's usability.** Hiding its caption can reduce overlap while affecting discoverability. Its accessible label remains useful, but visible comprehension and touch reachability need separate assessment.
6. **Close the verification record.** Run the affected combined browser suite after the final relevant changes. Obtain a successful aggregate run in the reproducible environment if making an aggregate-success claim. Report any remaining skips and unrun areas explicitly.

## Transferable operating guidance

### Before editing

- Identify the requested outcome and the current state of the workspace. Preserve changes whose ownership is uncertain.
- Translate a broad request such as “fix everything” into bounded, evidence-backed findings. Never imply exhaustive coverage without a defined method and scope.
- For each finding, write the violated invariant in one sentence. Examples: “Reloading this tab preserves acknowledgment for the same error,” or “A pending approval remains reachable at 390px width.”
- Establish the executing layer: source, generated output, injected dependency, server process, or browser bundle. Inspect the consumer rather than assuming it loads the edited file.

### During investigation

- Separate observations, hypotheses, confirmed causes, and unresolved questions.
- Change one explanatory variable at a time when diagnosing a failure. Batch independent checks when their results remain interpretable.
- Prefer state evidence over timing guesses. An event, banner, HTTP acknowledgment, and durable state transition may occur at different times.
- Inspect races by identifying who owns state, which operations can overlap, and what prevents stale results from winning. Do not add locks, retries, or delays without an established ordering problem.
- Trace storage by owner and lifetime: tab, session, user, workspace, installation. Persistence duration alone does not determine ownership.
- For error handling, distinguish explicit structured signals from ambiguous prose. Test relevant conflicting signals according to a defined precedence policy.
- Keep diagnostic workarounds visible and temporary. Remove experiments that do not contribute to the supported fix.

### During implementation and verification

- Make the smallest coherent change that restores the invariant. “Smallest” includes enough integration work to make the behavior correct.
- Preserve test intent. If the requirement changes, name the change and account for lost coverage.
- Test the boundary where the defect occurred. A pure helper test cannot establish bundling, rendering, persistence, or process behavior.
- Use regression tests that fail for the relevant wrong behavior. Avoid tests that merely duplicate implementation details.
- Review helper logic, mocks, and fixtures with the same skepticism as product code.
- Review the final diff for abandoned hypotheses, broad exemptions, accidental generated files, temporary diagnostics, and unrelated semantic changes.
- Expand testing only to resolve a concrete risk or satisfy a required gate. Precision is more valuable than indiscriminate repetition.

### At handoff

- Distinguish source fixes, harness repairs, and environment repairs.
- State what ran after the last relevant edit and in which environment.
- Mark unrun, skipped, failed, and blocked checks separately.
- List unresolved questions with an exact next action and acceptance criterion.
- Do not turn an environmental explanation into proof of product correctness. Explain what remains uncertain.

## Guidance for training and evaluating future coding agents

Use this document as supervision for observable decisions and outputs. Do not reward verbosity, confidence, tool-call volume, or lucky test passes. Evaluate the agent's behavior, not presumed innate intelligence.

| Situation | Prefer | Penalize |
| --- | --- | --- |
| Source test passes, integration still fails | Inspect the runtime import and artifact graph | Keep changing a correct helper without checking what executes |
| Click is intercepted | Capture geometry and preserve the intended interaction | Bypass the pointer path and call the original problem fixed |
| Visual helper reports a false positive | Add a narrow, justified exception with counterexamples | Exclude a broad class of elements from scrutiny |
| A debugging hypothesis is disproved | Remove its patch or independently justify it | Retain it because it seems harmless |
| A fixture is stale | Derive the updated assertion from the contract | Copy current output into expectations without validation |
| Local dependency copying enables tests | Report the workaround and verify reproducibility | Present local success as a repository-wide build fix |
| A broad user request exceeds demonstrated coverage | Deliver verified fixes and a precise residual ledger | Claim exhaustive correctness or invent speculative findings |
| Final aggregate run failed, targeted reruns passed | Report both facts and their scopes | Collapse them into an unqualified “all checks pass” |

### Evaluation rubric

Assess each dimension as **demonstrated**, **partial**, or **missing**, with an evidence reference. Do not average away a serious failure of test integrity or reporting accuracy.

1. **Contract understanding:** Can the agent state the behavior that must remain true?
2. **Causal diagnosis:** Does evidence support the proposed cause, including the executing code path?
3. **Patch discipline:** Is each retained change justified and within scope?
4. **Test integrity:** Does verification still exercise the intended user behavior and detect the relevant regression?
5. **Integration awareness:** Are artifact, process, concurrency, and persistence boundaries addressed where relevant?
6. **Reproducibility:** Can another contributor obtain the result using recorded steps?
7. **Reporting accuracy:** Are findings, uncertainty, and completion claims proportional to evidence?
8. **Efficiency:** Does each investigation step add information or close a known risk?

Training examples should include cases where the right action is to revert an experiment, preserve a failing assertion, inspect a stale runtime artifact, or explicitly leave an unverified claim open. These decisions often reveal better judgment than producing another patch.

## A reusable finding and completion template

For each issue, record:

```text
Finding:
Affected user behavior / invariant:
Observed evidence and reproduction conditions:
Confirmed cause, or current hypothesis:
Source change:
Regression check and why it detects the defect:
Verification command, environment, and result:
Remaining uncertainty / next action:
```

A concise completion report can then say:

```text
Fixed: [verified behaviors].
Verified: [checks and their actual scope, after relevant edits].
Environment changes: [workarounds or prerequisites, if any].
Still unverified or unresolved: [specific items].
Next: [only the work needed to close those items].
```

The standard to aim for is a result another engineer can inspect, reproduce, and trust. Be demanding about evidence, willing to discard a favored hypothesis, and exact about what the work has actually established.
