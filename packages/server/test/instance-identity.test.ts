/**
 * Instance identity: the attach path's third check, after "the pid is alive" and "the port
 * accepts".
 *
 * The peers here are real child processes holding real ports, not mocks. That is the point
 * of the suite: the failure it guards against is a discovery record that outlives the
 * server it names, and only a process that actually dies produces the shape of that — a
 * pid and a port that both still look fine to a naive check. The last test kills its peer
 * outright and asserts that the next agent recovers rather than inheriting a dead port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireServerInstanceClaim,
  liveServerLock,
  readServerLock,
  serverLockPath,
} from "../src/lock.js";
import {
  parseInstanceIdentity,
  probeInstanceIdentity,
  rootFingerprint,
} from "../src/instance-identity.js";
import { createTestApp, makeTempRoot } from "./helpers.js";

const PEER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "instance-peer.mjs",
);

interface Peer {
  proc: ChildProcess;
  port: number;
}

const live: Array<{ proc: ChildProcess; root: string }> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const { proc, root } of live.splice(0)) {
    // Only ever processes this file started — the same rule the production code follows.
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    roots.splice(roots.indexOf(root), 1);
  }
  for (const root of roots.splice(0)) {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  return root;
}

/**
 * Starts a peer process and waits until it has published its port on stdout.
 *
 * The lock is published by the peer itself before it writes, so by the time the parent has
 * read the port line, `server.lock` is already on disk — the parent never has to poll for a
 * record that may not be there yet, which is what makes the death assertions deterministic.
 */
function startPeer(
  root: string,
  opts: { rootId: string; route?: "yes" | "no"; publish?: boolean },
): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [PEER, root], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CHILD_ROOT_ID: opts.rootId,
        CHILD_ROUTE: opts.route ?? "yes",
        ...(opts.publish === false ? {} : { CHILD_LOCK: serverLockPath(root) }),
      },
    });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      out += chunk;
      const nl = out.indexOf("\n");
      if (nl === -1 || proc.exitCode !== null) return;
      clearTimeout(timer);
      resolve({ proc, port: Number(out.slice(0, nl).trim()) });
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code !== 0) reject(new Error(`peer exited early with code ${code}`));
    });
    const timer = setTimeout(() => reject(new Error("peer never reported a port")), 10_000);
  });
}

const exited = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => proc.once("exit", () => resolve()));

describe("instance identity", () => {
  it("fingerprints a root the same way however it is spelled, and differently from another", async () => {
    const root = await tempRoot();
    const other = await tempRoot();
    // Trailing separator and a relative round-trip are the two spellings that actually
    // differ as strings while naming one directory.
    expect(rootFingerprint(root)).toBe(rootFingerprint(`${root}${path.sep}`));
    expect(rootFingerprint(path.relative(process.cwd(), root))).toBe(rootFingerprint(root));
    expect(rootFingerprint(root)).not.toBe(rootFingerprint(other));
    // The wire form is a digest, not a path: nothing in it discloses the root's location.
    expect(rootFingerprint(root)).toMatch(/^[0-9a-f]{16}$/);
    expect(rootFingerprint(root)).not.toContain(root);
  });

  it("rejects a malformed identity rather than believing part of it", () => {
    const good = { rootId: "abcdef0123456789", pid: 42, port: 7364, startedAt: "now" };
    expect(parseInstanceIdentity(good)).toEqual(good);
    for (const bad of [
      null,
      "string",
      {},
      { ...good, rootId: 123 },
      { ...good, rootId: "nothex" },
      { ...good, pid: 0 },
      { ...good, pid: 1.5 },
      { ...good, port: 0 },
      { ...good, port: 70_000 },
      // A peer claiming to be reachable on a port nobody can dial has proved nothing.
      { ...good, port: -1 },
    ]) {
      expect(parseInstanceIdentity(bad)).toBeNull();
    }
  });

  it("answers which root it serves, without disclosing the path and without a login", async () => {
    const app = await createTestApp();
    try {
      // No cookie, no bearer: the caller is by definition not yet sure whether it may talk
      // to this server, which is why this route sits ahead of the auth gate.
      const res = await app.app.request("/api/instance");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["rootId"]).toBe(rootFingerprint(app.root));
      expect(body["pid"]).toBe(process.pid);
      // The wire form is a digest, so the answer never lays out the data directory.
      expect(JSON.stringify(body)).not.toContain(app.root);
    } finally {
      await app.cleanup();
    }
  });

  it("attaches to a live peer serving this root", async () => {
    const root = await tempRoot();
    const peer = await startPeer(root, { rootId: rootFingerprint(root) });
    live.push({ proc: peer.proc, root });
    expect(await liveServerLock(root)).toEqual(readServerLock(root));
  });

  it("refuses a peer that answers for a different root, even with a live pid and port", async () => {
    const root = await tempRoot();
    const stranger = await tempRoot();
    const peer = await startPeer(root, { rootId: rootFingerprint(stranger) });
    live.push({ proc: peer.proc, root });
    // The pid is alive and the port accepts — every check the old code made still passes.
    // This is the case pid+port cannot see: the server on that port is another root's.
    expect(readServerLock(root)).not.toBeNull();
    expect(await liveServerLock(root)).toBeNull();
  });

  it("still attaches to a build that predates the route, so an upgrade overlap works", async () => {
    const root = await tempRoot();
    const peer = await startPeer(root, { rootId: "", route: "no" });
    live.push({ proc: peer.proc, root });
    // No identity is a fact about the peer, not evidence against it: refusing here would
    // strand every client on the root during the one window where two builds coexist.
    expect(await probeInstanceIdentity(peer.port)).toBeNull();
    expect(await liveServerLock(root)).toEqual(readServerLock(root));
  });

  it("recovers when the peer dies: the record goes stale and a fresh server takes the root", async () => {
    const root = await tempRoot();

    // An agent attaches to a running server rather than starting its own.
    const first = await startPeer(root, { rootId: rootFingerprint(root) });
    expect(await liveServerLock(root)).not.toBeNull();

    // It is killed outright — no shutdown, no releaseServerLock, the discovery record left
    // behind exactly as a crash or a hard kill would leave it.
    first.proc.kill("SIGKILL");
    await exited(first.proc);

    // The record is now a lie that still looks true to a pid+port check's weaker cousin.
    expect(readServerLock(root)).not.toBeNull();
    expect(await liveServerLock(root)).toBeNull();

    // So the next agent falls back to starting its own, and the claim — the thing that
    // actually guarantees one writer — is free, because it died with the process holding it.
    const claim = acquireServerInstanceClaim(root);
    expect(claim).not.toBeNull();
    try {
      expect(acquireServerInstanceClaim(root)).toBeNull(); // still exactly one writer
      const second = await startPeer(root, { rootId: rootFingerprint(root) });
      live.push({ proc: second.proc, root });
      const lock = await liveServerLock(root);
      expect(lock).not.toBeNull();
      expect(lock!.pid).toBe(second.proc.pid);
      expect(lock!.port).toBe(second.port);
    } finally {
      claim?.release();
    }
  });
});
