import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID, projectDir } from "@prismshadow/penguin-core";
import {
  getOrCreateProjectRuntime,
  getSharedCodeGraphWatcher,
  resetCockpitRuntimesForTesting,
  scheduleRuntimeReap,
} from "../src/cockpit/ws.js";

afterEach(() => resetCockpitRuntimesForTesting());

describe("cockpit runtime ownership", () => {
  it("rejects missing and relative roots before constructing runtime resources", async () => {
    await expect(getOrCreateProjectRuntime("missing-root")).rejects.toThrow("explicit absolute");
    await expect(
      getOrCreateProjectRuntime("relative-root", { workspaceRoot: "relative" }),
    ).rejects.toThrow("explicit absolute");
    expect(() => getSharedCodeGraphWatcher()).toThrow("explicit absolute");
  });
  it("scopes the default project's topology to its own root, not the server CWD", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cockpit-root-"));
    const workspace = projectDir(root, DEFAULT_PROJECT_ID);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "owned.ts"), "export const owned = 1;");
    const runtime = await getOrCreateProjectRuntime(DEFAULT_PROJECT_ID, { root });
    await vi.waitFor(() =>
      expect(runtime.codeGraphWatcher.getTrackedFiles()).toContain("owned.ts"),
    );
    expect(runtime.codeGraphWatcher.getTrackedFiles()).toEqual(["owned.ts"]);
  });

  it("does not share runtimes between independent data roots with identical project IDs", async () => {
    const rootA = mkdtempSync(path.join(tmpdir(), "cockpit-root-a-"));
    const rootB = mkdtempSync(path.join(tmpdir(), "cockpit-root-b-"));
    const a = await getOrCreateProjectRuntime("same-project", { root: rootA });
    const b = await getOrCreateProjectRuntime("same-project", { root: rootB });
    expect(a).not.toBe(b);
    a.coordinator.dispatchDirective("operator", "coder", "only A");
    expect(b.coordinator.getMailboxSummaries().coder?.queueDepth).toBe(0);
  });

  it("keeps the sync seams separate per workspace root, not per project id alone", () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "cockpit-seam-a-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "cockpit-seam-b-"));
    const watcherA = getSharedCodeGraphWatcher(dirA, "seam-project");
    const watcherB = getSharedCodeGraphWatcher(dirB, "seam-project");
    expect(watcherA).not.toBe(watcherB);
    // The same root keeps the same runtime.
    expect(getSharedCodeGraphWatcher(dirA, "seam-project")).toBe(watcherA);
  });

  it("shares one runtime between the async factory and the sync seams for the same root", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cockpit-shared-key-"));
    const runtime = await getOrCreateProjectRuntime("shared-key-project", { root });
    expect(
      getSharedCodeGraphWatcher(projectDir(root, "shared-key-project"), "shared-key-project"),
    ).toBe(runtime.codeGraphWatcher);
  });

  it("disconnects authoritative key listeners when an idle runtime is reaped", async () => {
    const runtime = await getOrCreateProjectRuntime("reap-key-listeners", {
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "cockpit-reap-")),
    });
    runtime.keyFleet.registerProvider({ provider: "local", modelId: "unit", keys: ["test-key"] });
    const rotator = runtime.keyFleet.getRotator("local")!;
    scheduleRuntimeReap(runtime, {}, 1);
    await vi.waitFor(() => expect(runtime.keyFleet.getProviders()).toEqual([]));
    const notified = vi.fn();
    const unsubscribe = runtime.keyFleet.subscribe(notified);
    rotator.recordSuccess("test-key");
    expect(notified).not.toHaveBeenCalled();
    unsubscribe();
  });
});
