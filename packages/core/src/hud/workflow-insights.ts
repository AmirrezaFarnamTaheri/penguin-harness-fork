/**
 * Workflow Insights and Behavioral Telemetry.
 * Ported and unified from codeburn and Hermes session ledger.
 */

export interface WeightedCall {
  supplementaryAccounting?: boolean;
  timestamp?: string;
  tools?: string[];
  toolSequence?: Array<Array<{ name: string; args?: Record<string, unknown> }>>;
}

export interface WeightedTurn {
  userMessage?: string;
  assistantCalls: readonly WeightedCall[];
  timestamp?: string;
}

export interface WorkflowSession {
  sessionId: string;
  projectPath?: string;
  turns: readonly WeightedTurn[];
}

export interface UserCorrectionStats {
  corrections: number;
  userTurns: number;
  correctionRate: number | null;
}

export interface ReworkedFile {
  path: string;
  sessions: number;
  edits: number;
}

/**
 * True when the call is a real user-requested model invocation (weight 1);
 * false for supplementary accounting such as shutdown rollups or sync residual calls (weight 0).
 */
export function isBehavioralCall(call: WeightedCall): boolean {
  return !call.supplementaryAccounting;
}

/**
 * Number of real behavioral requests among a turn's assistant calls.
 */
export function behavioralCallCount(calls: readonly WeightedCall[]): number {
  let n = 0;
  for (const call of calls) {
    if (!call.supplementaryAccounting) n++;
  }
  return n;
}

/**
 * True when the turn holds at least one behavioral call.
 */
export function isBehavioralTurn(turn: WeightedTurn): boolean {
  return turn.assistantCalls.some((call) => !call.supplementaryAccounting);
}

/**
 * Number of behavioral turns (excluding turns that only performed internal accounting).
 */
export function behavioralTurnCount(turns: readonly WeightedTurn[]): number {
  let n = 0;
  for (const turn of turns) {
    if (isBehavioralTurn(turn)) n++;
  }
  return n;
}

/**
 * User-side correction heuristics to detect when a user corrects an assistant's mistakes.
 */
export const USER_CORRECTION_PATTERNS: RegExp[] = [
  /\bthat'?s (?:not|n'?t) (?:what|right|correct|it)\b/i,
  /\bthat'?s (?:wrong|incorrect)\b/i,
  /\bthat is (?:wrong|incorrect|not right)\b/i,
  /\bnot what I (?:meant|wanted|asked|said)\b/i,
  /\bno,? I (?:meant|wanted|said|asked for)\b/i,
  /\byou (?:missed|forgot|misunderstood|broke)\b/i,
  /\brevert (?:that|it|this|your|the last|the change)\b/i,
  /\bundo (?:that|it|this|your|the last|the change)\b/i,
  /\bwrong (?:file|approach|place|method|function|way|direction)\b/i,
  /\bstill (?:wrong|broken|failing|not working)\b/i,
];

export function matchesUserCorrection(text: string): boolean {
  return USER_CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Scans sessions for user corrections across conversation turns.
 */
export function scanUserCorrections(sessions: readonly WorkflowSession[]): UserCorrectionStats {
  let corrections = 0;
  let userTurns = 0;

  for (const session of sessions) {
    let sawPrompt = false;
    for (const turn of session.turns) {
      const msg = turn.userMessage;
      if (!msg || !msg.trim()) continue;

      userTurns++;
      if (!sawPrompt) {
        sawPrompt = true;
        continue;
      }

      if (matchesUserCorrection(msg)) {
        corrections++;
      }
    }
  }

  return {
    corrections,
    userTurns,
    correctionRate: userTurns > 0 ? Number((corrections / userTurns).toFixed(4)) : null,
  };
}

export const DEFAULT_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "create",
  "replace",
  "patch",
  "str_replace",
  "write_to_file",
  "replace_file_content",
]);

/**
 * Milliseconds from session start to first assistant edit tool invocation.
 */
export function sessionTimeToFirstEditMs(
  session: WorkflowSession,
  editTools: ReadonlySet<string> = DEFAULT_EDIT_TOOLS,
): number | null {
  const startRaw = session.turns[0]?.timestamp;
  if (!startRaw) return null;
  const startMs = Date.parse(startRaw);
  if (Number.isNaN(startMs)) return null;

  for (const turn of session.turns) {
    for (const call of turn.assistantCalls) {
      const hasEdit = (call.tools ?? []).some((t) => editTools.has(t.toLowerCase()));
      if (!hasEdit) continue;

      const editRaw = call.timestamp;
      if (!editRaw) return null;
      const editMs = Date.parse(editRaw);
      if (Number.isNaN(editMs)) return null;

      return Math.max(0, editMs - startMs);
    }
  }
  return null;
}

/**
 * Computes median time-to-first-edit across sessions.
 */
export function medianTimeToFirstEditMs(
  sessions: readonly WorkflowSession[],
  editTools: ReadonlySet<string> = DEFAULT_EDIT_TOOLS,
): number | null {
  const samples: number[] = [];
  for (const session of sessions) {
    const ms = sessionTimeToFirstEditMs(session, editTools);
    if (ms !== null) {
      samples.push(ms);
    }
  }

  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 === 0 ? (samples[mid - 1]! + samples[mid]!) / 2 : samples[mid]!;
}

function normalizeFileSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function relativizePath(absPath: string, projectPath?: string): string {
  const norm = normalizeFileSlashes(absPath);
  if (projectPath) {
    const normProject = normalizeFileSlashes(projectPath).replace(/\/+$/, "");
    if (norm === normProject || norm.startsWith(normProject + "/")) {
      return norm.slice(normProject.length + 1) || norm;
    }
  }
  return norm;
}

/**
 * Aggregates file rework/churn metrics across sessions.
 */
export function aggregateFileChurn(
  sessions: readonly WorkflowSession[],
  options?: { limit?: number; projectPath?: string; editTools?: ReadonlySet<string> },
): ReworkedFile[] {
  const limit = options?.limit ?? 15;
  const editTools = options?.editTools ?? DEFAULT_EDIT_TOOLS;

  type Acc = { path: string; sessions: Set<string>; edits: number };
  const byPath = new Map<string, Acc>();

  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const call of turn.assistantCalls) {
        if (!call.toolSequence) continue;
        for (const step of call.toolSequence) {
          for (const tc of step) {
            if (!editTools.has(tc.name.toLowerCase())) continue;
            const rawTarget =
              (tc.args?.TargetFile as string | undefined) ??
              (tc.args?.targetFile as string | undefined) ??
              (tc.args?.path as string | undefined) ??
              (tc.args?.file_path as string | undefined);
            if (!rawTarget || typeof rawTarget !== "string") continue;

            const relPath = relativizePath(rawTarget, options?.projectPath ?? session.projectPath);
            let entry = byPath.get(relPath);
            if (!entry) {
              entry = { path: relPath, sessions: new Set(), edits: 0 };
              byPath.set(relPath, entry);
            }
            entry.sessions.add(session.sessionId);
            entry.edits++;
          }
        }
      }
    }
  }

  const sorted = [...byPath.values()].sort((a, b) => {
    const bySessions = b.sessions.size - a.sessions.size;
    if (bySessions !== 0) return bySessions;
    return b.edits - a.edits;
  });

  return sorted.slice(0, limit).map((entry) => ({
    path: entry.path,
    sessions: entry.sessions.size,
    edits: entry.edits,
  }));
}
