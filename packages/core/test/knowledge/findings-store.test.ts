import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsGraph } from "../../src/knowledge/findings-graph.js";
import {
  FindingsStore,
  FindingsCapacityError,
  FindingsRecoveryError,
  FindingsRevisionError,
  FINDINGS_HIGH_WATER_BYTES,
  FINDINGS_MAX_BYTES,
} from "../../src/knowledge/store.js";
import { validateReportInput, FindingValidationError } from "../../src/knowledge/validation.js";
import * as writer from "../../src/internal/atomic-write.js";

describe("scope-aware findings store", () => {
  it("archives the lowest ranked finding at the count ceiling and keeps confirmed claims last", async () => {
    const s = store("count-cap");
    const seed = new FindingsGraph();
    const template = seed.report({
      title: "Retained proof",
      evidence: [{ tier: "runtime" }],
    }).finding;
    const snapshot = {
      version: 1 as const,
      findings: Array.from({ length: 5000 }, (_, i) => ({
        ...template,
        id: `record-${i}`,
        title: `Retained ${i}`,
        status: i === 0 ? ("refuted" as const) : ("confirmed" as const),
      })),
    };
    await fs.mkdir(path.dirname(s.scope.filePath), { recursive: true });
    await fs.writeFile(s.scope.filePath, JSON.stringify(snapshot));
    const before = (await s.read()).revision;
    const originalBytes = await fs.readFile(s.scope.filePath);
    vi.spyOn(writer, "atomicWriteFile").mockRejectedValueOnce(new Error("snapshot rename failed"));
    await expect(
      s.update(undefined, (graph) => graph.report({ title: "Uncommitted eviction" })),
    ).rejects.toThrow("snapshot rename failed");
    expect(await fs.readFile(s.scope.filePath)).toEqual(originalBytes);
    expect((await s.read()).graph!.archived()).toHaveLength(0);
    await s.update(undefined, (graph) => graph.report({ title: "Entirely new claim" }));
    const after = await s.read();
    expect(after.revision).not.toBe(before);
    expect(after.graph!.list()).toHaveLength(5000);
    expect(after.graph!.list().filter((finding) => finding.status === "confirmed")).toHaveLength(
      4999,
    );
    expect(after.graph!.list().some((finding) => finding.title === "Entirely new claim")).toBe(
      true,
    );
    expect(after.graph!.archived()).toMatchObject([
      { operationId: expect.any(String), finding: { id: "record-0", status: "refuted" } },
    ]);
  }, 15_000);

  it("keeps over-ceiling files exportable with bounded memory and preserves them on reset", async () => {
    const s = store("large-external");
    await fs.mkdir(path.dirname(s.scope.filePath), { recursive: true });
    await fs.writeFile(s.scope.filePath, "original");
    await fs.truncate(s.scope.filePath, FINDINGS_MAX_BYTES + 1);
    const read = await s.read();
    expect(read.recovery?.reason).toBe("capacity");
    expect(read.highWater).toBe(true);
    expect(Buffer.from((await s.rawPage(0, 8)).data, "base64").toString()).toBe("original");
    await expect(
      s.update(undefined, (graph) => graph.report({ title: "Unsafe overwrite" })),
    ).rejects.toBeInstanceOf(FindingsRecoveryError);
    await s.recover("reset", read.revision, "Exported oversized state", user);
    const audit = JSON.parse((await s.read()).graph!.since().at(-1)!.note!);
    expect((await fs.stat(audit.preserved)).size).toBe(FINDINGS_MAX_BYTES + 1);
  }, 15_000);
  it("serializes independent Node processes against one authority", async () => {
    const authority = store("process");
    const moduleUrl = new URL("../../dist/index.js", import.meta.url).href;
    const code = `import {FindingsStore} from ${JSON.stringify(moduleUrl)}; const store = new FindingsStore({id:"workspace:process",kind:"workspace",filePath:process.argv[1]}); for(let i=0;i<25;i++) await store.update(undefined,g=>g.report({title:process.argv[2]+i}));`;
    const run = promisify(execFile);
    await Promise.all(
      ["ProcessA", "ProcessB"].map((prefix) =>
        run(
          process.execPath,
          ["--input-type=module", "-e", code, authority.scope.filePath, prefix],
          { timeout: 30_000 },
        ),
      ),
    );
    expect((await authority.read()).graph!.list()).toHaveLength(50);
  }, 15_000);
  let root: string;
  const user = { actor: { kind: "user" as const, id: "operator" }, method: "route" as const };
  const store = (name = "workspace", kind: "workspace" | "project" = "workspace") =>
    new FindingsStore({
      id: `${kind}:${name}`,
      kind,
      filePath: path.join(root, name, "findings.json"),
    });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "findings-store-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps 50 concurrent updates through two instances per independent authority after restart", async () => {
    for (const kind of ["workspace", "project"] as const) {
      const a = store(kind, kind),
        b = store(kind, kind);
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          (i % 2 ? a : b).update(undefined, (graph) => graph.report({ title: `Unique ${i}` })),
        ),
      );
      const restarted = await store(kind, kind).read();
      expect(restarted.graph!.list()).toHaveLength(50);
      expect(restarted.scope.kind).toBe(kind);
    }
    expect(FindingsStore.cacheStats().pending).toBe(0);
  }, 15_000);

  it("parses unchanged reads once and detects same-size external replacement", async () => {
    const s = store();
    await s.update(undefined, (graph) => graph.report({ title: "Alpha" }));
    const before = FindingsStore.cacheStats().parses;
    const first = await s.read();
    await s.read();
    expect(FindingsStore.cacheStats().parses - before).toBe(1);
    const raw = await fs.readFile(s.scope.filePath, "utf8");
    const replaced = raw.replace('"title":"Alpha"', '"title":"Bravo"');
    expect(replaced.length).toBe(raw.length);
    await fs.writeFile(s.scope.filePath, replaced);
    const changed = await s.read();
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.graph!.list()[0]!.title).toBe("Bravo");
    await expect(
      s.update(first.revision, (graph) => graph.report({ title: "Rejected" })),
    ).rejects.toBeInstanceOf(FindingsRevisionError);
  });

  it("releases queues and locks on callback and atomic write failures without acknowledging a mutation", async () => {
    const s = store();
    await s.update(undefined, (graph) => graph.report({ title: "Original" }));
    const before = await fs.readFile(s.scope.filePath);
    await expect(
      s.update(undefined, (graph) => {
        graph.report({ title: "Transient" });
        throw new TypeError("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    vi.spyOn(writer, "atomicWriteFile").mockRejectedValueOnce(new Error("rename failed"));
    await expect(
      s.update(undefined, (graph) => graph.report({ title: "Unsaved" })),
    ).rejects.toThrow("rename failed");
    expect(await fs.readFile(s.scope.filePath)).toEqual(before);
    expect(FindingsStore.cacheStats().pending).toBe(0);
    expect(
      (await fs.readdir(path.dirname(s.scope.filePath))).some((name) => name.endsWith(".lock")),
    ).toBe(false);
    await s.update(undefined, (graph) => graph.report({ title: "Durable" }));
    expect((await s.read()).graph!.list()).toHaveLength(2);
  });

  it("distinguishes absent state from corrupt/partial/unsupported snapshots and preserves raw bytes", async () => {
    expect((await store().read()).recovery).toBeNull();
    for (const [name, raw] of [
      ["garbage", "garbage"],
      ["partial", '{"version":1,"findings":['],
      ["version", '{"version":2,"findings":[]}'],
      ["record", '{"version":1,"findings":[{}]}'],
    ] as const) {
      const s = store(name);
      await fs.mkdir(path.dirname(s.scope.filePath), { recursive: true });
      await fs.writeFile(s.scope.filePath, raw, { mode: 0o600 });
      const read = await s.read();
      expect(read.recovery?.state).toBe("read-only");
      expect(read.recovery?.reason).toBe(name === "version" ? "unsupported-version" : "corrupt");
      expect(read.recovery?.quarantineError).toBeUndefined();
      expect(read.graph).toBeNull();
      expect(await fs.readFile(read.recovery!.quarantinePath!, "utf8")).toBe(raw);
      const mutation = vi.fn((graph: FindingsGraph) => graph.report({ title: "Unsafe repair" }));
      await expect(s.update(undefined, mutation)).rejects.toBeInstanceOf(FindingsRecoveryError);
      expect(mutation).not.toHaveBeenCalled();
      expect(await fs.readFile(s.scope.filePath, "utf8")).toBe(raw);
      const page = await s.rawPage(0, 5);
      expect(Buffer.from(page.data, "base64").toString()).toBe(raw.slice(0, 5));
      // Repeated reads and rejected mutations of one damaged revision keep one bounded copy.
      const second = await s.read();
      expect(second.recovery!.quarantinePath).toBe(read.recovery!.quarantinePath);
      expect(await fs.readFile(read.recovery!.quarantinePath!, "utf8")).toBe(raw);
      const quarantined = async () => {
        const entries = await fs.readdir(path.dirname(s.scope.filePath));
        return entries.filter((entry) => entry.includes(".quarantine-"));
      };
      expect(await quarantined()).toHaveLength(1);
      // A tampered copy is never trusted as the preserved original.
      await fs.writeFile(read.recovery!.quarantinePath!, "tampered");
      const third = await s.read();
      expect(third.recovery!.quarantinePath).not.toBe(read.recovery!.quarantinePath);
      expect(await fs.readFile(third.recovery!.quarantinePath!, "utf8")).toBe(raw);
      expect(await quarantined()).toHaveLength(2);
    }
  });

  it("keeps readable corrupt findings read-only when quarantine creation is denied", async () => {
    const s = store("quarantine-denied");
    const original = Buffer.from("garbage");
    await fs.mkdir(path.dirname(s.scope.filePath), { recursive: true });
    await fs.writeFile(s.scope.filePath, original, { mode: 0o600 });
    const authorityPath = path.join(
      await fs.realpath(path.dirname(s.scope.filePath)),
      path.basename(s.scope.filePath),
    );
    const deniedQuarantines: string[] = [];
    const open = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).startsWith(`${authorityPath}.quarantine-`) && args[1] === "wx") {
          deniedQuarantines.push(String(args[0]));
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return open(...args);
      });
    const read = await s.read();
    expect(openSpy).toHaveBeenCalledWith(authorityPath, "r");
    expect(read.graph).toBeNull();
    expect(read.recovery).toMatchObject({
      state: "read-only",
      reason: "corrupt",
      quarantineError: "permission denied",
    });
    expect(read.recovery?.quarantinePath).toBeUndefined();
    const mutation = vi.fn((graph: FindingsGraph) => graph.report({ title: "Rejected" }));
    await expect(s.update(undefined, mutation)).rejects.toBeInstanceOf(FindingsRecoveryError);
    expect(mutation).not.toHaveBeenCalled();
    expect(deniedQuarantines).toHaveLength(2);
    expect(new Set(deniedQuarantines).size).toBe(1);
    expect(await fs.readFile(s.scope.filePath)).toEqual(original);
    expect(Buffer.from((await s.rawPage()).data, "base64")).toEqual(original);
    expect(await fs.readdir(path.dirname(s.scope.filePath))).toEqual(["findings.json"]);
    expect(FindingsStore.cacheStats().pending).toBe(0);
  });

  it("classifies a denied canonical authority read as unreadable and rejects mutation", async () => {
    const actual = store("read-denied");
    const original = Buffer.from(JSON.stringify(new FindingsGraph().exportSnapshot()));
    await fs.mkdir(path.dirname(actual.scope.filePath), { recursive: true });
    await fs.writeFile(actual.scope.filePath, original, { mode: 0o600 });
    const authorityPath = path.join(
      await fs.realpath(path.dirname(actual.scope.filePath)),
      path.basename(actual.scope.filePath),
    );
    // A lexical alias reproduces canonical-path changes without requiring symlink privileges.
    const s = new FindingsStore({
      ...actual.scope,
      filePath: `${path.dirname(actual.scope.filePath)}${path.sep}.${path.sep}${path.basename(actual.scope.filePath)}`,
    });
    expect(s.scope.filePath).not.toBe(authorityPath);
    const open = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) === authorityPath && args[1] === "r")
          throw Object.assign(new Error("unreadable"), { code: "EACCES" });
        return open(...args);
      });
    const read = await s.read();
    expect(openSpy).toHaveBeenCalledWith(authorityPath, "r");
    expect(read.graph).toBeNull();
    expect(read.recovery).toMatchObject({ state: "read-only", reason: "unreadable" });
    expect(read.recovery?.message).toContain("unreadable");
    expect(read.recovery?.quarantinePath).toBeUndefined();
    expect(read.recovery?.quarantineError).toBeUndefined();
    const mutation = vi.fn((graph: FindingsGraph) => graph.report({ title: "Rejected" }));
    await expect(s.update(undefined, mutation)).rejects.toBeInstanceOf(FindingsRecoveryError);
    expect(mutation).not.toHaveBeenCalled();
    await expect(s.rawPage()).rejects.toMatchObject({ code: "EACCES" });
    expect(
      openSpy.mock.calls.filter(
        ([target, flags]) => String(target) === authorityPath && flags === "r",
      ),
    ).toHaveLength(3);
    expect(await fs.readFile(actual.scope.filePath)).toEqual(original);
    expect(await fs.readdir(path.dirname(actual.scope.filePath))).toEqual(["findings.json"]);
    expect(FindingsStore.cacheStats().pending).toBe(0);
  });

  it("requires a human/reason/current revision to reset and records a preserved backup in the audit", async () => {
    const s = store();
    await fs.mkdir(path.dirname(s.scope.filePath), { recursive: true });
    await fs.writeFile(s.scope.filePath, "original damaged bytes");
    const read = await s.read();
    await expect(
      s.recover("reset", read.revision, "reason", {
        actor: { kind: "agent", id: "agent" },
        method: "tool",
      }),
    ).rejects.toBeInstanceOf(FindingValidationError);
    await expect(s.recover("reset", "stale", "reason", user)).rejects.toBeInstanceOf(
      FindingsRevisionError,
    );
    await expect(
      s.recover("restore", read.revision, "reason", user, Buffer.from("invalid")),
    ).rejects.toBeInstanceOf(FindingValidationError);
    await s.recover("reset", read.revision, "Operator acknowledged corruption", user);
    const current = await s.read();
    expect(current.recovery).toBeNull();
    expect(current.graph!.list()).toHaveLength(0);
    const event = current.graph!.since().at(-1)!;
    expect(event.actor).toEqual(user.actor);
    const audit = JSON.parse(event.note!);
    expect(audit.operation).toBe("reset");
    expect(await fs.readFile(audit.preserved, "utf8")).toBe("original damaged bytes");
    const backup = new FindingsGraph();
    backup.report({ title: "Restored claim" });
    await s.recover(
      "restore",
      current.revision,
      "Restore verified backup",
      user,
      Buffer.from(JSON.stringify(backup.exportSnapshot())),
    );
    expect((await s.read()).graph!.list()[0]!.title).toBe("Restored claim");
  });

  it("warns at high water, rejects oversized writes, and allows explicit terminal pruning with backup", async () => {
    const s = store();
    const claim = await s.update(undefined, (graph) =>
      graph.report({ title: "Large retained claim", body: "x".repeat(FINDINGS_HIGH_WATER_BYTES) }),
    );
    let current = await s.read();
    expect(current.highWater).toBe(true);
    await expect(
      s.update(undefined, (graph) =>
        graph.report({ title: "Oversized distinct report", body: "y".repeat(FINDINGS_MAX_BYTES) }),
      ),
    ).rejects.toBeInstanceOf(FindingsCapacityError);
    expect((await s.read()).revision).toBe(current.revision);
    await expect(
      s.prune([claim.finding.id], current.revision, "reason", user),
    ).rejects.toBeInstanceOf(FindingValidationError);
    await s.update(undefined, (graph) => graph.refute(claim.finding.id));
    current = await s.read();
    await s.prune(
      [claim.finding.id],
      current.revision,
      "Remove falsified claim after export",
      user,
    );
    const pruned = await s.read();
    expect(pruned.graph!.list()).toHaveLength(0);
    expect(pruned.highWater).toBe(false);
    const audit = JSON.parse(pruned.graph!.since().at(-1)!.note!);
    expect((await fs.stat(audit.preserved)).size).toBeGreaterThan(FINDINGS_HIGH_WATER_BYTES);
  });

  it("bounds cached scopes and permits the largest validated report in an empty store", async () => {
    for (let i = 0; i < 12; i++) {
      const s = store(`scope-${i}`);
      await s.update(undefined, (graph) => graph.report({ title: "Bounded scope" }));
      await s.read();
    }
    expect(FindingsStore.cacheStats().entries).toBeLessThanOrEqual(
      FindingsStore.cacheStats().limit,
    );
    const input = validateReportInput({
      title: "t".repeat(300),
      body: "b".repeat(50_000),
      subjects: Array(100).fill("p".repeat(500)),
      tags: Array(50).fill("g".repeat(100)),
      evidence: Array(100).fill({
        tier: "runtime",
        path: "p".repeat(500),
        quote: "q".repeat(2000),
        note: "n".repeat(2000),
      }),
    });
    await store("maximum-report").update(undefined, (graph) => graph.report(input));
    expect((await store("maximum-report").read()).bytes).toBeLessThan(FINDINGS_MAX_BYTES);
    expect(() => validateReportInput({ title: "t".repeat(301) })).toThrow(FindingValidationError);
  });
});
