import { describe, expect, it } from "vitest";
import {
  MAX_SERIALIZED_OUTPUT_LINES,
  MAX_SERIALIZED_STYLIZED_OUTPUT_LINES,
  NON_FAILURE_EXIT_CODES,
  LONG_RUNNING_COMMAND_DURATION_MS,
  LONG_RUNNING_BOTTOM_PADDING_LINES,
  MILLIS_PER_MIN,
  MINS_PER_HOUR,
  BlockList,
  BlockState,
  appendOutputLine,
  blockId,
  blockDuration,
  createBlock,
  deserializeBlock,
  exitCodeWasSuccessful,
  formatBlockDuration,
  formatDuration,
  hasBlockFailed,
  isGitCommand,
  isLongRunning,
  markDone,
  markRunning,
  markTerminated,
  serializeBlock,
} from "../../src/terminal/block-model";
import { createCellStyle } from "../../src/terminal/ansi-color";

describe("block model", () => {
  it("exports the source project's constants", () => {
    expect(NON_FAILURE_EXIT_CODES.has(130)).toBe(true);
    expect(NON_FAILURE_EXIT_CODES.has(141)).toBe(true);
    expect(NON_FAILURE_EXIT_CODES.has(1)).toBe(false);
    expect(LONG_RUNNING_COMMAND_DURATION_MS).toBe(50);
    expect(LONG_RUNNING_BOTTOM_PADDING_LINES).toBeCloseTo(0.2);
    expect(MAX_SERIALIZED_STYLIZED_OUTPUT_LINES).toBe(5000);
    expect(MAX_SERIALIZED_OUTPUT_LINES).toBe(50);
    expect(MILLIS_PER_MIN).toBe(60_000);
    expect(MINS_PER_HOUR).toBe(60);
  });

  it("starts blocks pending and answers success by exit code", () => {
    expect(exitCodeWasSuccessful(0)).toBe(true);
    expect(exitCodeWasSuccessful(1)).toBe(false);
    const block = createBlock({ id: blockId("b1"), command: "ls" });
    expect(block.state).toBe(BlockState.Pending);
    expect(block.exitCode).toBeNull();
    expect(block.output).toEqual([]);
    expect(block.agentInitiated).toBe(false);
  });

  it("classifies block failures, excluding ctrl-c and broken pipes", () => {
    // A finished command with a real failure.
    expect(hasBlockFailed(1, BlockState.DoneWithExecution)).toBe(true);
    // SIGINT (130) and SIGPIPE (141) are user interrupts, not failures.
    expect(hasBlockFailed(130, BlockState.DoneWithExecution)).toBe(false);
    expect(hasBlockFailed(141, BlockState.DoneWithExecution)).toBe(false);
    // Success.
    expect(hasBlockFailed(0, BlockState.DoneWithExecution)).toBe(false);
    // A non-zero code on a still-running block is not a failure yet.
    expect(hasBlockFailed(1, BlockState.Running)).toBe(false);
    expect(hasBlockFailed(1, BlockState.Terminated)).toBe(false);
  });

  it("transitions blocks through their lifecycle", () => {
    const block = createBlock({ id: blockId("b1"), command: "build", startedAt: 1000 });
    const running = markRunning(block, "/bin/bash", "/repo");
    expect(running.state).toBe(BlockState.Running);
    expect(running.shell).toBe("/bin/bash");
    expect(running.workingDirectory).toBe("/repo");
    // Output flips a pending or running block to streaming.
    const streaming = appendOutputLine(running, { text: "compiling", style: createCellStyle() });
    expect(streaming.state).toBe(BlockState.Streaming);
    expect(streaming.output[0]!.text).toBe("compiling");
    expect(streaming.plainOutput).toEqual(["compiling"]);
    // Recording the exit stamps the finish time.
    const done = markDone(streaming, 0, 1500);
    expect(done.state).toBe(BlockState.DoneWithExecution);
    expect(done.exitCode).toBe(0);
    expect(done.finishedAt).toBe(1500);
    expect(blockDuration(done)).toBe(500);
    // A completion time before the start is clamped to the start.
    const weird = markDone(running, 0, 500);
    expect(weird.finishedAt).toBe(1000);
    // Termination records no exit code.
    const terminated = markTerminated(running, 2000);
    expect(terminated.state).toBe(BlockState.Terminated);
    expect(terminated.exitCode).toBeNull();
    expect(blockDuration(terminated)).toBe(1000);
    expect(blockDuration(block)).toBeNull();
  });

  it("flags long running blocks", () => {
    const short = markDone(createBlock({ id: blockId("b"), command: "c", startedAt: 0 }), 0, 10);
    expect(isLongRunning(short)).toBe(false);
    const long = markDone(createBlock({ id: blockId("b"), command: "c", startedAt: 0 }), 0, 1000);
    expect(isLongRunning(long)).toBe(true);
    // Exactly the threshold counts.
    const exactly = markDone(
      createBlock({ id: blockId("b"), command: "c", startedAt: 0 }),
      0,
      LONG_RUNNING_COMMAND_DURATION_MS,
    );
    expect(isLongRunning(exactly)).toBe(true);
  });

  it("formats durations the way the source project does", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(59_999)).toBe("60s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_660_000)).toBe("1h 1m");
    // A running block reports its state, not a number.
    expect(formatBlockDuration(createBlock({ id: blockId("b"), command: "c" }))).toBe("running");
    expect(
      formatBlockDuration(
        markDone(createBlock({ id: blockId("b"), command: "c", startedAt: 0 }), 0, 2000),
      ),
    ).toBe("2s");
  });

  it("caps retained output lines", () => {
    const block = createBlock({ id: blockId("b"), command: "c", startedAt: 0 });
    const stylized = new Array(MAX_SERIALIZED_STYLIZED_OUTPUT_LINES + 10)
      .fill(null)
      .reduce(
        (acc, _, i) => appendOutputLine(acc, { text: `line ${i}`, style: createCellStyle() }),
        block,
      );
    expect(stylized.output).toHaveLength(MAX_SERIALIZED_STYLIZED_OUTPUT_LINES);
    expect(stylized.plainOutput).toHaveLength(MAX_SERIALIZED_OUTPUT_LINES);
    // The most recent lines survive, not the oldest.
    expect(stylized.plainOutput[stylized.plainOutput.length - 1]).toMatch(/line 5009$/);
  });

  it("manages the block list ring", () => {
    const list = new BlockList(3);
    expect(list.length).toBe(0);
    expect(list.last).toBeNull();
    list.append(createBlock({ id: blockId("b0"), command: "a" }));
    list.append(createBlock({ id: blockId("b1"), command: "b" }));
    list.append(createBlock({ id: blockId("b2"), command: "c" }));
    expect(list.length).toBe(3);
    expect(list.last!.command).toBe("c");
    // The capacity evicts the oldest block.
    list.append(createBlock({ id: blockId("b3"), command: "d" }));
    expect(list.length).toBe(3);
    expect(list.get(blockId("b0"))).toBeNull();
    expect(list.get(blockId("b3"))!.command).toBe("d");
    // Ids come from a monotonic sequence.
    const list2 = new BlockList();
    expect(list2.nextId()).toEqual(blockId("block-0"));
    expect(list2.nextId()).toEqual(blockId("block-1"));
  });

  it("replaces, searches and aggregates the block list", () => {
    const list = new BlockList();
    const first = createBlock({ id: blockId("b0"), command: "npm test" });
    list.append(first);
    list.replaceLast(markDone(first, 1, 1000));
    expect(list.last!.exitCode).toBe(1);
    // An empty list still accepts a replacement.
    const empty = new BlockList();
    empty.replaceLast(createBlock({ id: blockId("x"), command: "y" }));
    expect(empty.length).toBe(1);
    list.append(createBlock({ id: blockId("b1"), command: "git status" }));
    list.append(markDone(createBlock({ id: blockId("b2"), command: "ls" }), 0, 10));
    // Search matches commands and output, newest first.
    expect(list.search("git")[0]!.id.value).toBe("b1");
    expect(list.search("TEST")[0]!.id.value).toBe("b0");
    expect(list.search("missing")).toEqual([]);
    // Failures are the non-zero, non-excluded exits.
    expect(list.failures().map((b) => b.id.value)).toEqual(["b0"]);
    expect(list.totalOutputLines()).toBe(0);
    expect(list.filterByState(BlockState.DoneWithExecution)).toHaveLength(2);
    expect(list.filterByState(BlockState.Running)).toHaveLength(0);
    list.clear();
    expect(list.length).toBe(0);
  });

  it("round-trips a block through the serialized shape", () => {
    const block = markDone(
      {
        ...createBlock({
          id: blockId("b9"),
          command: "make",
          startedAt: 100,
          workingDirectory: "/repo",
          shell: "/bin/zsh",
          agentInitiated: true,
        }),
      },
      0,
      500,
    );
    const serialized = serializeBlock(block);
    expect(serialized.id).toBe("b9");
    expect(serialized.workingDirectory).toBe("/repo");
    expect(serialized.agentInitiated).toBe(true);
    const restored = deserializeBlock(serialized);
    expect(restored.id).toEqual(blockId("b9"));
    expect(restored.command).toBe("make");
    expect(restored.exitCode).toBe(0);
    expect(restored.plainOutput).toEqual([]);
    // The stylized lines are not part of the persisted shape.
    expect(restored.output).toEqual([]);
  });

  it("recognises git commands", () => {
    expect(isGitCommand("git status")).toBe(true);
    expect(isGitCommand("git")).toBe(true);
    expect(isGitCommand("g diff")).toBe(true);
    expect(isGitCommand("  git log  ")).toBe(true);
    expect(isGitCommand("gitx")).toBe(false);
    expect(isGitCommand("ls -la")).toBe(false);
    expect(isGitCommand("echo git")).toBe(false);
  });
});
