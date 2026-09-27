/**
 * The three organization writes that take an id the caller names and no id the request can prove:
 * attaching a session to a ticket, a channel message's `refs`, and deleting a calendar event. Each
 * has to answer for that id inside this organization — a same-Project session whose agent is not an
 * employee here, a reference that resolves to nothing, an agent that is not on the chart — because
 * all three end up recorded where this organization's employees read it: the ticket's cost roll-up,
 * the channel file, the calendar.
 *
 * On the org harness: the real file store, caches and service, with only the clock, the Agent
 * lifecycle and usage pricing doubled.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { serializeCalendarEvent } from "../src/organization/files.js";
import { DEFAULT_CHANNEL_ID, channelDayPath } from "../src/organization/paths.js";
import { makeOrgHarness } from "./org-harness.js";
import type { OrgHarness } from "./org-harness.js";

const P = "p1";
const ORG = "acme";
const CEO = "acme_ceo";
const HR = "acme_hr";
/** An Agent of the same Project that no organization employs. */
const OUTSIDER = "freelance_writer";
const T0 = Date.parse("2026-09-01T01:00:00Z");
const T0ISO = new Date(T0).toISOString();
const FIELDS = {
  prompt: "Sweep the inbox",
  enabled: true,
  startAt: "2026-09-02T10:00:00+08:00",
  period: "1d",
};

describe("organization integrity: ids a write has to answer for", () => {
  let h: OrgHarness;

  beforeEach(async () => {
    h = await makeOrgHarness({ nowMs: T0 });
    const { service, store } = h;
    await service.create(
      P,
      { orgId: ORG, name: "Acme", mission: "Run the marketplace.", timezone: "Asia/Shanghai" },
      "alice",
    );
    await fs.mkdir(path.join(store.dir(P, ORG), "workspace", "people"), { recursive: true });
    await service.hire(P, ORG, {
      newAgent: { agentId: HR },
      title: "HR",
      reportsTo: CEO,
      workspace: "people",
      budget: 20,
    });
  });

  /** A session of this Project, run by an agent this organization does not employ. */
  const outsiderSession = (sessionId: string, agentId = OUTSIDER): string => {
    h.sessions.insert({
      sessionId,
      projectId: P,
      agentId,
      provider: "custom",
      modelId: "m-bench",
      workspace: h.root,
      approvalMode: "allow-all",
      title: "A freelance writer's own work",
      client: "web",
      lastActiveAt: T0ISO,
      createdAt: T0ISO,
    });
    return sessionId;
  };

  describe("attaching a session to a ticket", () => {
    it("refuses a same-Project session whose agent is not an employee here, and moves no cost", async () => {
      const { service } = h;
      const t = await service.createTicket(
        P,
        ORG,
        { title: "Write the launch post", owner: `agent:${HR}` },
        { userId: "alice" },
      );
      const strangerWork = outsiderSession("session-2026-09-01-12-00-00-00000009");
      h.costs.set(strangerWork, 25);

      await expect(
        service.attachTicket(P, ORG, t.ticketId, strangerWork, { userId: "alice" }),
      ).rejects.toMatchObject({ status: 404, code: "employee_not_found" });

      // Nothing was written: not to the ticket, not to the cost roll-up, not to the session list
      // the organization shows, and no desk notice was queued.
      const after = await service.ticket(P, ORG, t.ticketId);
      expect(after.sessions).toEqual([]);
      expect(after.progress.filter((p) => p.text.includes(strangerWork))).toEqual([]);
      const finance = await service.finance(P, ORG);
      expect(finance.tickets.find((x) => x.ticketId === t.ticketId)?.cost).toBe(0);
      expect(finance.total).toBe(0);
      expect((await service.sessions(P, ORG)).tickets).toEqual([]);
      expect(h.events.filter((e) => e.type === "org_ticket" && e.change === "attached")).toEqual(
        [],
      );
    });

    it("still attaches an employee's own session, and the spend follows it", async () => {
      const { service } = h;
      const t = await service.createTicket(
        P,
        ORG,
        { title: "Write the launch post", owner: `agent:${HR}` },
        { userId: "alice" },
      );
      const desk = await service.desk(P, ORG, HR, {});
      h.costs.set(desk.sessionId, 30);

      const detail = await service.attachTicket(P, ORG, t.ticketId, desk.sessionId, {
        userId: "alice",
      });
      expect(detail.sessions).toEqual([desk.sessionId]);
      expect(detail.progress.at(-1)).toMatchObject({
        by: "user:alice",
        text: "attached a session",
        sessionId: desk.sessionId,
      });
      expect(h.events).toContainEqual({
        type: "org_ticket",
        projectId: P,
        orgId: ORG,
        ticketId: t.ticketId,
        change: "attached",
      });
      const finance = await service.finance(P, ORG);
      expect(finance.tickets.find((x) => x.ticketId === t.ticketId)?.cost).toBe(30);
      expect(finance.total).toBe(30);
      // The refusal above is the employee's bar, not a block on attaching at all: with the
      // employee's session on the ticket, another agent's still does not get on.
      const outsider = outsiderSession("session-2026-09-01-12-00-00-00000010");
      await expect(
        service.attachTicket(P, ORG, t.ticketId, outsider, { userId: "alice" }),
      ).rejects.toMatchObject({ status: 404, code: "employee_not_found" });
      expect((await service.ticket(P, ORG, t.ticketId)).sessions).toEqual([desk.sessionId]);
    });
  });

  describe("a channel message's refs", () => {
    it("keeps the refs that resolve and drops the ones that name nothing", async () => {
      const { service } = h;
      const t = await service.createTicket(
        P,
        ORG,
        { title: "Fix the footer", owner: `agent:${HR}` },
        { userId: "alice" },
      );
      const desk = await service.desk(P, ORG, HR, {});
      const work = await service.startTicket(
        P,
        ORG,
        t.ticketId,
        { agentId: HR },
        {
          userId: "alice",
          sessionId: desk.sessionId,
        },
      );

      const kept = await service.sendChannelMessage(P, ORG, "alice", DEFAULT_CHANNEL_ID, {
        text: "The footer is fixed; the ticket and its session are these.",
        refs: { ticket: t.ticketId, session: work.sessionId },
      });
      expect(kept.refs).toEqual({ ticket: t.ticketId, session: work.sessionId });

      // A ticket that does not exist, and a session of this Project run by an agent this
      // organization does not employ.
      const strangerWork = outsiderSession("session-2026-09-01-12-00-00-00000011");
      const dropped = await service.sendChannelMessage(P, ORG, "alice", DEFAULT_CHANNEL_ID, {
        text: "Picking this up again.",
        refs: {
          ticket: "2026-09-01-no-such-ticket",
          session: strangerWork,
          replyTo: kept.id,
        },
      });
      expect(dropped.refs).toEqual({ replyTo: kept.id });

      // A session id that names no session at all is dropped the same way, on its own.
      const neverExisted = "session-2026-09-01-00-00-99-99999999";
      const missing = await service.sendChannelMessage(P, ORG, "alice", DEFAULT_CHANNEL_ID, {
        text: "Starting a fresh thread.",
        refs: { session: neverExisted },
      });
      expect(missing.refs).toBeUndefined();

      // The line on disk is what the employees' agents read: the messages are there, the
      // references that resolve to nothing are not.
      const dir = h.store.dir(P, ORG);
      const days = await h.store.listMessageDays(dir, DEFAULT_CHANNEL_ID);
      expect(days).toEqual(["2026-09-01"]);
      const lines = (await fs.readFile(channelDayPath(dir, DEFAULT_CHANNEL_ID, days[0]!), "utf8"))
        .split("\n")
        .filter((l) => l.trim() !== "");
      const keptLine = lines.find((l) => l.includes("The footer is fixed"))!;
      const droppedLine = lines.find((l) => l.includes("Picking this up again"))!;
      const missingLine = lines.find((l) => l.includes("Starting a fresh thread"))!;
      expect(keptLine).toContain(t.ticketId);
      expect(keptLine).toContain(work.sessionId);
      expect(droppedLine).not.toContain("2026-09-01-no-such-ticket");
      expect(droppedLine).not.toContain(strangerWork);
      expect(droppedLine).toContain(kept.id);
      expect(missingLine).not.toContain(neverExisted);
      expect(missingLine).not.toContain('"refs"');
      // The service's own read path agrees with the file.
      const read = await service.channelMessages(
        P,
        ORG,
        { userId: "alice" },
        DEFAULT_CHANNEL_ID,
        {},
      );
      const mine = read.messages.filter((m) => !m.sender.startsWith("system"));
      expect(mine.map((m) => m.refs)).toEqual([
        { ticket: t.ticketId, session: work.sessionId },
        { replyTo: kept.id },
        undefined,
      ]);
    });

    it("drops one ref and keeps the other in the same message", async () => {
      const { service } = h;
      const t = await service.createTicket(
        P,
        ORG,
        { title: "Fix the footer", owner: `agent:${HR}` },
        { userId: "alice" },
      );
      const desk = await service.desk(P, ORG, HR, {});
      const work = await service.startTicket(
        P,
        ORG,
        t.ticketId,
        { agentId: HR },
        {
          userId: "alice",
          sessionId: desk.sessionId,
        },
      );
      const msg = await service.sendChannelMessage(P, ORG, "alice", DEFAULT_CHANNEL_ID, {
        text: "Half of this is real.",
        refs: { ticket: "2026-09-01-no-such-ticket", session: work.sessionId },
      });
      expect(msg.refs).toEqual({ session: work.sessionId });
    });

    it("writes a message with no resolvable ref at all, and keeps the text", async () => {
      const { service } = h;
      const msg = await service.sendChannelMessage(P, ORG, "alice", DEFAULT_CHANNEL_ID, {
        text: "Nothing to point at yet.",
        refs: { ticket: "2026-09-01-no-such-ticket" },
      });
      expect(msg.refs).toBeUndefined();
      expect(msg.text).toBe("Nothing to point at yet.");
      const read = await service.channelMessages(
        P,
        ORG,
        { userId: "alice" },
        DEFAULT_CHANNEL_ID,
        {},
      );
      const mine = read.messages.filter((m) => !m.sender.startsWith("system"));
      expect(mine).toHaveLength(1);
      expect(mine[0]!.refs).toBeUndefined();
    });
  });

  describe("deleting a calendar event", () => {
    it("refuses an agent that is not an employee, and leaves the event alone", async () => {
      const { service, store } = h;
      const dir = store.dir(P, ORG);
      // Written straight to the store, the way an event from before the hire was, or a hand edit,
      // would sit there: a file the calendar already reports as belonging to nobody.
      await store.writeCalendarEvent(
        dir,
        OUTSIDER,
        "freelance-sweep",
        serializeCalendarEvent({ ...FIELDS, startAt: "2026-09-02T16:00:00+08:00" }),
      );
      expect((await service.calendar(P, ORG)).invalidFiles).toEqual([
        { agentId: OUTSIDER, name: "freelance-sweep", error: "belongs to no employee" },
      ]);

      await expect(
        service.deleteCalendar(P, ORG, OUTSIDER, "freelance-sweep"),
      ).rejects.toMatchObject({ status: 404, code: "employee_not_found" });
      await expect(
        store.readCalendarEvent(dir, OUTSIDER, "freelance-sweep"),
      ).resolves.not.toBeNull();
      // The write path already refused this id; the delete now answers the same way.
      await expect(
        service.upsertCalendar(P, ORG, OUTSIDER, "freelance-sweep", FIELDS, { create: true }),
      ).rejects.toMatchObject({ status: 404, code: "employee_not_found" });
    });

    it("still deletes an employee's event", async () => {
      const { service } = h;
      await service.upsertCalendar(P, ORG, HR, "hr-audit", FIELDS, { create: true });
      expect((await service.calendar(P, ORG)).events.map((e) => e.name)).toEqual(["hr-audit"]);

      await service.deleteCalendar(P, ORG, HR, "hr-audit");
      expect((await service.calendar(P, ORG)).events).toEqual([]);
      // A second delete is the 404 the event's own absence reports, not the employee's.
      await expect(service.deleteCalendar(P, ORG, HR, "hr-audit")).rejects.toMatchObject({
        status: 404,
        code: "calendar_event_not_found",
      });
    });
  });
});
