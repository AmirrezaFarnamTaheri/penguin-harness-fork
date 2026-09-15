/**
 * slash-token.ts unit tests: positional slash matching (any caret position, whitespace
 * boundary, no URL/path false positives) and token removal on command run.
 */
import { describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  matchSlash,
  removeSlashToken,
} from "../src/features/chat/slash-token";

describe("matchSlash", () => {
  it("matches at the start of the text", () => {
    expect(matchSlash("/comp", 5)).toEqual({ start: 0, end: 5, query: "comp" });
  });

  it("matches mid-text after whitespace, with the token extending past the caret", () => {
    // caret in the middle of "/compact" (after "/com")
    expect(matchSlash("please /compact now", 11)).toEqual({ start: 7, end: 15, query: "com" });
  });

  it("does not treat paths or URLs as commands (no whitespace before the slash)", () => {
    expect(matchSlash("see a/b", 7)).toBeNull();
    expect(matchSlash("https://x", 9)).toBeNull();
  });

  it("stops matching once non-command characters follow the slash", () => {
    expect(matchSlash("/comp act", 9)).toBeNull(); // caret after the space: query has a space
    expect(matchSlash("/comp act", 5)).toEqual({ start: 0, end: 5, query: "comp" });
  });
});

describe("removeSlashToken", () => {
  it("removes just the token and keeps the rest of the text", () => {
    const m = matchSlash("please /compact now", 11)!;
    expect(removeSlashToken("please /compact now", m)).toBe("please now");
  });

  it("clears a token-only input to empty", () => {
    const m = matchSlash("/compact", 8)!;
    expect(removeSlashToken("/compact", m)).toBe("");
    // Whitespace-only leftovers count as empty too.
    expect(removeSlashToken("  /compact", matchSlash("  /compact", 10)!)).toBe("");
  });

  it("keeps multi-space runs elsewhere in the body verbatim", () => {
    const text = "a  b /compact";
    expect(removeSlashToken(text, matchSlash(text, text.length)!)).toBe("a  b ");
  });

  it("keeps indentation of a multi-line body verbatim", () => {
    const text = "steps:\n  - one\n    - nested\n/compact";
    expect(removeSlashToken(text, matchSlash(text, text.length)!)).toBe(
      "steps:\n  - one\n    - nested\n",
    );
  });
});

describe("filterSlashCommands", () => {
  const commands = [
    { cmd: "/compact", desc: "Compress context" },
    { cmd: "/goal", desc: "Goal mode" },
    { cmd: "/model", desc: "Switch model" },
    { cmd: "/agent", desc: "Handoff to agent" },
    { cmd: "/skills", desc: "Skills selection" },
    {
      cmd: "/ai-research-skills-creative-thinking-for-research",
      desc: "Brainstorm research ideas",
    },
    { cmd: "/penguin-sdk", desc: "Develop with SDK" },
  ];

  it("returns all commands when query is empty", () => {
    expect(filterSlashCommands(commands, "")).toEqual(commands);
    expect(filterSlashCommands(commands, "   ")).toEqual(commands);
  });

  it("matches exact command with highest priority", () => {
    const res = filterSlashCommands(commands, "skills");
    expect(res[0]?.cmd).toBe("/skills");
  });

  it("matches prefix commands", () => {
    const res = filterSlashCommands(commands, "com");
    expect(res[0]?.cmd).toBe("/compact");
  });

  it("matches word boundary in long skill commands (e.g. creative inside skill name)", () => {
    const res = filterSlashCommands(commands, "creative");
    expect(res.map((c) => c.cmd)).toContain("/ai-research-skills-creative-thinking-for-research");
  });

  it("matches substring in command name", () => {
    const res = filterSlashCommands(commands, "sdk");
    expect(res.map((c) => c.cmd)).toEqual(["/penguin-sdk"]);
  });

  it("matches terms in description", () => {
    const res = filterSlashCommands(commands, "compress");
    expect(res.map((c) => c.cmd)).toEqual(["/compact"]);
  });

  it("handles leading slashes in query", () => {
    const res = filterSlashCommands(commands, "/goal");
    expect(res[0]?.cmd).toBe("/goal");
  });
});
