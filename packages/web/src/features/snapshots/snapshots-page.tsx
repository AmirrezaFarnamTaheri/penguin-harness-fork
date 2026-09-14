import { useState, useMemo } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SnapshotTimeline } from "./snapshot-timeline";
import { SnapshotDiffViewer } from "./snapshot-diff-viewer";
import {
  computeStateDiff,
  executeTimeTravel,
  type AgentSnapshotState,
  type RollbackMode,
  type SnapshotVersionInfo,
  type TimeTravelResult,
} from "./snapshot-types";

function HistoryIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function UploadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

const INITIAL_SNAPSHOTS: SnapshotVersionInfo[] = [
  {
    version: 1,
    label: "Initial Agent Workspace Setup",
    timestamp: Date.now() - 3600_000 * 3,
    trigger: "user-checkpoint",
    uncompressedSizeBytes: 142000,
    fileCount: 12,
    memoryTopicsCount: 2,
    activePromptHash: "a1b2c3d4",
    isCurrent: false,
  },
  {
    version: 2,
    label: "Pre-Tool Checkpoint: Database Migration",
    timestamp: Date.now() - 3600_000,
    trigger: "pre-tool",
    uncompressedSizeBytes: 158000,
    fileCount: 15,
    memoryTopicsCount: 4,
    activePromptHash: "e5f6g7h8",
    isCurrent: false,
  },
  {
    version: 3,
    label: "Automated Periodic State Checkpoint",
    timestamp: Date.now() - 600_000,
    trigger: "auto-save",
    uncompressedSizeBytes: 174000,
    fileCount: 18,
    memoryTopicsCount: 6,
    activePromptHash: "i9j0k1l2",
    isCurrent: true,
  },
];

const INITIAL_STATE_DETAILS: Record<number, AgentSnapshotState> = {
  1: {
    systemPrompt: "You are an AI coding assistant specialized in agentic workflows.",
    memoryFiles: {
      "MEMORY.md": "# Index\n- [[database-rules]]",
      "database-rules.md": "# Database Rules\nUse PostgreSQL.",
    },
    skills: ["git-master"],
  },
  2: {
    systemPrompt: "You are a senior full-stack engineer and database architect.",
    memoryFiles: {
      "MEMORY.md": "# Index\n- [[database-rules]]\n- [[api-design]]",
      "database-rules.md": "# Database Rules\nUse PostgreSQL with Prisma.",
      "api-design.md": "# API Design\nREST endpoints.",
    },
    skills: ["git-master", "sql-pro"],
  },
  3: {
    systemPrompt: "You are an autonomous engineering leader in Penguin Harness.",
    memoryFiles: {
      "MEMORY.md": "# Index\n- [[database-rules]]\n- [[api-design]]\n- [[testing-patterns]]",
      "database-rules.md": "# Database Rules\nUse PostgreSQL with Drizzle ORM.",
      "api-design.md": "# API Design\nREST & WebSocket endpoints.",
      "testing-patterns.md": "# Testing\nVitest with 100% coverage.",
    },
    skills: ["git-master", "sql-pro", "test-engineer"],
  },
};

export function SnapshotsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [snapshots, setSnapshots] = useState<SnapshotVersionInfo[]>(INITIAL_SNAPSHOTS);
  const [stateDetails, setStateDetails] = useState(INITIAL_STATE_DETAILS);
  const [selectedVersion, setSelectedVersion] = useState<number>(1);
  const [isCreatingModal, setIsCreatingModal] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [rollbackConfirmation, setRollbackConfirmation] = useState<{
    targetVersion: number;
    mode: RollbackMode;
  } | null>(null);

  const currentSnapshot = useMemo(() => {
    return snapshots.find((s) => s.isCurrent) ?? snapshots[snapshots.length - 1]!;
  }, [snapshots]);

  const targetSnapshot = useMemo(() => {
    return snapshots.find((s) => s.version === selectedVersion) ?? currentSnapshot;
  }, [snapshots, selectedVersion, currentSnapshot]);

  const diffSummary = useMemo(() => {
    return computeStateDiff(currentSnapshot, targetSnapshot, stateDetails);
  }, [currentSnapshot, targetSnapshot, stateDetails]);

  const handleCreateCheckpoint = () => {
    const nextVersion = Math.max(...snapshots.map((s) => s.version)) + 1;
    const newSnapshot: SnapshotVersionInfo = {
      version: nextVersion,
      label: newLabel.trim() || `User Checkpoint v${nextVersion}`,
      timestamp: Date.now(),
      trigger: "user-checkpoint",
      uncompressedSizeBytes: currentSnapshot.uncompressedSizeBytes + 1200,
      fileCount: currentSnapshot.fileCount,
      memoryTopicsCount: currentSnapshot.memoryTopicsCount,
      activePromptHash: Math.random().toString(36).substring(2, 10),
      isCurrent: true,
    };

    setSnapshots((prev) => [
      ...prev.map((s) => ({ ...s, isCurrent: false })),
      newSnapshot,
    ]);

    setStateDetails((prev) => ({
      ...prev,
      [nextVersion]: {
        ...prev[currentSnapshot.version]!,
      },
    }));

    setSelectedVersion(currentSnapshot.version);
    setNewLabel("");
    setIsCreatingModal(false);
    setStatusMessage(`Created new checkpoint v${nextVersion}`);
  };

  const handleExecuteRollback = () => {
    if (!rollbackConfirmation) return;

    const res: TimeTravelResult = executeTimeTravel(
      currentSnapshot.version,
      rollbackConfirmation.targetVersion,
      rollbackConfirmation.mode,
    );

    if (rollbackConfirmation.mode === "in-place") {
      setSnapshots((prev) =>
        prev.map((s) => ({
          ...s,
          isCurrent: s.version === rollbackConfirmation.targetVersion,
        })),
      );
      setSelectedVersion(rollbackConfirmation.targetVersion);
    }

    setStatusMessage(res.message);
    setRollbackConfirmation(null);
  };

  return (
    <div className={`flex flex-col gap-6 ${embedded ? "p-3" : "p-6"}`}>
      {/* Top Header & Banner */}
      {!embedded && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <HistoryIcon size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">
                Session Time-Travel & Snapshot Rewind Studio
              </h1>
              <p className="text-xs text-muted-foreground">
                Deterministic agent state checkpoints, cross-version diff inspection, and dual-mode rollback recovery
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const dummyBlob = new Blob(["agent_state_archive"], { type: "application/gzip" });
                const url = URL.createObjectURL(dummyBlob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `agent-v${currentSnapshot.version}.tar.gz`;
                a.click();
                setStatusMessage(`Exported snapshot v${currentSnapshot.version}.tar.gz`);
              }}
            >
              <DownloadIcon size={13} />
              Export Archive (.tar.gz)
            </Button>

            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsCreatingModal(true)}
            >
              <PlusIcon size={13} />
              Create Checkpoint
            </Button>
          </div>
        </div>
      )}

      {/* Status Alert Notification (if active) */}
      {statusMessage && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-600 dark:text-emerald-400">
          <span>{statusMessage}</span>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="text-xs font-semibold hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Metrics Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Active Version</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xl font-bold text-foreground">
              v{currentSnapshot.version}
            </span>
            <Badge tone="green">Current</Badge>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {currentSnapshot.label}
          </span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Total Checkpoints</span>
          <span className="font-mono text-2xl font-bold text-primary">
            {snapshots.length}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Preserved in archive tree
          </span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Archive Footprint</span>
          <span className="font-mono text-2xl font-bold text-foreground">
            {(currentSnapshot.uncompressedSizeBytes / 1024).toFixed(1)} KB
          </span>
          <span className="text-[11px] text-muted-foreground">
            {currentSnapshot.fileCount} state files packaged
          </span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <span className="text-xs text-muted-foreground">Memory Topics</span>
          <span className="font-mono text-2xl font-bold text-emerald-500">
            {currentSnapshot.memoryTopicsCount}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Indexed knowledge files
          </span>
        </div>
      </div>

      {/* Main Split Workbench: Timeline on Left, Diff & Time-Travel on Right */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Timeline (5 cols) */}
        <div className="lg:col-span-5">
          <SnapshotTimeline
            snapshots={snapshots}
            selectedVersion={selectedVersion}
            onSelectVersion={(v) => setSelectedVersion(v)}
            onInitiateRollback={(v) =>
              setRollbackConfirmation({ targetVersion: v, mode: "in-place" })
            }
          />
        </div>

        {/* Diff Viewer (7 cols) */}
        <div className="lg:col-span-7">
          <SnapshotDiffViewer
            currentSnapshot={currentSnapshot}
            targetSnapshot={targetSnapshot}
            diffSummary={diffSummary}
            onConfirmRollback={(mode) =>
              setRollbackConfirmation({
                targetVersion: targetSnapshot.version,
                mode,
              })
            }
          />
        </div>
      </div>

      {/* Create Checkpoint Modal */}
      {isCreatingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <h3 className="text-base font-bold text-foreground">
              Create Agent State Checkpoint
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Creates an immutable snapshot archive preserving prompt, memory topics, and skill configurations.
            </p>

            <div className="flex flex-col gap-2 my-4">
              <span className="text-xs font-medium text-foreground">
                Checkpoint Tag / Label
              </span>
              <Input
                size="sm"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Pre-refactor stable state"
              />
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsCreatingModal(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleCreateCheckpoint}
              >
                Save Checkpoint
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback Confirmation Modal */}
      {rollbackConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <h3 className="text-base font-bold text-foreground">
              Confirm Time-Travel Execution
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {rollbackConfirmation.mode === "in-place"
                ? `You are reverting the active workspace in-place to version v${rollbackConfirmation.targetVersion}. An automatic pre-rollback safety snapshot will be recorded before rewriting.`
                : `You are branching a new isolated session fork from checkpoint v${rollbackConfirmation.targetVersion}. Your current session will remain completely intact.`}
            </p>

            <div className="flex items-center justify-end gap-2 border-t border-border pt-4 mt-5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setRollbackConfirmation(null)}
              >
                Cancel
              </Button>
              <Button
                variant={rollbackConfirmation.mode === "in-place" ? "danger" : "primary"}
                size="sm"
                onClick={handleExecuteRollback}
              >
                {rollbackConfirmation.mode === "in-place"
                  ? "Confirm In-Place Revert"
                  : "Confirm Fork Session"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
