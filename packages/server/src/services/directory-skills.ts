/**
 * Skills read from a directory the user picked, rather than from the built-in library.
 * Directory imports are deliberately text-only: binary auxiliary payloads are rejected explicitly
 * instead of being decoded with replacement characters and silently corrupted.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseSkillFrontmatter,
  PLUGIN_NAME_PATTERN,
  resolveSkillAlias,
} from "@prismshadow/penguin-core";
import type { SkillMetadata } from "@prismshadow/penguin-core";
import { HttpError } from "../http/errors.js";
import {
  MAX_ARCHIVE_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  skillTooLarge,
} from "./skill-import-limits.js";

export const SKILL_SOURCE_DIRS = [".agents/skills", ".claude/skills"] as const;
export type SkillSourceDir = (typeof SKILL_SOURCE_DIRS)[number];

export interface DirectorySkill extends SkillMetadata {
  content: string;
  icon?: string;
  files?: Record<string, string>;
  source: SkillSourceDir;
}

export interface DirectorySkillEntry extends Omit<DirectorySkill, "files"> {
  abs: string;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function resolveSkillRoots(
  dir: string,
): Promise<Array<{ abs: string; source: SkillSourceDir }>> {
  const roots: Array<{ abs: string; source: SkillSourceDir }> = [];
  const seen = new Set<string>();
  let selectedRoot: string;
  try {
    selectedRoot = await fs.realpath(dir);
    if (!(await fs.stat(selectedRoot)).isDirectory()) return roots;
  } catch {
    return roots;
  }

  for (const source of SKILL_SOURCE_DIRS) {
    let abs: string;
    try {
      abs = await fs.realpath(path.join(selectedRoot, source));
      if (!isStrictDescendant(selectedRoot, abs)) continue;
      if (!(await fs.stat(abs)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    roots.push({ abs, source });
  }
  return roots;
}

function isSafeSkillFilePath(rel: string): boolean {
  return (
    rel.length > 0 &&
    !path.isAbsolute(rel) &&
    !rel.includes("\\") &&
    !rel.split("/").some((segment) => segment === "..")
  );
}

function stripAnchorAndQuery(value: string): string {
  return value.split("#", 1)[0]!.split("?", 1)[0]!;
}

function isConcreteLocalReference(value: string): boolean {
  // Placeholders, globs and illustrative pseudo-paths are documentation examples rather than
  // resource-closure claims. Keep this in sync with scripts/skills/lib.mjs.
  if (/[<>{}*\[\]]/.test(value) || value.includes("...")) return false;
  if (value.endsWith("/")) return false;
  return true;
}

/**
 * Extract concrete package-local paths that the Skill explicitly tells the runtime/agent to use.
 * This intentionally mirrors the repository skill-integrity auditor so a package cannot be
 * reported as incomplete yet still be offered for installation by the server.
 */
function extractLocalReferences(markdown: string): string[] {
  const refs = new Set<string>();
  const add = (raw: string) => {
    const value = stripAnchorAndQuery(raw.trim().replace(/^['"<]|['">]$/g, ""));
    if (!value || /^(?:https?:|mailto:|data:|asset:|#)/i.test(value)) return;
    if (value.startsWith("/") || value.startsWith("~")) return;
    if (!isConcreteLocalReference(value) || !isSafeSkillFilePath(value)) return;
    if (/^(?:scripts|references|assets|_common|_templates)\//.test(value)) refs.add(value);
  };

  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) add(match[1]!);
  for (const match of markdown.matchAll(
    /`((?:scripts|references|assets|_common|_templates)\/[^`\s]+)`/g,
  )) {
    add(match[1]!);
  }
  for (const match of markdown.matchAll(
    /(?:^|\s)(?:node|python3?|bash|sh)\s+((?:scripts|references|assets)\/[^\s'"`;]+)/gm,
  )) {
    add(match[1]!);
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

async function isOwnedLocalResource(root: string, rel: string): Promise<boolean> {
  let current = root;
  for (const segment of rel.split("/")) {
    current = path.join(current, segment);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { code?: string }).code === "ENOENT" ||
          (error as { code?: string }).code === "ENOTDIR")
      ) {
        return false;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) return false;
  }

  const stat = await fs.lstat(current);
  return stat.isFile() || stat.isDirectory();
}

async function hasCompleteLocalResourceClosure(dir: string, content: string): Promise<boolean> {
  for (const rel of extractLocalReferences(content)) {
    // Reject symlinks in every path component, not just at the leaf. Otherwise a package could
    // claim `references/foo.md` while `references` itself points outside the selected checkout.
    if (!(await isOwnedLocalResource(dir, rel))) return false;
  }
  return true;
}

function decodeUtf8Strict(data: Uint8Array, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new HttpError(
      400,
      "binary_skill_file_unsupported",
      `Skill file '${label}' is binary or is not valid UTF-8. Directory skill imports currently support text files only.`,
    );
  }
  if (text.includes("\u0000")) {
    throw new HttpError(
      400,
      "binary_skill_file_unsupported",
      `Skill file '${label}' contains NUL bytes and cannot be imported as text.`,
    );
  }
  return text;
}

async function readSkillFile(file: string): Promise<string | undefined> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  if (stat.size > MAX_FILE_BYTES) throw skillTooLarge();
  return decodeUtf8Strict(await fs.readFile(file), path.basename(file));
}

async function readAuxiliaryFiles(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let count = 0;
  let total = 0;

  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const relChild = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(abs, entry.name), relChild);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relChild === "SKILL.md" || relChild === "icon.svg") continue;
      if (!isSafeSkillFilePath(relChild)) continue;

      const child = path.join(abs, entry.name);
      const stat = await fs.lstat(child);
      if (!stat.isFile()) continue;
      const size = stat.size;
      count += 1;
      total += size;
      if (count > MAX_ARCHIVE_FILES || size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        throw skillTooLarge();
      }
      files[relChild] = decodeUtf8Strict(await fs.readFile(child), relChild);
    }
  };

  await walk(dir, "");
  return files;
}

async function readSkillEntry(
  abs: string,
  name: string,
  source: SkillSourceDir,
): Promise<DirectorySkillEntry | null> {
  const content = await readSkillFile(path.join(abs, "SKILL.md"));
  if (content === undefined) return null;
  const metadata = parseSkillFrontmatter(content);
  if (!metadata) return null;
  if (!(await hasCompleteLocalResourceClosure(abs, content))) return null;
  const icon = await readSkillFile(path.join(abs, "icon.svg"));
  return {
    ...metadata,
    name,
    content,
    ...(icon !== undefined ? { icon } : {}),
    source,
    abs,
  };
}

export async function discoverDirectorySkills(dir: string): Promise<DirectorySkillEntry[]> {
  const byName = new Map<string, DirectorySkillEntry>();
  for (const root of await resolveSkillRoots(dir)) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PLUGIN_NAME_PATTERN.test(entry.name)) continue;
      if (byName.has(entry.name)) continue;
      const skill = await readSkillEntry(
        path.join(root.abs, entry.name),
        entry.name,
        root.source,
      ).catch(() => null);
      if (skill) byName.set(entry.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveDirectorySkills(
  dir: string,
  names: readonly string[],
): Promise<DirectorySkill[]> {
  if (names.length === 0) return [];
  const found = new Map((await discoverDirectorySkills(dir)).map((skill) => [skill.name, skill]));
  const picked = names.map((name) => {
    let skill = found.get(name);
    if (!skill) skill = found.get(resolveSkillAlias(name));
    if (!skill) {
      throw new HttpError(404, "unknown_skill", `Skill is not in ${dir}: ${name}`);
    }
    return skill;
  });

  return Promise.all(
    picked.map(async ({ abs, ...skill }) => {
      const files = await readAuxiliaryFiles(abs);
      return { ...skill, ...(Object.keys(files).length > 0 ? { files } : {}) };
    }),
  );
}
