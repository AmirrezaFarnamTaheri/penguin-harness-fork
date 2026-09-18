import { describe, expect, it } from "vitest";

import { isUrlAllowed } from "../../src/sandbox/egress-allowlist.js";
import { resolveLimits } from "../../src/sandbox/execution-limits.js";
import {
  EPHEMERAL_TEMPFS,
  networkGatedWorkspace,
  READ_ONLY_FS,
  resolvePreset,
  SANDBOX_PRESETS,
  STRICT_MICROVM_ISOLATION,
  summarizePreset,
} from "../../src/sandbox/sandbox-presets.js";

const MiB = 1024 * 1024;

describe("sandbox-presets", () => {
  describe("named presets", () => {
    it("read-only-fs is hardened, default-ceilinged, and denies every write and socket", () => {
      expect(READ_ONLY_FS).toEqual({
        name: "read-only-fs",
        description: expect.any(String),
        capabilities: ["fs:read"],
        denied: ["fs:write", "network:outbound", "network:bind", "shell:native-binary"],
        allowList: [],
        ceilings: { maxProcesses: 64, maxMemoryBytes: 512 * MiB, sigkillTimeoutMs: 30_000 },
        profile: "hardened",
        // No memory budget is named at all: a read-only mount has no layer to budget.
        fsOptions: { readOnly: true, allowSymlinks: false },
        requiresIsolation: true,
      });
    });

    it("ephemeral-tempfs is the normal-profile shell preset with an in-memory write layer", () => {
      expect(EPHEMERAL_TEMPFS).toEqual({
        name: "ephemeral-tempfs",
        description: expect.any(String),
        capabilities: ["fs:read", "fs:write", "shell:exec"],
        denied: ["network:outbound", "network:bind", "shell:native-binary"],
        allowList: [],
        ceilings: { maxProcesses: 64, maxMemoryBytes: 512 * MiB, sigkillTimeoutMs: 30_000 },
        profile: "normal",
        fsOptions: {
          readOnly: false,
          allowSymlinks: false,
          maxMemoryBytes: 128 * MiB,
          maxFileReadSize: 10 * MiB,
        },
        requiresIsolation: false,
      });
    });

    it("strict-microvm-isolation carries the tightest ceilings and a hardened profile", () => {
      expect(STRICT_MICROVM_ISOLATION).toEqual({
        name: "strict-microvm-isolation",
        description: expect.any(String),
        capabilities: ["fs:read"],
        denied: [
          "fs:write",
          "network:outbound",
          "network:bind",
          "shell:exec",
          "js:eval",
          "js:function-constructor",
          "js:dynamic-import",
          "js:webassembly",
        ],
        allowList: [],
        ceilings: { maxProcesses: 16, maxMemoryBytes: 256 * MiB, sigkillTimeoutMs: 10_000 },
        profile: "hardened",
        fsOptions: {
          readOnly: false,
          allowSymlinks: false,
          maxMemoryBytes: 32 * MiB,
          maxFileReadSize: 4 * MiB,
        },
        requiresIsolation: true,
      });
    });

    it("the network-gated entry of the preset table is network-off until given destinations", () => {
      const tableEntry = SANDBOX_PRESETS["network-gated-workspace"];
      expect(tableEntry.name).toBe("network-gated-workspace");
      expect(tableEntry.profile).toBe("normal");
      expect(tableEntry.allowList).toEqual([]);
      expect(tableEntry.capabilities).toEqual([
        "fs:read",
        "fs:write",
        "shell:exec",
        "shell:native-binary",
        "network:outbound",
      ]);
      expect(tableEntry.denied).toEqual(["network:bind"]);
      expect(tableEntry.requiresIsolation).toBe(true);
      // An empty list still means off: isUrlAllowed denies everything against it.
      expect(isUrlAllowed("https://example.com/", [...tableEntry.allowList])).toBe(false);
    });

    it("the preset table carries exactly the four named presets", () => {
      expect(Object.keys(SANDBOX_PRESETS).sort()).toEqual(
        [
          "ephemeral-tempfs",
          "network-gated-workspace",
          "read-only-fs",
          "strict-microvm-isolation",
        ].sort(),
      );
      expect(SANDBOX_PRESETS["read-only-fs"]).toBe(READ_ONLY_FS);
      expect(SANDBOX_PRESETS["ephemeral-tempfs"]).toBe(EPHEMERAL_TEMPFS);
      expect(SANDBOX_PRESETS["strict-microvm-isolation"]).toBe(STRICT_MICROVM_ISOLATION);
    });

    it("never permits a capability the same preset denies", () => {
      for (const preset of Object.values(SANDBOX_PRESETS)) {
        const overlap = preset.capabilities.filter((c) => preset.denied.includes(c));
        expect(overlap).toEqual([]);
      }
    });

    it("grants outbound network through network-gated-workspace alone", () => {
      for (const [name, preset] of Object.entries(SANDBOX_PRESETS)) {
        expect(preset.capabilities.includes("network:outbound")).toBe(
          name === "network-gated-workspace",
        );
      }
    });

    it("resolves each name to its documented preset when there is nothing to override", () => {
      expect(resolvePreset("read-only-fs")).toEqual(READ_ONLY_FS);
      expect(resolvePreset("ephemeral-tempfs")).toEqual(EPHEMERAL_TEMPFS);
      expect(resolvePreset("strict-microvm-isolation")).toEqual(STRICT_MICROVM_ISOLATION);
      expect(resolvePreset("network-gated-workspace").allowList).toEqual([]);
    });
  });

  describe("hardened versus normal limit profiles", () => {
    const normal = resolveLimits(undefined, "normal");
    const hardened = resolveLimits(undefined, "hardened");

    it("hardened is no looser than normal on every single ceiling", () => {
      for (const key of Object.keys(normal)) {
        expect((hardened as Record<string, number>)[key]!).toBeLessThanOrEqual(
          (normal as Record<string, number>)[key]!,
        );
      }
    });

    it("hardened is strictly tighter on the ceilings the docs name", () => {
      expect(hardened.maxSourceBytes).toBeLessThan(normal.maxSourceBytes);
      expect(hardened.maxCommandCount).toBeLessThan(normal.maxCommandCount);
      expect(hardened.maxLoopIterations).toBeLessThan(normal.maxLoopIterations);
      expect(hardened.maxExecutionTimeMs).toBeLessThan(normal.maxExecutionTimeMs);
      expect(hardened.maxOutputSize).toBeLessThan(normal.maxOutputSize);
      expect(hardened.maxLiveBytes).toBeLessThan(normal.maxLiveBytes);
      expect(hardened.maxInputBytes).toBeLessThan(normal.maxInputBytes);
      expect(hardened.maxFileDescriptors).toBeLessThan(normal.maxFileDescriptors);
    });

    it("keeps every resolved limit finite, so a runaway hits a ceiling rather than the machine", () => {
      for (const key of Object.keys(normal)) {
        expect(Number.isFinite((normal as Record<string, number>)[key])).toBe(true);
        expect(Number.isFinite((hardened as Record<string, number>)[key])).toBe(true);
      }
    });

    it("the hardened presets select the hardened profile, the shell presets select normal", () => {
      expect(READ_ONLY_FS.profile).toBe("hardened");
      expect(STRICT_MICROVM_ISOLATION.profile).toBe("hardened");
      expect(EPHEMERAL_TEMPFS.profile).toBe("normal");
      expect(SANDBOX_PRESETS["network-gated-workspace"].profile).toBe("normal");
    });

    it("strict-microvm-isolation tightens every isolation ceiling relative to the default", () => {
      const ceilings = STRICT_MICROVM_ISOLATION.ceilings;
      expect(ceilings.maxProcesses).toBeLessThan(READ_ONLY_FS.ceilings.maxProcesses);
      expect(ceilings.maxMemoryBytes).toBeLessThan(READ_ONLY_FS.ceilings.maxMemoryBytes);
      expect(ceilings.sigkillTimeoutMs).toBeLessThan(READ_ONLY_FS.ceilings.sigkillTimeoutMs);
    });
  });

  describe("network-gated-workspace factory", () => {
    it("grants the network only to the destinations named, at path boundaries", () => {
      const preset = networkGatedWorkspace(["https://example.com", "https://api.example.com/v1/"]);
      expect(preset.allowList).toEqual(["https://example.com", "https://api.example.com/v1/"]);
      expect(preset.capabilities).toContain("network:outbound");
      expect(isUrlAllowed("https://example.com/anything", [...preset.allowList])).toBe(true);
      expect(isUrlAllowed("https://api.example.com/v1/foo", [...preset.allowList])).toBe(true);
      expect(isUrlAllowed("https://api.example.com/v2/foo", [...preset.allowList])).toBe(false);
      expect(isUrlAllowed("https://evil.example.com/", [...preset.allowList])).toBe(false);
      expect(isUrlAllowed("https://example.com.evil.com/", [...preset.allowList])).toBe(false);
    });

    it("copies the caller's list, so widening it later cannot widen the preset", () => {
      const list = ["https://example.com"];
      const preset = networkGatedWorkspace(list);
      expect(preset.allowList).not.toBe(list);
      list.push("https://evil.example.com");
      expect(preset.allowList).toEqual(["https://example.com"]);
      expect(isUrlAllowed("https://evil.example.com/", [...preset.allowList])).toBe(false);
    });

    it("honours the memory and profile options", () => {
      const preset = networkGatedWorkspace(["https://example.com"], {
        maxMemoryBytes: 4 * MiB,
        profile: "hardened",
      });
      expect(preset.fsOptions.maxMemoryBytes).toBe(4 * MiB);
      expect(preset.profile).toBe("hardened");
      expect(preset.ceilings).toEqual(READ_ONLY_FS.ceilings);
    });

    it("defaults to a normal profile and a 128 MiB layer when no options are given", () => {
      const preset = networkGatedWorkspace(["https://example.com"]);
      expect(preset.profile).toBe("normal");
      expect(preset.fsOptions.maxMemoryBytes).toBe(128 * MiB);
      expect(preset.fsOptions.maxFileReadSize).toBe(10 * MiB);
      expect(preset.requiresIsolation).toBe(true);
    });

    it("rejects an entry that is not a URL, instead of silently denying everything", () => {
      expect(() => networkGatedWorkspace(["not-a-url"])).toThrow(
        /network-gated-workspace preset rejected its allow-list/,
      );
    });

    it("rejects a non-http scheme", () => {
      expect(() => networkGatedWorkspace(["ftp://example.com"])).toThrow(
        /Only http and https URLs are allowed in allow-list/,
      );
    });

    it("rejects an encoded separator that could move a request across a path boundary", () => {
      // %2f survives URL parsing as three characters, so the entry is refused rather
      // than matched against a different path than the one written here.
      expect(() => networkGatedWorkspace(["https://example.com/a%2fb"])).toThrow(
        /ambiguous path separators/,
      );
    });

    it("rejects a query string, which the boundary ignores", () => {
      expect(() => networkGatedWorkspace(["https://example.com/?x=1"])).toThrow(
        /Query strings and fragments are ignored in allow-list entries/,
      );
    });
  });

  describe("resolvePreset overrides", () => {
    it("merges a partial ceilings override over the preset's ceilings", () => {
      const resolved = resolvePreset("ephemeral-tempfs", { ceilings: { maxProcesses: 4 } });
      expect(resolved.ceilings).toEqual({
        maxProcesses: 4,
        maxMemoryBytes: 512 * MiB,
        sigkillTimeoutMs: 30_000,
      });
    });

    it("applies maxMemoryBytes to the copy-on-write layer only, not the isolation ceiling", () => {
      const resolved = resolvePreset("ephemeral-tempfs", { maxMemoryBytes: 1024 });
      expect(resolved.fsOptions.maxMemoryBytes).toBe(1024);
      expect(resolved.ceilings.maxMemoryBytes).toBe(512 * MiB);
    });

    it("applies a profile override to both the shell and the network preset", () => {
      expect(resolvePreset("ephemeral-tempfs", { profile: "hardened" }).profile).toBe("hardened");
      expect(resolvePreset("network-gated-workspace", { profile: "hardened" }).profile).toBe(
        "hardened",
      );
    });

    it("accepts a valid allow-list override and hands back a copy of it", () => {
      const list = ["https://example.com"];
      const resolved = resolvePreset("ephemeral-tempfs", { allowList: list });
      expect(resolved.allowList).toEqual(list);
      expect(resolved.allowList).not.toBe(list);
      expect(isUrlAllowed("https://example.com/x", [...resolved.allowList])).toBe(true);
    });

    it("leaves every field the override does not mention alone", () => {
      const resolved = resolvePreset("read-only-fs", { ceilings: { sigkillTimeoutMs: 5_000 } });
      expect(resolved.name).toBe("read-only-fs");
      expect(resolved.capabilities).toEqual(["fs:read"]);
      expect(resolved.profile).toBe("hardened");
      expect(resolved.fsOptions).toEqual({ readOnly: true, allowSymlinks: false });
      expect(resolved.requiresIsolation).toBe(true);
    });

    it("does not mutate the base preset it resolved from", () => {
      const beforeCeilings = { ...EPHEMERAL_TEMPFS.ceilings };
      const beforeFsOptions = { ...EPHEMERAL_TEMPFS.fsOptions };
      const resolved = resolvePreset("ephemeral-tempfs", {
        allowList: ["https://example.com"],
        ceilings: { maxProcesses: 1 },
        maxMemoryBytes: 2048,
        profile: "hardened",
      });

      expect(EPHEMERAL_TEMPFS.ceilings).toEqual(beforeCeilings);
      expect(EPHEMERAL_TEMPFS.fsOptions).toEqual(beforeFsOptions);
      expect(EPHEMERAL_TEMPFS.profile).toBe("normal");
      expect(EPHEMERAL_TEMPFS.allowList).toEqual([]);
      expect(SANDBOX_PRESETS["ephemeral-tempfs"].ceilings.maxProcesses).toBe(64);

      // The result is a separate object graph: poisoning it cannot poison the table.
      expect(resolved).not.toBe(EPHEMERAL_TEMPFS);
      expect(resolved.ceilings).not.toBe(EPHEMERAL_TEMPFS.ceilings);
      expect(resolved.fsOptions).not.toBe(EPHEMERAL_TEMPFS.fsOptions);
    });

    it("rejects an invalid allow-list override instead of silently accepting it", () => {
      expect(() => resolvePreset("ephemeral-tempfs", { allowList: ["not-a-url"] })).toThrow(
        /preset 'ephemeral-tempfs' rejected its allow-list override/,
      );
    });

    it("names the offending entry in the rejection", () => {
      expect(() => resolvePreset("read-only-fs", { allowList: ["ftp://example.com"] })).toThrow(
        /Only http and https URLs are allowed in allow-list/,
      );
    });

    it("re-validates the allow-list on the network preset as well", () => {
      // The network preset builds through its factory, so the list is checked there
      // first, with the factory's message.
      expect(() => resolvePreset("network-gated-workspace", { allowList: ["not-a-url"] })).toThrow(
        /network-gated-workspace preset rejected its allow-list/,
      );
    });

    it("still re-validates a valid list on the network preset", () => {
      const resolved = resolvePreset("network-gated-workspace", {
        allowList: ["https://example.com"],
      });
      expect(resolved.allowList).toEqual(["https://example.com"]);
      expect(isUrlAllowed("https://example.com/", [...resolved.allowList])).toBe(true);
    });
  });

  describe("summarizePreset", () => {
    it("writes a human-readable account of what a preset permits", () => {
      const summary = summarizePreset(READ_ONLY_FS);
      expect(summary).toContain("read-only-fs");
      expect(summary).toContain("fs:read");
      expect(summary).toContain("network: off");
      expect(summary).toContain("SIGKILL at 30000ms");
      // The denials are the half a human needs to refuse.
      expect(summary).toContain("fs:write");
      expect(summary).toContain("network:outbound");
    });

    it("counts the allowed hosts when the network is gated", () => {
      const summary = summarizePreset(
        networkGatedWorkspace(["https://example.com", "https://api.example.com/"]),
      );
      expect(summary).toContain("network: 2 allowed host(s)");
    });
  });
});
