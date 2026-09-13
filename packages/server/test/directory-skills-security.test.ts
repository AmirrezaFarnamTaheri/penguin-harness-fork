import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDirectorySkills } from "../src/services/directory-skills.js";

const skillMd = (name: string, body = "Body") =>
  `---\nname: ${name}\ndescription: ${name} test skill\nversion: 2026.09.13.1\n---\n\n${body}\n`;

const scratch: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((dir) =>
      fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ),
  );
});

describe("directory skill containment", () => {
  it("does not follow a skill source root outside the selected directory", async () => {
    const selected = await tempDir("penguin-dirskills-selected-");
    const outside = await tempDir("penguin-dirskills-outside-");
    const outsideSkills = path.join(outside, "skills");
    await fs.mkdir(path.join(outsideSkills, "escaped"), { recursive: true });
    await fs.writeFile(path.join(outsideSkills, "escaped", "SKILL.md"), skillMd("escaped"));

    await fs.mkdir(path.join(selected, ".agents"), { recursive: true });
    await fs.symlink(outsideSkills, path.join(selected, ".agents", "skills"));

    await expect(discoverDirectorySkills(selected)).resolves.toEqual([]);
  });

  it("rejects local references that traverse an intermediate symlink", async () => {
    const selected = await tempDir("penguin-dirskills-selected-");
    const outside = await tempDir("penguin-dirskills-outside-");
    const skill = path.join(selected, ".agents", "skills", "escaped-ref");
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.md"), "outside secret\n");
    await fs.symlink(outside, path.join(skill, "references"));
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      skillMd("escaped-ref", "Read [the local reference](references/secret.md)."),
    );

    await expect(discoverDirectorySkills(selected)).resolves.toEqual([]);
  });

  it("still accepts ordinary package-local referenced resources", async () => {
    const selected = await tempDir("penguin-dirskills-selected-");
    const skill = path.join(selected, ".agents", "skills", "owned-ref");
    await fs.mkdir(path.join(skill, "references"), { recursive: true });
    await fs.writeFile(path.join(skill, "references", "guide.md"), "owned guide\n");
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      skillMd("owned-ref", "Read [the local reference](references/guide.md)."),
    );

    const discovered = await discoverDirectorySkills(selected);
    expect(discovered.map((entry) => entry.name)).toEqual(["owned-ref"]);
  });
});
