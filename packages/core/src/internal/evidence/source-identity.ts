/**
 * Parse the source-identity sidecar and reconcile it against the evidence manifest.
 *
 * Provenance: a CI evidence bundle carries `source-identity.json` next to `evidence-manifest.json`. Both files
 * describe the source tree the bundle is evidence for, but from two different vantage points, which is why the
 * comparison is the point of the file. The identity sidecar records what the *capturing* shell observed
 * (`sourceCommit`, `sourceDirty`, the tree hash, the file count and byte total) plus an `expectedCommit` — the
 * commit the run believed it was producing evidence for. The manifest carries the same source facts under
 * snake_case names alongside `sha`, the commit the Actions checkout actually pointed at. On a `pull_request`
 * event those differ: the checkout resolves the merge ref, so `sha` is the synthesized merge commit while
 * `expectedCommit` and `sourceCommit` agree on the pull request's head. A verification that treats "the
 * manifest sha" and "the source commit" as the same field would flag exactly the case that is not a problem, so
 * the two are compared as a separate, deliberately named field.
 */

/** `source-identity.json`, in the shape it is serialized in (camelCase, unlike the manifest). */
export interface SourceIdentity {
  schemaVersion: number;
  sourceMode: string;
  sourceCommit: string;
  /** Commit the run intended to produce evidence for; may equal `sourceCommit`. */
  expectedCommit: string;
  sourceDirty: boolean;
  sourceTreeSha256: string;
  sourceFileCount: number;
  sourceBytes: number;
}

/** The schema version the identity format this parser reads is written against. */
export const SOURCE_IDENTITY_SCHEMA_VERSION = 2;

/** Result of parsing identity text. */
export interface ParsedSourceIdentity {
  ok: boolean;
  identity: SourceIdentity | undefined;
  /** Field-level problems, same vocabulary as the manifest parser. */
  issues: Array<{
    kind: "parse" | "schema_version" | "missing" | "type" | "value";
    field: string;
    message: string;
  }>;
}

/** Outcome of comparing one field across the two documents. */
export type IdentityFieldStatus = "match" | "mismatch" | "unknown";

/** One reconciled field. */
export interface SourceIdentityComparison {
  field: string;
  status: IdentityFieldStatus;
  /** Value the identity sidecar carries. */
  identity: string | number | boolean | undefined;
  /** Value the evidence manifest carries, `undefined` when the manifest omits it. */
  manifest: string | number | boolean | undefined;
  detail: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  return undefined;
}

/** Parse `source-identity.json` text. Missing fields are reported and left `undefined` on the result. */
export function parseSourceIdentity(text: string): ParsedSourceIdentity {
  const issues: ParsedSourceIdentity["issues"] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      identity: undefined,
      issues: [{ kind: "parse", field: "", message: `not valid JSON: ${message}` }],
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      identity: undefined,
      issues: [
        {
          kind: "type",
          field: "",
          message: `expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        },
      ],
    };
  }

  const need = (field: string, type: "string" | "number" | "boolean") => {
    const value = parsed[field];
    if (value === undefined) {
      issues.push({ kind: "missing", field, message: "required field is absent" });
      return undefined;
    }
    if (typeof value !== type) {
      issues.push({ kind: "type", field, message: `expected ${type}, got ${typeof value}` });
      return undefined;
    }
    return value;
  };
  const needString = (field: string) => need(field, "string") as string | undefined;
  const needBoolean = (field: string) => need(field, "boolean") as boolean | undefined;
  const needNumber = (field: string) => need(field, "number") as number | undefined;

  const schemaVersion = needNumber("schemaVersion");
  if (schemaVersion !== undefined && schemaVersion !== SOURCE_IDENTITY_SCHEMA_VERSION) {
    issues.push({
      kind: "schema_version",
      field: "schemaVersion",
      message: `expected ${SOURCE_IDENTITY_SCHEMA_VERSION}, got ${schemaVersion}`,
    });
  }

  const identity: SourceIdentity = {
    schemaVersion: needNumber("schemaVersion") ?? 0,
    sourceMode: needString("sourceMode") ?? "",
    sourceCommit: needString("sourceCommit") ?? "",
    expectedCommit: needString("expectedCommit") ?? "",
    sourceDirty: needBoolean("sourceDirty") ?? false,
    sourceTreeSha256: needString("sourceTreeSha256") ?? "",
    sourceFileCount: needNumber("sourceFileCount") ?? 0,
    sourceBytes: needNumber("sourceBytes") ?? 0,
  };

  return { ok: issues.length === 0, identity, issues };
}

/** Minimal view of the manifest: only the fields the reconciliation reads. */
export interface ManifestSourceView {
  sha: string;
  source_mode?: string;
  source_commit?: string;
  source_tree_sha256?: string;
  source_file_count?: number;
  source_bytes?: number;
  source_dirty?: boolean;
}

const IDENTITY_TO_MANIFEST: Array<{
  field: string;
  identityKey: keyof SourceIdentity;
  manifestKey: keyof ManifestSourceView;
  detail: string;
}> = [
  {
    field: "sourceMode",
    identityKey: "sourceMode",
    manifestKey: "source_mode",
    detail: "how the source tree was captured",
  },
  {
    field: "sourceCommit",
    identityKey: "sourceCommit",
    manifestKey: "source_commit",
    detail: "head commit of the captured tree",
  },
  {
    field: "sourceTreeSha256",
    identityKey: "sourceTreeSha256",
    manifestKey: "source_tree_sha256",
    detail: "SHA-256 of the captured tree",
  },
  {
    field: "sourceFileCount",
    identityKey: "sourceFileCount",
    manifestKey: "source_file_count",
    detail: "file count of the captured tree",
  },
  {
    field: "sourceBytes",
    identityKey: "sourceBytes",
    manifestKey: "source_bytes",
    detail: "byte total of the captured tree",
  },
  {
    field: "sourceDirty",
    identityKey: "sourceDirty",
    manifestKey: "source_dirty",
    detail: "whether the tree had uncommitted changes",
  },
];

/**
 * Reconcile the identity sidecar with the evidence manifest, field by field. Each source fact is compared across
 * the two documents and labelled `unknown` when the manifest does not state it — the identity sidecar is the
 * authority in that case, not a contradiction. The checked-out commit is compared against the sidecar's
 * `expectedCommit` rather than its `sourceCommit`, because a merge-ref checkout makes the two legitimately
 * differ.
 */
export function compareSourceIdentity(
  identity: SourceIdentity,
  manifest: ManifestSourceView,
): SourceIdentityComparison[] {
  const comparisons: SourceIdentityComparison[] = [];

  for (const mapping of IDENTITY_TO_MANIFEST) {
    const identityValue = scalar(identity[mapping.identityKey]);
    const manifestValue = scalar(manifest[mapping.manifestKey]);
    const status: IdentityFieldStatus =
      manifestValue === undefined
        ? "unknown"
        : identityValue === manifestValue
          ? "match"
          : "mismatch";
    comparisons.push({
      field: mapping.field,
      status,
      identity: identityValue,
      manifest: manifestValue,
      detail: mapping.detail,
    });
  }

  const sha = scalar(manifest.sha);
  comparisons.push({
    field: "checkedOutSha",
    status:
      sha === undefined || identity.expectedCommit === ""
        ? "unknown"
        : sha === identity.expectedCommit
          ? "match"
          : "mismatch",
    identity: identity.expectedCommit,
    manifest: sha,
    detail: "commit the checkout resolved to, against the commit the run intended to evidence",
  });

  return comparisons;
}

/** Roll-up of a field-by-field reconciliation. */
export interface IdentityComparisonSummary {
  matches: number;
  mismatches: number;
  unknowns: number;
  /** Names of the fields that disagreed. */
  mismatchedFields: string[];
  /** `true` when no field disagreed. Unknowns are not failures. */
  clean: boolean;
}

/** Count a reconciliation by outcome. Unknown fields do not make the comparison unclean. */
export function summarizeIdentityComparison(
  comparisons: SourceIdentityComparison[],
): IdentityComparisonSummary {
  let matches = 0;
  let mismatches = 0;
  let unknowns = 0;
  const mismatchedFields: string[] = [];
  for (const comparison of comparisons) {
    if (comparison.status === "match") matches += 1;
    else if (comparison.status === "mismatch") {
      mismatches += 1;
      mismatchedFields.push(comparison.field);
    } else unknowns += 1;
  }
  return { matches, mismatches, unknowns, mismatchedFields, clean: mismatches === 0 };
}
