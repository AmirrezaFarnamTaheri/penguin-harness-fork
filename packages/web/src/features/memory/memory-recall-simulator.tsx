import { useEffect, useState } from "react";
import type { MemoryRecallResult, MemoryTopicNode } from "./memory-types";
import { createRecallSearch } from "./memory-recall-query";
import { Input } from "../../components/ui/input";
import {
  mutedClass,
  rowButtonClass,
  selectedClass,
  useInspectionCopy,
} from "../context/inspection-ui";
export interface MemoryRecallSimulatorProps {
  projectId: string;
  agentId: string;
  topics: MemoryTopicNode[];
  onSelectTopic: (id: string) => void;
  selectedTopicId: string | null;
}
export function MemoryRecallSimulator({
  projectId,
  agentId,
  topics,
  onSelectTopic,
  selectedTopicId,
}: MemoryRecallSimulatorProps) {
  const copy = useInspectionCopy();
  const [query, setQuery] = useState("");
  const [threshold, setThreshold] = useState(0.2);
  const [matches, setMatches] = useState<MemoryRecallResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setMatches([]);
    setError(null);
    setLoading(Boolean(query.trim()));
    const search = createRecallSearch({
      projectId,
      agentId,
      onResults: (next) => {
        setMatches(next);
        setLoading(false);
      },
      onError: (err) => {
        setError(err.message);
        setLoading(false);
      },
    });
    search.setTopics(topics);
    search.query(query);
    setLoading(Boolean(query.trim()));
    return () => search.dispose();
  }, [projectId, agentId, query, topics]);
  const results = matches.filter((result) => result.relevance >= threshold);
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">{copy("Keyword recall test", "关键词召回测试")}</h2>
      <p className={mutedClass}>
        {copy(
          "Searches saved topic files on the server using word overlap, not embeddings or the agent's actual retrieval. Token counts use a rough bytes ÷ 4 estimate.",
          "通过服务器对已保存的主题文件进行词汇匹配，并非向量检索或智能体的实际召回。Token 数按字节数 ÷ 4 粗略估算。",
        )}
      </p>
      <Input
        aria-label={copy("Recall query", "召回查询")}
        placeholder={copy("Enter words to find in your memories", "输入要在记忆中查找的词语")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <label className="flex flex-wrap items-center gap-3">
        {copy("Minimum word overlap", "最低词汇匹配率")} {Math.round(threshold * 100)}%
        <input
          aria-label={copy("Minimum word overlap", "最低词汇匹配率")}
          className="accent-brand-600"
          type="range"
          min="0.1"
          max="0.9"
          step="0.05"
          value={threshold}
          onChange={(event) => setThreshold(Number(event.target.value))}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <p role="status" className={mutedClass}>
        {loading
          ? copy("Searching saved memories…", "正在搜索已保存的记忆…")
          : error
            ? copy("Search failed. Change the query to retry.", "搜索失败，请修改查询重试。")
            : !query.trim()
              ? copy("Enter a query to test recall.", "输入查询以测试召回。")
              : results.length
                ? `${results.length} ${copy("matches", "项匹配")} · ~${results.reduce((sum, result) => sum + result.tokenCount, 0).toLocaleString()} tokens`
                : copy(
                    "No matches. Try different words or lower the minimum overlap.",
                    "没有匹配项。请更换词语或降低匹配率。",
                  )}
      </p>
      <ul className="max-h-[28rem] overflow-y-auto">
        {results.map((result) => (
          <li key={result.topic.id}>
            <button
              type="button"
              aria-pressed={selectedTopicId === result.topic.id}
              onClick={() => onSelectTopic(result.topic.id)}
              className={`${rowButtonClass} ${selectedTopicId === result.topic.id ? selectedClass : ""}`}
            >
              <span className="flex justify-between gap-3">
                <span className="min-w-0 break-words font-semibold">{result.topic.title}</span>
                <span>{Math.round(result.relevance * 100)}%</span>
              </span>
              <span className={`mt-1 block break-all ${mutedClass}`}>
                {result.topic.scopeKey ?? result.topic.scope} / {result.topic.name}
              </span>
              <span className={`mt-1 block break-words ${mutedClass}`}>{result.snippet}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
