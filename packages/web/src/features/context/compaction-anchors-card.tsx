import { useState } from "react";
import { Button } from "../../components/ui/button";

export interface CompactionAnchorItem {
  id: string;
  trigger: "auto" | "manual";
  phase: "turn-start" | "in-loop" | "agent-session";
  preTokens: number;
  postTokens: number;
  foldedTurns: number;
  durationMs: number;
  timestamp: string;
}

export interface CompactionAnchorsCardProps {
  onManualCompact?: () => void;
  compacting?: boolean;
}

export function CompactionAnchorsCard({
  onManualCompact,
  compacting = false,
}: CompactionAnchorsCardProps) {
  const [anchors] = useState<CompactionAnchorItem[]>([
    {
      id: "anc-8f4b21",
      trigger: "auto",
      phase: "in-loop",
      preTokens: 142000,
      postTokens: 38400,
      foldedTurns: 8,
      durationMs: 420,
      timestamp: "12m ago",
    },
    {
      id: "anc-3a19e4",
      trigger: "manual",
      phase: "agent-session",
      preTokens: 89000,
      postTokens: 26100,
      foldedTurns: 5,
      durationMs: 310,
      timestamp: "45m ago",
    },
    {
      id: "anc-1c77d0",
      trigger: "auto",
      phase: "turn-start",
      preTokens: 165000,
      postTokens: 41200,
      foldedTurns: 12,
      durationMs: 580,
      timestamp: "2h ago",
    },
  ]);

  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl border border-gray-800 bg-gray-950 font-mono text-xs select-none">
      <div className="flex items-center justify-between pb-2 border-b border-gray-800">
        <div>
          <h4 className="font-bold text-sm text-gray-200">Context Compaction History & Anchors</h4>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Historical context folding points preserving conversation state while purging transient tool outputs.
          </p>
        </div>

        {onManualCompact && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onManualCompact}
            disabled={compacting}
            className="text-[11px]"
          >
            {compacting ? "Compacting..." : "Compact Context Now"}
          </Button>
        )}
      </div>

      {/* Anchors Timeline Table */}
      <div className="flex flex-col gap-2">
        {anchors.map((a) => {
          const tokensSaved = a.preTokens - a.postTokens;
          const savedPct = Math.round((tokensSaved / a.preTokens) * 100);

          return (
            <div
              key={a.id}
              className="p-3 rounded-lg border border-gray-800 bg-gray-900/50 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-200">{a.id}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-gray-800 text-cyan-300 font-semibold uppercase">
                      {a.trigger}
                    </span>
                    <span className="text-[10px] text-gray-500">[{a.phase}]</span>
                  </div>
                  <span className="text-[10px] text-gray-500 mt-0.5">{a.timestamp}</span>
                </div>
              </div>

              <div className="flex items-center gap-4 text-right">
                <div className="flex flex-col">
                  <span className="text-gray-400 text-[10px]">Tokens Before → After</span>
                  <span className="text-gray-200 font-semibold tabular-nums">
                    {a.preTokens.toLocaleString()} → {a.postTokens.toLocaleString()}
                  </span>
                </div>

                <div className="flex flex-col">
                  <span className="text-gray-400 text-[10px]">Purged Volume</span>
                  <span className="text-emerald-400 font-bold tabular-nums">
                    -{tokensSaved.toLocaleString()} tok ({savedPct}%)
                  </span>
                </div>

                <div className="flex flex-col">
                  <span className="text-gray-400 text-[10px]">Folded Turns</span>
                  <span className="text-gray-300 font-semibold tabular-nums">
                    {a.foldedTurns} turns ({a.durationMs}ms)
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
