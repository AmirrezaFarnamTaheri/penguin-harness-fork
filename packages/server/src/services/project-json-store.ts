import path from "node:path";
import fs from "node:fs/promises";
import { atomicWriteFile, projectDir, withFileLock } from "@prismshadow/penguin-core";

export interface JsonMutation<T, R> {
  value: T;
  result: R;
}

export type JsonDecoder<T> = (raw: string) => T;
export type JsonEncoder<T> = (value: T) => string;

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
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
