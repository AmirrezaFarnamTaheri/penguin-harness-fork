/**
 * Behavior tests for the diagnostics document parser. The fixture mirrors the sections the observed bundle
 * writes: a `github_context` of environment variables, a `toolchain_versions` section whose values are pipes
 * and URLs, a `git_state` section whose `status:` key is followed by free-form text rather than a key/value, a
 * `lockfile_fingerprints` section of `path: bytes=N sha256=hex` lines, a `filesystem_capacity` section whose
 * keys are drive letters with colons in them, and a `repository_inventory` section that repeats `dir:` and
 * `file:` once per entry on purpose.
 */
import { describe, expect, it } from "vitest";

import {
  diagnosticsSection,
  diagnosticsSectionValue,
  diagnosticsValue,
  diagnosticsValues,
  parseDiagnosticsLog,
  parseFilesystemCapacity,
  parseLockfileFingerprints,
  parseRepositoryInventory,
} from "../../../src/internal/evidence/diagnostics-log-parser.js";

const DIAGNOSTICS = [
  "scope: Visual regression review",
  "captured_utc: 2026-09-11T13:22:14.9757217+00:00",
  "workspace: D:\\a\\Scriptor\\Scriptor",
  "os: Microsoft Windows NT 10.0.26100.0",
  "timezone: UTC",
  "",
  "github_context:",
  "  GITHUB_WORKFLOW: Visual review",
  "  GITHUB_RUN_ID: 34603822218",
  "  GITHUB_REF: refs/pull/112/merge",
  "  GITHUB_SHA: d00c4b554d038f98620bd139554492b55810f9e0",
  "",
  "toolchain_versions:",
  "  git: git version 2.55.0.windows.5",
  "  node: v22.16.0",
  "  rustc: info: syncing channel updates | rustc 1.96.0 (ac68faa20 2026-05-25) | LLVM version: 22.1.2",
  "",
  "git_state:",
  "  head: 0f34a9448c6e5b2f1281ef2d00620c51b3a8661f",
  "  branch: HEAD",
  "  commit: 0f34a9448c6e5b2f1281ef2d00620c51b3a8661f 2026-09-11T16:51:08+03:30 fix(ci): update verified deploy-pages action pin",
  "  status:",
  "    ## HEAD (no branch)",
  "",
  "lockfile_fingerprints:",
  "  Cargo.lock: bytes=245807 sha256=1ff043431eaaafddbabbc4c8a60376dc9dda9cff85079261ba76b3c3f66cfc5a",
  "  pnpm-lock.yaml: bytes=179126 sha256=4d0d40aff16b2bc2a8cafec56ef4673d4195684cbc3aba3e12db32be1b8b1e62",
  "",
  "filesystem_capacity:",
  "  C: used_gib=117.95 free_gib=31.5 root=C:\\",
  "  Temp: used_gib=117.95 free_gib=31.5 root=C:\\Users\\runneradmin\\AppData\\Local\\Temp\\",
  "",
  "repository_inventory:",
  "  dir: .github bytes=-",
  "  dir: e2e bytes=-",
  "  file: README.md bytes=1818",
  "  file: playwright.visual.config.ts bytes=2088",
].join("\r\n");

describe("parseDiagnosticsLog", () => {
  const log = parseDiagnosticsLog(DIAGNOSTICS);

  it("reads the top-level scalars", () => {
    expect(diagnosticsValue(log, "scope")).toBe("Visual regression review");
    expect(diagnosticsValue(log, "timezone")).toBe("UTC");
  });

  it("keeps a Windows path and an ISO instant with an offset intact", () => {
    expect(diagnosticsValue(log, "workspace")).toBe("D:\\a\\Scriptor\\Scriptor");
    expect(diagnosticsValue(log, "captured_utc")).toBe("2026-09-11T13:22:14.9757217+00:00");
  });

  it("finds the six sections the document writes", () => {
    expect(log.sections.map((section) => section.name)).toEqual([
      "github_context",
      "toolchain_versions",
      "git_state",
      "lockfile_fingerprints",
      "filesystem_capacity",
      "repository_inventory",
    ]);
  });

  it("reads the entries of a section of environment variables", () => {
    expect(diagnosticsSectionValue(log, "github_context", "GITHUB_SHA")).toBe(
      "d00c4b554d038f98620bd139554492b55810f9e0",
    );
    expect(diagnosticsSectionValue(log, "github_context", "GITHUB_REF")).toBe(
      "refs/pull/112/merge",
    );
  });

  it("splits a value at the first colon-space only, leaving later colons in the value", () => {
    expect(diagnosticsSectionValue(log, "toolchain_versions", "git")).toBe(
      "git version 2.55.0.windows.5",
    );
    expect(diagnosticsSectionValue(log, "toolchain_versions", "rustc")).toBe(
      "info: syncing channel updates | rustc 1.96.0 (ac68faa20 2026-05-25) | LLVM version: 22.1.2",
    );
  });

  it("keeps a git commit line's date, subject and inner colon intact", () => {
    expect(diagnosticsSectionValue(log, "git_state", "commit")).toBe(
      "0f34a9448c6e5b2f1281ef2d00620c51b3a8661f 2026-09-11T16:51:08+03:30 fix(ci): update verified deploy-pages action pin",
    );
  });

  it("treats a key followed by free-form text as a multi-line value, not a nested section", () => {
    expect(diagnosticsSectionValue(log, "git_state", "status")).toBe("## HEAD (no branch)");
  });

  it("parses the lockfile fingerprints", () => {
    const fingerprints = parseLockfileFingerprints(
      diagnosticsSection(log, "lockfile_fingerprints"),
    );
    expect(fingerprints).toEqual([
      {
        path: "Cargo.lock",
        bytes: 245807,
        sha256: "1ff043431eaaafddbabbc4c8a60376dc9dda9cff85079261ba76b3c3f66cfc5a",
      },
      {
        path: "pnpm-lock.yaml",
        bytes: 179126,
        sha256: "4d0d40aff16b2bc2a8cafec56ef4673d4195684cbc3aba3e12db32be1b8b1e62",
      },
    ]);
  });

  it("parses the filesystem capacity, including a drive key that contains a colon", () => {
    const capacity = parseFilesystemCapacity(diagnosticsSection(log, "filesystem_capacity"));
    expect(capacity).toEqual([
      { drive: "C", usedGib: 117.95, freeGib: 31.5, root: "C:\\" },
      {
        drive: "Temp",
        usedGib: 117.95,
        freeGib: 31.5,
        root: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\",
      },
    ]);
  });

  it("keeps every entry of a section that repeats its keys", () => {
    const inventory = parseRepositoryInventory(diagnosticsSection(log, "repository_inventory"));
    expect(inventory).toEqual([
      { kind: "dir", path: ".github", bytes: null },
      { kind: "dir", path: "e2e", bytes: null },
      { kind: "file", path: "README.md", bytes: 1818 },
      { kind: "file", path: "playwright.visual.config.ts", bytes: 2088 },
    ]);
  });

  it("collects every value written under one key, in order", () => {
    expect(diagnosticsValues(log, "dir")).toEqual([".github bytes=-", "e2e bytes=-"]);
  });

  it("reports a section the document does not have", () => {
    expect(diagnosticsSection(log, "network")).toBeUndefined();
    expect(diagnosticsValue(log, "uptime")).toBeUndefined();
    expect(diagnosticsSectionValue(log, "git_state", "upstream")).toBeUndefined();
  });

  it("stops at a line of dashes that closes the document", () => {
    const logWithDelimiter = parseDiagnosticsLog(
      [DIAGNOSTICS, "", "---", "later: ignored"].join("\r\n"),
    );
    expect(diagnosticsValue(logWithDelimiter, "later")).toBeUndefined();
  });

  it("parses a document with LF line endings the same way", () => {
    const lf = parseDiagnosticsLog(DIAGNOSTICS.replace(/\r\n/g, "\n"));
    expect(diagnosticsValue(lf, "scope")).toBe("Visual regression review");
    expect(diagnosticsSectionValue(lf, "git_state", "status")).toBe("## HEAD (no branch)");
  });

  it("treats a section whose children are all keyless lines as a multi-line value", () => {
    const log = parseDiagnosticsLog(["notes:", "  first line", "  second line"].join("\n"));
    expect(diagnosticsValue(log, "notes")).toBe("first line\nsecond line");
  });
});
