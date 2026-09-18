/**
 * Server-side services for the Universal Tool Mesh.
 *
 * The fleet's server surface. {@link ToolFleetService} is the facade the routes talk to;
 * the pieces beneath it are exported so a caller can compose them differently (an embedded
 * SDK wants the vault and the mesh, not the refresh loop).
 */
export {
  FleetKeymaster,
  FleetKeymasterError,
  credentialStatus,
  EXPIRY_WARN_MS,
  type CredentialItem,
  type FleetKeymasterOptions,
} from "./fleet-keymaster.js";

export {
  FleetTokenRefreshScheduler,
  FleetTokenRefreshError,
  type FleetRefreshSnapshot,
  type FleetTokenRefreshOptions,
  type RefreshOutcome,
  type RefreshTransport,
} from "./fleet-token-refresh-scheduler.js";

export {
  FleetInvocationAudit,
  fingerprintEntry,
  type FleetAuditEntry,
  type FleetAuditStats,
  type FleetInvocationAuditOptions,
} from "./fleet-invocation-audit.js";

export {
  ToolFleetService,
  type ConnectableProvider,
  type FleetHealthSummary,
  type ToolFleetServiceOptions,
} from "./tool-fleet-service.js";
