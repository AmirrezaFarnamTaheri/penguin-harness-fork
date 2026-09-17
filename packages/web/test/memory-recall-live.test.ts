import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecallSearch } from "../src/features/memory/memory-recall-query";
import type { MemoryTopicNode } from "../src/features/memory/memory-types";

const topic: MemoryTopicNode = {
  id: "ws/db.md",
  name: "db.md",
  title: "Database",
  scope: "workspace",
  scopeKey: "ws",
  bytes: 40,
  tokens: 10,
  tags: [],
  updatedAt: "2026-09-17",
  content: "postgresql",
};
const response = (snippet = "Fresh server text") =>
  new Response(
    JSON.stringify({
      query: "database",
      results: [{ scopeKey: "ws", fileName: "db.md", relevance: 1, tokens: 46, snippet }],
    }),
    { headers: { "content-type": "application/json" } },
  );

function setup() {
  vi.useFakeTimers();
  const onResults = vi.fn();
  const onError = vi.fn();
  const search = createRecallSearch({
    projectId: "p1",
    agentId: "default_agent",
    onResults,
    onError,
  });
  search.setTopics([topic]);
  return { search, onResults, onError };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live memory recall", () => {
  it("debounces and maps server matches to the loaded scope-specific topic", async () => {
    const fetcher = vi.fn(async (_input: string) => response());
    vi.stubGlobal("fetch", fetcher);
    const { search, onResults } = setup();
    search.query("data");
    search.query(" database ");
    await vi.advanceTimersByTimeAsync(299);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/projects/p1/agents/default_agent/memory/search?q=database",
    );
    expect(onResults).toHaveBeenLastCalledWith(
      [{ topic, relevance: 1, tokenCount: 46, snippet: "Fresh server text" }],
      "live",
    );
    search.dispose();
  });

  it("invalidates in-flight results immediately when the query changes or clears", async () => {
    let resolve: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { search, onResults } = setup();
    search.query("old");
    await vi.advanceTimersByTimeAsync(300);
    search.query("");
    onResults.mockClear();
    resolve(response("obsolete"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onResults).not.toHaveBeenCalled();
    search.dispose();
  });

  it("reports failure instead of disguising local estimates as live results", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const { search, onResults, onError } = setup();
    search.query("postgresql");
    await vi.advanceTimersByTimeAsync(300);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResults.mock.calls.some((call) => call[1] === "local")).toBe(false);
    search.dispose();
  });

  it("never delivers results after disposal", async () => {
    let resolve: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const { search, onResults } = setup();
    search.query("database");
    await vi.advanceTimersByTimeAsync(300);
    search.dispose();
    onResults.mockClear();
    resolve(response());
    await vi.advanceTimersByTimeAsync(0);
    expect(onResults).not.toHaveBeenCalled();
  });
});
