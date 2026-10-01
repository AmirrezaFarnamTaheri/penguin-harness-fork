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

const RECALL_ID_PATTERN = "^(?:[a-f0-9]{12}|[a-f0-9]{32})$";

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

function isSplitSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

function emitText(
  output: string,
  toolCallId: string,
): ReturnType<typeof partialToolCallOutput> {
  return partialToolCallOutput({ eventType: "delta", output, toolCallId });
}

export function createRecallOutputTool(archive: TruncatedToolOutputArchive): BuiltinTool {
  return {
    name: RECALL_OUTPUT_NAME,
    definition: RECALL_OUTPUT_DEFINITION,
    async *execute(args, ctx) {
      const id = typeof args.recall_id === "string" ? args.recall_id : "";
      const offset = args.offset === undefined ? 0 : args.offset;
      if (
        !/^(?:[a-f0-9]{12}|[a-f0-9]{32})$/i.test(id) ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      ) {
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

      if (offset > result.text.length || isSplitSurrogate(result.text, offset)) {
        yield emitText("Recall offset is outside the output or splits a Unicode character.", ctx.toolCallId);
        return { stopReason: "fatal" };
      }

      let end = Math.min(result.text.length, offset + RECALL_OUTPUT_PAGE_CHARS);
      if (end < result.text.length) {
        const last = result.text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      }
      yield emitText(result.text.slice(offset, end), ctx.toolCallId);
      const note =
        end < result.text.length
          ? `[recall page: UTF-16 offsets ${offset}–${end} of ${result.text.length}; next_offset ${end}]`
          : `[recall complete: ${end} UTF-16 code units]`;
      return { note };
    },
  };
}
