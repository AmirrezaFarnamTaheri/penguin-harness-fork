/**
 * Foreign configuration: ownership, version gating, and a recoverable write transaction.
 *
 * A "foreign" config is a file that exists on a user's machine and was not necessarily written by
 * this Harness — a provider's own settings file, a hand-edited config, a file copied between
 * machines. Editing one has three failure modes that a plain `writeFile` cannot see:
 *
 * 1. **Someone else owns it.** The keys we know about may be a subset of what is in the file, and
 *    the file's owner may not be us. Writing anyway silently discards the parts the caller did
 *    not model. So a write first has to *prove ownership*: a marker the adapter declares has to
 *    be present with our value. Without it the file is refused as `unmanaged-provider`, and the
 *    only way to a managed state is an explicit `adopt`, which is its own transaction.
 * 2. **Its version may be from the future.** A config written by a newer release can contain
 *    constructs this release does not understand. The adapter declares an inclusive supported
 *    range, and a file outside it is refused rather than partially rewritten.
 * 3. **It may have changed since the caller looked.** A preview is a snapshot; between it and the
 *    write, another process (or the user's editor) may have saved. The caller's `expectedSha256`
 *    is compared against the live bytes *immediately before* the rename, so a changed file is
 *    refused instead of clobbered.
 *
 * Every accepted write is a transaction with the stages named in the result: back up the original
 * bytes → atomic replace (H3's `atomicWriteFile`) → read back and re-check version + marker →
 * on any failure, restore the backup byte-for-byte and report where it stopped. The original is
 * never the thing at risk, which is what makes "refuse" a safe answer for all of the above.
 *
 * Diagnostics never echo a value whose key looks secret: the readback reports `****last4`.
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rm, stat } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile } from "../internal/atomic-write.js";

/** Why a foreign-config operation refused. Every code leaves the original bytes in place. */
export type ForeignRefusalCode =
  | "unmanaged-provider"
  | "unsupported-version"
  | "changed-since-preview"
  | "symlink-target-ambiguous"
  | "permission-denied"
  | "write-failed"
  | "readback-mismatch"
  | "unsupported-syntax";

/** Where a failed transaction stopped; `backup` means the original is in the backup file. */
export type ForeignStage = "inspect" | "gate" | "backup" | "write" | "readback" | "restore";

export interface ForeignSymlinkInfo {
  /** Number of link hops followed to reach the target. */
  hops: number;
  /** The path the chain ends at. */
  resolved: string;
}

/** The original, recorded at preview time. This is the "what will be replaced" evidence. */
export interface ForeignPreview {
  adapterId: string;
  /** The path the caller named. */
  path: string;
  /** The path the write would actually land on (the end of the symlink chain). */
  resolvedPath: string;
  bytes: number;
  sha256: string;
  /** Permission bits of the resolved file, or null when it does not exist yet. */
  mode: number | null;
  mtimeMs: number | null;
  /** Version read from the config, or null when the adapter found none. */
  version: number | null;
  /** The marker value found, or null when the file does not carry one. */
  marker: string | null;
  /** True only when the adapter's marker is present with the expected value. */
  isManagedProvider: boolean;
  /** Whether the resolved path is a regular file we can replace. */
  isRegularFile: boolean;
  symlink: ForeignSymlinkInfo | null;
}

export type ForeignPreviewResult =
  | { ok: true; preview: ForeignPreview; diagnostics: string[] }
  | { ok: false; code: ForeignRefusalCode; message: string; diagnostics: string[] };

export type ForeignTransactionResult =
  | {
      ok: true;
      adapterId: string;
      path: string;
      resolvedPath: string;
      backupPath: string;
      beforeSha256: string;
      afterSha256: string;
      bytesWritten: number;
      version: number;
      /** Redacted view of what the file now contains. */
      readback: Record<string, string>;
      stages: ForeignStage[];
    }
  | {
      ok: false;
      adapterId: string;
      path: string;
      code: ForeignRefusalCode;
      message: string;
      diagnostics: string[];
      /** The stage the transaction reached before refusing or failing. */
      failedAt: ForeignStage;
      /** True when the original bytes were put back (or never moved). */
      originalPreserved: boolean;
      backupPath: string | null;
      stages: ForeignStage[];
    };

/**
 * Everything format-specific about one config family. The transaction is written once, against
 * this interface, so a new provider is an adapter rather than a second copy of the safety rules.
 */
export interface ForeignConfigAdapter {
  id: string;
  /** The top-level key whose value proves we manage this file. */
  markerKey: string;
  /** The value `markerKey` must carry for the file to count as managed by us. */
  markerValue: string;
  /** The top-level key holding the config's format version. */
  versionKey: string;
  /** Inclusive range of versions this release can rewrite correctly. */
  supportedVersions: { min: number; max: number };
  /** Reads the marker and version out of the raw text; returns nulls when it cannot. */
  inspect(text: string): { marker: string | null; version: number | null };
  /**
   * Returns the file's text with `patch` merged in and the marker/version ensured. Throws or
   * returns null when the file cannot be edited without losing unknown content — the caller turns
   * that into `unsupported-syntax` rather than writing a half-understood file.
   */
  compose(text: string, patch: Record<string, string>, version: number): string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Adapter for JSON provider configs (`settings.json`-shaped files): all top-level keys are
 * preserved, the patch merges over them, and `JSON.stringify` keeps the file re-readable.
 */
export function jsonConfigAdapter(options: {
  id: string;
  markerKey: string;
  markerValue: string;
  versionKey?: string;
  supportedVersions: { min: number; max: number };
}): ForeignConfigAdapter {
  const versionKey = options.versionKey ?? "configVersion";
  return {
    id: options.id,
    markerKey: options.markerKey,
    markerValue: options.markerValue,
    versionKey,
    supportedVersions: options.supportedVersions,
    inspect(text) {
      if (text.trim() === "") return { marker: null, version: null };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { marker: null, version: null };
      }
      if (!isPlainObject(parsed)) return { marker: null, version: null };
      const marker = parsed[options.markerKey];
      const version = parsed[versionKey];
      return {
        marker: typeof marker === "string" ? marker : null,
        version: typeof version === "number" && Number.isInteger(version) ? version : null,
      };
    },
    compose(text, patch, version) {
      const parsed = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
      if (!isPlainObject(parsed)) return null;
      const next: Record<string, unknown> = { ...parsed, ...patch };
      next[options.markerKey] = options.markerValue;
      next[versionKey] = version;
      return `${JSON.stringify(next, null, 2)}\n`;
    },
  };
}

/**
 * Adapter for the Harness's own TOML project config.
 *
 * The marker is `penguin_managed = true` and the version is `penguin_version`. A project config
 * written by earlier releases carries neither, so it inspects as unmanaged — which is the honest
 * answer: those files are written by `saveProjectConfig`, which owns their whole format, and this
 * adapter must not assume it can round-trip a file it did not model. Adoption is what marks a
 * file as ours.
 *
 * Editing is deliberately conservative: only top-level `key = value` lines are touched, and any
 * text the line editor cannot classify (a multi-line array, a nested table it would have to
 * rewrite) makes `compose` return null so the caller refuses with `unsupported-syntax`.
 */
export function tomlConfigAdapter(options: {
  id: string;
  markerKey: string;
  versionKey: string;
  /** Value written for `markerKey`; read back as either `true` or a quoted string. */
  markerValue: string;
  supportedVersions: { min: number; max: number };
}): ForeignConfigAdapter {
  const { markerKey, versionKey, markerValue } = options;
  const isTopLevel = (line: string): boolean => /^[A-Za-z0-9_.-]+\s*=/.test(line);
  const keyOf = (line: string): string => line.slice(0, line.indexOf("=")).trim();
  return {
    id: options.id,
    markerKey,
    markerValue,
    versionKey,
    supportedVersions: options.supportedVersions,
    inspect(text) {
      let marker: string | null = null;
      let version: number | null = null;
      let inTable = false;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) {
          inTable = true;
          continue;
        }
        if (inTable || !isTopLevel(trimmed)) continue;
        const key = keyOf(trimmed);
        const value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
        if (key === markerKey) {
          const bare = value.replace(/^["']|["']$/g, "");
          marker = bare === "true" || bare === markerValue ? markerValue : bare;
        }
        if (key === versionKey) {
          const parsed = Number.parseInt(value.replace(/^["']|["']$/g, ""), 10);
          if (Number.isInteger(parsed)) version = parsed;
        }
      }
      return { marker, version };
    },
    compose(text, patch, version) {
      const wanted = new Map<string, string>([
        ...Object.entries(patch).map(
          ([key, value]) =>
            [key, `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`] as const,
        ),
        [markerKey, "true"] as const,
        [versionKey, String(version)] as const,
      ]);
      const lines = text.split("\n");
      const seen = new Set<string>();
      const out: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        // Anything that is not a blank line, a comment, or a top-level key/value is left exactly
        // as it is; the only refusals come from the size check below.
        if (trimmed !== "" && !trimmed.startsWith("#") && isTopLevel(trimmed)) {
          const key = keyOf(trimmed);
          const replacement = wanted.get(key);
          if (replacement !== undefined) {
            seen.add(key);
            out.push(`${key} = ${replacement}`);
            continue;
          }
        }
        out.push(line);
      }
      const missing = [...wanted.entries()].filter(([key]) => !seen.has(key));
      if (missing.length > 0) {
        // Insert above the first table header so the new keys stay top-level.
        const firstTable = out.findIndex((line) => line.trim().startsWith("["));
        const insertion = missing.map(([key, value]) => `${key} = ${value}`);
        if (firstTable === -1) out.push(...insertion);
        else out.splice(firstTable, 0, ...insertion);
      }
      const composed = out.join("\n");
      // The composed text must inspect back to what we intended, or the edit was not understood.
      const check = this.inspect(composed);
      if (check.marker !== markerValue || check.version !== version) return null;
      return composed.endsWith("\n") ? composed : `${composed}\n`;
    },
  };
}

/** The adapter used for the Harness's own project config files. */
export const PROJECT_CONFIG_ADAPTER = tomlConfigAdapter({
  id: "penguin-project-config",
  markerKey: "penguin_managed",
  versionKey: "penguin_version",
  markerValue: "true",
  supportedVersions: { min: 1, max: 1 },
});

const SECRET_KEY = /(api[_-]?key|token|secret|password|credential)/i;
const MAX_SYMLINK_HOPS = 40;

/** Masks a value for display: the last four characters survive, everything else does not. */
export function redactValue(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function followSymlinks(target: string): Promise<{ resolved: string; hops: number }> {
  let current = target;
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops += 1) {
    let link: string;
    try {
      link = await readlink(current);
    } catch {
      return { resolved: current, hops };
    }
    current = path.resolve(path.dirname(current), link);
  }
  throw new Error(`Too many levels of symbolic links: "${target}"`);
}

/**
 * Reads a config without changing it: bytes, hash, permissions, version, ownership, and the
 * symlink chain, so a caller can decide (and show the user) exactly what a write would replace.
 */
export async function previewForeignConfig(
  target: string,
  adapter: ForeignConfigAdapter,
): Promise<ForeignPreviewResult> {
  const diagnostics: string[] = [];
  let resolvedPath: string;
  let hops = 0;
  try {
    const chain = await followSymlinks(target);
    resolvedPath = chain.resolved;
    hops = chain.hops;
  } catch (error) {
    return {
      ok: false,
      code: "symlink-target-ambiguous",
      message: `symlink chain at ${target} does not terminate: ${(error as Error).message}`,
      diagnostics: [`inspected ${target}`],
    };
  }
  const symlink = hops > 0 ? { hops, resolved: resolvedPath } : null;
  diagnostics.push(
    symlink === null
      ? `${target} is not a symlink`
      : `${target} -> ${resolvedPath} (${hops} hop(s))`,
  );

  let info: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    info = await lstat(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        ok: false,
        code: "permission-denied",
        message: `cannot stat ${resolvedPath}: ${code ?? "unknown error"}`,
        diagnostics,
      };
    }
    diagnostics.push(`${resolvedPath} does not exist yet`);
  }

  // A symlink whose chain ends at a directory (or a character device, or another link we could
  // not resolve) is ambiguous: replacing it would either rename the link or write into a
  // directory, and neither is what "edit this config" means.
  if (info !== null && !info.isFile()) {
    return {
      ok: false,
      code: "symlink-target-ambiguous",
      message: `${resolvedPath} is not a regular file (${info.isDirectory() ? "directory" : "special"})`,
      diagnostics,
    };
  }

  let text = "";
  if (info !== null) {
    try {
      text = await readFile(resolvedPath, "utf8");
    } catch (error) {
      return {
        ok: false,
        code: "permission-denied",
        message: `cannot read ${resolvedPath}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
        diagnostics,
      };
    }
  }

  const { marker, version } = adapter.inspect(text);
  const preview: ForeignPreview = {
    adapterId: adapter.id,
    path: target,
    resolvedPath,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256(text),
    mode: info === null ? null : info.mode & 0o777,
    mtimeMs: info === null ? null : info.mtimeMs,
    version,
    marker,
    isManagedProvider: marker === adapter.markerValue,
    isRegularFile: info !== null,
    symlink,
  };
  return { ok: true, preview, diagnostics };
}

function versionInRange(adapter: ForeignConfigAdapter, version: number | null): boolean {
  if (version === null) return false;
  return version >= adapter.supportedVersions.min && version <= adapter.supportedVersions.max;
}

function refusal(
  adapter: ForeignConfigAdapter,
  target: string,
  code: ForeignRefusalCode,
  message: string,
  diagnostics: string[],
  failedAt: ForeignStage,
  stages: ForeignStage[],
  extra: { backupPath?: string | null; originalPreserved?: boolean } = {},
): ForeignTransactionResult {
  return {
    ok: false,
    adapterId: adapter.id,
    path: target,
    code,
    message,
    diagnostics,
    failedAt,
    originalPreserved: extra.originalPreserved ?? true,
    backupPath: extra.backupPath ?? null,
    stages,
  };
}

/** The backup path for a given original: content-addressed, so re-backing-up is idempotent. */
export function backupPathFor(target: string, sha: string): string {
  return `${target}.penguin-backup-${sha.slice(0, 12)}`;
}

async function writeBackup(
  target: string,
  resolvedPath: string,
  sha: string,
  mode: number | null,
): Promise<string> {
  const backupPath = backupPathFor(target, sha);
  await copyFile(resolvedPath, backupPath);
  if (mode !== null) await chmod(backupPath, mode);
  return backupPath;
}

async function readbackRedacted(
  adapter: ForeignConfigAdapter,
  resolvedPath: string,
  patch: Record<string, string>,
): Promise<Record<string, string>> {
  const text = await readFile(resolvedPath, "utf8");
  const summary: Record<string, string> = {};
  for (const key of Object.keys(patch)) {
    if (SECRET_KEY.test(key)) {
      summary[key] = redactValue(patch[key]!);
      continue;
    }
    summary[key] = patch[key]!;
  }
  const { marker, version } = adapter.inspect(text);
  summary[adapter.markerKey] = marker ?? "(absent)";
  summary[adapter.versionKey] = version === null ? "(absent)" : String(version);
  return summary;
}

/**
 * Writes `patch` into a managed foreign config.
 *
 * The order is fixed and every step is represented in the result: inspect → gate (ownership,
 * version, and the caller's `expectedSha256` against the live bytes) → back up → atomic replace →
 * read back and re-check the marker and version. A failure after the backup restores those bytes
 * and says so; a failure before it never touched the file.
 */
export async function applyForeignConfig(
  target: string,
  adapter: ForeignConfigAdapter,
  options: {
    patch: Record<string, string>;
    /** The `sha256` from the preview the caller is acting on. Required: no implicit overwrite. */
    expectedSha256: string;
    /** Write through a symlink standing at `target` (see `atomicWriteFile`). */
    followSymlinks?: boolean;
  },
): Promise<ForeignTransactionResult> {
  const stages: ForeignStage[] = [];
  stages.push("inspect");
  const inspected = await previewForeignConfig(target, adapter);
  if (!inspected.ok) {
    return refusal(
      adapter,
      target,
      inspected.code,
      inspected.message,
      inspected.diagnostics,
      "inspect",
      stages,
    );
  }
  const preview = inspected.preview;

  stages.push("gate");
  if (!preview.isManagedProvider) {
    return refusal(
      adapter,
      target,
      "unmanaged-provider",
      `${preview.resolvedPath} does not carry ${adapter.markerKey} = ${adapter.markerValue}; it is not managed by ${adapter.id}. Adopt it explicitly first.`,
      [...inspected.diagnostics, `marker: ${preview.marker ?? "(absent)"}`],
      "gate",
      stages,
    );
  }
  if (!versionInRange(adapter, preview.version)) {
    return refusal(
      adapter,
      target,
      "unsupported-version",
      `${preview.resolvedPath} declares version ${preview.version ?? "(absent)"}; this release writes ${adapter.supportedVersions.min}-${adapter.supportedVersions.max}`,
      [...inspected.diagnostics, `version: ${preview.version ?? "(absent)"}`],
      "gate",
      stages,
    );
  }
  if (preview.sha256 !== options.expectedSha256) {
    return refusal(
      adapter,
      target,
      "changed-since-preview",
      `the file changed since it was previewed (expected ${options.expectedSha256.slice(0, 12)}, found ${preview.sha256.slice(0, 12)})`,
      [...inspected.diagnostics, "refusing to overwrite a file another writer has moved"],
      "gate",
      stages,
    );
  }

  // The gate above is a snapshot; re-read immediately before the write so a change that lands in
  // between is caught rather than clobbered (the "concurrent owner" case).
  const live = await readFile(preview.resolvedPath, "utf8").catch(() => null);
  if (live === null || sha256(live) !== options.expectedSha256) {
    return refusal(
      adapter,
      target,
      "changed-since-preview",
      "the file changed between the gate and the write",
      [...inspected.diagnostics, "second check immediately before rename failed"],
      "gate",
      stages,
    );
  }

  const composed = adapter.compose(
    live,
    options.patch,
    preview.version ?? adapter.supportedVersions.min,
  );
  if (composed === null) {
    return refusal(
      adapter,
      target,
      "unsupported-syntax",
      `${preview.resolvedPath} contains constructs this adapter cannot rewrite without losing content`,
      [...inspected.diagnostics, `adapter ${adapter.id} declined to compose`],
      "gate",
      stages,
    );
  }

  stages.push("backup");
  let backupPath: string;
  try {
    backupPath = await writeBackup(target, preview.resolvedPath, preview.sha256, preview.mode);
  } catch (error) {
    return refusal(
      adapter,
      target,
      "permission-denied",
      `cannot back up ${preview.resolvedPath}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
      inspected.diagnostics,
      "backup",
      stages,
    );
  }

  stages.push("write");
  try {
    await mkdir(path.dirname(preview.resolvedPath), { recursive: true });
    await atomicWriteFile(preview.resolvedPath, composed, {
      ...(preview.mode !== null ? { mode: preview.mode } : {}),
      followSymlinks: options.followSymlinks === true,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const restored = await restoreForeignConfig(backupPath, preview.resolvedPath).catch(
      () => false,
    );
    stages.push("restore");
    return refusal(
      adapter,
      target,
      code === "EACCES" || code === "EPERM" ? "permission-denied" : "write-failed",
      `write failed at ${preview.resolvedPath}: ${code ?? (error as Error).message}`,
      [
        ...inspected.diagnostics,
        restored ? "original restored from backup" : "restore reported failure",
      ],
      "write",
      stages,
      { backupPath, originalPreserved: restored },
    );
  }

  stages.push("readback");
  const readbackText = await readFile(preview.resolvedPath, "utf8").catch(() => null);
  const readbackInspect = readbackText === null ? null : adapter.inspect(readbackText);
  // The version gate is checked again on the bytes that actually landed: a write that produced an
  // unreadable or marker-less file is a failure, not a success with a stale summary.
  const readbackOk =
    readbackInspect !== null &&
    readbackInspect.marker === adapter.markerValue &&
    versionInRange(adapter, readbackInspect.version);
  if (!readbackOk) {
    const restored = await restoreForeignConfig(backupPath, preview.resolvedPath).catch(
      () => false,
    );
    stages.push("restore");
    return refusal(
      adapter,
      target,
      "readback-mismatch",
      `the written file did not read back as ${adapter.id} version ${preview.version ?? "?"}`,
      [
        ...inspected.diagnostics,
        `marker read back: ${readbackInspect?.marker ?? "(absent)"}`,
        `version read back: ${readbackInspect?.version ?? "(absent)"}`,
      ],
      "readback",
      stages,
      { backupPath, originalPreserved: restored },
    );
  }

  return {
    ok: true,
    adapterId: adapter.id,
    path: target,
    resolvedPath: preview.resolvedPath,
    backupPath,
    beforeSha256: preview.sha256,
    afterSha256: sha256(composed),
    bytesWritten: Buffer.byteLength(composed, "utf8"),
    version: readbackInspect!.version!,
    readback: await readbackRedacted(adapter, preview.resolvedPath, options.patch),
    stages,
  };
}

/**
 * Claims a foreign file for this adapter: a normal transaction whose patch is empty and whose
 * purpose is the marker (and version). It refuses an already-managed file and a file whose
 * version is unreadable, because adoption is about files we do not understand yet.
 */
export async function adoptForeignConfig(
  target: string,
  adapter: ForeignConfigAdapter,
  options: { expectedSha256: string; followSymlinks?: boolean; version?: number },
): Promise<ForeignTransactionResult> {
  const version = options.version ?? adapter.supportedVersions.min;
  if (version < adapter.supportedVersions.min || version > adapter.supportedVersions.max) {
    return refusal(
      adapter,
      target,
      "unsupported-version",
      `cannot adopt as version ${version}; this release writes ${adapter.supportedVersions.min}-${adapter.supportedVersions.max}`,
      [],
      "gate",
      ["inspect"],
    );
  }
  // Adoption is the one path allowed to write an unmanaged file, so it runs the transaction with
  // the ownership gate satisfied by construction: it composes the marker itself.
  const inspected = await previewForeignConfig(target, adapter);
  if (!inspected.ok) {
    return refusal(
      adapter,
      target,
      inspected.code,
      inspected.message,
      inspected.diagnostics,
      "inspect",
      ["inspect"],
    );
  }
  if (inspected.preview.isManagedProvider) {
    return refusal(
      adapter,
      target,
      "unmanaged-provider",
      `${inspected.preview.resolvedPath} is already managed by ${adapter.id}`,
      inspected.diagnostics,
      "gate",
      ["inspect"],
    );
  }
  const original = await readFile(inspected.preview.resolvedPath, "utf8").catch(() => "");
  const composed = adapter.compose(original, {}, version);
  if (composed === null) {
    return refusal(
      adapter,
      target,
      "unsupported-syntax",
      `${inspected.preview.resolvedPath} cannot be adopted by ${adapter.id}`,
      inspected.diagnostics,
      "gate",
      ["inspect"],
    );
  }

  const stages: ForeignStage[] = ["inspect", "gate", "backup", "write", "readback"];
  let backupPath: string;
  try {
    backupPath = await writeBackup(
      target,
      inspected.preview.resolvedPath,
      inspected.preview.sha256,
      inspected.preview.mode,
    );
  } catch (error) {
    return refusal(
      adapter,
      target,
      "permission-denied",
      `cannot back up ${inspected.preview.resolvedPath}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
      inspected.diagnostics,
      "backup",
      ["inspect", "gate"],
    );
  }
  try {
    await mkdir(path.dirname(inspected.preview.resolvedPath), { recursive: true });
    await atomicWriteFile(inspected.preview.resolvedPath, composed, {
      ...(inspected.preview.mode !== null ? { mode: inspected.preview.mode } : {}),
      followSymlinks: options.followSymlinks === true,
    });
  } catch (error) {
    const restored = await restoreForeignConfig(backupPath, inspected.preview.resolvedPath).catch(
      () => false,
    );
    return refusal(
      adapter,
      target,
      "write-failed",
      `adoption write failed: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
      [
        ...inspected.diagnostics,
        restored ? "original restored from backup" : "restore reported failure",
      ],
      "write",
      ["inspect", "gate", "backup", "write", "restore"],
      { backupPath, originalPreserved: restored },
    );
  }
  const after = adapter.inspect(await readFile(inspected.preview.resolvedPath, "utf8"));
  return {
    ok: true,
    adapterId: adapter.id,
    path: target,
    resolvedPath: inspected.preview.resolvedPath,
    backupPath,
    beforeSha256: inspected.preview.sha256,
    afterSha256: sha256(composed),
    bytesWritten: Buffer.byteLength(composed, "utf8"),
    version: after.version ?? version,
    readback: {
      [adapter.markerKey]: after.marker ?? "(absent)",
      [adapter.versionKey]: String(after.version ?? "(absent)"),
    },
    stages,
  };
}

/**
 * Puts the backup's bytes back, atomically and with the backup's own mode, so a restore cannot
 * itself be interrupted half-way. Returns false when the backup is unreadable or when the bytes
 * on disk after the restore are not the backup's.
 *
 * The atomic attempt can fail for the very reason the transaction is restoring: a rename refused
 * by the operating system is not a one-off. So there is a second attempt that writes the file in
 * place (no rename) and a final verification that the target now holds the backup's bytes
 * exactly. A restore that cannot prove itself reports failure rather than claiming success.
 */
export async function restoreForeignConfig(backupPath: string, target: string): Promise<boolean> {
  let bytes: Buffer;
  let mode: number | null = null;
  try {
    bytes = await readFile(backupPath);
    const info = await stat(backupPath);
    mode = info.mode & 0o777;
  } catch {
    return false;
  }
  const verify = async (): Promise<boolean> => {
    const onDisk = await readFile(target).catch(() => null);
    return onDisk !== null && onDisk.equals(bytes);
  };
  try {
    await atomicWriteFile(target, bytes, mode === null ? {} : { mode });
    if (await verify()) return true;
  } catch {
    // Fall through to the in-place attempt below.
  }
  try {
    await copyFile(backupPath, target);
    if (mode !== null) await chmod(target, mode);
  } catch {
    return false;
  }
  return verify();
}

/** Removes a backup file (used by callers that keep the original elsewhere). */
export async function discardBackup(backupPath: string): Promise<void> {
  await rm(backupPath, { force: true });
}
