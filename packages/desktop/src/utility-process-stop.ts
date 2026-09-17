/** Forced shutdown of a desktop-owned utility process; no Electron runtime dependency. */
import { execFile } from "node:child_process";
import type { UtilityProcess } from "electron";

type OwnedProcess = Pick<UtilityProcess, "pid" | "kill">;
type TreeCommand = (file: string, args: readonly string[]) => Promise<boolean>;

function runTreeCommand(file: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 2000 }, (error) => {
      resolve(error === null);
    });
  });
}

/**
 * Called only after the owned server's graceful shutdown window has expired, never
 * on terminal-view disconnect. Kill the Windows tree BEFORE the root: terminating
 * the utility process first would orphan the PTYs before taskkill can find them.
 *
 * POSIX utilityProcess.fork does not promise a separate process group. Do not send
 * a negative-PID signal or claim tree quarantine there; keep Electron's root kill
 * as the fallback, with terminal disposal delegated to graceful server shutdown.
 * This is best-effort cleanup, not a sandbox or an OS job-object containment boundary.
 */
export async function forceStopUtilityProcess(
  child: OwnedProcess,
  platform: NodeJS.Platform = process.platform,
  run: TreeCommand = runTreeCommand,
): Promise<void> {
  const pid = child.pid;
  if (
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid === process.pid ||
    pid === process.ppid
  ) {
    return;
  }
  if (platform === "win32") {
    try {
      if (await run("taskkill", ["/pid", String(pid), "/t", "/f"])) return;
    } catch {
      // Missing/restricted taskkill: preserve the existing direct-child fallback.
    }
  }
  // Electron clears pid after exit; never use a PID cached across the async attempt
  // to fall back onto a process that is no longer the child we intended to stop.
  if (child.pid === pid) child.kill();
}
