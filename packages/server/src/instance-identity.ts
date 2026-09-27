/**
 * Instance identity: the one question a discovery record cannot answer about itself.
 *
 * `server.lock` records `{pid, port}`, and liveness checks those two (see lock.ts). That
 * establishes that SOMETHING is there — not that the something is the server for MY data
 * root. The two facts rot independently: a crashed server's pid is eventually reused by an
 * unrelated process, and its port is eventually taken by some other program. Both checks
 * then pass at once, `liveServerLock` reports a live peer, and the CLI attaches to a
 * stranger — handing it the root's API token on the way in. machine-status.ts already names
 * the weaker ancestor of this same hole ("a recycled pid reads as a live server"); the
 * codebase hardened `kill -0` into pid+port, and this is the remaining step, which is
 * identity.
 *
 * WHY THE DATA ROOT IS THE SHARING KEY. The server is shared per data root, and the data
 * root is also the isolation boundary — the one thing two projects must not share. Those
 * are not two decisions that happen to agree; they are the same boundary, because
 * `<root>/.server-instance.sqlite` is where the single-instance claim is taken, so "which
 * server may I use" and "whose data am I allowed to touch" resolve to one key. Any other
 * key would be wrong in a way that is silent rather than loud: sharing by pid or by port
 * would let a process on root A attach to the server holding root B's database and act as
 * the owner of data it was never meant to see.
 *
 * So the wire form of that key is a FINGERPRINT, not the path: sha256 of the realpath,
 * truncated. A peer has to be able to prove which root it serves, and a server that may be
 * reachable on a non-loopback bind must not publish its data directory's absolute layout to
 * whoever asks. Two 16-hex-char digests of the same path match; the path itself never
 * leaves the machine.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A server's answer to "which data root are you?". Deliberately carries no path. */
export interface InstanceIdentity {
  /** sha256 of the realpath of the data root, truncated — the sharing key, in wire form. */
  rootId: string;
  /** The serving process's own pid, echoed so a caller can compare it with the lock's. */
  pid: number;
  /** The port it is actually listening on (the lock's port, or 0 before onListening). */
  port: number;
  /** When this process published its discovery record. */
  startedAt: string;
}

export const INSTANCE_ROUTE = "/api/instance";

/**
 * Fingerprint length in hex chars. 64 bits of a hash whose input is a filesystem path:
 * long enough that two independent roots colliding is not a thing that happens in
 * practice, short enough to read in a log line when an attach is refused.
 */
const FINGERPRINT_HEX = 16;

/** A probe is a startup-path question, not a request: answer fast or answer not at all. */
const PROBE_TIMEOUT_MS = 500;

/**
 * The fingerprint of a data root.
 *
 * Resolved through realpath so two spellings of one directory — a symlinked temp dir, a
 * Windows short (8.3) name, a trailing separator — produce the same id. Without that, the
 * same root could answer under two identities and a legitimate attach would be refused as a
 * cross-root mismatch. A root that does not exist yet (nothing has ever run on it) falls
 * back to plain resolution, which is the best answer available and is the one the creating
 * server will compute for itself a moment later.
 */
export function rootFingerprint(root: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(root);
  } catch {
    canonical = path.resolve(root);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, FINGERPRINT_HEX);
}

/** The identity this process publishes for the root it owns and has claimed. */
export function localInstanceIdentity(
  root: string,
  port: number,
  startedAt: string,
): InstanceIdentity {
  return { rootId: rootFingerprint(root), pid: process.pid, port, startedAt };
}

/**
 * Validates an answer before anything is allowed to believe it.
 *
 * A parse here is a remote input: the thing on the other end of the socket is whatever
 * happens to hold that port, and this decides whether the caller hands it a credential.
 * Every field is therefore type- and range-checked, and the port additionally has to be a
 * real one — a peer that answers `{"rootId":"<ours>","port":0}` has proved nothing about
 * being reachable. Anything that fails reads as "no identity", which is the safe direction:
 * it leaves the pid+port rule in charge rather than manufacturing a match.
 */
export function parseInstanceIdentity(value: unknown): InstanceIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { rootId, pid, port } = raw;
  if (typeof rootId !== "string" || !/^[0-9a-f]+$/.test(rootId)) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }
  return {
    rootId,
    pid,
    port,
    startedAt: typeof raw["startedAt"] === "string" ? raw["startedAt"] : "",
  };
}

/**
 * Asks whoever is on `port` which root it serves. Null for every failure mode — refused,
 * timed out, not JSON, wrong shape — and null is a real answer meaning "this port did not
 * identify itself", which is the case for both an older build and a non-HTTP stranger.
 *
 * Always 127.0.0.1, matching lock.ts's own liveness probe: the discovery record is written
 * by a server on this machine, so there is nothing to gain by asking over any other
 * address, and a server bound to a specific LAN interface simply does not answer here —
 * which lands in the same "no identity" bucket rather than in a wrong verdict.
 */
export async function probeInstanceIdentity(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<InstanceIdentity | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}${INSTANCE_ROUTE}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // The canonical-host guard answers a loopback request on the preview counterpart
      // name with a 302; the probe addresses 127.0.0.1 directly, and `redirect: "manual"`
      // keeps it that way instead of chasing a name that may resolve to ::1.
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return parseInstanceIdentity(await res.json());
  } catch {
    // A refused connection, a timeout, a non-JSON body: all of them mean the same thing,
    // which is that this port did not identify itself.
    return null;
  }
}
