import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { toolCall } from "@prismshadow/penguin-core";
import { getMessages } from "../src/i18n.js";
import { registerInputCommand } from "../src/commands/input.js";
import { FakeServer } from "./fake-server.js";

const t = getMessages("en");

/** One `approval_request` control frame: the tool call the [Y/n] prompt is about. */
function approvalRequest(): Record<string, unknown> {
  return {
    type: "approval_request",
    toolCall: toolCall({
      name: "exec_command",
      arguments: '{"cmd":"rm -rf scratch"}',
      toolCallId: "tc-pending",
    }),
  };
}

/** Polls a condition, failing loudly instead of hanging the way the pre-fix CLI did. */
async function waitFor(label: string, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

interface InputHandle {
  server: FakeServer;
  sessionId: string;
  /** stdout so far (the approval prompt and the --json result land here). */
  out: () => string;
  /** resolves once the command has written `text` to stdout. */
  waitForOutput: (text: string) => Promise<void>;
  /** resolves once a recorded request matches `pred`. */
  waitForRequest: (
    label: string,
    pred: (r: { method: string; path: string }) => boolean,
  ) => Promise<void>;
  /** invokes `penguin input`'s SIGINT listener exactly as Node would on Ctrl-C. */
  fireSigint: () => void;
  /** the running parseAsync; resolves when the turn ends and the command prints its result. */
  done: Promise<unknown>;
  /** restores stdin, stdout and process state. */
  finish: () => void;
}

/**
 * Runs `penguin input <session> -m stall --json` end to end against a fake server whose task
 * stalls (running, never idle) so a test can interleave at a chosen moment. stdin is a
 * PassThrough that never ends, so an approval prompt genuinely blocks — the condition the
 * hang reproduced under. stdout is captured (the renderer is off under --json, but the
 * approval prompt itself is written there).
 */
function startInput(): InputHandle {
  const server = new FakeServer();
  const uninstall = server.install();
  const session = server.addSession();
  server.hangTasks = true; // POST /tasks emits `running` and no `idle`: the turn waits
  server.onTask = () => []; // no task messages; the frames the test emits drive the scenario

  const stdin = new PassThrough();
  const realStdin = process.stdin;
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });

  const chunks: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });

  const sigintBefore = new Set(process.listeners("SIGINT"));
  const prevExitCode = process.exitCode;

  const program = new Command();
  program.exitOverride();
  registerInputCommand(program, t);
  const done = program.parseAsync([
    "node",
    "penguin",
    "input",
    session.sessionId,
    "-m",
    "stall",
    "--json",
  ]);

  return {
    server,
    sessionId: session.sessionId,
    out: () => chunks.join(""),
    waitForOutput: (text) =>
      waitFor(`stdout to contain ${JSON.stringify(text)}`, () => chunks.join("").includes(text)),
    waitForRequest: (label, pred) =>
      waitFor(label, () => server.requests.some((r) => pred({ method: r.method, path: r.path }))),
    fireSigint() {
      // Node calls every SIGINT listener synchronously on the signal; we invoke the one
      // input.ts registered rather than emitting the signal, so the runner's own Ctrl-C
      // handling stays out of the test.
      const handler = process.listeners("SIGINT").find((h) => !sigintBefore.has(h));
      if (!handler) throw new Error("penguin input did not register a SIGINT listener");
      handler("SIGINT");
    },
    done,
    finish() {
      process.exitCode = prevExitCode;
      outSpy.mockRestore();
      Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
      uninstall();
    },
  };
}

describe("penguin input — Ctrl-C during an approval prompt", () => {
  it("denies the pending tool instead of leaving the prompt hanging", async () => {
    const h = startInput();
    try {
      await h.waitForRequest(
        "POST /tasks",
        (r) => r.method === "POST" && r.path.endsWith("/tasks"),
      );
      // Stall the turn at the [Y/n] prompt: the tool call is now waiting on stdin.
      h.server.emitServerEvent(h.sessionId, approvalRequest());
      await h.waitForOutput(t.approvePrompt());

      h.fireSigint();

      // The deny is posted back for exactly the pending call ...
      await h.waitForRequest(
        "POST /approvals",
        (r) => r.method === "POST" && r.path.includes("/approvals/"),
      );
      const decision = h.server.requests.find(
        (r) => r.method === "POST" && r.path.includes("/approvals/"),
      )!.body;
      expect(decision).toEqual({ decision: "deny" });
      // ... and the turn was not aborted: a Ctrl-C at the prompt is a deny, not an interrupt.
      expect(h.server.requests.some((r) => r.method === "POST" && r.path.endsWith("/abort"))).toBe(
        false,
      );

      // Let the turn end; the watch returns and the command prints its result.
      h.server.emitServerEvent(h.sessionId, { type: "task_state", state: "idle" });
      await h.done;
      expect(h.out()).toContain('"status":"completed"');
    } finally {
      h.finish();
    }
  });

  it("aborts the task when no approval is pending (the deny-first check does not swallow it)", async () => {
    const h = startInput();
    try {
      await h.waitForRequest(
        "POST /tasks",
        (r) => r.method === "POST" && r.path.endsWith("/tasks"),
      );

      h.fireSigint();

      await h.waitForRequest(
        "POST /abort",
        (r) => r.method === "POST" && r.path.endsWith("/abort"),
      );
      expect(
        h.server.requests.some((r) => r.method === "POST" && r.path.includes("/approvals/")),
      ).toBe(false);

      h.server.emitServerEvent(h.sessionId, { type: "task_state", state: "idle" });
      await h.done;
    } finally {
      h.finish();
    }
  });
});
