/**
 * Copy-on-write virtual filesystem backend.
 *
 * Ports three things from the donors and welds them:
 * - the path algebra and null-byte / symlink-depth guards from the in-memory bash
 *   implementation's `path-utils.ts`;
 * - the traversal budget, alias-resistant identity comparison, and iterative
 *   symlink-cycle detection from its `traversal.ts`;
 * - the copy-on-write *model* — a read-through lower layer, a writable upper layer,
 *   and tombstones for deletion — from the userspace syscall virtualizer's
 *   `fs/backend/cow.zig` and `OverlayRoot.zig`.
 *
 * What is deliberately not ported is the Linux-specific plumbing: that
 * implementation holds real kernel file descriptors in a `readthrough | writecopy`
 * union and resolves overlay paths under `/tmp/.bvisor/sb/{uid}/cow`. This backend
 * keeps the union's *semantics* — a file is either still backed by the lower layer
 * or has been promoted into the writable layer — but the backing store is a lower
 * `IFileSystem` and an in-memory `Map`, so it works on every platform the harness
 * runs on and writes never reach host disk.
 *
 * The security property this module exists for is the one the donor documented:
 * reads come from the lower layer, writes stay in memory, and no path can escape
 * the validation root. Every entry point canonicalizes first, so a `..` traversal
 * or a symlink pointing outside is caught by containment rather than by a
 * best-effort check afterwards.
 */

import type { ExecutionLimits } from "./execution-limits.js";
import { resolveLimits } from "./execution-limits.js";

/** Maximum depth for symlink resolution loops (POSIX's own limit is 8; donors used 40). */
export const MAX_SYMLINK_DEPTH = 40;

/** Fixed timestamp on the always-present root directory: it was never written. */
const ROOT_MTIME = new Date(0);

/** Default directory permissions. */
export const DEFAULT_DIR_MODE = 0o755;

/** Default file permissions. */
export const DEFAULT_FILE_MODE = 0o644;

/** Default symlink permissions. */
export const SYMLINK_MODE = 0o777;

/** Maximum path length accepted, mirroring the donor's 512-byte stack buffer. */
export const MAX_PATH_LENGTH = 512;

/**
 * Normalize a virtual path: resolve `.` and `..`, ensure it starts with `/`, strip
 * trailing slashes. Pure, no I/O — which is why every other function here can call
 * it *before* touching any store, and why a traversal attempt is resolved away
 * before it is ever compared to the root.
 */
export function normalizePath(path: string): string {
  if (!path || path === "/") return "/";

  let normalized = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  const parts = normalized.split("/").filter((p) => p && p !== ".");
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return `/${resolved.join("/")}` || "/";
}

/** True when candidate is the same virtual path as parent or below it. */
export function isSameOrDescendantPath(parent: string, candidate: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedCandidate = normalizePath(candidate);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedParent === "/" ||
    normalizedCandidate.startsWith(`${normalizedParent}/`)
  );
}

/**
 * Reject paths containing null bytes. A null byte truncates a filename at the
 * kernel boundary and is the classic way to bypass a filter that matched a longer
 * string, so it is refused outright rather than tolerated as data.
 */
export function validatePath(path: string, operation: string): void {
  if (path.includes("\0")) {
    throw new Error(`ENOENT: path contains null byte, ${operation} '${path}'`);
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw new Error(`ENAMETOOLONG: path exceeds ${MAX_PATH_LENGTH} bytes, ${operation}`);
  }
}

/** Directory name of a normalized virtual path. */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}

/** Resolve a relative path against a base; absolute paths are normalized as-is. */
export function resolvePath(base: string, path: string): string {
  if (path.startsWith("/")) {
    return normalizePath(path);
  }
  const combined = base === "/" ? `/${path}` : `${base}/${path}`;
  return normalizePath(combined);
}

/** Join a parent path with a child name, handling the root edge case. */
export function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

/** Resolve a symlink target relative to the symlink's own directory. */
export function resolveSymlinkTarget(symlinkPath: string, target: string): string {
  if (target.startsWith("/")) {
    return normalizePath(target);
  }
  const dir = dirname(symlinkPath);
  return normalizePath(joinPath(dir, target));
}

/** A branded canonical path: proven to be inside a validation root. */
declare const canonicalPathBrand: unique symbol;
export type CanonicalPath = string & { readonly [canonicalPathBrand]: true };

export interface CanonicalPathPolicy {
  readonly root: string;
}

export class FileSystemPolicyError extends Error {
  readonly name = "FileSystemPolicyError";
  constructor(
    readonly operation: string,
    readonly virtualPath: string,
    message: string,
  ) {
    super(`${operation}: ${message}`);
  }
}

/**
 * Canonicalize a path and prove it is inside the policy root. The brand exists so a
 * caller that wants a definitely-contained path gets one from the type system, and a
 * caller that wants to check an untrusted path has to call this rather than assert.
 */
export async function canonicalizePath(
  fs: IFileSystem,
  path: string,
  policy: CanonicalPathPolicy,
): Promise<CanonicalPath> {
  const canonical = normalizePath(await fs.realpath(path));
  if (!isSameOrDescendantPath(policy.root, canonical)) {
    throw new FileSystemPolicyError(
      "canonicalize",
      path,
      `path resolves outside the permitted root (${canonical} is not under ${policy.root})`,
    );
  }
  return canonical as CanonicalPath;
}

export type SameFileResult = "same" | "different" | "unknown";
export type PathContainmentResult = "inside" | "outside" | "unknown";

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: Date;
  /** Alias-resistant identity (inode-style) when the backend can supply one. */
  identity?: string;
  dev?: number;
  ino?: number;
}

export interface ReadFileOptions {
  encoding?: "utf-8" | "base64" | "buffer";
}

export interface WriteFileOptions {
  mode?: number;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

/**
 * The filesystem interface the COW backend sits on, and the one it implements. A
 * lower layer is anything that can answer these; the COW backend is one itself, so
 * overlays can be stacked.
 */
export interface IFileSystem {
  stat(path: string): Promise<FsStat | undefined>;
  lstat(path: string): Promise<FsStat | undefined>;
  realpath(path: string): Promise<string>;
  readFile(path: string, options?: ReadFileOptions): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(path: string): Promise<string | undefined>;
}

interface MemoryFile {
  type: "file";
  content: Uint8Array;
  mode: number;
  mtime: Date;
  identity: string;
}
interface MemoryDir {
  type: "directory";
  mode: number;
  mtime: Date;
  identity: string;
}
interface MemorySymlink {
  type: "symlink";
  target: string;
  mode: number;
  mtime: Date;
  identity: string;
}
type MemoryEntry = MemoryFile | MemoryDir | MemorySymlink;

export interface CowFsOptions {
  /** The read-only lower layer. Reads for un-promoted paths come from here. */
  lower?: IFileSystem;
  /** Root that every path must stay inside. Defaults to `/`. */
  root?: string;
  /** Mount point the root appears at. Defaults to `/`. */
  mountPoint?: string;
  /** When true, every write throws EROFS. */
  readOnly?: boolean;
  /** Maximum bytes the writable layer may retain. Defaults to 1 GiB. */
  maxMemoryBytes?: number;
  /** Maximum bytes read from the lower layer in one readFile. Defaults to 10 MiB. */
  maxFileReadSize?: number;
  /** Whether to follow symlinks when resolving. Defaults to false (deny). */
  allowSymlinks?: boolean;
  /** Limits source for the traversal budget defaults. */
  limits?: ExecutionLimits;
  /** Aborts a traversal. */
  signal?: AbortSignal;
}

/** Error patterns safe to surface: they name virtual paths, not real ones. */
const PASSTHROUGH_ERRORS = ["ELOOP", "EFBIG", "EPERM", "ENAMETOOLONG"] as const;

export function sanitizeErrorMessage(message: string): string {
  // A real-filesystem error can contain the host path of the lower layer, which is
  // information a sandboxed script has no business reading. Virtual paths survive.
  if (PASSTHROUGH_ERRORS.some((code) => message.includes(code))) return message;
  return message.replace(/(?:file|dir|path) '[^']+'/g, "path");
}

/**
 * The copy-on-write backend. Every mutating operation promotes the affected path
 * into the writable layer first — that promotion is the "copy" — so the lower layer
 * is never observed in a state the script created.
 */
export class CowFsBackend implements IFileSystem {
  private readonly upper = new Map<string, MemoryEntry>();
  /** Paths deleted by the script. A tombstone shadows the lower layer's entry. */
  private readonly tombstones = new Set<string>();
  private readonly root: string;
  private readonly mountPoint: string;
  private readonly lower?: IFileSystem;
  private readonly readOnly: boolean;
  private readonly maxMemoryBytes: number;
  private readonly maxFileReadSize: number;
  private readonly allowSymlinks: boolean;
  private retainedBytes = 0;
  private nextIdentity = 0;

  constructor(options: CowFsOptions = {}) {
    this.lower = options.lower;
    this.root = normalizePath(options.root ?? "/");
    this.mountPoint = normalizePath(options.mountPoint ?? "/");
    this.readOnly = options.readOnly ?? false;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 1024 * 1024 * 1024;
    this.maxFileReadSize = options.maxFileReadSize ?? 10 * 1024 * 1024;
    this.allowSymlinks = options.allowSymlinks ?? false;
  }

  /** Bytes currently retained in the writable layer. */
  get retainedMemoryBytes(): number {
    return this.retainedBytes;
  }

  private guard(path: string, operation: string): string {
    validatePath(path, operation);
    const normalized = normalizePath(path);
    if (!isSameOrDescendantPath(this.root, normalized)) {
      throw new FileSystemPolicyError(
        operation,
        path,
        `path is outside the permitted root (${normalized} is not under ${this.root})`,
      );
    }
    return normalized;
  }

  private charge(bytes: number): void {
    if (this.retainedBytes + bytes > this.maxMemoryBytes) {
      throw new FileSystemPolicyError(
        "write",
        "in-memory layer",
        `copy-on-write layer would exceed ${this.maxMemoryBytes} bytes ` +
          `(${this.retainedBytes + bytes} requested)`,
      );
    }
    this.retainedBytes += bytes;
  }

  private requireWritable(operation: string, path: string): void {
    if (this.readOnly) {
      throw new FileSystemPolicyError(operation, path, "read-only filesystem (EROFS)");
    }
  }

  private freshIdentity(): string {
    return `cow:${(this.nextIdentity++).toString(36)}`;
  }

  async stat(path: string): Promise<FsStat | undefined> {
    const normalized = this.guard(path, "stat");
    const root = this.statRoot(normalized);
    if (root) return root;
    const upper = this.upper.get(normalized);
    if (upper) return this.toStat(upper);
    if (this.tombstones.has(normalized)) return undefined;
    if (this.lower) {
      const lowerStat = await this.lower.stat(this.toLowerPath(normalized));
      if (lowerStat) {
        return { ...lowerStat, identity: lowerStat.identity ?? `${normalized}:lower` };
      }
    }
    return undefined;
  }

  async lstat(path: string): Promise<FsStat | undefined> {
    const normalized = this.guard(path, "lstat");
    const root = this.statRoot(normalized);
    if (root) return root;
    const upper = this.upper.get(normalized);
    if (upper) return this.toStat(upper);
    if (this.tombstones.has(normalized)) return undefined;
    if (this.lower) {
      return this.lower.lstat(this.toLowerPath(normalized));
    }
    return undefined;
  }

  /**
   * The filesystem root — and the permitted root, when the backend is confined to
   * a subtree — is a directory that exists from construction. Nothing creates it,
   * but `mkdir("/data")` on a fresh backend still has to find its parent, and a
   * confined backend's `mkdir("/sandbox/data")` has to find "/sandbox".
   */
  private statRoot(normalized: string): FsStat | undefined {
    if (normalized !== "/" && normalized !== this.root) return undefined;
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      size: 0,
      mode: DEFAULT_DIR_MODE,
      mtime: ROOT_MTIME,
      identity: "cow:root",
    };
  }

  /**
   * Resolve symlinks. When symlinks are disallowed (the default) any path that
   * traverses one throws EPERM — the donor's documented behaviour — because a
   * symlink is the one way an otherwise-contained path can point somewhere else.
   * When allowed, resolution is bounded by MAX_SYMLINK_DEPTH and cycle-detected.
   */
  async realpath(path: string): Promise<string> {
    let current = this.guard(path, "realpath");
    const visited = new Set<string>();
    let depth = 0;

    for (;;) {
      const link = await this.readlinkRaw(current);
      if (link === undefined) return current;

      if (!this.allowSymlinks) {
        throw new FileSystemPolicyError(
          "realpath",
          path,
          "symbolic-link traversal is disabled on this filesystem (EPERM)",
        );
      }
      if (++depth > MAX_SYMLINK_DEPTH) {
        throw new FileSystemPolicyError(
          "realpath",
          path,
          "too many levels of symbolic links (ELOOP)",
        );
      }
      const resolved = resolveSymlinkTarget(current, link);
      if (visited.has(resolved)) {
        throw new FileSystemPolicyError("realpath", path, "symbolic-link cycle detected (ELOOP)");
      }
      visited.add(resolved);
      current = this.guard(resolved, "realpath");
    }
  }

  private async readlinkRaw(normalized: string): Promise<string | undefined> {
    const upper = this.upper.get(normalized);
    if (upper?.type === "symlink") return upper.target;
    if (this.lower) {
      const target = await this.lower.readlink(this.toLowerPath(normalized));
      if (target !== undefined) return target;
    }
    return undefined;
  }

  async readlink(path: string): Promise<string | undefined> {
    const normalized = this.guard(path, "readlink");
    return this.readlinkRaw(normalized);
  }

  async readFile(path: string, options?: ReadFileOptions): Promise<string | Uint8Array> {
    const normalized = await this.realpath(this.guard(path, "readFile"));
    const upper = this.upper.get(normalized);
    let bytes: Uint8Array;

    if (upper?.type === "file") {
      bytes = upper.content;
    } else if (upper?.type === "directory") {
      throw new FileSystemPolicyError("readFile", path, "is a directory (EISDIR)");
    } else if (this.lower && !this.tombstones.has(normalized)) {
      const lowerData = await this.lower.readFile(this.toLowerPath(normalized), {
        encoding: "buffer",
      });
      bytes = lowerData instanceof Uint8Array ? lowerData : Buffer.from(lowerData as string);
      if (bytes.byteLength > this.maxFileReadSize) {
        throw new FileSystemPolicyError(
          "readFile",
          path,
          `file size ${bytes.byteLength} exceeds ${this.maxFileReadSize} bytes (EFBIG)`,
        );
      }
    } else {
      throw new FileSystemPolicyError("readFile", path, "no such file or directory (ENOENT)");
    }

    if (options?.encoding === "utf-8") return new TextDecoder().decode(bytes);
    if (options?.encoding === "base64") {
      return Buffer.from(bytes).toString("base64");
    }
    return bytes;
  }

  /**
   * Write promotes the path into the writable layer. A write to a file still backed
   * by the lower layer copies the original content up first — the copy in
   * copy-on-write — so an in-place write cannot mutate the lower store.
   */
  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void> {
    this.requireWritable("writeFile", path);
    const normalized = await this.realpath(this.guard(path, "writeFile"));
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);

    const existing = this.upper.get(normalized);
    if (existing?.type === "file") {
      this.retainedBytes -= existing.content.byteLength;
    } else if (existing === undefined && !this.tombstones.has(normalized) && this.lower) {
      const lowerStat = await this.lower.stat(this.toLowerPath(normalized));
      if (lowerStat?.isFile) {
        // Promotion: read the lower content so partial writes preserve it.
        const lowerData = await this.lower.readFile(this.toLowerPath(normalized), {
          encoding: "buffer",
        });
        const promoted =
          lowerData instanceof Uint8Array ? lowerData : Buffer.from(lowerData as string);
        if (promoted.byteLength > this.maxFileReadSize) {
          throw new FileSystemPolicyError(
            "writeFile",
            path,
            "source file exceeds read ceiling (EFBIG)",
          );
        }
        this.charge(promoted.byteLength);
        this.upper.set(normalized, {
          type: "file",
          content: promoted,
          mode: lowerStat.mode,
          mtime: new Date(),
          identity: this.freshIdentity(),
        });
        this.tombstones.delete(normalized);
        this.retainedBytes -= promoted.byteLength;
      }
    }

    this.charge(bytes.byteLength);
    this.upper.set(normalized, {
      type: "file",
      content: bytes,
      mode: options?.mode ?? DEFAULT_FILE_MODE,
      mtime: new Date(),
      identity: this.freshIdentity(),
    });
    this.tombstones.delete(normalized);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.requireWritable("mkdir", path);
    const normalized = this.guard(path, "mkdir");

    if (options?.recursive) {
      // `mkdir -p` creates every missing ancestor, so the walk starts at the
      // root and makes each segment that is not already a directory.
      const segments = normalized.split("/").filter(Boolean);
      let current = "";
      for (const segment of segments) {
        current = joinPath(current, segment);
        const existing = await this.stat(current);
        if (existing === undefined) {
          this.upper.set(current, {
            type: "directory",
            mode: options?.mode ?? DEFAULT_DIR_MODE,
            mtime: new Date(),
            identity: this.freshIdentity(),
          });
          this.tombstones.delete(current);
        } else if (!existing.isDirectory) {
          throw new FileSystemPolicyError("mkdir", current, "file exists (EEXIST)");
        }
      }
      return;
    }

    if ((await this.stat(normalized)) !== undefined) {
      throw new FileSystemPolicyError("mkdir", path, "file exists (EEXIST)");
    }
    const parent = dirname(normalized);
    const parentStat = await this.stat(parent);
    if (parentStat === undefined || !parentStat.isDirectory) {
      throw new FileSystemPolicyError("mkdir", path, "no such file or directory (ENOENT)");
    }

    this.upper.set(normalized, {
      type: "directory",
      mode: options?.mode ?? DEFAULT_DIR_MODE,
      mtime: new Date(),
      identity: this.freshIdentity(),
    });
    this.tombstones.delete(normalized);
  }

  /**
   * Merged directory listing: the upper layer's entries shadow the lower layer's by
   * name, and tombstones remove lower entries entirely. A name present in both is
   * reported once, as the upper version — which is what makes a promoted file
   * visible to a script that lists the directory it is in.
   */
  async readdir(path: string): Promise<string[]> {
    const normalized = await this.realpath(this.guard(path, "readdir"));
    const stat = await this.stat(normalized);
    if (stat === undefined) {
      throw new FileSystemPolicyError("readdir", path, "no such file or directory (ENOENT)");
    }
    if (!stat.isDirectory) {
      throw new FileSystemPolicyError("readdir", path, "not a directory (ENOTDIR)");
    }

    const names = new Set<string>();
    for (const entryPath of this.upper.keys()) {
      if (dirname(entryPath) !== normalized) continue;
      names.add(entryPath.slice(normalized === "/" ? 1 : normalized.length + 1));
    }
    if (this.lower) {
      for (const name of await this.lower.readdir(this.toLowerPath(normalized))) {
        if (this.tombstones.has(joinPath(normalized, name))) continue;
        names.add(name);
      }
    }
    // Sorted so a caller comparing listings across two backends gets a stable order.
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  async unlink(path: string): Promise<void> {
    this.requireWritable("unlink", path);
    const normalized = this.guard(path, "unlink");
    const stat = await this.lstat(normalized);
    if (stat === undefined) {
      throw new FileSystemPolicyError("unlink", path, "no such file or directory (ENOENT)");
    }
    if (stat.isDirectory) {
      throw new FileSystemPolicyError("unlink", path, "is a directory (EISDIR)");
    }
    this.deleteFromUpper(normalized);
  }

  async rmdir(path: string): Promise<void> {
    this.requireWritable("rmdir", path);
    const normalized = this.guard(path, "rmdir");
    const stat = await this.stat(normalized);
    if (stat === undefined) {
      throw new FileSystemPolicyError("rmdir", path, "no such file or directory (ENOENT)");
    }
    if (!stat.isDirectory) {
      throw new FileSystemPolicyError("rmdir", path, "not a directory (ENOTDIR)");
    }
    if ((await this.readdir(normalized)).length > 0) {
      throw new FileSystemPolicyError("rmdir", path, "directory not empty (ENOTEMPTY)");
    }
    this.deleteFromUpper(normalized);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.requireWritable("symlink", linkPath);
    if (!this.allowSymlinks) {
      // Creating one is refused for the same reason following one is: a symlink is
      // an alias the containment check cannot see in the path text alone.
      throw new FileSystemPolicyError("symlink", linkPath, "symbolic links are disabled (EPERM)");
    }
    const normalized = this.guard(linkPath, "symlink");
    validatePath(target, "symlink target");
    if ((await this.stat(normalized)) !== undefined) {
      throw new FileSystemPolicyError("symlink", linkPath, "file exists (EEXIST)");
    }
    this.upper.set(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date(),
      identity: this.freshIdentity(),
    });
    this.tombstones.delete(normalized);
  }

  private deleteFromUpper(normalized: string): void {
    const existing = this.upper.get(normalized);
    if (existing?.type === "file") {
      this.retainedBytes -= existing.content.byteLength;
    }
    this.upper.delete(normalized);
    this.tombstones.add(normalized);
  }

  private toStat(entry: MemoryEntry): FsStat {
    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: entry.type === "symlink",
      size: entry.type === "file" ? entry.content.byteLength : 0,
      mode: entry.mode,
      mtime: entry.mtime,
      identity: entry.identity,
    };
  }

  private toLowerPath(normalized: string): string {
    if (this.mountPoint === "/") return normalized;
    if (normalized === this.mountPoint) return "/";
    if (normalized.startsWith(`${this.mountPoint}/`)) {
      return normalized.slice(this.mountPoint.length);
    }
    return normalized;
  }
}

/** One shared, command-local view over the traversal work budget. */
export interface TraversalBudgetOptions {
  readonly limits: Required<ExecutionLimits>;
  readonly signal?: AbortSignal;
  readonly site: string;
  readonly label?: string;
}

export class TraversalBudgetError extends Error {
  constructor(
    message: string,
    public readonly kind: "iterations" | "recursion" | "memory",
  ) {
    super(message);
    this.name = "TraversalBudgetError";
  }
}

/**
 * Traversal budget: what stops a `find /` from walking a filesystem larger than the
 * sandbox agreed to pay for. Three counters — work (fs operations), entries
 * (visited nodes), depth — because each bounds a different blowup: a wide tree
 * costs entries, a deep one costs depth, and a pathological readdir costs work
 * before it costs entries. `reserve` and `discover` exist so an oversized readdir
 * result is rejected before it is queued, not after it is allocated.
 */
export class FileTraversalBudget {
  private entries = 0;
  private discoveredEntries = 1;
  private work = 0;

  constructor(private readonly options: TraversalBudgetOptions) {}

  checkpoint(work = 1): void {
    if (this.options.signal?.aborted) throw new TraversalBudgetError("aborted", "iterations");
    if (
      !Number.isSafeInteger(work) ||
      work < 0 ||
      work > this.options.limits.maxTraversalWork - this.work
    ) {
      throw new TraversalBudgetError(
        `${this.options.site}: ${this.options.label ?? "filesystem traversal work"} limit exceeded ` +
          `(${this.options.limits.maxTraversalWork})`,
        "iterations",
      );
    }
    this.work += work;
  }

  visit(depth: number): void {
    this.checkpoint();
    if (depth > this.options.limits.maxTraversalDepth) {
      throw new TraversalBudgetError(
        `${this.options.site}: ${this.options.label ?? "filesystem traversal"} depth limit exceeded ` +
          `(${this.options.limits.maxTraversalDepth})`,
        "recursion",
      );
    }
    if (++this.entries > this.options.limits.maxTraversalEntries) {
      throw new TraversalBudgetError(
        `${this.options.site}: ${this.options.label ?? "filesystem traversal"} entry limit exceeded ` +
          `(${this.options.limits.maxTraversalEntries})`,
        "iterations",
      );
    }
  }

  /** Charge for children a traversal will retain, without charging for work not yet done. */
  reserve(count: number): void {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.options.limits.maxTraversalEntries - this.discoveredEntries
    ) {
      throw new TraversalBudgetError(
        `${this.options.site}: ${this.options.label ?? "filesystem traversal"} entry limit exceeded ` +
          `(${this.options.limits.maxTraversalEntries})`,
        "iterations",
      );
    }
    this.discoveredEntries += count;
  }

  /** Charge for children a traversal will both retain and visit. */
  discover(count: number): void {
    this.reserve(count);
    this.checkpoint(count);
  }
}

export interface TraversalEntry {
  readonly path: string;
  readonly depth: number;
  readonly stat: FsStat;
  readonly isSymlink: boolean;
  readonly phase: "enter" | "leave";
}

export type SymlinkTraversalPolicy = "never" | "follow";

export interface TraverseFileTreeOptions extends TraversalBudgetOptions {
  readonly fs: IFileSystem;
  readonly root: string;
  readonly symlinks?: SymlinkTraversalPolicy;
  readonly includeLeave?: boolean;
  readonly budget?: FileTraversalBudget;
}

type StackItem =
  | { readonly kind: "enter"; readonly path: string; readonly depth: number }
  | {
      readonly kind: "leave";
      readonly path: string;
      readonly depth: number;
      readonly stat: FsStat;
      readonly isSymlink: boolean;
      readonly identity?: string;
    };

/**
 * Iterative, deterministic DFS over the virtual tree. Directory identities stay
 * active until the matching `leave` marker, which is what detects an ancestor
 * symlink cycle without suppressing a valid alias in a *separate* branch — the
 * bug a naive visited-set produces.
 */
export async function traverseFileTree(
  options: TraverseFileTreeOptions,
  visitor: (entry: TraversalEntry) => void | Promise<void>,
): Promise<void> {
  const limits = resolveLimits(options.limits);
  const budget =
    options.budget ?? new FileTraversalBudget({ ...options, limits, site: options.site });
  const stack: StackItem[] = [{ kind: "enter", path: normalizePath(options.root), depth: 0 }];
  const activeDirectories = new Set<string>();

  while (stack.length > 0) {
    budget.checkpoint(0);
    const item = stack.pop();
    if (!item) break;

    if (item.kind === "leave") {
      if (options.includeLeave) {
        await visitor({
          path: item.path,
          depth: item.depth,
          stat: item.stat,
          isSymlink: item.isSymlink,
          phase: "leave",
        });
      }
      if (item.identity) activeDirectories.delete(item.identity);
      continue;
    }

    budget.visit(item.depth);
    const lstat = await options.fs.lstat(item.path);
    if (lstat === undefined) continue;
    const isSymlink = lstat.isSymbolicLink;
    const stat =
      isSymlink && options.symlinks === "follow"
        ? ((await options.fs.stat(item.path)) ?? lstat)
        : lstat;

    await visitor({
      path: item.path,
      depth: item.depth,
      stat,
      isSymlink,
      phase: "enter",
    });

    if (!stat.isDirectory || (isSymlink && options.symlinks !== "follow")) {
      continue;
    }

    const identity =
      stat.identity ??
      (await options.fs
        .realpath(item.path)
        .then(normalizePath)
        .catch(() => undefined));
    if (identity !== undefined) {
      if (activeDirectories.has(identity)) {
        throw new FileSystemPolicyError(
          options.site,
          item.path,
          "symbolic-link directory cycle detected",
        );
      }
      activeDirectories.add(identity);
    }

    stack.push({
      kind: "leave",
      path: item.path,
      depth: item.depth,
      stat,
      isSymlink,
      identity,
    });
    const names = await options.fs.readdir(item.path);
    budget.checkpoint();
    names.sort((a, b) => a.localeCompare(b));
    for (let index = names.length - 1; index >= 0; index--) {
      stack.push({
        kind: "enter",
        path: joinPath(item.path, names[index]!),
        depth: item.depth + 1,
      });
    }
  }
}

/**
 * Conservatively compare two paths for sameness. `unknown` is a real answer, not a
 * failure: it forces a destructive caller (a copy or a move) to stage its work
 * instead of treating "I cannot prove these are the same file" as "they differ".
 */
export async function resolveFileIdentity(
  fs: IFileSystem,
  path: string,
  budget?: FileTraversalBudget,
): Promise<
  | {
      readonly existence: "existing";
      readonly canonicalPath?: string;
      readonly stableIdentity?: string;
    }
  | { readonly existence: "missing"; readonly canonicalPath?: string }
  | { readonly existence: "unknown" }
> {
  const normalized = normalizePath(path);
  let stat: FsStat | undefined;
  try {
    stat = await fs.stat(normalized);
  } catch {
    return { existence: "unknown" };
  }
  if (stat !== undefined) {
    const stableIdentity = statIdentity(stat);
    try {
      return {
        existence: "existing",
        canonicalPath: normalizePath(await fs.realpath(normalized)),
        stableIdentity,
      };
    } catch {
      return stableIdentity === undefined
        ? { existence: "unknown" }
        : { existence: "existing", stableIdentity };
    }
  }

  const missingComponents: string[] = [];
  let candidate = normalized;
  for (;;) {
    budget?.checkpoint();
    const parent = dirname(candidate);
    if (parent === candidate) return { existence: "unknown" };
    missingComponents.unshift(candidate.slice(parent === "/" ? 1 : parent.length + 1));
    candidate = parent;
    try {
      const canonicalParent = normalizePath(await fs.realpath(candidate));
      return {
        existence: "missing",
        canonicalPath: missingComponents.reduce(
          (current, component) => joinPath(current, component),
          canonicalParent,
        ),
      };
    } catch {
      continue;
    }
  }
}

function statIdentity(stat: FsStat): string | undefined {
  if (stat.identity !== undefined) return `identity:${stat.identity}`;
  if (stat.dev !== undefined && stat.ino !== undefined) {
    return `inode:${String(stat.dev)}:${String(stat.ino)}`;
  }
  return undefined;
}

export async function compareFileIdentity(
  fs: IFileSystem,
  left: string,
  right: string,
): Promise<SameFileResult> {
  const [leftIdentity, rightIdentity] = await Promise.all([
    resolveFileIdentity(fs, left),
    resolveFileIdentity(fs, right),
  ]);
  if (leftIdentity.existence === "unknown" || rightIdentity.existence === "unknown") {
    return "unknown";
  }
  if (leftIdentity.existence === "missing" || rightIdentity.existence === "missing") {
    if (leftIdentity.existence !== rightIdentity.existence) return "different";
    return leftIdentity.canonicalPath !== undefined &&
      leftIdentity.canonicalPath === rightIdentity.canonicalPath
      ? "same"
      : "unknown";
  }
  if (leftIdentity.stableIdentity !== undefined && rightIdentity.stableIdentity !== undefined) {
    return leftIdentity.stableIdentity === rightIdentity.stableIdentity ? "same" : "different";
  }
  // Equal canonical paths prove sameness; different spellings do not prove
  // inequality without alias-resistant identities, because they may be hard links.
  return leftIdentity.canonicalPath !== undefined &&
    leftIdentity.canonicalPath === rightIdentity.canonicalPath
    ? "same"
    : "unknown";
}

export async function compareCanonicalContainment(
  fs: IFileSystem,
  sourceDirectory: string,
  destination: string,
  budget?: FileTraversalBudget,
): Promise<PathContainmentResult> {
  const [source, candidate] = await Promise.all([
    resolveFileIdentity(fs, sourceDirectory, budget),
    resolveFileIdentity(fs, destination, budget),
  ]);
  if (
    source.existence !== "existing" ||
    source.canonicalPath === undefined ||
    candidate.existence === "unknown" ||
    candidate.canonicalPath === undefined
  ) {
    return "unknown";
  }
  return isSameOrDescendantPath(source.canonicalPath, candidate.canonicalPath)
    ? "inside"
    : "outside";
}
