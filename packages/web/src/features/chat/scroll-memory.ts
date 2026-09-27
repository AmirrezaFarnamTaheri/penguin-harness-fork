/**
 * Scroll memory for the conversation list: where the reader had got to in each conversation
 * they had scrolled away from (pure decisions, unit tested).
 *
 * The stream already has a good follow model (stream-follow.ts) — it answers "should this view
 * keep snapping to the tail while it grows". What it does not answer is the question you only
 * ask when you come BACK: you scrolled up to re-read something, you clicked another
 * conversation to check something, and opening the first one dropped you at the bottom again,
 * with the message you were reading somewhere above you and no way to know how far.
 *
 * The memory only ever holds a position for a reader who was NOT following the tail. If you
 * were at the bottom, the existing stick-to-bottom is already the correct answer, and
 * recording a scrollTop that is about to be re-snapped would only give the restore something
 * stale to apply.
 *
 * Restoring the RAW offset, not a proportion, is deliberate. A conversation grows by APPENDING
 * at the bottom, so the content a reader had scrolled up to is still exactly `top` pixels down
 * when they return — a proportional restore would slide them down by however much arrived
 * while they were away, which is the one direction they had already asked not to move. The
 * opposite case, content shrinking (a compaction, a collapsed group), simply clamps: the
 * browser pins scrollTop at the new maximum, which is the closest honest answer.
 *
 * The store is bounded. The key is a Session id from the server, so an unbounded map is a
 * memory cost set entirely by the other end — the same argument that caps the pending
 * advisory buffer. Eviction is least-recently-stored: a conversation you keep coming back to
 * keeps its place, and one you have not opened since a dozen others still costs one slot.
 */

/** What is remembered about one conversation. */
export interface ScrollMemory {
  /** Raw `scrollTop` at the moment the reader left. */
  readonly top: number;
  /** Whether the reader was following the tail. Only `false` is ever stored — see above. */
  readonly following: boolean;
  /** When it was stored, as a monotonically increasing counter (never a clock: see `tick`). */
  readonly seq: number;
}

export interface ScrollMemoryStore {
  /** Record where the reader left `sessionId`. A following reader is recorded as `following`. */
  remember(sessionId: string, top: number, following: boolean): void;
  /** The remembered position, or undefined for a conversation never left mid-scroll (or evicted). */
  recall(sessionId: string): ScrollMemory | undefined;
  /** Drop one conversation — a delete, or an explicit "start me at the bottom". */
  forget(sessionId: string): void;
  /** Number of conversations currently remembered. */
  readonly size: number;
  /** The counter the store stamps entries with. Exposed so a restore can be ordered against a re-store. */
  tick(): number;
  clear(): void;
}

/** Default capacity: enough for a long working session, small enough to be free. */
export const SCROLL_MEMORY_CAPACITY = 40;

export function createScrollMemoryStore(
  capacity: number = SCROLL_MEMORY_CAPACITY,
): ScrollMemoryStore {
  // A Map iterates in insertion order, which is exactly the recency order we need: re-storing
  // an existing key does NOT move it, so the fix is to delete before setting.
  const entries = new Map<string, ScrollMemory>();
  let seq = 0;
  const cap = Math.max(1, Math.floor(capacity));

  const evictIfNeeded = () => {
    while (entries.size > cap) {
      const oldest = entries.keys().next();
      if (oldest.done === true) return;
      entries.delete(oldest.value);
    }
  };

  return {
    remember(sessionId, top, following) {
      seq += 1;
      // Re-storing must refresh recency, and Map.set on an existing key does not reorder it.
      entries.delete(sessionId);
      entries.set(sessionId, {
        // A negative or NaN offset is not a position; treat it as the top rather than
        // poisoning the recall with a value the browser would immediately clamp anyway.
        top: Number.isFinite(top) && top > 0 ? top : 0,
        following,
        seq,
      });
      evictIfNeeded();
    },
    recall(sessionId) {
      return entries.get(sessionId);
    },
    forget(sessionId) {
      entries.delete(sessionId);
    },
    get size() {
      return entries.size;
    },
    tick() {
      return seq;
    },
    clear() {
      entries.clear();
    },
  };
}

/** One store for the app: Session ids are unique, so a singleton is safe and lets the stream read it without prop-drilling. */
export const scrollMemory: ScrollMemoryStore = createScrollMemoryStore();
