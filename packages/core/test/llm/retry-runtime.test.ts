import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextEngine } from "../../src/engine/context-engine.js";
import type { EnvironmentInterface, LLMInterface, RunCutoff } from "../../src/interfaces/index.js";
import {
  assistantText,
  userText,
  tokenUsage,
  emptyTokenCounts,
} from "../../src/omnimessage/index.js";
import type { OmniMessage } from "../../src/omnimessage/index.js";

const environment: EnvironmentInterface = {
  listTools: async () => [],
  toolPermission: () => undefined,
  async *executeTool() {},
};

function isRequestEnd(message: OmniMessage): boolean {
  return "type" in message.payload && message.payload.type === "request_end";
}

async function consume(
  engine: ContextEngine,
  signal?: AbortSignal,
  onMessage?: (message: OmniMessage) => void,
) {
  const messages: OmniMessage[] = [];
  const generator = engine.run([userText("go")], { signal, approve: async () => "allow" });
  for (;;) {
    const next = await generator.next();
    if (next.done) return { messages, result: next.value as RunCutoff | null };
    messages.push(next.value);
    onMessage?.(next.value);
  }
}

describe("pool retry runtime", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [1, 3],
    [2, 4],
    [6, 12],
  ])("bounds pool %i despite partial output", async (retryPoolSize, ceiling) => {
    vi.useFakeTimers();
    let calls = 0;
    const llm: LLMInterface = {
      retryPoolSize,
      async *streamGenerate() {
        calls++;
        yield assistantText("partial", "retryable");
        return {
          status: "retryable",
          retryAccount: { rateLimited: true, accountId: `account_${calls % retryPoolSize}` },
        };
      },
    };
    const pending = consume(new ContextEngine({ llm, environment }));
    await vi.runAllTimersAsync();
    const { messages, result } = await pending;
    expect(calls).toBe(ceiling);
    expect(result?.kind).toBe("llm_failure");
    const ends = messages.filter(isRequestEnd);
    expect(ends).toHaveLength(ceiling);
    expect(ends.at(-1)?.payload).not.toHaveProperty("retry_in_ms");
    if (retryPoolSize > 1) expect(ends[0]?.payload).toHaveProperty("retry_in_ms", 50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one grace receipt for both countdown and routing", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let calls = 0;
    const retrySameAccount = vi.fn();
    const llm: LLMInterface = {
      retryPoolSize: 1,
      retrySameAccount,
      async *streamGenerate() {
        calls++;
        return {
          status: "retryable",
          retryDelay: { rawMs: 100, bufferedMs: 300, source: "header" },
          retryAccount: { accountId: "opaque", rateLimited: true },
        };
      },
    };
    const pending = consume(new ContextEngine({ llm, environment }));
    await vi.runAllTimersAsync();
    const { messages } = await pending;
    expect(calls).toBe(3);
    expect(retrySameAccount).toHaveBeenCalledTimes(1);
    const ends = messages.filter(isRequestEnd);
    expect(
      ends.slice(0, 2).map((message) => (message.payload as { retry_in_ms?: number }).retry_in_ms),
    ).toEqual([300, 300]);
    expect(Date.now() - startedAt).toBe(600);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for account eligibility when the whole pool is cooling down", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let calls = 0;
    const llm: LLMInterface = {
      retryPoolSize: 3,
      async *streamGenerate() {
        calls++;
        return calls === 1
          ? { status: "retryable", retryAccount: { rateLimited: true, poolUnavailableForMs: 8000 } }
          : { status: "completed" };
      },
    };
    const pending = consume(new ContextEngine({ llm, environment }));
    await vi.runAllTimersAsync();
    const { messages } = await pending;
    expect(calls).toBe(2);
    expect(Date.now() - startedAt).toBe(8000);
    expect(messages.find(isRequestEnd)?.payload).toHaveProperty("retry_in_ms", 8000);
  });

  it("can select the legacy policy for rollback", async () => {
    let calls = 0;
    const llm: LLMInterface = {
      retryPoolSize: 6,
      async *streamGenerate() {
        calls++;
        return { status: "retryable" };
      },
    };
    const { result } = await consume(
      new ContextEngine({ llm, environment, retryPolicyVersion: "legacy", maxReconnects: 0 }),
    );
    expect(calls).toBe(1);
    expect(result?.kind).toBe("llm_failure");
  });

  it("shares one compaction budget across unusable summaries and transport failures", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const llm: LLMInterface = {
      retryPoolSize: 1,
      async *streamGenerate() {
        calls++;
        if (calls === 1) {
          yield assistantText("answer");
          yield tokenUsage(emptyTokenCounts(), {
            total: 1,
            output: 1,
            cache_read: 0,
            cache_write: 0,
          });
          return { status: "completed" };
        }
        if (calls === 3) return { status: "retryable", errorCode: "network" };
        yield assistantText("[summary][/summary]");
        return { status: "completed" };
      },
    };
    const openNextContext = vi.fn(async () => {
      throw new Error("No usable summary should open a context");
    });
    const pending = consume(
      new ContextEngine({
        llm,
        environment,
        openNextContext,
        compaction: {
          maxContextLength: -1,
          maxSessionTurns: 1,
          mode: "summarize",
          prompt: "Summarize",
        },
      }),
    );
    await vi.runAllTimersAsync();
    const { messages } = await pending;
    expect(calls).toBe(4);
    expect(openNextContext).not.toHaveBeenCalled();
    const end = messages.find(
      (message) => "type" in message.payload && message.payload.type === "compaction_end",
    );
    expect(end?.payload).toMatchObject({
      status: "retryable",
      attempt: 3,
      error_code: "malformed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels during grace without sending or leaking account preference", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let calls = 0;
    const retrySameAccount = vi.fn();
    const llm: LLMInterface = {
      retryPoolSize: 1,
      retrySameAccount,
      async *streamGenerate() {
        calls++;
        return {
          status: "retryable",
          retryDelay: { rawMs: 1000, bufferedMs: 1200, source: "header" },
          retryAccount: { accountId: "opaque", rateLimited: true },
        };
      },
    };
    const pending = consume(new ContextEngine({ llm, environment }), abort.signal, (message) => {
      if (isRequestEnd(message)) setTimeout(() => abort.abort(), 100);
    });
    await vi.runAllTimersAsync();
    const { result } = await pending;
    expect(result?.kind).toBe("abort");
    expect(calls).toBe(1);
    expect(retrySameAccount).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
