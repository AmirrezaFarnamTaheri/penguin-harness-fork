/**
 * J2.3 — the Actions pin policy scanner.
 *
 * Pinning once is not a policy: the next PR that adds `uses: actions/checkout@v5` reintroduces
 * the exact risk the pinning removed (a mutable ref means an upstream account compromise becomes
 * code execution in this repository's CI). This scanner is what makes the pin hold.
 *
 * The rules, in order:
 *
 * 1. A local action (`./...`) is allowed: it lives in this repository and is reviewed like any
 *    other file here.
 * 2. An external `uses:` must be `owner/repo@<40 lowercase hex>` — a full commit SHA, not a
 *    7-character abbreviation and not a SHA-shaped tag.
 * 3. That SHA must be followed on the same line by a readable release comment (`# v1.2.3`), so a
 *    reviewer can tell what the SHA is without asking GitHub, and a human can update it.
 * 4. The pinned pair must appear in the allow-list (`scripts/actions-pins.json`), which records
 *    owner, repository, tag and the verification that produced the mapping. A *new* ref is not
 *    rejected for being unfamiliar; it is rejected until somebody adds it to the list with the
 *    evidence — that is the "explicit allow/update policy" the card asks for.
 * 5. Docker actions written as `docker://image:tag` are external images, not actions, and are
 *    reported separately (they are not SHA-pinnable in the same way; the workflow review receipt
 *    records which ones exist).
 *
 * Permissions get the same treatment, because a pinned action that has been granted more than it
 * needs is not actually safer (the card's "permission expansion must fail review/scanner"):
 *
 * 6. A workflow must declare a `permissions:` block. Without one it inherits the repository
 *    default, which is a property of the repository settings and not of the file under review.
 * 7. `write-all` is always a violation, and a `*: write` scope is a violation unless the
 *    allow-list names that scope for that specific workflow — with a note saying why. Read scopes
 *    are free: they grant nothing beyond what `content: read` already does for a public repo.
 * 8. Composite actions (`.github/actions/<name>/action.yml`) are scanned for their `uses:` refs
 *    but not for permissions: they inherit the caller's grant and cannot declare their own.
 *
 * Usage: `node scripts/check-actions-pins.mjs [--json]`. Exit code 1 means at least one violation.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const ACTIONS = path.join(ROOT, ".github/actions");
const ALLOW_LIST = path.join(ROOT, "scripts/actions-pins.json");

const FULL_SHA = /^[0-9a-f]{40}$/;
const RELEASE_COMMENT = /#\s*v?\d+(\.\d+)*\s*$/;

/** Extracts every `uses:` value with its line number. Comments and quoted scalars included. */
export function collectUses(text) {
  const entries = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*-?\s*uses:\s*(.+?)\s*$/.exec(lines[index]);
    if (match === null) continue;
    // The captured group runs to end of line, so a trailing release comment has to come back
    // out. SHAs and refs never contain `#`, so the first ` #` is the comment boundary.
    const value = match[1].split(/\s+#/)[0].trim();
    entries.push({ line: index + 1, value, raw: lines[index] });
  }
  return entries;
}

/** Classifies one `uses:` entry. Pure: the scanner's rules, with no filesystem access. */
export function classifyUse(entry, allowed) {
  const value = entry.value.replace(/^["']|["']$/g, "");
  if (value.startsWith("./") || value === ".") {
    return { kind: "local", entry, value };
  }
  if (value.startsWith("docker://")) {
    return { kind: "docker-image", entry, value };
  }
  const at = value.lastIndexOf("@");
  if (at <= 0) return { kind: "violation", entry, value, reason: "no @ref: an unpinned action" };
  const repo = value.slice(0, at);
  const ref = value.slice(at + 1);
  if (!FULL_SHA.test(ref)) {
    return {
      kind: "violation",
      entry,
      value,
      reason: `ref "${ref}" is not a full 40-character commit SHA`,
    };
  }
  if (!RELEASE_COMMENT.test(entry.raw)) {
    return {
      kind: "violation",
      entry,
      value,
      reason: "no readable release comment (`# v1.2.3`) after the SHA",
    };
  }
  const allowedRepo = allowed[repo];
  if (allowedRepo === undefined) {
    return {
      kind: "violation",
      entry,
      value,
      reason: `repository "${repo}" is not in the allow-list`,
    };
  }
  if (allowedRepo.commit !== ref) {
    return {
      kind: "violation",
      entry,
      value,
      reason: `pinned commit ${ref} is not the allow-listed ${allowedRepo.tag} commit ${allowedRepo.commit}`,
    };
  }
  return { kind: "pinned", entry, value, repo, ref };
}

const SCOPE_LINE = /^(\s*)([a-z-]+):\s*(read|write)\s*$/;

/**
 * Collects every `permissions:` block with its scopes.
 *
 * Line-based on purpose: this script must run before (and independently of) the dependency
 * install, so it cannot import a YAML parser. The shape it reads is the only shape GitHub accepts
 * for permissions — a mapping of `scope: read|write` lines — so the parse is exact for the
 * construct being policed rather than approximate over the whole document.
 */
export function collectPermissions(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)permissions:\s*(.*)$/.exec(lines[index]);
    if (match === null) continue;
    const indent = match[1].length;
    const inline = match[2].trim();
    const scopes = [];
    if (inline !== "") {
      if (!/^(read-all|write-all|\{\s*\})$/.test(inline)) {
        scopes.push({ scope: inline, value: "?", line: index + 1 });
      } else {
        scopes.push({
          scope: inline,
          value: inline === "write-all" ? "write" : "read",
          line: index + 1,
        });
      }
    } else {
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        const scope = SCOPE_LINE.exec(lines[scan]);
        if (scope === null || scope[1].length <= indent) break;
        scopes.push({ scope: scope[2], value: scope[3], line: scan + 1 });
      }
    }
    blocks.push({ line: index + 1, scopes });
  }
  return blocks;
}

/** Applies the permission policy to one file's text. Pure, like `scanText`. */
export function scanPermissions(text, allowed, source = "<text>") {
  const results = [];
  const blocks = collectPermissions(text);
  const isWorkflow = source.includes(".github/workflows/");
  if (isWorkflow && blocks.length === 0) {
    results.push({
      kind: "violation",
      source,
      line: 1,
      value: "permissions",
      reason: "no explicit permissions block: the workflow would inherit the repository default",
    });
    return results;
  }
  const allowedWrites = allowed.writeScopes?.[source.split("/").pop()] ?? [];
  for (const block of blocks) {
    for (const { scope, value, line } of block.scopes) {
      if (scope === "write-all") {
        results.push({
          kind: "violation",
          source,
          line,
          value: `permissions: ${scope}`,
          reason: "write-all grants every scope",
        });
        continue;
      }
      if (value !== "write") {
        results.push({ kind: "read", source, line, value: `${scope}: read` });
        continue;
      }
      if (!allowedWrites.includes(`${scope}:write`)) {
        results.push({
          kind: "violation",
          source,
          line,
          value: `${scope}: write`,
          reason: `"${scope}: write" is not declared for ${source.split("/").pop()} in the allow-list`,
        });
        continue;
      }
      results.push({ kind: "write-allowed", source, line, value: `${scope}: write` });
    }
  }
  return results;
}

/** Scans one file's text. Exported so the unit test can drive it without touching the repo. */
export function scanText(text, allowed, source = "<text>") {
  const results = [];
  for (const entry of collectUses(text)) {
    const classified = classifyUse(entry, allowed);
    results.push({ ...classified, source, line: entry.line });
  }
  return results;
}

async function main() {
  const listing = JSON.parse(await readFile(ALLOW_LIST, "utf8"));
  const allowed = { ...listing.actions, writeScopes: listing.permissions?.writeScopes ?? {} };
  const files = [];
  for (const name of (await readdir(WORKFLOWS)).filter((file) => file.endsWith(".yml"))) {
    files.push(path.join(WORKFLOWS, name));
  }
  for (const dir of await readdir(ACTIONS)) {
    files.push(path.join(ACTIONS, dir, "action.yml"));
  }

  const all = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text === "") continue;
    const source = path.relative(ROOT, file);
    all.push(...scanText(text, allowed, source));
    all.push(...scanPermissions(text, allowed, source));
  }

  const violations = all.filter((result) => result.kind === "violation");
  const pinned = all.filter((result) => result.kind === "pinned");
  const dockerImages = all.filter((result) => result.kind === "docker-image");
  const local = all.filter((result) => result.kind === "local");
  const writeGrants = all.filter((result) => result.kind === "write-allowed");

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          totals: {
            uses: all.length,
            pinned: pinned.length,
            local: local.length,
            dockerImages: dockerImages.length,
            writeGrants: writeGrants.length,
            violations: violations.length,
          },
          violations: violations.map((v) => ({
            source: v.source,
            line: v.line,
            value: v.value,
            reason: v.reason,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    for (const violation of violations) {
      console.error(
        `${violation.source}:${violation.line}: ${violation.value} — ${violation.reason}`,
      );
    }
    console.log(
      `actions pins: ${pinned.length} pinned, ${local.length} local, ${dockerImages.length} docker images, ` +
        `${writeGrants.length} allow-listed write scope(s), ${violations.length} violation(s)`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
