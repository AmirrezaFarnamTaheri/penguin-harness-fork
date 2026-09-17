import { describe, expect, it } from "vitest";
import {
  McpToolProvider,
  TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
} from "../src/environment/mcp/provider.js";

// Synthetic tools, not a measurement of the installed skill catalog.
const relevant = Array.from({ length: 12 }, (_, index) => ({
  name: `prettier_format_${index}`,
  description: "Format source code with Prettier.",
  parameters: {
    type: "object",
    properties: { source: { type: "string" } },
    required: ["source"],
    additionalProperties: false,
  },
}));
const unrelated = Array.from({ length: 100 }, (_, index) => ({
  name: `calendar_event_${index}`,
  description: "Schedule a calendar appointment.",
  parameters: {
    type: "object",
    properties: { date: { type: "string" } },
    required: ["date"],
    additionalProperties: false,
  },
}));

describe("lazy tool catalog discovery", () => {
  it("returns bounded relevant schemas without growing the model-visible surface", async () => {
    const provider = new McpToolProvider([], {
      exposure: "lazy",
      catalogTools: [...unrelated, ...relevant].map((definition) => ({
        definition,
        tool: {
          name: definition.name,
          definition: { ...definition, permission: "r" },
          execute: async function* () {
            throw new Error("Discovery must not execute a catalog tool");
          },
        },
      })),
    });
    const initialSurface = await provider.listTools();
    expect(initialSurface.map(({ name }) => name)).toEqual([TOOL_SEARCH_NAME, TOOL_CALL_NAME]);
    const search = await provider.resolveTool(TOOL_SEARCH_NAME);
    if (!search) throw new Error("Lazy discovery gateway is missing");

    for (const [query, limit, count] of [
      ["format code with prettier", 3, 3],
      ["format code with prettier", 100, 10],
      ["volcanology", 3, 0],
    ] as const) {
      let output = "";
      for await (const message of search.execute(
        { query, limit },
        { workspaceDir: process.cwd(), toolCallId: `discovery-${limit}-${count}` },
      )) {
        if ("type" in message.payload && message.payload.type === "partial_tool_call_output") {
          output += message.payload.output;
        }
      }
      const result: unknown = JSON.parse(output);
      expect(result).toEqual(
        expect.objectContaining({
          query,
          matches: relevant.slice(0, count).map((definition) => ({
            tool_ref: expect.any(String),
            tool_name: definition.name,
            source: expect.any(String),
            description: definition.description,
            permission: "r",
            input_schema: definition.parameters,
          })),
        }),
      );
      expect(await provider.listTools()).toEqual(initialSurface);
    }
  });
});
