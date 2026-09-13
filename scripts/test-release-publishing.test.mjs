import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
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
