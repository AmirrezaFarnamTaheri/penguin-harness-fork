import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import type {
  RollbackMode,
  SnapshotVersionInfo,
  StateDiffSummary,
} from "./snapshot-types";

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
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      {/* Header */}
      <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-foreground">
              State Diff: v{targetSnapshot.version} ➔ v{currentSnapshot.version} (Active)
            </h3>
            <Badge tone={isIdentical ? "green" : "brand"}>
              {isIdentical ? "Identical State" : "State Delta"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Comparing checkpoint {targetSnapshot.label} against current active agent state
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onConfirmRollback("fork-branch")}
          >
            Fork New Session
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onConfirmRollback("in-place")}
          >
            Revert In-Place
          </Button>
        </div>
      </div>

      {/* System Prompt Comparison */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            System Prompt Specification
          </span>
          <Badge tone={diffSummary.promptDiff.changed ? "amber" : "gray"}>
            {diffSummary.promptDiff.changed ? "Modified" : "Unchanged"}
          </Badge>
        </div>

        {diffSummary.promptDiff.changed ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Target Version (v{targetSnapshot.version}):
              </span>
              <pre className="max-h-36 overflow-auto rounded border border-border bg-card p-2 font-mono text-[11px] text-foreground">
                {diffSummary.promptDiff.after}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                Current Active (v{currentSnapshot.version}):
              </span>
              <pre className="max-h-36 overflow-auto rounded border border-border bg-card p-2 font-mono text-[11px] text-foreground">
                {diffSummary.promptDiff.before}
              </pre>
            </div>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            Agent system instruction prompt is identical across these two checkpoints.
          </span>
        )}
      </div>

      {/* Memory Topics Delta */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            Semantic Memory Topics ({diffSummary.memoryChanges.length} Changes)
          </span>
          <Badge tone={diffSummary.memoryChanges.length > 0 ? "amber" : "gray"}>
            {diffSummary.memoryChanges.length} Topics
          </Badge>
        </div>

        {diffSummary.memoryChanges.length === 0 ? (
          <span className="text-xs text-muted-foreground">
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
                  className="flex items-center justify-between rounded border border-border bg-card px-3 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={tone}>{change.changeType}</Badge>
                    <span className="font-mono font-medium text-foreground">
                      {change.topic}
                    </span>
                  </div>
                  {change.diffSnippet && (
                    <span className="text-[11px] text-muted-foreground">
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
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            Installed Skills ({diffSummary.skillChanges.length} Changes)
          </span>
          <Badge tone={diffSummary.skillChanges.length > 0 ? "amber" : "gray"}>
            {diffSummary.skillChanges.length} Skills
          </Badge>
        </div>

        {diffSummary.skillChanges.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            Agent capabilities and skill configurations match exactly.
          </span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {diffSummary.skillChanges.map((skill) => (
              <div
                key={skill.skillName}
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs"
              >
                <Badge tone={skill.changeType === "added" ? "green" : "red"}>
                  {skill.changeType}
                </Badge>
                <span className="font-medium text-foreground">
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
