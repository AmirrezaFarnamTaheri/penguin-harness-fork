import { describe, expect, it, vi } from "vitest";
import { LoopDetector, ProgressTracker } from "../src/agent/loop-detector.js";

describe("LoopDetector", () => {
  it("allows normal tool execution under repeat thresholds", () => {
    const detector = new LoopDetector({ maxRepeats: 5 });
    for (let i = 0; i < 4; i++) {
      const res = detector.checkToolCall("read_file", { path: `file_${i}.ts` });
      expect(res.status).toBe("ok");
      expect(res.shouldStop).toBe(false);
    }
  });

  it("detects consecutive calls to the same tool and stops", () => {
    const detector = new LoopDetector({ maxRepeats: 4 });
    detector.checkToolCall("grep_search", { query: "foo" });
    detector.checkToolCall("grep_search", { query: "bar" });
    detector.checkToolCall("grep_search", { query: "baz" });
    const fourth = detector.checkToolCall("grep_search", { query: "qux" });

    expect(fourth.status).toBe("loop_detected");
    expect(fourth.shouldStop).toBe(true);
    expect(fourth.patternType).toBe("consecutive_same_tool");
    expect(detector.shouldAbort()).toBe(true);
  });

  it("identifies identical argument loops specifically", () => {
    const detector = new LoopDetector({ maxRepeats: 3 });
    detector.checkToolCall("view_file", { path: "a.ts" });
    detector.checkToolCall("view_file", { path: "a.ts" });
    const third = detector.checkToolCall("view_file", { path: "a.ts" });

    expect(third.status).toBe("loop_detected");
    expect(third.patternType).toBe("identical_input_repeat");
    expect(third.message).toContain("identical arguments");
  });

  it("detects alternating cycle loops (e.g. A -> B -> A -> B -> A -> B)", () => {
    const detector = new LoopDetector({ maxCycleLength: 2, maxRepeats: 10 });
    // Sequence: A, B, A, B, A, B (period 2, 3 repeats = 6 calls)
    detector.checkToolCall("list_dir", { path: "dir1" });
    detector.checkToolCall("view_file", { path: "file1" });
    detector.checkToolCall("list_dir", { path: "dir1" });
    detector.checkToolCall("view_file", { path: "file1" });
    detector.checkToolCall("list_dir", { path: "dir1" });
    const sixth = detector.checkToolCall("view_file", { path: "file1" });

    expect(sixth.status).toBe("loop_detected");
    expect(sixth.patternType).toBe("alternating_cycle");
    expect(sixth.message).toContain("list_dir -> view_file");
  });

  it("detects progress stall when threshold is exceeded", () => {
    const detector = new LoopDetector({ stallThreshold: 5 });
    vi.useFakeTimers();

    detector.checkToolCall("some_tool");
    expect(detector.checkToolCall("").status).toBe("ok");

    // Advance time beyond stall threshold (6 seconds)
    vi.advanceTimersByTime(6000);
    const stall = detector.checkToolCall("");
    expect(stall.status).toBe("stall");
    expect(stall.shouldStop).toBe(true);

    // Recording progress recovers from stall
    detector.recordProgress();
    expect(detector.checkToolCall("").status).toBe("ok");

    vi.useRealTimers();
  });

  it("honors noteLlmWait to prevent slow LLM turns from being penalized as stalls", () => {
    const detector = new LoopDetector({ stallThreshold: 5 });
    vi.useFakeTimers();

    vi.advanceTimersByTime(4000);
    // 4s passed, note 3s of LLM generation wait
    detector.noteLlmWait(3);
    vi.advanceTimersByTime(2000); // Total wall time: 6s, but offset adjusted by +3s

    const res = detector.checkToolCall("");
    expect(res.status).toBe("ok");
    expect(res.shouldStop).toBe(false);

    vi.useRealTimers();
  });

  it("aborts when consecutive errors exceed maxErrors", () => {
    const detector = new LoopDetector({ maxErrors: 3 });
    detector.recordError("Error 1");
    expect(detector.checkToolCall("").status).toBe("ok");
    detector.recordError("Error 2");
    expect(detector.checkToolCall("").status).toBe("ok");
    detector.recordError("Error 3");

    const res = detector.checkToolCall("");
    expect(res.status).toBe("max_errors");
    expect(res.shouldStop).toBe(true);

    detector.recordSuccess();
    expect(detector.checkToolCall("").status).toBe("ok");
  });

  it("provides status summary accurately", () => {
    const detector = new LoopDetector({ maxRepeats: 5 });
    detector.startFile("src/index.ts");
    detector.checkToolCall("read_file");
    detector.recordError("syntax error");

    const summary = detector.getStatusSummary();
    expect(summary.currentFile).toBe("src/index.ts");
    expect(summary.consecutiveErrors).toBe(1);
    expect(summary.recentTools).toEqual(["read_file"]);
    expect(summary.isAborted).toBe(false);
  });
});

describe("ProgressTracker", () => {
  it("tracks file completion idempotently and ignores duplicate paths", () => {
    const tracker = new ProgressTracker(3);
    expect(tracker.completeFile("src/a.ts")).toBe(true);
    expect(tracker.completeFile("src\\a.ts")).toBe(false); // Normalized backslash
    expect(tracker.completedFiles).toBe(1);

    expect(tracker.completeFile("src/b.ts")).toBe(true);
    expect(tracker.completedFiles).toBe(2);

    const info = tracker.getProgressInfo();
    expect(info.filesCompleted).toBe(2);
    expect(info.totalFiles).toBe(3);
    expect(info.fileProgress).toBe(67);
  });

  it("tracks phases and computes progress accurately", () => {
    const tracker = new ProgressTracker(10);
    tracker.setPhase("Testing", 80);
    const info = tracker.getProgressInfo();
    expect(info.phase).toBe("Testing");
    expect(info.phaseProgress).toBe(80);
  });
});
