import { describe, expect, it } from "vitest";

import { MeshProtocol } from "../../../src/engine/swarm/mesh-protocol.js";
import {
  AnnouncementDirectory,
  type AnnouncementEvent,
} from "../../../src/engine/swarm/agent-announcement.js";

describe("AnnouncementDirectory leases", () => {
  it("records an announcement and serves it back", () => {
    const directory = new AnnouncementDirectory({ defaultTtlMs: 60_000 });
    const announcement = directory.announce({
      agentId: "architect-lead",
      capabilities: ["architecture", "design"],
      role: "architect_lead",
    });
    expect(announcement.capabilities).toEqual(["architecture", "design"]);
    expect(directory.get("architect-lead")?.role).toBe("architect_lead");
  });

  it("treats an unchanged re-announcement as idempotent", () => {
    const directory = new AnnouncementDirectory();
    const first = directory.announce({ agentId: "a", capabilities: ["testing"] });
    const second = directory.announce({ agentId: "a", capabilities: ["testing"] });
    expect(second.revision).toBe(first.revision);
    expect(directory.count()).toBe(1);
  });

  it("bumps the revision only on a material capability change", () => {
    const directory = new AnnouncementDirectory();
    const first = directory.announce({ agentId: "a", capabilities: ["testing"] });
    const changed = directory.announce({ agentId: "a", capabilities: ["testing", "debugging"] });
    expect(changed.revision).toBeGreaterThan(first.revision);
  });

  it("expires an announcement once its lease elapses", () => {
    const directory = new AnnouncementDirectory({ defaultTtlMs: 60_000 });
    directory.announce({ agentId: "a", capabilities: ["research"] });
    const expired = directory.sweep(Date.now() + 120_000);
    expect(expired).toEqual(["a"]);
    expect(directory.get("a")).toBeUndefined();
  });

  it("renews the lease so a sweep keeps the announcement", () => {
    const directory = new AnnouncementDirectory({ defaultTtlMs: 60_000 });
    directory.announce({ agentId: "a", capabilities: ["research"] });
    directory.renew("a");
    expect(directory.sweep(Date.now() + 30_000)).toHaveLength(0);
  });

  it("distinguishes explicit revocation from expiry", () => {
    const directory = new AnnouncementDirectory();
    directory.announce({ agentId: "a", capabilities: ["research"] });
    expect(directory.revoke("a")).toBe(true);
    expect(directory.get("a")).toBeUndefined();
    expect(directory.revoke("a")).toBe(false);
  });

  it("enforces the cardinality limit", () => {
    const directory = new AnnouncementDirectory({ maxAnnouncements: 1 });
    directory.announce({ agentId: "a" });
    expect(() => directory.announce({ agentId: "b" })).toThrow(/cardinality limit/);
  });
});

describe("AnnouncementDirectory capability index", () => {
  it("answers a capability query without scanning the mesh", () => {
    const directory = new AnnouncementDirectory();
    directory.announce({ agentId: "a", capabilities: ["security", "code_review"], priority: 5 });
    directory.announce({ agentId: "b", capabilities: ["security"], priority: 9 });

    const matches = directory.query({ capability: "security" });
    expect(matches.map((m) => m.agentId)).toEqual(["b", "a"]);
    expect(directory.agentsWithCapability("code_review")).toEqual(["a"]);
  });

  it("filters by role and freshness", () => {
    const directory = new AnnouncementDirectory();
    directory.announce({ agentId: "a", capabilities: ["testing"], role: "test_engineer" });
    directory.announce({ agentId: "b", capabilities: ["testing"], role: "bug_isolator" });

    expect(directory.query({ capability: "testing", role: "test_engineer" })).toHaveLength(1);
    expect(
      directory.query({ capability: "testing", fresherThanMs: 1 }).map((m) => m.agentId),
    ).toHaveLength(2);
  });

  it("caps the result count", () => {
    const directory = new AnnouncementDirectory();
    for (const id of ["a", "b", "c"])
      directory.announce({ agentId: id, capabilities: ["research"] });
    expect(directory.query({ capability: "research", limit: 2 })).toHaveLength(2);
  });

  it("drops a capability from the index when its agent revokes", () => {
    const directory = new AnnouncementDirectory();
    directory.announce({ agentId: "a", capabilities: ["research"] });
    directory.revoke("a");
    expect(directory.agentsWithCapability("research")).toHaveLength(0);
  });

  it("lists only live announcements", () => {
    const directory = new AnnouncementDirectory({ defaultTtlMs: 60_000 });
    directory.announce({ agentId: "a" });
    directory.announce({ agentId: "b" });
    directory.sweep(Date.now() + 120_000);
    expect(directory.list()).toHaveLength(0);
  });
});

describe("AnnouncementDirectory observers", () => {
  it("notifies on join and on material change, not on silent renewal", () => {
    const directory = new AnnouncementDirectory();
    const events: AnnouncementEvent[] = [];
    directory.subscribe((event) => events.push(event));

    directory.announce({ agentId: "a", capabilities: ["testing"] });
    directory.renew("a");
    directory.announce({ agentId: "a", capabilities: ["testing", "ci"] });

    expect(events.map((event) => event.type)).toEqual(["joined", "updated"]);
  });

  it("reports expiry to observers", () => {
    const directory = new AnnouncementDirectory({ defaultTtlMs: 60_000 });
    const events: AnnouncementEvent[] = [];
    directory.subscribe((event) => events.push(event));
    directory.announce({ agentId: "a", capabilities: ["research"] });
    directory.sweep(Date.now() + 120_000);
    expect(events.map((event) => event.type)).toContain("expired");
  });

  it("unsubscribes cleanly", () => {
    const directory = new AnnouncementDirectory();
    const events: AnnouncementEvent[] = [];
    const unsubscribe = directory.subscribe((event) => events.push(event));
    unsubscribe();
    directory.announce({ agentId: "a" });
    expect(events).toHaveLength(0);
  });
});

describe("AnnouncementDirectory gossip", () => {
  it("broadcasts local announcements over the mesh", () => {
    const directory = new AnnouncementDirectory();
    directory.announce({ agentId: "a", capabilities: ["research"] });
    const mesh = new MeshProtocol();
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");

    const outcome = directory.gossipOverMesh(mesh, "a");
    expect(outcome.sent).toBe(1);
  });

  it("merges a gossip payload from a peer without re-importing its own entry", () => {
    const directory = new AnnouncementDirectory();
    const mesh = new MeshProtocol();
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");

    directory.announce({ agentId: "a", capabilities: ["research"] });
    directory.gossipOverMesh(mesh, "a");

    const peerDirectory = new AnnouncementDirectory();
    peerDirectory.announce({ agentId: "b", capabilities: ["testing"] });
    const envelope = mesh.send("b", "a", "swarm.announcement.gossip", {
      origin: "b",
      announcements: [{ agentId: "b", capabilities: ["testing"] }],
    });
    expect(envelope.delivered).toBe(true);

    const merged = peerDirectory.mergeGossipPayload(
      { origin: "b", announcements: [{ agentId: "b", capabilities: ["testing"] }] },
      "b",
    );
    expect(merged).toBe(0);
  });

  it("ignores malformed gossip payloads", () => {
    const directory = new AnnouncementDirectory();
    expect(directory.mergeGossipPayload(null, "local")).toBe(0);
    expect(directory.mergeGossipPayload({ announcements: "nope" }, "local")).toBe(0);
  });
});
