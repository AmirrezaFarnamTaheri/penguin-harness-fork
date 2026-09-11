import { describe, expect, it } from "vitest";
import { FileContextTracker } from "../src/state/file-context-tracker.js";

describe("FileContextTracker", () => {
  it("tracks file reads, edits, and computes context token density", () => {
    const tracker = new FileContextTracker({ contextWindowCapacity: 10000, monopolyThresholdPct: 20 });

    // Turn 0
    tracker.recordFileRead("src/index.ts", 3800); // ~1000 tokens
    tracker.recordFileRead("src/small.ts", 380); // ~100 tokens

    const files = tracker.getTrackedFiles();
    expect(files.length).toBe(2);
    expect(files[0]?.filePath).toBe("src/index.ts");
    expect(files[0]?.estimatedTokens).toBe(1000);
    expect(files[0]?.readCount).toBe(1);

    // Turn 1
    tracker.advanceTurn();
    tracker.recordFileEdit("src/small.ts", 760); // updated to 200 tokens
    const updated = tracker.getTrackedFiles();
    const small = updated.find((f) => f.filePath === "src/small.ts");
    expect(small?.editCount).toBe(1);
    expect(small?.lastSeenTurn).toBe(1);
  });

  it("triggers context governance recommendations on dominating files", () => {
    const tracker = new FileContextTracker({ contextWindowCapacity: 10000, monopolyThresholdPct: 30 });

    // Inject massive file that consumes > 30% of context
    tracker.recordFileRead("huge-bundle.js", 19000); // 5000 tokens (50% of capacity)
    tracker.recordFileRead("config.json", 380); // 100 tokens

    const report = tracker.getGovernanceReport();
    expect(report.hasMonopolizingFiles).toBe(true);
    expect(report.topDominatingFiles.length).toBeGreaterThan(0);
    expect(report.topDominatingFiles[0]?.filePath).toBe("huge-bundle.js");
    expect(report.recommendations.some((r) => r.includes("huge-bundle.js"))).toBe(true);
  });
});
