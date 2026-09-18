/**
 * host-environment — what the Harness is actually running on, and what a path string really
 * means on it.
 *
 * The Harness runs on Windows through a POSIX shell layer (Git-Bash/MSYS or WSL), and an agent
 * cannot tell from its own inputs which one it is in: `process.platform` is `win32` for both a
 * native console and a Git-Bash session, `node /tmp/x.mjs` silently resolved to `D:\tmp\x.mjs`
 * (a bare POSIX path is read against the *current drive*, which depends on where the process
 * was started), and `node_modules/.bin/vitest` — a shell shim with no extension — fails under
 * `node` while `vitest.CMD` works. Every one of those failures is a guess about the machine
 * that the machine itself could have answered. This module answers it: live process facts only,
 * no shellouts (the one file read is `/proc/version`, a virtual file that costs one syscall),
 * plus purely lexical path translation that never guesses a drive.
 *
 * Two halves:
 * - {@link detectHostEnvironment} reports the platform, whether it is WSL/MSYS/Cygwin, the
 *   shell, the working directory and home, the OS's native newline, and the path style the
 *   process's own APIs expect. Facts are injectable so tests can pose as any machine.
 * - {@link translatePath} takes a path in ANY of the forms this machine can produce —
 *   `C:\Users\x`, `C:/Users/x`, `/c/Users/x`, `/mnt/c/Users/x`, `/cygdrive/c/x`, `~/x`, a
 *   relative path, a UNC share — and resolves it to an absolute OS-native path plus its
 *   POSIX twin. A form that names no drive on a Windows kernel (the `/tmp/x` case) FAILS with
 *   an explanation instead of silently meaning whatever the current drive happens to be —
 *   that failure is the whole point of the module.
 *
 * Everything here is lexical and side-effect free: no file is touched, no shell is spawned, so
 * a result never depends on the machine's current directory or on which drives are mounted —
 * only on the string and the platform facts.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The platform, narrowed from `process.platform` to the three a Harness actually runs on. */
export type HostPlatform = "win32" | "darwin" | "linux";

/** How this process's own path APIs read a string: Windows (backslash, drive letters) or POSIX. */
export type PathStyle = "win32" | "posix";

/**
 * The machine the process is on. Everything an agent needs to stop guessing about paths,
 * line endings and shells.
 */
export interface HostEnvironment {
  /** `win32`, `darwin` or `linux` — note this is `linux` inside WSL, which `isWsl` distinguishes. */
  platform: HostPlatform;
  /** True only inside WSL: `/proc/version` names a Microsoft kernel, or `WSL_DISTRO_NAME` is set. */
  isWsl: boolean;
  /** WSL's distro name (`WSL_DISTRO_NAME`) when inside WSL, else null. */
  wslDistro: string | null;
  /** True under MSYS2 / Git-Bash (`MSYSTEM` is set: MSYS, MINGW32/64, UCRT64, CLANG*). */
  isMsys: boolean;
  /** True under Cygwin (`OSTYPE=cygwin`); Cygwin's own paths use the `/cygdrive/c` form. */
  isCygwin: boolean;
  /** The shell the environment hands the model: `$SHELL`, else `$ComSpec` (Windows), else null. */
  shell: string | null;
  /** Absolute working directory in this process's own path style. */
  cwd: string;
  /** Absolute home directory in this process's own path style. */
  home: string;
  /** The OS's native line ending — `\r\n` on Windows, `\n` everywhere else. */
  newline: "\r\n" | "\n";
  /** `win32` on a Windows kernel (native or through MSYS/Cygwin), `posix` on Linux/macOS (incl. WSL). */
  pathStyle: PathStyle;
}

/**
 * Live process facts, all of them readable without spawning anything. `procVersion` is
 * `/proc/version`'s contents or null where the file does not exist (every non-Linux machine);
 * it is the reliable WSL signal, since `WSL_DISTRO_NAME` is only set by WSL's own init.
 */
export interface EnvironmentFacts {
  platform: string;
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  newline: string;
  procVersion: string | null;
}

/** Reads `/proc/version`, or returns null where there is no such file (one syscall, no shell). */
function readProcVersion(): string | null {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    // ENOENT on Windows/macOS, EACCES in a locked-down container: either way this machine
    // is not WSL through this signal, and WSL_DISTRO_NAME still gets a chance below.
    return null;
  }
}

/** The facts of the process this module is actually running in. */
export function liveEnvironmentFacts(): EnvironmentFacts {
  return {
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    home: os.homedir(),
    newline: os.EOL,
    procVersion: readProcVersion(),
  };
}

/**
 * Detects the host environment from live facts, which default to this process's own. A caller
 * (or a test) passes `facts` to pose as another machine — every field is optional and fills in
 * with the live value, so a test only names what differs.
 */
export function detectHostEnvironment(facts?: Partial<EnvironmentFacts>): HostEnvironment {
  const f: EnvironmentFacts = { ...liveEnvironmentFacts(), ...facts };
  const platform: HostPlatform =
    f.platform === "win32" ? "win32" : f.platform === "darwin" ? "darwin" : "linux";
  const env = f.env;
  const distro = typeof env["WSL_DISTRO_NAME"] === "string" ? env["WSL_DISTRO_NAME"] : null;
  const microsoftKernel = f.procVersion !== null && /microsoft/i.test(f.procVersion);
  return {
    platform,
    isWsl: platform === "linux" && (distro !== null || microsoftKernel),
    wslDistro: platform === "linux" ? distro : null,
    isMsys: typeof env["MSYSTEM"] === "string" && env["MSYSTEM"] !== "",
    isCygwin: env["OSTYPE"] === "cygwin",
    shell:
      typeof env["SHELL"] === "string" && env["SHELL"] !== ""
        ? env["SHELL"]
        : typeof env["ComSpec"] === "string" && env["ComSpec"] !== ""
          ? env["ComSpec"]
          : null,
    cwd: f.cwd,
    home: f.home,
    newline: f.newline === "\r\n" ? "\r\n" : "\n",
    pathStyle: platform === "win32" ? "win32" : "posix",
  };
}

/**
 * Raised by {@link translatePath} for a path whose form names no resolvable location on this
 * machine — the failure that keeps a bare `/tmp/x` from silently meaning the current drive.
 */
export class PathTranslationError extends Error {
  /** The input that could not be resolved (trimmed). */
  readonly input: string;
  constructor(input: string, message: string) {
    super(message);
    this.name = "PathTranslationError";
    this.input = input;
  }
}

/** Which path form an input was recognized as (reported back to the caller, never guessed). */
export type PathForm =
  | "windows-native" // C:\Users\x or C:/Users/x
  | "unc" // \\server\share or //server/share
  | "wsl" // /mnt/c/Users/x
  | "cygdrive" // /cygdrive/c/Users/x
  | "msys" // /c/Users/x (Git-Bash / MSYS)
  | "posix-native" // /usr/bin on a POSIX kernel
  | "home" // ~/...
  | "relative"; // src/app.ts — resolved against the working directory

/** What {@link translatePath} resolved an input to. */
export interface TranslatedPath {
  /** The input as received (trimmed). */
  input: string;
  /** The form it was recognized as. */
  form: PathForm;
  /** The Windows drive letter (uppercase) when the form identified one, else null. */
  drive: string | null;
  /** The absolute path in the form this process's OS APIs expect (backslashes on Windows). */
  native: string;
  /** The same location as a POSIX path: `/c/Users/x` on Windows, unchanged on a POSIX kernel. */
  posix: string;
}

/** The mount root a Windows drive has on this machine's POSIX side (`/mnt` under WSL). */
const POSIX_MOUNT_ROOT = "/mnt";

/** Path segments of a drive-relative remainder, with empty and "." pieces dropped. */
function splitSegments(rest: string): string[] {
  return rest.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
}

/**
 * A Windows drive path resolved on a Windows kernel: `C:\Users\x`, with the POSIX twin
 * `/c/Users/x` that Git-Bash/MSYS uses for the same location.
 */
function drivePathOnWindows(
  input: string,
  form: PathForm,
  drive: string,
  rest: string,
): TranslatedPath {
  const segments = splitSegments(rest);
  const low = drive.toLowerCase();
  if (segments.length === 0) {
    return { input, form, drive, native: `${drive}:\\`, posix: `/${low}` };
  }
  return {
    input,
    form,
    drive,
    native: `${drive}:\\${segments.join("\\")}`,
    posix: `/${low}/${segments.join("/")}`,
  };
}

/**
 * A Windows drive path resolved on a POSIX kernel (an agent inside WSL given `C:\Users\x`):
 * `/mnt/c/Users/x`, which is the same file the Windows side calls `C:\Users\x`.
 */
function drivePathOnPosix(
  input: string,
  form: PathForm,
  drive: string,
  rest: string,
): TranslatedPath {
  const segments = splitSegments(rest);
  const native =
    segments.length === 0
      ? `${POSIX_MOUNT_ROOT}/${drive.toLowerCase()}`
      : `${POSIX_MOUNT_ROOT}/${drive.toLowerCase()}/${segments.join("/")}`;
  return { input, form, drive, native, posix: native };
}

/**
 * A relative or `~`-relative path resolved against the environment's working directory or
 * home: `path.resolve` normalizes it in this process's own style (`.`/`..` collapsed), and the
 * POSIX twin is derived from the native result.
 */
function resolveRelative(
  input: string,
  rest: string,
  env: HostEnvironment,
  form: PathForm,
): TranslatedPath {
  const base = form === "home" ? env.home : env.cwd;
  if (env.pathStyle === "win32") {
    const native = path.win32.resolve(base, rest);
    return { input, form, drive: null, native, posix: windowsToPosix(native) };
  }
  const native = path.posix.resolve(base, rest);
  return { input, form, drive: null, native, posix: native };
}

/** The POSIX twin of an absolute Windows path: `D:\GitHub` → `/d/GitHub`, a UNC share keeps its `//`. */
function windowsToPosix(native: string): string {
  const unc = /^\\\\([^\\]+)(\\.*)?$/.exec(native);
  if (unc !== null) {
    return `//${unc[1] as string}${((unc[2] as string | undefined) ?? "").replace(/\\/g, "/")}`;
  }
  const drive = native.slice(0, 1).toLowerCase();
  return `/${drive}${native.slice(2).replace(/\\/g, "/")}`;
}

/** The drive letter of a Windows-kernel working directory, for the error message's example. */
function currentDrive(env: HostEnvironment): string | null {
  return /^[A-Za-z]:[\\/]/.test(env.cwd) ? env.cwd.slice(0, 1).toUpperCase() : null;
}

/**
 * Explains why a POSIX absolute path with no drive cannot be resolved on a Windows kernel —
 * the `/tmp/x` case this whole module exists to catch. Names the drive it would silently have
 * meant and every form the caller can use instead.
 */
function ambiguousPosixMessage(raw: string, env: HostEnvironment): string {
  const drive = currentDrive(env);
  const wouldMean =
    drive !== null
      ? `it would be read against this process's current drive, as "${drive}:${raw.replace(/\//g, "\\")}"`
      : "it would be read against whatever drive the process happens to be on";
  // The two Windows spellings are both shown on purpose: a caller may type either separator.
  const forms =
    drive !== null
      ? `the Windows form "${drive}:${raw.replace(/\//g, "\\")}" or "${drive}:/${raw.slice(1)}", ` +
        `the Git-Bash/MSYS form "/${drive.toLowerCase()}${raw}", or the WSL form ` +
        `"/mnt/${drive.toLowerCase()}${raw}"`
      : `a Windows form ("C:${raw}" or "C:/${raw.slice(1)}"), the Git-Bash/MSYS form ` +
        `("/c${raw}"), or the WSL form ("/mnt/c${raw}")`;
  return (
    `"${raw}" is a POSIX-style absolute path with no drive letter, and this machine runs a ` +
    `Windows kernel, where ${wouldMean} — the same string means a different file depending on ` +
    `where the process was started. Name the drive explicitly: ${forms}. A path inside WSL's ` +
    'own Linux filesystem still has to be reached through the "/mnt/<drive>/..." form from ' +
    "this side. Call this tool with translate_path to check any path before relying on it."
  );
}

/**
 * Resolves `input` to an absolute OS-native path and its POSIX twin, on the machine `env`
 * describes (this one by default). Every form the machine can produce is accepted; a form that
 * cannot tell where it points fails with a {@link PathTranslationError} instead of silently
 * landing somewhere plausible-looking.
 *
 * Accepted forms, and how each is read:
 * - Windows native — `C:\Users\x`, `C:/Users/x` (forward slashes are fine), or a bare `C:`,
 *   read as that drive's root (Windows itself would read it as the drive's *current*
 *   directory, which the process does not know).
 * - UNC — `\\server\share\x` or `//server/share/x`.
 * - WSL — `/mnt/c/Users/x`, recognized on either kernel.
 * - Cygwin — `/cygdrive/c/Users/x`.
 * - Git-Bash/MSYS — `/c/Users/x` (only on a Windows kernel; on a POSIX kernel `/c` is a real
 *   directory, so the input is a plain native path there).
 * - Home shorthand — `~` or `~/...`, expanded against `env.home`.
 * - Relative — `src/app.ts`, `../x`, resolved against `env.cwd`.
 * - POSIX native — `/usr/bin` on a POSIX kernel.
 *
 * Fails when:
 * - the input is empty;
 * - a Windows-kernel process gets a POSIX absolute path naming no drive (`/tmp/x`) — it would
 *   mean the current drive's root, exactly the silent bug this module exists to kill;
 * - a Windows drive-relative path (`C:foo`, the drive's current directory plus `foo`) is given
 *   to a Windows kernel, since the drive's current directory is not knowable from a string;
 * - a POSIX-kernel process gets a backslash-bearing string that is not an absolute Windows
 *   path (`src\app.ts`) — backslashes are legal POSIX filename characters, so the string would
 *   name one garbage file instead of the Windows location. An absolute `C:\Users\x` IS
 *   translated (to `/mnt/c/Users/x`), best-effort: `isWsl` tells the caller whether that mount
 *   is real on this machine.
 */
export function translatePath(
  input: string,
  env: HostEnvironment = detectHostEnvironment(),
): TranslatedPath {
  const raw = typeof input === "string" ? input.trim() : "";
  if (raw === "") {
    throw new PathTranslationError("", "an empty path names no location; pass a path string.");
  }
  const onWindows = env.pathStyle === "win32";

  // Home shorthand first — it cannot collide with any other form.
  if (raw === "~") {
    return resolveRelative(raw, "", env, "home");
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return resolveRelative(raw, raw.slice(2), env, "home");
  }

  // Windows native: a drive letter, a colon, then either a separator (or nothing) or — on a
  // POSIX kernel — any remainder, where the whole string is a Windows path being translated.
  const nativeForm = /^([A-Za-z]):([\\/]?)(.*)$/.exec(raw);
  if (nativeForm !== null) {
    const drive = (nativeForm[1] as string).toUpperCase();
    const separator = nativeForm[2] as string;
    const rest = nativeForm[3] as string;
    if (onWindows && separator === "" && rest !== "") {
      throw new PathTranslationError(
        raw,
        `"${raw}" is a drive-relative path ("C:foo" means the directory foo inside drive C's ` +
          "current directory, which this process does not know). Give the full path instead: " +
          `"${drive}:\\${rest}" or "${drive}:/${rest}".`,
      );
    }
    return onWindows
      ? drivePathOnWindows(raw, "windows-native", drive, rest)
      : drivePathOnPosix(raw, "windows-native", drive, rest);
  }

  if (onWindows) {
    // A POSIX-style drive form: /mnt/c/... (WSL) or /cygdrive/c/... (Cygwin).
    const wsl = /^\/mnt\/([A-Za-z])((?:[\\/].*)?)$/.exec(raw);
    if (wsl !== null) {
      return drivePathOnWindows(raw, "wsl", (wsl[1] as string).toUpperCase(), wsl[2] as string);
    }
    const cyg = /^\/cygdrive\/([A-Za-z])((?:[\\/].*)?)$/.exec(raw);
    if (cyg !== null) {
      return drivePathOnWindows(
        raw,
        "cygdrive",
        (cyg[1] as string).toUpperCase(),
        cyg[2] as string,
      );
    }
    // A single letter as the first segment is the Git-Bash/MSYS drive form (/c/Users/x).
    // A longer first segment (/tmp/x, /usr/bin) names no drive and is rejected below.
    const msys = /^\/([A-Za-z])((?:[\\/].*)?)$/.exec(raw);
    if (msys !== null) {
      return drivePathOnWindows(raw, "msys", (msys[1] as string).toUpperCase(), msys[2] as string);
    }
    // UNC: \\server\share or //server/share (both separators are accepted by the Windows APIs).
    const uncBack = /^\\\\([^\\]+)((?:\\.*)?)$/.exec(raw);
    const uncSlash = /^\/\/([^/]+)((?:\/.*)?)$/.exec(raw);
    if (uncBack !== null || uncSlash !== null) {
      const host = (uncBack ?? uncSlash)![1] as string;
      const rest = ((uncBack ?? uncSlash)![2] as string) ?? "";
      const posixRest = rest.replace(/\\/g, "/");
      return {
        input: raw,
        form: "unc",
        drive: null,
        native: `\\\\${host}${rest.replace(/\//g, "\\")}`,
        posix: `//${host}${posixRest}`,
      };
    }
    // Any other absolute POSIX string names no drive: refusing it here is the point.
    if (raw.startsWith("/")) {
      throw new PathTranslationError(raw, ambiguousPosixMessage(raw, env));
    }
    // A relative path with backslashes is a Windows relative path — fine, path.resolve reads it.
    return resolveRelative(raw, raw, env, "relative");
  }

  // POSIX kernel: a Windows-style path is not one this machine can open, and its characters
  // are legal (if never intended) POSIX filename bytes, so it is refused rather than joined
  // onto the working directory as a single garbage filename.
  if (/\\/.test(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new PathTranslationError(
      raw,
      `"${raw}" looks like a Windows path (backslashes or a "X:" drive prefix), but this ` +
        "machine's kernel is POSIX and reads those as ordinary filename characters — the " +
        "string would name a file inside the working directory, not the Windows location. " +
        'Use the POSIX form instead, e.g. "/mnt/c/Users/x" for a Windows file from inside WSL.',
    );
  }

  if (raw.startsWith("//")) {
    // A POSIX kernel may map a double-leading-slash path to a UNC share (SMB); keep it as-is.
    return { input: raw, form: "unc", drive: null, native: raw, posix: raw };
  }

  if (raw.startsWith("/")) {
    return { input: raw, form: "posix-native", drive: null, native: raw, posix: raw };
  }

  return resolveRelative(raw, raw, env, "relative");
}

/**
 * A compact, model-readable description of the machine: what OS and shell layer the agent is
 * running in, where it is, how this OS ends its lines, and — the part that saves the most
 * debugging — which path forms resolve here and which one silently does not. One paragraph
 * per topic, no tables: it is meant to be read once and acted on.
 */
export function describeEnvironment(env: HostEnvironment = detectHostEnvironment()): string {
  const osName =
    env.platform === "win32" ? "Windows" : env.platform === "darwin" ? "macOS" : "Linux";
  const layer = env.isWsl
    ? ` WSL${env.wslDistro !== null ? ` (distro ${env.wslDistro})` : ""}`
    : env.isMsys
      ? " MSYS2/Git-Bash"
      : env.isCygwin
        ? " Cygwin"
        : "";
  const shellLine =
    env.shell !== null
      ? `Shell: ${env.shell} — a POSIX-style shell on a Windows kernel reads some paths as /c/... and some as C:\\..., so check any path you are unsure about.`
      : "Shell: not reported by the environment (no SHELL or ComSpec).";
  const newlineName = env.newline === "\r\n" ? "CRLF (\\r\\n)" : "LF (\\n)";
  // The POSIX twin is a convenience; a cwd that does not translate (an exotic or inconsistent
  // environment) must never make the description itself fail.
  let cwdPosix = env.cwd;
  try {
    cwdPosix = translatePath(env.cwd, env).posix;
  } catch {
    // Keeps the raw working directory — the line still names where the process is.
  }
  const lines: string[] = [
    `Running on ${osName} (platform: ${env.platform}${layer ? `, running under${layer}` : ""}); ` +
      "this answer comes from the process itself, not a shell probe.",
    shellLine,
    `Working directory: ${env.cwd} (POSIX form: ${cwdPosix}).`,
    `Home: ${env.home}.`,
    `This OS's native line ending is ${newlineName}; the file tools still preserve each file's own ` +
      "style and match edit_file's old_string with endings normalized, so quote text from read_file exactly as shown.",
  ];
  if (env.pathStyle === "win32") {
    lines.push(
      "Path forms this machine resolves: Windows native (C:\\Users\\x or C:/Users/x), " +
        "Git-Bash/MSYS (/c/Users/x), WSL (/mnt/c/Users/x), Cygwin (/cygdrive/c/Users/x), " +
        "~/... for home, and relative paths against the working directory. A POSIX path with no " +
        "drive — /tmp/x — does NOT resolve here: it would silently mean the current drive's root " +
        "and open a different file depending on where the process started. Pass translate_path to " +
        "check any path before using it.",
    );
  } else {
    lines.push(
      "Path forms this machine resolves: POSIX absolute paths (/usr/bin, /mnt/c/Users/x inside " +
        "WSL), ~/... for home, and relative paths against the working directory. A Windows path " +
        "(C:\\Users\\x) is not openable from here — its backslashes are ordinary filename " +
        "characters on this kernel; use /mnt/c/Users/x for a Windows file instead. Pass " +
        "translate_path to check any path before using it.",
    );
  }
  return lines.join("\n");
}
