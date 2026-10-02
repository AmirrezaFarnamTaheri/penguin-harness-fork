import { createHash } from "node:crypto";
import { FindingsGraph, UnknownFindingError } from "./findings-graph.js";
import {
  FINDING_KINDS,
  FINDING_STATUSES,
  type FindingQuery,
  type FindingReadback,
  type FindingsPageAction,
  type FindingsPageEnvelope,
} from "./types.js";
import { FindingValidationError } from "./validation.js";
import type { FindingsRead } from "./store.js";

interface Cursor {
  version: 1;
  scope: string;
  revision: string;
  filterHash: string;
  lastKey: string;
}
export class FindingsCursorError extends Error {
  constructor(
    readonly code:
      | "invalid_cursor"
      | "cursor_mismatch"
      | "stale_cursor"
      | "event_gap"
      | "budget_too_small"
      | "compatibility_output_too_large",
    message: string,
    readonly earliestSequence?: number,
  ) {
    super(message);
    this.name = "FindingsCursorError";
  }
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function decode(value: unknown): Cursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new FindingsCursorError(
      "invalid_cursor",
      "Invalid findings cursor. Restart without a cursor.",
    );
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(Buffer.from(value, "base64url")),
    );
    const c = decoded as Cursor;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      c.version !== 1 ||
      typeof c.scope !== "string" ||
      typeof c.revision !== "string" ||
      typeof c.filterHash !== "string" ||
      typeof c.lastKey !== "string"
    )
      throw new Error("Invalid cursor fields");
    return c;
  } catch {
    throw new FindingsCursorError(
      "invalid_cursor",
      "Invalid findings cursor. Restart without a cursor.",
    );
  }
}

/** Never slices JSON. Tiny configured budgets receive a smaller, documented JSON failure. */
export function boundedFindingsJson(value: unknown, budget: number): string {
  const serialized = JSON.stringify(value);
  if (byteLength(serialized) <= budget) return serialized;
  const failure = JSON.stringify({
    version: 2,
    error: { code: "budget_too_small", message: "Increase the output byte budget.", restart: true },
  });
  if (byteLength(failure) <= budget) return failure;
  const small = '{"error":"budget_too_small"}';
  if (byteLength(small) <= budget) return small;
  return budget >= 2 ? "{}" : "0";
}

function numberArgument(value: unknown, field: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (field === "since" ? 0 : 1) ||
    value > max
  )
    throw new FindingValidationError(`${field} must be a safe integer in its allowed range.`);
  return value;
}
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 10000)
    throw new FindingValidationError(`${field} must be a string of at most 10000 characters.`);
  return value.trim() || undefined;
}
function queryArguments(args: Record<string, unknown>): FindingQuery {
  for (const [field, allowed] of [
    ["kind", FINDING_KINDS],
    ["status", FINDING_STATUSES],
  ] as const) {
    const value = args[field];
    if (
      value !== undefined &&
      (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    )
      throw new FindingValidationError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  if (
    args.tags !== undefined &&
    (!Array.isArray(args.tags) ||
      args.tags.length > 50 ||
      !args.tags.every((tag) => typeof tag === "string" && tag.length <= 100))
  )
    throw new FindingValidationError("tags must be an array of at most 50 short strings.");
  return {
    text: optionalText(args.text, "text"),
    subject: optionalText(args.subject, "subject"),
    kind: args.kind as FindingQuery["kind"],
    status: args.status as FindingQuery["status"],
    tags:
      args.tags === undefined
        ? undefined
        : [...new Set((args.tags as string[]).map((tag) => tag.trim().toLowerCase()))].sort(),
  };
}
function recallId(id: string): string {
  return `recall:${hash(id)}`;
}
function summary(finding: FindingReadback): unknown {
  return {
    ...(byteLength(finding.id) <= 256 ? { id: finding.id } : {}),
    recallId: recallId(finding.id),
    oversized: true,
    title: [...finding.title].slice(0, 40).join(""),
    status: finding.status,
    kind: finding.kind,
    authoredBy: finding.authoredBy,
    evidenceTiers: finding.evidenceTiers,
    recallAction: "recall",
  };
}
function eventSummary(value: Record<string, unknown>): unknown {
  return {
    seq: value.seq,
    type: value.type,
    oversized: true,
    recallId: `event:${value.seq}`,
    recallAction: "recall",
  };
}
function archiveSummary(value: {
  operationId: string;
  archivedAt: number;
  finding: FindingReadback;
}): unknown {
  return {
    ...(byteLength(value.finding.id) <= 256 ? { id: value.finding.id } : {}),
    recallId: recallId(value.finding.id),
    operationId: value.operationId,
    archivedAt: value.archivedAt,
    oversized: true,
    title: [...value.finding.title].slice(0, 40).join(""),
    status: value.finding.status,
    kind: value.finding.kind,
    authoredBy: value.finding.authoredBy,
    evidenceTiers: value.finding.evidenceTiers,
    recallAction: "recall",
  };
}

/** Version 2 pages bind scope, filters, revision, and the last stable record identity/sequence. */
export function findingsPage(
  read: FindingsRead,
  action: FindingsPageAction,
  args: Record<string, unknown>,
  budget: number,
): { text: string; failed: boolean } {
  if (!read.graph || read.recovery) throw new Error("Paging requires a readable findings scope.");
  const graph: FindingsGraph = read.graph;
  const envelope: FindingsPageEnvelope = {
    version: 2,
    action,
    items: [],
    scopeRevision: read.revision,
    latestSequence: graph.eventHighWater(),
    nextCursor: null,
    truncated: false,
    omittedCount: 0,
    highWater: read.highWater,
  };
  try {
    const outputVersion = args.outputVersion ?? 2;
    if (outputVersion !== 1 && outputVersion !== 2)
      throw new FindingValidationError("outputVersion must be 1 or 2.");
    const limit = numberArgument(args.limit, "limit", outputVersion === 1 ? 20 : 200, 200);
    const since = numberArgument(args.since, "since", 0, Number.MAX_SAFE_INTEGER);
    const query = queryArguments(args);
    const requestedId = optionalText(args.id, "id");
    const filterHash = hash(
      JSON.stringify({
        action,
        query: action === "query" ? query : undefined,
        since: action === "events" ? since : undefined,
        id:
          action === "recall" || action === "snapshot" || action === "archive"
            ? requestedId
            : undefined,
        limit,
      }),
    );
    const cursor = decode(args.cursor);
    const scopeKey = hash(read.scope.id);
    if (cursor && (cursor.scope !== scopeKey || cursor.filterHash !== filterHash))
      throw new FindingsCursorError(
        "cursor_mismatch",
        "Cursor belongs to a different scope or filter. Restart without it.",
      );
    const allEvents = graph.since();
    if (action === "events") {
      const earliest = allEvents[0]?.seq;
      const requested = cursor ? Number(cursor.lastKey) : since;
      if (!Number.isSafeInteger(requested) || requested < 0)
        throw new FindingsCursorError("invalid_cursor", "Invalid event cursor sequence.");
      if (
        (earliest !== undefined && requested < earliest - 1) ||
        (earliest === undefined && graph.list().length > 0)
      )
        throw new FindingsCursorError(
          "event_gap",
          "The retained log does not cover this request. Read a snapshot and restart event replay.",
          earliest,
        );
    }
    if (cursor && cursor.revision !== read.revision)
      throw new FindingsCursorError(
        "stale_cursor",
        "Findings changed during pagination. Restart without a cursor.",
      );

    if (action === "recall") {
      if (!requestedId) throw new FindingValidationError("recall requires id.");
      let value: unknown;
      if (/^event:\d+$/.test(requestedId))
        value = allEvents.find((event) => `event:${event.seq}` === requestedId);
      else {
        const live = graph
          .list()
          .find((f) => f.id === requestedId || recallId(f.id) === requestedId);
        if (live) value = graph.readback(live.id);
        else {
          const archived = graph
            .archived()
            .find(
              (entry) =>
                entry.finding.id === requestedId || recallId(entry.finding.id) === requestedId,
            );
          if (archived) value = graph.archivedReadback(archived.finding.id);
        }
      }
      if (value === undefined) throw new UnknownFindingError(requestedId);
      const bytes = Buffer.from(JSON.stringify(value), "utf8");
      const offset = cursor ? Number(cursor.lastKey) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length)
        throw new FindingsCursorError("invalid_cursor", "Invalid recall cursor offset.");
      let low = 1,
        high = Math.min(bytes.length - offset, budget),
        best: string | undefined;
      while (low <= high) {
        const count = Math.floor((low + high) / 2),
          next = offset + count;
        const candidate = {
          ...envelope,
          items: [
            {
              recallId: requestedId,
              encoding: "base64-json",
              offset,
              data: bytes.subarray(offset, next).toString("base64"),
            },
          ],
          omittedCount: bytes.length - next,
          truncated: next < bytes.length,
          nextCursor:
            next < bytes.length
              ? encode({
                  version: 1,
                  scope: scopeKey,
                  revision: read.revision,
                  filterHash,
                  lastKey: String(next),
                })
              : null,
        };
        const text = JSON.stringify(candidate);
        if (byteLength(text) <= budget) {
          best = text;
          low = count + 1;
        } else high = count - 1;
      }
      if (!best)
        throw new FindingsCursorError(
          "budget_too_small",
          "Budget cannot fit a recall page and its cursor. Increase it.",
        );
      return { text: best, failed: false };
    }

    const findings =
      action === "query"
        ? graph.query(query)
        : graph
            .list()
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .filter(
              (f) =>
                requestedId === undefined || f.id === requestedId || recallId(f.id) === requestedId,
            );
    const archived =
      action === "archive"
        ? graph
            .archived()
            .filter(
              (entry) =>
                requestedId === undefined ||
                entry.finding.id === requestedId ||
                recallId(entry.finding.id) === requestedId,
            )
            .map((entry) => graph.archivedReadback(entry.finding.id)!)
            .sort((a, b) => a.archivedAt - b.archivedAt || a.finding.id.localeCompare(b.finding.id))
        : [];
    const values: unknown[] =
      action === "events"
        ? allEvents.filter((event) => event.seq > since)
        : action === "archive"
          ? archived
          : findings.map((f) => {
              const view = graph.readback(f.id);
              if (action === "snapshot") return view;
              return {
                id: f.id,
                title: f.title,
                kind: f.kind,
                status: f.status,
                confidence: f.confidence,
                severity: f.severity,
                subjects: f.subjects,
                authoredBy: view.authoredBy,
                author: view.author,
                evidenceTiers: view.evidenceTiers,
                strength: Number(graph.strength(f.id).toFixed(3)),
              };
            });
    const key = (value: unknown) =>
      action === "events"
        ? String((value as { seq: number }).seq)
        : action === "archive"
          ? (value as { finding: { id: string } }).finding.id
          : (value as { id: string }).id;
    const stableKey = (value: unknown) => (action === "events" ? key(value) : hash(key(value)));
    if (outputVersion === 1) {
      if (cursor)
        throw new FindingsCursorError(
          "cursor_mismatch",
          "Compatibility version 1 does not accept cursors. Use outputVersion 2.",
        );
      const legacy =
        action === "snapshot"
          ? (() => {
              const { archive: _archive, ...snapshot } = graph.exportReadbackSnapshot();
              return snapshot;
            })()
          : action === "query"
            ? values.slice(0, limit)
            : values;
      const text = JSON.stringify(legacy);
      if (byteLength(text) > budget)
        throw new FindingsCursorError(
          "compatibility_output_too_large",
          "Version 1 cannot fit this result. Restart with outputVersion 2.",
        );
      return { text, failed: false };
    }
    let start = 0;
    if (cursor) {
      const index = values.findIndex((value) => stableKey(value) === cursor.lastKey);
      if (index < 0)
        throw new FindingsCursorError(
          "cursor_mismatch",
          "Cursor sort key is absent. Restart without it.",
        );
      start = index + 1;
    }
    let best = JSON.stringify({ ...envelope, omittedCount: values.length - start });
    if (byteLength(best) > budget)
      throw new FindingsCursorError(
        "budget_too_small",
        "Budget cannot fit the page envelope. Increase it.",
      );
    let accepted = 0,
      hasSummary = false;
    for (let i = start; i < values.length && accepted < limit; i++) {
      const next = i + 1;
      const nextCursor =
        next < values.length
          ? encode({
              version: 1,
              scope: scopeKey,
              revision: read.revision,
              filterHash,
              lastKey: stableKey(values[i]),
            })
          : null;
      const candidate = (item: unknown, summarized = false) => ({
        ...envelope,
        items: [...envelope.items, item],
        nextCursor,
        truncated: next < values.length || hasSummary || summarized,
        omittedCount: values.length - next,
      });
      let item = values[i],
        summarized = false;
      let text = JSON.stringify(candidate(item));
      if (byteLength(text) > budget) {
        if (accepted > 0) break;
        item =
          action === "events"
            ? eventSummary(values[i] as Record<string, unknown>)
            : action === "archive"
              ? archiveSummary(values[i] as Parameters<typeof archiveSummary>[0])
              : summary(graph.readback(key(values[i])));
        summarized = true;
        text = JSON.stringify(candidate(item, true));
        if (byteLength(text) > budget)
          throw new FindingsCursorError(
            "budget_too_small",
            "Budget cannot fit a record summary and its cursor. Increase it.",
          );
      }
      envelope.items.push(item);
      accepted++;
      hasSummary ||= summarized;
      best = text;
    }
    return { text: best, failed: false };
  } catch (error) {
    if (
      error instanceof FindingsCursorError ||
      error instanceof FindingValidationError ||
      error instanceof UnknownFindingError
    ) {
      const failure = {
        ...envelope,
        error: {
          code:
            error instanceof FindingsCursorError
              ? error.code
              : error instanceof UnknownFindingError
                ? "unknown_finding"
                : "invalid_arguments",
          message: error.message,
          restart: error instanceof FindingsCursorError,
          ...(error instanceof FindingsCursorError && error.earliestSequence !== undefined
            ? { earliestSequence: error.earliestSequence }
            : {}),
          ...(action === "events" ? { latestSequence: graph.eventHighWater() } : {}),
        },
      };
      return { text: boundedFindingsJson(failure, budget), failed: true };
    }
    throw error;
  }
}
