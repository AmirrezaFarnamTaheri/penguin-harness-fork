/**
 * tool-call-card.tsx preview helpers: previewArguments keeps the real arguments (what heads
 * the approval row), headerSubtitle surfaces the model-written `description` argument for
 * the command/subagent tools and the shortened file path for the file tools, and
 * pendingFilePayload decodes the file-tool arguments so a pending approval shows the actual
 * rewrite. All must tolerate incomplete mid-stream JSON; headerSubtitle additionally holds a
 * still-streaming field back until its closing quote so the header never jitters (#137).
 * isDetachedCall and showsBackgroundAction decide the background mark and the "move to
 * background" button from the same row's facts.
 */
import { describe, expect, it } from "vitest";
import {
  headerSubtitle,
  isBackgroundCall,
  isDetachedCall,
  pendingFilePayload,
  previewArguments,
  shortenPath,
  showsBackgroundAction,
} from "../src/features/chat/tool-call-card";
import { S } from "../src/lib/strings";

describe("previewArguments", () => {
  it("renders exec_command as $ <cmd>", () => {
    expect(previewArguments("exec_command", '{"cmd":"ls -la"}')).toBe("$ ls -la");
    // Mid-stream (incomplete JSON) still extracts the cmd prefix.
    expect(previewArguments("exec_command", '{"cmd":"echo h')).toBe("$ echo h");
  });

  it("previews exec_command's shell text under the `command` alias core also runs", () => {
    expect(previewArguments("exec_command", '{"command":"ls -la"}')).toBe("$ ls -la");
    // `cmd` is what runs when both are present, so it is what the approval row shows.
    expect(previewArguments("exec_command", '{"cmd":"pwd","command":"ls"}')).toBe("$ pwd");
  });

  it("renders the file tools by their shortened file_path", () => {
    expect(previewArguments("read_file", '{"file_path":"src/app.py","offset":3}')).toBe(
      "src/app.py",
    );
    expect(
      previewArguments("edit_file", '{"file_path":"a.txt","old_string":"x","new_string":"y"}'),
    ).toBe("a.txt");
    expect(previewArguments("write_file", '{"file_path":"packages/core/src/state/out.ts"}')).toBe(
      "…/state/out.ts",
    );
  });

  it("keeps the real command even when a description argument is present (approval fidelity)", () => {
    expect(
      previewArguments("exec_command", '{"cmd":"rm -rf build","description":"Clean caches"}'),
    ).toBe("$ rm -rf build");
  });

  it("previews the historical image tools by their source argument (old Traces)", () => {
    expect(previewArguments("read_image", '{"source":"shots/home.png"}')).toBe("shots/home.png");
    expect(
      previewArguments("describe_image", '{"source":"https://x.test/a/b/c.png","prompt":"?"}'),
    ).toBe("…/b/c.png");
    expect(headerSubtitle("read_image", '{"source":"shots/home.png"}')).toBe("shots/home.png");
  });

  it("falls back to the single-line raw arguments for other tools", () => {
    expect(previewArguments("search", '{"q": "a\n b"}')).toBe('{"q": "a b"}');
  });
});

describe("shortenPath", () => {
  it("keeps at most one parent directory plus the filename", () => {
    expect(shortenPath("file.ts")).toBe("file.ts");
    expect(shortenPath("src/file.ts")).toBe("src/file.ts");
    expect(shortenPath("/etc/hosts")).toBe("/etc/hosts");
    expect(shortenPath("packages/core/src/state/default-config.ts")).toBe(
      "…/state/default-config.ts",
    );
  });
});

describe("headerSubtitle", () => {
  it("shows the description for the command/subagent tools when present", () => {
    expect(
      headerSubtitle("exec_command", '{"cmd":"ls","description":"List workspace files"}'),
    ).toBe("List workspace files");
    expect(
      headerSubtitle("run_subagent", '{"prompt":"p","description":"Delegating research"}'),
    ).toBe("Delegating research");
    expect(
      headerSubtitle("input_command", '{"process_id":"proc-1","description":"Poll the build"}'),
    ).toBe("Poll the build");
    expect(
      headerSubtitle("input_subagent", '{"subagent_id":"s-1","description":"Follow up"}'),
    ).toBe("Follow up");
  });

  it("shows what a web search was for, and the query when it has no narration", () => {
    // web_search's schema marks `description` REQUIRED and says in its own parameter text that it
    // "is shown to the user while the call runs". The card did not list it, so the model was
    // obliged to write a sentence that was thrown away — and a search has no path argument
    // either, leaving the row a bare `web_search` with neither the narration nor the query.
    expect(
      headerSubtitle(
        "web_search",
        '{"description":"checking the release schedule","query":"node release"}',
      ),
    ).toBe("checking the release schedule");
    // No description at all: the query is what the call actually DID, so the row still says it.
    expect(headerSubtitle("web_search", '{"query":"node release schedule"}')).toBe(
      "node release schedule",
    );
  });

  it("falls back to the command that ran when a described tool sends no narration", () => {
    // A blank row tells the reader nothing about what their agent just did.
    expect(headerSubtitle("exec_command", '{"cmd":"pnpm test --filter core"}')).toBe(
      "pnpm test --filter core",
    );
    // The narration still wins when both are present — it is the model's account of the call.
    expect(headerSubtitle("exec_command", '{"cmd":"ls","description":"listing the root"}')).toBe(
      "listing the root",
    );
  });

  it("holds a row's subtitle back while its narration is still streaming", () => {
    // Partial JSON must not flash half a sentence.
    expect(headerSubtitle("web_search", '{"description":"checking the', false)).toBeNull();
  });

  it("falls back to the real command rather than showing a blank row (approval path is separate)", () => {
    // This used to assert null, on the reasoning that a tool whose schema does not ask for a
    // description has nothing to narrate. It does: the command is the call. A collapsed row
    // reading only "exec_command" tells the reader nothing about what their agent just ran.
    //
    // Deliberately `headerSubtitle` — the COLLAPSED row — and not `previewArguments`, the
    // approval row. Approval fidelity is a safety property and is unchanged: the approver always
    // sees the real command, never the model's account of it.
    expect(headerSubtitle("exec_command", '{"cmd":"ls"}')).toBe("ls");
    // An empty description falls through to the same thing, rather than rendering nothing.
    expect(headerSubtitle("exec_command", '{"cmd":"ls","description":""}')).toBe("ls");
    // A tool with neither a narration nor a semantic target still has nothing to say, which is
    // the honest outcome and is why the fallback is a per-tool table rather than a generic one.
    expect(headerSubtitle("input_subagent", '{"subagent_id":"s-1"}')).toBeNull();
  });

  it("shows the shortened file path for the file tools and nothing for others", () => {
    expect(headerSubtitle("read_file", '{"file_path":"src/app.py"}')).toBe("src/app.py");
    expect(headerSubtitle("edit_file", '{"file_path":"packages/web/src/a.tsx"}')).toBe(
      "…/src/a.tsx",
    );
    expect(headerSubtitle("write_file", '{"file_path":"out.md"}')).toBe("out.md");
    expect(headerSubtitle("search", '{"q":"x"}')).toBeNull();
  });

  it("folds a multi-line description to one line", () => {
    expect(headerSubtitle("exec_command", '{"cmd":"ls","description":"one\\ntwo"}')).toBe(
      "one two",
    );
  });

  it("holds a still-streaming description back until its closing quote (#137)", () => {
    expect(headerSubtitle("exec_command", '{"description":"Read the con', false)).toBeNull();
    // Closing quote arrived: renders even though later arguments are still streaming.
    expect(
      headerSubtitle("exec_command", '{"description":"Read the config","cmd":"cat co', false),
    ).toBe("Read the config");
  });

  it("holds a still-streaming file path back (shortenPath would rewrite non-monotonically)", () => {
    expect(headerSubtitle("read_file", '{"file_path":"/home/us', false)).toBeNull();
    expect(headerSubtitle("write_file", '{"file_path":"/a/b/c.txt","content":"xx', false)).toBe(
      "…/b/c.txt",
    );
  });

  it("renders whatever is there once the arguments settled, even unterminated (aborted call)", () => {
    expect(headerSubtitle("exec_command", '{"description":"half', true)).toBe("half");
    expect(headerSubtitle("read_file", '{"file_path":"/a/b/c.txt', true)).toBe("…/b/c.txt");
  });

  it("prefers a complete description over the file path when a file tool carries one (user-enabled schema)", () => {
    expect(
      headerSubtitle("read_file", '{"description":"Check the config","file_path":"/a/b/c.ts"}'),
    ).toBe("Check the config");
    // Description still streaming: nothing renders yet — no path-then-description swap.
    expect(headerSubtitle("read_file", '{"description":"Check the co', false)).toBeNull();
    // Empty description falls back to the path.
    expect(headerSubtitle("read_file", '{"description":"","file_path":"/a/b/c.ts"}')).toBe(
      "…/b/c.ts",
    );
  });
});

describe("pendingFilePayload", () => {
  it("decodes the edit_file rewrite so the approval block shows it", () => {
    const payload = pendingFilePayload(
      "edit_file",
      JSON.stringify({ file_path: "src/app.py", old_string: "a\nb", new_string: "a\nc" }),
    );
    expect(payload).toBe("file_path: src/app.py\nold_string:\na\nb\nnew_string:\na\nc");
  });

  it("decodes write_file content and read_file window arguments", () => {
    expect(pendingFilePayload("write_file", '{"file_path":"out.md","content":"hello"}')).toBe(
      "file_path: out.md\ncontent: hello",
    );
    expect(pendingFilePayload("read_file", '{"file_path":"a.txt","offset":3,"limit":5}')).toBe(
      "file_path: a.txt\noffset: 3\nlimit: 5",
    );
    // read_file's image branch forwards `prompt` to the vision model: it must be visible too.
    expect(
      pendingFilePayload("read_file", '{"file_path":"shot.png","prompt":"read the error"}'),
    ).toBe("file_path: shot.png\nprompt: read the error");
  });

  it("returns null for non-file tools and incomplete JSON", () => {
    expect(pendingFilePayload("exec_command", '{"cmd":"ls"}')).toBeNull();
    expect(pendingFilePayload("edit_file", '{"file_path":"a.txt","old_str')).toBeNull();
  });
});

describe("isBackgroundCall", () => {
  it("marks exec_command and run_subagent launched with the flag", () => {
    expect(isBackgroundCall('{"cmd":"pnpm dev","run_in_background":true}')).toBe(true);
    expect(isBackgroundCall('{"prompt":"go","run_in_background":true}')).toBe(true);
  });

  it("leaves an ordinary call unmarked, flag absent or false", () => {
    expect(isBackgroundCall('{"cmd":"ls"}')).toBe(false);
    expect(isBackgroundCall('{"cmd":"ls","run_in_background":false}')).toBe(false);
    // Only the real boolean counts: a string "true" is not the argument the tool acts on.
    expect(isBackgroundCall('{"cmd":"ls","run_in_background":"true"}')).toBe(false);
  });

  it("reads nothing from a mid-stream or malformed argument string", () => {
    // The flag is last in both schemas, so a still-growing call has not shown it yet — and a
    // command that merely mentions it is not one that was launched with it.
    expect(isBackgroundCall('{"cmd":"pnpm dev","run_in_background":tr')).toBe(false);
    expect(isBackgroundCall('{"cmd":"grep run_in_background\\": true src"}')).toBe(false);
    expect(isBackgroundCall("")).toBe(false);
  });
});

describe("isDetachedCall", () => {
  it("marks a call whose output carries the note the tool wrote on being moved to the background", () => {
    expect(
      isDetachedCall(
        "building…\n[moved to the background by the user with process_id proc-12ab34cd; its " +
          "completion will arrive as a user message — no need to poll.]",
      ),
    ).toBe(true);
  });

  it("leaves an ordinary or deadline-promoted call unmarked", () => {
    expect(isDetachedCall("done\n[exit code: 0]")).toBe(false);
    // The yield deadline promotes too, but nobody moved that one — it wears no mark today.
    expect(
      isDetachedCall("[process running with process_id proc-12ab34cd; use input_command …]"),
    ).toBe(false);
    expect(isDetachedCall("")).toBe(false);
  });
});

describe("showsBackgroundAction", () => {
  const EXEC = '{"cmd":"pnpm dev"}';

  it("offers the action while the two detachable tools execute on a main-session card", () => {
    expect(showsBackgroundAction("exec_command", EXEC, true, [])).toBe(true);
    expect(showsBackgroundAction("run_subagent", '{"prompt":"go"}', true, [])).toBe(true);
  });

  it("hides it once the call is no longer executing", () => {
    expect(showsBackgroundAction("exec_command", EXEC, false, [])).toBe(false);
  });

  it("hides it for tools with no background form", () => {
    expect(showsBackgroundAction("read_file", '{"file_path":"a.txt"}', true, [])).toBe(false);
    expect(showsBackgroundAction("input_command", '{"process_id":"proc-1"}', true, [])).toBe(false);
    expect(showsBackgroundAction("mcp__docs__search", "{}", true, [])).toBe(false);
  });

  it("hides it on a subagent-nested card: that call lives in the child Session's environment", () => {
    expect(showsBackgroundAction("exec_command", EXEC, true, ["session-child-12ab34cd"])).toBe(
      false,
    );
  });

  it("hides it on a call already launched with run_in_background: nothing left to hand over", () => {
    expect(
      showsBackgroundAction(
        "exec_command",
        '{"cmd":"pnpm dev","run_in_background":true}',
        true,
        [],
      ),
    ).toBe(false);
  });
});

describe("the tool row's background marker", () => {
  it("marks one call rather than a count of one", () => {
    // The row marks a single call whose work went to the background; "1 background task"
    // would be a count the row is not making, and would read as the conversation's total.
    expect(S.chat.backgroundCall).not.toBe(S.chat.backgroundTasks(1));
    expect(S.chat.backgroundCall).not.toMatch(/\d/);
  });
});
