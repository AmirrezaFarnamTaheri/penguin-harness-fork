import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { isSafeSpawnPath, spawnCommandProcess } from "../src/environment/tools/command/spawn.js";

describe("command process spawn boundary", () => {
  it("accepts quoted-by-argv Windows paths with spaces and both separators", () => {
    expect(isSafeSpawnPath("C:\\Program Files (x86)\\Git\\bin\\bash.exe")).toBe(true);
    expect(isSafeSpawnPath("C:/Program Files/Git/bin/bash.exe")).toBe(true);
    expect(isSafeSpawnPath("/usr/local/bin/bash")).toBe(true);
  });

  it("refuses shell metacharacters and control characters in the executable path", () => {
    for (const unsafe of [
      "C:\\tools\\bash.exe;whoami",
      "C:\\tools\\bash.exe&whoami",
      'C:\\tools\\"bash.exe',
      "C:\\tools\\bash.exe`whoami",
      "C:\\tools\\bash.exe\nwhoami",
    ]) {
      expect(isSafeSpawnPath(unsafe), unsafe).toBe(false);
    }
  });

  it("rejects before calling spawn and sets windowsHide on accepted launches", () => {
    const child = {} as ChildProcess;
    const spawn = vi.fn(() => child);
    const options = {
      cwd: "C:\\workspace",
      env: {},
      detached: false,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    };

    expect(() =>
      spawnCommandProcess("C:\\tools\\bash.exe;whoami", ["-lc", "echo safe"], options, spawn),
    ).toThrow(/unsafe characters/);
    expect(spawn).not.toHaveBeenCalled();
    const attemptedOverride = { ...options, shell: true, windowsHide: false };

    expect(
      spawnCommandProcess(
        "C:\\Program Files\\Git\\bin\\bash.exe",
        ["-lc", "echo safe"],
        attemptedOverride,
        spawn,
      ),
    ).toBe(child);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Program Files\\Git\\bin\\bash.exe",
      ["-lc", "echo safe"],
      { ...options, windowsHide: true, shell: false },
    );
  });
});
