import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SwarmRoleHandlers } from "@prismshadow/penguin-core";
import {
  getOrCreateProjectRuntime,
  isSafeCockpitProjectId,
  resetCockpitRuntimesForTesting,
} from "../src/cockpit/ws.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-runtime-"));
  await fs.mkdir(path.join(root, "alpha"), { recursive: true });
});

afterEach(async () => {
  resetCockpitRuntimesForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("cockpit project runtime boundaries", () => {
  it("adopts trusted swarm handlers supplied after a runtime was created without them", async () => {
    const first = await getOrCreateProjectRuntime("alpha", { root });
    expect(first.swarmHandlers).toBeUndefined();

    const handlers = { onExecute: async () => ({}) } as unknown as SwarmRoleHandlers;
    const second = await getOrCreateProjectRuntime("alpha", { root, swarmHandlers: handlers });
    expect(second).toBe(first);
    expect(second.swarmHandlers).toBe(handlers);

    // A later caller without handlers must not strip the configured host's handlers.
    const third = await getOrCreateProjectRuntime("alpha", { root });
    expect(third.swarmHandlers).toBe(handlers);
  });

  it("refuses project ids that are not one bounded path segment before creating a runtime", async () => {
    for (const projectId of [
      "",
      ".",
      "..",
      "../outside",
      "nested/project",
      "nested\\project",
      "C:outside",
      "line\nbreak",
      "nulbyte",
      "p".repeat(129),
    ]) {
      expect(isSafeCockpitProjectId(projectId)).toBe(false);
      await expect(getOrCreateProjectRuntime(projectId, { root })).rejects.toThrow(
        "single bounded path segment",
      );
    }
    expect(await fs.readdir(path.dirname(root))).toContain(path.basename(root));
    expect(isSafeCockpitProjectId("default_project")).toBe(true);
    expect(isSafeCockpitProjectId("项目-1.v2")).toBe(true);
    expect(isSafeCockpitProjectId("p".repeat(128))).toBe(true);
  });
});
