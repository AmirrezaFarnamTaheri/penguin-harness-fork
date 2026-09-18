import { describe, expect, it } from "vitest";
import type { UniConfig, UniEvent, UniMessage } from "@prismshadow/agenthub";
import { GenerativeModel, buildUniConfig } from "../src/llm/index.js";
import { userText } from "../src/omnimessage/index.js";
import type { OmniMessage } from "../src/omnimessage/index.js";

/** Exercises the real request configuration seam without making any provider calls. */
class PrefixModel extends GenerativeModel {
  readonly requests: Array<{ message: UniMessage; config: UniConfig }> = [];

  protected override async *openStream(
    message: UniMessage,
    _signal: AbortSignal,
    config: UniConfig,
  ): AsyncIterable<UniEvent> {
    this.requests.push({ message, config });
    yield {
      role: "assistant",
      event_type: "delta",
      content_items: [{ type: "text", text: "ok" }],
      finish_reason: "stop",
      usage_metadata: {
        cached_tokens: this.requests.length === 1 ? 0 : 300,
        prompt_tokens: 100,
        thoughts_tokens: 0,
        response_tokens: 10,
      },
    };
  }
}

describe("static prompt prefix at the LLM request boundary", () => {
  it("reuses the system/tool prefix across turns while preserving measured cache buckets", async () => {
    const tools = [
      { name: "lookup", description: "Read a local record", parameters: { type: "object" } },
    ];
    const systemPrompt = "Stable agent instructions.\nTool policies remain unchanged.";
    const model = new PrefixModel({ modelId: "claude-sonnet-4-6", tools, systemPrompt });
    const events: OmniMessage[] = [];
    for await (const event of model.streamGenerate({ newMessages: [userText("first turn")] })) {
      events.push(event);
    }
    for await (const event of model.streamGenerate({
      newMessages: [userText("second turn")],
      thinkingLevel: "high",
    })) {
      events.push(event);
    }
    expect(model.requests).toHaveLength(2);
    const [first, second] = model.requests;
    expect(first!.config.system_prompt).toBe(systemPrompt);
    expect(second!.config.system_prompt).toBe(systemPrompt);
    expect(second!.config.tools).toBe(first!.config.tools);
    expect(first!.config.tools).toEqual(tools);
    expect(first!.message.content_items).toEqual([{ type: "text", text: "first turn" }]);
    expect(second!.message.content_items).toEqual([{ type: "text", text: "second turn" }]);
    // Provider caching is enabled by AgentHub's default. Do not force provider-specific
    // cache_control, a guessed TTL, or an extra copy of the prefix into user messages.
    expect(first!.config.prompt_caching).toBeUndefined();
    expect(second!.config.system_prompt).not.toContain("second turn");
    const usage = events.flatMap((event) =>
      (event.payload as { type?: string }).type === "token_usage"
        ? [
            (
              event.payload as {
                request: { cache_read: number; cache_write: number; output: number; total: number };
              }
            ).request,
          ]
        : [],
    );
    expect(usage).toEqual([
      { cache_read: 0, cache_write: 100, output: 10, total: 110 },
      { cache_read: 300, cache_write: 100, output: 10, total: 410 },
    ]);
  });

  it("takes a new prefix when the model is rebuilt, rather than sharing another session's prefix", () => {
    const first = buildUniConfig({
      modelId: "claude-sonnet-4-6",
      tools: [],
      systemPrompt: "Session A",
    });
    const second = buildUniConfig({
      modelId: "claude-sonnet-4-6",
      tools: [],
      systemPrompt: "Session B",
    });
    expect(first.system_prompt).toBe("Session A");
    expect(second.system_prompt).toBe("Session B");
  });
});
