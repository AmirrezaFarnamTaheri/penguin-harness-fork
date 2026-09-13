/**
 * Root-level server instance coordination.
 *
 * `server.lock` is the published discovery record for an already-listening server. The actual
 * single-instance guarantee is a process-lifetime SQLite write transaction on a separate tiny
 * database in the same data root: unlike a check-then-write lock file, BEGIN IMMEDIATE is an
 * atomic cross-process claim and the OS releases it automatically if the owner crashes.
 *
 * Published as `@prismshadow/penguin-server/lock` (side-effect-free) so the CLI and the desktop
 * shell can pre-check a root without importing the package entry, which starts listening.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface ServerLock {
  pid: number;
  port: number;
  startedAt: string;
}

export interface ServerInstanceClaim {
  release(): void;
}

/** TCP probe budget: loopback either connects immediately or the port is dead. */
const PROBE_TIMEOUT_MS = 500;
/** A competing startup should fail promptly instead of sitting behind a live process. */
const CLAIM_BUSY_TIMEOUT_MS = 250;
const CLAIM_DB_NAME = ".server-instance.sqlite";
const sqlite = process.getBuiltinModule("node:sqlite");

export function serverLockPath(root: string): string {
  return path.join(root, "server.lock");
}

function serverClaimDbPath(root: string): string {
  return path.join(root, CLAIM_DB_NAME);
}

/**
 * The lock's text, parsed; anything that is not one reads as "no lock".
 *
 * Exported because a lock is also read where the file is not: a controller looking at
 * ANOTHER machine gets this same text back from an ssh `cat` (machines/server-state.ts). The
 * shape is defined once here so the two readers cannot drift apart.
 */
export function parseServerLock(raw: string): ServerLock | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerLock>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port > 65_535
    ) {
      return null;
    }
    return { pid: parsed.pid, port: parsed.port, startedAt: String(parsed.startedAt ?? "") };
  } catch {
    return null;
  }
}

/** Reads the published lock file; a missing or malformed file reads as "no lock". */
export function readServerLock(root: string): ServerLock | null {
  try {
    return parseServerLock(fs.readFileSync(serverLockPath(root), "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // 127.0.0.1 rather than localhost: this is a raw TCP liveness probe, not an App
    // request, and the server binds 127.0.0.1 (plus ::1) on loopback setups.
    const socket = net.connect({ host: "127.0.0.1", port, timeout: PROBE_TIMEOUT_MS });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** True when the published lock's process is alive AND its port accepts connections. */
export async function isServerLockAlive(lock: ServerLock): Promise<boolean> {
  return pidAlive(lock.pid) && (await portAccepts(lock.port));
}

/** Convenience for pre-checks: the live published lock on this root, or null. */
export async function liveServerLock(root: string): Promise<ServerLock | null> {
  const lock = readServerLock(root);
  if (!lock) return null;
  return (await isServerLockAlive(lock)) ? lock : null;
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is (?:locked|busy)/i.test(message);
}

/**
 * Atomically claims the right to start/run one server for a data root.
 *
 * The returned claim must be retained for the whole server lifetime. A second process cannot
 * acquire BEGIN IMMEDIATE on the same tiny database while this transaction is open. No PID or
 * stale-file reclamation protocol is needed: SQLite/OS file locks disappear when the connection
 * or process dies. `null` means another process currently owns (or is starting on) this root.
 */
export function acquireServerInstanceClaim(root: string): ServerInstanceClaim | null {
  fs.mkdirSync(root, { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(serverClaimDbPath(root));
  db.exec(`PRAGMA busy_timeout = ${CLAIM_BUSY_TIMEOUT_MS};`);
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (isBusyError(error)) return null;
    throw error;
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    },
  };
}

/** Writes the discovery lock atomically once the server is actually listening. */
export function acquireServerLock(root: string, lock: ServerLock): void {
  const target = serverLockPath(root);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock) + "\n");
  fs.renameSync(tmp, target);
}

/** Removes the published lock if it is still ours (best-effort; never throws on shutdown paths). */
export function releaseServerLock(root: string): void {
  try {
    const lock = readServerLock(root);
    if (lock && lock.pid === process.pid) fs.rmSync(serverLockPath(root));
  } catch {
    // Best-effort: the next server publishes a fresh discovery record after claiming the root.
  }
}
