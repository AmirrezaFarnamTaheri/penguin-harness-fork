import type {
  ShellRiskLevel,
  ShellSafetyAssessment,
  ShellFinding,
} from "@prismshadow/penguin-core/browser";

export type { ShellRiskLevel, ShellSafetyAssessment, ShellFinding };

export interface WorktreeLaneInfo {
  id: string;
  branch: string;
  headSha: string;
  agentId: string;
  status: "isolated" | "merging" | "dirty" | "stale";
  createdAgo: string;
  dirtyFilesCount: number;
}
