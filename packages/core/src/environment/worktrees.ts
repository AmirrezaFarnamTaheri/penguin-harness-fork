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

interface LaneRegistration {
  worktreePath: string;
  branch: string;
  agentId: string;
  createdAt: number;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  private lanesRoot(): string {
    return path.resolve(this.repoRoot, ".lanes");
  }

  private registryRoot(): string {
    return path.join(this.lanesRoot(), ".registry");
  }

  private assertManagedLanePath(candidate: string): string {
    const lanesRoot = this.lanesRoot();
    const resolved = path.resolve(candidate);
    const relative = path.relative(lanesRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing worktree operation outside managed lane directory '${lanesRoot}'`);
    }
    return resolved;
  }

  private registrationPath(cleanAgentId: string): string {
    return path.join(this.registryRoot(), `${cleanAgentId}.json`);
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await fs.lstat(candidate);
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async readRegistration(cleanAgentId: string): Promise<LaneRegistration | null> {
    try {
      const raw = await fs.readFile(this.registrationPath(cleanAgentId), "utf-8");
      const parsed = JSON.parse(raw) as Partial<LaneRegistration>;
      if (
        typeof parsed.worktreePath !== "string" ||
        typeof parsed.branch !== "string" ||
        typeof parsed.agentId !== "string" ||
        typeof parsed.createdAt !== "number"
      ) {
        throw new Error(`Invalid lane registration for '${cleanAgentId}'`);
      }
      return parsed as LaneRegistration;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async removeRegistrationIfOwned(cleanAgentId: string, expected: LaneRegistration): Promise<void> {
    const current = await this.readRegistration(cleanAgentId);
    if (
      !current ||
      current.worktreePath !== expected.worktreePath ||
      current.branch !== expected.branch ||
      current.agentId !== expected.agentId ||
      current.createdAt !== expected.createdAt
    ) {
      return;
    }
    await fs.unlink(this.registrationPath(cleanAgentId));
  }

  /**
   * Creates an isolated worktree for an autonomous subagent lane.
   * Existing lanes are never force-removed: callers must explicitly resolve a conflict first.
   * Ownership is reserved before invoking Git, so a bookkeeping failure cannot leave a real but
   * unmanageable worktree behind.
   */
  async createWorktree(agentId: string, branchName?: string): Promise<AgentWorktree> {
    const cleanAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!cleanAgentId) {
      throw new Error("Agent id does not contain any usable lane identifier characters");
    }

    const branch = branchName ?? `lane/${cleanAgentId}-${Date.now()}`;
    const worktreesDir = this.lanesRoot();
    const registryDir = this.registryRoot();
    await fs.mkdir(worktreesDir, { recursive: true });
    await fs.mkdir(registryDir, { recursive: true });

    const worktreePath = this.assertManagedLanePath(path.join(worktreesDir, cleanAgentId));
    const registration = await this.readRegistration(cleanAgentId);
    if (registration || (await this.pathExists(worktreePath))) {
      throw new Error(
        `Managed lane '${cleanAgentId}' already exists at '${worktreePath}'. Refusing to replace existing work.`,
      );
    }

    const registered = await this.listWorktrees();
    if (registered.some((entry) => path.resolve(entry.path) === worktreePath)) {
      throw new Error(`Git already has a worktree registered at '${worktreePath}'`);
    }

    const createdAt = Date.now();
    const laneRegistration: LaneRegistration = { worktreePath, branch, agentId, createdAt };
    try {
      await fs.writeFile(
        this.registrationPath(cleanAgentId),
        JSON.stringify(laneRegistration, null, 2),
        { encoding: "utf-8", flag: "wx" },
      );
    } catch (error) {
      throw new Error(
        `Could not reserve ownership for managed lane '${cleanAgentId}': ${String(error)}`,
      );
    }

    try {
      await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath], { cwd: this.repoRoot });
    } catch (error) {
      try {
        await this.removeRegistrationIfOwned(cleanAgentId, laneRegistration);
      } catch (cleanupError) {
        throw new Error(
          `Git failed to create worktree '${worktreePath}' and its ownership reservation could not be rolled back: ${String(error)}; cleanup: ${String(cleanupError)}`,
        );
      }
      throw error;
    }

    // From this point onward the lane is both Git-registered and ownership-registered. If a later
    // metadata read fails, keeping the registration intact makes the lane recoverable/removable.
    const { stdout: headSha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });

    return {
      worktreePath,
      branch,
      headSha: headSha.trim(),
      agentId,
      createdAt,
    };
  }

  /**
   * Removes an isolated worktree only when it is a registered, clean lane owned by this manager.
   * Git removal failures are surfaced; they are never converted into recursive filesystem deletion.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    const resolved = this.assertManagedLanePath(worktreePath);
    const cleanAgentId = path.basename(resolved);
    const registration = await this.readRegistration(cleanAgentId);
    if (!registration || path.resolve(registration.worktreePath) !== resolved) {
      throw new Error(`Refusing to remove unowned or unregistered worktree '${resolved}'`);
    }

    const registered = await this.listWorktrees();
    if (!registered.some((entry) => path.resolve(entry.path) === resolved)) {
      throw new Error(`Refusing to remove '${resolved}' because Git does not register it as a worktree`);
    }

    const { stdout: porcelain } = await execFileAsync("git", ["status", "--porcelain"], { cwd: resolved });
    if (porcelain.trim().length > 0) {
      throw new Error(`Refusing to remove dirty worktree '${resolved}'. Commit, stash, or discard changes explicitly first.`);
    }

    await execFileAsync("git", ["worktree", "remove", resolved], { cwd: this.repoRoot });
    await this.removeRegistrationIfOwned(cleanAgentId, registration);
    await execFileAsync("git", ["worktree", "prune"], { cwd: this.repoRoot });
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
