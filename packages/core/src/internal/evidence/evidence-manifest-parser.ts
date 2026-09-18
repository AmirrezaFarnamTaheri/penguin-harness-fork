/**
 * Parse and validate the CI evidence manifest.
 *
 * Provenance: a CI evidence bundle opens with `evidence-manifest.json`, which records what the bundle is, which
 * GitHub Actions run produced it, which source tree it is evidence for, and an inventory of the files it
 * carries with a SHA-256 per file. Two properties of that inventory matter to anything that consumes it:
 * `total_bytes` is explicitly nullable (the bundle stops short of claiming a byte total it did not compute), and
 * `files` is the only place per-file information lives, so a reader has to fall back to the `files[]` entries
 * whenever the summary field is `null`. The run identifiers `run_id`, `run_number` and `run_attempt` arrive as
 * JSON strings, not numbers — GitHub emits them as strings and the manifest preserves that, so the types below
 * keep them as strings rather than coercing and quietly changing the representation.
 */

import { createHash } from "node:crypto";

/** One file entry of the manifest inventory. */
export interface EvidenceFile {
  /** Repository-relative path of the file inside the bundle directory. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** Lowercase hex SHA-256 of the file contents. */
  sha256: string;
  /** Modification time as an ISO-8601 instant with a timezone offset. */
  modified_utc: string;
}

/** The evidence manifest, in the shape it is serialized in. */
export interface EvidenceManifest {
  schema_version: number;
  scope: string;
  status: string;
  captured_utc: string;
  repository: string;
  workflow: string;
  job: string;
  /** GitHub Actions run id, carried as a string. */
  run_id: string;
  /** GitHub Actions run number, carried as a string. */
  run_number: string;
  /** GitHub Actions run attempt, carried as a string. */
  run_attempt: string;
  event: string;
  ref: string;
  sha: string;
  source_mode: string;
  source_commit: string;
  source_tree_sha256: string;
  source_dirty: boolean;
  source_file_count: number;
  source_bytes: number;
  runner_os: string;
  runner_arch: string;
  /** Number of files listed in `files`. */
  file_count: number;
  /** Sum of the file sizes, or `null` when the bundle does not state it. */
  total_bytes: number | null;
  /** Per-file inventory; empty when the bundle carries none. */
  files: EvidenceFile[];
}

/** The schema version the manifest format this parser reads is written against. */
export const EVIDENCE_MANIFEST_SCHEMA_VERSION = 2;

/** The status value the observed bundles use for a completed capture. */
export const EVIDENCE_MANIFEST_STATUS_SUCCESS = "success";

/** Shape of the field-level problems a parse can report. */
export type ManifestIssueKind =
  "parse" | "schema_version" | "missing" | "type" | "value" | "count" | "total";

/** One validation problem found while parsing a manifest. */
export interface ManifestIssue {
  kind: ManifestIssueKind;
  /** Dotted path of the offending field, or empty for a whole-document problem. */
  field: string;
  message: string;
}

/** Result of parsing manifest text: either a usable manifest plus its issues, or issues alone. */
export interface ParsedEvidenceManifest {
  ok: boolean;
  manifest: EvidenceManifest | undefined;
  issues: ManifestIssue[];
}

/** Lowercase hex, 64 characters — the only form the observed manifests write a SHA-256 in. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, issues: ManifestIssue[]): string | undefined {
  if (typeof value === "string") return value;
  issues.push({
    kind: "type",
    field,
    message: `expected a string, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
  });
  return undefined;
}

function asBoolean(value: unknown, field: string, issues: ManifestIssue[]): boolean | undefined {
  if (typeof value === "boolean") return value;
  issues.push({ kind: "type", field, message: `expected a boolean, got ${typeof value}` });
  return undefined;
}

function asNonNegativeInt(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  issues.push({
    kind: "type",
    field,
    message: `expected a non-negative integer, got ${typeof value === "number" ? value : typeof value}`,
  });
  return undefined;
}

function asNullableNonNegativeInt(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): number | null | undefined {
  if (value === null) return null;
  return asNonNegativeInt(value, field, issues);
}

function asIsoInstant(value: unknown, field: string, issues: ManifestIssue[]): string | undefined {
  const text = asString(value, field, issues);
  if (text === undefined) return undefined;
  if (Number.isNaN(Date.parse(text))) {
    issues.push({ kind: "value", field, message: `not an ISO-8601 instant: ${text}` });
    return undefined;
  }
  return text;
}

/**
 * Parse manifest text. Every field that is present and wrongly typed produces an issue and is left `undefined`
 * on the result; required fields that are absent produce a `missing` issue. The parse still returns a manifest
 * with everything it could recover, so a caller can read the parts it cares about while checking `ok`.
 */
export function parseEvidenceManifest(text: string): ParsedEvidenceManifest {
  const issues: ManifestIssue[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      manifest: undefined,
      issues: [{ kind: "parse", field: "", message: `not valid JSON: ${message}` }],
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      manifest: undefined,
      issues: [
        {
          kind: "type",
          field: "",
          message: `expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        },
      ],
    };
  }

  const root = parsed;
  const get = (field: string) => root[field];

  const schemaVersion = asNonNegativeInt(get("schema_version"), "schema_version", issues);
  if (schemaVersion !== undefined && schemaVersion !== EVIDENCE_MANIFEST_SCHEMA_VERSION) {
    issues.push({
      kind: "schema_version",
      field: "schema_version",
      message: `expected ${EVIDENCE_MANIFEST_SCHEMA_VERSION}, got ${schemaVersion}`,
    });
  }

  const files: EvidenceFile[] = [];
  const rawFiles = get("files");
  if (rawFiles === undefined) {
    // A bundle with no inventory at all is degenerate but well-formed enough to read.
    files.length = 0;
  } else if (!Array.isArray(rawFiles)) {
    issues.push({
      kind: "type",
      field: "files",
      message: `expected an array, got ${typeof rawFiles}`,
    });
  } else {
    for (let index = 0; index < rawFiles.length; index += 1) {
      const entry = rawFiles[index];
      const field = `files[${index}]`;
      if (!isObject(entry)) {
        issues.push({
          kind: "type",
          field,
          message: `expected an object, got ${Array.isArray(entry) ? "array" : typeof entry}`,
        });
        continue;
      }
      const path = asString(entry["path"], `${field}.path`, issues);
      const bytes = asNonNegativeInt(entry["bytes"], `${field}.bytes`, issues);
      const sha256 = asString(entry["sha256"], `${field}.sha256`, issues);
      if (sha256 !== undefined && !SHA256_HEX.test(sha256)) {
        issues.push({
          kind: "value",
          field: `${field}.sha256`,
          message: `not 64 lowercase hex characters`,
        });
      }
      const modifiedUtc = asIsoInstant(entry["modified_utc"], `${field}.modified_utc`, issues);
      if (
        path !== undefined &&
        bytes !== undefined &&
        sha256 !== undefined &&
        modifiedUtc !== undefined
      ) {
        files.push({ path, bytes, sha256, modified_utc: modifiedUtc });
      }
    }
  }

  const manifest: EvidenceManifest = {
    schema_version: schemaVersion ?? 0,
    scope: asString(get("scope"), "scope", issues) ?? "",
    status: asString(get("status"), "status", issues) ?? "",
    captured_utc: asIsoInstant(get("captured_utc"), "captured_utc", issues) ?? "",
    repository: asString(get("repository"), "repository", issues) ?? "",
    workflow: asString(get("workflow"), "workflow", issues) ?? "",
    job: asString(get("job"), "job", issues) ?? "",
    run_id: asString(get("run_id"), "run_id", issues) ?? "",
    run_number: asString(get("run_number"), "run_number", issues) ?? "",
    run_attempt: asString(get("run_attempt"), "run_attempt", issues) ?? "",
    event: asString(get("event"), "event", issues) ?? "",
    ref: asString(get("ref"), "ref", issues) ?? "",
    sha: asString(get("sha"), "sha", issues) ?? "",
    source_mode: asString(get("source_mode"), "source_mode", issues) ?? "",
    source_commit: asString(get("source_commit"), "source_commit", issues) ?? "",
    source_tree_sha256: asString(get("source_tree_sha256"), "source_tree_sha256", issues) ?? "",
    source_dirty: asBoolean(get("source_dirty"), "source_dirty", issues) ?? false,
    source_file_count: asNonNegativeInt(get("source_file_count"), "source_file_count", issues) ?? 0,
    source_bytes: asNonNegativeInt(get("source_bytes"), "source_bytes", issues) ?? 0,
    runner_os: asString(get("runner_os"), "runner_os", issues) ?? "",
    runner_arch: asString(get("runner_arch"), "runner_arch", issues) ?? "",
    file_count: asNonNegativeInt(get("file_count"), "file_count", issues) ?? 0,
    total_bytes: asNullableNonNegativeInt(get("total_bytes"), "total_bytes", issues) ?? null,
    files,
  };

  for (const field of [
    "scope",
    "status",
    "captured_utc",
    "repository",
    "workflow",
    "job",
    "run_id",
    "run_number",
    "run_attempt",
    "event",
    "ref",
    "sha",
    "source_mode",
    "source_commit",
    "source_tree_sha256",
    "runner_os",
    "runner_arch",
  ]) {
    if (!(field in root))
      issues.push({ kind: "missing", field, message: "required field is absent" });
  }

  if (manifest.file_count !== files.length) {
    issues.push({
      kind: "count",
      field: "file_count",
      message: `states ${manifest.file_count} files but the inventory has ${files.length}`,
    });
  }

  if (manifest.total_bytes !== null) {
    let summed = 0;
    for (const file of files) summed += file.bytes;
    if (summed !== manifest.total_bytes) {
      issues.push({
        kind: "total",
        field: "total_bytes",
        message: `states ${manifest.total_bytes} bytes but the inventory adds up to ${summed}`,
      });
    }
  }

  return { ok: issues.length === 0, manifest, issues };
}

/** Cross-check of the byte totals: what the summary claims versus what the inventory adds up to. */
export interface ManifestBytesSummary {
  /** Value of `total_bytes`, `null` when the manifest leaves it unstated. */
  declared: number | null;
  /** Sum of the inventory `bytes` values. */
  summed: number;
  /** Whether the two agree; `null` when `total_bytes` is unstated and there is nothing to compare. */
  matches: boolean | null;
}

/**
 * Compare `total_bytes` with the sum of the inventory. The comparison is skipped when `total_bytes` is `null`
 * — that is the bundle saying "no total was computed", not "the total is zero".
 */
export function summarizeManifestBytes(manifest: EvidenceManifest): ManifestBytesSummary {
  let summed = 0;
  for (const file of manifest.files) summed += file.bytes;
  return {
    declared: manifest.total_bytes,
    summed,
    matches: manifest.total_bytes === null ? null : manifest.total_bytes === summed,
  };
}

/** Result of checking every inventory hash against the contents the bundle actually carries. */
export interface ManifestHashVerification {
  checked: number;
  verified: number;
  mismatched: string[];
  unreadable: string[];
}

/**
 * Verify the inventory hashes against contents supplied by the caller. Values may be strings (UTF-8 hashed) or
 * raw byte buffers; a `sha256` of a text file depends on its exact bytes, so callers that read with an encoding
 * are asserting that the encoding matches the bytes the bundle hashed.
 */
export function verifyManifestHashes(
  manifest: EvidenceManifest,
  contents: Map<string, string | Uint8Array>,
): ManifestHashVerification {
  const result: ManifestHashVerification = {
    checked: 0,
    verified: 0,
    mismatched: [],
    unreadable: [],
  };
  for (const file of manifest.files) {
    const found = contents.get(file.path);
    if (found === undefined) {
      result.unreadable.push(file.path);
      continue;
    }
    result.checked += 1;
    const buffer = typeof found === "string" ? Buffer.from(found, "utf8") : Buffer.from(found);
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest === file.sha256) result.verified += 1;
    else result.mismatched.push(file.path);
  }
  return result;
}
