/**
 * The Skills page's data layer, kept free of React so it can be tested directly: projecting the
 * plugin library onto skill rows, deriving the row key, filtering, and reading a skill's real
 * SKILL.md out of a plugin's file response.
 *
 * Everything here is a projection of what the server actually sends. GET /api/plugins returns
 * groups → plugins → skill *metadata* only — the endpoint's own comment says so, and it is why
 * this module holds no `allowedTools`, no `parameters` and no `content` field. Those three were
 * the page's invented data: the catalog endpoint has no such concept, so any value for them
 * would be a fabrication the reader would take for a fact about the skill. Skill BODIES do
 * exist, one endpoint over (GET /api/plugins/:plugin/files); {@link skillBodyPath} and
 * {@link skillBodyOf} read them from there, on demand, for the one skill the reader selected.
 */
import type { PluginFilesResponse, PluginGroupItem } from "@prismshadow/penguin-server/api";

/**
 * One skill in the page's list: the skill's own metadata plus the plugin and category it was
 * found under, which is what the list row shows alongside it.
 */
export interface SkillRow {
  /**
   * List key. `plugin` + `skill` joined by a separator neither name can contain: a plugin name
   * is `PLUGIN_NAME_PATTERN`-constrained and a skill name is a directory name, so the pair is
   * unique in a library — which the skill name alone is NOT. Nothing stops two plugins from
   * shipping a skill of the same name (each plugin's skills are its own directories under its
   * own tree), and keying the list on the name alone made React throw "Encountered two children
   * with the same key" on any library holding two.
   */
  key: string;
  /** Owning plugin's name — the identity the files endpoint is addressed by. */
  plugin: string;
  /** The library category's id, verbatim from the group (e.g. `software-development`). */
  groupId: string;
  /** The category's English title; the pill and the row badge show the localized one. */
  groupTitle: string;
  groupTitleZh?: string;
  /** Owning plugin's full description, used when the skill itself carries none. */
  pluginDescription: string;
  pluginDescriptionZh?: string;
  /** Skill directory name — also the slash command. */
  name: string;
  description: string;
  shortDescription?: string;
  shortDescriptionZh?: string;
  /** `YYYY.MM.DD.N`, or "" when the frontmatter carries none. */
  version: string;
}

/** The row key: the owning plugin and the skill name, which together identify one skill. */
export function skillRowKey(plugin: string, skill: string): string {
  return `${plugin}::${skill}`;
}

/**
 * The library as one flat list of skill rows, in the order the server groups them.
 *
 * The category is the group's REAL id rather than a page-local taxonomy: the previous version
 * put a seven-bucket constant on `category` while filling it with `g.id`, and no id the server
 * sends is one of those seven, so every category pill but "All" filtered to an empty list and
 * every badge fell through to the same gray. There is no taxonomy to map onto — the groups ARE
 * the taxonomy — so the pills on the page are built from these groups directly and a category
 * added to the library needs no edit here.
 */
export function skillRows(groups: readonly PluginGroupItem[]): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const group of groups) {
    for (const plugin of group.plugins) {
      for (const skill of plugin.skills) {
        rows.push({
          key: skillRowKey(plugin.name, skill.name),
          plugin: plugin.name,
          groupId: group.id,
          groupTitle: group.title,
          ...(group.titleZh !== undefined ? { groupTitleZh: group.titleZh } : {}),
          pluginDescription: plugin.description,
          ...(plugin.descriptionZh !== undefined
            ? { pluginDescriptionZh: plugin.descriptionZh }
            : {}),
          name: skill.name,
          description: skill.description || plugin.description,
          ...(skill.shortDescription !== undefined
            ? { shortDescription: skill.shortDescription }
            : {}),
          ...(skill.shortDescriptionZh !== undefined
            ? { shortDescriptionZh: skill.shortDescriptionZh }
            : {}),
          version: skill.version,
        });
      }
    }
  }
  return rows;
}

/**
 * The rows a category pill and the search box leave visible. `groupId` is matched against the
 * real group id; `query` against the skill's name, its localized short text, the plugin's and
 * the category's — so typing a category's title narrows to it the way the pills do.
 */
export function filterSkillRows(
  rows: readonly SkillRow[],
  groupId: string,
  query: string,
  localized: (row: SkillRow) => string,
): SkillRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (groupId !== ALL_GROUPS && row.groupId !== groupId) return false;
    if (!q) return true;
    return (
      row.name.toLowerCase().includes(q) ||
      localized(row).toLowerCase().includes(q) ||
      row.plugin.toLowerCase().includes(q) ||
      row.groupTitle.toLowerCase().includes(q) ||
      (row.groupTitleZh ?? "").toLowerCase().includes(q)
    );
  });
}

/** The pill that means "no category filter"; any real group id selects instead. */
export const ALL_GROUPS = "all";

/** A group's display title for the UI language (falls back to English, as the library does). */
export function groupLabel(
  locale: "zh" | "en",
  group: { title: string; titleZh?: string },
): string {
  return locale === "zh" && group.titleZh ? group.titleZh : group.title;
}

/** The path a plugin's files response carries one skill's SKILL.md under. */
export function skillBodyPath(skill: string): string {
  return `skills/${skill}/SKILL.md`;
}

/**
 * A skill's instruction body out of a plugin's file response, frontmatter stripped — or null
 * when that response carries no such file (a plugin whose skill ships no SKILL.md, or a
 * response for a different plugin). Callers must treat null as "there is no body to show"
 * rather than substituting text of their own.
 */
export function skillBodyOf(files: PluginFilesResponse, skill: string): string | null {
  const content = files.files[skillBodyPath(skill)];
  if (content === undefined) return null;
  return stripSkillFrontmatter(content);
}

/** SKILL.md opens with YAML frontmatter the parser already surfaced as metadata; a reader wants the body. */
export function stripSkillFrontmatter(content: string): string {
  return content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
