import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const desktopWorkflow = readFileSync(
  new URL("../.github/workflows/desktop-build.yml", import.meta.url),
  "utf8",
);
const dockerWorkflow = readFileSync(
  new URL("../.github/workflows/docker.yml", import.meta.url),
  "utf8",
);
const publishing = workflow.slice(workflow.indexOf("          package_version_exists() {"));
const validator = /node -e '([\s\S]*?)' "\$versions" "\$version"/.exec(publishing)?.[1];
assert.ok(validator, "release workflow must expose its registry-response validator");

function validate(response, version = "0.2.12") {
  let exitCode;
  runInNewContext(validator, {
    process: {
      argv: ["node", response, version],
      exit: (code) => {
        exitCode = code;
      },
    },
    console: { error() {} },
  });
  return exitCode;
}

test("published versions are skipped only on an exact match", () => {
  assert.equal(validate('["0.2.11","0.2.12"]'), 0);
  assert.equal(validate('"0.2.12"'), 0);
  assert.equal(validate('["0.2.120","0.2.12-rc.1"]'), 1);
  assert.equal(validate("[]"), 1);
});

test("malformed registry responses fail instead of authorizing publication", () => {
  for (const response of [
    "",
    "not json",
    "null",
    "{}",
    ' {"error":"unavailable"}',
    "42",
    "false",
    '["0.2.11",null]',
    '[""]',
  ]) {
    assert.equal(validate(response), 2, response);
  }
});

test("canonical release desktop builds cannot silently downgrade required signing", () => {
  const canonicalGuard =
    "github.repository == 'Prism-Shadow/penguin-harness' && (inputs.tag != '' || startsWith(github.ref, 'refs/tags/v') || startsWith(github.ref_name, 'release/'))";
  assert.equal(
    desktopWorkflow.split(canonicalGuard).length - 1,
    2,
    "both macOS and Windows signing requirements must be forced for canonical release contexts",
  );

  assert.match(
    desktopWorkflow,
    /if \[\[ "\$REQUIRE_MACOS_SIGNING" != "true" \]\]; then[\s\S]*?missing=\(\)[\s\S]*?\[\[ -z "\$\{CSC_LINK:-\}" \]\] && missing\+=\("CSC_LINK"\)/,
    "macOS may build unsigned only when signing is not required; missing credentials must fail when it is required",
  );
  assert.doesNotMatch(
    desktopWorkflow,
    /REQUIRE_MACOS_SIGNING" != "true" \|\| -z "\$\{CSC_LINK:-\}"/,
    "a missing CSC_LINK must never bypass a required macOS signature",
  );

  assert.match(
    desktopWorkflow,
    /if \(\[string\]::IsNullOrWhiteSpace\(\$env:EVSIGN_KEY\)\) \{[\s\S]*?if \(\$env:REQUIRE_WINDOWS_SIGNING -eq "true"\) \{[\s\S]*?Write-Error "Missing EVSIGN_KEY secret required for Windows release signing\."/,
    "Windows must fail closed when EVSIGN_KEY is absent and signing is required",
  );
  assert.match(
    desktopWorkflow,
    /EVSIGN_REQUIRE: \$\{\{ runner\.os == 'Windows' && env\.REQUIRE_WINDOWS_SIGNING == 'true' && 'true' \|\| 'false' \}\}/,
    "the build must not erase a required Windows-signing state merely because the secret is absent",
  );
  assert.match(
    desktopWorkflow,
    /if \(\$sig\.Status -eq "NotSigned" -and \$env:REQUIRE_WINDOWS_SIGNING -ne "true"\) \{/,
    "unsigned Windows artifacts are acceptable only for an explicitly non-required dry-run",
  );
});

test("fork Docker workflows build without authenticating to the upstream registry", () => {
  assert.match(
    dockerWorkflow,
    /PUBLISH_IMAGE: \$\{\{ github\.repository == 'Prism-Shadow\/penguin-harness' && \(github\.event_name == 'push' \|\| inputs\.push\) && 'true' \|\| 'false' \}\}/,
    "only the canonical repository may publish the upstream Docker image",
  );
  assert.match(
    dockerWorkflow,
    /- uses: docker\/login-action@v3\n\s+if: env\.PUBLISH_IMAGE == 'true'/,
    "fork runs must skip Docker Hub login when upstream credentials are unavailable",
  );
  assert.match(
    dockerWorkflow,
    /push: \$\{\{ env\.PUBLISH_IMAGE == 'true' \}\}/,
    "fork runs must still build while keeping registry mutation disabled",
  );
});
