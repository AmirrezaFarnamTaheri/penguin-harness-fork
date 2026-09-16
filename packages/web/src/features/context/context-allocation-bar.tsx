import type { SessionContextResponse } from "@prismshadow/penguin-server/api";
import { mutedClass, sectionClass, useInspectionCopy } from "./inspection-ui";

export interface ContextAllocationBarProps {
  data: SessionContextResponse;
  contextWindow?: number | null;
}

export function ContextAllocationBar({ data, contextWindow }: ContextAllocationBarProps) {
  const copy = useInspectionCopy();
  const parts = [
    { label: copy("System prompt", "系统提示词"), tokens: data.systemPrompt },
    { label: copy("Tool definitions", "工具定义"), tokens: data.toolDefs },
    { label: copy("User messages", "用户消息"), tokens: data.userMessages },
    { label: copy("Assistant messages", "助手消息"), tokens: data.assistantMessages },
    { label: copy("Tool requests", "工具请求"), tokens: data.toolRequests },
    { label: copy("Tool results", "工具结果"), tokens: data.toolResults },
  ];
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  const windowSize =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : null;
  const stale = data.contextClosed || data.occupancyStale === true;
  const measured =
    !stale && typeof data.occupancyTokens === "number" &&
    Number.isFinite(data.occupancyTokens) && data.occupancyTokens >= 0
      ? data.occupancyTokens
      : null;
  return (
    <>
      <section className={sectionClass}>
        <h2 className="text-base font-semibold">{copy("Measured context usage", "实测上下文用量")}</h2>
        <p className={mutedClass}>
          {stale
            ? copy("Compacted. Waiting for the next normal request to measure context usage.", "已压缩，等待下一次常规请求测量上下文用量。")
            : measured === null
              ? copy("No context usage measurement is available. Estimates below are not model occupancy.", "暂无上下文用量测量值。下方估算不代表模型上下文占用。")
              : copy("Latest normal request, not cumulative session usage. New messages are not measured until the next usage report.", "最近一次常规请求的用量，并非会话累计用量。新消息需等待下一份用量报告才会计入。")}
        </p>
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <dt className={mutedClass}>{copy("Used", "已使用")}</dt>
            <dd className="text-lg font-semibold tabular-nums">{measured?.toLocaleString() ?? copy("Unknown", "未知")}</dd>
          </div>
          <div>
            <dt className={mutedClass}>{copy("Model capacity", "模型容量")}</dt>
            <dd className="text-lg font-semibold tabular-nums">{windowSize?.toLocaleString() ?? copy("Unknown", "未知")}</dd>
          </div>
          <div>
            <dt className={mutedClass}>{copy("Compaction threshold", "压缩阈值")}</dt>
            <dd className="text-lg font-semibold tabular-nums">{data.compactionThreshold?.toLocaleString() ?? copy("Disabled or unavailable", "已禁用或不可用")}</dd>
          </div>
        </dl>
        {windowSize !== null && measured !== null && (
          <div className="space-y-1">
            <progress
              aria-label={copy("Context capacity used", "上下文容量使用情况")}
              className="w-full h-3 accent-brand-600"
              max={windowSize}
              value={Math.min(measured, windowSize)}
            />
            <p className={mutedClass}>
              {Math.round((measured / windowSize) * 100)}% {copy("of model capacity", "的模型容量")}
              {measured > windowSize && copy(" — exceeds configured capacity", " — 超出配置容量")}
            </p>
          </div>
        )}
        {measured !== null && data.occupancyRecordedAt && (
          <p className={`break-all ${mutedClass}`}>
            {copy("Usage recorded: ", "用量记录时间：")}
            <time dateTime={data.occupancyRecordedAt}>{data.occupancyRecordedAt}</time>
          </p>
        )}
      </section>
      <section className={sectionClass}>
        <h2 className="text-base font-semibold">{copy("Estimated composition", "估算构成")}</h2>
        <p className={mutedClass}>
          {copy("Character-based estimates across the latest trace shard, not the last request. Shares use the estimated total and may differ from measured usage.", "基于最新追踪分片全文字符的估算，而非最近一次请求。占比以估算总量为基准，可能与实测用量不同。")}
        </p>
        <dl className="divide-y divide-gray-200 dark:divide-gray-800">
          <div className="flex items-center justify-between gap-4 py-2 font-semibold">
            <dt>{copy("Estimated total", "估算总量")}</dt>
            <dd className="tabular-nums">{total.toLocaleString()}</dd>
          </div>
          {parts.map((part) => (
            <div key={part.label} className="flex items-center justify-between gap-4 py-2">
              <dt>{part.label}</dt>
              <dd className="tabular-nums text-right">
                {part.tokens.toLocaleString()} {" "}
                <span className={mutedClass}>({total ? ((part.tokens / total) * 100).toFixed(1) : "0"}%)</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
