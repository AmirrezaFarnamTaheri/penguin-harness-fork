import type { WorktreesResponse } from "@prismshadow/penguin-server/api";
import { apiFetch } from "../../api/client";

export function listWorktrees(projectId: string, workspace: string): Promise<WorktreesResponse> {
  return apiFetch<WorktreesResponse>(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, {
    query: { workspace },
  });
}
