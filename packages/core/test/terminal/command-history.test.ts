import { describe, expect, it } from "vitest";
import {
  CommandHistory,
  currentWord,
  emptyCursor,
  expandHistoryRef,
  suggestCompletions,
} from "../../src/terminal/command-history";

describe("command history", () => {
  it("pushes, deduplicates and trims", () => {
    const history = new CommandHistory();
    expect(history.length).toBe(0);
    expect(history.last).toBeNull();
    history.push("  ls -la  ");
    // Whitespace is trimmed on entry.
    expect(history.last!.command).toBe("ls -la");
    history.push("ls -la");
    // An exact repeat of the most recent entry does not refill the history.
    expect(history.length).toBe(1);
    history.push("git status");
    expect(history.length).toBe(2);
    // Blank commands are ignored.
    history.push("   ");
    expect(history.length).toBe(2);
  });

  it("deduplicates case-insensitively when asked", () => {
    const sensitive = new CommandHistory({ caseSensitiveDedupe: true });
    sensitive.push("ls");
    sensitive.push("LS");
    expect(sensitive.length).toBe(2);
    const insensitive = new CommandHistory({ caseSensitiveDedupe: false });
    insensitive.push("ls");
    insensitive.push("LS");
    expect(insensitive.length).toBe(1);
  });

  it("evicts the oldest entry past capacity", () => {
    const history = new CommandHistory({ capacity: 3 });
    for (let i = 0; i < 5; i++) history.push(`cmd ${i}`);
    expect(history.length).toBe(3);
    expect(history.commands()).toEqual(["cmd 2", "cmd 3", "cmd 4"]);
  });

  it("searches by prefix, substring and directory", () => {
    const history = new CommandHistory();
    history.push("git status", 100, 0, "/repo");
    history.push("git log", 200, 0, "/repo");
    history.push("npm test", 300, 0, "/other");
    history.push("git branch", 400, 0, "/repo");
    // Prefix matches come back newest first.
    expect(history.prefixSearch("git").map((e) => e.command)).toEqual([
      "git branch",
      "git log",
      "git status",
    ]);
    expect(history.prefixSearch("GIT")).toEqual(history.prefixSearch("git"));
    expect(history.prefixSearch("")).toEqual([]);
    // Substring search is the reverse-i-search behaviour.
    expect(history.substringSearch("status").map((e) => e.command)).toEqual(["git status"]);
    expect(history.substringSearch("te").map((e) => e.command)).toEqual(["npm test"]);
    // Directory filter.
    expect(history.forDirectory("/repo")).toHaveLength(3);
    expect(history.forDirectory("/other")).toHaveLength(1);
    expect(history.forDirectory("/nowhere")).toHaveLength(0);
  });

  it("collects failures", () => {
    const history = new CommandHistory();
    history.push("ok", 100, 0);
    history.push("boom", 200, 1);
    history.push("interrupted", 300, 130);
    expect(history.failures().map((e) => e.command)).toEqual(["boom"]);
  });

  it("walks the history cursor back and forward", () => {
    const history = new CommandHistory();
    history.push("one");
    history.push("two");
    history.push("three");
    // From the end, walking back visits newest-first.
    expect(history.navigate(emptyCursor())).toMatchObject({ index: 2, command: "three" });
    let cursor = emptyCursor();
    cursor = history.navigate(cursor);
    expect(cursor.command).toBe("three");
    cursor = history.navigate(cursor);
    expect(cursor.command).toBe("two");
    cursor = history.navigate(cursor);
    expect(cursor.command).toBe("one");
    // Past the oldest entry the cursor clears.
    cursor = history.navigate(cursor);
    expect(cursor).toEqual(emptyCursor());
    // And walking forward returns the entries again.
    cursor = history.navigateForward(cursor);
    expect(cursor.command).toBe("one");
    cursor = history.navigateForward(cursor);
    expect(cursor.command).toBe("two");
    cursor = history.navigateForward(cursor);
    expect(cursor.command).toBe("three");
    cursor = history.navigateForward(cursor);
    expect(cursor).toEqual(emptyCursor());
  });

  it("navigates with a prefix filter", () => {
    const history = new CommandHistory();
    history.push("git status");
    history.push("npm test");
    history.push("git log");
    let cursor = emptyCursor();
    cursor = history.navigate(cursor, "git");
    expect(cursor.command).toBe("git log");
    cursor = history.navigate(cursor, "git");
    expect(cursor.command).toBe("git status");
    cursor = history.navigate(cursor, "git");
    expect(cursor).toEqual(emptyCursor());
    // Forward navigation honours the same prefix, from the oldest match.
    cursor = history.navigate(emptyCursor(), "git");
    cursor = history.navigate(cursor, "git");
    expect(cursor.command).toBe("git status");
    cursor = history.navigateForward(cursor, "git");
    expect(cursor.command).toBe("git log");
  });

  it("clears and restores the persisted list", () => {
    const history = new CommandHistory();
    history.push("one");
    history.push("two");
    expect(history.serialize()).toEqual(["one", "two"]);
    history.clear();
    expect(history.length).toBe(0);
    // Restore stamps descending timestamps so the oldest entry is oldest.
    history.restore(["alpha", "beta"], 10_000);
    expect(history.commands()).toEqual(["alpha", "beta"]);
    expect(history.entries[0]!.timestamp).toBe(8000);
    expect(history.entries[1]!.timestamp).toBe(9000);
    // Blank entries in a persisted list are dropped.
    history.restore(["one", "  ", "two"]);
    expect(history.commands()).toEqual(["one", "two"]);
  });

  it("extracts the word at the cursor, honouring quotes", () => {
    expect(currentWord("git sta")).toBe("sta");
    expect(currentWord("git")).toBe("git");
    expect(currentWord("")).toBe("");
    // Unquoted whitespace starts a new word.
    expect(currentWord("echo hello wor")).toBe("wor");
    // Quoted spaces are part of the word.
    expect(currentWord('echo "hello wor')).toBe('"hello wor');
    expect(currentWord("git commit -m 'fix")).toBe("'fix");
    expect(currentWord("git 'a b' ")).toBe("");
  });

  it("suggests completions from the history", () => {
    const history = new CommandHistory();
    history.push("git status");
    history.push("git log");
    history.push("git log --oneline");
    history.push("npm test");
    // Distinct history commands that extend the current word, newest first.
    expect(suggestCompletions(history, "git")).toEqual([
      "git log --oneline",
      "git log",
      "git status",
    ]);
    expect(suggestCompletions(history, "gi")).toHaveLength(3);
    expect(suggestCompletions(history, "npm")).toEqual(["npm test"]);
    // A word boundary with nothing after it offers nothing.
    expect(suggestCompletions(history, "git ")).toEqual([]);
    expect(suggestCompletions(history, "")).toEqual([]);
    expect(suggestCompletions(history, "zzz")).toEqual([]);
  });

  it("expands bang history references", () => {
    const history = new CommandHistory();
    expect(expandHistoryRef(history, "ls")).toBe("ls");
    history.push("git status");
    history.push("git commit -m fix");
    // `!!` is the previous command.
    expect(expandHistoryRef(history, "sudo !!")).toBe("sudo git commit -m fix");
    // `!$` is the last word of the previous command.
    expect(expandHistoryRef(history, "echo !$")).toBe("echo fix");
    // `!n` is the nth entry, `!-n` counts back from the end.
    expect(expandHistoryRef(history, "!1")).toBe("git status");
    expect(expandHistoryRef(history, "!-1")).toBe("git commit -m fix");
    // `!prefix` is the most recent command starting with the prefix.
    expect(expandHistoryRef(history, "!st")).toBe("git status");
    // Unresolvable references are left alone.
    expect(expandHistoryRef(history, "!nope")).toBe("!nope");
    expect(expandHistoryRef(history, "!99")).toBe("!99");
  });
});
