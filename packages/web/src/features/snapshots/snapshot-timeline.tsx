import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  formatSnapshotTimestamp,
  type SnapshotTrigger,
  type SnapshotVersionInfo,
} from "./snapshot-types";

export interface SnapshotTimelineProps {
  snapshots: SnapshotVersionInfo[];
  selectedVersion: number;
  onSelectVersion: (version: number) => void;
  onInitiateRollback: (version: number) => void;
}

function triggerTone(trigger: SnapshotTrigger) {
  switch (trigger) {
    case "user-checkpoint":
      return "brand";
    case "pre-tool":
      return "amber";
    case "auto-save":
      return "gray";
    case "branch-fork":
      return "green";
    default:
      return "gray";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function SnapshotTimeline({
  snapshots,
  selectedVersion,
  onSelectVersion,
  onInitiateRollback,
}: SnapshotTimelineProps) {
  // Sort descending by version number
  const sorted = [...snapshots].sort((a, b) => b.version - a.version);

  return (
    <div className="flex flex-col gap-3 border-b border-gray-200 dark:border-gray-800 py-4">
      <div className="flex flex-wrap items-center justify-between border-b border-gray-200 dark:border-gray-800 pb-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Checkpoints</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Select a checkpoint to compare its prompt, memory and skills.
          </p>
        </div>
        <Badge tone="gray">{snapshots.length} Versions</Badge>
      </div>

      {/* Chronological List of Checkpoint Nodes */}
      <div className="flex flex-col gap-2.5">
        {sorted.map((item) => {
          const isSelected = selectedVersion === item.version;

          return (
            <div
              key={item.version}
              className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors ${
                isSelected
                  ? "border-blue-600 bg-blue-700 ring-1 ring-blue-600"
                  : "border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 hover:border-gray-400 hover:bg-muted/30"
              }`}
            >
              {/* Header: Version Tag, Badges, Timestamp */}
              <div className="flex flex-wrap items-center justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span className=" text-sm font-semibold text-gray-900 dark:text-gray-100">
                    v{item.version}
                  </span>
                  <Badge tone={triggerTone(item.trigger)}>{item.trigger}</Badge>
                  {item.isCurrent && <Badge tone="green">Current</Badge>}
                </div>
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  {formatSnapshotTimestamp(item.timestamp)}
                </span>
              </div>

              {/* Label & Description */}
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectVersion(item.version)}
                className="min-h-10 text-left text-sm font-medium underline underline-offset-4"
              >
                {item.label}
              </button>

              {/* Metadata Row: Files, Memory, Archive Size */}
              <div className="flex flex-wrap items-center justify-between border-t border-gray-200 dark:border-gray-800 pt-2 text-sm text-gray-600 dark:text-gray-400">
                <div className="flex flex-wrap items-center gap-3">
                  <span>{item.fileCount} state files</span>
                  <span>•</span>
                  <span>{item.memoryTopicsCount} memory topics</span>
                  <span>•</span>
                  <span>{formatBytes(item.uncompressedSizeBytes)}</span>
                </div>

                {!item.isCurrent && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onInitiateRollback(item.version);
                    }}
                  >
                    Preview restore
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
