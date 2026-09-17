import { useEffect, useState } from "react";
import type { WorktreesResponse } from "@prismshadow/penguin-server/api";
import { Button } from "../../components/ui/button";
import { WorkspaceSelect } from "../chat/workspace-select";
import { listWorktrees } from "./worktree-lanes-api";

export interface WorktreeLanesCardProps {
  projectId: string;
}

export function WorktreeLanesCard({ projectId }: WorktreeLanesCardProps) {
  // Reset selection as well as pending requests when the project changes.
  return <ProjectWorktrees key={projectId} projectId={projectId} />;
}

function ProjectWorktrees({ projectId }: WorktreeLanesCardProps) {
  const [workspace, setWorkspace] = useState("");
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<WorktreesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    setLoading(Boolean(projectId && workspace));
    if (projectId && workspace) {
      void listWorktrees(projectId, workspace).then(
        (response) => {
          if (!cancelled) {
            setResult(response);
            setLoading(false);
          }
        },
        (reason: unknown) => {
          if (!cancelled) {
            setError(reason instanceof Error ? reason.message : "Could not load worktrees.");
            setLoading(false);
          }
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, workspace, revision]);

  return (
    <section aria-label="Repository worktrees" className="min-w-0 space-y-4 py-4 text-sm">
      <p className="text-gray-600 dark:text-gray-400">
        Select a server workspace to inspect its Git worktrees. This view does not create, remove,
        or modify lanes.
      </p>
      {!projectId ? (
        <p role="status">Select a project to inspect worktrees.</p>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <WorkspaceSelect
              projectId={projectId}
              workspace={workspace}
              onChange={setWorkspace}
              fieldLabel="Repository workspace"
              emptyLabel="Choose a repository"
              clearLabel="Clear repository"
              menuHint="Choose an existing Git repository on the server."
            />
            <Button
              disabled={!workspace || loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh worktrees
            </Button>
          </div>
          {!workspace && <p role="status">Choose a repository to load its worktrees.</p>}
          {loading && <p role="status">Loading worktrees…</p>}
          {error && (
            <div role="alert" className="space-y-2 break-words">
              <p>{error}</p>
              <Button onClick={() => setRevision((value) => value + 1)}>
                Retry loading worktrees
              </Button>
            </div>
          )}
          {result && (
            <>
              <p className="break-all font-mono text-gray-600 dark:text-gray-400">
                {result.workspace}
              </p>
              {result.worktrees.length === 0 ? (
                <p role="status">No worktrees returned.</p>
              ) : (
                <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                  {result.worktrees.map((lane) => (
                    <li key={lane.path} className="min-w-0 space-y-1 py-3">
                      <p className="break-all font-medium">
                        {lane.branch.replace(/^refs\/heads\//, "") ||
                          (lane.head ? "Detached HEAD" : "Bare repository")}
                      </p>
                      <p className="break-all font-mono">{lane.path}</p>
                      {lane.head && (
                        <p className="break-all font-mono text-gray-600 dark:text-gray-400">
                          {lane.head}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
