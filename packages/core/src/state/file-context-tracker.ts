/**
 * Per-File Context Weight & Token Budget Tracker.
 *
 * Tracks individual file token weights, access frequency, and token density across
 * agent turns, alerting when specific files monopolize the context window.
 *
 * Synthesized from OpenAnalyst FileContextTracker and nanobot context_governance.
 */

export interface TrackedFileContext {
  filePath: string;
  estimatedTokens: number;
  readCount: number;
  editCount: number;
  firstSeenTurn: number;
  lastSeenTurn: number;
  percentageOfContext: number;
}

export interface ContextGovernanceReport {
  totalEstimatedTokens: number;
  contextWindowCapacity: number;
  capacityUsedPercentage: number;
  trackedFileCount: number;
  topDominatingFiles: TrackedFileContext[];
  hasMonopolizingFiles: boolean;
  monopolyWarningThresholdPct: number;
  recommendations: string[];
}

export class FileContextTracker {
  private fileRecords = new Map<
    string,
    {
      estimatedTokens: number;
      readCount: number;
      editCount: number;
      firstSeenTurn: number;
      lastSeenTurn: number;
    }
  >();

  private currentTurn = 0;
  private readonly contextWindowCapacity: number;
  private readonly monopolyThresholdPct: number;

  constructor(options: { contextWindowCapacity?: number; monopolyThresholdPct?: number } = {}) {
    this.contextWindowCapacity = options.contextWindowCapacity ?? 200_000;
    this.monopolyThresholdPct = options.monopolyThresholdPct ?? 25.0; // 25% of context
  }

  public advanceTurn(): void {
    this.currentTurn++;
  }

  public recordFileRead(filePath: string, contentOrLength: string | number): void {
    const tokens =
      typeof contentOrLength === "string"
        ? Math.ceil(contentOrLength.length / 3.8)
        : Math.ceil(contentOrLength / 3.8);

    const existing = this.fileRecords.get(filePath);
    if (existing) {
      existing.readCount++;
      existing.estimatedTokens = tokens;
      existing.lastSeenTurn = this.currentTurn;
    } else {
      this.fileRecords.set(filePath, {
        estimatedTokens: tokens,
        readCount: 1,
        editCount: 0,
        firstSeenTurn: this.currentTurn,
        lastSeenTurn: this.currentTurn,
      });
    }
  }

  public recordFileEdit(filePath: string, newLength: number): void {
    const tokens = Math.ceil(newLength / 3.8);
    const existing = this.fileRecords.get(filePath);
    if (existing) {
      existing.editCount++;
      existing.estimatedTokens = tokens;
      existing.lastSeenTurn = this.currentTurn;
    } else {
      this.fileRecords.set(filePath, {
        estimatedTokens: tokens,
        readCount: 1,
        editCount: 1,
        firstSeenTurn: this.currentTurn,
        lastSeenTurn: this.currentTurn,
      });
    }
  }

  public removeFile(filePath: string): boolean {
    return this.fileRecords.delete(filePath);
  }

  public getTrackedFiles(): TrackedFileContext[] {
    let totalTokens = 0;
    for (const rec of this.fileRecords.values()) {
      totalTokens += rec.estimatedTokens;
    }

    const divisor = totalTokens > 0 ? totalTokens : 1;
    const result: TrackedFileContext[] = [];

    for (const [filePath, rec] of this.fileRecords.entries()) {
      const pct = (rec.estimatedTokens / divisor) * 100;
      result.push({
        filePath,
        estimatedTokens: rec.estimatedTokens,
        readCount: rec.readCount,
        editCount: rec.editCount,
        firstSeenTurn: rec.firstSeenTurn,
        lastSeenTurn: rec.lastSeenTurn,
        percentageOfContext: Math.round(pct * 10) / 10,
      });
    }

    return result.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  }

  public getGovernanceReport(): ContextGovernanceReport {
    const files = this.getTrackedFiles();
    const totalTokens = files.reduce((sum, f) => sum + f.estimatedTokens, 0);
    const capacityUsedPct = (totalTokens / this.contextWindowCapacity) * 100;

    const dominatingFiles = files.filter((f) => f.percentageOfContext >= this.monopolyThresholdPct);
    const hasMonopoly = dominatingFiles.length > 0;
    const recommendations: string[] = [];

    if (hasMonopoly) {
      for (const dom of dominatingFiles) {
        recommendations.push(
          `File '${dom.filePath}' occupies ${dom.percentageOfContext}% of prompt context (${dom.estimatedTokens} tokens). Consider replacing full file content with symbol summary or diff.`,
        );
      }
    }

    if (capacityUsedPct > 75) {
      recommendations.push(
        `Context window is ${Math.round(capacityUsedPct)}% full. Compaction or memory anchor creation is advised.`,
      );
    }

    return {
      totalEstimatedTokens: totalTokens,
      contextWindowCapacity: this.contextWindowCapacity,
      capacityUsedPercentage: Math.round(capacityUsedPct * 10) / 10,
      trackedFileCount: files.length,
      topDominatingFiles: files.slice(0, 5),
      hasMonopolizingFiles: hasMonopoly,
      monopolyWarningThresholdPct: this.monopolyThresholdPct,
      recommendations,
    };
  }
}
