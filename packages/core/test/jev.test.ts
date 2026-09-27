import { describe, expect, it } from "vitest";
import type { OmniMessage, ToolCallPayload } from "../src/omnimessage/index.js";
import {
  assistantText,
  isEventMessage,
  toolCall,
  toolCallOutput,
  tokenUsage,
  userText,
} from "../src/omnimessage/index.js";
import type { EnvironmentInterface, LLMInterface, LLMOutcome } from "../src/interfaces/index.js";
import type { PreToolUseHook } from "../src/hooks/tool-hook.js";
import { JevCircuitOpenError, JevClient } from "../src/jev/client.js";
import {
  buildJevAdvisoryState,
  createJevAdvisoryHook,
  JEV_MAX_ARGUMENT_CHARS,
  JEV_TOOL_QUESTIONS,
  JevToolAdvisor,
} from "../src/jev/advisor.js";
import { createJevAdvisor } from "../src/jev/config.js";
import { AdvisoryActivityRecorder } from "../src/jev/activity.js";
import { Session } from "../src/session.js";
import type { HookPayload } from "../src/omnimessage/types.js";

const usage = (n: number) => ({ cache_read: 0, cache_write: 0, output: n, total: n });

const answer = (overrides: Record<string, unknown> = {}) => ({
  model: "jev-test",
  answers: {
    tool_fit: {
      type: "choice",
      choice: "matches",
      confidence: 0.91,
      probabilities: { matches: 0.91, different_tool: 0.05, no_tool: 0.04 },
    },
    risk: {
      type: "score",
      score: 2,
      confidence: 0.8,
      legend: {
        "0": JEV_TOOL_QUESTIONS.risk.criteria[0],
        "1": JEV_TOOL_QUESTIONS.risk.criteria[1],
        "2": JEV_TOOL_QUESTIONS.risk.criteria[2],
        "3": JEV_TOOL_QUESTIONS.risk.criteria[3],
        "4": JEV_TOOL_QUESTIONS.risk.criteria[4],
      },
      probabilities: { "0": 0.1, "1": 0.2, "2": 0.6, "3": 0.1, "4": 0 },
    },
    needs_tool: { type: "noul", noul: 0.9 },
    arguments_complete: { type: "noul", noul: 0.85 },
    requires_approval: { type: "noul", noul: 0.2 },
    ...overrides,
  },
  usage: { input_tokens: 12, output_tokens: 3 },
});

function fakeFetch(response: () => Response): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("JevClient", () => {
  it("uses the verified System One endpoint, bearer auth, and bounded request settings", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(answer()));
    const client = new JevClient({
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:8799",
      model: "jev-test",
      timeoutMs: 1234,
      maxRetries: 0,
      fetch,
      now: () => 0,
    });
    const result = await client.ask({
      state: JSON.stringify({ hello: "world" }),
      questions: JEV_TOOL_QUESTIONS,
    });
    expect(result.model).toBe("jev-test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8799/v1/systemone");
    expect(calls[0]!.init?.redirect).toBe("error");
    const init = calls[0]!.init!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body)) as {
      state: string;
      questions: Record<string, { type: string }>;
    };
    expect(body.state).toContain("hello");
    expect(
      Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key, q.type])),
    ).toEqual({
      tool_fit: "choice",
      risk: "score",
      needs_tool: "noul",
      arguments_complete: "noul",
      requires_approval: "noul",
    });
  });

  it("pins the official endpoint, rejects remote plaintext, and refuses redirects", async () => {
    const previous = process.env.TYPESAFE_BASE_URL;
    process.env.TYPESAFE_BASE_URL = "http://ambient.example";
    try {
      const { fetch, calls } = fakeFetch(() => Response.json(answer()));
      const client = new JevClient({ apiKey: "test-key", maxRetries: 0, fetch });
      await client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS });
      expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_BASE_URL;
      else process.env.TYPESAFE_BASE_URL = previous;
    }

    expect(() => new JevClient({ apiKey: "test-key", baseUrl: "http://remote.example" })).toThrow(
      /https/,
    );
    const redirect = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "https://other.example" } }),
    );
    const redirectClient = new JevClient({
      apiKey: "test-key",
      baseUrl: "https://api.typesafe.ai",
      maxRetries: 0,
      fetch: redirect.fetch,
    });
    await expect(
      redirectClient.ask({ state: "s", questions: JEV_TOOL_QUESTIONS }),
    ).rejects.toThrow();
  });

  it("reports its OWN deadline as a timeout, not as a user cancellation", async () => {
    // The internal deadline fires the same composed signal the SDK watches, and the SDK maps
    // any abort of it to a user abort — so a slow provider used to be reported to the reader as
    // "cancelled", blaming them for the provider's latency and leaving "timeout" unreachable.
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const advisor = new JevToolAdvisor({
      client: new JevClient({
        apiKey: "test-key",
        maxRetries: 0,
        totalTimeoutMs: 300,
        fetch: fetchImpl,
      }),
      deadlineMs: 300,
    });
    const result = await advisor.advise({ toolName: "bash", argumentsJson: "{}" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("timeout");
  });

  it("forgets failures that are older than the reset window", async () => {
    // A process-wide breaker reached by every session meant one network blip during a run with
    // several tool calls in flight tripped it by itself, and then every tool call on the server
    // recorded "circuit open" for the whole window.
    let clock = 1_000_000;
    const failing = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const client = new JevClient({
      apiKey: "test-key",
      maxRetries: 0,
      failureThreshold: 3,
      circuitResetMs: 1000,
      now: () => clock,
      fetch: failing,
    });
    for (let i = 0; i < 2; i += 1) {
      await expect(client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS })).rejects.toThrow();
    }
    expect(client.circuitState()).toBe("closed");
    // These two failures are a minute old by the third: the provider has had time to recover,
    // so they must not combine with the two above to open the circuit.
    clock += 60_000;
    for (let i = 0; i < 2; i += 1) {
      await expect(client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS })).rejects.toThrow();
    }
    expect(client.circuitState()).toBe("closed");
    // A third failure INSIDE one window still opens it.
    await expect(client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS })).rejects.toThrow();
    expect(client.circuitState()).toBe("open");
  });

  it("never puts an argument KEY on the wire that spells a path or a credential", () => {
    // Keys are model-authored, so a key can carry anything a value could. Redaction covers
    // credential shapes; a bare path holds no recognisable secret and would otherwise go out.
    const state = buildJevAdvisoryState({
      toolName: "read_file",
      argumentsJson: JSON.stringify({
        "C:\\Users\\acer\\secret-project\\notes.md": "x",
        "api_key=sk-abcdefghijklmnopqrstuvwxyz012345": "y",
        path: "ok",
      }),
    });
    const args = JSON.parse(state).tool.arguments as { keys: string[]; value_types: string[] };
    // The PATH is reduced to its last segment: the name is what tells the model this argument
    // is a file path at all, and the directory does not.
    expect(args.keys[0]).toBe("notes.md");
    expect(state).not.toContain("Users");
    expect(state).not.toContain("secret-project");
    expect(state).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    // An ordinary key is left completely alone, and the types stay index-aligned.
    expect(args.keys[2]).toBe("path");
    expect(args.value_types).toEqual(["string", "string", "string"]);
    expect(args.value_types).toHaveLength(args.keys.length);
  });

  it("marks an over-budget call as omitted rather than answering about a partial one", () => {
    const huge = JSON.stringify({ body: "x".repeat(JEV_MAX_ARGUMENT_CHARS + 10) });
    const summary = JSON.parse(
      buildJevAdvisoryState({ toolName: "write_file", argumentsJson: huge }),
    ).tool.arguments as { omitted: boolean; reason?: string };
    expect(summary.omitted).toBe(true);
    expect(summary.reason).toBe("over_budget");
  });

  it("enforces one hard total deadline and does not count caller cancellation as a failure", async () => {
    let calls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          {
            once: true,
          },
        );
      });
    }) as typeof fetch;
    const client = new JevClient({
      apiKey: "test-key",
      maxRetries: 2,
      totalTimeoutMs: 60,
      failureThreshold: 1,
      fetch: fetchImpl,
    });
    await expect(
      client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS }, undefined, { deadlineMs: 50 }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(client.circuitState()).toBe("open");

    const controller = new AbortController();
    const cancelClient = new JevClient({
      apiKey: "test-key",
      maxRetries: 0,
      failureThreshold: 1,
      fetch: fetchImpl,
    });
    const pending = cancelClient.ask(
      { state: "s", questions: JEV_TOOL_QUESTIONS },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelClient.circuitState()).toBe("closed");
  });

  it("opens a local circuit after consecutive failures and recovers after the reset window", async () => {
    let now = 0;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= 2) throw new Error("connection refused");
      return Response.json(answer());
    }) as typeof fetch;
    const client = new JevClient({
      apiKey: "test-key",
      maxRetries: 0,
      failureThreshold: 2,
      circuitResetMs: 1000,
      fetch: fetchImpl,
      now: () => now,
    });
    await expect(client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS })).rejects.toThrow();
    await expect(client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS })).rejects.toThrow();
    expect(client.circuitState()).toBe("open");
    await expect(client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS })).rejects.toBeInstanceOf(
      JevCircuitOpenError,
    );
    expect(calls).toBe(2);
    now = 1000;
    await expect(client.ask({ state: "s", questions: JEV_TOOL_QUESTIONS })).resolves.toMatchObject({
      model: "jev-test",
    });
    expect(calls).toBe(3);
    expect(client.circuitState()).toBe("closed");
  });
});

describe("JevToolAdvisor", () => {
  it("normalizes the SDK's zero-based score, scrubs arguments, and never returns a decision", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(answer()));
    const advisor = new JevToolAdvisor({
      client: new JevClient({ apiKey: "test-key", maxRetries: 0, fetch }),
    });
    const result = await advisor.advise({
      toolName: "exec_command",
      argumentsJson: JSON.stringify({
        cmd: "ls",
        api_key: "sk-ant-abcdefghijklmnopqrstuvwxyz123456",
      }),
      permission: "rw",
    });
    expect(result).toMatchObject({
      status: "advised",
      choice: "matches",
      confidence: 0.91,
      riskScore: 3,
      needsToolProbability: 0.9,
      argumentsCompleteProbability: 0.85,
      requiresApprovalProbability: 0.2,
      inputTokens: 12,
      outputTokens: 3,
    });
    const body = JSON.parse(String(calls[0]!.init!.body)) as { state: string };
    expect(body.state).toContain("api_key");
    expect(body.state).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz123456");
    expect(buildJevAdvisoryState({ toolName: "x", argumentsJson: "not json" })).toContain(
      "advisory_only",
    );
    const optedIn = buildJevAdvisoryState({
      toolName: "x",
      argumentsJson: JSON.stringify({ token: "sk-ant-abcdefghijklmnopqrstuvwxyz123456" }),
      includeArguments: true,
    });
    expect(optedIn).toContain("<redacted>");
    expect(optedIn).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("turns malformed provider data into an explicit unavailable observation", async () => {
    const { fetch } = fakeFetch(() => Response.json({ model: "m", answers: { tool_fit: {} } }));
    const advisor = new JevToolAdvisor({
      client: new JevClient({ apiKey: "test-key", maxRetries: 0, fetch }),
    });
    const result = await advisor.advise({ toolName: "read_file", argumentsJson: "{}" });
    expect(result.status).toBe("unavailable");
    expect(result.choice).toBe("unknown");
    expect(result.reason).toBe("invalid_response");
  });

  it("keeps provider error bodies out of the advisory diagnostic", async () => {
    const { fetch } = fakeFetch(() => new Response("opaque-secret-from-provider", { status: 500 }));
    const advisor = new JevToolAdvisor({
      client: new JevClient({ apiKey: "test-key", maxRetries: 0, fetch }),
    });
    const result = await advisor.advise({ toolName: "read_file", argumentsJson: "{}" });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("provider_http_500");
    expect(JSON.stringify(result)).not.toContain("opaque-secret-from-provider");
  });

  it("counts protocol-invalid responses toward the circuit and rejects fractional risk overflow", async () => {
    let calls = 0;
    const { fetch } = fakeFetch(() => {
      calls += 1;
      const malformed = answer();
      return Response.json({
        ...malformed,
        usage: { input_tokens: 1.5, output_tokens: 2 },
      });
    });
    const client = new JevClient({
      apiKey: "test-key",
      maxRetries: 0,
      failureThreshold: 2,
      circuitResetMs: 1000,
      fetch,
    });
    const advisor = new JevToolAdvisor({ client });
    const first = await advisor.advise({ toolName: "read_file", argumentsJson: "{}" });
    const second = await advisor.advise({ toolName: "read_file", argumentsJson: "{}" });
    const third = await advisor.advise({ toolName: "read_file", argumentsJson: "{}" });
    expect(first.reason).toBe("invalid_response");
    expect(second.reason).toBe("invalid_response");
    expect(third.reason).toBe("circuit_open");
    expect(calls).toBe(2);

    const fractional = answer();
    fractional.answers.risk.score = 4.5;
    const fractionalAdvisor = new JevToolAdvisor({
      client: new JevClient({
        apiKey: "test-key",
        maxRetries: 0,
        fetch: fakeFetch(() => Response.json(fractional)).fetch,
      }),
    });
    const result = await fractionalAdvisor.advise({
      toolName: "read_file",
      argumentsJson: "{}",
    });
    expect(result.status).toBe("advised");
    expect(result.riskScore).toBe(5);
  });

  it("keeps endpoint and credential composition host-owned", () => {
    expect(() => createJevAdvisor({ apiKey: "" })).toThrow();
    expect(() => createJevAdvisor({ apiKey: "k", baseUrl: "file:///tmp/jev" })).toThrow();
    expect(createJevAdvisor({ apiKey: "k" })).toBeDefined();
  });

  it("exposes an event-only pre-tool-use hook", async () => {
    const { fetch } = fakeFetch(() => Response.json(answer()));
    const hook = createJevAdvisoryHook(
      new JevToolAdvisor({
        client: new JevClient({ apiKey: "test-key", maxRetries: 0, fetch }),
      }),
    );
    const result = await hook.run({
      sessionId: "s1",
      toolName: "read_file",
      toolCallId: "c1",
      argumentsJson: "{}",
    });
    expect(result).toMatchObject({ output: { jev_status: "advised", jev_choice: "matches" } });
    expect(result).not.toHaveProperty("decision");
  });
});

describe("Session advisory seam", () => {
  const environment: EnvironmentInterface = {
    listTools: async () => [],
    executeTool: async function* ({ toolCall: tc }) {
      yield toolCallOutput({ output: "ran", toolCallId: tc.payload.tool_call_id });
    },
    toolPermission: () => undefined,
  };

  function llm(): LLMInterface {
    let turn = 0;
    return {
      async *streamGenerate(): AsyncGenerator<OmniMessage, LLMOutcome> {
        turn += 1;
        if (turn === 1) {
          yield toolCall({
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "ls" }),
            toolCallId: "c1",
          });
          yield tokenUsage(usage(1), usage(1));
          return { status: "completed" };
        }
        yield assistantText("done");
        yield tokenUsage(usage(1), usage(1));
        return { status: "completed" };
      },
    };
  }

  it("adds no event when the host does not provide an advisor", async () => {
    const session = new Session({
      meta: {
        session_id: "s1",
        provider: "custom",
        model_id: "m",
        model_context_window: 1000,
        system_prompt: "sp",
        agent_state: "state",
        workspace: "workspace",
      },
      bootstrap: async () => ({ llm: llm() }),
      environment,
      imagesDir: "scratchpad",
      modelHasVision: true,
    });
    const stream: OmniMessage[] = [];
    for await (const msg of session.run([userText("go")], { approve: async () => "allow" })) {
      stream.push(msg);
    }
    expect(stream.some((m) => isEventMessage(m) && m.payload.type === "hook")).toBe(false);
  });

  it("keeps command-policy vetoes ahead of both an agent hook allow and the advisor", async () => {
    let advisorCalls = 0;
    let approvals = 0;
    let executions = 0;
    const advisor: PreToolUseHook = {
      name: "jev_advisory",
      run: async () => {
        advisorCalls += 1;
        return { output: { jev_status: "should-not-run" } };
      },
    };
    const session = new Session({
      meta: {
        session_id: "s1",
        provider: "custom",
        model_id: "m",
        model_context_window: 1000,
        system_prompt: "sp",
        agent_state: "state",
        workspace: "workspace",
      },
      bootstrap: async () => ({ llm: llm() }),
      environment: {
        ...environment,
        executeTool: async function* (request) {
          executions += 1;
          yield* environment.executeTool(request);
        },
      },
      imagesDir: "scratchpad",
      modelHasVision: true,
      hooks: {
        preToolUse: [
          {
            name: "agent_hook",
            run: async () => ({ decision: "allow", output: { agent_hook: "allow" } }),
          },
        ],
      },
      advisoryPreToolUse: advisor,
      commandPolicy: () => ({
        enabled: true,
        rules: [{ name: "no-ls", pattern: "ls" }],
      }),
    });
    for await (const _msg of session.run([userText("go")], {
      approve: async () => {
        approvals += 1;
        return "allow";
      },
    })) {
      // drain
    }
    expect(advisorCalls).toBe(0);
    expect(approvals).toBe(0);
    expect(executions).toBe(0);
  });

  it("reports to the counters the calls the advisor never saw, and why", async () => {
    // Without this the dashboard can only ever show what happened, never what did not — and
    // "how many calls were already decided before the advisor" is the number that says whether
    // the advisor is earning its place. Three distinct reasons, three distinct counters.
    const activity = new AdvisoryActivityRecorder();
    const advisor = createJevAdvisoryHook(
      new JevToolAdvisor({
        client: new JevClient({
          apiKey: "k",
          maxRetries: 0,
          fetch: fakeFetch(() => Response.json(answer())).fetch,
        }),
        activity,
      }),
    );

    // (a) a policy veto: the advisor must not be consulted.
    const vetoed = new Session({
      meta: {
        session_id: "s1",
        provider: "custom",
        model_id: "m",
        model_context_window: 1000,
        system_prompt: "sp",
        agent_state: "state",
        workspace: "workspace",
      },
      bootstrap: async () => ({ llm: llm() }),
      environment,
      imagesDir: "scratchpad",
      modelHasVision: true,
      advisoryPreToolUse: advisor,
      commandPolicy: () => ({ enabled: true, rules: [{ name: "no-ls", pattern: "ls" }] }),
    });
    for await (const _msg of vetoed.run([userText("go")])) {
      // drain
    }
    expect(activity.snapshot().skippedPolicy).toBe(1);
    expect(activity.snapshot().skippedDecided).toBe(0);
    expect(activity.snapshot().skipped).toBe(0);

    // (b) an ordinary hook already decided: counted as decided, not as a policy veto.
    activity.reset();
    const decided = new Session({
      meta: {
        session_id: "s2",
        provider: "custom",
        model_id: "m",
        model_context_window: 1000,
        system_prompt: "sp",
        agent_state: "state",
        workspace: "workspace",
      },
      bootstrap: async () => ({ llm: llm() }),
      environment,
      imagesDir: "scratchpad",
      modelHasVision: true,
      hooks: {
        preToolUse: [
          {
            name: "agent_hook",
            run: async () => ({ decision: "deny", reason: "not now" }),
          },
        ],
      },
      advisoryPreToolUse: advisor,
    });
    for await (const _msg of decided.run([userText("go")], { approve: async () => "allow" })) {
      // drain
    }
    expect(activity.snapshot().skippedDecided).toBe(1);
    expect(activity.snapshot().skippedPolicy).toBe(0);
    expect(activity.snapshot().answered).toBe(0);
  });

  it("records the advisor but still requires the normal approval callback", async () => {
    let advisorCalls = 0;
    let approvals = 0;
    let executions = 0;
    const advisor: PreToolUseHook = {
      name: "jev_advisory",
      run: async () => {
        advisorCalls += 1;
        // A buggy/adversarial advisor tries to authorize; the Session must discard that decision.
        return { decision: "allow", reason: "model said so", output: { jev_status: "advised" } };
      },
    };
    const session = new Session({
      meta: {
        session_id: "s1",
        provider: "custom",
        model_id: "m",
        model_context_window: 1000,
        system_prompt: "sp",
        agent_state: "state",
        workspace: "workspace",
      },
      bootstrap: async () => ({ llm: llm() }),
      environment: {
        ...environment,
        executeTool: async function* (request) {
          executions += 1;
          yield* environment.executeTool(request);
        },
      },
      imagesDir: "scratchpad",
      modelHasVision: true,
      advisoryPreToolUse: advisor,
    });
    const stream: OmniMessage[] = [];
    for await (const msg of session.run([userText("go")], {
      approve: async () => {
        approvals += 1;
        return "deny";
      },
    })) {
      stream.push(msg);
    }
    expect(advisorCalls).toBe(1);
    expect(approvals).toBe(1);
    expect(executions).toBe(0);
    const hookEvent = stream.find((m) => isEventMessage(m) && m.payload.type === "hook");
    const hookPayload = hookEvent!.payload as HookPayload;
    expect(hookPayload.output).toEqual({ jev_status: "advised" });
    expect(hookPayload.decision).toBeUndefined();
    expect(hookPayload.reason).toBeUndefined();
    const approval = stream.find(
      (m) => isEventMessage(m) && m.payload.type === "approval_decision",
    );
    expect((approval!.payload as { decision: string }).decision).toBe("deny");
  });
});
