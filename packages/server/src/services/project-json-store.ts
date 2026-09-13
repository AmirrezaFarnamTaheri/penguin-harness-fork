import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { atomicWriteFile, projectDir } from "@prismshadow/penguin-core";

export interface JsonMutation<T, R> {
  value: T;
  result: R;
}

export type JsonDecoder<T> = (raw: string) => T;
export type JsonEncoder<T> = (value: T) => string;

const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;
const RECOVERY_DB_NAME = ".project-state-locks.sqlite";

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

const sqlite = process.getBuiltinModule("node:sqlite");
const recoveryTails = new Map<string, Promise<void>>();

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLockOwner(raw: string): LockOwner {
  const parsed = JSON.parse(raw) as Partial<LockOwner>;
  if (
    typeof parsed.token !== "string" ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.hostname !== "string" ||
    typeof parsed.createdAt !== "number"
  ) {
    throw new Error("Invalid lock-owner metadata");
  }
  return parsed as LockOwner;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    return parseLockOwner(await fs.readFile(lockPath, "utf-8"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    return true;
  }
}

async function quarantineAndDelete(lockPath: string, label: string): Promise<boolean> {
  const quarantine = `${lockPath}.${label}-${randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantine);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
  await fs.unlink(quarantine).catch((error) => {
    if (!isErrno(error, "ENOENT")) throw error;
  });
  return true;
}

function openRecoveryMutex(root: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path.join(root, RECOVERY_DB_NAME));
  db.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MS};`);
  // Ensure the database has a durable schema page before using a transaction only as a mutex.
  db.exec("CREATE TABLE IF NOT EXISTS recovery_guard (id INTEGER PRIMARY KEY CHECK (id = 1));");
  return db;
}

async function withSqliteRecoveryMutex<R>(root: string, work: () => Promise<R>): Promise<R> {
  const db = openRecoveryMutex(root);
  let began = false;
  try {
    // SQLite supplies the cross-process primitive the filesystem API lacks here: only one stale
    // reclaimer may hold an IMMEDIATE transaction for this data root, and the OS releases it if
    // that process dies. A contender therefore rechecks the lock pathname only after the prior
    // reclaimer has finished, so it cannot act on an owner snapshot taken before replacement.
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const result = await work();
    db.exec("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original recovery error; closing the connection also drops the transaction.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

async function withRecoveryMutex<R>(root: string, work: () => Promise<R>): Promise<R> {
  const key = path.resolve(root);
  const previous = recoveryTails.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => withSqliteRecoveryMutex(root, work));
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  recoveryTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (recoveryTails.get(key) === tail) recoveryTails.delete(key);
  }
}

/**
 * Recover an abandoned lock. Recovery is serialized across processes through SQLite before the
 * lock is re-read, so two stale reclaimers cannot both act on the same old owner and let the later
 * one rename a fresh replacement. A well-formed owner is recovered only when it belongs to this
 * host and its PID is dead. A stale malformed lock represents an acquisition that never published
 * valid ownership metadata; work cannot have started before publication, so that reservation can
 * be quarantined after the stale grace period.
 */
async function removeLockIfAbandoned(lockPath: string, root: string): Promise<boolean> {
  return withRecoveryMutex(root, async () => {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(lockPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return true;
      throw error;
    }

    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;

    let owner: LockOwner | null;
    try {
      owner = await readLockOwner(lockPath);
    } catch {
      return quarantineAndDelete(lockPath, "abandoned-unpublished");
    }
    if (!owner) return true;
    if (owner.hostname !== os.hostname()) return false;
    if (processIsAlive(owner.pid)) return false;

    const quarantine = `${lockPath}.abandoned-${owner.token}-${randomUUID()}`;
    try {
      await fs.rename(lockPath, quarantine);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return true;
      throw error;
    }

    const movedOwner = await readLockOwner(quarantine);
    if (!movedOwner || movedOwner.token !== owner.token) {
      // Preserve the quarantined evidence rather than replacing a potentially new live lock.
      throw new Error(
        `Refusing to remove project-state lock '${lockPath}' because ownership changed during stale recovery.`,
      );
    }

    await fs.unlink(quarantine);
    return true;
  });
}

async function handleStillOwnsPath(
  handle: Awaited<ReturnType<typeof fs.open>>,
  lockPath: string,
): Promise<boolean> {
  try {
    const [handleStat, pathStat] = await Promise.all([handle.stat(), fs.stat(lockPath)]);
    return handleStat.dev === pathStat.dev && handleStat.ino === pathStat.ino;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function withFileLock<R>(
  targetPath: string,
  root: string,
  work: () => Promise<R>,
): Promise<R> {
  const lockPath = `${targetPath}.lock`;
  const startedAt = Date.now();
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now(),
  };
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

  while (!handle) {
    let createdReservation = false;
    try {
      handle = await fs.open(lockPath, "wx");
      createdReservation = true;
      await handle.writeFile(JSON.stringify(owner), "utf-8");
      await handle.sync();

      // A stalled writer can outlive the stale grace period before publishing metadata. Another
      // process may then quarantine that unpublished inode and acquire a fresh lock at lockPath.
      // Revalidate the directory entry against our open handle before mutation work starts so the
      // old writer never proceeds concurrently after losing its reservation.
      if (!(await handleStillOwnsPath(handle, lockPath))) {
        await handle.close().catch(() => undefined);
        handle = null;
        createdReservation = false;
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for project state lock '${lockPath}'.`);
        }
        await delay(LOCK_POLL_MS);
        continue;
      }
    } catch (error) {
      let ownsReservation = false;
      if (handle && createdReservation) {
        ownsReservation = await handleStillOwnsPath(handle, lockPath).catch(() => false);
      }
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = null;
      }
      if (ownsReservation) {
        // Only unlink the pathname if it still refers to the inode we created. Otherwise a stale
        // recovery may already have replaced it with another process's live reservation.
        await fs.unlink(lockPath).catch((unlinkError) => {
          if (!isErrno(unlinkError, "ENOENT")) throw unlinkError;
        });
      }
      if (!isErrno(error, "EEXIST")) throw error;
      if (await removeLockIfAbandoned(lockPath, root)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for project state lock '${lockPath}'.`);
      }
      await delay(LOCK_POLL_MS);
    }
  }

  const ownedHandle = handle;
  const heartbeat = setInterval(() => {
    const now = new Date();
    void ownedHandle.utimes(now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await ownedHandle.close().catch(() => undefined);

    const currentOwner = await readLockOwner(lockPath).catch(() => null);
    if (currentOwner?.token === owner.token) {
      const releasePath = `${lockPath}.released-${owner.token}`;
      try {
        await fs.rename(lockPath, releasePath);
        const releasedOwner = await readLockOwner(releasePath);
        if (releasedOwner?.token !== owner.token) {
          throw new Error(
            `Refusing to release project-state lock '${lockPath}' because ownership changed.`,
          );
        }
        await fs.unlink(releasePath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
  }
}

export class ProjectJsonStore<T> {
  private readonly tails = new Map<string, Promise<void>>();

  public constructor(
    private readonly root: string,
    private readonly fileName: string,
    private readonly empty: () => T,
    private readonly decode: JsonDecoder<T>,
    private readonly encode: JsonEncoder<T> = (value) => JSON.stringify(value, null, 2),
  ) {}

  private filePath(projectId: string): string {
    return path.join(projectDir(this.root, projectId), this.fileName);
  }

  private async readPath(filePath: string): Promise<T> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return this.empty();
      throw error;
    }

    return this.decode(raw);
  }

  public async read(projectId: string): Promise<T> {
    return this.readPath(this.filePath(projectId));
  }

  public async update<R>(
    projectId: string,
    mutate: (current: T) => JsonMutation<T, R> | Promise<JsonMutation<T, R>>,
  ): Promise<R> {
    const filePath = this.filePath(projectId);
    const previous = this.tails.get(filePath) ?? Promise.resolve();

    const run = previous
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        return withFileLock(filePath, this.root, async () => {
          const current = await this.readPath(filePath);
          const mutation = await mutate(current);
          await atomicWriteFile(filePath, this.encode(mutation.value));
          return mutation.result;
        });
      });

    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(filePath, tail);

    try {
      return await run;
    } finally {
      if (this.tails.get(filePath) === tail) {
        this.tails.delete(filePath);
      }
    }
  }
}
