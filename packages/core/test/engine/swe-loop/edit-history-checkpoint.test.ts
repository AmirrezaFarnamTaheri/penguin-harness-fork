import { describe, expect, it } from "vitest";

import { EditHistory } from "../../../src/engine/swe-loop/edit-history-checkpoint.js";

describe("EditHistory push and content model", () => {
  it("derives before from the live content and makes after the live content", () => {
    const history = new EditHistory();
    const first = history.push("src/a.ts", "export const a = 1;");
    expect(first.before).toBe("");
    expect(first.after).toBe("export const a = 1;");
    expect(first.reverted).toBe(false);
    expect(history.getFile("src/a.ts")?.content).toBe("export const a = 1;");
    expect(history.getFile("src/a.ts")?.lastSeq).toBe(1);
    expect(history.getFile("src/a.ts")?.checkpointIds).toEqual([first.id]);
  });

  it("chains the previous content as the next before", () => {
    const history = new EditHistory();
    history.push("src/a.ts", "v1");
    const second = history.push("src/a.ts", "v2");
    expect(second.before).toBe("v1");
    expect(second.after).toBe("v2");
    expect(history.size()).toBe(2);
  });

  it("normalizes path separators on every entry", () => {
    const history = new EditHistory();
    const checkpoint = history.push("src\\nested\\a.ts", "x");
    expect(checkpoint.path).toBe("src/nested/a.ts");
    expect(history.getFile("src/nested/a.ts")).toBeDefined();
    expect(history.getFile("src\\nested\\a.ts")).toBeDefined();
  });

  it("seeds a baseline that is not itself a checkpoint", () => {
    const history = new EditHistory();
    history.seed("src/a.ts", "baseline");
    expect(history.size()).toBe(0);
    const checkpoint = history.push("src/a.ts", "baseline\nedited");
    expect(checkpoint.before).toBe("baseline");
    expect(history.listFiles()).toHaveLength(1);
  });

  it("seeds only into a path that has no content yet", () => {
    const history = new EditHistory();
    history.push("src/a.ts", "v1");
    history.seed("src/a.ts", "ignored");
    expect(history.getFile("src/a.ts")?.content).toBe("v1");
  });

  it("evicts the oldest checkpoint at the cap and keeps the path index honest", () => {
    const history = new EditHistory({ maxCheckpoints: 2 });
    history.push("src/a.ts", "v1");
    history.push("src/a.ts", "v2");
    history.push("src/a.ts", "v3");
    expect(history.size()).toBe(2);
    expect(
      history.getCheckpoint(history.getFile("src/a.ts")?.checkpointIds[0] as string)?.after,
    ).toBe("v2");
    expect(history.getFile("src/a.ts")?.checkpointIds).toHaveLength(2);
  });

  it("refuses an edit over the byte cap", () => {
    const history = new EditHistory({ maxCheckpointBytes: 8 });
    expect(() => history.push("src/a.ts", "0123456789")).toThrow(/checkpoint limit/);
  });

  it("survives an empty path", () => {
    const history = new EditHistory();
    expect(() => history.push("   ", "x")).not.toThrow();
    expect(history.listFiles()).toHaveLength(1);
  });
});

describe("EditHistory rollbackTo", () => {
  it("rolls later checkpoints back in reverse order, restoring the prior content", () => {
    const history = new EditHistory();
    history.seed("src/a.ts", "baseline");
    const first = history.push("src/a.ts", "baseline\none");
    const second = history.push("src/a.ts", "baseline\none\ntwo");

    const result = history.rollbackTo(first.id);
    // The most recent checkpoint is reverted first.
    expect(result.rolledBack).toEqual([second.id, first.id]);
    expect(result.refused).toHaveLength(0);
    expect(history.getFile("src/a.ts")?.content).toBe("baseline");
    expect(history.getCheckpoint(second.id)?.reverted).toBe(true);
    expect(history.getCheckpoint(first.id)?.reverted).toBe(true);
  });

  it("reverts every checkpoint recorded after the target, across paths", () => {
    const history = new EditHistory();
    history.seed("src/a.ts", "a-base");
    const a1 = history.push("src/a.ts", "a-base\none");
    const b1 = history.push("src/b.ts", "b-one");
    const a2 = history.push("src/a.ts", "a-base\none\ntwo");

    // rollbackTo is a timeline rewind, not a per-path undo: everything recorded
    // after the target goes back, whichever path it touched.
    const result = history.rollbackTo(a1.id);
    expect(result.rolledBack).toEqual([a2.id, b1.id, a1.id]);
    expect(history.getFile("src/a.ts")?.content).toBe("a-base");
    expect(history.getFile("src/b.ts")?.content).toBe("");
  });

  it("completes in well under the 100ms failed-test budget", () => {
    const history = new EditHistory();
    history.seed("src/a.ts", "baseline");
    for (let index = 0; index < 50; index++) history.push("src/a.ts", `baseline\n${index}`);
    const target = history.listCheckpoints()[5]?.id as string;

    const result = history.rollbackTo(target);
    expect(result.durationMs).toBeLessThan(100);
    expect(result.rolledBack.length).toBeGreaterThan(0);
  });

  it("refuses an unknown checkpoint id", () => {
    const history = new EditHistory();
    history.push("src/a.ts", "v1");
    const result = history.rollbackTo("does-not-exist");
    expect(result.rolledBack).toHaveLength(0);
    expect(result.refused[0]?.reason).toMatch(/not found/);
  });

  it("refuses to replay a checkpoint that was already rolled back over", () => {
    const history = new EditHistory();
    const first = history.push("src/a.ts", "v1");
    history.push("src/a.ts", "v2");

    expect(history.rollbackTo(first.id).rolledBack).toHaveLength(2);
    // Rolling back to the same handle again cannot restore content that the
    // first rollback already moved away from.
    const second = history.rollbackTo(first.id);
    expect(second.rolledBack).toHaveLength(0);
    expect(second.refused.map((refusal) => refusal.checkpointId)).toContain(first.id);
  });

  it("refuses when the live content diverged from the recorded post-edit state", () => {
    const history = new EditHistory();
    const first = history.push("src/a.ts", "v1");
    history.push("src/a.ts", "v2");
    history.rollbackTo(first.id);
    // A later edit moves the file on, so the target's precondition is stale.
    history.push("src/a.ts", "diverged");

    const result = history.rollbackTo(first.id);
    expect(result.rolledBack).not.toContain(first.id);
    expect(result.refused.map((refusal) => refusal.checkpointId)).toContain(first.id);
    expect(history.getFile("src/a.ts")?.content).toBe("");
  });

  it("delegates the failed-test path to the same rollback machinery", () => {
    const history = new EditHistory();
    history.seed("src/a.ts", "baseline");
    const preTest = history.push("src/a.ts", "baseline\nimplementation");
    history.push("src/a.ts", "baseline\nimplementation\nbroken");

    const result = history.rollbackForFailedTest(preTest.id);
    expect(result.rolledBack).toContain(preTest.id);
    expect(history.getFile("src/a.ts")?.content).toBe("baseline");
  });
});

describe("EditHistory extractDiff", () => {
  it("reports the net change per path against the earliest baseline", () => {
    const history = new EditHistory();
    history.push("src/a.ts", "one\ntwo");
    history.push("src/a.ts", "one\ntwo\nthree\nfour");

    const diff = history.extractDiff();
    expect(diff).toHaveLength(1);
    expect(diff[0]?.path).toBe("src/a.ts");
    expect(diff[0]?.before).toBe("");
    expect(diff[0]?.after).toBe("one\ntwo\nthree\nfour");
    expect(diff[0]?.changedLines).toBe(4);
  });

  it("reports the post-rollback state, not the pre-rollback one", () => {
    const history = new EditHistory();
    history.seed("src/a.ts", "keep\nkeep");
    const first = history.push("src/a.ts", "keep\nkeep\nadded");
    history.push("src/a.ts", "keep\nkeep\nadded\nmore");

    expect(history.extractDiff()[0]?.after).toBe("keep\nkeep\nadded\nmore");
    history.rollbackTo(first.id);
    expect(history.extractDiff()[0]?.after).toBe("keep\nkeep");
    expect(history.extractDiff()[0]?.changedLines).toBe(0);
  });

  it("covers every path the history touched", () => {
    const history = new EditHistory();
    history.push("src/a.ts", "a");
    history.push("src/b.ts", "b");
    expect(
      history
        .extractDiff()
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("EditHistory snapshot", () => {
  it("serializes the checkpoint stack and the file count", () => {
    const history = new EditHistory();
    history.push("src/a.ts", "a1");
    history.push("src/b.ts", "b1");
    const snapshot = history.snapshot();
    expect(snapshot.files).toBe(2);
    expect(snapshot.checkpoints).toHaveLength(2);
    expect(snapshot.checkpoints.map((checkpoint) => checkpoint.reverted)).toEqual([false, false]);
  });
});
