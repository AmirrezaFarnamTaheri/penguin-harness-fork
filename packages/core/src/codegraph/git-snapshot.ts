import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import path from "node:path";

const OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const stderrLimit = 8 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type GitSnapshotErrorCode =
  | "invalid-revision"
  | "git-unavailable"
  | "git-command-failed"
  | "invalid-object-id"
  | "missing-object"
  | "invalid-object-response"
  | "binary-object"
  | "object-too-large"
  | "snapshot-too-large"
  | "invalid-tree"
  | "interrupted"
  | "timeout";

export class GitSnapshotError extends Error {
  readonly code: GitSnapshotErrorCode;
  readonly objectId?: string;
  readonly filePath?: string;
  readonly revision?: string;

  constructor(
    code: GitSnapshotErrorCode,
    message: string,
    details: { objectId?: string; filePath?: string; revision?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = "GitSnapshotError";
    this.code = code;
    this.objectId = details.objectId;
    this.filePath = details.filePath;
    this.revision = details.revision;
  }
}

export interface GitSnapshotReaderLimits {
  /** Maximum bytes returned by one `ls-tree` operation. Defaults to 16 MiB. */
  maxTreeBytes?: number;
  /** Maximum entries in either commit tree. Defaults to 50,000. */
  maxEntries?: number;
  /** Maximum materialized size of one unique blob. Defaults to 8 MiB. */
  maxObjectBytes?: number;
  /** Maximum combined size of unique blobs in a pair. Defaults to 64 MiB. */
  maxTotalBytes?: number;
  /** Maximum duration of each Git subprocess. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface GitSnapshotEntry {
  readonly path: string;
  readonly mode: string;
  readonly objectId: string;
  /** Shared by entries with the same object id. Treat these bytes as immutable. */
  readonly content: Buffer;
}

export interface GitCommitSnapshot {
  readonly requestedRevision: string;
  readonly commitId: string;
  readonly treeId: string;
  readonly entries: ReadonlyMap<string, GitSnapshotEntry>;
}

export type GitSnapshotChange =
  | { readonly status: "added"; readonly path: string; readonly after: GitSnapshotEntry }
  | { readonly status: "deleted"; readonly path: string; readonly before: GitSnapshotEntry }
  | {
      readonly status: "modified";
      readonly path: string;
      readonly before: GitSnapshotEntry;
      readonly after: GitSnapshotEntry;
    };

export interface GitSnapshotPair {
  readonly base: GitCommitSnapshot;
  readonly head: GitCommitSnapshot;
  readonly changes: readonly GitSnapshotChange[];
  /** Number of unique blob objects fetched for both commits. */
  readonly uniqueBlobCount: number;
  /** Total bytes fetched for those unique blobs. */
  readonly uniqueBlobBytes: number;
}

interface ResolvedTree {
  readonly requestedRevision: string;
  readonly commitId: string;
  readonly treeId: string;
  readonly entries: readonly {
    readonly path: string;
    readonly mode: string;
    readonly objectId: string;
  }[];
}

interface ProcessOptions {
  readonly input?: Buffer;
  readonly maxOutputBytes: number;
  readonly overflowCode: "object-too-large" | "snapshot-too-large";
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly revision?: string;
}

/**
 * Reads committed Git trees without checking them out or touching the working tree.
 * Blob ids shared by the two commits are fetched once with one `cat-file --batch` process.
 */
export class GitSnapshotReader {
  private readonly repositoryPath: string;
  private readonly limits: Required<GitSnapshotReaderLimits>;

  constructor(repositoryPath: string, limits: GitSnapshotReaderLimits = {}) {
    this.repositoryPath = path.resolve(repositoryPath);
    this.limits = {
      maxTreeBytes: limits.maxTreeBytes ?? 16 * 1024 * 1024,
      maxEntries: limits.maxEntries ?? 50_000,
      maxObjectBytes: limits.maxObjectBytes ?? 8 * 1024 * 1024,
      maxTotalBytes: limits.maxTotalBytes ?? 64 * 1024 * 1024,
      timeoutMs: limits.timeoutMs ?? 30_000,
    };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    if (this.limits.maxObjectBytes > this.limits.maxTotalBytes) {
      throw new RangeError("maxObjectBytes cannot exceed maxTotalBytes");
    }
  }

  async readPair(
    baseRevision: string,
    headRevision: string,
    options: {
      signal?: AbortSignal;
      /** Select source files before fetching blobs; excluded binary assets consume no blob budget. */
      includePath?: (filePath: string) => boolean;
    } = {},
  ): Promise<GitSnapshotPair> {
    const baseTree = await this.resolveTree(baseRevision, options.signal);
    const headTree = await this.resolveTree(headRevision, options.signal);
    const selectEntries = (tree: ResolvedTree): ResolvedTree => ({
      ...tree,
      entries: options.includePath
        ? tree.entries.filter((entry) => options.includePath!(entry.path))
        : tree.entries,
    });
    const selectedBase = selectEntries(baseTree);
    const selectedHead = selectEntries(headTree);
    const objectPaths = new Map<string, string>();
    for (const entry of [...selectedBase.entries, ...selectedHead.entries]) {
      if (!objectPaths.has(entry.objectId)) objectPaths.set(entry.objectId, entry.path);
    }
    const objectIds = [...objectPaths.keys()];
    const contents = await this.readBlobObjects(objectIds, objectPaths, options.signal);

    const makeSnapshot = (tree: ResolvedTree): GitCommitSnapshot => {
      const entries = new Map<string, GitSnapshotEntry>();
      for (const item of tree.entries) {
        const content = contents.get(item.objectId);
        if (!content) {
          throw new GitSnapshotError(
            "invalid-object-response",
            `Git returned no content for object ${item.objectId}`,
            { objectId: item.objectId, filePath: item.path },
          );
        }
        entries.set(item.path, { ...item, content });
      }
      return {
        requestedRevision: tree.requestedRevision,
        commitId: tree.commitId,
        treeId: tree.treeId,
        entries,
      };
    };

    const base = makeSnapshot(selectedBase);
    const head = makeSnapshot(selectedHead);
    const changes = compareSnapshots(base, head);
    let uniqueBlobBytes = 0;
    for (const content of contents.values()) uniqueBlobBytes += content.byteLength;
    return { base, head, changes, uniqueBlobCount: contents.size, uniqueBlobBytes };
  }

  private async resolveTree(revision: string, signal?: AbortSignal): Promise<ResolvedTree> {
    if (!revision || revision.length > 1024 || revision.includes("\0")) {
      throw new GitSnapshotError(
        "invalid-revision",
        "Git revision must be a non-empty, bounded string",
        {
          revision,
        },
      );
    }

    let commitId: string;
    try {
      const output = await this.runGit(
        ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
        { maxOutputBytes: 256, overflowCode: "snapshot-too-large", signal, revision },
      );
      commitId = output.toString("ascii").trim();
    } catch (error) {
      if (error instanceof GitSnapshotError && error.code === "git-command-failed") {
        throw new GitSnapshotError(
          "invalid-revision",
          `Git could not resolve revision ${revision}`,
          {
            revision,
            cause: error,
          },
        );
      }
      throw error;
    }
    if (!OID_PATTERN.test(commitId)) {
      throw new GitSnapshotError(
        "invalid-revision",
        `Git returned an invalid commit id for ${revision}`,
        {
          revision,
        },
      );
    }

    const treeOutput = await this.runGit(["rev-parse", "--verify", `${commitId}^{tree}`], {
      maxOutputBytes: 256,
      overflowCode: "snapshot-too-large",
      signal,
      revision,
    });
    const treeId = treeOutput.toString("ascii").trim();
    if (!OID_PATTERN.test(treeId) || treeId.length !== commitId.length) {
      throw new GitSnapshotError(
        "invalid-tree",
        `Git returned an invalid tree id for ${revision}`,
        {
          revision,
        },
      );
    }

    const tree = await this.runGit(["ls-tree", "-r", "-z", "--full-tree", treeId], {
      maxOutputBytes: this.limits.maxTreeBytes,
      overflowCode: "snapshot-too-large",
      signal,
      revision,
    });
    const entries = parseTree(tree, treeId, this.limits.maxEntries, revision);
    return { requestedRevision: revision, commitId, treeId, entries };
  }

  private async readBlobObjects(
    objectIds: readonly string[],
    objectPaths: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<Map<string, Buffer>> {
    if (objectIds.length === 0) return new Map();
    for (const objectId of objectIds) {
      if (!OID_PATTERN.test(objectId)) {
        throw new GitSnapshotError("invalid-object-id", `Invalid Git object id: ${objectId}`, {
          objectId,
        });
      }
    }

    const input = Buffer.from(`${objectIds.join("\n")}\n`, "ascii");
    const checked = await this.runGit(["cat-file", "--batch-check"], {
      input,
      maxOutputBytes: Math.min(this.limits.maxTreeBytes, objectIds.length * 128),
      overflowCode: "snapshot-too-large",
      signal,
    });
    const metadata = parseBatchCheck(checked, objectIds, objectPaths);
    let expectedBytes = 0;
    for (const item of metadata) {
      if (item.size > this.limits.maxObjectBytes) {
        throw new GitSnapshotError(
          "object-too-large",
          `Git object ${item.objectId} is ${item.size} bytes; limit is ${this.limits.maxObjectBytes}`,
          { objectId: item.objectId },
        );
      }
      if (item.size > this.limits.maxTotalBytes - expectedBytes) {
        throw new GitSnapshotError(
          "snapshot-too-large",
          `Unique Git blobs exceed the ${this.limits.maxTotalBytes}-byte pair limit`,
          { objectId: item.objectId },
        );
      }
      expectedBytes += item.size;
    }

    const output = await this.runGit(["cat-file", "--batch"], {
      input,
      maxOutputBytes: expectedBytes + objectIds.length * 128,
      overflowCode: "snapshot-too-large",
      signal,
    });
    const blobs = parseBatch(output, metadata);
    for (const [index, item] of metadata.entries()) {
      const content = blobs[index]!;
      const digest = createHash(item.objectId.length === 40 ? "sha1" : "sha256")
        .update(`blob ${content.byteLength}\0`)
        .update(content)
        .digest("hex");
      if (digest !== item.objectId) {
        throw new GitSnapshotError(
          "invalid-object-response",
          "Git blob content does not match its object id",
          {
            objectId: item.objectId,
            filePath: objectPaths.get(item.objectId),
          },
        );
      }
      if (content.includes(0)) {
        throw new GitSnapshotError(
          "binary-object",
          `Git blob ${item.objectId} contains binary data`,
          {
            objectId: item.objectId,
            filePath: objectPaths.get(item.objectId),
          },
        );
      }
    }
    return new Map(metadata.map((item, index) => [item.objectId, blobs[index]!]));
  }

  private runGit(args: readonly string[], options: ProcessOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(
          new GitSnapshotError("interrupted", "Git snapshot read was aborted", {
            revision: options.revision,
          }),
        );
        return;
      }

      let child;
      try {
        const env = { ...process.env };
        for (const name of Object.keys(env)) {
          if (
            /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_(KEY|VALUE)_\d+)$/i.test(
              name,
            )
          ) {
            delete env[name];
          }
        }
        env.GIT_NO_REPLACE_OBJECTS = "1";
        env.GIT_OPTIONAL_LOCKS = "0";
        child = spawn("git", ["--no-replace-objects", "-C", this.repositoryPath, ...args], {
          cwd: this.repositoryPath,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (cause) {
        reject(
          new GitSnapshotError("git-unavailable", "Unable to start Git", {
            revision: options.revision,
            cause,
          }),
        );
        return;
      }

      const output: Buffer[] = [];
      const errorOutput: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let forcedError: GitSnapshotError | undefined;
      let settled = false;
      const finish = (error?: GitSnapshotError, result?: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result ?? Buffer.alloc(0));
      };
      const terminate = (error: GitSnapshotError): void => {
        if (forcedError) return;
        forcedError = error;
        child.kill("SIGKILL");
      };
      const abort = (): void =>
        terminate(
          new GitSnapshotError("interrupted", "Git snapshot read was aborted", {
            revision: options.revision,
          }),
        );
      const timer = setTimeout(
        () =>
          terminate(
            new GitSnapshotError("timeout", "Git snapshot subprocess exceeded its time limit", {
              revision: options.revision,
            }),
          ),
        options.timeoutMs ?? this.limits.timeoutMs,
      );
      timer.unref?.();
      options.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > options.maxOutputBytes) {
          terminate(
            new GitSnapshotError(
              options.overflowCode,
              "Git snapshot subprocess exceeded its output limit",
              {
                revision: options.revision,
              },
            ),
          );
          return;
        }
        output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errorBytes >= stderrLimit) return;
        const accepted = chunk.subarray(0, stderrLimit - errorBytes);
        errorOutput.push(accepted);
        errorBytes += accepted.byteLength;
      });
      child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
        if (!forcedError && cause.code !== "EPIPE") {
          terminate(
            new GitSnapshotError("git-command-failed", "Could not send input to Git", {
              revision: options.revision,
              cause,
            }),
          );
        }
      });
      child.on("error", (cause: NodeJS.ErrnoException) => {
        finish(
          new GitSnapshotError(
            cause.code === "ENOENT" ? "git-unavailable" : "git-command-failed",
            cause.code === "ENOENT"
              ? "Git executable was not found"
              : "Git subprocess could not start",
            { revision: options.revision, cause },
          ),
        );
      });
      child.on("close", (exitCode: number | null, signalName: NodeJS.Signals | null) => {
        if (forcedError) {
          finish(forcedError);
          return;
        }
        if (signalName) {
          finish(
            new GitSnapshotError(
              "interrupted",
              `Git snapshot subprocess was interrupted (${signalName})`,
              {
                revision: options.revision,
              },
            ),
          );
          return;
        }
        if (exitCode !== 0) {
          const stderr = Buffer.concat(errorOutput).toString("utf8").trim();
          finish(
            new GitSnapshotError(
              "git-command-failed",
              `Git subprocess failed${stderr ? `: ${stderr}` : signalName ? ` (${signalName})` : ""}`,
              { revision: options.revision },
            ),
          );
          return;
        }
        finish(undefined, Buffer.concat(output, outputBytes));
      });
      if (options.input) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}

function parseTree(
  output: Buffer,
  treeId: string,
  maxEntries: number,
  revision: string,
): ResolvedTree["entries"] {
  if (output.byteLength === 0) return [];
  if (output[output.byteLength - 1] !== 0) {
    throw new GitSnapshotError("invalid-tree", `Git returned a truncated tree for ${revision}`, {
      revision,
    });
  }

  const entries: Array<{ path: string; mode: string; objectId: string }> = [];
  const seen = new Set<string>();
  let recordCount = 0;
  let start = 0;
  for (let end = 0; end < output.byteLength; end += 1) {
    if (output[end] !== 0) continue;
    recordCount += 1;
    if (recordCount > maxEntries) {
      throw new GitSnapshotError(
        "snapshot-too-large",
        `Tree ${treeId} has more than ${maxEntries} entries`,
        {
          revision,
        },
      );
    }
    const record = output.subarray(start, end);
    const tab = record.indexOf(9);
    if (tab <= 0 || tab === record.byteLength - 1) {
      throw new GitSnapshotError(
        "invalid-tree",
        `Git returned a malformed tree entry for ${revision}`,
        {
          revision,
        },
      );
    }
    const header = record.subarray(0, tab).toString("ascii").split(" ");
    if (header.length !== 3 || !/^[0-7]{6}$/.test(header[0]!) || !OID_PATTERN.test(header[2]!)) {
      throw new GitSnapshotError(
        "invalid-tree",
        `Git returned invalid tree metadata for ${revision}`,
        {
          revision,
        },
      );
    }
    const [mode, type, objectId] = header as [string, string, string];
    if (type === "commit" && mode === "160000") {
      start = end + 1;
      continue;
    }
    if (type !== "blob") {
      throw new GitSnapshotError("invalid-tree", `Tree entry has unsupported object type ${type}`, {
        objectId,
        revision,
      });
    }
    let filePath: string;
    try {
      filePath = utf8.decode(record.subarray(tab + 1));
    } catch (cause) {
      throw new GitSnapshotError("invalid-tree", `Tree path in ${revision} is not valid UTF-8`, {
        revision,
        cause,
      });
    }
    if (!isSafeGitPath(filePath) || seen.has(filePath)) {
      throw new GitSnapshotError(
        "invalid-tree",
        `Tree contains an unsafe or duplicate path: ${filePath}`,
        {
          filePath,
          revision,
        },
      );
    }
    seen.add(filePath);
    entries.push({ path: filePath, mode, objectId });
    start = end + 1;
  }
  return entries;
}

function isSafeGitPath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("\0"))
    return false;
  return filePath.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

interface BatchObjectMetadata {
  readonly objectId: string;
  readonly size: number;
}

function parseBatchCheck(
  output: Buffer,
  expectedOids: readonly string[],
  objectPaths: ReadonlyMap<string, string>,
): BatchObjectMetadata[] {
  const lines = output.toString("ascii").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== expectedOids.length) {
    throw new GitSnapshotError(
      "invalid-object-response",
      "Git returned the wrong number of batch metadata rows",
    );
  }
  return lines.map((line, index) => {
    const parts = line.split(" ");
    const expected = expectedOids[index]!;
    if (parts.length === 2 && parts[0] === expected && parts[1] === "missing") {
      throw new GitSnapshotError("missing-object", `Git object ${expected} is missing`, {
        objectId: expected,
        filePath: objectPaths.get(expected),
      });
    }
    if (
      parts.length !== 3 ||
      parts[0] !== expected ||
      parts[1] !== "blob" ||
      !/^\d+$/.test(parts[2]!)
    ) {
      throw new GitSnapshotError(
        "invalid-object-response",
        `Unexpected Git batch metadata for ${expected}`,
        {
          objectId: expected,
        },
      );
    }
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitSnapshotError(
        "invalid-object-response",
        `Invalid Git blob size for ${expected}`,
        {
          objectId: expected,
        },
      );
    }
    return { objectId: expected, size };
  });
}

function parseBatch(output: Buffer, metadata: readonly BatchObjectMetadata[]): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  for (const item of metadata) {
    const newline = output.indexOf(10, offset);
    if (newline < 0) {
      throw new GitSnapshotError(
        "invalid-object-response",
        `Git truncated the header for ${item.objectId}`,
        {
          objectId: item.objectId,
        },
      );
    }
    const header = output.toString("ascii", offset, newline).split(" ");
    if (
      header.length !== 3 ||
      header[0] !== item.objectId ||
      header[1] !== "blob" ||
      Number(header[2]) !== item.size
    ) {
      throw new GitSnapshotError(
        "invalid-object-response",
        `Git returned an inconsistent header for ${item.objectId}`,
        {
          objectId: item.objectId,
        },
      );
    }
    const contentStart = newline + 1;
    const contentEnd = contentStart + item.size;
    if (contentEnd >= output.byteLength || output[contentEnd] !== 10) {
      throw new GitSnapshotError(
        "invalid-object-response",
        `Git truncated the body for ${item.objectId}`,
        {
          objectId: item.objectId,
        },
      );
    }
    result.push(output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== output.byteLength) {
    throw new GitSnapshotError(
      "invalid-object-response",
      "Git returned trailing bytes after the object batch",
    );
  }
  return result;
}

function compareSnapshots(base: GitCommitSnapshot, head: GitCommitSnapshot): GitSnapshotChange[] {
  const paths = [...new Set([...base.entries.keys(), ...head.entries.keys()])].sort(
    compareCodepoints,
  );
  const changes: GitSnapshotChange[] = [];
  for (const filePath of paths) {
    const before = base.entries.get(filePath);
    const after = head.entries.get(filePath);
    if (!before && after) changes.push({ status: "added", path: filePath, after });
    else if (before && !after) changes.push({ status: "deleted", path: filePath, before });
    else if (
      before &&
      after &&
      (before.objectId !== after.objectId || before.mode !== after.mode)
    ) {
      changes.push({ status: "modified", path: filePath, before, after });
    }
  }
  return changes;
}

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
