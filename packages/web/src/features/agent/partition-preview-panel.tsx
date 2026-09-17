import type { PartitionResult } from "@prismshadow/penguin-core";

export interface PartitionPreviewPanelProps {
  result: PartitionResult;
}

/** Read-only preview of the partitioner's output; source order is not a scheduling policy. */
export function PartitionPreviewPanel({ result }: PartitionPreviewPanelProps) {
  return (
    <section aria-label="Decomposition preview" className="min-w-0 space-y-3">
      <h3 className="text-base font-semibold">Decomposition preview</h3>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Preview only. Calculated locally; no agents are started. Suggested roles are not
        assignments.
      </p>
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-600 dark:text-gray-400">
        {result.originalQuery}
      </p>
      {result.subQueries.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">No sub-queries to preview.</p>
      ) : (
        <ol className="divide-y divide-gray-200 dark:divide-gray-800">
          {result.subQueries.map((part) => (
            <li key={part.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                <span className="break-all font-mono">{part.id}</span>
                <span className="break-all font-medium">{part.targetRole}</span>
                <span className="text-gray-600 dark:text-gray-400">{`Priority: ${part.priority}`}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{part.query}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
