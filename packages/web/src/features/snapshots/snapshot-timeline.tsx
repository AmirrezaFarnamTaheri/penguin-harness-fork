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
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div>
          <h2 className="text-xs font-semibold text-foreground">
            Session Checkpoint History
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Select any checkpoint node to inspect state diff or time-travel
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
              onClick={() => onSelectVersion(item.version)}
              className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors ${
                isSelected
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border bg-card hover:border-primary/40 hover:bg-muted/30"
              }`}
            >
              {/* Header: Version Tag, Badges, Timestamp */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-foreground">
                    v{item.version}
                  </span>
                  <Badge tone={triggerTone(item.trigger)}>
                    {item.trigger}
                  </Badge>
                  {item.isCurrent && (
                    <Badge tone="green">Current Active State</Badge>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {formatSnapshotTimestamp(item.timestamp)}
                </span>
              </div>

              {/* Label & Description */}
              <span className="text-xs font-medium text-foreground">
                {item.label}
              </span>

              {/* Metadata Row: Files, Memory, Archive Size */}
              <div className="flex items-center justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-3">
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
                    Time-Travel →
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
