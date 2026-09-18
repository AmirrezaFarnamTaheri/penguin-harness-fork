import { describe, expect, it } from "vitest";

import { SweEventStream } from "../../../src/engine/swe-loop/event-stream.js";
import { EditHistory } from "../../../src/engine/swe-loop/edit-history-checkpoint.js";
import {
  DEFAULT_SUBMISSION_POLICY,
  SubmissionReviewer,
  type PatchFile,
  type Submission,
  type TestEvidence,
} from "../../../src/engine/swe-loop/submission-reviewer.js";

function evidence(overrides: Partial<TestEvidence> = {}): TestEvidence {
  return {
    ran: ["suite.test"],
    failures: [],
    errors: [],
    passed: 2,
    durationMs: 12,
    ...overrides,
  };
}

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    patch: "--- a/src/math.ts\n+++ b/src/math.ts\n@@ +1 -0 @@\n",
    files: [
      { path: "src/math.ts", additions: 4, deletions: 1 },
      { path: "src/math.test.ts", additions: 6, deletions: 0 },
    ],
    testEvidence: evidence(),
    ...overrides,
  };
}

describe("SubmissionReviewer structural rejections", () => {
  it("rejects an empty submission with empty_patch", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review({ patch: "", files: [] });
    expect(verdict.accepted).toBe(false);
    expect(verdict.exitStatus).toBe("empty");
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain("empty_patch");
    expect(reviewer.getReviewedCount()).toBe(1);
    expect(reviewer.getAcceptedCount()).toBe(0);
  });

  it("treats a whitespace-only patch with no files as empty", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review({ patch: "   \n  ", files: [] });
    expect(verdict.exitStatus).toBe("empty");
  });

  it("rejects a patch that touches a forbidden path", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(
      submission({ files: [{ path: "dist/bundle.js", additions: 100, deletions: 0 }] }),
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.exitStatus).toBe("rejected");
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain("forbidden_path");
    expect(verdict.blockingFindings[0]?.affected).toEqual(["dist/bundle.js"]);
  });

  it("matches forbidden paths through windows separators", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(
      submission({ files: [{ path: "dist\\bundle.js", additions: 1, deletions: 0 }] }),
    );
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain("forbidden_path");
  });

  it("matches every forbidden pattern in the default policy", () => {
    const reviewer = new SubmissionReviewer();
    for (const forbidden of DEFAULT_SUBMISSION_POLICY.forbiddenPaths) {
      const path = forbidden.endsWith("/") ? `${forbidden}thing.js` : forbidden;
      const verdict = reviewer.review(
        submission({ files: [{ path, additions: 1, deletions: 0 }] }),
      );
      expect(verdict.accepted).toBe(false);
    }
  });
});

describe("SubmissionReviewer test evidence", () => {
  it("blocks a submission with no test evidence when the policy requires it", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(submission({ testEvidence: undefined }));
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain(
      "missing_test_evidence",
    );
    expect(verdict.exitStatus).toBe("rejected");
  });

  it("blocks on failing tests and names them", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(
      submission({ testEvidence: evidence({ failures: ["add.test", "subtract.test"] }) }),
    );
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain("failing_tests");
    expect(verdict.blockingFindings[0]?.affected).toEqual(["add.test", "subtract.test"]);
  });

  it("blocks on erroring tests distinctly from failures", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(
      submission({ testEvidence: evidence({ errors: ["hook.test"] }) }),
    );
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain("erroring_tests");
  });

  it("blocks when too few tests pass", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(submission({ testEvidence: evidence({ passed: 0 }) }));
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain(
      "insufficient_passing_tests",
    );
  });

  it("blocks evidence that records no test as executed", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(submission({ testEvidence: evidence({ ran: [], passed: 0 }) }));
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain("no_tests_ran");
  });

  it("skips the evidence rules when the policy does not require them", () => {
    const reviewer = new SubmissionReviewer({ requireTestEvidence: false });
    const verdict = reviewer.review(submission({ testEvidence: undefined }));
    expect(verdict.accepted).toBe(true);
    expect(verdict.blockingFindings).toHaveLength(0);
  });
});

describe("SubmissionReviewer acceptance", () => {
  it("accepts a clean implementation with passing tests", () => {
    const reviewer = new SubmissionReviewer();
    const verdict = reviewer.review(submission());
    expect(verdict.accepted).toBe(true);
    expect(verdict.exitStatus).toBe("submitted");
    expect(verdict.testedFileCount).toBe(1);
    expect(verdict.implementationFileCount).toBe(1);
    expect(verdict.totalAdditions).toBe(10);
    expect(verdict.totalDeletions).toBe(1);
    expect(reviewer.getAcceptedCount()).toBe(1);
  });

  it("warns on a test-only patch but still accepts it", () => {
    const reviewer = new SubmissionReviewer();
    const files: PatchFile[] = [{ path: "src/math.test.ts", additions: 3, deletions: 0 }];
    const verdict = reviewer.review(submission({ files }));
    expect(verdict.accepted).toBe(true);
    const warning = verdict.findings.find((finding) => finding.ruleId === "test_only_patch");
    expect(warning?.level).toBe("warn");
    expect(verdict.blockingFindings).toHaveLength(0);
    expect(verdict.implementationFileCount).toBe(0);
  });

  it("normalizes exit status to submitted_with_errors when tolerated failures exceed the budget", () => {
    const reviewer = new SubmissionReviewer({
      requireTestEvidence: false,
      maxFailuresForWithErrors: 0,
    });
    const verdict = reviewer.review(
      submission({ testEvidence: evidence({ failures: ["flaky.test"] }) }),
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.exitStatus).toBe("submitted_with_errors");
  });

  it("reports a clean submitted status when tolerated failures are within budget", () => {
    const reviewer = new SubmissionReviewer({
      requireTestEvidence: false,
      maxFailuresForWithErrors: 2,
    });
    const verdict = reviewer.review(
      submission({ testEvidence: evidence({ failures: ["flaky.test"] }) }),
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.exitStatus).toBe("submitted");
  });
});

describe("SubmissionReviewer autosubmitFromTrajectory", () => {
  it("salvages the last proposed patch and the recorded test evidence", () => {
    const reviewer = new SubmissionReviewer();
    const stream = new SweEventStream();
    stream.append("submission_proposed", {
      patch: "--- a/src/old.ts\n",
      files: [{ path: "dist/generated.js", additions: 1, deletions: 0 }],
    });
    stream.append("tool_output", {
      testEvidence: evidence({ ran: ["recovered.test"], passed: 1 }),
    });
    stream.append("submission_proposed", {
      patch: "--- a/src/fresh.ts\n+++ b/src/fresh.ts\n",
      files: [{ path: "src/fresh.ts", additions: 2, deletions: 0 }],
    });

    const verdict = reviewer.autosubmitFromTrajectory(stream, "coder");
    // The *last* proposal was used: the earlier one touched a forbidden path
    // and would have been rejected outright.
    expect(verdict.accepted).toBe(true);
    expect(verdict.exitStatus).toBe("submitted");
    expect(verdict.implementationFileCount).toBe(1);
  });

  it("rejects a salvaged submission that carries no evidence", () => {
    const reviewer = new SubmissionReviewer();
    const stream = new SweEventStream();
    stream.append("submission_proposed", {
      patch: "--- a/src/fresh.ts\n",
      files: [{ path: "src/fresh.ts", additions: 2, deletions: 0 }],
    });

    const verdict = reviewer.autosubmitFromTrajectory(stream);
    expect(verdict.accepted).toBe(false);
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain(
      "missing_test_evidence",
    );
  });

  it("reports an empty submission when the trajectory has no proposals", () => {
    const reviewer = new SubmissionReviewer();
    const stream = new SweEventStream();
    stream.append("run_started", {});
    const verdict = reviewer.autosubmitFromTrajectory(stream);
    expect(verdict.exitStatus).toBe("empty");
    expect(verdict.blockingFindings.map((finding) => finding.ruleId)).toContain("empty_patch");
  });
});

describe("SubmissionReviewer extractPatchFromHistory", () => {
  it("reduces a checkpoint stack to per-file line deltas and a patch", () => {
    const reviewer = new SubmissionReviewer();
    const history = new EditHistory();
    history.push("src/a.ts", "one\ntwo\nthree");
    history.push("src/a.ts", "one\ntwo\nthree\nfour");
    history.push("src/b.ts", "x\ny\nz");
    history.push("src/b.ts", "x");

    const extracted = reviewer.extractPatchFromHistory(history);
    const byPath = new Map(extracted.files.map((file) => [file.path, file]));
    expect(byPath.get("src/a.ts")).toEqual({ path: "src/a.ts", additions: 3, deletions: 0 });
    expect(byPath.get("src/b.ts")).toEqual({ path: "src/b.ts", additions: 2, deletions: 2 });

    expect(extracted.patch).toContain("--- a/src/a.ts");
    expect(extracted.patch).toContain("+++ b/src/a.ts");
    expect(extracted.patch).toContain("@@ changed: +3 -0 @@");
  });

  it("reports nothing for an empty history", () => {
    const reviewer = new SubmissionReviewer();
    const extracted = reviewer.extractPatchFromHistory(new EditHistory());
    expect(extracted.files).toHaveLength(0);
    expect(extracted.patch).toContain("synthesized patch");
  });
});
