/**
 * Behavior tests for the source-identity sidecar and its reconciliation against the evidence manifest. The
 * fixture pair below mirrors the observed visual review bundle, whose interesting property is that the
 * manifest's `sha` is the merge commit the `pull_request` checkout resolved to while the sidecar's
 * `expectedCommit` and `sourceCommit` agree on the pull request's head — a difference that is correct, not a
 * tampering signal.
 */
import { describe, expect, it } from "vitest";

import {
  SOURCE_IDENTITY_SCHEMA_VERSION,
  compareSourceIdentity,
  parseSourceIdentity,
  summarizeIdentityComparison,
} from "../../../src/internal/evidence/source-identity.js";
import type { EvidenceManifest } from "../../../src/internal/evidence/evidence-manifest-parser.js";

const IDENTITY = {
  schemaVersion: 2,
  sourceMode: "git",
  sourceCommit: "0f34a9448c6e5b2f1281ef2d00620c51b3a8661f",
  expectedCommit: "0f34a9448c6e5b2f1281ef2d00620c51b3a8661f",
  sourceDirty: true,
  sourceTreeSha256: "0573eee0db5ffa01ebd948b26317df1ac835054333de4c24d477f54dcae89ae3",
  sourceFileCount: 32393,
  sourceBytes: 22537360,
};

const MANIFEST: EvidenceManifest = {
  schema_version: 2,
  scope: "Visual regression review",
  status: "success",
  captured_utc: "2026-09-11T13:24:49.1032351+00:00",
  repository: "AmirrezaFarnamTaheri/Scriptor",
  workflow: "Visual review",
  job: "visual-review",
  run_id: "34603822218",
  run_number: "511",
  run_attempt: "1",
  event: "pull_request",
  ref: "refs/pull/112/merge",
  sha: "d00c4b554d038f98620bd139554492b55810f9e0",
  source_mode: "git",
  source_commit: "0f34a9448c6e5b2f1281ef2d00620c51b3a8661f",
  source_tree_sha256: "0573eee0db5ffa01ebd948b26317df1ac835054333de4c24d477f54dcae89ae3",
  source_dirty: true,
  source_file_count: 32393,
  source_bytes: 22537360,
  runner_os: "Windows",
  runner_arch: "X64",
  file_count: 6,
  total_bytes: null,
  files: [],
};

describe("parseSourceIdentity", () => {
  it("reads the observed bundle's sidecar without complaint", () => {
    const parsed = parseSourceIdentity(JSON.stringify(IDENTITY));
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it("reports the schema version it was built against", () => {
    expect(SOURCE_IDENTITY_SCHEMA_VERSION).toBe(2);
  });

  it("flags a schema version other than the one the parser reads", () => {
    const parsed = parseSourceIdentity(JSON.stringify({ ...IDENTITY, schemaVersion: 1 }));
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({
      kind: "schema_version",
      field: "schemaVersion",
      message: "expected 2, got 1",
    });
  });

  it("flags a required field that is absent", () => {
    const broken = { ...IDENTITY } as Record<string, unknown>;
    delete broken.expectedCommit;
    const parsed = parseSourceIdentity(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({
      kind: "missing",
      field: "expectedCommit",
      message: "required field is absent",
    });
  });

  it("flags a mistyped field and keeps the rest", () => {
    const parsed = parseSourceIdentity(JSON.stringify({ ...IDENTITY, sourceBytes: "22 MB" }));
    expect(parsed.ok).toBe(false);
    expect(
      parsed.issues.some((issue) => issue.field === "sourceBytes" && issue.kind === "type"),
    ).toBe(true);
    expect(parsed.identity?.sourceBytes).toBe(0);
  });

  it("rejects text that is not JSON", () => {
    const parsed = parseSourceIdentity("{not json");
    expect(parsed.ok).toBe(false);
    expect(parsed.identity).toBeUndefined();
  });
});

describe("compareSourceIdentity", () => {
  it("agrees on every source fact the two documents both state", () => {
    const comparisons = compareSourceIdentity(
      parseSourceIdentity(JSON.stringify(IDENTITY)).identity as never,
      MANIFEST,
    );
    const summary = summarizeIdentityComparison(comparisons);
    // The merge-ref difference is the one expected disagreement; see the test below.
    expect(summary.matches).toBe(6);
    expect(summary.mismatches).toBe(1);
  });

  it("reports the merge-ref difference between the checked-out sha and the expected commit", () => {
    const comparisons = compareSourceIdentity(
      parseSourceIdentity(JSON.stringify(IDENTITY)).identity as never,
      MANIFEST,
    );
    const checkedOut = comparisons.find((comparison) => comparison.field === "checkedOutSha");
    expect(checkedOut?.status).toBe("mismatch");
    expect(checkedOut?.identity).toBe("0f34a9448c6e5b2f1281ef2d00620c51b3a8661f");
    expect(checkedOut?.manifest).toBe("d00c4b554d038f98620bd139554492b55810f9e0");
  });

  it("reports the checked-out sha as matching when the run was on the head it intended", () => {
    const comparisons = compareSourceIdentity(
      parseSourceIdentity(JSON.stringify(IDENTITY)).identity as never,
      {
        ...MANIFEST,
        sha: "0f34a9448c6e5b2f1281ef2d00620c51b3a8661f",
      },
    );
    const summary = summarizeIdentityComparison(comparisons);
    expect(summary.clean).toBe(true);
    expect(summary.mismatches).toBe(0);
  });

  it("flags a source fact the two documents disagree about", () => {
    const comparisons = compareSourceIdentity(
      parseSourceIdentity(JSON.stringify(IDENTITY)).identity as never,
      {
        ...MANIFEST,
        sha: "0f34a9448c6e5b2f1281ef2d00620c51b3a8661f",
        source_bytes: 1,
      },
    );
    const treeBytes = comparisons.find((comparison) => comparison.field === "sourceBytes");
    expect(treeBytes?.status).toBe("mismatch");
    expect(summarizeIdentityComparison(comparisons)).toEqual({
      matches: 6,
      mismatches: 1,
      unknowns: 0,
      mismatchedFields: ["sourceBytes"],
      clean: false,
    });
  });

  it("labels a fact the manifest does not state as unknown rather than wrong", () => {
    const partial: Record<string, unknown> = { sha: "0f34a9448c6e5b2f1281ef2d00620c51b3a8661f" };
    const comparisons = compareSourceIdentity(
      parseSourceIdentity(JSON.stringify(IDENTITY)).identity as never,
      partial as never,
    );
    expect(comparisons.find((comparison) => comparison.field === "sourceTreeSha256")?.status).toBe(
      "unknown",
    );
    expect(summarizeIdentityComparison(comparisons).clean).toBe(true);
  });

  it("reports every field the sidecar and manifest can be reconciled on", () => {
    const comparisons = compareSourceIdentity(
      parseSourceIdentity(JSON.stringify(IDENTITY)).identity as never,
      MANIFEST,
    );
    expect(comparisons.map((comparison) => comparison.field)).toEqual([
      "sourceMode",
      "sourceCommit",
      "sourceTreeSha256",
      "sourceFileCount",
      "sourceBytes",
      "sourceDirty",
      "checkedOutSha",
    ]);
  });
});
