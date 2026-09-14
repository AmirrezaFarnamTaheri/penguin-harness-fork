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
  ".next",
  ".turbo",
  ".cache",
  ".gemini",
  "coverage",
];

export class CodeGraphWatcher extends EventEmitter {
  private readonly rootDir: string;
  private readonly graph: CodeGraph;
  private readonly indexer: SymbolIndexer;
  private readonly extensions: Set<string>;
  private readonly ignorePatterns: Array<string | RegExp>;
  private readonly debounceMs: number;

  private fsWatcher: fs.FSWatcher | null = null;
  private pendingUpdates = new Map<string, NodeJS.Timeout>();
  private trackedFiles = new Set<string>();
  private lastUpdated: number = Date.now();
  private isClosed: boolean = false;

  constructor(rootDir: string, options: CodeGraphWatcherOptions = {}) {
    super();
    this.rootDir = path.resolve(rootDir);
    this.graph = options.graph ?? new CodeGraph();
    this.indexer = options.indexer ?? new SymbolIndexer();
    this.extensions = new Set((options.extensions ?? DEFAULT_EXTENSIONS).map((ext) => ext.toLowerCase()));
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
        if (normalized.includes(`/${pattern}/`) || normalized.endsWith(`/${pattern}`) || normalized.startsWith(`${pattern}/`)) {
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

    for (const file of filesToProcess) {
      this.processFile(file);
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
   */
  public startWatching(): void {
    if (this.fsWatcher || this.isClosed || !fs.existsSync(this.rootDir)) return;

    try {
      this.fsWatcher = fs.watch(
        this.rootDir,
        { recursive: true },
        (_eventType: string, filename: string | null) => {
          if (!filename || this.isClosed) return;

          const relPath = filename.replace(/\\/g, "/");
          if (this.isPathIgnored(relPath)) return;
          if (!this.hasSupportedExtension(relPath)) return;

          const fullPath = path.join(this.rootDir, filename);

          const existingTimer = this.pendingUpdates.get(fullPath);
          if (existingTimer) clearTimeout(existingTimer);

          const timer = setTimeout(() => {
            this.pendingUpdates.delete(fullPath);
            if (fs.existsSync(fullPath)) {
              this.processFile(fullPath);
            } else {
              this.removeFile(fullPath);
            }
          }, this.debounceMs);

          this.pendingUpdates.set(fullPath, timer);
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
   * Closes watcher and cancels pending timers.
   */
  public close(): void {
    this.isClosed = true;
    for (const timer of this.pendingUpdates.values()) {
      clearTimeout(timer);
    }
    this.pendingUpdates.clear();

    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignore
      }
      this.fsWatcher = null;
    }

    this.emit("closed");
  }
}
