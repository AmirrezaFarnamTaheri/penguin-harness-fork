import { Button } from "../../components/ui/button";
import { mutedClass, sectionClass, useInspectionCopy } from "./inspection-ui";

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
  anchors?: CompactionAnchorItem[];
}

export function CompactionAnchorsCard({
  onManualCompact,
  compacting = false,
  anchors,
}: CompactionAnchorsCardProps) {
  const copy = useInspectionCopy();
  return (
    <section className={sectionClass}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{copy("Compaction", "上下文压缩")}</h2>
          <p className={`mt-1 ${mutedClass}`}>
            {copy(
              "Fold older conversation content to reduce the next request's context.",
              "折叠较早的对话内容，减少下次请求的上下文。",
            )}
          </p>
        </div>
        {onManualCompact && (
          <Button disabled={compacting} onClick={onManualCompact}>
            {compacting ? copy("Requesting…", "请求中…") : copy("Request compaction", "请求压缩")}
          </Button>
        )}
      </div>
      {!anchors ? (
        <p className={mutedClass}>
          {copy(
            "Compaction history is not supplied by this context endpoint. No history is inferred from the current snapshot.",
            "此上下文接口未提供压缩历史，当前快照不能用于推断历史记录。",
          )}
        </p>
      ) : !anchors.length ? (
        <p className={mutedClass}>{copy("No compaction events recorded.", "暂无压缩记录。")}</p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800">
          {anchors.map((anchor) => (
            <li key={anchor.id} className="flex flex-wrap justify-between gap-3 py-3">
              <span>
                {anchor.timestamp} · {anchor.trigger} · {anchor.phase}
              </span>
              <span>
                {anchor.preTokens.toLocaleString()} → {anchor.postTokens.toLocaleString()} tokens ·{" "}
                {anchor.foldedTurns} turns · {anchor.durationMs} ms
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
