import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteFile } from "../internal/atomic-write.js";
import { withFileLock } from "../internal/file-lock.js";
import { FindingsArchiveCapacityError, FindingsGraph } from "./findings-graph.js";
import { FindingValidationError } from "./validation.js";
import type { FindingMutationContext, FindingsGraphSnapshot } from "./types.js";

export const FINDINGS_HIGH_WATER_BYTES = 24 * 1024 * 1024;
export const FINDINGS_MAX_BYTES = 32 * 1024 * 1024;
export const FINDINGS_MAX_COUNT = 5000;
const CACHE_LIMIT = 8;
const cache = new Map<string, { revision: string; snapshot: FindingsGraphSnapshot }>();
const tails = new Map<string, Promise<void>>();
let parseCount = 0;

export interface FindingsScope {
  id: string;
  kind: "workspace" | "project";
  filePath: string;
}
export interface FindingsRecovery {
  state: "read-only";
  reason: "corrupt" | "unsupported-version" | "unreadable" | "capacity";
  message: string;
  quarantinePath?: string;
  quarantineError?: string;
}
export interface FindingsRead {
  scope: FindingsScope;
  revision: string;
  bytes: number;
  highWater: boolean;
  graph: FindingsGraph | null;
  recovery: FindingsRecovery | null;
}
export class FindingsRecoveryError extends Error {
  constructor(readonly read: FindingsRead) {
    super(read.recovery?.message ?? "Findings recovery is required.");
    this.name = "FindingsRecoveryError";
  }
}
export class FindingsRevisionError extends Error {
  constructor(readonly actualRevision: string) {
    super("Findings changed. Read the current revision before retrying.");
    this.name = "FindingsRevisionError";
  }
}
export class FindingsCapacityError extends Error {
  constructor() {
    super(
      "Findings capacity exceeded. Export the scope, then use authenticated pruning of terminal findings to recover capacity.",
    );
    this.name = "FindingsCapacityError";
  }
}

function errno(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function fingerprint(bytes: Uint8Array, scopeId: string): string {
  return createHash("sha256").update(scopeId).update("\0").update(bytes).digest("hex");
}
function freshGraph(snapshot?: FindingsGraphSnapshot): FindingsGraph {
  // Durable eviction writes its archive in the same atomic snapshot as the live graph.
  const graph = new FindingsGraph();
  if (snapshot) graph.importSnapshot(snapshot);
  return graph;
}

/** Resolve aliases even when the store or some of its parent directories do not exist yet. */
async function canonicalPath(filePath: string): Promise<string> {
  let ancestor = path.dirname(path.resolve(filePath));
  const suffix = [path.basename(filePath)];
  for (;;) {
    try {
      const resolved = await fs.realpath(ancestor);
      if (!(await fs.stat(resolved)).isDirectory())
        throw Object.assign(new Error("Findings parent must be a directory."), { code: "ENOTDIR" });
      return path.join(resolved, ...suffix);
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Strict store validation; the tolerant engine importer is only used after this gate. */
function decodeSnapshot(raw: Uint8Array): FindingsGraphSnapshot {
  parseCount++;
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Snapshot must be an object.");
  const snapshot = value as FindingsGraphSnapshot;
  if (snapshot.version !== 1) throw new Error("unsupported-version");
  if (
    !Array.isArray(snapshot.findings) ||
    (snapshot.events !== undefined && !Array.isArray(snapshot.events))
  )
    throw new Error("Invalid snapshot collections.");
  const graph = freshGraph();
  const restored = graph.importSnapshot(snapshot);
  if (
    restored.skipped ||
    restored.imported !== snapshot.findings.length ||
    graph.list().length !== snapshot.findings.length
  )
    throw new Error("Snapshot contains malformed or duplicate findings.");
  const ids = new Set(snapshot.findings.map((f) => f.id));
  if (ids.size !== snapshot.findings.length) throw new Error("Duplicate finding IDs.");
  for (const finding of snapshot.findings)
    for (const e of finding.evidence) {
      if (
        (e.path !== undefined && typeof e.path !== "string") ||
        (e.quote !== undefined && typeof e.quote !== "string") ||
        (e.note !== undefined && typeof e.note !== "string") ||
        (e.line !== undefined && (!Number.isSafeInteger(e.line) || e.line < 0))
      )
        throw new Error("Malformed stored evidence.");
    }
  const events = snapshot.events ?? [];
  if (graph.since().length !== Math.min(events.length, 2000))
    throw new Error("Snapshot contains malformed events.");
  let previous = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous)
      throw new Error("Event sequences must increase.");
    previous = event.seq;
  }
  return graph.exportSnapshot();
}

/** One authority file per explicit scope. Sharing paths never invents a project/workspace binding. */
export class FindingsStore {
  constructor(readonly scope: FindingsScope) {
    if (!scope.id.trim() || !path.isAbsolute(scope.filePath))
      throw new Error("Findings scope requires an ID and absolute authority path.");
  }

  private async preserve(
    target: string,
    bytes: Uint8Array,
    mode: number,
    label: string,
  ): Promise<string> {
    const backup = `${target}.${label}-${Date.now()}-${randomUUID()}`;
    const handle = await fs.open(backup, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return backup;
  }

  /**
   * One quarantine copy per damaged revision. Reads of a corrupt authority repeat, so a fresh
   * copy per read would let ordinary queries consume unbounded disk. A pre-existing copy is
   * reused only when it is a regular file holding the same bytes; otherwise a unique copy is
   * written so the original bytes are always preserved.
   */
  private async quarantine(
    target: string,
    bytes: Uint8Array,
    mode: number,
    revision: string,
  ): Promise<string> {
    const quarantinePath = `${target}.quarantine-${revision.slice(0, 32)}`;
    let handle;
    try {
      handle = await fs.open(quarantinePath, "wx", 0o600);
    } catch (error) {
      if (!errno(error, "EEXIST")) throw error;
    }
    if (handle) {
      let written = false;
      try {
        await handle.writeFile(bytes);
        await handle.chmod(mode & 0o777);
        await handle.sync();
        written = true;
      } finally {
        await handle.close();
        if (!written) await fs.rm(quarantinePath, { force: true });
      }
      return quarantinePath;
    }
    try {
      const existing = await fs.lstat(quarantinePath);
      if (existing.isFile() && !existing.isSymbolicLink()) {
        const preserved = await fs.readFile(quarantinePath);
        if (fingerprint(preserved, this.scope.id) === revision) return quarantinePath;
      }
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
    }
    return this.preserve(target, bytes, mode, "quarantine");
  }

  private async preserveFile(target: string, mode: number, label: string): Promise<string> {
    const backup = `${target}.${label}-${Date.now()}-${randomUUID()}`;
    await fs.copyFile(target, backup, constants.COPYFILE_EXCL);
    const handle = await fs.open(backup, "r+");
    try {
      await handle.chmod(mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return backup;
  }

  private async openAuthority(target: string) {
    const original = await fs.lstat(target);
    if (!original.isFile() || original.isSymbolicLink())
      throw new Error("Findings authority must be a regular file.");
    const handle = await fs.open(target, "r");
    try {
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== original.dev || actual.ino !== original.ino)
        throw new Error("Findings authority changed while opening it.");
      return { handle, stat: actual };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async readPath(target: string): Promise<FindingsRead> {
    let bytes: Uint8Array;
    let mode = 0o600;
    try {
      const { handle, stat } = await this.openAuthority(target);
      mode = stat.mode;
      // Read through an open descriptor so atomic replacement cannot mix metadata and contents.
      try {
        if (stat.size > FINDINGS_MAX_BYTES) {
          const hash = createHash("sha256").update(this.scope.id).update("\0");
          const chunk = Buffer.alloc(64 * 1024);
          let offset = 0;
          while (offset < stat.size) {
            const { bytesRead } = await handle.read(
              chunk,
              0,
              Math.min(chunk.length, stat.size - offset),
              offset,
            );
            if (!bytesRead) break;
            hash.update(chunk.subarray(0, bytesRead));
            offset += bytesRead;
          }
          return {
            scope: this.scope,
            revision: hash.digest("hex"),
            bytes: offset,
            highWater: true,
            graph: null,
            recovery: {
              state: "read-only",
              reason: "capacity",
              message:
                "Findings exceed the 32 MiB read/write ceiling. Export raw pages, then restore a smaller snapshot or explicitly reset with acknowledgement.",
            },
          };
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errno(error, "ENOENT"))
        return {
          scope: this.scope,
          revision: fingerprint(new Uint8Array(), this.scope.id),
          bytes: 0,
          highWater: false,
          graph: freshGraph(),
          recovery: null,
        };
      return {
        scope: this.scope,
        revision: "unreadable",
        bytes: 0,
        highWater: false,
        graph: null,
        recovery: {
          state: "read-only",
          reason: "unreadable",
          message: `Unable to read findings: ${describe(error)}`,
        },
      };
    }
    const revision = fingerprint(bytes, this.scope.id);
    const result = {
      scope: this.scope,
      revision,
      bytes: bytes.byteLength,
      highWater: bytes.byteLength >= FINDINGS_HIGH_WATER_BYTES,
    };
    const cached = cache.get(target);
    if (cached?.revision === revision) {
      cache.delete(target);
      cache.set(target, cached);
      return { ...result, graph: freshGraph(cached.snapshot), recovery: null };
    }
    cache.delete(target);
    try {
      const snapshot = decodeSnapshot(bytes);
      cache.set(target, { revision, snapshot });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return { ...result, graph: freshGraph(snapshot), recovery: null };
    } catch (error) {
      const recovery: FindingsRecovery = {
        state: "read-only",
        reason: describe(error) === "unsupported-version" ? "unsupported-version" : "corrupt",
        message: `Findings require recovery; normal mutations are disabled: ${describe(error)}`,
      };
      try {
        recovery.quarantinePath = await this.quarantine(target, bytes, mode, revision);
      } catch (failure) {
        recovery.quarantineError = describe(failure);
      }
      return { ...result, graph: null, recovery };
    }
  }

  async read(): Promise<FindingsRead> {
    try {
      return await this.readPath(await canonicalPath(this.scope.filePath));
    } catch (error) {
      return {
        scope: this.scope,
        revision: "unreadable",
        bytes: 0,
        highWater: false,
        graph: null,
        recovery: {
          state: "read-only",
          reason: "unreadable",
          message: `Unable to resolve findings authority: ${describe(error)}`,
        },
      };
    }
  }

  private async locked<R>(work: (target: string) => Promise<R>): Promise<R> {
    const target = await canonicalPath(this.scope.filePath);
    const previous = tails.get(target) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        return withFileLock(target, path.dirname(target), () => work(target));
      });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(target, tail);
    try {
      return await run;
    } finally {
      if (tails.get(target) === tail) tails.delete(target);
    }
  }

  private async commit(target: string, graph: FindingsGraph): Promise<void> {
    const snapshot = graph.exportSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (
      snapshot.findings.length > FINDINGS_MAX_COUNT ||
      Buffer.byteLength(serialized, "utf8") > FINDINGS_MAX_BYTES
    )
      throw new FindingsCapacityError();
    // A callback cannot make malformed state durable by bypassing the public report validator.
    decodeSnapshot(Buffer.from(serialized));
    try {
      await atomicWriteFile(target, serialized);
    } finally {
      cache.delete(target);
    }
  }

  async update<R>(
    expectedRevision: string | undefined,
    mutation: (graph: FindingsGraph) => R | Promise<R>,
  ): Promise<R> {
    return this.locked(async (target) => {
      const current = await this.readPath(target);
      if (current.recovery || !current.graph) throw new FindingsRecoveryError(current);
      if (expectedRevision !== undefined && expectedRevision !== current.revision)
        throw new FindingsRevisionError(current.revision);
      let result: R;
      try {
        result = await mutation(current.graph);
      } catch (error) {
        if (error instanceof FindingsArchiveCapacityError) throw new FindingsCapacityError();
        throw error;
      }
      await this.commit(target, current.graph);
      return result;
    });
  }

  async rawPage(
    offset = 0,
    limit = 4096,
  ): Promise<{ data: string; offset: number; nextOffset: number | null; bytes: number }> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64 * 1024
    )
      throw new Error("Invalid raw export page.");
    const target = await canonicalPath(this.scope.filePath);
    const { handle } = await this.openAuthority(target);
    try {
      const stat = await handle.stat();
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, offset);
      const next = offset + bytesRead;
      return {
        data: buffer.subarray(0, bytesRead).toString("base64"),
        offset,
        nextOffset: next < stat.size ? next : null,
        bytes: stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  private requireHuman(context: FindingMutationContext, reason: string): void {
    if (
      context.actor?.kind !== "user" ||
      !context.actor.id.trim() ||
      context.method === "tool" ||
      !reason.trim()
    )
      throw new FindingValidationError(
        "Recovery requires an authenticated human and a non-empty reason.",
      );
  }

  /** Reset/restore require the revision shown to the operator and preserve all previous bytes. */
  async recover(
    operation: "reset" | "restore",
    expectedRevision: string,
    reason: string,
    context: FindingMutationContext,
    backup?: Uint8Array,
  ): Promise<void> {
    this.requireHuman(context, reason);
    await this.locked(async (target) => {
      const current = await this.readPath(target);
      if (current.revision !== expectedRevision || current.revision === "unreadable")
        throw new FindingsRevisionError(current.revision);
      let graph = freshGraph();
      if (operation === "restore") {
        if (!backup || backup.byteLength > FINDINGS_MAX_BYTES)
          throw new FindingValidationError(
            "Restore snapshot exceeds the 32 MiB ceiling or is missing.",
          );
        try {
          graph = freshGraph(decodeSnapshot(backup));
        } catch (error) {
          throw new FindingValidationError(`Invalid restore snapshot: ${describe(error)}`);
        }
      }
      let preserved: string | undefined;
      try {
        const stat = await fs.lstat(target);
        preserved = await this.preserveFile(target, stat.mode, "recovery-backup");
      } catch (error) {
        if (!errno(error, "ENOENT")) throw error;
      }
      const snapshot = graph.exportSnapshot();
      snapshot.events ??= [];
      snapshot.events.push({
        seq: (snapshot.events.at(-1)?.seq ?? 0) + 1,
        type: "update",
        findingId: "__scope__",
        at: Date.now(),
        actor: { ...context.actor! },
        method: context.method ?? "engine",
        note: JSON.stringify({
          operation,
          reason: reason.trim(),
          previousRevision: current.revision,
          preserved,
          operationId: randomUUID(),
        }),
      });
      await this.commit(target, freshGraph(snapshot));
    });
  }

  /** Explicit operator pruning keeps a full backup and removes only terminal claims. */
  async prune(
    ids: readonly string[],
    expectedRevision: string,
    reason: string,
    context: FindingMutationContext,
  ): Promise<void> {
    this.requireHuman(context, reason);
    if (!ids.length || ids.length > 500 || new Set(ids).size !== ids.length)
      throw new FindingValidationError("Select between 1 and 500 distinct terminal findings.");
    await this.locked(async (target) => {
      const current = await this.readPath(target);
      if (current.recovery || !current.graph) throw new FindingsRecoveryError(current);
      if (expectedRevision !== current.revision) throw new FindingsRevisionError(current.revision);
      const snapshot = current.graph.exportSnapshot();
      const selected = new Set(ids);
      for (const id of ids) {
        const finding = current.graph.get(id);
        if (!finding || (finding.status !== "refuted" && finding.status !== "superseded"))
          throw new FindingValidationError("Only existing terminal findings can be pruned.");
      }
      const stat = await fs.lstat(target);
      const preserved = await this.preserveFile(target, stat.mode, "prune-backup");
      snapshot.findings = snapshot.findings.filter((f) => !selected.has(f.id));
      for (const finding of snapshot.findings) {
        finding.related = finding.related.filter((id) => !selected.has(id));
        if (finding.contradicts)
          finding.contradicts = finding.contradicts.filter((id) => !selected.has(id));
        if (finding.supersededBy && selected.has(finding.supersededBy)) delete finding.supersededBy;
      }
      snapshot.events ??= [];
      snapshot.events.push({
        seq: (snapshot.events.at(-1)?.seq ?? 0) + 1,
        type: "update",
        findingId: "__scope__",
        at: Date.now(),
        actor: { ...context.actor! },
        method: context.method ?? "engine",
        note: JSON.stringify({
          operation: "prune",
          ids,
          reason,
          preserved,
          operationId: randomUUID(),
        }),
      });
      await this.commit(target, freshGraph(snapshot));
    });
  }

  static cacheStats(): { entries: number; limit: number; pending: number; parses: number } {
    return { entries: cache.size, limit: CACHE_LIMIT, pending: tails.size, parses: parseCount };
  }
}
