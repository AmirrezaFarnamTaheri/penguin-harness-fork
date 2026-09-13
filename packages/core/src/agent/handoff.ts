/**
 * Multi-Agent Handoff and State Transfer Protocol.
 * Absorbed and unified from aif-handoff, agents-main, and cc-connect.
 */

export type HandoffMode = "coordinator" | "subagent" | "peer_delegation" | "review_gate";

export interface HandoffArtifact {
  path: string;
  description: string;
  diff?: string;
}

export interface HandoffPacket {
  sourceAgentId: string;
  targetAgentId: string;
  mode: HandoffMode;
  taskId?: string;
  goal: string;
  summary: string;
  artifacts: HandoffArtifact[];
  constraints?: string[];
  sharedMemoryKeys?: string[];
  skipReview?: boolean;
  timestamp: number;
}

/**
 * Creates a structured handoff packet for transferring execution context between agents.
 */
export function createHandoffPacket(params: {
  sourceAgentId: string;
  targetAgentId: string;
  mode?: HandoffMode;
  taskId?: string;
  goal: string;
  summary: string;
  artifacts?: HandoffArtifact[];
  constraints?: string[];
  sharedMemoryKeys?: string[];
  skipReview?: boolean;
}): HandoffPacket {
  return {
    sourceAgentId: params.sourceAgentId,
    targetAgentId: params.targetAgentId,
    mode: params.mode ?? "subagent",
    taskId: params.taskId,
    goal: params.goal,
    summary: params.summary,
    artifacts: params.artifacts ?? [],
    constraints: params.constraints ?? [],
    sharedMemoryKeys: params.sharedMemoryKeys ?? [],
    skipReview: params.skipReview ?? false,
    timestamp: Date.now(),
  };
}

/**
 * Formats a handoff packet into an authoritative context injection prompt for the receiving agent.
 */
export function formatHandoffPrompt(packet: HandoffPacket): string {
  const lines: string[] = [
    `=== AGENT HANDOFF PACKET ===`,
    `Mode: ${packet.mode.toUpperCase()}`,
    `Delegated by: ${packet.sourceAgentId}`,
    `Assigned to: ${packet.targetAgentId}`,
  ];

  if (packet.taskId) {
    lines.push(`Task ID: ${packet.taskId}`);
  }

  lines.push(`Objective: ${packet.goal}`, ``, `Context Summary:`, packet.summary);

  if (packet.artifacts.length > 0) {
    lines.push(``, `Attached Artifacts:`);
    for (const art of packet.artifacts) {
      lines.push(`- ${art.path}: ${art.description}`);
    }
  }

  if (packet.constraints && packet.constraints.length > 0) {
    lines.push(``, `Execution Constraints:`);
    for (const c of packet.constraints) {
      lines.push(`- ${c}`);
    }
  }

  if (packet.skipReview) {
    lines.push(``, `Note: Direct execution requested (Skip Review Gate: true).`);
  }

  lines.push(`============================`);
  return lines.join("\n");
}
