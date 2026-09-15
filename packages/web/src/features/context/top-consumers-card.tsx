import type { ContextToolShare, ContextFileShare } from "@prismshadow/penguin-server/api";

export interface TopConsumersCardProps {
  tools: ContextToolShare[];
  files: ContextFileShare[];
}

export function TopConsumersCard({ tools, files }: TopConsumersCardProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs select-none">
      {/* Top 5 Tools */}
      <div className="flex flex-col gap-2.5 p-4 rounded-xl border border-gray-800 bg-gray-950">
        <div className="flex items-center justify-between pb-2 border-b border-gray-800">
          <h4 className="font-bold text-sm text-gray-200">Top Tools by Context Footprint</h4>
          <span className="text-[10px] text-gray-500 uppercase">Top 5</span>
        </div>

        {tools.length === 0 ? (
          <div className="py-6 text-center text-gray-600">No tool executions recorded.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {tools.map((t, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2 rounded-lg bg-gray-900/50 border border-gray-800/80"
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-500 text-[10px] tabular-nums font-bold">
                    #{idx + 1}
                  </span>
                  <span className="font-semibold text-cyan-400">{t.name}</span>
                </div>
                <div className="text-right">
                  <span className="text-gray-200 font-bold tabular-nums">
                    {t.tokens.toLocaleString()}
                  </span>{" "}
                  <span className="text-gray-500 text-[10px]">tokens</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top 5 Files */}
      <div className="flex flex-col gap-2.5 p-4 rounded-xl border border-gray-800 bg-gray-950">
        <div className="flex items-center justify-between pb-2 border-b border-gray-800">
          <h4 className="font-bold text-sm text-gray-200">Top Files by Tool Traffic</h4>
          <span className="text-[10px] text-gray-500 uppercase">Top 5</span>
        </div>

        {files.length === 0 ? (
          <div className="py-6 text-center text-gray-600">No file operations recorded.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {files.map((f, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2 rounded-lg bg-gray-900/50 border border-gray-800/80"
              >
                <div className="flex flex-col gap-0.5 min-w-0 flex-1 pr-2">
                  <span className="font-semibold text-gray-200 truncate" title={f.path}>
                    {f.path.split("/").pop() || f.path}
                  </span>
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                    {f.ops.read > 0 && <span className="text-blue-400">R:{f.ops.read}</span>}
                    {f.ops.edit > 0 && <span className="text-amber-400">E:{f.ops.edit}</span>}
                    {f.ops.write > 0 && <span className="text-emerald-400">W:{f.ops.write}</span>}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <span className="text-gray-200 font-bold tabular-nums">
                    {f.tokens.toLocaleString()}
                  </span>{" "}
                  <span className="text-gray-500 text-[10px]">tokens</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
