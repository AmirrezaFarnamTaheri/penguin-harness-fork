import { describe, expect, it } from "vitest";

import { MailboxKernel, type MailboxMessage } from "../../../src/agent/mailbox.js";
import {
  MESH_BROADCAST,
  MailboxKernelMeshTransport,
  MeshProtocol,
  type MeshEnvelope,
  type MeshLinkKind,
  type MeshTransport,
} from "../../../src/engine/swarm/mesh-protocol.js";

/** Collects envelopes so tests can assert on routing decisions directly. */
class CollectingTransport implements MeshTransport {
  public readonly delivered: Array<{ to: string; envelope: MeshEnvelope }> = [];

  public deliver<T = unknown>(to: string, envelope: MeshEnvelope<T>): MailboxMessage | null {
    this.delivered.push({ to, envelope: envelope as MeshEnvelope });
    // The mesh only cares whether delivery happened; the envelope is what the
    // test wants to inspect, and it satisfies the transport's contract here.
    return envelope as unknown as MailboxMessage;
  }

  public knowsRecipient(): boolean {
    return true;
  }
}

function meshWith(transport?: MeshTransport): MeshProtocol {
  return new MeshProtocol({ transport, staleAfterMs: 60_000, defaultTtl: 4 });
}

describe("MeshProtocol.join / liveness", () => {
  it("joins nodes with capabilities and rejects empty ids", () => {
    const mesh = meshWith();
    const node = mesh.join("alpha", ["planning", "delegation"]);
    expect(mesh.hasNode("alpha")).toBe(true);
    expect(node.capabilities).toEqual(["planning", "delegation"]);
    expect(() => mesh.join("")).toThrow(/cannot be empty/);
  });

  it("re-joins an existing node as a capability refresh, not a duplicate", () => {
    const mesh = meshWith();
    mesh.join("alpha", ["planning"]);
    const refreshed = mesh.join("alpha", ["planning", "security"]);
    expect(mesh.listNodes()).toHaveLength(1);
    expect(refreshed.capabilities).toEqual(["planning", "security"]);
  });

  it("enforces the node cardinality limit", () => {
    const mesh = new MeshProtocol({ maxNodes: 2 });
    mesh.join("a");
    mesh.join("b");
    expect(() => mesh.join("c")).toThrow(/cardinality limit/);
  });

  it("sweeps stale nodes out of routing and reports them", () => {
    const mesh = new MeshProtocol({ staleAfterMs: 1_000 });
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");
    // a heartbeats just before the sweep; b never did, so only b goes stale.
    const sweepAt = Date.now() + 5_000;
    mesh.heartbeat("a", sweepAt - 500);
    expect(mesh.isLive("b")).toBe(true);

    const stale = mesh.sweepStale(sweepAt);
    expect(stale).toEqual(["b"]);
    expect(mesh.isLive("b")).toBe(false);
    expect(mesh.isLive("a")).toBe(true);
    // A stale node has no live neighbours, so routing to it must fail loudly.
    expect(mesh.send("b", "a", "ping", {}).delivered).toBe(false);
  });

  it("revives a swept node on heartbeat", () => {
    const mesh = new MeshProtocol({ staleAfterMs: 1_000 });
    mesh.join("a");
    mesh.sweepStale(Date.now() + 5_000);
    expect(mesh.revive("a")).toBe(true);
    expect(mesh.isLive("a")).toBe(true);
  });

  it("leaves the mesh and drops its links", () => {
    const mesh = meshWith();
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");
    expect(mesh.leave("a")).toBe(true);
    expect(mesh.hasNode("a")).toBe(false);
    expect(mesh.send("b", "a", "ping", {}).delivered).toBe(false);
  });
});

describe("MeshProtocol routing", () => {
  it("delivers directly over an established link", () => {
    const transport = new CollectingTransport();
    const mesh = meshWith(transport);
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");

    const result = mesh.send("b", "a", "directive", { content: "hello" });
    expect(result.delivered).toBe(true);
    expect(result.hops).toBe(1);
    expect(result.path).toEqual(["a", "b"]);
    expect(transport.delivered).toHaveLength(1);
    expect(transport.delivered[0]?.to).toBe("b");
  });

  it("relays over the shortest live path when no direct link exists", () => {
    const transport = new CollectingTransport();
    const mesh = meshWith(transport);
    mesh.join("a");
    mesh.join("b");
    mesh.join("c");
    mesh.link("a", "b");
    mesh.link("b", "c");

    const result = mesh.send("c", "a", "directive", { n: 1 });
    expect(result.delivered).toBe(true);
    expect(result.path).toEqual(["a", "b", "c"]);
    expect(result.hops).toBe(2);
  });

  it("picks the shorter of two relay routes", () => {
    const transport = new CollectingTransport();
    const mesh = meshWith(transport);
    for (const id of ["a", "b", "c", "d"]) mesh.join(id);
    mesh.link("a", "b");
    mesh.link("b", "d");
    mesh.link("a", "c");
    mesh.link("c", "d");

    const result = mesh.send("d", "a", "directive", {});
    expect(result.delivered).toBe(true);
    expect(result.hops).toBe(2);
  });

  it("reports unroutable sends with a reason instead of throwing", () => {
    const mesh = meshWith();
    mesh.join("a");
    mesh.join("b");
    const result = mesh.send("b", "a", "directive", {});
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/no live route/);
    expect(mesh.getDroppedCount()).toBe(1);
  });

  it("rejects sends from non-members", () => {
    const mesh = meshWith();
    mesh.join("b");
    const result = mesh.send("b", "ghost", "directive", {});
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/not a mesh member/);
  });

  it("requires link endpoints to be members", () => {
    const mesh = meshWith();
    mesh.join("a");
    expect(() => mesh.link("a", "b")).toThrow(/non-member/);
    expect(() => mesh.link("a", "a")).toThrow(/self-referential/);
  });
});

describe("MeshProtocol broadcast", () => {
  it("floods a ring mesh delivering each node exactly once", () => {
    const transport = new CollectingTransport();
    const mesh = meshWith(transport);
    for (const id of ["a", "b", "c", "d", "e"]) mesh.join(id);
    mesh.link("a", "b");
    mesh.link("b", "c");
    mesh.link("c", "d");
    mesh.link("d", "e");
    mesh.link("e", "a");

    const result = mesh.broadcast("a", "announce", { hello: true });
    expect(result.delivered).toBe(true);
    const targets = transport.delivered.map((entry) => entry.to).sort();
    expect(targets).toEqual(["b", "c", "d", "e"]);
    // Each node appears exactly once: the flood does not re-deliver.
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("respects the TTL and stops short of the far side of a line", () => {
    const transport = new CollectingTransport();
    const mesh = new MeshProtocol({ transport, defaultTtl: 2 });
    for (const id of ["a", "b", "c", "d", "e"]) mesh.join(id);
    mesh.link("a", "b");
    mesh.link("b", "c");
    mesh.link("c", "d");
    mesh.link("d", "e");

    mesh.broadcast("a", "announce", {});
    const targets = transport.delivered.map((entry) => entry.to);
    // TTL 2 from a reaches b and c only.
    expect(targets).toEqual(["b", "c"]);
  });

  it("drops a broadcast with no reachable peers", () => {
    const mesh = meshWith();
    mesh.join("a");
    const result = mesh.broadcast("a", "announce", {});
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/reached no other node/);
  });

  it("uses the mailbox as the default transport", () => {
    const mailbox = new MailboxKernel();
    const transport = new MailboxKernelMeshTransport(mailbox);
    const mesh = new MeshProtocol({ transport });
    mesh.join("orchestrator", ["planning"]);
    mesh.join("coder", ["implementation"]);
    mesh.link("orchestrator", "coder");

    const result = mesh.send("coder", "orchestrator", "task_assignment", { steps: ["a"] });
    expect(result.delivered).toBe(true);
    const summary = mailbox.getSummary("coder");
    expect(summary.queueDepth).toBe(1);
    expect(mailbox.poll("coder")?.eventType).toBe("task_assignment");
  });

  it("survives a transport that refuses oversized payloads", () => {
    const refusing: MeshTransport = {
      deliver: () => null,
      knowsRecipient: () => true,
    };
    const mesh = meshWith(refusing);
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");
    const result = mesh.send("b", "a", "directive", {});
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/transport rejected/);
  });
});

describe("MeshProtocol topology", () => {
  it("detects partitions as connected components over live links", () => {
    const mesh = meshWith();
    for (const id of ["a", "b", "c", "d"]) mesh.join(id);
    mesh.link("a", "b");
    mesh.link("c", "d");

    const partitions = mesh.partitions().map((component) => component.sort());
    expect(partitions).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("reports a single partition for a fully connected mesh", () => {
    const mesh = meshWith();
    for (const id of ["a", "b", "c"]) mesh.join(id);
    mesh.link("a", "b");
    mesh.link("b", "c");
    mesh.link("a", "c");
    expect(mesh.partitions()).toHaveLength(1);
  });

  it("excludes inactive links from the topology view", () => {
    const mesh = meshWith();
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");
    // unlink is symmetric by default, so both directions go away.
    expect(mesh.unlink("a", "b")).toBe(true);
    expect(mesh.listLinks().filter((link) => link.active)).toHaveLength(0);
    // Two live nodes with no links are two partitions — the mesh reporting
    // that it has split, not an empty mesh.
    expect(mesh.partitions()).toHaveLength(2);
  });

  it("tears down only one direction when asked", () => {
    const mesh = meshWith();
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b");
    expect(mesh.unlink("a", "b", { symmetric: false })).toBe(true);
    expect(mesh.listLinks().filter((link) => link.active)).toHaveLength(1);
    // The surviving b -> a edge is one-directional: a can no longer reach b,
    // so the mesh reports two partitions — a directed teardown really does
    // leave the topology asymmetric, which is why the default is symmetric.
    expect(mesh.partitions()).toHaveLength(2);
  });

  it("records delivery telemetry on the links it uses", () => {
    const transport = new CollectingTransport();
    const mesh = meshWith(transport);
    mesh.join("a");
    mesh.join("b");
    mesh.link("a", "b", "gossip" as MeshLinkKind);
    mesh.send("b", "a", "directive", {});
    const link = mesh.listLinks()[0];
    expect(link?.deliveries).toBe(1);
  });
});
