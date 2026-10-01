import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "../internal/atomic-write.js";
import type { TopologyEdge, TopologyNode } from "./types.js";
import type { BuildStats, TopologySnapshot } from "./topology-engine.js";

/** Bump when the persisted topology snapshot contract changes incompatibly. */
export const CODEGRAPH_SCHEMA_VERSION = 1;
export const DEFAULT_GRAPH_STORE_MAX_BYTES = 64 * 1024 * 1024;

export type GraphStoreRead<T> =
  | { status: "hit"; value: T }
  | { status: "missing" }
  | { status: "unsupported-version"; storedVersion: number }
  | {
      status: "corrupt";
      reason: "not-a-file" | "oversized" | "invalid-envelope" | "checksum" | "invalid-value";
    };

/** Persistence contract for derived graphs. Implementations own every byte of serialization. */
export interface GraphStore<T> {
  load(): Promise<GraphStoreRead<T>>;
  save(value: T, options?: { signal?: AbortSignal }): Promise<void>;
  /** Remove only this derived cache file; source files and repository state are never touched. */
  clear(): Promise<void>;
}

export interface FileGraphStoreOptions {
  schemaVersion?: number;
  maxBytes?: number;
}

interface GraphStoreEnvelope {
  format: "penguin-codegraph-snapshot";
  schemaVersion: number;
  checksum: string;
  payload: string;
}

const writeQueues = new Map<string, Promise<void>>();

/**
 * Checksummed, versioned graph snapshots with atomic replacement. A rejected snapshot is a
 * cache miss the caller can rebuild; it is never returned as a partially trusted graph.
 */
export class FileGraphStore<T> implements GraphStore<T> {
  private readonly schemaVersion: number;
  private readonly maxBytes: number;

  constructor(
    private readonly filePath: string,
    private readonly validate: (value: unknown) => value is T,
    options: FileGraphStoreOptions = {},
  ) {
    this.schemaVersion = options.schemaVersion ?? CODEGRAPH_SCHEMA_VERSION;
    this.maxBytes = options.maxBytes ?? DEFAULT_GRAPH_STORE_MAX_BYTES;
    if (!path.isAbsolute(filePath)) throw new TypeError("Graph store path must be absolute");
    if (!Number.isSafeInteger(this.schemaVersion) || this.schemaVersion < 1)
      throw new RangeError("Graph store schema version must be a positive safe integer");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
      throw new RangeError("Graph store byte limit must be a positive safe integer");
  }

  async load(): Promise<GraphStoreRead<T>> {
    let handle;
    try {
      const linkInfo = await lstat(this.filePath);
      if (linkInfo.isSymbolicLink()) return { status: "corrupt", reason: "not-a-file" };
      handle = await open(this.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      if ((error as NodeJS.ErrnoException).code === "ELOOP")
        return { status: "corrupt", reason: "not-a-file" };
      throw error;
    }

    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { status: "corrupt", reason: "not-a-file" };
      if (stat.size > this.maxBytes) return { status: "corrupt", reason: "oversized" };
      const chunks: Buffer[] = [];
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes + 1));
      let totalBytes = 0;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
        if (bytesRead === 0) break;
        totalBytes += bytesRead;
        if (totalBytes > this.maxBytes) return { status: "corrupt", reason: "oversized" };
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      bytes = Buffer.concat(chunks, totalBytes);
    } finally {
      await handle.close();
    }
    if (bytes.byteLength > this.maxBytes) return { status: "corrupt", reason: "oversized" };

    let envelope: unknown;
    try {
      envelope = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { status: "corrupt", reason: "invalid-envelope" };
    }
    if (!isEnvelope(envelope)) return { status: "corrupt", reason: "invalid-envelope" };
    if (envelope.schemaVersion !== this.schemaVersion)
      return { status: "unsupported-version", storedVersion: envelope.schemaVersion };

    const expected = Buffer.from(envelope.checksum, "hex");
    const actual = createHash("sha256").update(envelope.payload, "utf8").digest();
    if (!timingSafeEqual(expected, actual)) return { status: "corrupt", reason: "checksum" };

    let value: unknown;
    try {
      value = JSON.parse(envelope.payload);
    } catch {
      return { status: "corrupt", reason: "invalid-value" };
    }
    return this.validate(value)
      ? { status: "hit", value }
      : { status: "corrupt", reason: "invalid-value" };
  }

  async save(value: T, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.validate(value)) throw new TypeError("Refusing to persist an invalid graph snapshot");
    let payload: string | undefined;
    try {
      payload = JSON.stringify(value);
    } catch (error) {
      throw new TypeError("Graph snapshot is not JSON serializable", { cause: error });
    }
    if (payload === undefined) throw new TypeError("Graph snapshot is not JSON serializable");
    const envelope: GraphStoreEnvelope = {
      format: "penguin-codegraph-snapshot",
      schemaVersion: this.schemaVersion,
      checksum: createHash("sha256").update(payload, "utf8").digest("hex"),
      payload,
    };
    const encoded = JSON.stringify(envelope);
    if (Buffer.byteLength(encoded, "utf8") > this.maxBytes)
      throw new RangeError("Graph snapshot exceeds the configured byte limit");
    await serializeForPath(this.filePath, async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await atomicWriteFile(this.filePath, encoded, { mode: 0o600, ...options });
    });
  }

  async clear(): Promise<void> {
    await serializeForPath(this.filePath, () => rm(this.filePath, { force: true }));
  }
}

/** Windows rejects concurrent rename-over-existing operations; serialize writers per target. */
function serializeForPath<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, tail);
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return current;
}

/** File-backed store for the public topology snapshot shape. */
export function createTopologyGraphStore(
  filePath: string,
  options: FileGraphStoreOptions = {},
): FileGraphStore<TopologySnapshot> {
  return new FileGraphStore(filePath, isTopologySnapshot, options);
}

export function isTopologySnapshot(value: unknown): value is TopologySnapshot {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
  if (!isBuildStats(value.stats)) return false;
  const nodes = value.nodes as unknown[];
  const edges = value.edges as unknown[];
  if (!nodes.every(isTopologyNode) || !edges.every(isTopologyEdge)) return false;

  const ids = new Set<string>();
  for (const node of nodes as TopologyNode[]) {
    if (ids.has(node.id)) return false;
    ids.add(node.id);
  }
  if ((value.stats as BuildStats).edges !== edges.length) return false;
  if ((value.stats as BuildStats).callEdges !== edges.filter(isCallEdge).length) return false;
  if ((value.stats as BuildStats).importEdges !== edges.filter(isImportEdge).length) return false;
  return (edges as TopologyEdge[]).every((edge) => ids.has(edge.source) && ids.has(edge.target));
}

function isEnvelope(value: unknown): value is GraphStoreEnvelope {
  return (
    isRecord(value) &&
    value.format === "penguin-codegraph-snapshot" &&
    Number.isSafeInteger(value.schemaVersion) &&
    (value.schemaVersion as number) > 0 &&
    typeof value.checksum === "string" &&
    /^[a-f0-9]{64}$/.test(value.checksum) &&
    typeof value.payload === "string"
  );
}

function isBuildStats(value: unknown): value is BuildStats {
  return (
    isRecord(value) &&
    ["files", "symbols", "edges", "callEdges", "importEdges", "parseMs"].every(
      (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
    )
  );
}

function isTopologyNode(value: unknown): value is TopologyNode {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    typeof value.filePath !== "string" ||
    typeof value.kind !== "string" ||
    !NODE_KINDS.has(value.kind)
  )
    return false;
  return (
    optionalNonNegativeInteger(value.startLine) &&
    optionalNonNegativeInteger(value.endLine) &&
    optionalString(value.qualifiedName) &&
    optionalNonNegativeNumber(value.complexity)
  );
}

function isTopologyEdge(value: unknown): value is TopologyEdge {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.target === "string" &&
    typeof value.kind === "string" &&
    EDGE_KINDS.has(value.kind) &&
    optionalPositiveInteger(value.line) &&
    optionalString(value.callName) &&
    (value.callType === undefined || value.callType === "simple" || value.callType === "attribute")
  );
}

const NODE_KINDS = new Set([
  "file",
  "module",
  "class",
  "struct",
  "interface",
  "trait",
  "enum",
  "type",
  "function",
  "method",
]);

const EDGE_KINDS = new Set([
  "contains",
  "calls",
  "imports",
  "exports",
  "extends",
  "implements",
  "references",
  "inherits",
  "defines",
  "uses",
]);

function isCallEdge(edge: unknown): boolean {
  return isRecord(edge) && edge.kind === "calls";
}

function isImportEdge(edge: unknown): boolean {
  return isRecord(edge) && edge.kind === "imports";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
