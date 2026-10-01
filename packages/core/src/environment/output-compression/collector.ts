/**
 * The per-call buffer behind tool-output compression.
 *
 * Environment's contract is that concatenating the streamed deltas reproduces the complete
 * `tool_call_output` exactly, and a compressed result replaces the text. Those two facts cannot
 * both hold unless the deltas are withheld, so a call that is *going* to be compressed withholds
 * them and emits the compressed text as a single delta at finalization. The invariant then holds
 * trivially, and the model — the only consumer this feature exists for — reads the summary.
 *
 * The cost is honest and worth stating: a recognised high-volume output fills its tool card when
 * the command finishes rather than while it runs. That is invisible for `git log` or a test run
 * (the raw stream was noise) and it is confined to the classified types; everything unrecognised
 * streams live exactly as before.
 *
 * The buffer is the existing `TruncatedToolOutputCapture` rather than a new accumulator, so
 * memory stays bounded by the same per-call limit the truncation archive already uses, and the
 * overflow case can reuse that capture's head/tail windows instead of buffering a second copy.
 */
import type {
  TruncatedToolOutputArchive,
  TruncatedToolOutputCapture,
} from "../truncated-tool-output-archive.js";
import type { CompressionResult, OutputKind } from "./strategies.js";
import { compressOutput } from "./strategies.js";

/** Human-readable name of each strategy, for the note that tells the model what it is holding. */
const KIND_LABEL: Record<OutputKind, string> = {
  "test-runner": "test runner output",
  "git-log": "git log",
  "git-status": "git status",
  "git-diff": "git diff",
  lint: "lint output",
  "log-dedup": "log output",
};

/**
 * The note appended to a compressed result.
 *
 * It states three things and nothing else: that this is a summary rather than the output, how
 * much was collapsed, and how to get the original. A model must never be able to mistake a
 * summary for a result — the failure mode is a model reading "3 tests failed" in a compressed
 * green run and acting on it, so the counts and the handle are both mandatory. The token figures
 * are character counts, not token counts: this module ships no tokenizer and does not pretend
 * otherwise, for the same reason `rtk` documents its own numbers as `bytes/4` estimates.
 */
export function formatCompressionNote(
  kind: OutputKind,
  result: CompressionResult,
  recall: { id: string; bytes: number; lines: number },
): string {
  return [
    `[output compressed (${KIND_LABEL[kind]}): a summary, not the full output — ${result.hiddenLines} of ${result.originalLines} lines collapsed, ${result.originalChars} → ${result.text.length} chars]`,
    `[full output (${recall.lines} lines) is recoverable in this Session — {"recallId":"${recall.id}","sizeBytes":${recall.bytes},"tokenCount":${Math.ceil(recall.bytes / 4)}} (tokenCount is a bytes/4 estimate); call recall_output with recall_id "${recall.id}" and offset 0, then continue with each next_offset]`,
  ].join("\n");
}

/** One tool call's buffered output, tagged with the strategy its type was classified as. */
export class ToolOutputCollector {
  constructor(
    readonly kind: OutputKind,
    private readonly capture: TruncatedToolOutputCapture,
  ) {}

  append(text: string): void {
    this.capture.append(text);
  }

  /**
   * The exact text buffered, or null once the capture outgrew its limit. A null answer is not a
   * failure: the caller falls back to the ordinary head/tail truncation path, which is what an
   * 8 MiB single tool result gets today.
   */
  text(): string | null {
    return this.capture.text();
  }

  /** The retained windows, valid only after `text()` has returned null. */
  windows(): { head: string; tail: string } {
    return { head: this.capture.headText(), tail: this.capture.tailText() };
  }

  /** The underlying capture, for the truncation fallback that saves the recovery file. */
  get captureHandle(): TruncatedToolOutputCapture {
    return this.capture;
  }
}

/**
 * Applies the call's strategy, or returns null to mean "ship the text unchanged".
 *
 * Two things are deliberately not parameters here. There is no `enabled` flag: compression runs
 * only when a recall store exists (see `startCollector`), because a summary the model cannot
 * expand is not a summary, it is a loss. And there is no per-call override for the same reason —
 * the decision is made once, from the tool's own name and arguments, and the same call always
 * gets the same treatment.
 */
export function compressCollected(
  kind: OutputKind,
  text: string,
  maxChars: number,
): CompressionResult | null {
  return compressOutput({ kind, text, maxChars });
}

/**
 * Starts a collector for this call, or returns null when this call must stream unchanged.
 *
 * Returns null when the tool is not one of the classified types, and when the Environment has no
 * Session scratchpad — a standalone SDK embedder has nowhere to put a recall entry, so it keeps
 * the uncompressed behaviour rather than shipping a summary with no way to undo it.
 */
export function startCollector(
  kind: OutputKind | null,
  archive: TruncatedToolOutputArchive | null,
): ToolOutputCollector | null {
  if (kind === null || archive === null) return null;
  return new ToolOutputCollector(kind, archive.startCapture());
}
