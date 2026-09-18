/**
 * Integration tests for the line-ending contract in the file tools: read_file's style note,
 * and edit_file / write_file preserving a target file's dominant terminator while matching an
 * old_string quoted from read_file's \r-stripped display. Drives the BuiltinTool generators
 * directly, the same way test/file-tools.test.ts does; the LF view and the write-back live in
 * line-endings.ts, covered separately by line-endings.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { READ_FILE_NAME, createReadFileTool } from "../../src/environment/tools/read-file.js";
import { EDIT_FILE_NAME, createEditFileTool } from "../../src/environment/tools/edit-file.js";
import { WRITE_FILE_NAME, createWriteFileTool } from "../../src/environment/tools/write-file.js";
import {
  ENVIRONMENT_INFO_NAME,
  createEnvironmentInfoTool,
} from "../../src/environment/tools/environment-info.js";
import { BUILTIN_TOOL_FACTORIES } from "../../src/environment/tools/registry.js";
import {
  describeEnvironment,
  detectHostEnvironment,
} from "../../src/environment/tools/host-environment.js";
import type { EnvironmentFacts } from "../../src/environment/tools/host-environment.js";
import type { BuiltinTool, ToolResult } from "../../src/environment/tools/types.js";
import type { OmniMessage } from "../../src/omnimessage/index.js";
import type { ToolDefinitionConfig } from "../../src/interfaces/index.js";

function def(name: string, permission: "r" | "rw"): ToolDefinitionConfig {
  return { name, description: "test", permission };
}

/** Runs one tool execution: concatenates text deltas and captures the generator's return value. */
async function run(tool: BuiltinTool, args: Record<string, unknown>, workspaceDir: string) {
  const gen = tool.execute(args, { workspaceDir, toolCallId: "c1" });
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

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "penguin-eol-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("read_file — line-ending note", () => {
  const tool = () => createReadFileTool(def(READ_FILE_NAME, "r"));

  it("adds no note for the common LF file and no note for a file with no endings", async () => {
    await writeFile(path.join(tmp, "lf.txt"), "alpha\nbeta\n");
    const lf = await run(tool(), { file_path: "lf.txt" }, tmp);
    expect(lf.text).not.toContain("line endings");
    await writeFile(path.join(tmp, "none.txt"), "single line, no terminator");
    const none = await run(tool(), { file_path: "none.txt" }, tmp);
    expect(none.text).not.toContain("line endings");
  });

  it("notes CRLF with the stable wording", async () => {
    await writeFile(path.join(tmp, "crlf.txt"), "alpha\r\nbeta\r\n");
    const { text } = await run(tool(), { file_path: "crlf.txt" }, tmp);
    expect(text).toContain("(file uses CRLF line endings)");
    expect(text).not.toContain("\r"); // Display stays \r-free.
  });

  it("notes a CR-only (classic Mac) file", async () => {
    await writeFile(path.join(tmp, "cr.txt"), "alpha\rbeta\r");
    const { text } = await run(tool(), { file_path: "cr.txt" }, tmp);
    expect(text).toContain("(file uses CR line endings)");
  });

  it("notes a mixed file with its per-style counts", async () => {
    await writeFile(path.join(tmp, "mixed.txt"), "alpha\r\nbeta\ngamma\r");
    const { text } = await run(tool(), { file_path: "mixed.txt" }, tmp);
    expect(text).toContain("(file uses mixed line endings: 1 CRLF, 1 LF, 1 CR)");
  });

  it("reports the file's style for any window — the scan counts the whole file under the cap", async () => {
    // LF first half, CRLF second half: whichever window the model asks for, the note reports
    // both counts, because the scan walks the file from the start to count the lines it skips.
    await writeFile(path.join(tmp, "mixed.txt"), `${"x\n".repeat(10)}${"y\r\n".repeat(10)}`);
    const head = await run(tool(), { file_path: "mixed.txt", limit: 3 }, tmp);
    expect(head.text).toContain("(file uses mixed line endings: 10 CRLF, 10 LF)");
    const tail = await run(tool(), { file_path: "mixed.txt", offset: 18 }, tmp);
    expect(tail.text).toContain("(file uses mixed line endings: 10 CRLF, 10 LF)");
  });
});

describe("edit_file — preserve-on-edit round trip", () => {
  const tool = () => createEditFileTool(def(EDIT_FILE_NAME, "rw"));

  it("matches an old_string supplied with LF against a CRLF file and keeps the file CRLF", async () => {
    const file = path.join(tmp, "crlf.txt");
    await writeFile(file, "alpha\nbeta\nGAMMA\ndelta\n".replace(/\n/g, "\r\n"));
    const { result, text } = await run(
      tool(),
      { file_path: "crlf.txt", old_string: "GAMMA", new_string: "replaced" },
      tmp,
    );
    expect(result?.stopReason).toBeUndefined();
    expect(text).toContain('Replaced 1 occurrence in "crlf.txt".');
    // Written back in the file's own terminator: no mixed endings, no LF leak.
    expect(await readFile(file, "utf8")).toBe("alpha\r\nbeta\r\nreplaced\r\ndelta\r\n");
  });

  it("keeps an LF file LF and a CR-only file CR", async () => {
    const lf = path.join(tmp, "lf.txt");
    await writeFile(lf, "alpha\nbeta\n");
    await run(tool(), { file_path: "lf.txt", old_string: "beta", new_string: "two" }, tmp);
    expect(await readFile(lf, "utf8")).toBe("alpha\ntwo\n");

    const cr = path.join(tmp, "cr.txt");
    await writeFile(cr, "alpha\rbeta\r");
    await run(tool(), { file_path: "cr.txt", old_string: "beta", new_string: "two" }, tmp);
    expect(await readFile(cr, "utf8")).toBe("alpha\rtwo\r");
  });

  it("preserves CRLF across a replace_all storm", async () => {
    const file = path.join(tmp, "storm.txt");
    await writeFile(file, "a\nb\n".repeat(4).replace(/\n/g, "\r\n"));
    const { result } = await run(
      tool(),
      { file_path: "storm.txt", old_string: "b", new_string: "cc", replace_all: true },
      tmp,
    );
    expect(result?.stopReason).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("a\r\ncc\r\n".repeat(4));
  });

  it("inserts new multiline content in the file's style (LF new_string into a CRLF file)", async () => {
    const file = path.join(tmp, "crlf.txt");
    await writeFile(file, "start\r\nend\r\n");
    await run(tool(), { file_path: "crlf.txt", old_string: "start", new_string: "one\ntwo" }, tmp);
    expect(await readFile(file, "utf8")).toBe("one\r\ntwo\r\nend\r\n");
  });

  it("preserves a CRLF file when the edit erases the whole content", async () => {
    const file = path.join(tmp, "erase.txt");
    await writeFile(file, "a\r\nb\r\n");
    const { result } = await run(
      tool(),
      { file_path: "erase.txt", old_string: "a\nb", new_string: "" },
      tmp,
    );
    expect(result?.stopReason).toBeUndefined();
    // old_string covered the two lines' text, not the file's final terminator — that survives,
    // in the file's style.
    expect(await readFile(file, "utf8")).toBe("\r\n");
  });

  it("leaves a file with no line terminators exactly as the caller wrote it", async () => {
    const file = path.join(tmp, "none.txt");
    await writeFile(file, "one line");
    await run(tool(), { file_path: "none.txt", old_string: "one", new_string: "two\nlines" }, tmp);
    // The file had no terminator, so the caller's bytes stand (LF here, not invented as CRLF).
    expect(await readFile(file, "utf8")).toBe("two\nlines line");
  });

  it("writes a mixed file back in its dominant terminator", async () => {
    const file = path.join(tmp, "mixed.txt");
    await writeFile(file, "a\r\nb\r\nc\nd");
    const { result } = await run(
      tool(),
      { file_path: "mixed.txt", old_string: "c", new_string: "x" },
      tmp,
    );
    expect(result?.stopReason).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("a\r\nb\r\nx\r\nd");
  });

  it("reports the file's style when a genuinely-absent old_string misses a CRLF file", async () => {
    await writeFile(path.join(tmp, "crlf.txt"), "alpha\r\nbeta\r\n");
    const { result, text } = await run(
      tool(),
      { file_path: "crlf.txt", old_string: "gamma", new_string: "x" },
      tmp,
    );
    expect(result?.stopReason).toBe("fatal");
    expect(text).toContain("old_string not found");
    expect(text).toContain("CRLF");
  });
});

describe("write_file — preserve-on-overwrite", () => {
  const tool = () => createWriteFileTool(def(WRITE_FILE_NAME, "rw"));

  it("creates a new file in the caller's own style", async () => {
    const file = path.join(tmp, "new.txt");
    await run(tool(), { file_path: "new.txt", content: "one\ntwo\n" }, tmp);
    expect(await readFile(file, "utf8")).toBe("one\ntwo\n");
  });

  it("converts LF content to the overwritten file's CRLF", async () => {
    const file = path.join(tmp, "crlf.txt");
    await writeFile(file, "old\r\ncontent\r\n");
    const { text } = await run(tool(), { file_path: "crlf.txt", content: "new\ncontent\n" }, tmp);
    expect(await readFile(file, "utf8")).toBe("new\r\ncontent\r\n");
    // The reported size describes the bytes actually written.
    expect(text).toContain("bytes)");
  });

  it("keeps an LF file LF when overwriting", async () => {
    const file = path.join(tmp, "lf.txt");
    await writeFile(file, "old\n");
    await run(tool(), { file_path: "lf.txt", content: "new\n" }, tmp);
    expect(await readFile(file, "utf8")).toBe("new\n");
  });

  it("keeps a CR-only file CR when overwriting", async () => {
    const file = path.join(tmp, "cr.txt");
    await writeFile(file, "old\r");
    await run(tool(), { file_path: "cr.txt", content: "new\n" }, tmp);
    expect(await readFile(file, "utf8")).toBe("new\r");
  });

  it("leaves a file with no terminators as the caller wrote it", async () => {
    const file = path.join(tmp, "none.txt");
    await writeFile(file, "old no newline");
    await run(tool(), { file_path: "none.txt", content: "also no newline" }, tmp);
    expect(await readFile(file, "utf8")).toBe("also no newline");
  });

  it("preserves the style of a CRLF file larger than the diff source cap", async () => {
    // A file bigger than DIFF_SOURCE_CAP_BYTES gets no full read-back for the diff; the style
    // is probed from the head instead, so an LF overwrite must still land as CRLF.
    const file = path.join(tmp, "big.txt");
    const bigLine = "x".repeat(64) + "\r\n";
    await writeFile(file, bigLine.repeat(20_000)); // ~1.3 MB, all CRLF
    const { text } = await run(
      tool(),
      { file_path: "big.txt", content: `${"y".repeat(64)}\n`.repeat(3) },
      tmp,
    );
    expect(await readFile(file, "utf8")).toBe(`${"y".repeat(64)}\r\n`.repeat(3));
    expect(text).toContain("Overwrote");
  });

  it("reports a CRLF overwrite as unchanged when only the line endings differed", async () => {
    const file = path.join(tmp, "crlf.txt");
    await writeFile(file, "same\r\ncontent\r\n");
    const { text } = await run(tool(), { file_path: "crlf.txt", content: "same\ncontent\n" }, tmp);
    expect(text).toContain("(content unchanged)");
  });
});

describe("environment_info — the tool", () => {
  const winFacts: Partial<EnvironmentFacts> = {
    platform: "win32",
    env: { SHELL: "/usr/bin/bash", MSYSTEM: "MINGW64" },
    cwd: "D:\\GitHub\\fork",
    home: "C:\\Users\\ACER",
    newline: "\r\n",
    procVersion: null,
  };
  const tool = () => createEnvironmentInfoTool(def(ENVIRONMENT_INFO_NAME, "r"), winFacts);

  it("answers 'what am I running on' with describeEnvironment's summary", async () => {
    const { result, text } = await run(tool(), {}, tmp);
    expect(result?.stopReason).toBeUndefined();
    expect(text).toBe(describeEnvironment(detectHostEnvironment(winFacts)));
    expect(text).toContain("win32");
    expect(text).toContain("MSYS2/Git-Bash");
    expect(text).toContain("CRLF");
  });

  it("resolves a translate_path and names the form it was recognized as", async () => {
    const { result, text } = await run(tool(), { translate_path: "/c/Users/ACER" }, tmp);
    expect(result?.stopReason).toBeUndefined();
    expect(text).toContain("C:\\Users\\ACER");
    expect(text).toContain("/c/Users/ACER");
    expect(text).toContain("msys");
    expect(text).toContain("drive C");
  });

  it("still emits the summary, then fails on a path that names no drive", async () => {
    const { result, text } = await run(tool(), { translate_path: "/tmp/x" }, tmp);
    // The machine's facts come first, so a bad path never costs them.
    expect(text).toContain("win32");
    expect(text).toContain("cannot resolve");
    expect(result?.stopReason).toBe("fatal");
  });

  it("rejects a non-string translate_path by restating its own schema", async () => {
    const { result, text } = await run(tool(), { translate_path: 42 }, tmp);
    expect(result?.stopReason).toBe("fatal");
    expect(text).toContain("environment_info was not run");
    expect(text).toContain("translate_path");
  });

  it("rejects an empty translate_path", async () => {
    const { result, text } = await run(tool(), { translate_path: "   " }, tmp);
    expect(result?.stopReason).toBe("fatal");
    expect(text).toContain("environment_info was not run");
  });

  it("is registered as a builtin tool factory", () => {
    // The registry is the only seam the tool needs to reach the model; the config entry and
    // package exports are wired separately.
    expect(BUILTIN_TOOL_FACTORIES[ENVIRONMENT_INFO_NAME]).toBeDefined();
    const instance = BUILTIN_TOOL_FACTORIES[ENVIRONMENT_INFO_NAME]!({
      name: ENVIRONMENT_INFO_NAME,
      description: "test",
      permission: "r",
    });
    expect(instance.name).toBe(ENVIRONMENT_INFO_NAME);
  });
});
