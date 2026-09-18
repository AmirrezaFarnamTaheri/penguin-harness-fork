/**
 * Registry contract: every tool the default config offers the model has a factory in
 * BUILTIN_TOOL_FACTORIES, and environment_info — the host/path detection tool — is one of them.
 *
 * The registry is the seam that makes a config entry executable: Environment assembles a tool
 * only when its name is in the table, and a name without a factory is silently skipped (neither
 * listed to the model nor callable). A default entry that loses its factory therefore vanishes
 * from the agent with no error anywhere, so the contract is pinned here rather than trusted.
 * environment_info specifically, because it is the tool that answers "which platform form is
 * this?" — registered and defaulted together, the two halves are useless apart.
 */
import { describe, expect, it } from "vitest";

import { defaultSystemConfig } from "../../src/state/default-config.js";
import type { ToolDefinitionConfig } from "../../src/interfaces/index.js";
import { BUILTIN_TOOL_FACTORIES } from "../../src/environment/tools/registry.js";
import {
  ENVIRONMENT_INFO_NAME,
  ENVIRONMENT_INFO_PARAMETERS,
  createEnvironmentInfoTool,
} from "../../src/environment/tools/environment-info.js";

// defaultSystemConfig always populates tools.builtin (see default-config.ts); the optional
// typing is narrowed here once via the safe-access chain rather than asserted at each use below.
const defaultBuiltin = (): ToolDefinitionConfig[] => defaultSystemConfig().tools?.builtin ?? [];
const defaultTools = (): string[] => defaultBuiltin().map((t) => t.name);

describe("builtin tool registry", () => {
  it("registers a factory for every tool the default config offers", () => {
    const missing = defaultTools().filter((name) => BUILTIN_TOOL_FACTORIES[name] === undefined);
    expect(missing).toEqual([]);
  });

  it("offers no tool name twice", () => {
    const names = defaultTools();
    expect(new Set(names).size).toBe(names.length);
  });

  it("defaults environment_info and backs it with a factory", () => {
    expect(defaultTools()).toContain(ENVIRONMENT_INFO_NAME);
    expect(BUILTIN_TOOL_FACTORIES[ENVIRONMENT_INFO_NAME]).toBeDefined();

    const entry = defaultBuiltin().find((t) => t.name === ENVIRONMENT_INFO_NAME);
    expect(entry).toBeDefined();
    // A read-only tool that answers a question; the timeout is short because detection is
    // a few file reads, and the budget matches the tool's own fallback.
    expect(entry!.permission).toBe("r");
    // The schema is exported once and referenced by the config entry, so the entry and the tool
    // cannot disagree about what the arguments are.
    expect(entry!.parameters).toBe(ENVIRONMENT_INFO_PARAMETERS);
  });

  it("builds environment_info from its config entry", () => {
    const entry = defaultBuiltin().find((t) => t.name === ENVIRONMENT_INFO_NAME)!;
    const tool = BUILTIN_TOOL_FACTORIES[ENVIRONMENT_INFO_NAME]!(entry);
    expect(tool.name).toBe(ENVIRONMENT_INFO_NAME);
    expect(tool.definition).toBe(entry);
  });

  it("constructs the tool directly from its factory", () => {
    const tool = createEnvironmentInfoTool({
      name: ENVIRONMENT_INFO_NAME,
      description: "test",
      permission: "r",
    });
    expect(tool.name).toBe(ENVIRONMENT_INFO_NAME);
  });
});
