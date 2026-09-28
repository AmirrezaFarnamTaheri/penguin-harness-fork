/**
 * Session Time-Travel & Snapshot Rewind Studio Types & Algorithms.
 */

export type SnapshotTrigger = "auto-save" | "pre-tool" | "user-checkpoint" | "branch-fork";

export type RollbackMode = "in-place" | "fork-branch";

/**
 * One snapshot version, as the server actually returns it.
 *
 * `fileCount`, `memoryTopicsCount` and `activePromptHash` used to be declared here and
 * rendered in the timeline's metadata row. The server has never returned any of them — the
 * only `fileCount` in the API is `MemoryScopeInfo`'s, a different type about a different
 * directory — so the row read "state files" and "memory topics" with no number in front of
 * them, because `undefined` renders as an empty string. A type that promises a field the
 * wire never carries is worse than a missing one: it makes the gap invisible to the compiler
 * and to the next reader. They are gone from the type, and with them the rendering.
 *
 * `uncompressedSizeBytes` and `isCurrent` are real and are what the row now shows.
 */
export interface SnapshotVersionInfo {
  version: number;
  label: string;
  timestamp: number;
  trigger: SnapshotTrigger;
  uncompressedSizeBytes: number;
  isCurrent: boolean;
}

export interface StateDiffSummary {
  promptDiff: {
    before: string;
    after: string;
    changed: boolean;
  };
  memoryChanges: Array<{
    topic: string;
    changeType: "added" | "modified" | "deleted";
    diffSnippet?: string;
  }>;
  skillChanges: Array<{
    skillName: string;
    changeType: "added" | "modified" | "deleted";
  }>;
}

export interface TimeTravelResult {
  success: boolean;
  targetVersion: number;
  mode: RollbackMode;
  newSessionId?: string;
  safetySnapshotVersion?: number;
  message: string;
}

export interface AgentSnapshotState {
  systemPrompt: string;
  memoryFiles: Record<string, string>;
  skills: string[];
}

/**
 * Computes difference between two snapshot states (e.g. source current vs target rollback).
 */
export function computeStateDiff(
  source: SnapshotVersionInfo,
  target: SnapshotVersionInfo,
  stateDetails: Record<number, AgentSnapshotState>,
): StateDiffSummary {
  const sourceState = stateDetails[source.version] ?? {
    systemPrompt: "",
    memoryFiles: {},
    skills: [],
  };
  const targetState = stateDetails[target.version] ?? {
    systemPrompt: "",
    memoryFiles: {},
    skills: [],
  };

  // Prompt diff
  const promptChanged = sourceState.systemPrompt !== targetState.systemPrompt;
  const promptDiff = {
    before: sourceState.systemPrompt,
    after: targetState.systemPrompt,
    changed: promptChanged,
  };

  // Memory changes
  const memoryChanges: StateDiffSummary["memoryChanges"] = [];
  const allTopicKeys = new Set([
    ...Object.keys(sourceState.memoryFiles),
    ...Object.keys(targetState.memoryFiles),
  ]);

  for (const topic of allTopicKeys) {
    const srcContent = sourceState.memoryFiles[topic];
    const tgtContent = targetState.memoryFiles[topic];

    if (srcContent === undefined && tgtContent !== undefined) {
      memoryChanges.push({ topic, changeType: "added" });
    } else if (srcContent !== undefined && tgtContent === undefined) {
      memoryChanges.push({ topic, changeType: "deleted" });
    } else if (srcContent !== tgtContent) {
      memoryChanges.push({
        topic,
        changeType: "modified",
        diffSnippet: `Content modified (${tgtContent?.length ?? 0} bytes)`,
      });
    }
  }

  // Skill changes
  const skillChanges: StateDiffSummary["skillChanges"] = [];
  const srcSkills = new Set(sourceState.skills);
  const tgtSkills = new Set(targetState.skills);

  for (const skill of targetState.skills) {
    if (!srcSkills.has(skill)) {
      skillChanges.push({ skillName: skill, changeType: "added" });
    }
  }
  for (const skill of sourceState.skills) {
    if (!tgtSkills.has(skill)) {
      skillChanges.push({ skillName: skill, changeType: "deleted" });
    }
  }

  return {
    promptDiff,
    memoryChanges,
    skillChanges,
  };
}

/**
 * Simulates or executes session time travel with safety rollback protections.
 */
export function executeTimeTravel(
  currentVersion: number,
  targetVersion: number,
  mode: RollbackMode,
): TimeTravelResult {
  if (mode === "in-place") {
    const safetySnapshotVersion = Math.max(currentVersion, targetVersion) + 1;
    return {
      success: true,
      targetVersion,
      mode: "in-place",
      safetySnapshotVersion,
      message: `Reverted in-place to v${targetVersion}. Automatic pre-rollback safety snapshot v${safetySnapshotVersion} created.`,
    };
  }

  // Fork session
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  const newSessionId = `fork-v${targetVersion}-${Date.now().toString(36)}-${randomSuffix}`;
  return {
    success: true,
    targetVersion,
    mode: "fork-branch",
    newSessionId,
    message: `Branched new session ${newSessionId} from snapshot v${targetVersion}. Active session preserved.`,
  };
}

/**
 * Validates and extracts version & agent metadata from snapshot archive filename.
 */
export function validateSnapshotArchiveName(fileName: string): {
  valid: boolean;
  version?: number;
  agentId?: string;
} {
  const match = /^([a-zA-Z0-9_-]+)-v(\d+)\.(tar\.gz|tgz|gz)$/i.exec(fileName.trim());
  if (!match) {
    return { valid: false };
  }

  const agentId = match[1];
  const version = parseInt(match[2] ?? "0", 10);

  if (!agentId || isNaN(version) || version <= 0) {
    return { valid: false };
  }

  return {
    valid: true,
    agentId,
    version,
  };
}

/**
 * Formats snapshot timestamps into localized datetime strings.
 */
export function formatSnapshotTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
