import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TopologyEngine } from "../../src/codegraph/topology-engine.js";
import {
  CODEGRAPH_SCHEMA_VERSION,
  createTopologyGraphStore,
  FileGraphStore,
} from "../../src/codegraph/graph-store.js";
import type { TopologySnapshot } from "../../src/codegraph/topology-engine.js";

const directories: string[] = [];

interface TestEnvelope {
  format: "penguin-codegraph-snapshot";
  schemaVersion: number;
  checksum: string;
  payload: string;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "penguin-graph-store-"));
  directories.push(directory);
  return directory;
}

function snapshot(files: Record<string, string> = {}): TopologySnapshot {
  const engine = new TopologyEngine();
  engine.build(Object.entries(files).map(([filePath, content]) => ({ path: filePath, content })));
  return engine.snapshot();
}

function encodeEnvelope(schemaVersion: number, value: unknown): string {
  const payload = JSON.stringify(value);
  const envelope: TestEnvelope = {
    format: "penguin-codegraph-snapshot",
    schemaVersion,
    checksum: createHash("sha256").update(payload, "utf8").digest("hex"),
    payload,
  };
  return JSON.stringify(envelope);
}

describe("FileGraphStore", () => {
  it("round-trips topology snapshots and rejects a corrupt checksum", async () => {
    const filePath = path.join(fixtureDirectory(), "cache", "graph.json");
    const store = createTopologyGraphStore(filePath);
    const value = snapshot({ "src/a.ts": "export function a() { return 1; }" });
    expect(await store.load()).toEqual({ status: "missing" });
    await store.save(value);
    expect(await store.load()).toEqual({ status: "hit", value });

    const bytes = readFileSync(filePath, "utf8");
    const envelope = JSON.parse(bytes) as TestEnvelope;
    envelope.payload = envelope.payload.replace("src/a.ts", "src/b.ts");
    writeFileSync(filePath, JSON.stringify(envelope));
    expect(await store.load()).toEqual({ status: "corrupt", reason: "checksum" });
  });

  it("treats unsupported schema as a rebuildable miss and replaces it with the current version", async () => {
    const filePath = path.join(fixtureDirectory(), "graph.json");
    const store = createTopologyGraphStore(filePath);
    writeFileSync(filePath, encodeEnvelope(CODEGRAPH_SCHEMA_VERSION + 1, snapshot()));
    expect(await store.load()).toEqual({
      status: "unsupported-version",
      storedVersion: CODEGRAPH_SCHEMA_VERSION + 1,
    });
    const current = snapshot({ "src/current.ts": "export const current = 1;" });
    await store.save(current);
    expect(await store.load()).toEqual({ status: "hit", value: current });
  });

  it("rejects structurally invalid graphs and never overwrites valid bytes on interrupted save", async () => {
    const filePath = path.join(fixtureDirectory(), "graph.json");
    const store = createTopologyGraphStore(filePath);
    const original = snapshot({ "src/safe.ts": "export const safe = 1;" });
    await store.save(original);
    const originalBytes = readFileSync(filePath);
    const malformed = snapshot();
    malformed.edges.push({ source: "missing", target: "also-missing", kind: "calls" });
    await expect(store.save(malformed)).rejects.toThrow("invalid graph snapshot");
    const abort = new AbortController();
    abort.abort();
    await expect(store.save(original, { signal: abort.signal })).rejects.toThrow();
    expect(readFileSync(filePath)).toEqual(originalBytes);
    expect(await store.load()).toEqual({ status: "hit", value: original });
  });

  it("never returns a torn snapshot while concurrent writers atomically replace the cache", async () => {
    const filePath = path.join(fixtureDirectory(), "graph.json");
    const store = createTopologyGraphStore(filePath);
    const candidates = [
      snapshot({ "src/one.ts": "export const one = 1;" }),
      snapshot({ "src/two.ts": "export const two = 2;" }),
      snapshot({ "src/three.ts": "export const three = 3;" }),
    ];
    await store.save(candidates[0]!);
    const reads = Array.from({ length: 24 }, async () => {
      for (let index = 0; index < 12; index++) {
        const result = await store.load();
        expect(result.status).toBe("hit");
        if (result.status === "hit") expect(candidates).toContainEqual(result.value);
      }
    });
    const writes = candidates.map((candidate) => store.save(candidate));
    await Promise.all([...reads, ...writes]);
  });

  it("enforces the configured byte ceiling on both reads and writes", async () => {
    const filePath = path.join(fixtureDirectory(), "graph.json");
    const small = new FileGraphStore<TopologySnapshot>(
      filePath,
      (value): value is TopologySnapshot => value !== null && typeof value === "object",
      { maxBytes: 10 },
    );
    await expect(small.save(snapshot())).rejects.toThrow("byte limit");
    writeFileSync(filePath, "x".repeat(11));
    expect(await small.load()).toEqual({ status: "corrupt", reason: "oversized" });
  });
});
