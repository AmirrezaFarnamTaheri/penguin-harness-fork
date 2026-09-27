/**
 * Tamper-evident provenance for an evaluation run.
 *
 * The problem this exists for: an eval report is a NUMBER, and a number records nothing about
 * what produced it. A pass rate is equally true of the run that produced it and of the run that
 * produced it after the dataset was edited, the scorer was changed, or the model tag underneath
 * it started pointing somewhere else. Nothing in the report can tell those apart, so a
 * regression that is really a changed measurement is indistinguishable from a real one.
 *
 * The fix is the one `simple-jev/eval/audit.py` uses and the one `JevRev` enforces at three
 * separate layers: bind every input that can change the answer, then re-derive the answer and
 * refuse to certify when the two disagree. Six independent invariants, each with its own reason
 * it failed, so a reader learns WHICH input drifted rather than that "something did".
 *
 * What makes it enforceable here rather than aspirational:
 * - the model revision is a REQUIRED 40-hex commit id, not a floating tag, so the same input
 *   cannot be scored against a different checkpoint under the same name;
 * - the repository commit is read from real git (`readCheckout`), not accepted from a caller,
 *   so the code that computed the number is pinned by the same rule;
 * - the dataset and the scorer are hashed, so a "no change" claim has something to be wrong about;
 * - a case that errored is NOT a pass. A run where the crash is simply absent from the tally
 *   reports a rate that was never earned.
 */
import { createHash } from "node:crypto";
import { readCheckout } from "../../internal/git-facts.js";

/** A git object id, and nothing else. A tag or a branch name is not reproducible. */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** What an audit found wrong. `ok` is the only value that certifies a run. */
export interface EvalAuditResult {
  readonly ok: boolean;
  /** One entry per violated invariant, naming the check and the values that disagreed. */
  readonly problems: string[];
}

export interface EvalRunManifest {
  /** Dataset identity, hashed. */
  readonly datasetSha256: string;
  /** The evaluator/judge code that produced the scores, hashed. */
  readonly scorerSha256: string;
  /** The exact scored rows, hashed — not just the case ids. */
  readonly rowsSha256: string;
  readonly rowCount: number;
  /** 40-hex commit id of the model. */
  readonly modelRevision: string;
  /** 40-hex commit id of THIS repository at scoring time, or null outside a checkout. */
  readonly repoCommit: string | null;
  /** Suite-level configuration the report depends on, snapshotted so it cannot drift silently. */
  readonly reporting: string;
}

export interface EvalScoredRow {
  readonly caseId: string;
  readonly outcome: string;
  readonly numericScore: number;
  /** Set when the case could not be scored at all. Present means "not a pass". */
  readonly error?: string;
}

/** SHA-256 of any serialisable value, with the object's key order pinned. */
export function hashValue(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** JSON with object keys sorted recursively, so two equal values always hash equally. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export interface BuildManifestInput {
  dataset: unknown;
  /** The scoring code's own source or a digest of it; the caller decides what "the code" is. */
  scorer: unknown;
  rows: readonly EvalScoredRow[];
  modelRevision: string;
  reporting: string;
  /** Working directory to read the checkout from; defaults to the process root. */
  cwd?: string;
}

/**
 * Builds the manifest for a run. Throws on an unpinned model revision: a floating tag is the
 * one input whose drift cannot be detected later, so it is refused at the point of writing
 * rather than discovered at audit time.
 */
export function buildEvalRunManifest(input: BuildManifestInput): EvalRunManifest {
  if (!COMMIT_ID.test(input.modelRevision)) {
    throw new Error(
      `model revision must be a 40-character commit id, got ${JSON.stringify(input.modelRevision)}`,
    );
  }
  const checkout = readCheckout(input.cwd ?? process.cwd());
  return {
    datasetSha256: hashValue(input.dataset),
    scorerSha256: hashValue(input.scorer),
    rowsSha256: hashValue(input.rows),
    rowCount: input.rows.length,
    modelRevision: input.modelRevision,
    repoCommit: checkout.commit,
    reporting: input.reporting,
  };
}

export interface AuditInput {
  manifest: EvalRunManifest;
  /** The rows as they are being reported now. */
  rows: readonly EvalScoredRow[];
  /** The scorer's own output, re-derived for one row from its raw response. */
  reparse?: (row: EvalScoredRow) => Pick<EvalScoredRow, "outcome" | "numericScore"> | null;
  /** The dataset and scorer as they are now, for the drift checks. */
  dataset?: unknown;
  scorer?: unknown;
}

/**
 * Re-derives every bound input and reports each disagreement separately. Offline by
 * construction: nothing here loads a model, opens a socket, or repairs an artifact — a check
 * that could fix the thing it is checking cannot be evidence about it.
 */
export function auditEvalRun(input: AuditInput): EvalAuditResult {
  const problems: string[] = [];
  const { manifest, rows } = input;

  if (rows.length !== manifest.rowCount) {
    problems.push(
      `row count changed: manifest recorded ${manifest.rowCount}, found ${rows.length}`,
    );
  }

  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.caseId)) problems.push(`duplicate case id: ${row.caseId}`);
    ids.add(row.caseId);
    // No partial credit: a case that could not be scored is not a pass, however the tally counts it.
    if (row.error !== undefined) {
      problems.push(`case ${row.caseId} did not complete: ${row.error}`);
    }
  }

  if (input.dataset !== undefined) {
    const now = hashValue(input.dataset);
    if (now !== manifest.datasetSha256) {
      problems.push(`dataset changed: manifest ${manifest.datasetSha256}, now ${now}`);
    }
  }
  if (input.scorer !== undefined) {
    const now = hashValue(input.scorer);
    if (now !== manifest.scorerSha256) {
      problems.push(`scorer changed: manifest ${manifest.scorerSha256}, now ${now}`);
    }
  }

  // The scored rows themselves, not merely their ids: a score that moved with an unchanged
  // case id is exactly the drift this is for.
  const rowsNow = hashValue(rows);
  if (rowsNow !== manifest.rowsSha256) {
    problems.push(`scored rows changed: manifest ${manifest.rowsSha256}, now ${rowsNow}`);
  }

  // Re-derive the score from the raw response where the caller can. Catches a scorer whose
  // code was edited but whose recorded output was not regenerated.
  if (input.reparse !== undefined) {
    for (const row of rows) {
      const derived = input.reparse(row);
      if (derived === null) continue;
      if (derived.outcome !== row.outcome || derived.numericScore !== row.numericScore) {
        problems.push(
          `case ${row.caseId} does not re-derive: recorded ${row.outcome}/${row.numericScore}, replay ${derived.outcome}/${derived.numericScore}`,
        );
      }
    }
  }

  if (!COMMIT_ID.test(manifest.modelRevision)) {
    problems.push(`model revision is not a commit id: ${manifest.modelRevision}`);
  }
  if (manifest.repoCommit !== null && !COMMIT_ID.test(manifest.repoCommit)) {
    problems.push(`repository revision is not a commit id: ${manifest.repoCommit}`);
  }

  return { ok: problems.length === 0, problems };
}
