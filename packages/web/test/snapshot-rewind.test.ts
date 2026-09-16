import { describe, expect, it } from "vitest";
import {
  computeStateDiff,
  executeTimeTravel,
  formatSnapshotTimestamp,
  validateSnapshotArchiveName,
  type SnapshotVersionInfo,
} from "../src/features/snapshots/snapshot-types";

describe("snapshot-types", () => {
  const sampleSnapshots: SnapshotVersionInfo[] = [
    {
      version: 1,
      label: "Initial Agent Workspace Setup",
      timestamp: 1726300000000,
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
      timestamp: 1726303600000,
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
      timestamp: 1726307200000,
      trigger: "auto-save",
      uncompressedSizeBytes: 174000,
      fileCount: 18,
      memoryTopicsCount: 6,
      activePromptHash: "i9j0k1l2",
      isCurrent: true,
    },
  ];

  const stateDetails: Record<
    number,
    {
      systemPrompt: string;
      memoryFiles: Record<string, string>;
      skills: string[];
    }
  > = {
    1: {
      systemPrompt: "You are a coding assistant.",
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

  describe("computeStateDiff", () => {
    it("computes prompt changes and file/skill diffs between two snapshot versions", () => {
      const diff = computeStateDiff(sampleSnapshots[2]!, sampleSnapshots[1]!, stateDetails);

      // Prompt changed
      expect(diff.promptDiff.changed).toBe(true);
      expect(diff.promptDiff.before).toContain("autonomous engineering leader");
      expect(diff.promptDiff.after).toContain("senior full-stack engineer");

      // Memory topic modifications and additions
      expect(diff.memoryChanges.length).toBeGreaterThanOrEqual(2);
      const testPatternChange = diff.memoryChanges.find((m) => m.topic === "testing-patterns.md");
      expect(testPatternChange?.changeType).toBe("deleted"); // reverting from v3 to v2 removes testing-patterns

      // Skill changes
      const skillChange = diff.skillChanges.find((s) => s.skillName === "test-engineer");
      expect(skillChange?.changeType).toBe("deleted");
    });
  });

  describe("executeTimeTravel", () => {
    it("performs in-place rollback with automatic safety snapshot created", () => {
      const result = executeTimeTravel(3, 1, "in-place");
      expect(result.success).toBe(true);
      expect(result.mode).toBe("in-place");
      expect(result.targetVersion).toBe(1);
      expect(result.safetySnapshotVersion).toBe(4);
      expect(result.message).toContain("Reverted in-place to v1");
    });

    it("performs branch fork creating a new isolated session ID", () => {
      const result = executeTimeTravel(3, 2, "fork-branch");
      expect(result.success).toBe(true);
      expect(result.mode).toBe("fork-branch");
      expect(result.targetVersion).toBe(2);
      expect(result.newSessionId).toBeDefined();
      expect(result.newSessionId).toContain("fork-v2-");
    });
  });

  describe("validateSnapshotArchiveName", () => {
    it("validates and parses valid snapshot archive filenames", () => {
      const parsed1 = validateSnapshotArchiveName("agent-alpha-v3.tar.gz");
      expect(parsed1.valid).toBe(true);
      expect(parsed1.agentId).toBe("agent-alpha");
      expect(parsed1.version).toBe(3);

      const parsed2 = validateSnapshotArchiveName("my-worker-v12.tgz");
      expect(parsed2.valid).toBe(true);
      expect(parsed2.agentId).toBe("my-worker");
      expect(parsed2.version).toBe(12);
    });

    it("rejects invalid archive filenames", () => {
      expect(validateSnapshotArchiveName("not-a-snapshot.txt").valid).toBe(false);
      expect(validateSnapshotArchiveName("agent-no-version.tar.gz").valid).toBe(false);
    });
  });

  describe("formatSnapshotTimestamp", () => {
    it("formats epoch timestamps into readable dates", () => {
      const formatted = formatSnapshotTimestamp(1726300000000);
      expect(formatted).toBeDefined();
      expect(formatted.length).toBeGreaterThan(5);
    });
  });
});
