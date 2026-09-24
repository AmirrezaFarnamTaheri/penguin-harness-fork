import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "../src/i18n.js";
import {
  applyLanguageToRc,
  resolveShellRc,
  restartShell,
  upsertBlock,
} from "../src/lang-config.js";

describe("resolveShellRc", () => {
  // rcPath is built with path.join, so the expectations join too (backslashes on Windows —
  // where the `config lang` command refuses before ever calling this, but the pure function
  // stays coherent).
  it("maps zsh / bash / fish to their startup files and syntax", () => {
    const zsh = resolveShellRc("/bin/zsh", "/home/u");
    expect(zsh.kind).toBe("zsh");
    expect(zsh.rcPath).toBe(join("/home/u", ".zshrc"));
    expect(zsh.body("zh")).toBe("export PENGUIN_LANG=zh");

    const bash = resolveShellRc("/usr/bin/bash", "/home/u");
    expect(bash.kind).toBe("bash");
    expect(bash.rcPath).toBe(join("/home/u", ".bashrc"));

    const fish = resolveShellRc("/usr/local/bin/fish", "/home/u");
    expect(fish.kind).toBe("fish");
    expect(fish.rcPath).toBe(join("/home/u", ".config", "fish", "config.fish"));
    expect(fish.body("en")).toBe("set -gx PENGUIN_LANG en");
  });

  it("falls back to ~/.profile for an unknown shell", () => {
    const rc = resolveShellRc(undefined, "/home/u");
    expect(rc.kind).toBe("unknown");
    expect(rc.rcPath).toBe(join("/home/u", ".profile"));
  });
});

describe("upsertBlock", () => {
  it("appends a marked block when none exists", () => {
    const out = upsertBlock("export PATH=/x\n", "export PENGUIN_LANG=zh");
    expect(out).toContain("export PATH=/x");
    expect(out).toContain("# >>> PenguinHarness PENGUIN_LANG >>>");
    expect(out).toContain("export PENGUIN_LANG=zh");
    expect(out).toContain("# <<< PenguinHarness PENGUIN_LANG <<<");
  });

  it("replaces the block in place and is idempotent", () => {
    const first = upsertBlock("", "export PENGUIN_LANG=zh");
    const second = upsertBlock(first, "export PENGUIN_LANG=en");
    // Only one block remains, with its content replaced by the latest value.
    expect(second.match(/PenguinHarness PENGUIN_LANG/g)?.length).toBe(2); // begin + end markers
    expect(second).toContain("export PENGUIN_LANG=en");
    expect(second).not.toContain("export PENGUIN_LANG=zh");
    // Writing the same value again is stable (the block does not keep growing).
    const third = upsertBlock(second, "export PENGUIN_LANG=en");
    expect(third).toBe(second);
  });

  it("preserves surrounding content when replacing", () => {
    const base = "line1\n" + upsertBlock("", "export PENGUIN_LANG=zh") + "line2\n";
    const out = upsertBlock(base, "export PENGUIN_LANG=en");
    expect(out.startsWith("line1\n")).toBe(true);
    expect(out.endsWith("line2\n")).toBe(true);
    expect(out).toContain("export PENGUIN_LANG=en");
  });
});

describe("applyLanguageToRc", () => {
  let home: string;
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("writes the export line to the resolved startup file", async () => {
    home = await mkdtemp(join(tmpdir(), "penguin-lang-"));
    const { rcPath, kind } = await applyLanguageToRc("zh", { shell: "/bin/zsh", home });
    expect(kind).toBe("zsh");
    expect(rcPath).toBe(join(home, ".zshrc"));
    const content = await readFile(rcPath, "utf8");
    expect(content).toContain("export PENGUIN_LANG=zh");

    // Switching the language again updates the file in place instead of appending.
    await applyLanguageToRc("en", { shell: "/bin/zsh", home });
    const updated = await readFile(rcPath, "utf8");
    expect(updated).toContain("export PENGUIN_LANG=en");
    expect(updated).not.toContain("export PENGUIN_LANG=zh");
    expect(updated.match(/# >>> PenguinHarness/g)?.length).toBe(1);
  });

  it("creates nested config dir for fish", async () => {
    home = await mkdtemp(join(tmpdir(), "penguin-lang-"));
    const { rcPath } = await applyLanguageToRc("en", { shell: "/usr/bin/fish", home });
    expect(rcPath).toBe(join(home, ".config", "fish", "config.fish"));
    const content = await readFile(rcPath, "utf8");
    expect(content).toContain("set -gx PENGUIN_LANG en");
  });
});

describe("restartShell", () => {
  // Pointing $SHELL at a missing binary makes spawn fail; the error path writes to stderr
  // and sets a failing exit code, so both are captured and restored per test.
  let prevShell: string | undefined;
  let prevExitCode: number | string | null | undefined;
  beforeEach(() => {
    prevShell = process.env.SHELL;
    prevExitCode = process.exitCode;
  });
  afterEach(() => {
    if (prevShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = prevShell;
    process.exitCode = prevExitCode;
  });

  it("reports the spawn failure instead of exiting silently", async () => {
    process.env.SHELL = "/nonexistent-penguin-shell-binary";
    const writes: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      restartShell("en", getMessages("en"));
      // The child's 'error' event is delivered asynchronously.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      const out = writes.join("");
      expect(out).toContain("Failed to open a new shell");
      expect(out).toContain("ENOENT"); // the raw spawn error rides along
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
