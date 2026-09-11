/**
 * Session File Tracker and Change Auditor.
 * Absorbed from crush filetracker and git_error.
 */

export type FileOperation = "read" | "write" | "create" | "edit" | "delete";

export interface FileRecord {
  path: string;
  operations: Set<FileOperation>;
  firstAccessAt: number;
  lastModifiedAt?: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface SessionFileSummary {
  totalFilesTouched: number;
  filesModified: string[];
  filesCreated: string[];
  filesDeleted: string[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

export class SessionFileTracker {
  private records = new Map<string, FileRecord>();

  private getOrCreate(filePath: string): FileRecord {
    let rec = this.records.get(filePath);
    if (!rec) {
      rec = {
        path: filePath,
        operations: new Set<FileOperation>(),
        firstAccessAt: Date.now(),
        linesAdded: 0,
        linesRemoved: 0,
      };
      this.records.set(filePath, rec);
    }
    return rec;
  }

  recordRead(filePath: string): void {
    const rec = this.getOrCreate(filePath);
    rec.operations.add("read");
  }

  recordWrite(filePath: string, linesAdded: number = 0, linesRemoved: number = 0, isNew: boolean = false): void {
    const rec = this.getOrCreate(filePath);
    rec.operations.add(isNew ? "create" : "edit");
    rec.operations.add("write");
    rec.lastModifiedAt = Date.now();
    rec.linesAdded += Math.max(0, linesAdded);
    rec.linesRemoved += Math.max(0, linesRemoved);
  }

  recordDelete(filePath: string): void {
    const rec = this.getOrCreate(filePath);
    rec.operations.add("delete");
    rec.lastModifiedAt = Date.now();
  }

  listModifiedFiles(): string[] {
    const modified: string[] = [];
    for (const [p, rec] of this.records) {
      if (rec.operations.has("write") || rec.operations.has("create") || rec.operations.has("delete")) {
        modified.push(p);
      }
    }
    return modified;
  }

  getSummary(): SessionFileSummary {
    const filesModified: string[] = [];
    const filesCreated: string[] = [];
    const filesDeleted: string[] = [];
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    for (const [p, rec] of this.records) {
      if (rec.operations.has("delete")) {
        filesDeleted.push(p);
      } else if (rec.operations.has("create")) {
        filesCreated.push(p);
      } else if (rec.operations.has("edit") || rec.operations.has("write")) {
        filesModified.push(p);
      }
      totalLinesAdded += rec.linesAdded;
      totalLinesRemoved += rec.linesRemoved;
    }

    return {
      totalFilesTouched: this.records.size,
      filesModified,
      filesCreated,
      filesDeleted,
      totalLinesAdded,
      totalLinesRemoved,
    };
  }

  reset(): void {
    this.records.clear();
  }
}
