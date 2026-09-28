export {
  JevCircuitOpenError,
  JevClient,
  type JevAskOptions,
  type JevCircuitState,
  type JevClientOptions,
} from "./client.js";
export {
  buildJevAdvisoryState,
  createJevAdvisoryHook,
  JEV_DEFAULT_DEADLINE_MS,
  JEV_MAX_ARGUMENT_CHARS,
  JEV_MAX_STATE_CHARS,
  JEV_RISK_RUBRIC,
  JEV_TOOL_QUESTIONS,
  JevToolAdvisor,
  type JevToolAdvisorOptions,
} from "./advisor.js";
export {
  createJevAdvisor,
  createJevSurfaceAdvisor,
  type CreateJevAdvisorOptions,
} from "./config.js";
export {
  ADVISORY_SURFACES,
  AdvisoryActivityRecorder,
  bucketReason,
  type AdvisoryActivity,
  type AdvisoryReason,
  type AdvisorySurface,
  type SurfaceDropReason,
} from "./activity.js";
export {
  buildJevSurfaceState,
  JEV_MAX_PENDING_SURFACE_OBSERVATIONS,
  JEV_SURFACE_DEADLINE_MS,
  JEV_SURFACE_QUESTIONS,
  JevSurfaceAdvisor,
  type JevContextFacts,
  type JevContextRead,
  type JevSessionFacts,
  type JevSessionRead,
  type JevSurfaceAdvisorOptions,
  type JevSurfaceAdvisory,
  type JevSurfaceFacts,
  type JevTurnFacts,
  type JevTurnRead,
} from "./surfaces.js";
export type {
  JevAdvisoryStatus,
  JevRequest,
  JevResponse,
  JevToolAdvisory,
  JevToolChoice,
} from "./types.js";
// The observation journal and the analysis layer over it. Both were built while this file was
// held by a sibling, so they were importable only by direct path — reachable, but not
// discoverable, and a barrel that lies about its module's surface is a small lie that
// compounds. Neither is wired into the module's own request path: the journal imports only
// TYPES from the rest of jev, so it cannot create a cycle, and nothing here can be reached
// by accident.
export * from "./observation.js";
export * from "./insight.js";
