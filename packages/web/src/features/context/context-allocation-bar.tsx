import type { SessionContextResponse } from "@prismshadow/penguin-server/api";

export interface ContextAllocationBarProps {
  data: SessionContextResponse;
  contextWindow?: number;
}

export function ContextAllocationBar({ data, contextWindow = 200000 }: ContextAllocationBarProps) {
  const parts = [
    {
      label: "System Prompt",
      tokens: data.systemPrompt,
      color: "bg-blue-500",
      text: "text-blue-400",
    },
    { label: "Tool Defs", tokens: data.toolDefs, color: "bg-purple-500", text: "text-purple-400" },
    {
      label: "User Messages",
      tokens: data.userMessages,
      color: "bg-indigo-500",
      text: "text-indigo-400",
    },
    {
      label: "Assistant Output",
      tokens: data.assistantMessages,
      color: "bg-cyan-500",
      text: "text-cyan-400",
    },
    {
      label: "Tool Calls",
      tokens: data.toolRequests,
      color: "bg-amber-500",
      text: "text-amber-400",
    },
    {
      label: "Tool Results",
      tokens: data.toolResults,
      color: "bg-emerald-500",
      text: "text-emerald-400",
    },
  ];

  const totalTokens = parts.reduce((acc, p) => acc + p.tokens, 0);
  const occupancyPct =
    contextWindow > 0 ? Math.min(100, Math.round((totalTokens / contextWindow) * 100)) : 0;
  const thresholdPct =
    data.compactionThreshold && contextWindow > 0
      ? Math.min(100, Math.round((data.compactionThreshold / contextWindow) * 100))
      : null;

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl border border-gray-800 bg-gray-950 font-mono text-xs select-none">
      <div className="flex items-center justify-between pb-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
          <h3 className="font-bold text-sm text-gray-100">Context Window Allocation</h3>
        </div>
        <div className="flex items-center gap-2 text-gray-400 text-[11px]">
          <span>
            Total: <strong className="text-gray-100">{totalTokens.toLocaleString()}</strong> /{" "}
            {contextWindow.toLocaleString()} tokens
          </span>
          <span className="text-cyan-400 font-bold">({occupancyPct}%)</span>
        </div>
      </div>

      {/* Segmented Progress Bar with Threshold Marker */}
      <div className="relative w-full h-3 bg-gray-900 rounded-full overflow-hidden flex">
        {totalTokens === 0 ? (
          <div className="w-full h-full bg-gray-800" />
        ) : (
          parts.map((part, idx) => {
            if (part.tokens <= 0) return null;
            const pct = (part.tokens / totalTokens) * 100;
            return (
              <div
                key={idx}
                className={`h-full ${part.color} transition-all duration-300`}
                style={{ width: `${pct}%` }}
                title={`${part.label}: ${part.tokens.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
              />
            );
          })
        )}

        {/* Compaction Threshold line */}
        {thresholdPct !== null && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-rose-500 z-10"
            style={{ left: `${thresholdPct}%` }}
            title={`Compaction Threshold: ${data.compactionThreshold?.toLocaleString()} tokens (${thresholdPct}%)`}
          />
        )}
      </div>

      {/* Threshold indicator notice */}
      {thresholdPct !== null && (
        <div className="flex items-center justify-between text-[10px] text-gray-500">
          <span>0 tokens</span>
          <span className="text-rose-400 font-semibold">
            Compaction triggers at: {data.compactionThreshold?.toLocaleString()} tok ({thresholdPct}
            %)
          </span>
          <span>{contextWindow.toLocaleString()} tok</span>
        </div>
      )}

      {/* Legend & Token Count Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 pt-1">
        {parts.map((p, idx) => {
          const sharePct = totalTokens > 0 ? ((p.tokens / totalTokens) * 100).toFixed(1) : "0.0";
          return (
            <div
              key={idx}
              className="p-2 rounded-lg bg-gray-900/60 border border-gray-800/80 flex flex-col gap-0.5"
            >
              <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                <span className={`w-2 h-2 rounded-full ${p.color}`} />
                <span className="truncate">{p.label}</span>
              </div>
              <div className="text-xs font-bold text-gray-200 tabular-nums">
                {p.tokens.toLocaleString()}
              </div>
              <div className={`text-[10px] font-semibold ${p.text}`}>{sharePct}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
