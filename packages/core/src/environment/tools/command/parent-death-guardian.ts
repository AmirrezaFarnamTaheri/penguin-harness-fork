/**
 * Parent-death guardian (E10.1) — cleanup that does not depend on the harness running its own
 * exit hook.
 *
 * Background commands are spawned detached, each as its own process-group leader, and the
 * registry kills them from a `process.on("exit")` fallback. That covers a normal exit, Ctrl-C
 * and SIGTERM — and nothing else. SIGKILL, an OOM kill, or a crash of the harness skips the
 * fallback entirely, and the detached group survives with no UI left that can reach it: a dev
 * server or watcher holding a port and a directory until the machine reboots.
 *
 * The supported boundary here is a tiny watchdog process per Session, itself detached, that:
 *   - polls whether the harness pid is still alive,
 *   - and, the moment it is not, SIGKILLs every process group still listed in its pid file.
 *
 * The pid file is the contract between the two: the Session's command manager rewrites it
 * synchronously whenever a background session is spawned, reaped or killed, so the guardian
 * always sweeps the current set and never touches a group the harness already disposed of. The
 * directory holding it is the Session scratchpad, which the host removes with the Session — a
 * guardian whose file is gone exits by itself.
 *
 * Windows has no process groups and no POSIX signals, so this module is inert there
 * (`guardianSupported()`): the documented boundary on Windows is the Job Object, which needs a
 * native handle this package does not carry (see the E10.1 receipt — recorded, not claimed).
 */
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** How often the guardian checks whether the harness is still alive. */
export const GUARDIAN_POLL_MS = 500;

/**
 * The guardian program, as source text for `node -e` / `node <file>`.
 *
 * Deliberately dependency-free and quiet: it takes `[parentPid, pidFile]`, polls both, and exits
 * on its own once the parent is gone (after sweeping) or once the pid file has disappeared. Its
 * polling interval is NOT unref'd — an unref'd timer would let node exit on the first tick, and
 * the guardian's whole job is to still be there when the parent dies. It never writes to
 * stdout/stderr — it is invisible to the user.
 */
export const PARENT_DEATH_GUARDIAN_SOURCE = `const [parentPidArg, pidFile] = process.argv.slice(1);
const parentPid = Number(parentPidArg);
const pollMs = ${GUARDIAN_POLL_MS};
const fs = require("node:fs");
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}
function readGroups() {
  try {
    return fs
      .readFileSync(pidFile, "utf8")
      .split("\\n")
      .map((line) => Number(line.trim()))
      // Load-bearing: a negative target with pid 1 reaches every process in the session, pid 0
      // the guardian's own group, and a stray negative pid something unrelated. A corrupted pid
      // file must therefore produce an EMPTY list, never a dangerous one.
      .filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch {
    return [];
  }
}
function sweep() {
  for (const pid of readGroups()) {
    // The group id equals the leader's pid (see ManagedSession's detached spawn). Kill the
    // group; fall back to the single process if the group is already gone or was never one.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
if (!Number.isInteger(parentPid) || parentPid <= 1) process.exit(0);
const timer = setInterval(() => {
  if (!alive(parentPid)) {
    sweep();
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    process.exit(0);
  }
  // Parent alive but the file is gone (Session deleted, host cleaned the scratchpad): there is
  // nothing left to sweep, so the watchdog leaves rather than accumulating.
  if (!fs.existsSync(pidFile)) process.exit(0);
}, pollMs);
`;

export interface ParentDeathGuardianHandle {
  /** Guardian process id, or null when no guardian was started (unsupported platform / refusal). */
  pid: number | null;
  /** Stops the guardian. Idempotent; the guardian also exits by itself once the parent is gone. */
  stop(): void;
}

/**
 * Whether this platform gets the watchdog. The boundary is POSIX process groups: on Windows the
 * equivalent guarantee is a Job Object, which requires a native handle and is deliberately not
 * claimed here.
 */
export function guardianSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export interface StartGuardianOptions {
  /** Harness pid the guardian watches; when this dies, the listed groups are killed. */
  parentPid?: number;
  /** File listing one process-group leader pid per line. */
  pidFile: string;
  /** Test seam: how the guardian is launched. Defaults to `node -e <source>`. */
  spawnImpl?: typeof spawn;
}

/**
 * Starts the watchdog for one Session's background commands. Returns a handle whose `stop()`
 * terminates the guardian (called when the Session disposes: a graceful shutdown has already
 * killed the groups, so the watchdog has nothing left to do and should not outlive it).
 */
export function startParentDeathGuardian(opts: StartGuardianOptions): ParentDeathGuardianHandle {
  if (!guardianSupported()) return { pid: null, stop: () => {} };
  const parentPid = opts.parentPid ?? process.pid;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const child = spawnImpl(
    process.execPath,
    ["-e", PARENT_DEATH_GUARDIAN_SOURCE, String(parentPid), opts.pidFile],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref?.();
  return {
    pid: child.pid ?? null,
    stop: () => {
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone: the desired end state.
      }
    },
  };
}

/**
 * Rewrites the pid file with the current process-group leader pids. Written synchronously
 * because the write happens immediately before or after a spawn/kill: a crash in between must
 * leave a file that lists exactly the groups that may still be running, never a stale pid that
 * the guardian would later kill on a reuse.
 */
export function writeGuardedPids(pidFile: string, pids: readonly number[]): void {
  try {
    writeFileSync(pidFile, pids.map((pid) => `${pid}\n`).join(""), { mode: 0o600 });
  } catch {
    // A scratchpad that cannot be written only costs this Session its watchdog; spawning a
    // command must not fail because of it.
  }
}

/** Removes the pid file (the Session disposed; there is nothing left to sweep). */
export function clearGuardedPids(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch {
    // Already gone.
  }
}

/** Reads the pid file back; exposed for the manager's own bookkeeping and for tests. */
export function readGuardedPids(pidFile: string): number[] {
  try {
    return parseGuardedPids(readFileSync(pidFile, "utf8"));
  } catch {
    return [];
  }
}

/** Parses the file body into pids, ignoring anything that is not a live-looking pid. */
export function parseGuardedPids(body: string): number[] {
  return body
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

/** Where a Session's guardian state lives inside its scratchpad. */
export function guardianPidFile(scratchpadDir: string): string {
  return path.join(scratchpadDir, "guarded-processes.txt");
}
