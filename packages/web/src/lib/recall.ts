/**
 * Reading recall metadata out of a tool result, and paging the archived output back (F18.1).
 *
 * When a tool's output is too large to keep inline, the harness replaces it with a bounded
 * summary and a note carrying `{"recallId":"…","sizeBytes":N,"tokenCount":M}`; the model pages the
 * original back with `recall_output`. This module is the browser half of that handle: it finds the
 * metadata in a result's text (nothing else does — the renderer only shows the note), and walks
 * `GET /api/sessions/:id/recall/:recallId` page by page.
 *
 * Two rules the rest of the app relies on, and both are enforced here rather than at each call
 * site:
 *
 *   - an id is only ever what the note published. {@link parseRecallMetadata} accepts the exact
 *     12/32-hex shape and nothing else, so a note whose body happens to contain a path-like string
 *     cannot turn the UI into a file reader. This is the same rule the server route and the CLI
 *     apply (core's `RECALL_ID_PATTERN`); it is restated here because the browser must not send a
 *     request to find out, and because a shared import would drag core's Environment graph into
 *     the web bundle;
 *   - a fetch is bounded. {@link collectRecallText} reads at most `pageLimit` pages and reports
 *     what it has, so a caller cannot accidentally hold a multi-megabyte result in state while a
 *     turn is streaming.
 *
 * Deliberately free of DOM and React: the paging logic is what a test can hold still, and the
 * chip's render is asserted by its own component tests elsewhere.
 */

/** The id shape published in a recall note: 12 or 32 lowercase hex characters, and nothing else. */
export const RECALL_ID_RE = /^(?:[a-f0-9]{12}|[a-f0-9]{32})$/;

/** One page of a recalled output, as the server serves it (see server's RecallPageResponse). */
export interface RecallPage {
  recallId: string;
  offset: number;
  page: string;
  nextOffset: number | null;
  totalChars: number;
}

/** The metadata a result note publishes about an archived output. */
export interface RecallMetadata {
  recallId: string;
  /** Size of the archived text in bytes, when the note said so. */
  sizeBytes: number | null;
  /** The note's bytes/4 token estimate, when it said so. */
  tokenCount: number | null;
}

/**
 * The first recall metadata object in `text`, or null.
 *
 * The note is JSON embedded in prose (`[full output … {"recallId":"…","sizeBytes":…} … call
 * recall_output …]`), so this scans for balanced `{…}` runs and parses each with `JSON.parse`,
 * preferring the first that carries a valid `recallId`. A hand-rolled field regex would accept
 * ids inside a sentence that merely mentions one; parsing means the id really came from a
 * published metadata object.
 */
export function parseRecallMetadata(text: string): RecallMetadata | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const open = text.indexOf("{");
  if (open === -1) return null;
  for (let start = open; start !== -1; start = text.indexOf("{", start + 1)) {
    // Balanced-brace scan, string-aware enough for JSON: braces inside string literals do not
    // close the object.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = parseRecallCandidate(text.slice(start, i + 1));
          if (candidate !== null) return candidate;
          break; // this object is not metadata; continue from the next `{`
        }
      }
    }
  }
  return null;
}

function parseRecallCandidate(raw: string): RecallMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const id = typeof record.recallId === "string" ? record.recallId.trim().toLowerCase() : "";
  if (!RECALL_ID_RE.test(id)) return null;
  const sizeBytes =
    typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes)
      ? record.sizeBytes
      : null;
  const tokenCount =
    typeof record.tokenCount === "number" && Number.isFinite(record.tokenCount)
      ? record.tokenCount
      : null;
  return { recallId: id, sizeBytes, tokenCount };
}

/**
 * The URL of one page. The id is re-validated (a caller that bypassed {@link parseRecallMetadata}
 * gets a rejection rather than a URL), and it is percent-encoded so nothing in it can add a path
 * segment or a query parameter.
 */
export function recallPageUrl(sessionId: string, recallId: string, offset = 0): string {
  const id = recallId.trim().toLowerCase();
  if (!RECALL_ID_RE.test(id)) throw new Error("not a recall id");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid recall offset");
  return `/api/sessions/${encodeURIComponent(sessionId)}/recall/${id}?offset=${offset}`;
}

/** How a paged read ended: the whole text, a bounded prefix, or a failure the caller can show. */
export type RecallCollectOutcome =
  | { status: "complete"; text: string; pages: number }
  | { status: "partial"; text: string; pages: number; nextOffset: number }
  | { status: "failed"; text: string; pages: number; error: string };

/** The shape {@link collectRecallText} needs from a fetch — injected so tests hold it still. */
export type RecallFetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Walks the pages of one recall id, concatenating into `onChunk` as each arrives.
 *
 * Bounded on purpose: `pageLimit` caps the number of requests (so a UI control cannot walk a
 * multi-megabyte entry by accident), and a failure part-way through reports the text collected so
 * far as `partial`/`failed` rather than throwing it away — the reader keeps what was already
 * shown. `onChunk` is called per page instead of the text being returned whole so a caller can
 * stream into a reader pane; the accumulated text is returned too, because the small-entry case
 * (one page) is the common one and would otherwise have to re-assemble it.
 */
export async function collectRecallText(
  fetchPage: RecallFetch,
  opts: {
    sessionId: string;
    recallId: string;
    offset?: number;
    pageLimit?: number;
    onChunk?: (chunk: string) => void;
  },
): Promise<RecallCollectOutcome> {
  const pageLimit = opts.pageLimit ?? 20;
  let offset = opts.offset ?? 0;
  let text = "";
  let pages = 0;
  while (pages < pageLimit) {
    let response: Awaited<ReturnType<RecallFetch>>;
    try {
      response = await fetchPage(recallPageUrl(opts.sessionId, opts.recallId, offset));
    } catch (err) {
      return {
        status: pages === 0 ? "failed" : "partial",
        text,
        pages,
        ...(pages === 0
          ? { error: err instanceof Error ? err.message : String(err) }
          : { nextOffset: offset }),
      } as RecallCollectOutcome;
    }
    if (!response.ok) {
      const message = await readErrorMessage(response);
      return pages === 0
        ? { status: "failed", text, pages, error: message }
        : { status: "partial", text, pages, nextOffset: offset };
    }
    const body = (await response.json()) as Partial<RecallPage>;
    const chunk = typeof body.page === "string" ? body.page : "";
    pages += 1;
    if (chunk !== "") {
      text += chunk;
      opts.onChunk?.(chunk);
    }
    const next = typeof body.nextOffset === "number" ? body.nextOffset : null;
    if (next === null) return { status: "complete", text, pages };
    offset = next;
  }
  // Reached only when the page limit stopped the walk: the offset to continue from is the one the
  // last page named (the loop exits after assigning it), so the caller resumes without a gap.
  return { status: "partial", text, pages, nextOffset: offset };
}

/** The server's `{error:{message}}` body, or a status-shaped fallback. Never throws. */
async function readErrorMessage(response: {
  status: number;
  json(): Promise<unknown>;
}): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    if (typeof message === "string" && message.trim() !== "") return message;
  } catch {
    // fall through to the status text
  }
  return `HTTP ${response.status}`;
}
