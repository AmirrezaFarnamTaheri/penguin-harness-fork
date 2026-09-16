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
  const windowSize = contextWindow && contextWindow > 0 ? contextWindow : null;
  return (
    <section className={sectionClass}>
      <h2 className="text-base font-semibold">{copy("Token allocation", "Token 分配")}</h2>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <dt className={mutedClass}>{copy("Used", "已使用")}</dt>
          <dd className="text-lg font-semibold tabular-nums">{total.toLocaleString()}</dd>
        </div>
        <div>
          <dt className={mutedClass}>{copy("Model capacity", "模型容量")}</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {windowSize?.toLocaleString() ?? copy("Unknown", "未知")}
          </dd>
        </div>
        <div>
          <dt className={mutedClass}>{copy("Compaction threshold", "压缩阈值")}</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {data.compactionThreshold?.toLocaleString() ?? "—"}
          </dd>
        </div>
      </dl>
      {windowSize && (
        <div className="space-y-1">
          <progress
            aria-label={copy("Context capacity used", "上下文容量使用情况")}
            className="w-full h-3 accent-brand-600"
            max={windowSize}
            value={Math.min(total, windowSize)}
          />
          <p className={mutedClass}>
            {Math.round((total / windowSize) * 100)}% {copy("of model capacity", "的模型容量")}
          </p>
        </div>
      )}
      <dl className="divide-y divide-gray-200 dark:divide-gray-800">
        {parts.map((part) => (
          <div key={part.label} className="flex items-center justify-between gap-4 py-2">
            <dt>{part.label}</dt>
            <dd className="tabular-nums text-right">
              {part.tokens.toLocaleString()}{" "}
              <span className={mutedClass}>
                ({total ? ((part.tokens / total) * 100).toFixed(1) : "0"}%)
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
