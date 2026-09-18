/**
 * Behavior tests for the evidence manifest reader. The primary fixture is the manifest of the observed visual
 * review bundle, which is why the expectations below read as they do: `total_bytes` is `null` while `file_count`
 * is a populated number, the run identifiers arrive as strings, and the six inventory entries each carry a
 * 64-character hex digest.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_MANIFEST_STATUS_SUCCESS,
  parseEvidenceManifest,
  summarizeManifestBytes,
  verifyManifestHashes,
} from "../../../src/internal/evidence/evidence-manifest-parser.js";

/** Manifest of the observed visual review bundle: schema 2, six files, `total_bytes` unstated. */
const VISUAL_REVIEW_MANIFEST = {
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
  files: [
    {
      path: "command-summary.md",
      bytes: 363,
      sha256: "0c87aee073a94b5d259234f48367d6aaa08e2b4b73968ae99771922f95a3742f",
      modified_utc: "2026-09-11T13:24:46.7221075Z",
    },
    {
      path: "diagnostics.log",
      bytes: 4823,
      sha256: "85e1464fb51e516c2641b2803d032366987be050d5bfc7690e7afa436818808b",
      modified_utc: "2026-09-11T13:22:30.8884297Z",
    },
    {
      path: "install-frozen-pnpm-dependency-graph.log",
      bytes: 8118,
      sha256: "043c9e4b78d2eb165f64d8eec68c114e5e61220a59b0ee3e7b0146bac133c0e2",
      modified_utc: "2026-09-11T13:22:38.7326748Z",
    },
    {
      path: "install-playwright-ffmpeg-runtime.log",
      bytes: 5043,
      sha256: "6b1623c6f31ba3a6e77fa52ad1ac0a7097aa2351b4b2569419385788b9be74f4",
      modified_utc: "2026-09-11T13:22:41.9277043Z",
    },
    {
      path: "run-visual-regression-suite.log",
      bytes: 5679,
      sha256: "826b623345541edd072c28814f340e1609a12ec7ac5ca90967b42a8336e4426e",
      modified_utc: "2026-09-11T13:24:46.7180536Z",
    },
    {
      path: "source-identity.json",
      bytes: 342,
      sha256: "0cba47861bd9c03844dc49cbb87ee746148d84592bfc8ac0ea45499258c45b7b",
      modified_utc: "2026-09-11T13:24:49.0078666Z",
    },
  ],
};

/** Byte total the six inventory entries of the observed bundle add up to. */
const INVENTORY_BYTES = 363 + 4823 + 8118 + 5043 + 5679 + 342;

describe("parseEvidenceManifest", () => {
  it("reads the observed bundle's manifest without complaint", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it("keeps run_id, run_number and run_attempt as the strings the manifest carries", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    expect(parsed.manifest?.run_id).toBe("34603822218");
    expect(parsed.manifest?.run_number).toBe("511");
    expect(parsed.manifest?.run_attempt).toBe("1");
  });

  it("reports a nullable total_bytes as null rather than zero", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    expect(parsed.manifest?.total_bytes).toBe(null);
    expect(parsed.manifest?.file_count).toBe(6);
  });

  it("keeps every inventory entry a well-formed bundle lists", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    expect(parsed.manifest?.files).toHaveLength(6);
    expect(parsed.manifest?.files[0]).toEqual({
      path: "command-summary.md",
      bytes: 363,
      sha256: "0c87aee073a94b5d259234f48367d6aaa08e2b4b73968ae99771922f95a3742f",
      modified_utc: "2026-09-11T13:24:46.7221075Z",
    });
  });

  it("reports the schema version it was built against", () => {
    expect(EVIDENCE_MANIFEST_SCHEMA_VERSION).toBe(2);
    expect(EVIDENCE_MANIFEST_STATUS_SUCCESS).toBe("success");
  });

  it("flags a schema version other than the one the parser reads", () => {
    const parsed = parseEvidenceManifest(
      JSON.stringify({ ...VISUAL_REVIEW_MANIFEST, schema_version: 3 }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({
      kind: "schema_version",
      field: "schema_version",
      message: "expected 2, got 3",
    });
  });

  it("accepts a manifest that states a byte total agreeing with its inventory", () => {
    const withTotal = { ...VISUAL_REVIEW_MANIFEST, total_bytes: INVENTORY_BYTES };
    const parsed = parseEvidenceManifest(JSON.stringify(withTotal));
    expect(parsed.ok).toBe(true);
    expect(parsed.manifest?.total_bytes).toBe(INVENTORY_BYTES);
  });

  it("flags a byte total that disagrees with the inventory", () => {
    const parsed = parseEvidenceManifest(
      JSON.stringify({ ...VISUAL_REVIEW_MANIFEST, total_bytes: 1 }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({
      kind: "total",
      field: "total_bytes",
      message: `states 1 bytes but the inventory adds up to ${INVENTORY_BYTES}`,
    });
  });

  it("flags a file_count that disagrees with the inventory length", () => {
    const parsed = parseEvidenceManifest(
      JSON.stringify({ ...VISUAL_REVIEW_MANIFEST, file_count: 99 }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((issue) => issue.kind === "count")).toBe(true);
  });

  it("accepts a manifest with no files[] at all and reads an empty inventory", () => {
    const withoutFiles = { ...VISUAL_REVIEW_MANIFEST } as Record<string, unknown>;
    delete withoutFiles.files;
    withoutFiles.file_count = 0;
    const parsed = parseEvidenceManifest(JSON.stringify(withoutFiles));
    expect(parsed.manifest?.files).toEqual([]);
    expect(parsed.ok).toBe(true);
  });

  it("reports a file entry whose digest is not 64 hex characters", () => {
    const broken = JSON.parse(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    broken.files[1].sha256 = "not-a-digest";
    const parsed = parseEvidenceManifest(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({
      kind: "value",
      field: "files[1].sha256",
      message: "not 64 lowercase hex characters",
    });
    // The entry is kept — its path and byte count still describe the file — and the other entries are intact.
    expect(parsed.manifest?.files).toHaveLength(6);
    expect(parsed.manifest?.files[1]?.sha256).toBe("not-a-digest");
  });

  it("reports a file entry whose byte count is not a non-negative integer", () => {
    const broken = JSON.parse(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    broken.files[0].bytes = -4;
    const parsed = parseEvidenceManifest(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((issue) => issue.field === "files[0].bytes")).toBe(true);
  });

  it("reports a required field that is absent", () => {
    const broken = { ...VISUAL_REVIEW_MANIFEST } as Record<string, unknown>;
    delete broken.source_commit;
    const parsed = parseEvidenceManifest(JSON.stringify(broken));
    expect(parsed.ok).toBe(false);
    expect(parsed.issues).toContainEqual({
      kind: "missing",
      field: "source_commit",
      message: "required field is absent",
    });
  });

  it("reports a mistyped field without dropping the rest of the manifest", () => {
    const parsed = parseEvidenceManifest(
      JSON.stringify({ ...VISUAL_REVIEW_MANIFEST, source_dirty: "yes" }),
    );
    expect(parsed.ok).toBe(false);
    expect(
      parsed.issues.some((issue) => issue.field === "source_dirty" && issue.kind === "type"),
    ).toBe(true);
    expect(parsed.manifest?.source_dirty).toBe(false);
  });

  it("rejects text that is not JSON", () => {
    const parsed = parseEvidenceManifest("{not json");
    expect(parsed.ok).toBe(false);
    expect(parsed.manifest).toBeUndefined();
    expect(parsed.issues[0]?.kind).toBe("parse");
  });

  it("rejects a JSON document that is not an object", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(["command-summary.md"]));
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0]?.kind).toBe("type");
  });

  it("reads a manifest indented and terminated with CRLF the way a Windows capture writes it", () => {
    const text = `${JSON.stringify(VISUAL_REVIEW_MANIFEST).replace(/}/g, "}\r\n")}`;
    const parsed = parseEvidenceManifest(text);
    expect(parsed.ok).toBe(true);
  });
});

describe("summarizeManifestBytes", () => {
  it("leaves the comparison open when total_bytes is unstated", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    const summary = summarizeManifestBytes(parsed.manifest as never);
    expect(summary.declared).toBe(null);
    expect(summary.summed).toBe(INVENTORY_BYTES);
    expect(summary.matches).toBe(null);
  });

  it("agrees when a stated total matches the inventory", () => {
    const parsed = parseEvidenceManifest(
      JSON.stringify({ ...VISUAL_REVIEW_MANIFEST, total_bytes: INVENTORY_BYTES }),
    );
    expect(summarizeManifestBytes(parsed.manifest as never)).toEqual({
      declared: INVENTORY_BYTES,
      summed: INVENTORY_BYTES,
      matches: true,
    });
  });

  it("disagrees when a stated total does not match the inventory", () => {
    const parsed = parseEvidenceManifest(
      JSON.stringify({ ...VISUAL_REVIEW_MANIFEST, total_bytes: 100 }),
    );
    expect(summarizeManifestBytes(parsed.manifest as never).matches).toBe(false);
  });
});

describe("verifyManifestHashes", () => {
  it("confirms an entry whose contents hash to the recorded digest", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    const manifest = parsed.manifest as never as { files: Array<{ path: string; sha256: string }> };
    manifest.files[0]!.sha256 = createHash("sha256")
      .update("a captured phase summary")
      .digest("hex");
    const contents = new Map<string, string>([["command-summary.md", "a captured phase summary"]]);
    expect(verifyManifestHashes(manifest as never, contents)).toEqual({
      checked: 1,
      verified: 1,
      mismatched: [],
      unreadable: [
        "diagnostics.log",
        "install-frozen-pnpm-dependency-graph.log",
        "install-playwright-ffmpeg-runtime.log",
        "run-visual-regression-suite.log",
        "source-identity.json",
      ],
    });
  });

  it("reports a mismatch when the contents differ from what was hashed", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    const contents = new Map<string, string>([["command-summary.md", "different contents"]]);
    expect(verifyManifestHashes(parsed.manifest as never, contents)).toEqual({
      checked: 1,
      verified: 0,
      mismatched: ["command-summary.md"],
      unreadable: [
        "diagnostics.log",
        "install-frozen-pnpm-dependency-graph.log",
        "install-playwright-ffmpeg-runtime.log",
        "run-visual-regression-suite.log",
        "source-identity.json",
      ],
    });
  });

  it("reports paths the caller did not supply as unreadable rather than mismatched", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    const verified = verifyManifestHashes(parsed.manifest as never, new Map());
    expect(verified).toEqual({
      checked: 0,
      verified: 0,
      mismatched: [],
      unreadable: [
        "command-summary.md",
        "diagnostics.log",
        "install-frozen-pnpm-dependency-graph.log",
        "install-playwright-ffmpeg-runtime.log",
        "run-visual-regression-suite.log",
        "source-identity.json",
      ],
    });
  });

  it("hashes raw byte buffers the same as the text they encode", () => {
    const parsed = parseEvidenceManifest(JSON.stringify(VISUAL_REVIEW_MANIFEST));
    const manifest = parsed.manifest as never as { files: Array<{ path: string; sha256: string }> };
    const text = "a captured phase summary";
    manifest.files[0]!.sha256 = createHash("sha256").update(text).digest("hex");
    const contents = new Map<string, Uint8Array>([
      ["command-summary.md", new TextEncoder().encode(text)],
    ]);
    expect(verifyManifestHashes(manifest as never, contents).verified).toBe(1);
  });
});
