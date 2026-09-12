import path from "node:path";
import fs from "node:fs/promises";
import { atomicWriteFile, projectDir } from "@prismshadow/penguin-core";

export interface JsonMutation<T, R> {
  value: T;
  result: R;
}

export type JsonDecoder<T> = (raw: string) => T;
export type JsonEncoder<T> = (value: T) => string;

const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 25;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeLockIfStale(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false;
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    throw error;
  }
}

async function withFileLock<R>(targetPath: string, work: () => Promise<R>): Promise<R> {
  const lockPath = `${targetPath}.lock`;
  const startedAt = Date.now();
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (await removeLockIfStale(lockPath)) continue;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for project state lock '${lockPath}'.`);
      }
      await delay(LOCK_POLL_MS);
    }
  }

  try {
    return await work();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

/**
 * Small durable JSON repository for per-project route state.
 *
 * - Reads distinguish an absent file from corruption/permission failures.
 * - Mutations are serialized in-process and by an on-disk lock across processes.
 * - Every mutation reloads durable state while holding the lock, then atomically replaces it.
 * - No mutable in-memory snapshot is published before hydration or retained after a write failure.
 */
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

    // Deliberately let decoder/JSON errors propagate. A corrupt source is evidence to preserve,
    // not an empty store that a subsequent request may overwrite.
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
        return withFileLock(filePath, async () => {
          const current = await this.readPath(filePath);
          const mutation = await mutate(current);
          await atomicWriteFile(filePath, this.encode(mutation.value));
          return mutation.result;
        });
      });

    const tail = run.then(() => undefined, () => undefined);
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
