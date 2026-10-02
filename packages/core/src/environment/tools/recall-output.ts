/**
 * Session-scoped, path-free paging for oversized tool output.
 *
 * The archive is owned by one Environment (and therefore one Session). A model receives only
 * the opaque id and can retrieve bounded UTF-16-safe pages; filesystem paths never cross the
 * tool-result boundary.
 */
import { partialToolCallOutput } from "../../omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../interfaces/index.js";
import type { TruncatedToolOutputArchive } from "../truncated-tool-output-archive.js";
import type { BuiltinTool } from "./types.js";

export const RECALL_OUTPUT_NAME = "recall_output";
export const RECALL_OUTPUT_PAGE_CHARS = 12_000;

/**
 * The only shape a recall id may have: 12 or 32 lowercase hex characters. Published because every
 * recall surface (the tool, the HTTP route, the CLI) must apply the same rule, and because the
 * rule is what keeps an id from ever being a path: it has no separators, no dots and no
 * extension, so it can only ever name a file the archive itself wrote (F18.1).
 */
export const RECALL_ID_PATTERN = "^(?:[a-f0-9]{12}|[a-f0-9]{32})$";

const RECALL_ID_RE = new RegExp(RECALL_ID_PATTERN);

/** Whether `id` is a recall id at all; case is normalized first, as the store does. */
export function isValidRecallId(id: string): boolean {
  return RECALL_ID_RE.test(id.trim().toLowerCase());
}

export const RECALL_OUTPUT_DEFINITION: ToolDefinitionConfig = {
  name: RECALL_OUTPUT_NAME,
  description:
    "Read a page from oversized output saved in this Session. Use the recall_id shown in the result, begin at offset 0, and pass each returned next_offset as the next offset until complete. The id is private to this Session and expires with its archive entry.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      recall_id: { type: "string", pattern: RECALL_ID_PATTERN },
      offset: { type: "integer", minimum: 0 },
    },
    required: ["recall_id"],
  },
  permission: "r",
  maxOutputLength: RECALL_OUTPUT_PAGE_CHARS,
  timeoutMs: 5_000,
};

/**
 * One bounded page of an archived output, in UTF-16 code units so `offset`/`nextOffset` can be
 * passed straight back in.
 *
 * Shared by the model-facing `recall_output` tool and by host surfaces (HTTP route, CLI) so a
 * page is cut at exactly the same boundary wherever it is read: a page never splits a surrogate
 * pair, and `nextOffset` is null exactly when the text is complete. `invalid-offset` is its own
 * outcome rather than an empty page, because "you asked for a place that does not exist" and
 * "there is nothing more here" must not look the same to a caller (F18.1).
 */
export type RecallPageSlice =
  | { status: "ok"; page: string; nextOffset: number | null; totalChars: number }
  | { status: "invalid-offset"; totalChars: number };

export function sliceRecallPage(
  text: string,
  offset: number,
  pageChars: number = RECALL_OUTPUT_PAGE_CHARS,
): RecallPageSlice {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(pageChars) ||
    pageChars <= 0 ||
    offset > text.length ||
    isSplitSurrogate(text, offset)
  ) {
    return { status: "invalid-offset", totalChars: text.length };
  }
  let end = Math.min(text.length, offset + pageChars);
  if (end < text.length) {
    // A page must not end between the halves of a surrogate pair: the consumer would receive a
    // lone surrogate, and re-assembling pages would not give back the original text.
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return {
    status: "ok",
    page: text.slice(offset, end),
    nextOffset: end < text.length ? end : null,
    totalChars: text.length,
  };
}

function isSplitSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

function emitText(output: string, toolCallId: string): ReturnType<typeof partialToolCallOutput> {
  return partialToolCallOutput({ eventType: "delta", output, toolCallId });
}

export function createRecallOutputTool(archive: TruncatedToolOutputArchive): BuiltinTool {
  return {
    name: RECALL_OUTPUT_NAME,
    definition: RECALL_OUTPUT_DEFINITION,
    async *execute(args, ctx) {
      const id = typeof args.recall_id === "string" ? args.recall_id : "";
      const offset = args.offset === undefined ? 0 : args.offset;
      if (!isValidRecallId(id) || typeof offset !== "number") {
        yield emitText("Recall id or offset is invalid.", ctx.toolCallId);
        return { stopReason: "fatal" };
      }

      const result = await archive.recall(id);
      if (result.status !== "ok") {
        yield emitText(
          result.status === "dropped"
            ? "This Session's output archive entry has expired."
            : "This output id is unavailable in the current Session.",
          ctx.toolCallId,
        );
        return { stopReason: "fatal" };
      }

      const slice = sliceRecallPage(result.text, offset, RECALL_OUTPUT_PAGE_CHARS);
      if (slice.status === "invalid-offset") {
        yield emitText(
          "Recall offset is outside the output or splits a Unicode character.",
          ctx.toolCallId,
        );
        return { stopReason: "fatal" };
      }

      yield emitText(slice.page, ctx.toolCallId);
      const note =
        slice.nextOffset === null
          ? `[recall complete: ${slice.totalChars} UTF-16 code units]`
          : `[recall page: UTF-16 offsets ${offset}–${slice.nextOffset} of ${slice.totalChars}; next_offset ${slice.nextOffset}]`;
      return { note };
    },
  };
}
