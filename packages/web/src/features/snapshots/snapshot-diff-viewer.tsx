import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type { RollbackMode, SnapshotVersionInfo, StateDiffSummary } from "./snapshot-types";

export interface SnapshotDiffViewerProps {
  currentSnapshot: SnapshotVersionInfo;
  targetSnapshot: SnapshotVersionInfo;
  diffSummary: StateDiffSummary;
  onConfirmRollback: (mode: RollbackMode) => void;
}

export function SnapshotDiffViewer({
  currentSnapshot,
  targetSnapshot,
  diffSummary,
  onConfirmRollback,
}: SnapshotDiffViewerProps) {
  const isIdentical =
    !diffSummary.promptDiff.changed &&
    diffSummary.memoryChanges.length === 0 &&
    diffSummary.skillChanges.length === 0;

  return (
    <div className="flex flex-col gap-4 border-b border-gray-200 dark:border-gray-800 py-4">
      {/* Header */}
      <div className="flex flex-col gap-2 border-b border-gray-200 dark:border-gray-800 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Compare: v{targetSnapshot.version} ➔ v{currentSnapshot.version} (Active)
            </h3>
            <Badge tone={isIdentical ? "green" : "brand"}>
              {isIdentical ? "Identical State" : "Changes"}
            </Badge>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Comparing checkpoint {targetSnapshot.label} against current active agent state
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => onConfirmRollback("fork-branch")}>
            Preview fork
          </Button>
          <Button variant="danger" size="sm" onClick={() => onConfirmRollback("in-place")}>
            Preview restore
          </Button>
        </div>
      </div>

      {/* System Prompt Comparison */}
      <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-800 py-3">
        <div className="flex flex-wrap items-center justify-between">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            System prompt
          </span>
          <Badge tone={diffSummary.promptDiff.changed ? "amber" : "gray"}>
            {diffSummary.promptDiff.changed ? "Modified" : "Unchanged"}
          </Badge>
        </div>

        {diffSummary.promptDiff.changed ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                Target Version (v{targetSnapshot.version}):
              </span>
              <pre className="font-mono break-words whitespace-pre-wrap  break-words whitespace-pre-wrap max-h-36 overflow-auto rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-2 text-sm text-gray-900 dark:text-gray-100">
                {diffSummary.promptDiff.after}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                Current Active (v{currentSnapshot.version}):
              </span>
              <pre className="font-mono break-words whitespace-pre-wrap  break-words whitespace-pre-wrap max-h-36 overflow-auto rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-2 text-sm text-gray-900 dark:text-gray-100">
                {diffSummary.promptDiff.before}
              </pre>
            </div>
          </div>
        ) : (
          <span className="text-sm text-gray-600 dark:text-gray-400">
            Agent system instruction prompt is identical across these two checkpoints.
          </span>
        )}
      </div>

      {/* Memory Topics Delta */}
      <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-800 py-3">
        <div className="flex flex-wrap items-center justify-between">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Semantic Memory Topics ({diffSummary.memoryChanges.length} Changes)
          </span>
          <Badge tone={diffSummary.memoryChanges.length > 0 ? "amber" : "gray"}>
            {diffSummary.memoryChanges.length} Topics
          </Badge>
        </div>

        {diffSummary.memoryChanges.length === 0 ? (
          <span className="text-sm text-gray-600 dark:text-gray-400">
            No memory file additions, deletions, or modifications between versions.
          </span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {diffSummary.memoryChanges.map((change) => {
              let tone: "green" | "amber" | "red" = "amber";
              if (change.changeType === "added") tone = "green";
              if (change.changeType === "deleted") tone = "red";

              return (
                <div
                  key={change.topic}
                  className="flex flex-wrap items-center justify-between rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-1.5 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={tone}>{change.changeType}</Badge>
                    <span className=" font-medium text-gray-900 dark:text-gray-100">
                      {change.topic}
                    </span>
                  </div>
                  {change.diffSnippet && (
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {change.diffSnippet}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Skills Delta */}
      <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-800 py-3">
        <div className="flex flex-wrap items-center justify-between">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Installed Skills ({diffSummary.skillChanges.length} Changes)
          </span>
          <Badge tone={diffSummary.skillChanges.length > 0 ? "amber" : "gray"}>
            {diffSummary.skillChanges.length} Skills
          </Badge>
        </div>

        {diffSummary.skillChanges.length === 0 ? (
          <span className="text-sm text-gray-600 dark:text-gray-400">
            Agent capabilities and skill configurations match exactly.
          </span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {diffSummary.skillChanges.map((skill) => (
              <div
                key={skill.skillName}
                className="flex flex-wrap items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-2 py-1 text-sm"
              >
                <Badge tone={skill.changeType === "added" ? "green" : "red"}>
                  {skill.changeType}
                </Badge>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {skill.skillName}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
