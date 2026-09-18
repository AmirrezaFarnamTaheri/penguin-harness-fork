/**
 * Edit-history checkpointing for the autonomous SWE loop.
 *
 * The plan sets a hard target: "rollback on failed test < 100ms". That rules
 * out any implementation that restores files by re-running a tool or spawning
 * a process — the rollback has to be an in-memory content swap. It also rules
 * out an implementation that rolls back blindly: if the file on disk no longer
 * matches what the checkpoint recorded, a rollback would silently destroy
 * someone else's edit. So every checkpoint stores the *before* content and a
 * rollback verifies the *current* content equals the recorded *after* before
 * doing anything, and fails loudly otherwise.
 *
 * That verification-and-refuse shape is ported directly from Hermes's
 * `hermes_state_rewind.py`, which refuses a rewind when the session history
 * changed underneath it rather than persisting an inconsistent state. The
 * checkpoint stack and per-step diff extraction come from SWE-agent's
 * trajectory, where each step carries the diff as part of its state so a dead
 * runtime can still be autosubmitted.
 *
 * This module holds the *content model* — it does not touch disk. A host
 * applies checkpoints to its real workspace; the < 100ms target is met
 * because every rollback here is a map lookup plus a string comparison.
 */

export interface EditCheckpoint {
  id: string;
  seq: number;
  path: string;
  /** File content before this edit (the rollback target). */
  before: string;
  /** File content after this edit (what a rollback must see to be safe). */
  after: string;
  appliedAt: number;
  appliedBy?: string;
  /** Set once rolled back over, so a checkpoint cannot be replayed twice. */
  reverted: boolean;
}

export interface RollbackResult {
  rolledBack: string[];
  /** Checkpoints refused because the live content diverged from `after`. */
  refused: Array<{ checkpointId: string; path: string; reason: string }>;
  durationMs: number;
}

export interface EditHistoryOptions {
  /** Max checkpoints retained; the oldest are evicted. */
  maxCheckpoints?: number;
  /** Max bytes of content in one checkpoint, a guard on memory. */
  maxCheckpointBytes?: number;
}

export interface FileView {
  path: string;
  content: string;
  /** Highest seq applied to this path. */
  lastSeq: number;
  /** Checkpoint ids for this path, oldest first. */
  checkpointIds: string[];
}

function generateCheckpointId(): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return `ckpt-${globalThis.crypto.randomUUID()}`;
  }
  return `ckpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export class EditHistory {
  private readonly checkpoints: EditCheckpoint[] = [];
  /** Live content model: path -> content. The rollback target swaps here. */
  private readonly contents = new Map<string, string>();
  private readonly byPath = new Map<string, string[]>();
  private seqCounter = 0;
  private readonly options: Required<EditHistoryOptions>;

  constructor(options: EditHistoryOptions = {}) {
    this.options = {
      maxCheckpoints: Math.max(1, options.maxCheckpoints ?? 512),
      maxCheckpointBytes: Math.max(1, options.maxCheckpointBytes ?? 4 * 1024 * 1024),
    };
  }

  public size(): number {
    return this.checkpoints.length;
  }

  public getCheckpoint(id: string): EditCheckpoint | undefined {
    const checkpoint = this.checkpoints.find((entry) => entry.id === id);
    return checkpoint ? { ...checkpoint } : undefined;
  }

  public listCheckpoints(): EditCheckpoint[] {
    return this.checkpoints.map((checkpoint) => ({ ...checkpoint }));
  }

  public getFile(path: string): FileView | undefined {
    const normalized = this.normalize(path);
    const content = this.contents.get(normalized);
    if (content === undefined) return undefined;
    return {
      path: normalized,
      content,
      lastSeq: this.lastSeqFor(normalized),
      checkpointIds: [...(this.byPath.get(normalized) ?? [])],
    };
  }

  public listFiles(): FileView[] {
    return Array.from(this.contents.keys()).map((path) => this.getFile(path) as FileView);
  }

  /** Seeds a file's baseline content; not itself a checkpointed edit. */
  public seed(path: string, content: string): FileView {
    const normalized = this.normalize(path);
    if (!this.contents.has(normalized)) this.contents.set(normalized, content);
    return this.getFile(normalized) as FileView;
  }

  /**
   * Records one edit: `before` is derived from the current live content (or
   * empty when the file is new), `after` becomes the live content. Returns the
   * checkpoint, whose id is the rollback handle.
   */
  public push(path: string, after: string, appliedBy?: string): EditCheckpoint {
    const normalized = this.normalize(path);
    if (after.length > this.options.maxCheckpointBytes) {
      throw new Error(
        `Edit on '${normalized}' is ${after.length} bytes, over the ${this.options.maxCheckpointBytes} checkpoint limit`,
      );
    }
    if (this.checkpoints.length >= this.options.maxCheckpoints) {
      const evicted = this.checkpoints.shift();
      if (evicted) this.dropFromPathIndex(evicted);
    }

    const before = this.contents.get(normalized) ?? "";
    this.seqCounter++;
    const checkpoint: EditCheckpoint = {
      id: generateCheckpointId(),
      seq: this.seqCounter,
      path: normalized,
      before,
      after,
      appliedAt: Date.now(),
      appliedBy,
      reverted: false,
    };
    this.checkpoints.push(checkpoint);
    this.contents.set(normalized, after);
    const ids = this.byPath.get(normalized) ?? [];
    ids.push(checkpoint.id);
    this.byPath.set(normalized, ids);
    return { ...checkpoint };
  }

  /**
   * Rolls back to `checkpointId` inclusive: every checkpoint recorded after it
   * is reverted, in strict reverse order, and the live content is restored to
   * that checkpoint's *before* state. A checkpoint is refused when the live
   * content no longer matches its recorded `after` — the file changed under
   * the loop, and restoring it would destroy that change.
   */
  public rollbackTo(checkpointId: string): RollbackResult {
    const started = performance.now();
    const index = this.checkpoints.findIndex((checkpoint) => checkpoint.id === checkpointId);
    if (index < 0) {
      return {
        rolledBack: [],
        refused: [{ checkpointId, path: "", reason: "checkpoint id not found in this history" }],
        durationMs: 0,
      };
    }

    const target = this.checkpoints[index] as EditCheckpoint;
    const rolledBack: string[] = [];
    const refused: RollbackResult["refused"] = [];

    for (let cursor = this.checkpoints.length - 1; cursor > index; cursor--) {
      const checkpoint = this.checkpoints[cursor] as EditCheckpoint;
      if (checkpoint.reverted) continue;
      const live = this.contents.get(checkpoint.path) ?? "";
      if (live !== checkpoint.after) {
        refused.push({
          checkpointId: checkpoint.id,
          path: checkpoint.path,
          reason:
            "live content diverged from the recorded post-edit content; refusing to overwrite a change made outside this history",
        });
        continue;
      }
      this.contents.set(checkpoint.path, checkpoint.before);
      checkpoint.reverted = true;
      rolledBack.push(checkpoint.id);
    }

    const targetLive = this.contents.get(target.path) ?? "";
    if (targetLive !== target.after) {
      refused.push({
        checkpointId: target.id,
        path: target.path,
        reason: "rollback target's precondition no longer holds",
      });
    } else {
      this.contents.set(target.path, target.before);
      target.reverted = true;
      rolledBack.push(target.id);
    }

    return {
      rolledBack,
      refused,
      durationMs: Math.max(0, performance.now() - started),
    };
  }

  /**
   * The plan's "< 100ms on failed test" path: roll the whole history back to
   * the checkpoint taken *before* the failing step. Refusals are reported
   * rather than ignored, so a partial rollback is never mistaken for success.
   */
  public rollbackForFailedTest(preTestCheckpointId: string): RollbackResult {
    return this.rollbackTo(preTestCheckpointId);
  }

  /**
   * Extracts a unified-diff-shaped record of the net change per path. Net
   * content per path is computed by replaying only the non-reverted
   * checkpoints, so a history that rolled back reports the post-rollback
   * state, not the pre-rollback one.
   */
  public extractDiff(): Array<{
    path: string;
    before: string;
    after: string;
    changedLines: number;
  }> {
    const paths = new Set<string>();
    for (const checkpoint of this.checkpoints) paths.add(checkpoint.path);

    const results: Array<{ path: string; before: string; after: string; changedLines: number }> =
      [];
    for (const path of paths) {
      const live = this.contents.get(path);
      const baseline = this.baselineFor(path);
      if (live === undefined) continue;
      const changed = this.countChangedLines(baseline, live);
      results.push({ path, before: baseline, after: live, changedLines: changed });
    }
    return results;
  }

  /** Serializes the history for a trajectory; checkpoints stay immutable. */
  public snapshot(): { checkpoints: EditCheckpoint[]; files: number } {
    return {
      checkpoints: this.checkpoints.map((checkpoint) => ({ ...checkpoint })),
      files: this.contents.size,
    };
  }

  // ---------------------------------------------------------------- internals

  private normalize(path: string): string {
    return path.trim().replace(/\\/g, "/");
  }

  private lastSeqFor(path: string): number {
    let last = 0;
    for (const checkpoint of this.checkpoints) {
      if (checkpoint.path === path && checkpoint.seq > last) last = checkpoint.seq;
    }
    return last;
  }

  private baselineFor(path: string): string {
    const ids = this.byPath.get(path) ?? [];
    if (ids.length === 0) return "";
    const first = this.checkpoints.find((checkpoint) => checkpoint.id === ids[0]);
    return first ? first.before : "";
  }

  private dropFromPathIndex(checkpoint: EditCheckpoint): void {
    const ids = this.byPath.get(checkpoint.path);
    if (!ids) return;
    const filtered = ids.filter((id) => id !== checkpoint.id);
    if (filtered.length === 0) this.byPath.delete(checkpoint.path);
    else this.byPath.set(checkpoint.path, filtered);
  }

  private countChangedLines(before: string, after: string): number {
    const beforeLines = new Set(before.split("\n"));
    return after.split("\n").filter((line) => !beforeLines.has(line)).length;
  }
}
