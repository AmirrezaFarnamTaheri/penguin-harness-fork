import type { WorktreesResponse } from "@prismshadow/penguin-server/api";
import { apiFetchJson } from "../../api/client";

export function listWorktrees(projectId: string, workspace: string): Promise<WorktreesResponse> {
  return apiFetchJson<WorktreesResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
    {
      query: { workspace },
    },
  );
}
