/**
 * edit_file — exact-string file editing tool, a builtin tool implementation (BuiltinTool).
 *
 * Replaces `old_string` with `new_string` in an existing file. `old_string` is matched against
 * the file's **LF view** — the content with every line terminator normalized to LF — so a
 * multi-line `old_string` quoted from read_file's output (which strips the `\r`) matches a file
 * whose bytes are CRLF, and `new_string` may be written in either style too: the result is
 * written back in the file's own dominant terminator, preserving it (see line-endings.ts).
 * A file with no line terminators at all keeps exactly the bytes supplied. `old_string` must
 * still be unique in that view unless `replace_all` is set (whitespace/indentation included) —
 * zero or multiple occurrences fail with an explanation telling the model to fix the match or
 * widen the context. On success the output confirms the replacement count and shows a
 * git-style unified diff of the changed regions (one hunk per replacement site, nearby sites
 * merged; capped for replace_all storms), so both the model and the user can verify exactly
 * what changed without re-reading the file. The write is atomic (temp file + rename,
 * preserving the original permission bits), so a crash mid-write cannot leave the file
 * half-edited; a symlinked path is followed to the file it names, the same way the read that
 * produced the diff was. Relative paths resolve against the Workspace; absolute paths are
 * allowed (tools run with the user's full permissions, same as the shell tool).
 *
 * Division of responsibility with Environment (see environment.ts): non-streaming — yields
 * one final text delta; failures are explanatory text finalized as `failed`; anything
 * unexpected that still throws is caught by Environment and likewise finalized as failed.
 * If interrupted, only reports `aborted` — the interruption note is appended by
 * Environment.
 * Docs: /docs/tools § "File tools".
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { partialToolCallOutput } from "../../omnimessage/index.js";
import type { OmniMessage } from "../../omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../interfaces/index.js";
import type { BuiltinTool, ToolExecutionContext, ToolResult } from "./types.js";
import { atomicWriteFile } from "../../internal/atomic-write.js";
import { buildReplacementHunks, renderHunk } from "./diff.js";
import {
  countLineEndings,
  dominantTerminatorForWrite,
  lineEndingStyleFromCounts,
  lineEndingStyleLabel,
  normalizeLineEndings,
  restoreLineEndings,
} from "./line-endings.js";
import { missingPathHint } from "./path-hint.js";
import { describeArgumentError } from "./tool-arguments.js";

/** Tool name constant (used only within this tool module, never exposed to Environment). */
export const EDIT_FILE_NAME = "edit_file";

/** Max diff hunks shown in the result (replace_all over a large file stays readable). */
const MAX_DIFF_HUNKS = 5;

/** Output-budget headroom reserved for the trailing "…and N more replacements" note. */
const NOTE_RESERVE = 120;

/** Fallback output budget when the definition carries no maxOutputLength (mirrors the default config entry). */
const DEFAULT_OUTPUT_BUDGET = 16000;

/** Counts non-overlapping occurrences of `needle` in `haystack` (needle is non-empty here). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * edit_file builtin tool: reads the file, validates the uniqueness of `old_string`,
 * writes the replaced content back atomically, and reports a unified diff of the change.
 * `definition` is overridden by Environment at construction time with the same-named entry
 * from ToolConfig (description/arguments/permissions/limits).
 */
export function createEditFileTool(definition: ToolDefinitionConfig): BuiltinTool {
  return {
    name: definition.name,
    definition,
    async *execute(
      args: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ): AsyncGenerator<OmniMessage, ToolResult | void> {
      const { toolCallId, signal } = ctx;
      const delta = (output: string): OmniMessage =>
        partialToolCallOutput({ eventType: "delta", output, toolCallId });

      const filePath = args["file_path"];
      if (typeof filePath !== "string" || filePath.length === 0) {
        yield delta(
          describeArgumentError(definition, args, { argument: "file_path", kind: "missing" }),
        );
        return { stopReason: "fatal" };
      }
      const oldString = args["old_string"];
      if (typeof oldString !== "string") {
        yield delta(
          describeArgumentError(definition, args, { argument: "old_string", kind: "missing" }),
        );
        return { stopReason: "fatal" };
      }
      if (oldString.length === 0) {
        yield delta(
          describeArgumentError(
            definition,
            args,
            { argument: "old_string", kind: "missing" },
            {
              hint: `${definition.name} replaces existing text; to create a file or rewrite it wholesale, use write_file.`,
            },
          ),
        );
        return { stopReason: "fatal" };
      }
      const newString = args["new_string"];
      if (typeof newString !== "string") {
        yield delta(
          describeArgumentError(definition, args, { argument: "new_string", kind: "missing" }),
        );
        return { stopReason: "fatal" };
      }
      if (oldString === newString) {
        yield delta(
          "old_string and new_string are identical — nothing to change. Make new_string the desired replacement text.",
        );
        return { stopReason: "fatal" };
      }
      const replaceAll = args["replace_all"] === true;

      const resolved = path.resolve(ctx.workspaceDir, filePath);
      let content: string;
      let fileMode: number | undefined;
      try {
        const st = await stat(resolved);
        if (st.isDirectory()) {
          yield delta(`Cannot edit "${filePath}": it is a directory.`);
          return { stopReason: "fatal" };
        }
        fileMode = st.mode & 0o777;
        content = await readFile(resolved, { encoding: "utf8", ...(signal ? { signal } : {}) });
      } catch (err) {
        if (signal?.aborted) return { stopReason: "aborted" };
        const code = (err as NodeJS.ErrnoException).code;
        // ENOTDIR is the same mistake seen one segment later (a file used as a directory),
        // so it gets the same diagnosis instead of a raw errno message.
        if (code === "ENOENT" || code === "ENOTDIR") {
          const hint = await missingPathHint(resolved);
          yield delta(
            `File not found: "${filePath}". edit_file only edits existing files — check the path (absolute paths are supported), or use write_file to create it.${hint}`,
          );
        } else {
          const message = err instanceof Error ? err.message : String(err);
          yield delta(`Failed to read "${filePath}": ${message}`);
        }
        return { stopReason: "fatal" };
      }
      if (signal?.aborted) return { stopReason: "aborted" };

      // The file's line endings are the whole reason this tool normalizes: read_file strips
      // every \r from what it shows, so an old_string quoted from that display has bare \n
      // while the file's bytes carry \r\n. Match in the file's LF view, and write the result
      // back in the file's dominant terminator (see line-endings.ts). An LF file's view is the
      // content itself and the write-back is a no-op, so nothing changes for the common case.
      const writeTerminator = dominantTerminatorForWrite(content);
      const view = writeTerminator === null ? content : normalizeLineEndings(content, "lf");
      const oldView = normalizeLineEndings(oldString, "lf");
      const newView = normalizeLineEndings(newString, "lf");

      const occurrences = countOccurrences(view, oldView);
      if (occurrences === 0) {
        // Matching is normalized, so a miss is genuinely about the text; the file's style is
        // still worth naming, because it tells the model the tool has already handled \r and
        // the fix is in the content, not the line endings.
        const style = lineEndingStyleFromCounts(countLineEndings(content));
        const styleHint =
          style === "lf" || style === "none"
            ? ""
            : ` Note: the file uses ${lineEndingStyleLabel(style)} line endings — line endings are normalized for matching, so quote the text exactly as read_file displays it (no \\r).`;
        yield delta(
          `old_string not found in "${filePath}". Make sure it matches the file content exactly, including whitespace and indentation.${styleHint}`,
        );
        return { stopReason: "fatal" };
      }
      if (occurrences > 1 && !replaceAll) {
        yield delta(
          `old_string occurs ${occurrences} times in "${filePath}". Add surrounding context to make it unique, or set replace_all to true to replace every occurrence.`,
        );
        return { stopReason: "fatal" };
      }

      const replaceStart = view.indexOf(oldView);
      const replacedView = replaceAll
        ? view.split(oldView).join(newView)
        : view.slice(0, replaceStart) + newView + view.slice(replaceStart + oldView.length);
      // Back to the file's own terminator (or the caller's bytes when the file had none).
      const newContent =
        writeTerminator === null ? replacedView : restoreLineEndings(replacedView, writeTerminator);
      try {
        await atomicWriteFile(resolved, newContent, {
          ...(fileMode !== undefined ? { mode: fileMode } : {}),
          ...(signal ? { signal } : {}),
          followSymlinks: true,
        });
      } catch (err) {
        if (signal?.aborted) return { stopReason: "aborted" };
        const message = err instanceof Error ? err.message : String(err);
        yield delta(`Failed to write "${filePath}": ${message}`);
        return { stopReason: "fatal" };
      }

      const replaced = replaceAll ? occurrences : 1;
      // Runtime-recorded editor attribution (option A): who ran this edit and what the file's
      // bytes were before/after, so a later agent can tell whether the file changed since.
      // Emitted only after the write succeeded — a failed edit gets no receipt. Absent
      // attribution (bare embedders) keeps the historical output shape.
      const attribution = ctx.attribution;
      const sha256 = (bytes: string): string =>
        createHash("sha256").update(bytes, "utf8").digest("hex");
      // Git-style unified diff of the changed regions, self-budgeted below the tool's
      // output cap so the leading summary line (and the elision note) always survive
      // Environment's front-keep truncation.
      // The diff is built in the same LF view the replacement was matched in — its site
      // search would not find an LF old_string in CRLF content, and the rendered lines stay
      // \r-free either way (renderHunk strips a trailing \r for display).
      const { hunks } = buildReplacementHunks(view, oldView, newView, replaceAll, MAX_DIFF_HUNKS);
      const budget =
        definition.maxOutputLength !== undefined && definition.maxOutputLength > 0
          ? definition.maxOutputLength
          : DEFAULT_OUTPUT_BUDGET;
      const out: string[] = [
        `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in "${filePath}".`,
      ];
      if (attribution) {
        out.push(
          `[editor attribution: agent=${attribution.agentId} session=${attribution.sessionId} call=${toolCallId} at=${new Date().toISOString()} sha256_before=${sha256(content)} sha256_after=${sha256(newContent)}]`,
        );
      }
      let used = out.reduce((n, line) => n + line.length + 1, 0) - 1;
      let shownSites = 0;
      for (const { hunk, sites } of hunks) {
        const rendered = renderHunk(hunk);
        if (used + 1 + rendered.length > budget - NOTE_RESERVE) break;
        out.push(rendered);
        used += 1 + rendered.length;
        shownSites += sites;
      }
      const omitted = replaced - shownSites;
      if (omitted > 0) {
        out.push(`…and ${omitted} more replacement${omitted === 1 ? "" : "s"}`);
      }
      yield delta(out.join("\n"));
      return;
    },
  };
}
