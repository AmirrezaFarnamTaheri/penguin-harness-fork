/** Debounced server search with generation fencing; errors never become local estimates. */
import { getMemorySearch } from "../../api/endpoints";
import type { MemoryRecallResult, MemoryTopicNode } from "./memory-types";

interface RecallSearchOptions {
  projectId: string;
  agentId: string;
  onResults: (results: MemoryRecallResult[], source: "live") => void;
  onError: (error: Error) => void;
  delayMs?: number;
}

export function createRecallSearch(options: RecallSearchOptions) {
  let topics: MemoryTopicNode[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;

  async function run(text: string, requestGeneration: number) {
    try {
      const body = await getMemorySearch(options.projectId, options.agentId, text);
      if (disposed || requestGeneration !== generation) return;
      const byKey = new Map(
        topics.map((topic) => [`${topic.scopeKey ?? topic.scope}/${topic.name}`, topic]),
      );
      // Honor the inspection page's scope/title filters and only offer selectable documents.
      const results = body.results.flatMap((hit): MemoryRecallResult[] => {
        const topic = byKey.get(`${hit.scopeKey}/${hit.fileName}`);
        return topic
          ? [{ topic, relevance: hit.relevance, tokenCount: hit.tokens, snippet: hit.snippet }]
          : [];
      });
      options.onResults(results, "live");
    } catch (error) {
      if (disposed || requestGeneration !== generation) return;
      options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    setTopics(next: MemoryTopicNode[]) {
      topics = next;
    },
    query(text: string) {
      if (disposed) return;
      const requestGeneration = ++generation;
      clearTimeout(timer);
      options.onResults([], "live");
      const trimmed = text.trim();
      if (!trimmed) return;
      timer = setTimeout(() => void run(trimmed, requestGeneration), options.delayMs ?? 300);
    },
    dispose() {
      disposed = true;
      generation++;
      clearTimeout(timer);
    },
  };
}
