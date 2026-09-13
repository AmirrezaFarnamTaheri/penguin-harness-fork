import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  assert.match(
    desktopWorkflow,
    /- name: Enforce production release signing[\s\S]*?REPOSITORY: \$\{\{ github\.repository \}\}[\s\S]*?if \[\[ "\$REPOSITORY" != "Prism-Shadow\/penguin-harness" \]\]; then[\s\S]*?if \[\[ -n "\$RELEASE_TAG" \|\| "\$RELEASE_REF" == refs\/tags\/v\* \|\| "\$RELEASE_REF_NAME" == release\/\* \]\]; then[\s\S]*?echo "REQUIRE_MACOS_SIGNING=true" >> "\$GITHUB_ENV"[\s\S]*?echo "REQUIRE_WINDOWS_SIGNING=true" >> "\$GITHUB_ENV"/,
    "canonical tag and release-branch builds must upgrade both signing requirements before credential preparation",
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
    /"EVSIGN_REQUIRE=\$\(\$env:REQUIRE_WINDOWS_SIGNING\)" \| Out-File -FilePath \$env:GITHUB_ENV/,
    "Windows signing requirement must be propagated to electron-builder through the runtime environment",
  );

  assert.doesNotMatch(
    desktopWorkflow,
    /env\.REQUIRE_(?:MACOS|WINDOWS)_SIGNING/,
    "post-policy signing decisions must not use workflow expression env values that predate GITHUB_ENV overrides",
  );
  assert.doesNotMatch(
    desktopWorkflow,
    /EVSIGN_REQUIRE:\s*\$\{\{/,
    "the build step must inherit the runtime EVSIGN_REQUIRE value rather than recomputing it as a workflow expression",
  );
  assert.match(
    desktopWorkflow,
    /- name: Build packages[\s\S]*?shell: bash[\s\S]*?if \[\[ "\$RUNNER_OS" == "macOS" && "\$REQUIRE_MACOS_SIGNING" == "true" \]\]; then[\s\S]*?signing_args\+=\("-c\.mac\.forceCodeSigning=true"\)/,
    "macOS forceCodeSigning must consume the runtime signing policy",
  );

  for (const stepName of [
    "Notarize and staple macOS DMGs",
    "Clean macOS update metadata",
    "Verify macOS signing and notarization",
  ]) {
    const start = desktopWorkflow.indexOf(`      - name: ${stepName}`);
    assert.notEqual(start, -1, `${stepName} must exist`);
    const next = desktopWorkflow.indexOf("\n      - name:", start + 1);
    const block = desktopWorkflow.slice(start, next === -1 ? undefined : next);
    assert.match(block, /if: runner\.os == 'macOS'/, `${stepName} must run on macOS`);
    assert.match(
      block,
      /if \[\[ "\$REQUIRE_MACOS_SIGNING" != "true" \]\]; then/,
      `${stepName} must decide from the runtime signing policy`,
    );
  }
});

test("Docker publishing is canonical-only and honors the reusable push input", () => {
  assert.match(
    dockerWorkflow,
    /- name: Resolve publish policy[\s\S]*?id: publish-policy[\s\S]*?REPOSITORY: \$\{\{ github\.repository \}\}[\s\S]*?REQUEST_PUSH: \$\{\{ inputs\.push && 'true' \|\| 'false' \}\}[\s\S]*?if \[\[ "\$REPOSITORY" == "Prism-Shadow\/penguin-harness" \]\]; then[\s\S]*?if \[\[ "\$REQUEST_PUSH" == "true" \|\| \( -z "\$TAG" && "\$EVENT_NAME" == "push" && "\$REF" == "refs\/heads\/main" \) \]\]; then[\s\S]*?echo "publish=\$publish" >> "\$GITHUB_OUTPUT"/,
    "Docker publication must require the canonical repository and either an explicit request or a direct main push",
  );
  assert.doesNotMatch(
    dockerWorkflow,
    /github\.event_name == 'push' \|\| inputs\.push/,
    "an inherited push event must not override push: false on a reusable workflow call",
  );
  assert.match(
    dockerWorkflow,
    /- uses: docker\/login-action@v3\n\s+if: steps\.publish-policy\.outputs\.publish == 'true'/,
    "fork and build-only runs must skip Docker Hub login",
  );
  assert.match(
    dockerWorkflow,
    /push: \$\{\{ steps\.publish-policy\.outputs\.publish == 'true' \}\}/,
    "the build must use the resolved publish policy instead of the inherited caller event",
  );
});

test("release.yml is the only workflow allowed to publish npm packages", () => {
  const workflowsDir = new URL("../.github/workflows/", import.meta.url);
  const publishers = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .filter((name) => {
      const text = readFileSync(new URL(name, workflowsDir), "utf8");
      const executable = text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      return /^\s*(?:-\s+run:\s*)?(?:npm|pnpm)\b[^\n]*\bpublish\b/m.test(executable);
    });
  assert.deepEqual(
    publishers,
    ["release.yml"],
    "npm publication must have one hardened owner; duplicate release-trigger publishers bypass OIDC/preflight policy and can race the canonical release",
  );
});
