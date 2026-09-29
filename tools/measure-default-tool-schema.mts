/**
 * Reproducible measurement of the model-facing default tool payload.
 *
 * Run from the repository root with `pnpm exec tsx tools/measure-default-tool-schema.mts`.
 * The before fixture uses the same current default configuration with only
 * `knowledge_graph` and `code_graph` removed. No user state, MCP server, machine-specific path,
 * or external tokenizer is required.
 */
import { Environment } from "../packages/core/src/environment/environment.js";
import { approximateTokens } from "../packages/core/src/llm/context-limits.js";
import { toolCall } from "../packages/core/src/omnimessage/index.js";
import type { OmniMessage } from "../packages/core/src/omnimessage/index.js";
import { defaultSystemConfig } from "../packages/core/src/state/default-config.js";
import type { ToolDefinitionConfig } from "../packages/core/src/interfaces/index.js";

const ADDED_TOOLS = ["knowledge_graph", "code_graph"] as const;
const REVIEW_THRESHOLD_TOKENS = 1500;
const addedNames = new Set<string>(ADDED_TOOLS);
const defaultTools = defaultSystemConfig().tools.builtin;
const previousTools = defaultTools.filter((tool) => !addedNames.has(tool.name));

if (ADDED_TOOLS.some((name) => !defaultTools.some((tool) => tool.name === name))) {
  throw new Error("The default tool configuration is missing one of the two measured tools.");
}

function environmentFor(
  customTools: ToolDefinitionConfig[],
  toolExposure: "direct" | "lazy",
): Environment {
  return new Environment({
    workspaceDir: process.cwd(),
    toolConfig: { customTools, mcpServers: [], toolExposure },
  });
}

async function collect(generator: AsyncGenerator<OmniMessage>): Promise<OmniMessage[]> {
  const messages: OmniMessage[] = [];
  for await (const message of generator) messages.push(message);
  return messages;
}

function summarize(serialized: string) {
  return {
    characters: serialized.length,
    utf8Bytes: Buffer.byteLength(serialized, "utf8"),
    charsPer4Tokens: Math.ceil(serialized.length / 4),
    runtimeEstimateTokens: approximateTokens(serialized),
  };
}

function measureSchemas(schemas: unknown[]) {
  const serialized = JSON.stringify(schemas);
  return { schemaCount: schemas.length, ...summarize(serialized) };
}

function verifyConfiguredSchemas(
  configuredTools: ToolDefinitionConfig[],
  schemas: Array<{ name: string }>,
) {
  const configuredNames = configuredTools.map((tool) => tool.name);
  const exposedNames = schemas.map((schema) => schema.name);
  const missing = configuredNames.filter((name) => !exposedNames.includes(name));
  const unexpected = exposedNames.filter((name) => !configuredNames.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Direct schema fixture mismatch; missing: ${missing.join(", ") || "none"}; ` +
        `unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
  return { configuredNames, exposedNames, allConfiguredToolsExposed: true };
}

async function measureLazySearch(environment: Environment, toolName: (typeof ADDED_TOOLS)[number]) {
  const messages = await collect(
    environment.executeTool({
      toolCall: toolCall({
        name: "search_tools",
        arguments: JSON.stringify({ query: toolName, limit: 1 }),
        toolCallId: `schema-measure-${toolName}`,
      }),
    }),
  );
  const payload = messages.at(-1)?.payload as { output?: string; stop_reason?: string } | undefined;
  if (!payload?.output || payload.stop_reason !== "completed") {
    throw new Error(`Lazy catalog search failed for ${toolName}.`);
  }
  const result = JSON.parse(payload.output) as {
    matches?: Array<{ tool_name?: string }>;
  };
  if (!Array.isArray(result.matches) || result.matches[0]?.tool_name !== toolName) {
    throw new Error(`Lazy catalog search did not return ${toolName}.`);
  }
  return { matchCount: result.matches.length, ...summarize(payload.output) };
}

const environments: Environment[] = [];
try {
  const directBeforeEnvironment = environmentFor(previousTools, "direct");
  environments.push(directBeforeEnvironment);
  const directAfterEnvironment = environmentFor(defaultTools, "direct");
  environments.push(directAfterEnvironment);
  const lazyBeforeEnvironment = environmentFor(previousTools, "lazy");
  environments.push(lazyBeforeEnvironment);
  const lazyAfterEnvironment = environmentFor(defaultTools, "lazy");
  environments.push(lazyAfterEnvironment);

  const directBefore = await directBeforeEnvironment.listTools();
  const directAfter = await directAfterEnvironment.listTools();
  const lazyBefore = await lazyBeforeEnvironment.listTools();
  const lazyAfter = await lazyAfterEnvironment.listTools();
  const addedDirectSchemas = directAfter.filter((tool) => addedNames.has(tool.name));
  const addedSchemaCost = measureSchemas(addedDirectSchemas);
  const directExposure = {
    before: verifyConfiguredSchemas(previousTools, directBefore),
    after: verifyConfiguredSchemas(defaultTools, directAfter),
  };
  if (JSON.stringify(lazyBefore) !== JSON.stringify(lazyAfter)) {
    throw new Error("The lazy gateway payload changed after adding the measured catalog tools.");
  }

  const lazyCatalogSearches = {} as Record<string, Awaited<ReturnType<typeof measureLazySearch>>>;
  for (const toolName of ADDED_TOOLS) {
    lazyCatalogSearches[toolName] = await measureLazySearch(lazyAfterEnvironment, toolName);
  }

  console.log(
    JSON.stringify(
      {
        method: {
          fixture:
            "defaultSystemConfig() on this checkout; before removes only knowledge_graph and code_graph",
          serialization:
            "compact JSON.stringify of Environment.listTools() definitions (provider envelope excluded)",
          charsPer4Tokens: "ceil(serialized UTF-16 character count / 4)",
          runtimeEstimateTokens: "production approximateTokens() estimate",
          providerTokenizer: "unavailable; no provider-specific tokenizer dependency is installed",
          mcpServers: "none; lazy gateway and private built-in catalog only",
        },
        direct: {
          configuredExposure: directExposure,
          before: measureSchemas(directBefore),
          after: measureSchemas(directAfter),
          addedSchemas: addedSchemaCost,
          reviewThresholdTokens: REVIEW_THRESHOLD_TOKENS,
          belowReviewThreshold: addedSchemaCost.charsPer4Tokens <= REVIEW_THRESHOLD_TOKENS,
        },
        lazy: {
          gatewayToolNames: lazyAfter.map((tool) => tool.name),
          beforeGateway: measureSchemas(lazyBefore),
          afterGateway: measureSchemas(lazyAfter),
          gatewayPayloadUnchanged: JSON.stringify(lazyBefore) === JSON.stringify(lazyAfter),
          onDemandSearchResults: lazyCatalogSearches,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(environments.map((environment) => environment.dispose()));
}
