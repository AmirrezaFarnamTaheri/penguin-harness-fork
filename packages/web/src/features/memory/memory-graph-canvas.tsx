import { useMemo } from "react";
import type { MemoryTopicNode } from "./memory-types";
import { memoryLinkEdges } from "./memory-types";
import { TopologyGraphCanvas } from "../topology/topology-graph-canvas";
import { mutedClass, useInspectionCopy } from "../context/inspection-ui";
export interface MemoryGraphCanvasProps {
  topics: MemoryTopicNode[];
  selectedTopicId: string | null;
  onSelectTopic: (id: string) => void;
  highlightedTopicIds?: Set<string>;
}
export function MemoryGraphCanvas({
  topics,
  selectedTopicId,
  onSelectTopic,
  highlightedTopicIds,
}: MemoryGraphCanvasProps) {
  const copy = useInspectionCopy();
  const nodes = useMemo(
    () =>
      topics.map((topic) => ({
        id: topic.id,
        name: topic.title,
        filePath: `${topic.scopeKey ?? topic.scope}/${topic.name}`,
        kind: "file" as const,
      })),
    [topics],
  );
  const edges = useMemo(
    () => memoryLinkEdges(topics).map((edge) => ({ ...edge, kind: "references" as const })),
    [topics],
  );
  if (!topics.length)
    return (
      <p className={`py-8 ${mutedClass}`}>
        {copy(
          "No matching topics. Clear filters to see more memories.",
          "没有匹配主题。清除筛选以查看更多记忆。",
        )}
      </p>
    );
  return (
    <section className="space-y-3">
      <p className={mutedClass}>
        {topics.length} {copy("topics", "个主题")} · {edges.length}{" "}
        {copy(
          "resolved links within the selected files. Unresolved links are not drawn.",
          "条已解析链接（仅所选文件内），未解析链接不显示。",
        )}
      </p>
      <TopologyGraphCanvas
        nodes={nodes}
        edges={edges}
        selectedNodeId={selectedTopicId}
        onSelectNode={onSelectTopic}
        highlightedPathNodeIds={highlightedTopicIds}
      />
    </section>
  );
}
