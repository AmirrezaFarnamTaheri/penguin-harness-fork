/**
 * J2.3/J2.4 — the scanner's cases, driven by the committed fixtures in `./fixtures/actions-pins/`.
 *
 * Every named negative from the card has a fixture: mutable tag, unknown owner/action, malformed
 * SHA, nested composite ref, and permission expansion. There is one control fixture that must
 * pass, so a scanner that rejects everything fails here rather than looking strict.
 *
 * `node --test scripts/check-actions-pins.test.mjs`
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

import {
  classifyUse,
  collectPermissions,
  collectUses,
  scanPermissions,
  scanText,
} from "./check-actions-pins.mjs";

const ALLOW_LIST = JSON.parse(
  await readFile(new URL("./actions-pins.json", import.meta.url), "utf8"),
);
const ALLOWED = { ...ALLOW_LIST.actions, writeScopes: ALLOW_LIST.permissions.writeScopes };
const FIXTURES = new URL("./fixtures/actions-pins/", import.meta.url);

const classify = (line) => classifyUse(collectUses(line)[0], ALLOWED);

async function fixture(name) {
  return readFile(new URL(name, FIXTURES), "utf8");
}

async function violationsOf(name) {
  const text = await fixture(name);
  const source = name.includes("/") ? `.github/actions/${name}` : `.github/workflows/${name}`;
  return [...scanText(text, ALLOWED, source), ...scanPermissions(text, ALLOWED, source)].filter(
    (result) => result.kind === "violation",
  );
}

test("the control fixture passes both the ref and the permission policy", async () => {
  assert.deepEqual(await violationsOf("pinned-ok.yml"), []);
});

test("mutable tag: actions/checkout@v5 is rejected", async () => {
  const [violation] = await violationsOf("mutable-tag.yml");
  assert.match(violation.reason, /not a full 40-character commit SHA/);
});

test("unknown owner/action: a SHA-pinned ref outside the allow-list is rejected", async () => {
  const [violation] = await violationsOf("unknown-owner.yml");
  assert.match(violation.reason, /not in the allow-list/);
});

test("malformed SHA: a 7-character abbreviation is rejected", async () => {
  const [violation] = await violationsOf("malformed-sha.yml");
  assert.match(violation.reason, /not a full 40-character commit SHA/);
});

test("a correct SHA with no readable release comment is rejected", async () => {
  const [violation] = await violationsOf("missing-comment.yml");
  assert.match(violation.reason, /no readable release comment/);
});

test("permission expansion: an undeclared write scope is rejected", async () => {
  const [violation] = await violationsOf("permission-expansion.yml");
  assert.match(violation.reason, /id-token: write.*not declared/);
});

test("permission expansion: write-all is always rejected", async () => {
  const [violation] = await violationsOf("write-all.yml");
  assert.match(violation.reason, /write-all grants every scope/);
});

test("implicit permissions: a workflow with no permissions block is rejected", async () => {
  const [violation] = await violationsOf("implicit-permissions.yml");
  assert.match(violation.reason, /no explicit permissions block/);
});

test("nested composite ref: a mutable ref inside a composite action is rejected", async () => {
  const [violation] = await violationsOf("nested-composite/action.yml");
  assert.match(violation.reason, /not a full 40-character commit SHA/);
  // Composite actions are not asked for their own permissions: they inherit the caller's grant.
  const permissions = scanPermissions(
    await fixture("nested-composite/action.yml"),
    ALLOWED,
    ".github/actions/x/action.yml",
  );
  assert.deepEqual(permissions, []);
});

test("a branch name and a short SHA are both rejected", () => {
  assert.match(
    classify("uses: actions/checkout@main").reason,
    /not a full 40-character commit SHA/,
  );
  assert.match(
    classify("uses: actions/checkout@fbc6f399").reason,
    /not a full 40-character commit SHA/,
  );
});

test("the exact allow-listed pin with its release comment passes", () => {
  const commit = ALLOWED["actions/checkout"].commit;
  assert.equal(classify(`      - uses: actions/checkout@${commit} # v5.0.0`).kind, "pinned");
  assert.equal(classify(`uses: "actions/checkout@${commit}" # v5.0.0`).kind, "pinned");
});

test("local actions and docker images are not ref violations", () => {
  assert.equal(classify("uses: ./.github/actions/setup").kind, "local");
  assert.equal(classify("uses: docker://alpine:3.20").kind, "docker-image");
});

test("permissions are read from both the block and the inline form", () => {
  assert.deepEqual(
    collectPermissions("permissions:\n  contents: read\n  id-token: write\n")[0].scopes.map(
      (s) => `${s.scope}:${s.value}`,
    ),
    ["contents:read", "id-token:write"],
  );
  assert.deepEqual(collectPermissions("permissions: write-all\n")[0].scopes[0].value, "write");
});

test("every fixture on disk is exercised by this file", async () => {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith(".yml"));
  const source = await readFile(new URL(import.meta.url), "utf8");
  for (const name of [...names, "nested-composite/action.yml"]) {
    assert.ok(source.includes(name), `${name} is not referenced by the suite`);
  }
});

test("the repository's real pins all map to allow-list entries with provenance", () => {
  for (const [name, entry] of Object.entries(ALLOW_LIST.actions)) {
    assert.match(entry.commit, /^[0-9a-f]{40}$/, `${name} commit`);
    assert.ok(entry.tag.length > 0, `${name} tag`);
    assert.ok(entry.verified.length > 10, `${name} verification note`);
  }
  assert.ok(Object.keys(ALLOW_LIST.actions).length >= 14);
  for (const [name, scopes] of Object.entries(ALLOW_LIST.permissions.writeScopes)) {
    assert.ok(name.endsWith(".yml"), `${name} is a workflow`);
    assert.ok(
      scopes.every((scope) => scope.endsWith(":write")),
      `${name} scopes are write scopes`,
    );
  }
});
