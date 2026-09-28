import { describe, expect, it } from "vitest";
import {
  abortEvent,
  approvalDecision,
  hookEvent,
  toolCall,
  requestEnd,
  toolCallOutput,
  userSteeringText,
  userText,
} from "@prismshadow/penguin-core/omnimessage";
import {
  collectCoordinationActivity,
  coordinationActivityFor,
  toolOutcome,
} from "../src/features/chat/cross-agent-activity";
import { createStreamModel, pushMessage } from "../src/lib/omni/stream-model";
import { S } from "../src/lib/strings";
import type { StreamModel, ToolCallItem } from "../src/lib/omni/stream-model";

const agent = () => "tester";

function childWithAdvisory(choice = "different_tool"): StreamModel {
  const child = createStreamModel();
  pushMessage(
    child,
    hookEvent({
      hook: "pre_tool_use",
      name: "jev_advisory",
      toolCallId: "c1",
      output: {
        jev_status: "advised",
        jev_choice: choice,
        jev_confidence: 0.74,
        jev_risk_score: 2,
      },
    }),
  );
  pushMessage(child, toolCall({ name: "read_file", arguments: "{}", toolCallId: "c1" }));
  pushMessage(child, toolCallOutput({ toolCallId: "c1", output: "done" }));
  return child;
}

describe("coordination activity", () => {
  it("walks the whole Task from the root, attributing each row to the agent that acted", () => {
    const parent = createStreamModel();
    const child = childWithAdvisory();
    pushMessage(parent, toolCall({ name: "bash", arguments: "{}", toolCallId: "p1" }));
    pushMessage(parent, toolCallOutput({ toolCallId: "p1", output: "ok" }));
    parent.subagents.set("child-session", child);

    const rows = collectCoordinationActivity(parent, "parent-session", agent);
    // Document order, across the boundary: the parent's call, then the child's observation and
    // its call. The old comparator pushed every timestamped row ahead of every untimestamped
    // one, which listed the child's call before the parent's.
    expect(rows.map((row) => row.kind)).toEqual(["tool", "advisory", "tool"]);
    expect(rows[0]).toMatchObject({ kind: "tool", subjectId: "parent-session", depth: 0 });
    expect(rows[1]).toMatchObject({
      kind: "advisory",
      subjectId: "child-session",
      depth: 1,
      advisory: { choice: "different_tool" },
    });
    // No row is ever attributed to the session it is ABOUT when that differs from the walker.
    expect(rows.every((row) => row.agent === "tester")).toBe(true);
  });

  it("walks exactly the subtree it is rooted at, which is why the panel roots it at the Session", () => {
    const parent = createStreamModel();
    const child = childWithAdvisory();
    pushMessage(parent, toolCall({ name: "bash", arguments: "{}", toolCallId: "p1" }));
    parent.subagents.set("child-session", child);

    // (model, sessionId) is a pair: a StreamModel carries no id of its own, so nothing can check
    // the pairing. Rooted at the parent's own model the log covers the whole Task; rooted at the
    // child's model it covers the child. That is exactly why subagents-view passes the
    // conversation's model and id unconditionally — the old version passed the SELECTED child,
    // so the log's contents changed meaning whenever a different node was clicked, under one
    // tab name.
    const fromRoot = collectCoordinationActivity(parent, "parent-session", agent);
    const fromChild = collectCoordinationActivity(child, "child-session", agent);
    expect(fromRoot.map((r) => r.kind)).toEqual(["tool", "advisory", "tool"]);
    expect(fromChild.map((r) => r.kind)).toEqual(["advisory", "tool"]);
  });

  it("reports a policy-blocked call as blocked, never as completed", () => {
    const m = createStreamModel();
    pushMessage(m, toolCall({ name: "bash", arguments: "{}", toolCallId: "b1" }));
    pushMessage(m, approvalDecision("forbidden", "b1"));
    pushMessage(m, toolCallOutput({ toolCallId: "b1", output: "" }));
    const card = m.toolCards.get("b1") as ToolCallItem;
    // A policy veto still emits an output message, so an outputComplete-only map calls this
    // "completed" — a blocked command reported as one that ran.
    expect(card.outputComplete).toBe(true);
    expect(card.decision).toBe("forbidden");
    expect(toolOutcome(card).tone).toBe("danger");
  });

  it("names who decided, and reports a call still awaiting approval", () => {
    const decided = {
      kind: "tool_call",
      decision: "deny",
      decisionSource: "manual",
      outputComplete: true,
      output: "",
    } as unknown as ToolCallItem;
    // Asserted against the dictionary, not an English literal: the suite runs under zh.
    expect(toolOutcome(decided).text).toBe(`${S.chat.decisionDeny} · ${S.chat.decisionManual}`);

    const waiting = { kind: "tool_call", outputComplete: true, output: "" } as ToolCallItem;
    expect(toolOutcome(waiting).tone).toBe("attention");
  });

  it("is a total order: rows never disagree with themselves", () => {
    const parent = createStreamModel();
    const a = createStreamModel();
    const b = createStreamModel();
    pushMessage(a, toolCall({ name: "x", arguments: "{}", toolCallId: "a" }));
    pushMessage(b, toolCall({ name: "y", arguments: "{}", toolCallId: "b" }));
    parent.subagents.set("a", a);
    parent.subagents.set("b", b);
    const rows = collectCoordinationActivity(parent, "root", agent);
    const orders = rows.map((r) => r.order);
    // A comparator that pushed timestamped rows ahead of untimestamped ones was non-transitive;
    // arrival order is a total order by construction.
    expect(orders).toEqual([...orders].sort((x, y) => x - y));
  });

  it("does not confuse two different trees that share every aggregate", () => {
    // The signature used to count items, advisories and settled calls and SUM their stamps. Two
    // genuinely different states share all of those: two calls stamped 1000 + 2000, against the
    // same two calls stamped 1500 + 1500. Same counts, same sum, different log — and a guard that
    // cannot tell them apart serves the wrong rows.
    const model = createStreamModel();
    pushMessage(model, toolCall({ name: "a", arguments: "{}", toolCallId: "a1" }));
    pushMessage(model, toolCall({ name: "b", arguments: "{}", toolCallId: "b1" }));
    model.toolCards.get("a1")!.callStartedAtMs = 1000;
    model.toolCards.get("b1")!.callStartedAtMs = 2000;
    const first = coordinationActivityFor(model, "root", agent);
    expect(first.filter((r) => r.kind === "tool").map((r) => r.atMs)).toEqual([1000, 2000]);

    model.toolCards.get("a1")!.callStartedAtMs = 1500;
    model.toolCards.get("b1")!.callStartedAtMs = 1500;
    const second = coordinationActivityFor(model, "root", agent);
    // The walk really ran again, and the log reflects the NEW stamps.
    expect(second).not.toBe(first);
    expect(second.filter((r) => r.kind === "tool").map((r) => r.atMs)).toEqual([1500, 1500]);
  });

  it("shows a REPLACED advisory rather than the one it replaced", () => {
    // `card.advisory` is overwritten when a second observation arrives for the same call. The row
    // holds a reference to the advisory OBJECT, so a cached row would render the old verdict.
    const model = createStreamModel();
    pushMessage(model, toolCall({ name: "a", arguments: "{}", toolCallId: "a1" }));
    pushMessage(
      model,
      hookEvent({
        hook: "pre_tool_use",
        name: "jev_advisory",
        toolCallId: "a1",
        output: { jev_status: "advised", jev_choice: "matches" },
      }),
    );
    const first = coordinationActivityFor(model, "root", agent);
    expect(first.find((r) => r.kind === "advisory")).toMatchObject({
      advisory: { choice: "matches" },
    });

    model.toolCards.get("a1")!.advisory = { status: "advised", choice: "different_tool" };
    const second = coordinationActivityFor(model, "root", agent);
    expect(second.find((r) => r.kind === "advisory")).toMatchObject({
      advisory: { choice: "different_tool" },
    });
  });

  it("shows the failures too, not only the successes", () => {
    // A coordination log that only reports messages and completed tools is the log a reader opens
    // AFTER something went wrong, and it would show them nothing. A child's provider failure, a
    // retried request and an aborted run are the whole point of a cross-agent view.
    const parent = createStreamModel();
    const child = createStreamModel();
    pushMessage(child, toolCall({ name: "read_file", arguments: "{}", toolCallId: "c1" }));
    pushMessage(child, requestEnd("fatal", { errorCode: "network" }));
    pushMessage(child, requestEnd("retryable", { attempt: 2, retryInMs: 500 }));
    pushMessage(child, abortEvent("backoff_interrupted"));
    parent.subagents.set("child", child);

    const rows = collectCoordinationActivity(parent, "root", agent);
    expect(rows.map((r) => r.kind)).toEqual(["tool", "error", "retry", "abort"]);
    expect(rows[1]).toMatchObject({ kind: "error", detail: "network", depth: 1 });
    // gaveUp is true here and that is correct: the abort that follows ended the pending wait, so
    // the retry record is a give-up. The retrying-vs-gave-up transition is pinned on its own below.
    expect(rows[2]).toMatchObject({ kind: "retry", attempt: 2, gaveUp: true });
    expect(rows[3]).toMatchObject({ kind: "abort", detail: "backoff_interrupted" });
  });

  it("never copies a provider's own error text into a log row", () => {
    // The conversation renders the provider's wording once, in place. A log row outlives the
    // banner, and a provider message is exactly where a URL, a token fragment or a customer
    // identifier ends up. The row carries the machine-readable code or nothing.
    const model = createStreamModel();
    pushMessage(
      model,
      requestEnd("fatal", {
        errorCode: "rejected",
        errorMessage:
          "upstream https://attacker.example/steal?token=sk-abcdefghijklmnopqrstuvwx failed",
      }),
    );
    const row = collectCoordinationActivity(model, "root", agent)[0];
    expect(row).toMatchObject({ kind: "error", detail: "rejected" });
    expect(JSON.stringify(row)).not.toContain("attacker.example");
    expect(JSON.stringify(row)).not.toContain("sk-abcdefghij");
  });

  it("distinguishes a retry in progress from one that gave up", () => {
    // "Retrying" and "gave up" are the same row to a reader who is not told which, and they mean
    // opposite things about whether the agent is still working.
    const model = createStreamModel();
    pushMessage(model, requestEnd("retryable", { attempt: 1, retryInMs: 500 }));
    // While a wait is pending the row says "retrying"; the stream keeps ONE reconnect record per
    // model and advances it, so the next request_end is not a second row.
    expect(collectCoordinationActivity(model, "root", agent)[0]).toMatchObject({
      kind: "retry",
      attempt: 1,
      gaveUp: false,
    });
    // The run then announces no further retry, and the same row becomes a give-up.
    pushMessage(model, requestEnd("retryable", { attempt: 3 }));
    const rows = collectCoordinationActivity(model, "root", agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "retry", attempt: 3, gaveUp: true });
  });

  it("shows both directions of a parent-child exchange, not just the parent's half", () => {
    // The log exists to answer "what did the agents say to each other". Only the parent's
    // steering used to appear, so a child answering one looked as though it had said nothing.
    const parent = createStreamModel();
    const child = createStreamModel();
    pushMessage(parent, userText("do the thing"));
    // `sender` is userText's second argument; userSteeringText only wraps the text in its marker.
    pushMessage(child, userText(userSteeringText("focus on the tests"), "parent_agent"));
    pushMessage(child, userText("understood, checking the suite"));
    parent.subagents.set("child", child);

    const rows = collectCoordinationActivity(parent, "root", agent);
    const messages = rows.filter((r) => r.kind === "message");
    expect(messages).toHaveLength(3);
    // Role attribution, not just presence: the human at the top, the parent mid-flight, and the
    // child's own input are three different rows.
    expect(messages.map((m) => (m.kind === "message" ? m.role : null))).toEqual([
      "you",
      "parent",
      "child",
    ]);
    expect(messages[2]).toMatchObject({ subjectId: "child", depth: 1 });
  });

  it("serves a cached walk without ever serving a stale one", () => {
    // The cache exists so a long Task does not re-walk every model ~8 times a second. It must not
    // be able to show an old row: a call that settles and gains a timestamp, and an advisory that
    // binds after its card, both have to appear.
    const model = createStreamModel();
    pushMessage(model, toolCall({ name: "bash", arguments: "{}", toolCallId: "c1" }));
    const before = coordinationActivityFor(model, "root", agent);
    const toolBefore = before.find((r) => r.kind === "tool");
    const originalAtMs = toolBefore?.atMs;
    expect(originalAtMs).toBeTypeOf("number");

    // A settled call's stamp is corrected, and an advisory binds to the card.
    const card = model.toolCards.get("c1")!;
    card.callStartedAtMs = 1_700_000_000_000;
    card.outputComplete = true;
    card.advisory = { status: "advised", choice: "matches" };
    pushMessage(
      model,
      hookEvent({
        hook: "pre_tool_use",
        name: "jev_advisory",
        toolCallId: "c1",
        output: { jev_status: "advised", jev_choice: "matches" },
      }),
    );

    const after = coordinationActivityFor(model, "root", agent);
    // The new row is there…
    expect(after.some((r) => r.kind === "advisory")).toBe(true);
    // …and the old row's copied timestamp was NOT reused.
    const toolAfter = after.find((r) => r.kind === "tool");
    expect(toolAfter?.atMs).toBe(1_700_000_000_000);
  });

  it("returns the identical row objects when nothing changed", () => {
    // The point of the cache: an unchanged tree must not rebuild its rows.
    const model = createStreamModel();
    pushMessage(model, toolCall({ name: "bash", arguments: "{}", toolCallId: "c1" }));
    const first = coordinationActivityFor(model, "root", agent);
    const second = coordinationActivityFor(model, "root", agent);
    expect(second).toBe(first);
  });
});
