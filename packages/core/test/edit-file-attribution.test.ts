/**
 * edit_file runtime attribution (option A — runtime-recorded, not cryptographic):
 * a successful edit's output carries a receipt naming who edited (agent/session from the
 * runtime, never model arguments), which tool call, when, and the SHA-256 of the file's
 * bytes before and after — so a later agent reading the conversation or Trace can tell
 * whether the file changed since. A failed edit produces no receipt: nothing was edited.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EDIT_FILE_NAME, createEditFileTool } from "../src/environment/tools/edit-file.js";
import type { BuiltinTool, ToolResult } from "../src/environment/tools/types.js";
import type { ToolDefinitionConfig } from "../src/interfaces/index.js";
import type { OmniMessage } from "../src/omnimessage/index.js";

function def(name: string, permission: "r" | "rw"): ToolDefinitionConfig {
  return { name, description: "test", permission };
}

/** Runs one tool execution: concatenates text deltas and captures the generator's return value. */
async function run(tool: BuiltinTool, args: Record<string, unknown>, ctx: Record<string, unknown>) {
  const gen = tool.execute(args, ctx as never);
  const messages: OmniMessage[] = [];
  let result: ToolResult | void;
  for (;;) {
    const res = await gen.next();
    if (res.done) {
      result = res.value;
      break;
    }
    messages.push(res.value);
  }
  const text = messages.map((m) => (m.payload as { output?: string }).output ?? "").join("");
  return { result, text };
}

const sha256 = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "penguin-edit-attribution-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("edit_file runtime attribution", () => {
  it("records agent, session, call id, timestamp and before/after hashes on a successful edit", async () => {
    const file = path.join(tmp, "a.txt");
    await writeFile(file, "before line\n");
    const before = await readFile(file, "utf8");
    const { text } = await run(
      createEditFileTool(def(EDIT_FILE_NAME, "rw")),
      {
        file_path: file,
        old_string: "before line",
        new_string: "after line",
      },
      {
        workspaceDir: tmp,
        toolCallId: "call-77",
        attribution: { agentId: "ag-1", sessionId: "sess-9" },
      },
    );
    expect(text).toContain("Replaced 1 occurrence");
    const line = text.split("\n").find((l) => l.startsWith("[editor attribution: "));
    expect(line).toBeDefined();
    expect(line).toContain("agent=ag-1");
    expect(line).toContain("session=sess-9");
    expect(line).toContain("call=call-77");
    // Timestamp: an ISO instant, not the model's word for it.
    const at = /\bat=([^\s]+)\b/.exec(line!)?.[1] ?? "";
    expect(Number.isNaN(Date.parse(at))).toBe(false);
    // Hashes match the real bytes on disk before and after the write.
    expect(line).toContain(`sha256_before=${sha256(before)}`);
    expect(line).toContain(`sha256_after=${sha256(await readFile(file, "utf8"))}`);
    expect(line).toMatch(/[a-f0-9]{64}/);
  });

  it("emits no receipt when the edit fails", async () => {
    const file = path.join(tmp, "b.txt");
    await writeFile(file, "content\n");
    const { text } = await run(
      createEditFileTool(def(EDIT_FILE_NAME, "rw")),
      {
        file_path: file,
        old_string: "not present",
        new_string: "x",
      },
      {
        workspaceDir: tmp,
        toolCallId: "call-78",
        attribution: { agentId: "ag-1", sessionId: "sess-9" },
      },
    );
    expect(text).not.toContain("[editor attribution:");
  });

  it("still succeeds without attribution context (bare embedders keep the old output shape)", async () => {
    const file = path.join(tmp, "c.txt");
    await writeFile(file, "alpha\n");
    const { text } = await run(
      createEditFileTool(def(EDIT_FILE_NAME, "rw")),
      {
        file_path: file,
        old_string: "alpha",
        new_string: "beta",
      },
      { workspaceDir: tmp, toolCallId: "call-79" },
    );
    expect(text).toContain("Replaced 1 occurrence");
    expect(text).not.toContain("[editor attribution:");
  });
});
