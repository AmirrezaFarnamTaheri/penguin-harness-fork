/**
 * skill-catalog.ts unit test: the Skills page's projection of GET /api/plugins onto skill
 * rows. Three things it pins, all of them defects this page shipped:
 *
 *  1. the row key — skill names repeat ACROSS plugins, so keying the list on the name made
 *     React throw "Encountered two children with the same key". The page has no DOM test
 *     environment (vitest runs in node, this package has no component-testing library), so
 *     the collision is asserted the way React detects it: over the whole sibling list, every
 *     key distinct — while the fixture deliberately puts the same skill name under two
 *     different plugins, which is the case the old key could not express;
 *  2. the category — the rows carry the library group's REAL id, so the page's pills (built
 *     from the response's own groups) can filter, instead of the seven invented bucket ids
 *     the page compared against;
 *  3. the instruction body — read from a plugin's file response, or null. There is no
 *     fallback that manufactures one, because the listing response carries no body and the
 *     page used to assemble one out of the skill's name and description.
 */
import { describe, expect, it } from "vitest";
import type { PluginFilesResponse, PluginGroupItem } from "@prismshadow/penguin-server/api";
import {
  ALL_GROUPS,
  filterSkillRows,
  groupLabel,
  skillBodyOf,
  skillBodyPath,
  skillRowKey,
  skillRows,
  stripSkillFrontmatter,
  type SkillRow,
} from "../src/features/skills/skill-catalog";

const skill = (name: string, description = `${name} description`) => ({
  name,
  description,
  version: "2026.09.01.1",
});

const plugin = (name: string, skills: ReturnType<typeof skill>[]) => ({
  name,
  description: `${name} plugin`,
  version: "2026.09.01.1",
  skills,
  hooks: [] as string[],
});

/** Two categories, and the two plugins that share a skill name — the collision fixture. */
const LIBRARY: PluginGroupItem[] = [
  {
    id: "software-development",
    title: "Software Development",
    titleZh: "软件开发",
    plugins: [plugin("alpha", [skill("shared-name"), skill("only-alpha")])],
  },
  {
    id: "office-productivity",
    title: "Office Productivity",
    titleZh: "办公效率",
    plugins: [plugin("beta", [skill("shared-name"), skill("only-beta")])],
  },
];

const rows = skillRows(LIBRARY);
/** Stands in for the page's own short-text selection; the filter takes it as a callback. */
const shortText = (row: SkillRow) => row.shortDescription ?? row.description;

describe("skill rows: keying", () => {
  it("gives two same-named skills under different plugins distinct keys (the React collision)", () => {
    const collided = rows.filter((row) => row.name === "shared-name");
    // The fixture is the regression: without it this test would pass on any library.
    expect(collided).toHaveLength(2);
    expect(collided.map((row) => row.plugin).sort()).toEqual(["alpha", "beta"]);
    // What the list used to key on.
    expect(new Set(collided.map((row) => row.name)).size).toBe(1);
    // What it keys on now: no two siblings in the whole list share a key.
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("keys on plugin and skill name, injectively over every name the library can send", () => {
    expect(skillRowKey("alpha", "shared-name")).toBe("alpha::shared-name");
    // The separator is unreachable in real input: a plugin name is PLUGIN_NAME_PATTERN
    // (`[A-Za-z0-9_-]+`, core/src/plugins) and a skill name is a directory name, so neither
    // can hold a colon. Injective over that domain, which is what makes the key unique.
    const names = ["a", "a-b", "a_b", "A1", "z9_x-Y", "shared-name", "long.name", "x"];
    const keys = names.flatMap((plugin) => names.map((skill) => skillRowKey(plugin, skill)));
    expect(new Set(keys).size).toBe(names.length * names.length);
  });

  it("every row carries the key its own plugin and name derive", () => {
    for (const row of rows) expect(row.key).toBe(skillRowKey(row.plugin, row.name));
  });
});

describe("skill rows: category", () => {
  it("carries the library group's real id, so the response's own groups are the taxonomy", () => {
    expect(rows.map((row) => row.groupId)).toEqual([
      "software-development",
      "software-development",
      "office-productivity",
      "office-productivity",
    ]);
    // The page's pills are built from the response's groups; every row must fall under one.
    const groupIds = new Set(LIBRARY.map((group) => group.id));
    for (const row of rows) expect(groupIds.has(row.groupId)).toBe(true);
  });

  it("filters by a real group id, and by none at all under the All pill", () => {
    expect(filterSkillRows(rows, ALL_GROUPS, "", shortText)).toHaveLength(4);
    const office = filterSkillRows(rows, "office-productivity", "", shortText);
    expect(office.map((row) => row.name).sort()).toEqual(["only-beta", "shared-name"]);
    expect(office.every((row) => row.groupId === "office-productivity")).toBe(true);
  });

  it("matches nothing on an id the server never sends (the invented bucket ids)", () => {
    // This is what the page did before: seven constants compared against a raw group id, of
    // which "general" is the only one that could ever have matched.
    for (const invented of ["engineering", "design", "qa", "science", "ops", "management"]) {
      expect(filterSkillRows(rows, invented, "", shortText)).toEqual([]);
    }
  });

  it("searches the skill name, its text, the plugin name and the category title", () => {
    expect(filterSkillRows(rows, ALL_GROUPS, "only-beta", shortText).map((r) => r.name)).toEqual([
      "only-beta",
    ]);
    // "alpha" is a plugin name, so it selects that plugin's whole skill set and nothing else.
    expect(
      filterSkillRows(rows, ALL_GROUPS, "alpha", shortText)
        .map((r) => r.key)
        .sort(),
    ).toEqual(["alpha::only-alpha", "alpha::shared-name"]);
    expect(filterSkillRows(rows, ALL_GROUPS, "Software Development", shortText)).toHaveLength(2);
    expect(filterSkillRows(rows, ALL_GROUPS, "办公效率", shortText)).toHaveLength(2);
    expect(filterSkillRows(rows, ALL_GROUPS, "  ", shortText)).toHaveLength(4);
  });

  it("labels a group in the UI language, falling back to English as the library does", () => {
    const group = { title: "Software Development", titleZh: "软件开发" };
    expect(groupLabel("en", group)).toBe("Software Development");
    expect(groupLabel("zh", group)).toBe("软件开发");
    expect(groupLabel("zh", { title: "Other" })).toBe("Other");
  });
});

describe("skill rows: instruction body", () => {
  const files: PluginFilesResponse = {
    files: {
      "skills/shared-name/SKILL.md":
        "---\nname: shared-name\ndescription: d\n---\n\nDo the thing.\n",
      "hooks/hooks.json": "{}",
    },
  };

  it("reads the skill's real SKILL.md out of its plugin's files, frontmatter stripped", () => {
    expect(skillBodyPath("shared-name")).toBe("skills/shared-name/SKILL.md");
    expect(skillBodyOf(files, "shared-name")).toBe("Do the thing.");
  });

  it("returns null when the plugin ships no SKILL.md for it, rather than any stand-in text", () => {
    expect(skillBodyOf(files, "not-in-this-plugin")).toBeNull();
    expect(skillBodyOf({ files: {} }, "shared-name")).toBeNull();
  });

  it("strips a BOM-bearing frontmatter block and keeps the body verbatim", () => {
    // Line endings are the file's own, not this function's to rewrite: it is a reader, and
    // markdown renders either.
    expect(stripSkillFrontmatter("﻿---\r\nname: a\r\n---\r\nBody\r\nline")).toBe("Body\r\nline");
    expect(stripSkillFrontmatter("No frontmatter here")).toBe("No frontmatter here");
  });
});

describe("skill rows: no invented fields", () => {
  it("carries only what the listing response has — no tools, no parameters, no body", () => {
    // GET /api/plugins sends skill metadata only. A field the response cannot fill is a
    // fabrication, so the row type does not have one to fill.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("allowedTools");
      expect(Object.keys(row)).not.toContain("parameters");
      expect(Object.keys(row)).not.toContain("content");
    }
  });

  it("falls back to the plugin's own description when the skill carries none", () => {
    const [row] = skillRows([
      {
        id: "other",
        title: "Other",
        plugins: [plugin("gamma", [{ ...skill("bare"), description: "" }])],
      },
    ]);
    expect(row?.description).toBe("gamma plugin");
  });
});
