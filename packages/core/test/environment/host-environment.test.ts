/**
 * Unit tests for host-environment.ts — platform/shell-layer detection and lexical path
 * translation. Every machine here is a constructed set of facts, so a Windows-native agent,
 * a WSL agent and a Linux agent are all testable from any CI runner; translatePath is pure,
 * which is what makes the "must not silently mean D:\tmp" property provable.
 */
import { describe, expect, it } from "vitest";
import {
  PathTranslationError,
  describeEnvironment,
  detectHostEnvironment,
  translatePath,
} from "../../src/environment/tools/host-environment.js";
import type {
  EnvironmentFacts,
  HostEnvironment,
} from "../../src/environment/tools/host-environment.js";

/** A machine described from scratch, with every fact the module reads supplied or defaulted. */
function machine(partial: Partial<EnvironmentFacts> = {}): HostEnvironment {
  return detectHostEnvironment({
    platform: "win32",
    env: {},
    cwd: "D:\\GitHub\\fork",
    home: "C:\\Users\\ACER",
    newline: "\r\n",
    procVersion: null,
    ...partial,
  });
}

/** The facts of a WSL Ubuntu session, as /proc/version and the environment report them. */
const WSL_FACTS: Partial<EnvironmentFacts> = {
  platform: "linux",
  procVersion: "Linux version 5.15.153.1-microsoft-standard-WSL2 (root@xxx) (gcc 12) #1 SMP",
  env: { WSL_DISTRO_NAME: "Ubuntu", SHELL: "/bin/bash", USER: "acer" },
  cwd: "/home/acer",
  home: "/home/acer",
  newline: "\n",
};

describe("host-environment — detection", () => {
  it("reports a native Windows machine, including through a Git-Bash shell layer", () => {
    const env = machine({
      env: { MSYSTEM: "MINGW64", SHELL: "C:\\Program Files\\Git\\usr\\bin\\bash.exe" },
    });
    expect(env).toMatchObject({
      platform: "win32",
      isWsl: false,
      isMsys: true,
      isCygwin: false,
      pathStyle: "win32",
      newline: "\r\n",
      wslDistro: null,
    });
    expect(env.shell).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  });

  it("detects WSL from /proc/version naming a microsoft kernel", () => {
    const env = machine(WSL_FACTS);
    expect(env.platform).toBe("linux");
    expect(env.isWsl).toBe(true);
    expect(env.wslDistro).toBe("Ubuntu");
    expect(env.pathStyle).toBe("posix");
  });

  it("detects WSL from WSL_DISTRO_NAME even when /proc/version is unreadable", () => {
    const env = machine({ ...WSL_FACTS, procVersion: null, env: { WSL_DISTRO_NAME: "Debian" } });
    expect(env.isWsl).toBe(true);
    expect(env.wslDistro).toBe("Debian");
  });

  it("does not call a plain Linux box WSL: no microsoft kernel and no distro name", () => {
    const env = machine({
      platform: "linux",
      procVersion: "Linux version 6.8.0-45-generic (buildd@lcy02) (gcc 13) #1 SMP",
      env: { SHELL: "/bin/bash" },
      cwd: "/home/acer",
      home: "/home/acer",
      newline: "\n",
    });
    expect(env.isWsl).toBe(false);
    expect(env.wslDistro).toBe(null);
    expect(env.pathStyle).toBe("posix");
  });

  it("does not call a macOS box WSL either", () => {
    const env = machine({
      platform: "darwin",
      procVersion: null,
      env: { SHELL: "/bin/zsh" },
      cwd: "/Users/acer",
      home: "/Users/acer",
      newline: "\n",
    });
    expect(env.isWsl).toBe(false);
    expect(env.platform).toBe("darwin");
  });

  it("detects Cygwin by OSTYPE and falls back to ComSpec when SHELL is unset", () => {
    const env = machine({ env: { OSTYPE: "cygwin", ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
    expect(env.isCygwin).toBe(true);
    expect(env.isMsys).toBe(false);
    expect(env.shell).toBe("C:\\Windows\\system32\\cmd.exe");
  });

  it("reports no shell when neither SHELL nor ComSpec is set", () => {
    expect(machine({ env: {} }).shell).toBe(null);
  });

  it("narrows an unknown platform value to linux rather than passing it through", () => {
    expect(machine({ platform: "freebsd" }).platform).toBe("linux");
  });
});

describe("host-environment — path translation on a Windows kernel", () => {
  const win = machine();

  it("reads Windows-native paths with either separator, uppercasing the drive", () => {
    expect(translatePath("C:\\Users\\x", win)).toEqual({
      input: "C:\\Users\\x",
      form: "windows-native",
      drive: "C",
      native: "C:\\Users\\x",
      posix: "/c/Users/x",
    });
    expect(translatePath("C:/Users/x", win)).toMatchObject({
      form: "windows-native",
      drive: "C",
      native: "C:\\Users\\x",
      posix: "/c/Users/x",
    });
    // A lowercase drive letter is reported uppercase; the path's own case is kept.
    expect(translatePath("d:\\GitHub\\fork", win)).toMatchObject({
      drive: "D",
      native: "D:\\GitHub\\fork",
    });
    // A bare drive letter means that drive's root.
    expect(translatePath("C:", win)).toMatchObject({ drive: "C", native: "C:\\", posix: "/c" });
  });

  it("reads the Git-Bash/MSYS drive form /c/Users/x", () => {
    expect(translatePath("/c/Users/x", win)).toEqual({
      input: "/c/Users/x",
      form: "msys",
      drive: "C",
      native: "C:\\Users\\x",
      posix: "/c/Users/x",
    });
    expect(translatePath("/d/GitHub/fork", win)).toMatchObject({ form: "msys", drive: "D" });
    expect(translatePath("/c", win)).toMatchObject({ drive: "C", native: "C:\\", posix: "/c" });
  });

  it("reads the WSL form /mnt/c/Users/x and the Cygwin form /cygdrive/c/Users/x", () => {
    expect(translatePath("/mnt/c/Users/x", win)).toMatchObject({
      form: "wsl",
      drive: "C",
      native: "C:\\Users\\x",
    });
    expect(translatePath("/cygdrive/c/Users/x", win)).toMatchObject({
      form: "cygdrive",
      drive: "C",
      native: "C:\\Users\\x",
    });
  });

  it("reads UNC shares in either separator style", () => {
    expect(translatePath("\\\\server\\share\\x", win)).toEqual({
      input: "\\\\server\\share\\x",
      form: "unc",
      drive: null,
      native: "\\\\server\\share\\x",
      posix: "//server/share/x",
    });
    expect(translatePath("//server/share/x", win)).toMatchObject({
      form: "unc",
      native: "\\\\server\\share\\x",
      posix: "//server/share/x",
    });
  });

  it("expands ~ against the home directory", () => {
    expect(translatePath("~", win)).toMatchObject({
      form: "home",
      native: "C:\\Users\\ACER",
      posix: "/c/Users/ACER",
    });
    expect(translatePath("~/docs/x", win)).toMatchObject({
      native: "C:\\Users\\ACER\\docs\\x",
      posix: "/c/Users/ACER/docs/x",
    });
  });

  it("resolves relative paths against the working directory, collapsing ..", () => {
    expect(translatePath("src/app.ts", win)).toMatchObject({
      form: "relative",
      native: "D:\\GitHub\\fork\\src\\app.ts",
      posix: "/d/GitHub/fork/src/app.ts",
    });
    expect(translatePath("../x", win).native).toBe("D:\\GitHub\\x");
    expect(translatePath("src\\app.ts", win).native).toBe("D:\\GitHub\\fork\\src\\app.ts");
  });

  it("round-trips: translating the posix twin lands back on the same native path", () => {
    for (const input of [
      "C:\\Users\\x",
      "C:/Users/x",
      "/c/Users/x",
      "/d/GitHub/fork",
      "/mnt/c/Users/x",
      "/cygdrive/d/data",
      "~/docs",
      "src/app.ts",
      "\\\\server\\share\\x",
    ]) {
      const first = translatePath(input, win);
      const back = translatePath(first.posix, win);
      expect(back.native).toBe(first.native);
    }
  });

  it("trims whitespace around the input", () => {
    expect(translatePath("  /c/Users/x  ", win).native).toBe("C:\\Users\\x");
  });

  it("refuses an empty input instead of resolving it to the working directory", () => {
    expect(() => translatePath("", win)).toThrow(PathTranslationError);
    expect(() => translatePath("   ", win)).toThrow(PathTranslationError);
  });

  it("does NOT silently turn /tmp/x into D:\\tmp\\x on a Windows kernel", () => {
    // This is the bug the module exists for: a bare POSIX path is read against the current
    // drive, so the same string means a different file depending on where the process started.
    let message = "";
    expect(() => {
      try {
        translatePath("/tmp/x.mjs", win);
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    }).toThrow(PathTranslationError);
    expect(message).toContain("/tmp/x.mjs");
    expect(message).toContain("no drive letter");
    // The examples use the process's own drive — the same one the string would silently have
    // meant — and offer both Windows separators plus the shell and WSL spellings.
    expect(message).toContain("D:\\tmp\\x.mjs");
    expect(message).toContain("D:/tmp/x.mjs");
    expect(message).toContain("/d/tmp/x.mjs");
    expect(message).toContain("/mnt/d/tmp/x.mjs");
  });

  it("refuses other drive-less POSIX paths the same way (/usr/bin, /etc)", () => {
    expect(() => translatePath("/usr/bin/env", win)).toThrow(PathTranslationError);
    expect(() => translatePath("/etc/hosts", win)).toThrow(PathTranslationError);
  });

  it("refuses a drive-relative path (C:foo), which depends on the drive's current directory", () => {
    expect(() => translatePath("C:foo\\bar", win)).toThrow(PathTranslationError);
    try {
      translatePath("C:foo\\bar", win);
    } catch (e) {
      expect((e as Error).message).toContain("drive-relative");
    }
  });
});

describe("host-environment — path translation on a POSIX kernel", () => {
  const linux = machine({
    platform: "linux",
    procVersion: "Linux version 6.8.0-45-generic (gcc 13) #1 SMP",
    env: { SHELL: "/bin/bash" },
    cwd: "/home/acer/project",
    home: "/home/acer",
    newline: "\n",
  });
  const wsl = machine(WSL_FACTS);

  it("reads POSIX absolute paths as native, including the WSL mount of a Windows drive", () => {
    expect(translatePath("/usr/bin/env", linux)).toEqual({
      input: "/usr/bin/env",
      form: "posix-native",
      drive: null,
      native: "/usr/bin/env",
      posix: "/usr/bin/env",
    });
    expect(translatePath("/mnt/c/Users/x", wsl)).toMatchObject({
      form: "posix-native",
      native: "/mnt/c/Users/x",
    });
    // A single-letter first segment is a real directory here, not a drive form.
    expect(translatePath("/c/Users/x", linux)).toMatchObject({
      form: "posix-native",
      native: "/c/Users/x",
    });
  });

  it("translates a Windows-native path to its POSIX mount form", () => {
    expect(translatePath("C:\\Users\\x", wsl)).toEqual({
      input: "C:\\Users\\x",
      form: "windows-native",
      drive: "C",
      native: "/mnt/c/Users/x",
      posix: "/mnt/c/Users/x",
    });
    expect(translatePath("D:/data/f", wsl).native).toBe("/mnt/d/data/f");
  });

  it("expands ~ and resolves relative paths in the POSIX style", () => {
    expect(translatePath("~/docs/x", linux).native).toBe("/home/acer/docs/x");
    expect(translatePath("src/app.ts", linux).native).toBe("/home/acer/project/src/app.ts");
    expect(translatePath("../x", linux).native).toBe("/home/acer/x");
  });

  it("keeps a double-leading-slash UNC path as a UNC path", () => {
    expect(translatePath("//server/share/x", linux)).toMatchObject({
      form: "unc",
      native: "//server/share/x",
      posix: "//server/share/x",
    });
  });

  it("refuses a Windows-looking relative path, since its characters are filename bytes here", () => {
    expect(() => translatePath("src\\app.ts", linux)).toThrow(PathTranslationError);
    try {
      translatePath("src\\app.ts", linux);
    } catch (e) {
      expect((e as Error).message).toContain("looks like a Windows path");
    }
    // An absolute Windows path with a drive prefix is translated to its mount form instead —
    // isWsl tells the caller whether /mnt/c is a real location on this machine.
    expect(translatePath("C:\\Users\\x", linux).native).toBe("/mnt/c/Users/x");
  });
});

describe("host-environment — describeEnvironment", () => {
  it("names the OS, shell layer, locations, line ending and the path caveat a Windows agent needs", () => {
    const text = describeEnvironment(machine({ env: { SHELL: "/usr/bin/bash" } }));
    expect(text).toContain("Windows");
    expect(text).toContain("win32");
    expect(text).toContain("D:\\GitHub\\fork"); // working directory
    expect(text).toContain("/d/GitHub/fork"); // its POSIX twin
    expect(text).toContain("C:\\Users\\ACER"); // home
    expect(text).toContain("CRLF"); // native line ending
    // The sentence that saves the most debugging:
    expect(text).toContain("A POSIX path with no drive");
    expect(text).toContain("translate_path");
  });

  it("mentions the WSL distro when inside WSL, and keeps the POSIX path caveat", () => {
    const text = describeEnvironment(machine(WSL_FACTS));
    expect(text).toContain("Linux");
    expect(text).toContain("WSL");
    expect(text).toContain("Ubuntu");
    expect(text).toContain("Windows path");
    expect(text).toContain("translate_path");
  });

  it("never throws on an environment whose working directory does not translate", () => {
    expect(() => describeEnvironment(machine({ cwd: "not-a-real-path" }))).not.toThrow();
  });
});
