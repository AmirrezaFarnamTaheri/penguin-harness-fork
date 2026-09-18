/**
 * CI evidence bundle readers: the artifact shapes a captured CI phase leaves behind.
 *
 * These modules port the *data shapes and the reasoning* of a CI evidence bundle rather than any source
 * project: the evidence manifest, the source-identity sidecar, the phase summary table, the diagnostics
 * document and the captured phase logs, together with the escape-sequence handling every captured line needs
 * before it can be parsed.
 */

export {
  stripAnsi,
  stripAnsiFromLines,
  stripLogTimestamp,
  cleanLogLine,
  cleanLogLines,
  type LogLineTimestamp,
} from "./ansi.js";

export {
  parseEvidenceManifest,
  summarizeManifestBytes,
  verifyManifestHashes,
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_MANIFEST_STATUS_SUCCESS,
  type EvidenceFile,
  type EvidenceManifest,
  type ManifestIssue,
  type ManifestIssueKind,
  type ParsedEvidenceManifest,
  type ManifestBytesSummary,
  type ManifestHashVerification,
} from "./evidence-manifest-parser.js";

export {
  parseSourceIdentity,
  compareSourceIdentity,
  summarizeIdentityComparison,
  SOURCE_IDENTITY_SCHEMA_VERSION,
  type SourceIdentity,
  type ParsedSourceIdentity,
  type ManifestSourceView,
  type SourceIdentityComparison,
  type IdentityFieldStatus,
  type IdentityComparisonSummary,
} from "./source-identity.js";

export {
  parseCommandSummary,
  formatDurationLabel,
  allRowsHaveResult,
  COMMAND_SUMMARY_PASS,
  COMMAND_SUMMARY_FAIL,
  type CommandSummary,
  type CommandSummaryRow,
} from "./command-summary-parser.js";

export {
  parseDiagnosticsLog,
  diagnosticsStrayLines,
  diagnosticsValue,
  diagnosticsValues,
  diagnosticsSection,
  diagnosticsSectionValue,
  parseLockfileFingerprints,
  parseRepositoryInventory,
  parseFilesystemCapacity,
  type DiagnosticsLog,
  type DiagnosticsEntry,
  type DiagnosticsSection,
  type LockfileFingerprint,
  type InventoryEntry,
  type CapacityEntry,
} from "./diagnostics-log-parser.js";

export {
  parsePhaseLog,
  phaseSection,
  phaseStdoutLines,
  phaseStderrLines,
  parseProgressLine,
  phaseProgressLines,
  type PhaseLog,
  type PhaseHeader,
  type PhaseResult,
  type PhaseSection,
  type PhaseEnvelopeEntry,
  type ProgressLine,
  type TestSummaryCounts,
} from "./run-log-parser.js";
