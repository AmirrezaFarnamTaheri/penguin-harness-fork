/**
 * Git Worktrees and Isolated Coding Lane Manager.
 * Absorbed and unified from CodeKanban and worktrees.md.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface AgentWorktree {
  worktreePath: string;
  branch: string;
  headSha: string;
  agentId: string;
  createdAt: number;
}

export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  /**
   * Creates an isolated worktree for an autonomous subagent lane.
   */
  async createWorktree(agentId: string, branchName?: string): Promise<AgentWorktree> {
    const cleanAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const branch = branchName ?? `lane/${cleanAgentId}-${Date.now()}`;
    const worktreesDir = path.join(this.repoRoot, ".lanes");
    await fs.mkdir(worktreesDir, { recursive: true });

    const worktreePath = path.join(worktreesDir, cleanAgentId);

    // Remove existing if any
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: this.repoRoot });
    } catch {
      // ignore if didn't exist
    }

    // Add worktree
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath], { cwd: this.repoRoot });

    // Get HEAD sha
    const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });

    return {
      worktreePath,
      branch,
      headSha: headSha.trim(),
      agentId,
      createdAt: Date.now(),
    };
  }

  /**
   * Removes an isolated worktree and prunes git tracking.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: this.repoRoot });
    } catch {
      // Fallback manual cleanup if git remove failed
      await fs.rm(worktreePath, { recursive: true, force: true });
      await execFileAsync("git", ["worktree", "prune"], { cwd: this.repoRoot });
    }
  }

  /**
   * Lists all active git worktrees for the repository.
   */
  async listWorktrees(): Promise<Array<{ path: string; head: string; branch: string }>> {
    try {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: this.repoRoot });
      const entries: Array<{ path: string; head: string; branch: string }> = [];
      let currentPath = "";
      let currentHead = "";
      let currentBranch = "";

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("worktree ")) {
          currentPath = trimmed.slice("worktree ".length);
        } else if (trimmed.startsWith("HEAD ")) {
          currentHead = trimmed.slice("HEAD ".length);
        } else if (trimmed.startsWith("branch ")) {
          currentBranch = trimmed.slice("branch ".length);
        } else if (trimmed === "" && currentPath) {
          entries.push({ path: currentPath, head: currentHead, branch: currentBranch });
          currentPath = "";
          currentHead = "";
          currentBranch = "";
        }
      }
      if (currentPath) {
        entries.push({ path: currentPath, head: currentHead, branch: currentBranch });
      }
      return entries;
    } catch {
      return [];
    }
  }
}
