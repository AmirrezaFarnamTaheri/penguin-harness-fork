/**
 * E10.1 — cleanup that survives SIGKILL of the harness.
 *
 * The registry's `process.on("exit")` fallback covers a graceful exit and nothing else. These
 * tests prove the watchdog boundary with real processes: a "harness" process is killed with
 * SIGKILL (no exit hook can run), and the detached command group it left behind is gone a moment
 * later — while a process that was never registered with the watchdog survives untouched.
 *
 * The guardian program itself is executed exactly as production runs it (`node -e <source>`), so
 * what is proven here is the shipped artifact, not a reimplementation.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandSessionManager } from "../src/environment/tools/command/session-manager.js";
import {
  GUARDIAN_POLL_MS,
  PARENT_DEATH_GUARDIAN_SOURCE,
  guardianPidFile,
  guardianSupported,
  parseGuardedPids,
  readGuardedPids,
} from "../src/environment/tools/command/parent-death-guardian.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(GUARDIAN_POLL_MS / 2);
  }
  return !alive(pid);
}

/** Signal a whole process group, tolerating ESRCH. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

describe("guardian pid-file parsing", () => {
  it("accepts only plausible group-leader pids", () => {
    // The negative/zero/low cases matter: `kill(-1, SIGKILL)` reaches the whole session, so a
    // corrupted file must never produce pid 1 or 0 — the guard lives in the parser AND in the
    // guardian program, which filters the same way.
    expect(parseGuardedPids("4321\n77\n")).toEqual([4321, 77]);
    // The dangerous ones are asserted here, where they are only parsed: 1 = every process in the
    // session, 0 = the caller's own group, negative = an unrelated process.
    expect(parseGuardedPids("1\n0\n-5\n\nnot-a-pid\n  \n2.5\n")).toEqual([]);
    expect(parseGuardedPids("")).toEqual([]);
    expect(parseGuardedPids("1")).toEqual([]);
  });
});

describe("manager wiring for the watchdog (E10.1)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "penguin-guardian-wiring-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts one watchdog for live background commands and stops it when none remain", async () => {
    const started: { pidFile: string }[] = [];
    let stops = 0;
    const manager = new CommandSessionManager({
      guardianDir: dir,
      guardianSpawn: (opts) => {
        started.push(opts);
        return { pid: 4242, stop: () => (stops += 1) };
      },
    });
    const pidFile = guardianPidFile(dir);

    expect(await fs.readFile(pidFile, "utf8").catch(() => null)).toBeNull();

    const first = manager.spawn({ cmd: "sleep 30", cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const firstId = manager.register(first);
    expect(started).toHaveLength(1);
    // The pid file lists the live group leader, which is what the watchdog sweeps.
    expect(readGuardedPids(pidFile)).toEqual([first.pid]);

    // A second command joins the same watchdog — one process per Session, not per command.
    const second = manager.spawn({ cmd: "sleep 30", cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.register(second);
    expect(started).toHaveLength(1);
    expect(readGuardedPids(pidFile).sort()).toEqual([first.pid!, second.pid!].sort());

    // Killing one leaves the other guarded; the watchdog is only stopped with the last one.
    manager.kill(firstId);
    expect(stops).toBe(0);
    expect(readGuardedPids(pidFile)).toEqual([second.pid]);
    expect(manager.guardedProcessGroupIds()).toEqual([second.pid]);

    manager.kill(manager.list()[0]!.processId);
    expect(stops).toBe(1);
    expect(readGuardedPids(pidFile)).toEqual([]);
    expect(manager.guardedProcessGroupIds()).toEqual([]);

    // Disposing is idempotent and leaves no state behind.
    manager.dispose();
    expect(manager.guardedProcessGroupIds()).toEqual([]);
    expect(await fs.readFile(pidFile, "utf8").catch(() => null)).toBeNull();
  });

  it("stays out of the way when no scratchpad directory is configured", async () => {
    let started = 0;
    const manager = new CommandSessionManager({
      guardianSpawn: () => {
        started += 1;
        return { pid: null, stop: () => {} };
      },
    });
    const session = manager.spawn({ cmd: "sleep 30", cwd: dir });
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.register(session);
    // No watchdogDir means no watchdog: an embedder without a Session scratchpad keeps
    // today's behavior and the limitation is documented rather than papered over.
    expect(started).toBe(0);
    manager.dispose();
  });
});

describe.skipIf(!guardianSupported())("parent-death guardian (E10.1)", () => {
  let dir: string;
  const spawned: ChildProcessWithoutNullStreams[] = [];

  const start = (
    command: string,
    args: string[],
    options: { detached?: boolean } = {},
  ): ChildProcessWithoutNullStreams => {
    const child = spawn(command, args, {
      stdio: "pipe",
      detached: options.detached ?? false,
    }) as ChildProcessWithoutNullStreams;
    spawned.push(child);
    return child;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "penguin-guardian-"));
  });

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      if (child.pid !== undefined) killGroup(child.pid);
      child.kill("SIGKILL");
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("kills a detached command group when the harness is SIGKILLed, and leaves others alone", async () => {
    const pidFile = guardianPidFile(dir);
    // A stand-in harness: it starts a detached background command and a watchdog, then waits to
    // be killed. It runs no exit hook, exactly like a SIGKILLed or crashed harness.
    const harness = start("node", [
      "-e",
      `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [guardianSource, pidFile] = process.argv.slice(1);
// The "background command": detached, so it leads its own process group and would survive.
const group = spawn("sh", ["-c", "sleep 120"], { detached: true, stdio: "ignore" });
group.unref();
fs.writeFileSync(pidFile, group.pid + "\\n", { mode: 0o600 });
const guardian = spawn(process.execPath, ["-e", guardianSource, String(process.pid), pidFile], {
  detached: true,
  stdio: "ignore",
});
guardian.unref();
process.stdout.write(String(group.pid) + "\\n");
setInterval(() => {}, 1000);
`,
      PARENT_DEATH_GUARDIAN_SOURCE,
      pidFile,
    ]);

    const groupPid = await new Promise<number>((resolve, reject) => {
      let buffer = "";
      harness.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const line = buffer.split("\n")[0]?.trim();
        if (line) resolve(Number(line));
      });
      harness.on("error", reject);
    });
    expect(Number.isInteger(groupPid)).toBe(true);
    expect(alive(groupPid)).toBe(true);

    // An unrelated process, in its own group, started by someone else entirely.
    const bystander = start("sh", ["-c", "sleep 120"], { detached: true });
    const bystanderPid = bystander.pid!;

    // SIGKILL the harness: no exit hook, no signal handler, no chance to clean up.
    process.kill(harness.pid!, "SIGKILL");
    await waitForDead(harness.pid!);

    // The watchdog noticed and swept the group it was told about.
    expect(await waitForDead(groupPid)).toBe(true);
    // The unrelated process was never in the pid file and is untouched.
    expect(alive(bystanderPid)).toBe(true);
  });

  it("does nothing while the harness is alive, and exits once its pid file is gone", async () => {
    const pidFile = guardianPidFile(dir);
    const group = start("sh", ["-c", "sleep 120"], { detached: true });
    const groupPid = group.pid!;
    await fs.writeFile(pidFile, `${groupPid}\n`, { mode: 0o600 });

    const guardian = start("node", [
      "-e",
      PARENT_DEATH_GUARDIAN_SOURCE,
      String(process.pid),
      pidFile,
    ]);
    // The guardian of a live parent must not kill anything, however long it runs.
    await sleep(GUARDIAN_POLL_MS * 3);
    expect(guardian.exitCode).toBeNull();
    expect(alive(groupPid)).toBe(true);

    // Once the Session deletes its scratchpad there is nothing to sweep: the watchdog leaves.
    await fs.rm(pidFile, { force: true });
    const deadline = Date.now() + 5000;
    while (guardian.exitCode === null && Date.now() < deadline) await sleep(GUARDIAN_POLL_MS / 2);
    expect(guardian.exitCode).not.toBeNull();
    expect(alive(groupPid)).toBe(true);
  });

  it("ignores a malformed pid file rather than acting on it", async () => {
    const pidFile = guardianPidFile(dir);
    // Only values that cannot turn into a dangerous kill are put in a file the guardian will
    // actually sweep: pid 1 would reach the whole session and a negative pid an unrelated
    // process, so those cases are asserted on the pure parser instead (see above) — proving the
    // filter by executing it with a live session at stake is not a test, it is an incident.
    await fs.writeFile(pidFile, "not-a-pid\n\n  \n2.5\n", { mode: 0o600 });
    const guardian = start("node", ["-e", PARENT_DEATH_GUARDIAN_SOURCE, "999999", pidFile]);
    const deadline = Date.now() + 5000;
    while (guardian.exitCode === null && Date.now() < deadline) await sleep(GUARDIAN_POLL_MS / 2);
    expect(guardian.exitCode).not.toBeNull();
    // Nothing was unlinked out from under a live process and the file the guardian emptied
    // itself of is gone (it removes the file it swept, which was malformed and thus empty).
    expect(await fs.readFile(pidFile, "utf8").catch(() => null)).toBeNull();
  });
});
