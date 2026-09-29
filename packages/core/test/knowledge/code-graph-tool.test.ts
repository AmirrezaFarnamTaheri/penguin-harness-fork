import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCodeGraphTool } from "../../src/environment/tools/code-graph.js";
import type { ToolExecutionContext } from "../../src/environment/tools/types.js";

const definition = {
  name: "code_graph",
  description: "Query the code graph",
  parameters: {},
};

async function run(
  args: Record<string, unknown>,
  workspaceDir: string,
): Promise<{ output: string; stopReason: string }> {
  const tool = createCodeGraphTool(definition);
  const ctx: ToolExecutionContext = { workspaceDir, toolCallId: "call_test" };
  let output = "";
  const generator = tool.execute(args, ctx);
  for (;;) {
    const step = await generator.next();
    if (step.done) {
      return { output, stopReason: step.value?.stopReason ?? "completed" };
    }
    const message = step.value as unknown as {
      type?: string;
      payload?: { type?: string; event_type?: string; output?: string };
    };
    if (
      message.type === "model_msg" &&
      message.payload?.type === "partial_tool_call_output" &&
      message.payload.event_type === "delta"
    ) {
      output += message.payload.output ?? "";
    }
  }
}

/** A two-file workspace where `app` calls `helper`, so callers/callees have real edges. */
function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cg-tool-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "src", "helper.ts"),
    "export function helper(): number {\n  return 1;\n}\n",
  );
  writeFileSync(
    path.join(dir, "src", "app.ts"),
    "import { helper } from './helper';\nexport function app(): number {\n  return helper();\n}\n",
  );
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "junk.ts"), "export const junk = 1;\n");
  return dir;
}
describe("code_graph builtin tool", () => {
  it("indexes a workspace, honoring ignore patterns", async () => {
    const dir = makeWorkspace();
    const indexed = JSON.parse((await run({ action: "index" }, dir)).output) as {
      totalFiles: number;
    };
    expect(indexed.totalFiles).toBe(2);

    const files = JSON.parse((await run({ action: "files" }, dir)).output) as {
      total: number;
      files: string[];
    };
    expect(files.total).toBe(2);
    expect(files.files.join(" ")).not.toContain("node_modules");
    expect(files.files.join(" ")).toContain("helper.ts");
  });

  it("searches symbols and answers callers/callees", async () => {
    const dir = makeWorkspace();
    const hits = JSON.parse(
      (await run({ action: "search", term: "helper" }, dir)).output,
    ) as Array<{
      name: string;
    }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.name.includes("helper"))).toBe(true);

    const callees = (await run({ action: "callees", node_id: "src/app.ts", depth: 3 }, dir)).output;
    expect(callees).toContain("helper");
  });

  it("fails cleanly on missing arguments and unknown actions", async () => {
    const dir = makeWorkspace();
    const noAction = await run({}, dir);
    expect(noAction.stopReason).toBe("fatal");
    expect(noAction.output).toContain("action");

    const noTerm = await run({ action: "search" }, dir);
    expect(noTerm.stopReason).toBe("fatal");
    expect(noTerm.output).toContain("term");

    const unknown = await run({ action: "obliterate" }, dir);
    expect(unknown.stopReason).toBe("fatal");
    expect(unknown.output).toContain("Unknown action");
  });
});
