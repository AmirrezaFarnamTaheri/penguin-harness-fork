/**
 * The two path conventions a Playwright visual regression run leaves behind.
 *
 * Provenance: a Playwright run writes its *expected* images into a snapshot directory beside the spec file and
 * its *actual* images into the per-test output directory, and both names are computed by algorithms that are
 * worth reproducing exactly rather than guessing at, because a harness that pairs an actual with the wrong
 * baseline reports a regression that never happened. The baseline form is `<specFile>-snapshots/<case>-<platform>.<ext>`:
 * the directory is the spec file's name plus `-snapshots`, and the file name is the case the test named — or the
 * case Playwright derived from the test title — plus a platform suffix. The platform suffix comes from the
 * snapshot path template's `{-snapshotSuffix}` slot, and in a Windows-captured bundle it is `win32`, matching
 * the manifest's `runner_os`.
 *
 * The per-test output directory is the harder of the two: Playwright names it
 * `<sanitized-spec-relative-path>-<sanitized-title-path>` truncated to a filesystem-friendly length, with a
 * five-character SHA-1 prefix spliced into the middle when truncation happens, followed by the project id, the
 * retry index and the repeat index. The truncation keeps the first 26 characters and the last 27, which is why
 * `visual-review-visual-review-states-MCP-sharing-and-sync-inventory` becomes
 * `visual-review-visual-revie-2bc42--sharing-and-sync-inventory` on disk. `formatTestOutputDirName` reproduces
 * the same name from the parts, hash included, because the hash is deterministic in the un-truncated string.
 */

import { createHash } from "node:crypto";

/**
 * Playwright's per-path sanitizer, ported: runs of characters outside `[A-Za-z0-9_-]` become a single dash.
 * Spaces, punctuation and path separators all land in that range, so `key: value` and `a/b` both collapse to
 * dash-joined slugs.
 */
export function sanitizeForFilePath(text: string): string {
  return text.replace(/[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, "-");
}

/** The length Playwright keeps a per-test output directory name under on every platform. */
export const WINDOWS_FILESYSTEM_FRIENDLY_LENGTH = 60;

/**
 * Playwright's long-name truncation, ported: a name that fits is returned untouched; a name that does not keeps
 * its first and last characters with `-<first five hex of its own SHA-1>-` spliced between them, so two
 * differently-truncated long titles cannot collide.
 */
export function trimLongString(text: string, maxLength = 100): string {
  if (text.length <= maxLength) return text;
  const hash = createHash("sha1").update(text).digest("hex");
  const middle = `-${hash.substring(0, 5)}-`;
  const start = Math.floor((maxLength - middle.length) / 2);
  const end = maxLength - middle.length - start;
  return text.substring(0, start) + middle + text.slice(-end);
}

/** The platforms Playwright's snapshot suffix can name. */
export const BASELINE_PLATFORMS = ["win32", "darwin", "linux"] as const;

/** A platform named by a baseline file's suffix. */
export type BaselinePlatform = (typeof BASELINE_PLATFORMS)[number];

/** A parsed baseline file name: a case, its optional platform, and its extension. */
export interface BaselineName {
  /** The case name the test named or that was derived from its title, without the platform suffix. */
  caseName: string;
  /** Platform suffix from the snapshot template's `{-snapshotSuffix}` slot, when the name carries one. */
  platform: BaselinePlatform | undefined;
  /** File extension including the dot. */
  extension: string;
}

/** A parsed baseline path. */
export interface BaselinePath {
  /** Directory the spec's snapshots live in, e.g. `e2e/screenshots.spec.ts-snapshots`. */
  directory: string;
  /** Spec file name the directory belongs to, e.g. `screenshots.spec.ts`. */
  specStem: string;
  name: BaselineName;
}

const SNAPSHOT_DIR_SUFFIX = "-snapshots";

/**
 * Parse a baseline path such as `e2e/screenshots.spec.ts-snapshots/canvas-win32.png`. Returns `undefined` when
 * the path is not inside a `-snapshots` directory or is not a file with an extension. A case name that happens
 * to end in a platform word is read as carrying that platform only when the platform is one Playwright writes;
 * `workspace-light` therefore stays one case name while `canvas-win32` splits into case and platform.
 */
export function parseBaselinePath(filePath: string): BaselinePath | undefined {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const directory = separator < 0 ? "" : filePath.slice(0, separator);
  const fileName = separator < 0 ? filePath : filePath.slice(separator + 1);
  if (!fileName.includes(".")) return undefined;

  const dirBase =
    directory === ""
      ? ""
      : directory.slice(Math.max(directory.lastIndexOf("/"), directory.lastIndexOf("\\")) + 1);
  if (!dirBase.endsWith(SNAPSHOT_DIR_SUFFIX)) return undefined;

  const extension = fileName.slice(fileName.lastIndexOf("."));
  const stem = fileName.slice(0, fileName.length - extension.length);
  const platform = BASELINE_PLATFORMS.find((candidate) => stem.endsWith(`-${candidate}`));
  const caseName = platform === undefined ? stem : stem.slice(0, stem.length - platform.length - 1);

  return {
    directory,
    specStem: dirBase.slice(0, dirBase.length - SNAPSHOT_DIR_SUFFIX.length),
    name: { caseName, platform, extension },
  };
}

/** Build a baseline path from its parts. */
export function formatBaselinePath(
  specStem: string,
  caseName: string,
  platform?: BaselinePlatform,
  extension = ".png",
): string {
  const suffix = platform === undefined ? "" : `-${platform}`;
  return `${specStem}${SNAPSHOT_DIR_SUFFIX}/${caseName}${suffix}${extension}`;
}

/**
 * The key a baseline pairs an actual against: the case name alone. The platform suffix names which expected
 * image the run wrote, not which case it belongs to, so a `win32` expected pairs with an actual produced on
 * Windows and a cross-platform repository keeps one baseline per case per platform.
 */
export function baselineCaseKey(name: BaselineName): string {
  return name.caseName;
}

/** A parsed per-test output directory name, e.g. `visual-review-visual-revie-2bc42--sharing-and-sync-inventory`. */
export interface TestOutputDirName {
  /** Sanitized spec path relative to the test directory, with the spec extension removed. */
  specPath: string;
  /**
   * The title path as it appears in the name: every `describe` title and the test title joined by dashes. When
   * Playwright truncated the name this is only the tail, because the middle is replaced by the hash.
   */
  titleSlug: string;
  /** Whether Playwright truncated the name, splicing a hash into the title path. */
  truncated: boolean;
  /** The five-character SHA-1 prefix the truncation spliced in, present only when `truncated`. */
  hash: string | undefined;
  /** Project id appended after the name, when the run had more than one project. */
  projectId: string | undefined;
  /** Retry index, on a retried run. */
  retry: number | undefined;
  /** Repeat-each index, on a repeated run. */
  repeatEachIndex: number | undefined;
}

const TEST_OUTPUT_HASH = /(.+)-([0-9a-f]{5})--(.+)/;

/**
 * Parse a per-test output directory name. The hash is Playwright's own truncation marker, so a name without one
 * is an un-truncated title path and a name with one is a title path whose middle Playwright replaced. The parts
 * the truncation discarded are not recoverable from the name alone. A multi-project run appends a project id
 * after the name; this parser does not separate it, so it stays in `titleSlug` — the observed bundles are
 * single-project and carry no id to separate.
 */
export function parseTestOutputDirName(name: string): TestOutputDirName | undefined {
  let rest = name;
  let retry: number | undefined;
  let repeatEachIndex: number | undefined;

  // Suffixes are stripped from the right so the title path keeps any dashes of its own.
  const repeatFound = /-repeat(\d+)$/.exec(rest);
  if (repeatFound) {
    repeatEachIndex = Number(repeatFound[1]);
    rest = rest.slice(0, repeatFound.index);
  }
  const retryFound = /-retry(\d+)$/.exec(rest);
  if (retryFound) {
    retry = Number(retryFound[1]);
    rest = rest.slice(0, retryFound.index);
  }

  const hashed = TEST_OUTPUT_HASH.exec(rest);
  if (hashed) {
    return {
      specPath: hashed[1] ?? "",
      titleSlug: hashed[3] ?? "",
      truncated: true,
      hash: hashed[2],
      projectId: undefined,
      retry,
      repeatEachIndex,
    };
  }

  const dash = rest.lastIndexOf("-");
  if (dash < 0) return undefined;
  return {
    specPath: rest.slice(0, dash),
    titleSlug: rest.slice(dash + 1),
    truncated: false,
    hash: undefined,
    projectId: undefined,
    retry,
    repeatEachIndex,
  };
}

/** Parts sufficient to name a per-test output directory, whether or not Playwright would truncate the result. */
export interface TestOutputDirParts {
  /** Spec path relative to the test directory, with the spec extension removed. */
  specPath: string;
  /** Titles from the outermost `describe` to the test itself, in order. */
  titlePath: string[];
  projectId?: string;
  retry?: number;
  repeatEachIndex?: number;
}

/**
 * Build the name Playwright gives a test's output directory: the sanitized spec path and title path joined,
 * truncated to the filesystem-friendly length with a deterministic hash when that is not enough, then the
 * project id, retry and repeat-each suffixes. The name is byte-identical to Playwright's for the same inputs.
 */
export function formatTestOutputDirName(parts: TestOutputDirParts): string {
  const fullTitle = parts.titlePath.join(" ");
  const name = trimLongString(
    `${sanitizeForFilePath(parts.specPath)}-${sanitizeForFilePath(fullTitle)}`,
    WINDOWS_FILESYSTEM_FRIENDLY_LENGTH,
  );
  let result = name;
  if (parts.projectId) result += `-${parts.projectId}`;
  if (parts.retry) result += `-retry${parts.retry}`;
  if (parts.repeatEachIndex) result += `-repeat${parts.repeatEachIndex}`;
  return result;
}

/**
 * The case name Playwright derives for a screenshot the test did not name: the title path with a per-call
 * index, sanitized and truncated the way an anonymous snapshot name is. Named screenshots keep the name the
 * test passed, so this only applies to the anonymous form.
 */
export function anonymousSnapshotCaseName(titlePath: string[], index: number): string {
  return sanitizeForFilePath(trimLongString([...titlePath, index].join(" ")));
}
