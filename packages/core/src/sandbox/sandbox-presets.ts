/**
 * Sandbox security policy presets — Track 2's Tier 4 layer.
 *
 * Each preset is a complete, named policy: the capability set, the egress
 * allow-list, the resource ceilings, the execution-limit profile, and the filesystem
 * options, assembled so a caller spells an intent rather than configuring a dozen
 * knobs and hoping the combination is safe.
 *
 * The presets differ along two axes that matter. The first is **filesystem
 * mutability**: `read-only-fs` denies writes outright, `ephemeral-tempfs` permits
 * them inside a copy-on-write layer that never reaches host disk, and
 * `strict-microvm-isolation` permits writes only inside a per-sandbox overlay whose
 * root is private. The second is **network reachability**: `network-gated-workspace`
 * is the only preset that grants outbound network, and it grants it to an explicit
 * allow-list — an empty allow-list is *still* network-off, which is why the preset
 * constructor takes the list as an argument rather than defaulting it.
 *
 * Every preset denies the capability set the policy box denies by default; presets
 * only ever *add* permissions, and the `denied` list exists to make that visible in
 * telemetry and in an approval prompt. A preset that needed to *remove* a denial
 * would be a signal that the denial was wrong, not that the preset was right.
 */

import type { AllowedUrlEntry } from "./egress-allowlist.js";
import { validateAllowList } from "./egress-allowlist.js";
import type { ExecutionLimits } from "./execution-limits.js";
import type { CowFsOptions } from "./cow-fs-backend.js";
import type { IsolationCeilings } from "./isolated-execution-runtime.js";
import { DEFAULT_ISOLATION_CEILINGS } from "./isolated-execution-runtime.js";

/** Preset identifiers. */
export type SandboxPresetName =
  "read-only-fs" | "ephemeral-tempfs" | "network-gated-workspace" | "strict-microvm-isolation";

/**
 * A sandbox policy: everything a runtime needs to decide one script's fate.
 */
export interface SandboxPreset {
  readonly name: SandboxPresetName;
  readonly description: string;
  /** Capabilities the preset explicitly permits, on top of nothing. */
  readonly capabilities: readonly string[];
  /** Capabilities the preset explicitly records as denied, for telemetry. */
  readonly denied: readonly string[];
  /** Permitted egress destinations. Empty means no outbound network. */
  readonly allowList: readonly AllowedUrlEntry[];
  /** Resource ceilings for the isolated tier. */
  readonly ceilings: IsolationCeilings;
  /** Execution-limit profile name. */
  readonly profile: "normal" | "hardened";
  /** Filesystem options for the in-memory / copy-on-write tier. */
  readonly fsOptions: Readonly<CowFsOptions>;
  /** Whether the isolated tier is required for anything not in-memory safe. */
  readonly requiresIsolation: boolean;
}

/**
 * The read-only preset: no writes at all.
 *
 * Used for inspection — listing, reading, diffing — where the script's job is to
 * report and any write is a mistake. The filesystem is mounted read-only so a script
 * that tries `>` learns it cannot, instead of writing into a copy-on-write layer it
 * will then report as success.
 */
export const READ_ONLY_FS: SandboxPreset = {
  name: "read-only-fs",
  description:
    "Read-only filesystem access with no network. For inspection scripts whose only job is to report.",
  capabilities: ["fs:read"],
  denied: ["fs:write", "network:outbound", "network:bind", "shell:native-binary"],
  allowList: [],
  ceilings: DEFAULT_ISOLATION_CEILINGS,
  profile: "hardened",
  fsOptions: { readOnly: true, allowSymlinks: false },
  requiresIsolation: true,
};

/**
 * The ephemeral tempfs preset: writes allowed, nowhere persistent.
 *
 * Reads come from the lower layer; writes go into an in-memory copy-on-write layer
 * bounded by `maxMemoryBytes`, so a script's writes exist for the duration of the
 * sandbox and cannot reach host disk. This is the default for shell work, because
 * the overwhelming majority of shell writes are scratch.
 */
export const EPHEMERAL_TEMPFS: SandboxPreset = {
  name: "ephemeral-tempfs",
  description:
    "Copy-on-write filesystem: reads from the workspace, writes to an in-memory layer that never reaches disk.",
  capabilities: ["fs:read", "fs:write", "shell:exec"],
  denied: ["network:outbound", "network:bind", "shell:native-binary"],
  allowList: [],
  ceilings: DEFAULT_ISOLATION_CEILINGS,
  profile: "normal",
  fsOptions: {
    readOnly: false,
    allowSymlinks: false,
    maxMemoryBytes: 128 * 1024 * 1024,
    maxFileReadSize: 10 * 1024 * 1024,
  },
  requiresIsolation: false,
};

/**
 * The network-gated workspace preset: outbound network, to named destinations only.
 *
 * The only preset that grants `network:outbound`, and it grants it *to a list*. The
 * list is validated at construction: an entry that is not a valid http/https URL, or
 * one with ambiguous path separators, is a configuration error the caller hears
 * about rather than a permission that silently does not match anything.
 */
export function networkGatedWorkspace(
  allowList: AllowedUrlEntry[],
  options?: {
    maxMemoryBytes?: number;
    profile?: "normal" | "hardened";
  },
): SandboxPreset {
  const errors = validateAllowList(allowList);
  if (errors.length > 0) {
    throw new Error(
      `network-gated-workspace preset rejected its allow-list:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  return {
    name: "network-gated-workspace",
    description:
      "Workspace shell plus outbound network access to an explicit allow-list; listening is denied.",
    capabilities: ["fs:read", "fs:write", "shell:exec", "shell:native-binary", "network:outbound"],
    denied: ["network:bind"],
    allowList: [...allowList],
    ceilings: DEFAULT_ISOLATION_CEILINGS,
    profile: options?.profile ?? "normal",
    fsOptions: {
      readOnly: false,
      allowSymlinks: false,
      maxMemoryBytes: options?.maxMemoryBytes ?? 128 * 1024 * 1024,
      maxFileReadSize: 10 * 1024 * 1024,
    },
    requiresIsolation: true,
  };
}

/**
 * The strict isolation preset: everything not in-memory safe runs in a hardware-
 * isolated sandbox, with the tightest ceilings and a hardened limit profile.
 *
 * Named for what it *does not* assume: it does not assume the in-memory tier is
 * enough, does not assume the copy-on-write layer is enough, and does not assume the
 * script is benign. The memory ceiling is halved, the process cap is a quarter of
 * the default, and the SIGKILL threshold drops to 10 seconds — a hostile workload
 * gets less time to be hostile in.
 */
export const STRICT_MICROVM_ISOLATION: SandboxPreset = {
  name: "strict-microvm-isolation",
  description:
    "Hardware isolation for untrusted binaries: tightest ceilings, hardened limits, no network, no symlinks.",
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
  ceilings: {
    maxProcesses: 16,
    maxMemoryBytes: 256 * 1024 * 1024,
    sigkillTimeoutMs: 10_000,
  },
  profile: "hardened",
  fsOptions: {
    readOnly: false,
    allowSymlinks: false,
    maxMemoryBytes: 32 * 1024 * 1024,
    maxFileReadSize: 4 * 1024 * 1024,
  },
  requiresIsolation: true,
};

/** The factory preset table, keyed by name. */
export const SANDBOX_PRESETS: Readonly<Record<SandboxPresetName, SandboxPreset>> = {
  "read-only-fs": READ_ONLY_FS,
  "ephemeral-tempfs": EPHEMERAL_TEMPFS,
  "network-gated-workspace": networkGatedWorkspace([]),
  "strict-microvm-isolation": STRICT_MICROVM_ISOLATION,
};

/**
 * Resolve a preset by name, applying per-instance overrides. Overriding the
 * allow-list re-validates it, because the list is the one part of a preset whose
 * contents are caller data rather than caller intent.
 */
export function resolvePreset(
  name: SandboxPresetName,
  overrides?: {
    allowList?: AllowedUrlEntry[];
    ceilings?: Partial<IsolationCeilings>;
    maxMemoryBytes?: number;
    profile?: "normal" | "hardened";
  },
): SandboxPreset {
  const base =
    name === "network-gated-workspace"
      ? networkGatedWorkspace(overrides?.allowList ?? [], {
          maxMemoryBytes: overrides?.maxMemoryBytes,
          profile: overrides?.profile,
        })
      : SANDBOX_PRESETS[name];

  if (!overrides) return base;

  const allowList = overrides.allowList ?? base.allowList;
  if (overrides.allowList) {
    const errors = validateAllowList(allowList);
    if (errors.length > 0) {
      throw new Error(
        `preset '${name}' rejected its allow-list override:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }

  const fsOptions = { ...base.fsOptions };
  if (overrides.maxMemoryBytes !== undefined) {
    fsOptions.maxMemoryBytes = overrides.maxMemoryBytes;
  }

  return {
    ...base,
    allowList: [...allowList],
    ceilings: { ...base.ceilings, ...overrides.ceilings },
    profile: overrides.profile ?? base.profile,
    fsOptions,
  };
}

/**
 * A human-readable summary of what a preset permits, for an approval prompt. A
 * permission the human cannot read is a permission the human cannot refuse.
 */
export function summarizePreset(preset: SandboxPreset): string {
  const lines = [
    `${preset.name}: ${preset.description}`,
    `  permits: ${preset.capabilities.join(", ") || "(none beyond defaults)"}`,
    `  denies: ${preset.denied.join(", ")}`,
    `  network: ${preset.allowList.length > 0 ? `${preset.allowList.length} allowed host(s)` : "off"}`,
    `  ceilings: ${preset.ceilings.maxProcesses} processes, ` +
      `${Math.round(preset.ceilings.maxMemoryBytes / (1024 * 1024))} MiB, ` +
      `SIGKILL at ${preset.ceilings.sigkillTimeoutMs}ms`,
  ];
  return lines.join("\n");
}
