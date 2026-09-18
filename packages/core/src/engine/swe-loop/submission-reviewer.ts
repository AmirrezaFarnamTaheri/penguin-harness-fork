/**
 * Submission review for the autonomous SWE loop.
 *
 * The question this answers is small and sharp: an agent has declared "I am
 * done" and handed over a patch — is that submission *acceptable*, and if
 * not, what exactly is wrong with it? The loop's state machine can only move
 * to `submitted`; this module decides whether that move is honest.
 *
 * Rules, all evaluated and each one producing a named finding:
 *  - an empty patch is an automatic rejection with `empty_patch` — there is
 *    nothing to review;
 *  - a patch touching a forbidden path (build output, node_modules, lockfile)
 *    is rejected with `forbidden_path`, because a clean diff is not clean if
 *    it regenerates artifacts;
 *  - when the policy requires test evidence, a submission with no test run,
 *    or one whose test results contain failures, is rejected with
 *    `missing_test_evidence` / `failing_tests` and the failing names listed;
 *  - a patch that only touches test files is flagged `test_only_patch` —
 *    a valid TDD step, but never an implementation-only submission;
 *  - exit status is normalized to the SWE-bench vocabulary
 *    (`submitted`/`submitted_with_errors`/`exited`) so downstream tooling can
 *    compare strings instead of guessing.
 *
 * It also implements the two recovery paths the SWE-loop archives use when a
 * run ends badly: `autosubmitFromTrajectory` salvages the last known good
 * diff from the event log when the runtime died (SWE-agent's
 * `attempt_autosubmission_after_error`), and `extractPatch` builds a patch
 * record from an edit-history checkpoint stack.
 */

import type { SweEvent, SweEventStream } from "./event-stream.js";
import type { EditHistory } from "./edit-history-checkpoint.js";

export interface PatchFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface TestEvidence {
  /** Test names or ids that ran. */
  ran: string[];
  /** Names of failing tests. */
  failures: string[];
  /** Names of erroring tests (distinct from assertion failures). */
  errors: string[];
  passed: number;
  durationMs: number;
}

export interface Submission {
  /** The diff or patch text; empty string means "no change produced". */
  patch: string;
  files: PatchFile[];
  testEvidence?: TestEvidence;
  /** Originating agent id, for provenance. */
  agentId?: string;
  note?: string;
}

export type SubmissionFindingLevel = "block" | "warn" | "info";

export interface SubmissionFinding {
  ruleId: string;
  level: SubmissionFindingLevel;
  detail: string;
  affected?: string[];
}

export interface SubmissionPolicy {
  requireTestEvidence: boolean;
  forbiddenPaths: readonly string[];
  /** Paths a test-only patch is allowed to consist of. */
  testPathPatterns: readonly RegExp[];
  /** Min passed tests before evidence counts. */
  minPassedTests: number;
  /** Max failures tolerated in `submitted_with_errors`. */
  maxFailuresForWithErrors: number;
}

export const DEFAULT_SUBMISSION_POLICY: SubmissionPolicy = Object.freeze({
  requireTestEvidence: true,
  forbiddenPaths: Object.freeze([
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "*.min.js",
  ]),
  testPathPatterns: Object.freeze([/\.test\.ts$/, /\.spec\.ts$/, /test\//, /tests\//, /__tests__/]),
  minPassedTests: 1,
  maxFailuresForWithErrors: 0,
});

export type SubmissionExitStatus =
  "submitted" | "submitted_with_errors" | "exited" | "rejected" | "empty";

export interface SubmissionVerdict {
  accepted: boolean;
  exitStatus: SubmissionExitStatus;
  findings: SubmissionFinding[];
  blockingFindings: SubmissionFinding[];
  testedFileCount: number;
  implementationFileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  reviewedAt: number;
}

function matchesForbiddenPath(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return patterns.some((pattern) => {
    if (pattern.startsWith("*")) {
      return normalized.endsWith(pattern.slice(1));
    }
    if (pattern.endsWith("/")) return normalized.startsWith(pattern);
    return normalized === pattern || normalized.startsWith(pattern);
  });
}

function matchesTestPath(path: string, patterns: readonly RegExp[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return patterns.some((pattern) => pattern.test(normalized));
}

export class SubmissionReviewer {
  private readonly policy: SubmissionPolicy;
  private reviewed = 0;
  private accepted = 0;

  constructor(policy: Partial<SubmissionPolicy> = {}) {
    this.policy = { ...DEFAULT_SUBMISSION_POLICY, ...policy };
  }

  public getReviewedCount(): number {
    return this.reviewed;
  }

  public getAcceptedCount(): number {
    return this.accepted;
  }

  /**
   * Reviews a submission. Never throws on a bad submission — a rejection is a
   * verdict with findings, which is the whole point. Only structurally
   * invalid input (no submission object) throws.
   */
  public review(submission: Submission): SubmissionVerdict {
    this.reviewed++;
    const findings: SubmissionFinding[] = [];

    const patchText = submission.patch ?? "";
    if (patchText.trim().length === 0 && submission.files.length === 0) {
      findings.push({
        ruleId: "empty_patch",
        level: "block",
        detail: "submission contains no patch text and no changed files",
      });
      return this.finalize(submission, findings, "empty");
    }

    for (const file of submission.files) {
      if (matchesForbiddenPath(file.path, this.policy.forbiddenPaths)) {
        findings.push({
          ruleId: "forbidden_path",
          level: "block",
          detail: `submission touches '${file.path}', which the policy forbids as generated output`,
          affected: [file.path],
        });
      }
    }

    let testedFileCount = 0;
    let implementationFileCount = 0;
    for (const file of submission.files) {
      if (matchesTestPath(file.path, this.policy.testPathPatterns)) testedFileCount++;
      else implementationFileCount++;
    }

    if (implementationFileCount === 0 && submission.files.length > 0) {
      findings.push({
        ruleId: "test_only_patch",
        level: "warn",
        detail: "every changed file is a test file; this is a TDD step, not an implementation",
      });
    }

    if (this.policy.requireTestEvidence) {
      if (!submission.testEvidence) {
        findings.push({
          ruleId: "missing_test_evidence",
          level: "block",
          detail: "policy requires test evidence and the submission provides none",
        });
      } else {
        const evidence = submission.testEvidence;
        if (evidence.passed < this.policy.minPassedTests) {
          findings.push({
            ruleId: "insufficient_passing_tests",
            level: "block",
            detail: `${evidence.passed} passing test(s) is below the required ${this.policy.minPassedTests}`,
          });
        }
        if (evidence.failures.length > 0) {
          findings.push({
            ruleId: "failing_tests",
            level: "block",
            detail: `${evidence.failures.length} test(s) failing: ${evidence.failures.slice(0, 8).join(", ")}`,
            affected: [...evidence.failures],
          });
        }
        if (evidence.errors.length > 0) {
          findings.push({
            ruleId: "erroring_tests",
            level: "block",
            detail: `${evidence.errors.length} test(s) erroring: ${evidence.errors.slice(0, 8).join(", ")}`,
            affected: [...evidence.errors],
          });
        }
        if (evidence.ran.length === 0 && evidence.passed === 0) {
          findings.push({
            ruleId: "no_tests_ran",
            level: "block",
            detail: "test evidence present but records no test as executed",
          });
        }
      }
    }

    const blocking = findings.filter((finding) => finding.level === "block");
    return this.finalize(
      submission,
      findings,
      blocking.length > 0 ? "rejected" : this.deriveExitStatus(submission.testEvidence),
    );
  }

  /**
   * Salvages a submission of opportunity from the event log when the run
   * ended badly — the runtime died, or the model stopped producing tool calls
   * without declaring done. Mirrors SWE-agent's behaviour of running the
   * submission command anyway and, when even that fails, falling back to the
   * last diff recorded in the trajectory.
   */
  public autosubmitFromTrajectory(stream: SweEventStream, agentId?: string): SubmissionVerdict {
    const lastPatch = this.extractPatch(stream);
    const evidence = this.extractTestEvidence(stream);

    const submission: Submission = {
      patch: lastPatch.patch,
      files: lastPatch.files,
      testEvidence: evidence,
      agentId,
      note: "autosubmitted after an abnormal run termination",
    };
    return this.review(submission);
  }

  /** Builds a patch record from an edit-history checkpoint stack. */
  public extractPatchFromHistory(history: EditHistory): { patch: string; files: PatchFile[] } {
    const files = new Map<string, PatchFile>();
    for (const checkpoint of history.listCheckpoints()) {
      const existing = files.get(checkpoint.path);
      const additions = checkpoint.after.split("\n").length - checkpoint.before.split("\n").length;
      if (existing) {
        existing.additions += Math.max(0, additions);
        existing.deletions += Math.max(0, -additions);
      } else {
        files.set(checkpoint.path, {
          path: checkpoint.path,
          additions: Math.max(0, additions),
          deletions: Math.max(0, -additions),
        });
      }
    }
    return { patch: this.renderPatch(files), files: Array.from(files.values()) };
  }

  // ---------------------------------------------------------------- internals

  private finalize(
    submission: Submission,
    findings: SubmissionFinding[],
    exitStatus: SubmissionExitStatus,
  ): SubmissionVerdict {
    const blocking = findings.filter((finding) => finding.level === "block");
    const verdict: SubmissionVerdict = {
      accepted: blocking.length === 0 && exitStatus !== "empty" && exitStatus !== "rejected",
      exitStatus,
      findings,
      blockingFindings: blocking,
      testedFileCount: 0,
      implementationFileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      reviewedAt: Date.now(),
    };
    verdict.testedFileCount = submission.files.filter((file) =>
      matchesTestPath(file.path, this.policy.testPathPatterns),
    ).length;
    verdict.implementationFileCount = submission.files.length - verdict.testedFileCount;
    verdict.totalAdditions = submission.files.reduce((sum, file) => sum + file.additions, 0);
    verdict.totalDeletions = submission.files.reduce((sum, file) => sum + file.deletions, 0);
    if (verdict.accepted) this.accepted++;
    return verdict;
  }

  private deriveExitStatus(evidence?: TestEvidence): SubmissionExitStatus {
    if (!evidence) return "submitted";
    if (evidence.failures.length > this.policy.maxFailuresForWithErrors) {
      return "submitted_with_errors";
    }
    return "submitted";
  }

  private renderPatch(files: Map<string, PatchFile>): string {
    const lines: string[] = ["# synthesized patch", ""];
    for (const [path, file] of files) {
      lines.push(
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ changed: +${file.additions} -${file.deletions} @@`,
      );
    }
    return lines.join("\n");
  }

  private extractPatch(stream: SweEventStream): { patch: string; files: PatchFile[] } {
    const events = stream.replay();
    let lastPatch = "";
    let lastFiles: PatchFile[] = [];
    for (const event of events) {
      if (event.kind === "submission_proposed") {
        const payload = event.payload as { patch?: string; files?: PatchFile[] };
        if (payload.patch) lastPatch = payload.patch;
        if (payload.files) lastFiles = payload.files;
      }
    }
    return { patch: lastPatch, files: lastFiles };
  }

  private extractTestEvidence(stream: SweEventStream): TestEvidence | undefined {
    const events: SweEvent[] = stream.replay({ kinds: ["tool_output"] });
    let evidence: TestEvidence | undefined;
    for (const event of events) {
      const payload = event.payload as { testEvidence?: TestEvidence };
      if (payload?.testEvidence) evidence = payload.testEvidence;
    }
    return evidence;
  }
}
