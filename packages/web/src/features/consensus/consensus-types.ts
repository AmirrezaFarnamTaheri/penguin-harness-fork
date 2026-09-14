import type {
  TopicStanding,
  TopicConsensusStatus,
  QuorumPolicy,
  Endorsement,
  Refutation,
  MailboxMessage,
  MailboxSummary,
  LeaseState,
} from "@prismshadow/penguin-core";

export type {
  TopicStanding,
  TopicConsensusStatus,
  QuorumPolicy,
  Endorsement,
  Refutation,
  MailboxMessage,
  MailboxSummary,
  LeaseState,
};

export interface HandoffStepItem {
  id: string;
  fromAgent: string;
  toAgent: string;
  reason: string;
  payloadSummary: string;
  status: "completed" | "in_progress" | "blocked" | "pending";
  durationMs: number;
  timestamp: string;
}
