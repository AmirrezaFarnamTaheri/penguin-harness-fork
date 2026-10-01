import {
  EVIDENCE_TIERS,
  FINDING_CONFIDENCE,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  type FindingEvidence,
  type FindingSource,
  type ReportFindingInput,
} from "./types.js";

export const FINDING_FIELD_LIMITS = {
  title: 300,
  body: 50_000,
  subjects: 100,
  subject: 500,
  evidence: 100,
  evidencePath: 500,
  evidenceText: 2000,
  tags: 50,
  tag: 100,
} as const;

export class FindingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingValidationError";
  }
}

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new FindingValidationError(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > max || !value.trim()) {
    throw new FindingValidationError(
      `${field} must be a non-empty string of at most ${max} characters.`,
    );
  }
  return value.trim();
}

function enumeration<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new FindingValidationError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function strings(
  value: unknown,
  field: string,
  count: number,
  length: number,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > count) {
    throw new FindingValidationError(`${field} must be an array of at most ${count} entries.`);
  }
  return value.map((entry) => text(entry, `${field} entry`, length, true)!);
}

/** Same validation at both ingress boundaries. Identity is supplied separately by the host. */
export function validateReportInput(
  raw: Record<string, unknown>,
  source?: FindingSource,
): ReportFindingInput {
  const caps = FINDING_FIELD_LIMITS;
  let evidence: FindingEvidence[] | undefined;
  if (raw.evidence !== undefined && raw.evidence !== null) {
    if (!Array.isArray(raw.evidence) || raw.evidence.length > caps.evidence) {
      throw new FindingValidationError(
        `evidence must be an array of at most ${caps.evidence} entries.`,
      );
    }
    evidence = raw.evidence.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new FindingValidationError("evidence entries must be objects.");
      }
      const e = value as Record<string, unknown>;
      const tier = enumeration(e.tier, "evidence tier", EVIDENCE_TIERS);
      if (!tier) throw new FindingValidationError("evidence tier is required.");
      if (e.line !== undefined && (!Number.isSafeInteger(e.line) || (e.line as number) < 0)) {
        throw new FindingValidationError("evidence line must be a non-negative safe integer.");
      }
      return {
        tier,
        path: text(e.path, "evidence path", caps.evidencePath),
        line: e.line as number | undefined,
        quote: text(e.quote, "evidence quote", caps.evidenceText),
        note: text(e.note, "evidence note", caps.evidenceText),
      };
    });
  }
  return {
    title: text(raw.title, "title", caps.title, true)!,
    body: text(raw.body, "body", caps.body),
    kind: enumeration(raw.kind, "kind", FINDING_KINDS),
    confidence: enumeration(raw.confidence, "confidence", FINDING_CONFIDENCE),
    severity: enumeration(raw.severity, "severity", FINDING_SEVERITIES),
    subjects: strings(raw.subjects, "subjects", caps.subjects, caps.subject),
    tags: strings(raw.tags, "tags", caps.tags, caps.tag),
    evidence,
    ...(source ? { source: { ...source } } : {}),
  };
}
