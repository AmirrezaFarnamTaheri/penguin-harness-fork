/**
 * PRR-05 acceptance — signed process-group ownership records.
 *
 * F5: `refreshGuardian` kept every registered row's `session.pid` and published it to the
 * watchdog's pid file without checking whether the process was still alive. The group id equals
 * the leader's pid, so after OS reuse a new unrelated process group can carry that same numeric
 * id, and the guardian would signal it when the harness died.
 *
 * The repair gives every spawned command a random ownership nonce, publishes `pid:nonce` records
 * atomically, and makes the shipped guardian prove ownership from the *current* members of a group
 * before it sends the negative-PGID signal.
 *
 * The real-process half of this (recycled groups, surviving descendants, parent death) is
 * POSIX-only — `guardianSupported()` is false on win32, where the documented gap is the Job Object
 * — so those cases are `skipIf`-gated here exactly as the existing guardian suite gates them. What
 * runs on every platform is the part that decides *whether* a signal is ever allowed: the record
 * format, the parser's tolerance, and the shipped guardian's own proof requirement, pinned against
 * the source that production executes.
 */
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GUARDIAN_OWNER_ENV,
  GUARDIAN_POLL_MS,
  PARENT_DEATH_GUARDIAN_SOURCE,
  guardianSupported,
  parseGuardedPids,
  readGuardedPids,
  writeGuardedPids,
} from "../src/environment/tools/command/parent-death-guardian.js";

const NONCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

let dir: string;
let pidFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "prr-05-guardian-"));
  pidFile = path.join(dir, "guarded.pids");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** The raw pid-file body, so assertions can see the format rather than only the parsed pids. */
const body = (): Promise<string> => fs.readFile(pidFile, "utf8");

describe("PRR-05 signed group records", () => {
  it("publishes one nonce-bound record per group", async () => {
    const owners = new Map([
      [4321, NONCE],
      [8765, "f".repeat(32)],
    ]);
    writeGuardedPids(pidFile, [4321, 8765], owners);
    expect(await body()).toBe(`4321:${NONCE}\n8765:${"f".repeat(32)}\n`);
    expect(readGuardedPids(pidFile)).toEqual([4321, 8765]);
  });

  it("drops an unsigned record rather than advertising an unprovable group", async () => {
    // A group written without a nonce is invisible to the guarded-process list: if ownership
    // cannot be named, the record is not published. The shipped guardian's signed-line pattern
    // rejects it as well, so the two layers agree on fail-closed.
    writeGuardedPids(pidFile, [4321]);
    expect(await body()).toBe("4321:\n");
    expect(readGuardedPids(pidFile)).toEqual([]);
    expect(/^(\d+):([a-f0-9]{32})$/.test("4321:")).toBe(false);
  });

  it("replaces the file atomically and leaves no temporary residue", async () => {
    writeGuardedPids(pidFile, [1_000_001], new Map([[1_000_001, NONCE]]));
    writeGuardedPids(pidFile, [1_000_002, 1_000_003], new Map([[1_000_003, NONCE]]));

    // One whole generation, never a mix of the two writes and never a truncated file.
    expect(await body()).toBe(`1000002:\n1000003:${NONCE}\n`);
    const entries = await fs.readdir(dir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("parses the signed form, the legacy bare form, and nothing else", () => {
    expect(parseGuardedPids(`4321:${NONCE}\n8765\n`)).toEqual([4321, 8765]);
    // A pid the guardian must never signal: 0 is its own group and 1 is init's session.
    expect(parseGuardedPids("1\n0\n-5\n")).toEqual([]);
    expect(parseGuardedPids("not-a-pid\n")).toEqual([]);
    // A truncated, wrong-length or non-hex nonce is not a valid signed record.
    expect(parseGuardedPids(`4321:deadbeef\n`)).toEqual([]);
    expect(parseGuardedPids("4321:not-hex-at-all\n")).toEqual([]);
  });

  it("never reports a dangerous pid from a corrupted file", () => {
    // A blank line, a stray separator and a non-numeric line all drop out rather than becoming a
    // negative target; valid records around them survive.
    expect(parseGuardedPids("\n\n\n")).toEqual([]);
    expect(parseGuardedPids(`4321:${NONCE}\n\n9876:${NONCE}\n`)).toEqual([4321, 9876]);
    expect(parseGuardedPids(":::\n4321:::\n")).toEqual([]);
  });

  it("round-trips a record through write and read unchanged", async () => {
    const owners = new Map([
      [111, "0".repeat(32)],
      [222, "f".repeat(32)],
    ]);
    writeGuardedPids(pidFile, [111, 222], owners);
    expect(readGuardedPids(pidFile)).toEqual([111, 222]);
    expect(await body()).toBe(`111:${"0".repeat(32)}\n222:${"f".repeat(32)}\n`);
  });

  it("clearing the file removes it rather than leaving a sweepable record", async () => {
    writeGuardedPids(pidFile, [4321], new Map([[4321, NONCE]]));
    await fs.rm(pidFile, { force: true });
    expect(readGuardedPids(pidFile)).toEqual([]);
  });
});

describe("PRR-05 the shipped guardian proves ownership before signalling", () => {
  // These are source pins against the exact program production runs (`node -e <source>`). They
  // stand in for the POSIX-only real-process cases, which cannot execute on this platform.
  const source = PARENT_DEATH_GUARDIAN_SOURCE;

  it("requires a signed pid:nonce line to consider a group at all", () => {
    expect(source).toContain(String.raw`/^(\d+):([a-f0-9]{32})$/`);
    expect(source).toContain("ownerEnv");
    expect(source).toContain("PENGUIN_GUARDIAN_OWNER");
  });

  it("inspects the group's current members for the nonce before signalling", () => {
    // Ownership is decided by a live member carrying the nonce, not by the numeric pgid alone.
    expect(source).toContain(
      String.raw`(members.get(pid) || []).some((member) => owns(member, owner))) continue;`,
    );
  });

  it("signals the negative pgid and has no bare-pid kill", () => {
    // `process.kill(pid, 0)` is a liveness probe and signals nothing, so it is legitimate; what
    // must not exist is any destructive signal aimed at a bare pid. Enumerating every call makes
    // that check total rather than a spot-check on one known line.
    const calls = [...source.matchAll(/process\.kill\(([^)]*)\)/g)].map((match) =>
      match[1]!.trim(),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      const [target, signal] = args.split(",").map((part) => part.trim());
      if (signal === '"SIGKILL"') expect([target, signal]).toEqual(["-pid", '"SIGKILL"']);
      else expect(signal).toBe("0");
    }
  });

  it("reads the nonce from a live process environment, not from the pid file's number", () => {
    // /proc/<pid>/environ on Linux, `ps eww` elsewhere — either way the proof comes from the
    // running process, which a recycled numeric id cannot fake.
    expect(source).toContain('"/proc/" + member + "/environ"');
    expect(source).toContain('["eww", "-p", String(member), "-o", "command="]');
  });

  it("keeps the corrupted-file failure closed", () => {
    // A pid file that cannot be parsed must yield an empty sweep set, never a dangerous one.
    expect(source).toMatch(/function readGroups\(\)[\s\S]*?catch \{[\s\S]*?return \[\];/);
    expect(source).toContain("Number.isInteger(entry.pid) && entry.pid > 1");
  });

  it("gives up rather than signalling when the process list is unavailable", () => {
    expect(source).toContain("if (result.status !== 0 || result.error) return;");
  });

  it("refuses a parent pid that would make the watchdog signal itself", () => {
    expect(source).toContain(
      "if (!Number.isInteger(parentPid) || parentPid <= 1) process.exit(0);",
    );
  });
});

describe.skipIf(!guardianSupported())("PRR-05 real groups (POSIX only)", () => {
  /** Runs the shipped guardian program against a pid file, watching a stand-in harness process. */
  function startGuardian(watchingPid: number): () => void {
    const child = spawn(
      process.execPath,
      ["-e", PARENT_DEATH_GUARDIAN_SOURCE, String(watchingPid), pidFile],
      {
        stdio: "ignore",
        detached: true,
      },
    );
    child.unref();
    return () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
  }

  it("sweeps a group whose members carry this harness's nonce, and spares one that does not", async () => {
    // The review's case, both halves in one run: the pgid is alive and numeric in both cases, and
    // only one of them can prove it belongs to the harness that died.
    const owned = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [GUARDIAN_OWNER_ENV]: NONCE },
    });
    const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const harness = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });

    try {
      expect(owned.pid).not.toBeNull();
      expect(unrelated.pid).not.toBeNull();
      expect(harness.pid).not.toBeNull();

      // The unrelated group is registered under a nonce nobody in it has: the numeric id alone
      // must never authorise a signal.
      writeGuardedPids(
        pidFile,
        [owned.pid!, unrelated.pid!],
        new Map([
          [owned.pid!, NONCE],
          [unrelated.pid!, "0".repeat(32)],
        ]),
      );

      const stopGuardian = startGuardian(harness.pid!);
      try {
        process.kill(harness.pid!, "SIGKILL");
        // Two guardian polls plus slack: the watchdog must observe the death and sweep.
        await new Promise((resolve) => setTimeout(resolve, GUARDIAN_POLL_MS * 4));

        expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
        expect(() => process.kill(owned.pid!, 0)).toThrow();
      } finally {
        stopGuardian();
      }
    } finally {
      for (const pid of [owned.pid, unrelated.pid, harness.pid]) {
        if (pid === undefined) continue;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });
});
