/**
 * Autonomous SWE loop mechanics — an ordered event log, a whole-run tool-loop
 * state machine, edit-history checkpointing, submission review, and the
 * code-execution guard model.
 *
 * These are the whole-run control surfaces that `engine/context-engine.ts`
 * does not provide: that engine runs the ReAct loop for one agent and yields
 * tool output as it streams, without judging whether the *run* is making
 * progress, whether it is time to submit, or whether a patch is acceptable.
 */
export {
  SweEventStream,
  type SweEvent,
  type SweEventKind,
  type SweReplayOptions,
  type SweStreamCheckpoint,
  type SweStreamOptions,
} from "./event-stream.js";

export {
  DEFAULT_TOOL_LOOP_LIMITS,
  ToolLoopStateMachine,
  type RetryMode,
  type ToolLoopEventKind,
  type ToolLoopLimits,
  type ToolLoopSnapshot,
  type ToolLoopState,
  type ToolLoopTransition,
} from "./tool-loop-state.js";

export {
  CodeExecutionPolicyEngine,
  DEFAULT_AUTHORIZED_IMPORTS,
  DEFAULT_CODE_EXECUTION_POLICY,
  DANGEROUS_FUNCTIONS,
  DANGEROUS_MODULES,
  ALLOWED_DUNDER_METHODS,
  strictCodeExecutionPolicy,
  buildImportTree,
  checkImportAuthorized,
  type CodeArtifact,
  type CodeExecutionAssessment,
  type CodeExecutionPolicy,
  type CodeExecutionViolation,
  type CodeLanguage,
  type ImportTree,
} from "./code-execution-policy.js";

export {
  DEFAULT_SUBMISSION_POLICY,
  SubmissionReviewer,
  type PatchFile,
  type Submission,
  type SubmissionExitStatus,
  type SubmissionFinding,
  type SubmissionFindingLevel,
  type SubmissionPolicy,
  type SubmissionVerdict,
  type TestEvidence,
} from "./submission-reviewer.js";

export {
  EditHistory,
  type EditCheckpoint,
  type EditHistoryOptions,
  type FileView,
  type RollbackResult,
} from "./edit-history-checkpoint.js";
