/**
 * Live Incremental AST Knowledge Graph File-Watcher.
 *
 * Recursively watches workspace source files and incrementally updates
 * the CodeGraph knowledge graph in real-time as files are created, modified,
 * or deleted. Emits change events for telemetry streaming.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { CodeGraph, type CodeGraphEdge, type CodeGraphNode } from "./code-graph.js";
import { SymbolIndexer, type FileSummary } from "./symbol-indexer.js";

export interface CodeGraphWatcherOptions {
  graph?: CodeGraph;
  indexer?: SymbolIndexer;
  extensions?: string[];
  ignorePatterns?: Array<string | RegExp>;
  debounceMs?: number;
  autoStart?: boolean;
}

export interface CodeGraphWatcherStats {
  totalFiles: number;
  totalNodes: number;
  totalEdges: number;
  lastUpdated: number;
}

export interface CodeGraphChangeEvent {
  action: "update" | "remove";
  filePath: string;
  summary?: FileSummary;
  timestamp: number;
}

const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
];

const DEFAULT_IGNORES: Array<string | RegExp> = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  ".gemini",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".idea",
  ".vscode",
];

export class CodeGraphWatcher extends EventEmitter {
  private readonly rootDir: string;
  private readonly graph: CodeGraph;
  private readonly indexer: SymbolIndexer;
  private readonly extensions: Set<string>;
  private readonly ignorePatterns: Array<string | RegExp>;
  private readonly debounceMs: number;

  private fsWatcher: fs.FSWatcher | null = null;
  // Non-recursive fallback (see startPerDirectoryWatch): one watcher per directory when the
  // platform does not support `fs.watch({ recursive: true })`.
  private readonly dirWatchers = new Map<string, fs.FSWatcher>();
  private degradationWarned = false;
  // Coalesced dirty paths set to prevent timer starvation and handle burst writes efficiently
  private dirtyPaths = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing: boolean = false;
  private trackedFiles = new Set<string>();
  private lastUpdated: number = Date.now();
  private isClosed: boolean = false;

  constructor(rootDir: string, options: CodeGraphWatcherOptions = {}) {
    super();
    this.rootDir = path.resolve(rootDir);
    this.graph = options.graph ?? new CodeGraph();
    this.indexer = options.indexer ?? new SymbolIndexer();
    this.extensions = new Set(
      (options.extensions ?? DEFAULT_EXTENSIONS).map((ext) => ext.toLowerCase()),
    );
    this.ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORES;
    this.debounceMs = options.debounceMs ?? 100;

    if (options.autoStart) {
      void this.init();
    }
  }

  public getGraph(): CodeGraph {
    return this.graph;
  }

  public getTrackedFiles(): string[] {
    return Array.from(this.trackedFiles);
  }

  public getStats(): CodeGraphWatcherStats {
    const nodes = this.graph.getAllNodes();
    const edges = this.graph.getAllEdges();
    return {
      totalFiles: this.trackedFiles.size,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      lastUpdated: this.lastUpdated,
    };
  }

  public exportSnapshot(): {
    nodes: CodeGraphNode[];
    edges: CodeGraphEdge[];
    stats: CodeGraphWatcherStats;
  } {
    return {
      nodes: this.graph.getAllNodes(),
      edges: this.graph.getAllEdges(),
      stats: this.getStats(),
    };
  }

  public isPathIgnored(targetPath: string): boolean {
    const normalized = targetPath.replace(/\\/g, "/");
    for (const pattern of this.ignorePatterns) {
      if (typeof pattern === "string") {
        if (
          normalized === pattern ||
          normalized.includes(`/${pattern}/`) ||
          normalized.endsWith(`/${pattern}`) ||
          normalized.startsWith(`${pattern}/`)
        ) {
          return true;
        }
      } else if (pattern.test(normalized)) {
        return true;
      }
    }
    return false;
  }

  public hasSupportedExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return this.extensions.has(ext);
  }

  /**
   * Initializes watcher by performing an initial workspace scan and attaching file-system hooks.
   */
  public async init(): Promise<void> {
    if (this.isClosed) return;
    await this.scanWorkspace();
    this.startWatching();
    this.emit("ready", this.getStats());
  }

  /**
   * Performs an exhaustive scan of the workspace root and populates the graph.
   */
  public async scanWorkspace(): Promise<void> {
    if (!fs.existsSync(this.rootDir)) return;

    const filesToProcess: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(this.rootDir, fullPath);

        if (this.isPathIgnored(relPath)) continue;

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && this.hasSupportedExtension(entry.name)) {
          filesToProcess.push(fullPath);
        }
      }
    };

    walk(this.rootDir);

    const chunkSize = 25;
    for (let i = 0; i < filesToProcess.length; i++) {
      this.processFile(filesToProcess[i]!);
      if (i > 0 && i % chunkSize === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    this.lastUpdated = Date.now();
  }

  /**
   * Synchronously or asynchronously processes a single file into the graph.
   */
  public processFile(fullPath: string): FileSummary | null {
    if (this.isClosed) return null;

    const relPath = path.relative(this.rootDir, fullPath).replace(/\\/g, "/");
    if (!fs.existsSync(fullPath)) {
      this.removeFile(fullPath);
      return null;
    }

    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      return null;
    }

    const summary = this.indexer.parseContent(relPath, content);
    this.graph.updateFile(summary);
    this.trackedFiles.add(relPath);
    this.lastUpdated = Date.now();

    const changeEv: CodeGraphChangeEvent = {
      action: "update",
      filePath: relPath,
      summary,
      timestamp: this.lastUpdated,
    };
    this.emit("change", changeEv);
    return summary;
  }

  /**
   * Removes a file from the tracked set and cleans its nodes/edges from the graph.
   */
  public removeFile(fullPath: string): void {
    const relPath = path.relative(this.rootDir, fullPath).replace(/\\/g, "/");
    this.graph.removeFile(relPath);
    this.trackedFiles.delete(relPath);
    this.lastUpdated = Date.now();

    const changeEv: CodeGraphChangeEvent = {
      action: "remove",
      filePath: relPath,
      timestamp: this.lastUpdated,
    };
    this.emit("change", changeEv);
  }

  /**
   * Starts native filesystem watching.
   *
   * `fs.watch({ recursive: true })` is documented as macOS/Windows-only and is silently ignored
   * on Linux, where it would make the watcher blind to everything outside the workspace root.
   * When recursion is unavailable, fall back to one non-recursive watcher per directory.
   */
  public startWatching(): void {
    if (this.isClosed || !fs.existsSync(this.rootDir)) return;

    if (this.supportsRecursiveWatch()) {
      this.startRecursiveWatch();
    } else {
      if (!this.degradationWarned) {
        this.degradationWarned = true;
        this.emit(
          "warn",
          `Recursive filesystem watching is unavailable on ${process.platform}; installing one ` +
            `watcher per directory instead. Subdirectory file changes are still tracked; newly ` +
            `created directories are picked up as they appear inside a watched directory.`,
        );
      }
      this.startPerDirectoryWatch();
    }
  }

  /**
   * Whether `fs.watch({ recursive: true })` is honored on this platform. Overridable in tests so
   * the per-directory fallback can be exercised on platforms that do support recursion.
   */
  protected supportsRecursiveWatch(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
  }

  /**
   * Coalesces a dirty path into a single debounced flush pass (shared by both watch paths).
   */
  private scheduleFlush(): void {
    if (this.flushTimer || this.isFlushing || this.isClosed) return;
    // Source: https://nodejs.org/api/timers.html#setimmediatecallback-args
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushDirtyPaths();
    }, this.debounceMs);
  }

  private startRecursiveWatch(): void {
    if (this.fsWatcher || this.isClosed) return;

    try {
      this.fsWatcher = fs.watch(
        this.rootDir,
        { recursive: true },
        (_eventType: string, filename: string | null) => {
          if (!filename || this.isClosed) return;

          const relPath = filename.replace(/\\/g, "/");
          if (this.isPathIgnored(relPath)) return;
          if (!this.hasSupportedExtension(relPath)) return;

          this.dirtyPaths.add(path.join(this.rootDir, filename));
          this.scheduleFlush();
        },
      );

      this.fsWatcher.on("error", (err) => {
        this.emit("error", err);
      });
    } catch (err) {
      this.emit("error", err);
    }
  }

  /**
   * Fallback used when recursive watching is unavailable: walks the tree once and installs one
   * non-recursive watcher per (non-ignored) directory. New directories are watched as they are
   * created inside a watched directory; watchers on removed directories are dropped.
   */
  private startPerDirectoryWatch(): void {
    for (const dir of this.collectWatchedDirectories()) {
      this.watchDirectory(dir);
    }
  }

  private collectWatchedDirectories(): string[] {
    const dirs: string[] = [this.rootDir];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(dir, entry.name);
        if (this.isPathIgnored(path.relative(this.rootDir, fullPath))) continue;
        dirs.push(fullPath);
        walk(fullPath);
      }
    };
    walk(this.rootDir);
    return dirs;
  }

  private watchDirectory(dir: string): void {
    if (this.isClosed || this.dirWatchers.has(dir)) return;

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, (_eventType: string, filename: string | null) => {
        if (!filename || this.isClosed) return;

        const fullPath = path.join(dir, filename);
        const relPath = path.relative(this.rootDir, fullPath).replace(/\\/g, "/");

        let isDirectory = false;
        try {
          isDirectory = fs.statSync(fullPath).isDirectory();
        } catch {
          // The entry is already gone; a watched subdirectory may have been removed.
        }
        if (isDirectory) {
          if (!this.isPathIgnored(relPath)) this.discoverDirectory(fullPath);
          return;
        }
        if (this.dirWatchers.has(fullPath)) this.closeDirectoryWatcher(fullPath);
        if (this.isPathIgnored(relPath) || !this.hasSupportedExtension(relPath)) return;

        this.dirtyPaths.add(fullPath);
        this.scheduleFlush();
      });
    } catch (err) {
      this.emit("error", err);
      return;
    }

    watcher.on("error", (err) => {
      // A deleted/renamed directory stops being watchable: drop the handle rather than leak it.
      this.closeDirectoryWatcher(dir);
      this.emit("error", err);
    });
    this.dirWatchers.set(dir, watcher);
  }

  /**
   * Installs a watcher on a directory discovered at runtime and sweeps it once: files may have
   * appeared between the directory's creation and this notification, and they would otherwise be
   * missed forever (the new watcher only sees changes from installation onward).
   */
  private discoverDirectory(dir: string): void {
    this.watchDirectory(dir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!this.isPathIgnored(path.relative(this.rootDir, fullPath))) {
          this.discoverDirectory(fullPath);
        }
        continue;
      }
      const relPath = path.relative(this.rootDir, fullPath).replace(/\\/g, "/");
      if (this.isPathIgnored(relPath) || !this.hasSupportedExtension(entry.name)) continue;
      this.dirtyPaths.add(fullPath);
    }
    this.scheduleFlush();
  }

  private closeDirectoryWatcher(dir: string): void {
    const watcher = this.dirWatchers.get(dir);
    if (!watcher) return;
    this.dirWatchers.delete(dir);
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }

  /**
   * Processes queued dirty file paths in bounded slices, yielding to the event loop
   * between slices using setImmediate to prevent thread starvation under continuous writes.
   */
  public async flushDirtyPaths(): Promise<void> {
    if (this.isClosed || this.isFlushing) return;
    this.isFlushing = true;
    const BATCH_SIZE = 10;

    try {
      while (this.dirtyPaths.size > 0 && !this.isClosed) {
        const slice: string[] = [];
        for (const p of this.dirtyPaths) {
          slice.push(p);
          this.dirtyPaths.delete(p);
          if (slice.length >= BATCH_SIZE) break;
        }

        for (const fullPath of slice) {
          if (this.isClosed) break;
          if (fs.existsSync(fullPath)) {
            this.processFile(fullPath);
          } else {
            this.removeFile(fullPath);
          }
        }

        if (this.dirtyPaths.size > 0 && !this.isClosed) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } finally {
      this.isFlushing = false;
      // If new dirty paths arrived while processing the final slice, schedule next pass
      if (this.dirtyPaths.size > 0 && !this.flushTimer && !this.isClosed) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flushDirtyPaths();
        }, this.debounceMs);
      }
    }
  }

  /**
   * Explicitly flushes any queued dirty paths immediately.
   */
  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushDirtyPaths();
  }

  /**
   * Closes watcher and cancels pending timers.
   */
  public close(): void {
    this.isClosed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirtyPaths.clear();

    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignore
      }
      this.fsWatcher = null;
    }

    for (const dir of [...this.dirWatchers.keys()]) {
      this.closeDirectoryWatcher(dir);
    }

    this.emit("closed");
  }
}
