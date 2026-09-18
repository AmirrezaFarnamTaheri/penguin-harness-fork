/**
 * RepeatToolGuard integration: the guard's advisory reminder must reach the LLM's *next*
 * request input — and the output stream — once a tool call repeats past the threshold.
 *
 * The guard exists to break autonomous agent loops, and a reminder that is never delivered
 * to the model breaks nothing. `repeat-tool-guard.test.ts` covers the detection math; these
 * tests pin the runtime wiring inside ContextEngine (observe on the approved-call path,
 * deliver at the next-input assembly, alongside tool outputs like steering/notices), plus the
 * two boundaries that keep its history honest: a new Task starts a fresh chain, and engines
 * sharing one guard never share one key.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantText,
  emptyTokenCounts,
  sessionMeta,
  tokenUsage,
  toolCall,
  toolCallOutput,
  userText,
} from "../src/omnimessage/index.js";
import { BUILTIN_TOOL_FACTORIES } from "../src/environment/tools/registry.js";
import type {
  GenerativeModelParameters,
  LLMInterface,
  LLMOutcome,
} from "../src/interfaces/index.js";
import type { OmniMessage } from "../src/omnimessage/index.js";
import { Environment } from "../src/environment/index.js";
import { ContextEngine } from "../src/engine/context-engine.js";
import { RepeatToolGuard } from "../src/agent/repeat-tool-guard.js";

const PROBE = "__repeat_probe__";
const GENTLE = "repeating the exact same tool call";
const DETAILED = "Repeated tool call detected:";

/** In-memory probe tool: no real process, one fixed complete output per call. */
BUILTIN_TOOL_FACTORIES[PROBE] = (definition) => ({
  name: PROBE,
  definition,
  async *execute(_args, ctx) {
    yield toolCallOutput({
      output: "probe-ok",
      toolCallId: ctx.toolCallId,
      stopReason: "completed",
    });
  },
});

/**
 * Issues one scripted tool call per turn (arguments taken from the script, in order), then a
 * final text reply. Records every request's input so a test can prove what the model actually
 * received on each turn — the assertion that matters for "the reminder reached the LLM".
 *
 * `replay` starts the script over for the next Task on the same engine: a Task boundary is
 * invisible at the LLM seam (the engine holds one LLM object for its whole lifetime), so the
 * harness models "a second user task" by handing the scripted model a fresh script.
 */
class ScriptedLLM implements LLMInterface {
  calls = 0;
  readonly inputs: OmniMessage[][] = [];
  private scriptIndex = 0;
  private script: string[];
  constructor(script: string[]) {
    this.script = script;
  }
  /** Next Task: the script replays from the top (the engine keeps this LLM object). */
  replay(script?: string[]): void {
    if (script) this.script = script;
    this.scriptIndex = 0;
  }
  async *streamGenerate(
    params: GenerativeModelParameters,
  ): AsyncGenerator<OmniMessage, LLMOutcome> {
    this.calls += 1;
    this.inputs.push(params.newMessages);
    if (this.scriptIndex < this.script.length) {
      // scriptIndex < length holds here, but noUncheckedIndexedAccess widens the index type;
      // the fallback never fires and keeps the tool_call's required string field honest.
      const args = this.script[this.scriptIndex++] ?? "";
      yield toolCall({
        name: PROBE,
        arguments: args,
        toolCallId: `probe_call_${this.calls}`,
        stopReason: "completed",
      });
      yield tokenUsage(emptyTokenCounts(), {
        cache_read: 0,
        cache_write: 0,
        output: 1,
        total: this.calls,
      });
      return { status: "completed" };
    }
    yield assistantText("All done.");
    yield tokenUsage(emptyTokenCounts(), {
      cache_read: 0,
      cache_write: 0,
      output: 1,
      total: 99,
    });
    return { status: "completed" };
  }
}

/** All user/assistant text of a message list, joined — the reminder rides in a user text. */
function allText(messages: OmniMessage[] | undefined): string {
  if (!messages) return "";
  return messages
    .filter((m) => (m.payload as { type?: string }).type === "text")
    .map((m) => (m.payload as { text?: string }).text ?? "")
    .join("\n");
}

async function collect(engine: ContextEngine, prompt: OmniMessage[]): Promise<OmniMessage[]> {
  const out: OmniMessage[] = [];
  for await (const msg of engine.run(prompt, { approve: async () => "allow" })) out.push(msg);
  return out;
}

describe("ContextEngine RepeatToolGuard delivery (advisory reminders reach the model)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "penguin-repeat-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function build(
    script: string[],
    repeatToolGuard?: RepeatToolGuard | null,
    options?: { sessionId?: string },
  ) {
    const llm = new ScriptedLLM(script);
    const environment = new Environment({
      workspaceDir: workspace,
      toolConfig: {
        customTools: [{ name: PROBE, description: "probe", permission: "r", maxOutputLength: 40 }],
        mcpServers: [],
      },
    });
    const engine = new ContextEngine({
      llm,
      environment,
      ...(repeatToolGuard === undefined ? {} : { repeatToolGuard }),
      ...(options?.sessionId === undefined
        ? {}
        : {
            sessionMeta: sessionMeta({
              session_id: options.sessionId,
              provider: "custom",
              model_id: "test-model",
              model_context_window: 200000,
              system_prompt: "sp",
              agent_state: "/tmp/state",
              workspace: "/tmp/ws",
            }),
          }),
    });
    return { llm, engine };
  }

  it("delivers the gentle reminder into the NEXT turn's input after the third identical call", async () => {
    const same = JSON.stringify({ n: 1 });
    const { llm, engine } = build([same, same, same]);

    const collected = await collect(engine, [userText("probe three times")]);

    // Three tool turns + one final-reply turn.
    expect(llm.calls).toBe(4);
    // Visible in the stream (the user/Trace side, like steering)...
    expect(allText(collected)).toContain(GENTLE);
    // ...and, critically, in the request that follows the third repeat — not the one that
    // produced it (the reminder is generated while dispatching call 3, so it can only appear
    // from request 4 onward).
    expect(allText(llm.inputs[2])).not.toContain(GENTLE);
    expect(allText(llm.inputs[3])).toContain(GENTLE);
    // Exactly one reminder: 3 is the gentle threshold and 4 is between thresholds.
    expect(allText(collected).split(GENTLE).length - 1).toBe(1);
  });

  it("produces no reminder when the arguments vary between calls", async () => {
    const { llm, engine } = build([
      JSON.stringify({ n: 1 }),
      JSON.stringify({ n: 2 }),
      JSON.stringify({ n: 3 }),
    ]);

    const collected = await collect(engine, [userText("probe with variety")]);

    expect(llm.calls).toBe(4);
    for (const input of llm.inputs) expect(allText(input)).not.toContain(GENTLE);
    expect(allText(collected)).not.toContain(GENTLE);
    expect(allText(collected)).not.toContain(DETAILED);
  });

  it("uses a host-supplied guard instead of the default", async () => {
    const same = JSON.stringify({ n: 1 });
    const { llm, engine } = build([same, same], new RepeatToolGuard({ thresholds: [2] }));

    await collect(engine, [userText("probe twice")]);

    expect(llm.calls).toBe(3);
    // threshold 2 -> the reminder is due while dispatching call 2, so it lands in request 3.
    expect(allText(llm.inputs[1])).not.toContain(GENTLE);
    expect(allText(llm.inputs[2])).toContain(GENTLE);
  });

  it("escalates: the gentle reminder lands after call 3 and the detailed one after call 5", async () => {
    const same = JSON.stringify({ n: 1 });
    const { llm, engine } = build([same, same, same, same, same]);

    const collected = await collect(engine, [userText("probe five times")]);

    expect(llm.calls).toBe(6);
    // Both thresholds fired, each delivered one turn later than the call that triggered it.
    expect(allText(llm.inputs[3])).toContain(GENTLE);
    expect(allText(llm.inputs[3])).not.toContain(DETAILED);
    expect(allText(llm.inputs[5])).toContain(DETAILED);
    expect(allText(llm.inputs[5])).toContain("consecutive_calls: 5");
    // Each reminder is seen exactly once, and never on the request that caused it.
    expect(allText(llm.inputs[2])).not.toContain(GENTLE);
    expect(allText(collected).split(GENTLE).length - 1).toBe(1);
    expect(allText(collected).split(DETAILED).length - 1).toBe(1);
  });

  it("disables the advisory reminders when the host passes null", async () => {
    const same = JSON.stringify({ n: 1 });
    const { llm, engine } = build([same, same, same, same, same], null);

    const collected = await collect(engine, [userText("probe five times")]);

    expect(llm.calls).toBe(6);
    for (const input of llm.inputs) {
      expect(allText(input)).not.toContain(GENTLE);
      expect(allText(input)).not.toContain(DETAILED);
    }
    expect(allText(collected)).not.toContain(GENTLE);
    expect(allText(collected)).not.toContain(DETAILED);
  });

  it("resets the repeat chain at a Task boundary so a prior task's tail cannot arm this task's first call", async () => {
    const same = JSON.stringify({ n: 1 });
    const { llm, engine } = build([same, same]);

    // Task 1: two identical calls — under the first threshold, so nothing fires, and the task
    // ends on a tail of two repeats.
    const first = await collect(engine, [userText("task one: probe twice")]);
    expect(llm.calls).toBe(3);
    expect(allText(first)).not.toContain(GENTLE);

    // Task 2 on the same stateful engine: `run` is a new user task, so the script replays.
    llm.replay();
    const second = await collect(engine, [userText("task two: probe twice again")]);

    // Without a Task-boundary reset, task 2's FIRST identical call inherits count 3 from task
    // 1's tail and fires the gentle reminder (delivered into the request that follows it);
    // with it, task 2's calls are its own counts 1 and 2.
    expect(llm.calls).toBe(6);
    expect(allText(second)).not.toContain(GENTLE);
    expect(allText(second)).not.toContain(DETAILED);
    for (const input of llm.inputs) {
      expect(allText(input)).not.toContain(GENTLE);
      expect(allText(input)).not.toContain(DETAILED);
    }
  });

  it("gives each engine its own repeat history when a shared guard carries no session metadata", async () => {
    // A host that intentionally shares one guard across engines, publishing no session_meta:
    // keying every such engine as one constant would make engine B's first identical call
    // engine A's repeat #3, firing a reminder about a loop the other engine is not in.
    const shared = new RepeatToolGuard();
    const same = JSON.stringify({ n: 1 });

    const a = build([same, same], shared);
    await collect(a.engine, [userText("engine A: probe twice")]);
    expect(a.llm.calls).toBe(3);
    expect(allText(a.llm.inputs[2])).not.toContain(GENTLE);

    const b = build([same, same], shared);
    const collected = await collect(b.engine, [userText("engine B: probe twice")]);

    expect(b.llm.calls).toBe(3);
    expect(allText(collected)).not.toContain(GENTLE);
    for (const input of b.llm.inputs) expect(allText(input)).not.toContain(GENTLE);
  });

  it("keys a shared guard by session id when the contexts publish distinct ones", async () => {
    const shared = new RepeatToolGuard();
    const same = JSON.stringify({ n: 1 });

    const a = build([same, same], shared, { sessionId: "sess-a" });
    await collect(a.engine, [userText("engine A: probe twice")]);
    const b = build([same, same], shared, { sessionId: "sess-b" });
    const collected = await collect(b.engine, [userText("engine B: probe twice")]);

    // The session id stays the key, so the two engines keep distinct chains.
    expect(b.llm.calls).toBe(3);
    expect(allText(collected)).not.toContain(GENTLE);
    for (const input of b.llm.inputs) expect(allText(input)).not.toContain(GENTLE);
  });
});
