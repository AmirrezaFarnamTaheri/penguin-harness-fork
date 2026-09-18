/**
 * Environment module barrel — exports the environment interface implementation and builtin tool abstractions.
 */
export { Environment } from "./environment.js";
export type { BuiltinTool, ToolExecutionContext } from "./tools/types.js";
export { BUILTIN_TOOL_FACTORIES } from "./tools/registry.js";
export type { BuiltinToolFactory } from "./tools/registry.js";
export { searchToolCatalog } from "./tool-catalog.js";
export type { ToolCatalogEntry, ToolCatalogMatch } from "./tool-catalog.js";
export { createReadFileTool, READ_FILE_NAME } from "./tools/read-file.js";
export { createEditFileTool, EDIT_FILE_NAME } from "./tools/edit-file.js";
export { createWriteFileTool, WRITE_FILE_NAME } from "./tools/write-file.js";
export {
  createEnvironmentInfoTool,
  ENVIRONMENT_INFO_NAME,
  ENVIRONMENT_INFO_PARAMETERS,
} from "./tools/environment-info.js";
export { createExecCommandTool, EXEC_COMMAND_NAME } from "./tools/exec-command.js";
export { createInputCommandTool, INPUT_COMMAND_NAME } from "./tools/input-command.js";
export { createSubagentTool, SUBAGENT_NAME } from "./tools/run-subagent.js";
export { createInputSubagentTool, INPUT_SUBAGENT_NAME } from "./tools/input-subagent.js";
export {
  createWebSearchTool,
  WEB_SEARCH_NAME,
  DEFAULT_SEARXNG_ENDPOINT,
  buildSearxngSearchUrl,
} from "./tools/web-search.js";
export { CommandSessionManager, ManagedSession } from "./tools/command/index.js";
export type { ProcessExit, SpawnOptions } from "./tools/command/index.js";
export { SubagentSessionManager, ManagedSubagentSession } from "./tools/subagent/index.js";
export {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_PERMISSION,
  DEFAULT_TOOL_EXPOSURE_THRESHOLD_TOKENS,
  MCP_TOOL_PREFIX,
  McpToolProvider,
  TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
  mcpToolName,
  resolveMCPServer,
  resolveMCPServers,
} from "./mcp/index.js";
export type {
  MCPServerPermissionMode,
  McpToolProviderOptions,
  ResolvedMCPServer,
  ResolvedMCPTransport,
  ResolveMCPServersResult,
} from "./mcp/index.js";
export * from "./sandbox-provider.js";

// Host detection and path translation — the answers environment_info gives the model. A host
// building on the SDK needs the same facts the tool has (am I on Windows-native, WSL, MSYS or
// Cygwin? which shell? how is a path spelled here?) to present paths in the form this machine
// opens, and translatePath is the converter between the POSIX and native spellings a mixed
// Windows/POSIX setup threads through every command and file path.
export {
  detectHostEnvironment,
  describeEnvironment,
  liveEnvironmentFacts,
  translatePath,
  PathTranslationError,
  type HostEnvironment,
  type HostPlatform,
  type PathStyle,
  type EnvironmentFacts,
  type PathForm,
  type TranslatedPath,
} from "./tools/host-environment.js";

// Line-terminator detection and conversion — the LF/CRLF layer the file tools share. read_file
// shows LF whatever the bytes are, so anything that writes back must restore the file's own
// terminator; these are the detectors and converters that keep that round trip exact.
export {
  countLineEndings,
  detectLineEndings,
  dominantLineEnding,
  dominantTerminatorForWrite,
  lineEndingStyleFromCounts,
  lineEndingStyleLabel,
  lineEndingStyleNote,
  normalizeLineEndings,
  restoreLineEndings,
  terminatorString,
  type LineEndingCounts,
  type LineEndingDetection,
  type LineEndingStyle,
  type LineTerminator,
} from "./tools/line-endings.js";
