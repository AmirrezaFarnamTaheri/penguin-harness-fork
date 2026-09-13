import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverDirectorySkills } from "../src/services/directory-skills.js";

const roots: string[] = [];

async function makeSkill(
  root: string,
  name: string,
  body: string,
  files: Record<string, string> = {},
): Promise<void> {
  const dir = path.join(root, ".agents", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture\nversion: 2026.09.13.1\n---\n\n${body}\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }),
    ),
  );
});

describe("directory skill resource closure", () => {
  it("offers complete packages but quarantines missing and flattened local resources", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-skill-closure-"));
    roots.push(root);

    await makeSkill(
      root,
      "complete-skill",
      "Read `references/api.md` before use.",
      { "references/api.md": "# API\n" },
    );
    await makeSkill(root, "missing-skill", "Read `_common/BOUNDARIES.md` before use.");
    await makeSkill(
      root,
      "flattened-pointer-skill",
      "Read `_common/BOUNDARIES.md` before use.",
      { _common: "../_common\n" },
    );

    const discovered = await discoverDirectorySkills(root);
    expect(discovered.map((skill) => skill.name)).toEqual(["complete-skill"]);
  });

  it("does not mistake illustrative placeholder paths for missing dependencies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-skill-placeholders-"));
    roots.push(root);

    await makeSkill(
      root,
      "example-skill",
      "Run `scripts/<generated-name>.js` when your generated helper exists.",
    );

    const discovered = await discoverDirectorySkills(root);
    expect(discovered.map((skill) => skill.name)).toEqual(["example-skill"]);
  });
});
