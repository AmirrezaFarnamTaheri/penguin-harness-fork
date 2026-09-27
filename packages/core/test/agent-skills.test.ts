/**
 * On-disk behavior of an Agent's installed Skills: installSkill /
 * removeSkill / listInstalledSkills, and metadata injection via skillMetadataSection /
 * assembleSystemPrompt.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { librarySkill } from "../src/index.js";
import {
  AGENTS_MD_PLACEHOLDER,
  DEFAULT_AGENT_ID,
  DEFAULT_PROJECT_ID,
  SKILL_METADATA_PLACEHOLDER,
  agentStateDir,
  assembleSystemPrompt,
  installSkill,
  listInstalledSkills,
  removeSkill,
  skillMetadataSection,
  skillsDir,
} from "../src/state/index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-skills-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const install = (name: string, content: string, icon?: string) =>
  installSkill(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID, {
    name,
    content,
    ...(icon !== undefined ? { icon } : {}),
  });
const list = () => listInstalledSkills(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID);
const skillFile = (name: string, file: string) =>
  path.join(skillsDir(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID), name, file);
const skillMd = (name: string) => skillFile(name, "SKILL.md");
const skillIcon = (name: string) => skillFile(name, "icon.svg");

describe("installSkill / removeSkill", () => {
  it("writes skills/<name>/SKILL.md verbatim with a trailing newline", async () => {
    const skill = librarySkill("penguin-config")!.skill;
    await install(skill.name, skill.content);
    expect(await fs.readFile(skillMd("penguin-config"), "utf8")).toBe(skill.content);

    // Content without a trailing newline gets one appended; reinstalling overwrites.
    await install(
      "penguin-config",
      "---\nname: penguin-config\nversion: 2026.08.01.2\n---\n\nNew body",
    );
    expect(await fs.readFile(skillMd("penguin-config"), "utf8")).toBe(
      "---\nname: penguin-config\nversion: 2026.08.01.2\n---\n\nNew body\n",
    );
    expect((await list()).map((s) => s.version)).toEqual(["2026.08.01.2"]);
  });

  it("writes an install's icon.svg alongside SKILL.md, and reinstalling without one removes it", async () => {
    // Library skills carry no icon (the plugin owns it), but installSkill still accepts one —
    // for user-authored skills and zip imports. An install with an icon writes it to disk.
    const icon = "<svg><rect /></svg>";
    await install("penguin-sdk", librarySkill("penguin-sdk")!.skill.content, icon);
    expect(await fs.readFile(skillIcon("penguin-sdk"), "utf8")).toBe(icon);

    // Overwrite semantics: this install has no icon -> the old icon.svg is removed, and the
    // directory matches this install's content exactly.
    await install("penguin-sdk", "---\nname: penguin-sdk\nversion: 2\n---\n\nNew body\n");
    await expect(fs.access(skillIcon("penguin-sdk"))).rejects.toThrow();
    expect(await fs.readFile(skillMd("penguin-sdk"), "utf8")).toContain("New body");
  });

  it("rejects invalid skill names (path traversal safety)", async () => {
    await expect(install("../evil", "x")).rejects.toThrow(/skill_name/);
    await expect(install("a/b", "x")).rejects.toThrow(/skill_name/);
    await expect(removeSkill(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID, "..")).rejects.toThrow(
      /skill_name/,
    );
  });

  it("writes auxiliary files a SKILL.md references (subdirs preserved), and a reinstall drops ones the new version omits", async () => {
    await installSkill(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID, {
      name: "multi",
      content: "---\nname: multi\n---\nBody\n",
      files: { "reference/API.md": "# API\n", "reference/nested/notes.txt": "notes\n" },
    });
    expect(await fs.readFile(skillFile("multi", "reference/API.md"), "utf8")).toBe("# API\n");
    expect(await fs.readFile(skillFile("multi", "reference/nested/notes.txt"), "utf8")).toBe(
      "notes\n",
    );

    // Reinstall with a smaller file set: the whole directory is replaced, so the dropped file is gone.
    await installSkill(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID, {
      name: "multi",
      content: "---\nname: multi\n---\nBody\n",
      files: { "reference/API.md": "# API v2\n" },
    });
    expect(await fs.readFile(skillFile("multi", "reference/API.md"), "utf8")).toBe("# API v2\n");
    await expect(fs.access(skillFile("multi", "reference/nested/notes.txt"))).rejects.toThrow();
  });

  it("rejects auxiliary file paths that escape the skill directory, writing nothing", async () => {
    for (const bad of ["../evil.md", "/abs.md", "a\\b.md", "ref/../../x.md", ""]) {
      await expect(
        installSkill(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID, {
          name: "guarded",
          content: "---\nname: guarded\n---\nBody\n",
          files: { [bad]: "x" },
        }),
      ).rejects.toThrow(/skill file path/);
      // The guard runs before any write: the skill directory is never created.
      await expect(fs.access(skillMd("guarded"))).rejects.toThrow();
    }
  });

  it("stages the install and leaves no staging directory behind", async () => {
    const skill = librarySkill("penguin-sdk")!.skill;
    await install(skill.name, skill.content);
    const entries = await fs.readdir(skillsDir(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID));
    expect(entries).toEqual(["penguin-sdk"]);
  });

  it("removeSkill deletes the whole skill directory and is idempotent", async () => {
    const skill = librarySkill("penguin-sdk")!.skill;
    await install(skill.name, skill.content);
    await removeSkill(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID, "penguin-sdk");
    await expect(fs.access(skillMd("penguin-sdk"))).rejects.toThrow();
    // Idempotent when it no longer exists: does not throw.
    await removeSkill(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID, "penguin-sdk");
    expect(await list()).toEqual([]);
  });
});

describe("listInstalledSkills", () => {
  it("returns [] when the skills directory does not exist", async () => {
    expect(await list()).toEqual([]);
  });

  it("parses frontmatter and sorts by name", async () => {
    await install(
      "zeta",
      "---\nname: zeta\ndescription: Z skill.\nversion: 2026.07.16.3\n---\n\nBody\n",
    );
    await install(
      "alpha",
      "---\nname: alpha\ndescription: A skill.\nversion: 2026.07.16.1\n---\n\nBody\n",
    );
    expect(await list()).toEqual([
      { name: "alpha", description: "A skill.", version: "2026.07.16.1" },
      { name: "zeta", description: "Z skill.", version: "2026.07.16.3" },
    ]);
  });

  it("returns icon.svg content and passes short description fields through", async () => {
    const icon = '<svg viewBox="0 0 24 24"><path d="M4 4h16" /></svg>\n';
    await install(
      "with-extras",
      "---\nname: with-extras\ndescription: Long description here.\nshort_description: Short one.\nshort_description_zh: 短描述。\nversion: 2026.07.17.1\n---\n\nBody\n",
      icon,
    );
    await install(
      "plain",
      "---\nname: plain\ndescription: Plain skill.\nversion: 2026.07.17.1\n---\n\nBody\n",
    );
    const skills = await list();
    expect(skills).toEqual([
      { name: "plain", description: "Plain skill.", version: "2026.07.17.1" },
      {
        name: "with-extras",
        description: "Long description here.",
        shortDescription: "Short one.",
        shortDescriptionZh: "短描述。",
        version: "2026.07.17.1",
        icon,
      },
    ]);
    // Entries missing icon / short description omit the corresponding field (undefined does
    // not produce a key; the interface layer's conditional spread relies on this convention).
    expect("icon" in skills[0]!).toBe(false);
    expect("shortDescription" in skills[0]!).toBe(false);
  });

  it("uses the directory name as the skill identity even when frontmatter name disagrees", async () => {
    // A hand-written or network-sourced skill may have a frontmatter name that differs from
    // its directory name: the directory name is the addressing key used for install, uninstall,
    // and Prompt lookup, so the listing must follow it (frontmatter fields are display-only).
    await install(
      "local-name",
      "---\nname: upstream-name\ndescription: Fetched skill.\nversion: 2026.07.01.2\n---\n\nBody\n",
    );
    expect(await list()).toEqual([
      { name: "local-name", description: "Fetched skill.", version: "2026.07.01.2" },
    ]);
  });

  it("falls back to directory-name metadata for broken frontmatter and skips non-skill entries", async () => {
    // A SKILL.md without frontmatter: falls back to directory name + empty description + version 1.
    await install("broken", "# No frontmatter here\n");
    // Directories without a SKILL.md, and stray files, do not count as Skills.
    const dir = skillsDir(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID);
    await fs.mkdir(path.join(dir, "empty-dir"), { recursive: true });
    await fs.writeFile(path.join(dir, "stray.md"), "stray", "utf8");
    // A staging directory an interrupted install left behind is complete enough to look like a
    // Skill; the dot prefix (never a valid Skill name) is what keeps it out.
    await fs.mkdir(path.join(dir, ".half-installed.incoming"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".half-installed.incoming", "SKILL.md"),
      "---\nname: half-installed\n---\nBody\n",
      "utf8",
    );
    expect(await list()).toEqual([{ name: "broken", description: "", version: "" }]);
  });
});

describe("skillMetadataSection / assembleSystemPrompt injection", () => {
  it("renders one `- \\`name\\` — description` line per skill; empty input renders empty", () => {
    expect(skillMetadataSection([])).toBe("");
    expect(
      skillMetadataSection([
        { name: "a", description: "Does A.", version: "2026.07.16.1" },
        { name: "b", description: "", version: "" },
      ]),
    ).toBe("- `a` — Does A.\n- `b`");
  });

  it("replaces {{SKILL_METADATA}} with metadata lines, or an empty string when absent", () => {
    const state = {
      root: tmpRoot,
      projectId: DEFAULT_PROJECT_ID,
      agentId: DEFAULT_AGENT_ID,
      stateDir: agentStateDir(tmpRoot, DEFAULT_PROJECT_ID, DEFAULT_AGENT_ID),
      systemConfig: {
        system_prompt: ["before", AGENTS_MD_PLACEHOLDER, SKILL_METADATA_PLACEHOLDER, "after"].join(
          "\n",
        ),
      },
      agentsMd: "# Agent Rules",
    };
    const prompt = assembleSystemPrompt(state, undefined, undefined, [
      { name: "demo", description: "Demo skill.", version: "2026.07.16.1" },
    ]);
    expect(prompt).toBe(["before", "# Agent Rules", "- `demo` — Demo skill.", "after"].join("\n"));
    // Not provided / empty list: the placeholder is replaced with an empty string, no residue left.
    const empty = assembleSystemPrompt(state);
    expect(empty).toBe(["before", "# Agent Rules", "", "after"].join("\n"));
    expect(empty).not.toContain(SKILL_METADATA_PLACEHOLDER);
  });
});

describe("skill index cost (Q1: skills must not pad every request)", () => {
  const corpus = (count: number, over: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `skill-${i}`,
      // A long-form description with a matching author-written short_description, the shape
      // the shipped corpus actually has.
      description: `Long form ${i}. ${"detail ".repeat(over)}`,
      shortDescription: `Short form ${i}.`,
      version: "1.0.0",
    }));

  it("carries no skill body for a 200-skill corpus — only the index line", () => {
    const section = skillMetadataSection(corpus(200, 40));
    // Every skill is discoverable: 200 rows.
    expect(section.split("\n")).toHaveLength(200);
    // No body ever leaks in: the long form is what a body-less-but-verbose description would
    // drag in, and none of it is present.
    expect(section).not.toContain("detail detail");
    for (const skill of corpus(200, 40)) {
      expect(section).toContain(`- \`${skill.name}\` — ${skill.shortDescription}`);
    }
  });

  it("prefers the shorter form, so the index shrinks by the short/long gap", () => {
    const skills = corpus(1, 40);
    const before = skillMetadataSection([{ ...skills[0]!, shortDescription: undefined }]);
    const after = skillMetadataSection(skills);
    expect(after).toBe("- `skill-0` — Short form 0.");
    expect(after.length).toBeLessThan(before.length);
  });

  it("is never longer than the full-description form it replaces, even when short is longer", () => {
    // `rust-no-std` in the real corpus: short_description 84 chars, description 83.
    const skill = {
      name: "x",
      description: "D".repeat(83),
      shortDescription: "S".repeat(84),
      version: "",
    };
    const legacy = skillMetadataSection([{ ...skill, shortDescription: undefined }]);
    expect(skillMetadataSection([skill]).length).toBeLessThanOrEqual(legacy.length);
  });

  it("falls back to the full description when a skill ships no short form", () => {
    expect(
      skillMetadataSection([{ name: "a", description: "Only the long form.", version: "" }]),
    ).toBe("- `a` — Only the long form.");
  });

  it("uses the short form for a skill whose description is empty but short form is not", () => {
    expect(
      skillMetadataSection([
        { name: "a", description: "", shortDescription: "Has one.", version: "" },
      ]),
    ).toBe("- `a` — Has one.");
  });

  it("emits a bare name when a skill has neither form", () => {
    expect(
      skillMetadataSection([
        { name: "a", description: "", version: "" },
        { name: "b", description: "   ", shortDescription: "  ", version: "" },
      ]),
    ).toBe("- `a`\n- `b`");
  });

  it("does not cap the corpus: every installed skill stays listed", () => {
    // 507 is the measured size of a real installed corpus. A cap here would be alphabetical
    // (the section is assembled at Session open, before any user message to rank against) and
    // would make skills undiscoverable, so no cap is applied and this asserts that.
    expect(skillMetadataSection(corpus(507, 0)).split("\n")).toHaveLength(507);
  });
});
