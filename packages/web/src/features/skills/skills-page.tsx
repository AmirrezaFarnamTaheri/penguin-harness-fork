/**
 * Skills Hub — every skill in the built-in plugin library, in one searchable list, with the
 * selected skill's real instruction body beside it.
 *
 * The list is a flat projection of GET /api/plugins (groups → plugins → skill metadata); the
 * data layer, the row key and the filter live in skill-catalog.ts, which is where the shape of
 * that response is reconciled with what this page shows.
 *
 * Two things this page deliberately does NOT show, because the library listing carries no such
 * data: a skill's allowed tools and a skill's parameters. There are no panels for either, rather
 * than panels behind an `if` that can never pass — a control that can never render reads as a
 * capability the page has and does not.
 *
 * The instruction body is the real SKILL.md, fetched on demand for the selected skill's plugin
 * from GET /api/plugins/:plugin/files. It used to be a string this page assembled out of the
 * skill's name and description and then labelled "Instruction Body (SKILL.md)" — a document the
 * reader would reasonably take as the skill's instructions, containing none. When that request
 * fails, or the plugin ships no SKILL.md for the skill, the panel says so; it never substitutes
 * text of its own.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../../api/endpoints";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { apiErrorText } from "../../lib/api-error";
import { useLocale } from "../../state/locale";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { CopyButton } from "../../components/ui/copy-button";
import { SkeletonList } from "../../components/ui/skeleton";
import { Md } from "../chat/md";
import { localizedShortText, localizedText } from "../chat/skill-use";
import {
  ALL_GROUPS,
  filterSkillRows,
  groupLabel,
  skillBodyOf,
  skillRows,
  type SkillRow,
} from "./skill-catalog";
import type { PluginFilesResponse, PluginGroupItem } from "@prismshadow/penguin-server/api";

export function SkillsPage() {
  useDocumentTitle(S.nav.skills);
  const { locale } = useLocale();

  const [groups, setGroups] = useState<PluginGroupItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Selected row KEY, not its name: names repeat across plugins, so a name selects the wrong row. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string>(ALL_GROUPS);
  const [query, setQuery] = useState("");

  // Library list: readable once logged in, fetched on entry and on Refresh. Kept out of the
  // effect's dependency list on purpose — the previous version rebuilt the fetcher whenever the
  // selection changed, so every click on a row refetched the whole library.
  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    setGroups(null);
    api
      .getPluginLibrary()
      .then((res) => {
        if (!cancelled) setGroups(res.groups);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(load, [load]);

  const rows = useMemo(() => skillRows(groups ?? []), [groups]);
  const selected = useMemo(
    () => rows.find((row) => row.key === selectedKey) ?? null,
    [rows, selectedKey],
  );
  const visible = useMemo(
    () => filterSkillRows(rows, groupId, query, (row) => localizedShortText(locale, row)),
    [rows, groupId, query, locale],
  );

  return (
    <div className="flex h-full w-full flex-col font-sans">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold">{S.skills.hub.title}</h1>
            {rows.length > 0 && <Badge>{S.skills.hub.loadedCount(rows.length)}</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{S.skills.hub.subtitle}</p>
        </div>
        {/* load returns a cleanup for the mount effect; an onClick return value is ignored. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void load()}
          disabled={groups === null}
        >
          {S.skills.hub.refresh}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-gray-200 dark:border-gray-800">
          <div className="space-y-2 border-b border-gray-200 p-3 dark:border-gray-800">
            <input
              type="text"
              // No count in the placeholder. It used to read "Search 2,400+ skills by name,
              // tag, or role…" — a hardcoded marketing number with nothing behind it, on a
              // page that lists whatever the built-in library actually holds. A search box that
              // promises a size it cannot know is the invented-metric tell in its purest
              // form, and it is the one place a reader would most expect the number to be
              // true. The real count is in the badge above, taken from the list itself.
              placeholder={S.skills.hub.searchPlaceholder}
              aria-label={S.skills.hub.searchLabel}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-900 placeholder:text-gray-500 focus:border-[var(--accent-bg)] focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
            {/* The pills are the library's OWN groups, in the order the server sends them. The
                seven hardcoded buckets this replaces shared no id with anything the server
                sends, so every one of them but "All" filtered to an empty list. Reading the
                taxonomy off the response means a category added to the library shows up here
                on its own. */}
            {groups !== null && groups.length > 0 && (
              <div className="flex flex-wrap gap-1 text-[11px]">
                <CategoryPill
                  label={S.skills.hub.allCategories}
                  active={groupId === ALL_GROUPS}
                  onClick={() => setGroupId(ALL_GROUPS)}
                />
                {groups.map((group) => (
                  <CategoryPill
                    key={group.id}
                    label={groupLabel(locale, group)}
                    active={groupId === group.id}
                    onClick={() => setGroupId(group.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {groups === null ? (
              error ? null : (
                <SkeletonList rows={8} />
              )
            ) : (
              <>
                {visible.map((row) => (
                  <SkillListRow
                    key={row.key}
                    row={row}
                    active={row.key === selectedKey}
                    onClick={() => setSelectedKey(row.key)}
                  />
                ))}
                {visible.length === 0 && (
                  <p className="py-12 text-center text-xs text-gray-500">
                    {rows.length === 0 ? S.skills.hub.noSkills : S.skills.hub.noMatches}
                  </p>
                )}
              </>
            )}
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <SkillInspector row={selected} />
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                {S.common.retry}
              </Button>
            </div>
          ) : groups === null ? null : (
            <p className="flex h-full items-center justify-center text-xs text-gray-500">
              {rows.length === 0 ? S.skills.hub.noSkills : S.skills.hub.selectHint}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function CategoryPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 font-medium whitespace-nowrap transition-colors ${
        active
          ? "bg-[var(--accent-bg)] text-[var(--accent-fg)]"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
      }`}
    >
      {label}
    </button>
  );
}

function SkillListRow({
  row,
  active,
  onClick,
}: {
  row: SkillRow;
  active: boolean;
  onClick: () => void;
}) {
  const { locale } = useLocale();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`mb-1 w-full rounded-md border p-2.5 text-left transition-colors ${
        active
          ? "border-[var(--accent-bg)] bg-[var(--accent-bg)]/[0.05]"
          : "border-transparent hover:bg-gray-100 dark:hover:bg-gray-800/60"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-xs font-semibold">{row.name}</span>
        {/* The category's real title, not its id: an id is an identifier ("office-productivity"),
            and a pill of identifiers is a row nobody reads. */}
        <span className="shrink-0 text-[10px] text-gray-500 dark:text-gray-400">
          {localizedText(locale, row.groupTitle, row.groupTitleZh)}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">
        {localizedShortText(locale, row)}
      </p>
      {/* The owning plugin. It is also what tells two same-named skills apart in the list. */}
      <p className="mt-1 truncate font-mono text-[10px] text-gray-500 dark:text-gray-400">
        {row.plugin}
      </p>
    </button>
  );
}

function SkillInspector({ row }: { row: SkillRow }) {
  const { locale } = useLocale();
  return (
    <div className="max-w-3xl space-y-6 p-8">
      <div className="border-b border-gray-200 pb-5 dark:border-gray-800">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-mono text-2xl font-bold">{row.name}</h2>
            {/* The skill's own description; the library carries no Chinese variant of it
                (only short_description_zh), so this line is English in both languages. */}
            <p className="mt-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
              {row.description}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Badge>{localizedText(locale, row.groupTitle, row.groupTitleZh)}</Badge>
            {row.version !== "" && <Badge tone="gray">v{row.version}</Badge>}
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {S.skills.hub.shippedBy(row.plugin)}
        </p>
      </div>

      <SkillInvocation row={row} />
      <SkillBodyPanel row={row} />
    </div>
  );
}

/**
 * The skill's slash command. `/<skill_name>` is the app's real form for addressing a skill
 * (features/chat/skill-use.ts builds the same string for the composer's slash menu); what this
 * panel no longer does is append `key="value"` pairs from a parameter list the library listing
 * never carried, which is why that half of it was dead code.
 */
function SkillInvocation({ row }: { row: SkillRow }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wider text-gray-500 uppercase">
          {S.skills.hub.invocationTitle}
        </h3>
        <CopyButton text={`/${row.name}`} label={S.skills.hub.copyInvocation} />
      </div>
      <p className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 font-mono text-xs text-gray-900 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100">
        /{row.name}
      </p>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {S.skills.hub.invocationNeedsInstall}
      </p>
    </section>
  );
}

/**
 * The selected skill's real SKILL.md, read from its plugin's file response.
 *
 * The request is keyed on the PLUGIN, not the skill, so moving between two skills of the same
 * plugin re-reads nothing. All three failure shapes are stated rather than papered over: the
 * request failed, the response carried no SKILL.md for this skill, or the body is on its way.
 */
function SkillBodyPanel({ row }: { row: SkillRow }) {
  const [files, setFiles] = useState<PluginFilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError(null);
    api
      .getPluginFiles(row.plugin)
      .then((res) => {
        if (!cancelled) setFiles(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [row.plugin, nonce]);

  const body = files === null ? null : skillBodyOf(files, row.name);

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold tracking-wider text-gray-500 uppercase">
        {S.skills.hub.bodyTitle}
      </h3>
      {error ? (
        <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => setNonce((n) => n + 1)}>
            {S.common.retry}
          </Button>
        </div>
      ) : body === null ? (
        <div className="rounded-md border border-gray-200 p-6 text-center dark:border-gray-800">
          {files === null ? (
            <SkeletonList rows={4} />
          ) : (
            <p className="text-xs text-gray-500">
              {S.skills.hub.bodyMissing(row.plugin, row.name)}
            </p>
          )}
        </div>
      ) : (
        <div className="md-body max-h-96 overflow-y-auto rounded-md border border-gray-200 p-4 text-sm text-gray-800 dark:border-gray-800 dark:text-gray-100">
          <Md text={body} />
        </div>
      )}
    </section>
  );
}
