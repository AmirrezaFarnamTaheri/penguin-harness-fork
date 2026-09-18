import { describe, it } from "vitest";
import { ShellEvaluator, ExecutionLimitError } from "../../src/sandbox/shell-evaluator.js";

describe("probe3", () => {
  it("clock", async () => {
    const calls: number[] = [];
    const ev = new ShellEvaluator({
      now: () => (calls.push(1), 5000),
      limits: { maxExecutionTimeMs: 10 },
    });
    try {
      const r = await ev.evaluate("pwd");
      console.log(
        "CONSTANT-CLOCK exit",
        r.exitCode,
        "dur",
        r.durationMs,
        "now-calls",
        calls.length,
      );
    } catch (e) {
      console.log("CONSTANT-CLOCK THREW", (e as Error).message, "calls", calls.length);
    }

    let t = 0;
    const ev2 = new ShellEvaluator({ now: () => (t += 1000), limits: { maxExecutionTimeMs: 100 } });
    t = 5000;
    try {
      const r = await ev2.evaluate("pwd");
      console.log("JUMPED-CLOCK exit", r.exitCode, "dur", r.durationMs);
    } catch (e) {
      console.log(
        "JUMPED-CLOCK THREW",
        (e as ExecutionLimitError).constructor.name,
        (e as Error).message,
        "kind",
        (e as ExecutionLimitError).kind,
      );
    }

    // expansion error paths with no VAR in env
    for (const src of [
      "X=${MISSING:?}",
      "X=${MISSING:?}",
      "X=${MISSING?nope}",
      "X=${VAR:-d}",
      "X=${VAR-d}",
      "X=${VAR:+a}",
      "X=${VAR+a}",
      "X=${VAR}",
      "X=$VAR",
      "X=$",
      "X=$?",
      "X=$$",
      "X=$#",
    ]) {
      try {
        const r = await new ShellEvaluator({ env: { SET: "v" } }).evaluate(src);
        console.log(
          "EXPAND",
          JSON.stringify(src),
          "exit",
          r.exitCode,
          "err",
          JSON.stringify(r.stderr),
        );
      } catch (e) {
        console.log(
          "EXPAND",
          JSON.stringify(src),
          "THREW",
          (e as Error).constructor.name,
          (e as Error).message,
        );
      }
    }
    // expansion of an assignment value that is then unreadable - check $? after false
    {
      const ev3 = new ShellEvaluator();
      await ev3.evaluate("false");
      const r = await ev3.evaluate("X=$?");
      console.log("STATUS after false, then X=$? =>", r.exitCode);
    }
  });
});
