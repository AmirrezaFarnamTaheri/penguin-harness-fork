/**
 * The dead-letter store must not become the one unbounded structure in the kernel.
 *
 * Every other mailbox structure is capped: inbox depth, payload size, mailbox cardinality. The
 * dead-letter store was not, and it is reached precisely when things are going wrong — a message
 * that cannot be delivered keeps failing, and each failure appended a full `MailboxMessage`
 * (payload included) to an array that was never trimmed. A stuck consumer therefore grew memory
 * without limit for as long as the kernel lived, and the failure that produced it is exactly the
 * situation where nobody is watching the mailbox.
 */
import { describe, expect, it } from "vitest";
import { MailboxKernel } from "../src/agent/mailbox.js";

/** A payload large enough that a leak is obvious in aggregate, small enough to keep the test fast. */
const PAYLOAD = { blob: "x".repeat(1000) };

describe("MailboxKernel dead-letter retention", () => {
  it("keeps the dead-letter store bounded per mailbox, dropping the oldest", () => {
    const mb = new MailboxKernel({ maxDeadLetters: 3 });

    const first = mb.send("worker", "orchestrator", "task", PAYLOAD);
    const ids: string[] = [first.id];
    for (let i = 0; i < 9; i += 1) {
      const msg = mb.send("worker", "orchestrator", "task", PAYLOAD);
      ids.push(msg.id);
      mb.deadLetter("worker", msg, `unprocessable #${i}`);
    }

    const dead = mb.getDeadLetters("worker");
    expect(dead).toHaveLength(3);
    // Oldest first: the first dead letters are the ones that age out, not the newest.
    expect(dead.map((d) => d.msg.id)).toEqual(ids.slice(-3));
  });

  it("bounds the number of mailboxes that keep dead letters, not just each one's depth", () => {
    // Depth alone is not a bound: 100 mailboxes × the per-mailbox cap is still a large retained
    // set, and the key set never shrank at all. Both axes have to be capped.
    const mb = new MailboxKernel({ maxDeadLetters: 2, maxDeadLetterMailboxes: 2 });

    for (const agent of ["a", "b", "c", "d"]) {
      const msg = mb.send(agent, "orchestrator", "task", PAYLOAD);
      mb.deadLetter(agent, msg, "unprocessable");
    }

    // The two most recent owners keep their letters; the earlier ones are forgotten entirely.
    expect(mb.getDeadLetters("c")).toHaveLength(1);
    expect(mb.getDeadLetters("d")).toHaveLength(1);
    expect(mb.getDeadLetters("a")).toHaveLength(0);
    expect(mb.getDeadLetters("b")).toHaveLength(0);
  });

  it("keeps dead letters in a structure that does not consume the live mailbox budget", () => {
    // The dead-letter store is keyed by owner name like `queues` is, but it is a different
    // structure with its own cap. Retaining a dead letter must not make the owner look like a
    // live mailbox, or a kernel that failed a lot of deliveries would refuse real mail.
    const mb = new MailboxKernel({ maxMailboxes: 1, maxDeadLetters: 5 });

    const ghost = mb.send("ghost", "orchestrator", "task", PAYLOAD);
    mb.deadLetter("ghost", ghost, "unprocessable");
    // "ghost" is still a live mailbox, so the single slot is its — as it was before the failure.
    expect(() => mb.send("other", "orchestrator", "task", PAYLOAD)).toThrow(
      /Maximum mailbox cardinality/,
    );

    // A dead letter for an owner that never received mail creates no mailbox at all.
    mb.deadLetter("never-seen", { ...ghost, toAgent: "never-seen" }, "no such agent");
    expect(mb.getDeadLetters("never-seen")).toHaveLength(1);
    expect(() => mb.send("third", "orchestrator", "task", PAYLOAD)).toThrow(
      /Maximum mailbox cardinality/,
    );
  });

  it("defaults to a bound that keeps a stuck consumer from growing without limit", () => {
    const mb = new MailboxKernel();
    const msg = mb.send("worker", "orchestrator", "task", PAYLOAD);
    for (let i = 0; i < 5_000; i += 1) mb.deadLetter("worker", msg, `boom ${i}`);

    // No option supplied: the default still has to be a ceiling, not "unlimited".
    expect(mb.getDeadLetters("worker").length).toBeLessThanOrEqual(1_000);
  });
});
