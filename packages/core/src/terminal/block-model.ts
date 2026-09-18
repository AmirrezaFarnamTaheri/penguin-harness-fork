/**
 * Block-based terminal model.
 *
 * Ported from the Rust terminal emulator's block model
 * (`app/src/terminal/model/block.rs`, `model/blocks.rs`): a terminal is a
 * list of *blocks*, each one a prompt command plus the output it produced,
 * rather than a flat grid of lines. The cockpit renders these as cards, and
 * per-line staging sits alongside them.
 *
 * Failure semantics, exit-code constants, the long-running thresholds and
 * the serialized-line caps are the source project's own values, so behaviour
 * matches the terminal the cockpit replaces.
 */

import type { CellStyle } from "./ansi-color";

/** Lifecycle of one command block. */
export enum BlockState {
  /** Command accepted but `preexec` has not fired yet. */
  Pending = "pending",
  /** Running right now. */
  Running = "running",
  /** Finished executing, exit code available. */
  DoneWithExecution = "done_with_execution",
  /** The shell was killed before the command reported an exit. */
  Terminated = "terminated",
  /** Output is being streamed but the command has not exited. */
  Streaming = "streaming",
}

/**
 * Exit codes that must not be reported as failures.
 *
 * 130 = terminated by SIGINT (Ctrl-C) and 141 = SIGPIPE. The source project
 * also excludes any command whose `preexec` never fired, since the exit code
 * then belongs to something else entirely. Keep this in sync with the
 * upstream command-corrections list.
 */
export const NON_FAILURE_EXIT_CODES: ReadonlySet<number> = new Set([130, 141]);

export function exitCodeWasSuccessful(exitCode: number): boolean {
  return exitCode === 0;
}

/**
 * A block failed when it finished executing with a non-zero exit code that is
 * not in the SIGINT/SIGPIPE exclusion set.
 */
export function hasBlockFailed(exitCode: number, state: BlockState): boolean {
  return (
    state === BlockState.DoneWithExecution &&
    !exitCodeWasSuccessful(exitCode) &&
    !NON_FAILURE_EXIT_CODES.has(exitCode)
  );
}

/** Commands running longer than this are "long running" and get padding. */
export const LONG_RUNNING_COMMAND_DURATION_MS = 50;
/** Bottom padding, in lines, added under a long-running block. */
export const LONG_RUNNING_BOTTOM_PADDING_LINES = 0.2;

/**
 * Stylized output is what the user sees; plain output is kept only for
 * command corrections and notifications, so it needs far fewer lines.
 */
export const MAX_SERIALIZED_STYLIZED_OUTPUT_LINES = 5000;
export const MAX_SERIALIZED_OUTPUT_LINES = 50;

/** Duration-formatting constants. */
export const MILLIS_PER_MIN = 60_000;
export const MINS_PER_HOUR = 60;

export interface BlockId {
  readonly value: string;
}

export function blockId(value: string): BlockId {
  return { value };
}

/** One styled line of terminal output. */
export interface TerminalLine {
  text: string;
  style: CellStyle;
}

export interface Block {
  id: BlockId;
  /** Command line the user entered, without styling. */
  command: string;
  state: BlockState;
  /** Exit status, meaningful once `state` is `DoneWithExecution`. */
  exitCode: number | null;
  /** Start time as a Unix epoch millisecond timestamp. */
  startedAt: number;
  /** Completion timestamp, or `null` while running. */
  finishedAt: number | null;
  /** Working directory at the time the command was entered. */
  workingDirectory: string | null;
  /** Shell that ran the command, when known. */
  shell: string | null;
  /** Styled output lines. */
  output: TerminalLine[];
  /** Plain-text output, capped at `MAX_SERIALIZED_OUTPUT_LINES`. */
  plainOutput: string[];
  /** Whether the command was invoked from an agent rather than a human. */
  agentInitiated: boolean;
}

export function createBlock(params: {
  id: BlockId;
  command: string;
  startedAt?: number;
  workingDirectory?: string | null;
  shell?: string | null;
  agentInitiated?: boolean;
}): Block {
  return {
    id: params.id,
    command: params.command,
    state: BlockState.Pending,
    exitCode: null,
    startedAt: params.startedAt ?? Date.now(),
    finishedAt: null,
    workingDirectory: params.workingDirectory ?? null,
    shell: params.shell ?? null,
    output: [],
    plainOutput: [],
    agentInitiated: params.agentInitiated ?? false,
  };
}

/** Elapsed milliseconds, or `null` for a block that never finished. */
export function blockDuration(block: Block): number | null {
  if (block.finishedAt === null) return null;
  return Math.max(0, block.finishedAt - block.startedAt);
}

/** True when the block ran past the long-running threshold. */
export function isLongRunning(block: Block): boolean {
  const duration = blockDuration(block);
  return duration !== null && duration >= LONG_RUNNING_COMMAND_DURATION_MS;
}

/**
 * Human-readable duration. The source project formats as
 * `Xs`, `Xm Ys`, `Xh Ym` — the cockpit keeps the same shapes so the values
 * stay comparable side by side.
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  // The minute boundary is tested against milliseconds, not the rounded
  // second count: 59_999ms rounds to 60s but is still under a minute, so it
  // renders as "60s" while exactly 60_000ms renders as "1m".
  if (durationMs < MILLIS_PER_MIN) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / MINS_PER_HOUR);
  const minutes = totalMinutes % MINS_PER_HOUR;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Relative time stamp for a finished block, e.g. "2m 13s". */
export function formatBlockDuration(block: Block): string {
  const duration = blockDuration(block);
  return duration === null ? "running" : formatDuration(duration);
}

/**
 * The block list: an append-only ring of blocks with a scrollback cap.
 * Ported from the source project's `BlockList` plus its scrollback history
 * limits; the newest block is at the end.
 */
export class BlockList {
  readonly blocks: Block[] = [];
  /** Cap on retained blocks; older blocks are evicted FIFO. */
  readonly capacity: number;
  private readonly blockSequence: number[] = [];
  private sequence = 0;

  constructor(capacity = 10_000) {
    this.capacity = capacity;
  }

  get length(): number {
    return this.blocks.length;
  }

  /** The most recent block, or `null` when the list is empty. */
  get last(): Block | null {
    return this.blocks.length === 0 ? null : this.blocks[this.blocks.length - 1]!;
  }

  nextId(): BlockId {
    const id = this.sequence;
    this.sequence += 1;
    this.blockSequence.push(id);
    return blockId(`block-${id}`);
  }

  append(block: Block): void {
    this.blocks.push(block);
    if (this.blocks.length > this.capacity) {
      this.blocks.shift();
    }
  }

  /** Replace the last block; used when a block transitions state. */
  replaceLast(block: Block): void {
    if (this.blocks.length === 0) {
      this.blocks.push(block);
      return;
    }
    this.blocks[this.blocks.length - 1] = block;
  }

  get(id: BlockId): Block | null {
    return this.blocks.find((b) => b.id.value === id.value) ?? null;
  }

  /** Blocks whose command or output matches a substring, newest first. */
  search(query: string, limit = 50): Block[] {
    const needle = query.toLowerCase();
    const matches: Block[] = [];
    for (let i = this.blocks.length - 1; i >= 0 && matches.length < limit; i--) {
      const block = this.blocks[i]!;
      const haystack = `${block.command}\n${block.plainOutput.join("\n")}`.toLowerCase();
      if (haystack.includes(needle)) matches.push(block);
    }
    return matches;
  }

  /** Blocks with a non-zero, non-excluded exit code. */
  failures(): Block[] {
    return this.blocks.filter((b) => hasBlockFailed(b.exitCode ?? 0, b.state));
  }

  /** Total output lines across every block. */
  totalOutputLines(): number {
    return this.blocks.reduce((sum, b) => sum + b.output.length, 0);
  }

  /** Blocks in a given state, in insertion order. */
  filterByState(state: BlockState): Block[] {
    return this.blocks.filter((b) => b.state === state);
  }

  clear(): void {
    this.blocks.length = 0;
  }
}

/**
 * Streaming append: push one styled line into the running block, keeping the
 * plain-text mirror under `MAX_SERIALIZED_OUTPUT_LINES` and the stylized list
 * under `MAX_SERIALIZED_STYLIZED_OUTPUT_LINES`.
 */
export function appendOutputLine(block: Block, line: TerminalLine): Block {
  const output = block.output.concat(line);
  if (output.length > MAX_SERIALIZED_STYLIZED_OUTPUT_LINES) {
    output.splice(0, output.length - MAX_SERIALIZED_STYLIZED_OUTPUT_LINES);
  }
  const plain = block.plainOutput.concat(line.text);
  if (plain.length > MAX_SERIALIZED_OUTPUT_LINES) {
    plain.splice(0, plain.length - MAX_SERIALIZED_OUTPUT_LINES);
  }
  return { ...block, output, plainOutput: plain, state: streamingState(block.state) };
}

function streamingState(state: BlockState): BlockState {
  if (state === BlockState.Pending) return BlockState.Streaming;
  if (state === BlockState.Running) return BlockState.Streaming;
  return state;
}

/** Transition a block to running when the shell reports `preexec`. */
export function markRunning(
  block: Block,
  shell: string | null,
  workingDirectory: string | null,
): Block {
  return { ...block, state: BlockState.Running, shell, workingDirectory };
}

/** Record the exit and stamp the completion time. */
export function markDone(block: Block, exitCode: number, finishedAt = Date.now()): Block {
  return {
    ...block,
    state: BlockState.DoneWithExecution,
    exitCode,
    finishedAt: finishedAt < block.startedAt ? block.startedAt : finishedAt,
  };
}

/** Mark the block as terminated without an exit code. */
export function markTerminated(block: Block, finishedAt = Date.now()): Block {
  return { ...block, state: BlockState.Terminated, finishedAt };
}

/**
 * Serialisable shape for session restore. The source project keeps the
 * stylized lines to restore a transcript and the plain lines for command
 * corrections; both are carried here.
 */
export interface SerializedBlock {
  id: string;
  command: string;
  state: BlockState;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  workingDirectory: string | null;
  shell: string | null;
  plainOutput: string[];
  agentInitiated: boolean;
}

export function serializeBlock(block: Block): SerializedBlock {
  return {
    id: block.id.value,
    command: block.command,
    state: block.state,
    exitCode: block.exitCode,
    startedAt: block.startedAt,
    finishedAt: block.finishedAt,
    workingDirectory: block.workingDirectory,
    shell: block.shell,
    plainOutput: [...block.plainOutput],
    agentInitiated: block.agentInitiated,
  };
}

export function deserializeBlock(data: SerializedBlock): Block {
  return {
    id: blockId(data.id),
    command: data.command,
    state: data.state,
    exitCode: data.exitCode,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    workingDirectory: data.workingDirectory,
    shell: data.shell,
    output: [],
    plainOutput: [...data.plainOutput],
    agentInitiated: data.agentInitiated,
  };
}

/** True when the block's command looks like a git invocation. */
export function isGitCommand(command: string): boolean {
  const trimmed = command.trim();
  return /^(?:git|g)\s/.test(trimmed) || /^(?:git|g)$/.test(trimmed);
}
