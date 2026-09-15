import { useState, useMemo } from "react";
import type { MemoryTopicNode } from "./memory-types";
import { simulateSemanticRecall } from "./memory-types";
import { Input } from "../../components/ui/input";

function SearchIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SparklesIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 3l1.912 5.888L20 10l-6.088 1.112L12 17l-1.912-5.888L4 10l6.088-1.112z" />
    </svg>
  );
}

function SlidersIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function ArrowUpRightIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </svg>
  );
}

export interface MemoryRecallSimulatorProps {
  topics: MemoryTopicNode[];
  onSelectTopic: (id: string) => void;
  selectedTopicId: string | null;
}

export function MemoryRecallSimulator({
  topics,
  onSelectTopic,
  selectedTopicId,
}: MemoryRecallSimulatorProps) {
  const [query, setQuery] = useState("React state management architecture");
  const [threshold, setThreshold] = useState(0.2);

  const recallResults = useMemo(() => {
    return simulateSemanticRecall(query, topics, threshold);
  }, [query, topics, threshold]);

  const totalTokensRecalled = useMemo(() => {
    return recallResults.reduce((sum, r) => sum + r.tokenCount, 0);
  }, [recallResults]);

  return (
    <div className="flex flex-col h-full border border-border rounded-lg bg-card overflow-hidden">
      {/* Simulator Header */}
      <div className="p-3.5 border-b border-border bg-muted/20 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-medium text-xs text-foreground">
            <SparklesIcon size={14} className="text-primary" />
            <span>Semantic Recall Simulator</span>
          </div>

          <div className="text-[11px] text-muted-foreground font-mono">
            Recalled: <span className="font-semibold text-primary">{totalTokensRecalled}</span>{" "}
            tokens
          </div>
        </div>

        {/* Search Query Input */}
        <div className="relative">
          <SearchIcon
            size={14}
            className="absolute left-2.5 top-2 text-muted-foreground pointer-events-none"
          />
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Simulate prompt query to test memory recall..."
            className="pl-8 h-8"
          />
        </div>

        {/* Threshold Filter Slider */}
        <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <SlidersIcon size={12} />
            <span>Similarity Threshold:</span>
            <span className="font-mono font-medium text-foreground">
              {Math.round(threshold * 100)}%
            </span>
          </div>
          <input
            type="range"
            min="0.1"
            max="0.9"
            step="0.05"
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
            className="w-28 accent-primary h-1.5 cursor-pointer"
          />
        </div>
      </div>

      {/* Results List */}
      <div className="flex-1 p-3 overflow-y-auto space-y-2">
        {recallResults.length === 0 ? (
          <div className="h-40 flex flex-col items-center justify-center text-center text-muted-foreground">
            <SearchIcon size={24} className="text-muted-foreground/40 mb-1" />
            <p className="text-xs">
              No matching topics exceeded threshold ({Math.round(threshold * 100)}%)
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Try a broader query or lower the threshold
            </p>
          </div>
        ) : (
          recallResults.map((result) => {
            const isSelected = selectedTopicId === result.topic.id;
            const pct = Math.round(result.relevance * 100);

            return (
              <div
                key={result.topic.id}
                onClick={() => onSelectTopic(result.topic.id)}
                className={`p-2.5 rounded-md border cursor-pointer transition-all ${
                  isSelected
                    ? "bg-primary/5 border-primary/40 shadow-sm"
                    : "bg-muted/30 border-border hover:bg-muted/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`text-[9px] px-1.5 py-0.2 rounded font-medium border uppercase ${
                        result.topic.scope === "user"
                          ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                          : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      }`}
                    >
                      {result.topic.scope}
                    </span>
                    <span className="text-xs font-medium text-foreground truncate">
                      {result.topic.title}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-semibold ${
                        pct >= 70
                          ? "bg-emerald-500/10 text-emerald-400"
                          : pct >= 40
                            ? "bg-amber-500/10 text-amber-400"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {pct}%
                    </span>
                    <ArrowUpRightIcon size={12} className="text-muted-foreground" />
                  </div>
                </div>

                {/* Relevance Progress Bar */}
                <div className="w-full bg-secondary h-1 rounded-full overflow-hidden mt-1.5">
                  <div
                    className={`h-full transition-all duration-300 ${
                      pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-primary/70"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <p className="text-[11px] text-muted-foreground line-clamp-1 mt-1 font-mono">
                  {result.snippet}
                </p>

                <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1 pt-1 border-t border-border/40">
                  <span>{result.topic.name}</span>
                  <span className="font-mono">{result.tokenCount} tokens</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
