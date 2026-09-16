import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Modal } from "../../components/ui/modal";
import { bodyWithoutFrontmatter } from "../../lib/frontmatter";
import {
  WorkTool,
  WorkHeader,
  WorkError,
  fieldClass,
  panelClass,
  mutedClass,
} from "../kanban/work-tool-ui";

type Tab = "document" | "links" | "path" | "checks";
type Page = Awaited<ReturnType<typeof api.getWikiNode>>["node"];
type Lint = Awaited<ReturnType<typeof api.lintWikiGraph>>;
export function WikiPage() {
  useDocumentTitle(S.nav.wiki);
  const { currentProject } = useProject();
  return currentProject ? (
    <WikiWorkspace key={currentProject.projectId} projectId={currentProject.projectId} />
  ) : (
    <WorkTool>
      <p>Select a project to view its wiki.</p>
    </WorkTool>
  );
}
export function WikiWorkspace({ projectId }: { projectId: string }) {
  const [pages, setPages] = useState<api.WikiPageItem[]>([]);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<string[] | null>(null);
  const [tab, setTab] = useState<Tab>("document");
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [neighbors, setNeighbors] = useState<string[]>([]);
  const [linksError, setLinksError] = useState("");
  const [target, setTarget] = useState("");
  const [path, setPath] = useState<string[] | null | undefined>();
  const [lint, setLint] = useState<Lint | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("concept");
  const [newTags, setNewTags] = useState("");
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const listGeneration = useRef(0);
  const pageGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const dirty = editing && draft !== page?.content;
  const load = useCallback(async () => {
    const ticket = ++listGeneration.current;
    setLoading(true);
    setError("");
    try {
      const response = await api.listWikiNodes(projectId);
      if (ticket !== listGeneration.current) return;
      if (!Array.isArray(response?.nodes)) throw new Error("The server did not return wiki pages.");
      setPages(response.nodes);
      setSelected((previous) =>
        response.nodes?.some((n) => n.id === previous) ? previous : (response.nodes?.[0]?.id ?? ""),
      );
    } catch (err) {
      if (ticket === listGeneration.current) setError(message(err));
    } finally {
      if (ticket === listGeneration.current) setLoading(false);
    }
  }, [projectId]);
  useEffect(() => {
    void load();
    return () => {
      listGeneration.current++;
    };
  }, [load]);
  useEffect(() => {
    const ticket = ++pageGeneration.current;
    setPage(null);
    setDraft("");
    setEditing(false);
    setPageError("");
    setLinksError("");
    setNeighbors([]);
    setPath(undefined);
    setTarget("");
    if (!selected) {
      setPageLoading(false);
      return;
    }
    setPageLoading(true);
    void api
      .getWikiNode(projectId, selected)
      .then((response) => {
        if (ticket !== pageGeneration.current) return;
        if (!response?.node || typeof response.node.content !== "string")
          throw new Error("The server did not return this document.");
        setPage(response.node);
        setDraft(response.node.content);
      })
      .catch((err) => {
        if (ticket === pageGeneration.current) setPageError(message(err));
      })
      .finally(() => {
        if (ticket === pageGeneration.current) setPageLoading(false);
      });
    void api
      .getWikiNeighbors(projectId, selected)
      .then((response) => {
        if (ticket === pageGeneration.current) setNeighbors(response.neighbors);
      })
      .catch((err) => {
        if (ticket === pageGeneration.current) setLinksError(message(err));
      });
    return () => {
      pageGeneration.current++;
    };
  }, [projectId, selected]);
  useEffect(() => {
    const ticket = ++searchGeneration.current;
    if (!query.trim()) {
      setMatches(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void api
        .listWikiNodes(projectId, query.trim())
        .then((response) => {
          if (ticket === searchGeneration.current)
            setMatches(response.matches?.map((match) => match.id) ?? []);
        })
        .catch((err) => {
          if (ticket === searchGeneration.current) setError(message(err));
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      searchGeneration.current++;
    };
  }, [projectId, query]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function select(id: string) {
    if (busy || id === selected) return;
    if (dirty) setPendingSelection(id);
    else setSelected(id);
  }
  async function save() {
    if (!page || busy || !draft.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.createWikiNode(projectId, { id: page.id, content: draft, filePath: page.filePath });
      setPage({ ...page, content: draft });
      setEditing(false);
      setLint(null);
      try {
        const response = await api.getWikiNeighbors(projectId, page.id);
        setNeighbors(response.neighbors);
        setLinksError("");
      } catch (err) {
        setLinksError(message(err));
      }
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const id = newId.trim();
    if (pages.some((p) => p.id === id)) {
      setError("A page with this ID already exists. Choose a different ID to avoid replacing it.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const content = `---\ntitle: ${JSON.stringify(newTitle.trim())}\ntype: ${newType}\ntags: ${JSON.stringify(
        newTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      )}\n---\n\n# ${newTitle.trim()}\n`;
      await api.createWikiNode(projectId, { id, content });
      setNewOpen(false);
      setNewId("");
      setNewTitle("");
      setNewTags("");
      setLint(null);
      await load();
      setSelected(id);
      setTab("document");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function findPath() {
    if (!selected || !target || busy) return;
    setBusy(true);
    setError("");
    setPath(undefined);
    try {
      const response = await api.getWikiPath(projectId, selected, target);
      setPath(response.path);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function checkLinks() {
    if (busy) return;
    setBusy(true);
    setError("");
    setLint(null);
    try {
      setLint(await api.lintWikiGraph(projectId));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const visiblePages = matches === null ? pages : pages.filter((p) => matches.includes(p.id));
  return (
    <WorkTool>
      <WorkHeader
        title="Project wiki"
        description="Write project notes, follow linked pages, and find missing references. This wiki contains saved documents, not a live code-symbol index."
      >
        <Button
          className="min-h-10"
          disabled={loading || busy || dirty}
          onClick={() => void load()}
        >
          Refresh list
        </Button>
        <Button
          className="min-h-10"
          variant="primary"
          disabled={busy || dirty}
          onClick={() => {
            setError("");
            setNewOpen(true);
          }}
        >
          New page
        </Button>
      </WorkHeader>
      {!newOpen && <WorkError error={error} />}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-label="Wiki pages" className="min-w-0 space-y-3">
          <label className="block font-medium">
            Search pages
            <input
              className={`${fieldClass} mt-2`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles and content"
            />
          </label>
          <p className={mutedClass}>{visiblePages.length} pages</p>
          {loading && (
            <p role="status" className={mutedClass}>
              Loading pages…
            </p>
          )}
          <div className="max-h-80 overflow-y-auto space-y-1 lg:max-h-[65vh]">
            {visiblePages.map((p) => (
              <button
                key={p.id}
                disabled={busy}
                aria-pressed={p.id === selected}
                onClick={() => select(p.id)}
                className={`min-h-11 w-full rounded-md border px-3 py-2 text-left break-words ${p.id === selected ? "border-gray-300 bg-gray-100 dark:border-gray-700 dark:bg-gray-800" : "border-transparent hover:bg-gray-50 dark:hover:bg-gray-900"}`}
              >
                {p.id}
              </button>
            ))}
          </div>
          {!loading && !visiblePages.length && !error && (
            <p className={mutedClass}>
              {pages.length
                ? "No matching pages."
                : "No pages yet. Create a page to start documenting this project."}
            </p>
          )}
        </aside>
        <section className="min-w-0 space-y-5">
          <nav
            aria-label="Wiki views"
            className="flex flex-wrap gap-1 border-b border-gray-200 pb-2 dark:border-gray-800"
          >
            {(
              [
                { id: "document", label: "Document" },
                { id: "links", label: "Linked pages" },
                { id: "path", label: "Find a path" },
                { id: "checks", label: "Link checks" },
              ] as const
            ).map((item) => (
              <Button
                key={item.id}
                className="min-h-10"
                variant={tab === item.id ? "secondary" : "ghost"}
                aria-pressed={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
          {tab !== "checks" && <WorkError error={pageError} />}
          {tab !== "checks" && pageLoading && (
            <p role="status" className={mutedClass}>
              Loading document…
            </p>
          )}
          {tab === "document" && page && (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-semibold break-words">{page.id}</h2>
                  <p className={mutedClass}>
                    {editing ? "Editing Markdown · changes are not saved yet" : "Saved document"}
                  </p>
                </div>
                <div className="flex gap-2">
                  {editing ? (
                    <>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setEditing(false);
                          setDraft(page.content);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        disabled={busy || !draft.trim()}
                        onClick={() => void save()}
                      >
                        {busy ? "Saving…" : "Save page"}
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => setEditing(true)}>Edit page</Button>
                  )}
                </div>
              </div>
              {editing ? (
                <label className="block">
                  Markdown content
                  <textarea
                    className={`${fieldClass} mt-2 min-h-80 font-mono leading-7`}
                    rows={18}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <span className={`mt-2 block ${mutedClass}`}>
                    Use [[page-id]] to connect pages. Metadata stays in the frontmatter at the top.
                  </span>
                </label>
              ) : (
                <article className="max-w-3xl break-words leading-7 [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:my-4 [&_h2]:text-xl [&_h2]:font-semibold [&_p]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-gray-100 [&_pre]:p-4 dark:[&_pre]:bg-gray-900 [&_a]:text-brand-600 [&_a]:underline">
                  <Markdown>{bodyWithoutFrontmatter(page.content)}</Markdown>
                </article>
              )}
            </>
          )}
          {tab === "links" && selected && (
            <section className="space-y-4">
              <h2 className="text-xl font-semibold">Pages connected to {selected}</h2>
              <WorkError error={linksError} />
              <ul className="space-y-2">
                {neighbors.map((id) => (
                  <li key={id}>
                    <button
                      className="min-h-10 text-left text-brand-600 underline break-all"
                      disabled={busy}
                      onClick={() => select(id)}
                    >
                      {id}
                    </button>
                    {!pages.some((p) => p.id === id) && (
                      <span className={mutedClass}> · Page not found in this project</span>
                    )}
                  </li>
                ))}
              </ul>
              {!neighbors.length && !linksError && !pageLoading && (
                <p className={mutedClass}>
                  No connected pages. Add [[page-id]] links in the document.
                </p>
              )}
            </section>
          )}
          {tab === "path" && selected && (
            <section className="space-y-4">
              <h2 className="text-xl font-semibold">Find a connection</h2>
              <p className={mutedClass}>
                Find the shortest link path from {selected} to another page.
              </p>
              <label className="block max-w-lg">
                Destination
                <select
                  className={`${fieldClass} mt-2`}
                  value={target}
                  disabled={busy}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setPath(undefined);
                  }}
                >
                  <option value="">Choose a page</option>
                  {pages
                    .filter((p) => p.id !== selected)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                className="min-h-10"
                disabled={!target || busy}
                onClick={() => void findPath()}
              >
                {busy ? "Finding…" : "Find path"}
              </Button>
              {path === null && (
                <p role="status" className={mutedClass}>
                  No path connects these pages.
                </p>
              )}
              {path && (
                <div className={panelClass}>
                  <h3 className="font-semibold">{Math.max(0, path.length - 1)} hops</h3>
                  <ol className="mt-3 space-y-2">
                    {path.map((id) => (
                      <li key={id}>
                        <button
                          className="min-h-10 text-brand-600 underline break-all"
                          onClick={() => select(id)}
                        >
                          {id}
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          )}
          {tab === "checks" && (
            <section className="space-y-4">
              <h2 className="text-xl font-semibold">Check wiki links</h2>
              <p className={mutedClass}>
                Find links to missing pages and pages without connections. This checks references,
                not the accuracy of the content.
              </p>
              <Button
                className="min-h-10"
                disabled={busy || loading}
                onClick={() => void checkLinks()}
              >
                {busy ? "Checking…" : "Run link checks"}
              </Button>
              {lint && (
                <div className="space-y-5">
                  <section>
                    <h3 className="font-semibold">Broken links ({lint.brokenLinks.length})</h3>
                    {!lint.brokenLinks.length && (
                      <p className={mutedClass}>No broken links found.</p>
                    )}
                    <ul className="mt-2 space-y-2">
                      {lint.brokenLinks.map((link, i) => (
                        <li key={`${link.from}:${link.to}:${i}`} className={panelClass}>
                          <button
                            className="min-h-10 text-brand-600 underline break-all"
                            onClick={() => {
                              select(link.from);
                              setTab("document");
                            }}
                          >
                            {link.from}
                          </button>
                          <p className={mutedClass}>Missing page: {link.to}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h3 className="font-semibold">
                      Pages without connections ({lint.orphanNodes.length})
                    </h3>
                    <ul className="mt-2 space-y-2">
                      {lint.orphanNodes.map((id) => (
                        <li key={id}>
                          <button
                            className="min-h-10 text-brand-600 underline break-all"
                            onClick={() => {
                              select(id);
                              setTab("document");
                            }}
                          >
                            {id}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {!lint.orphanNodes.length && (
                      <p className={mutedClass}>No unconnected pages found.</p>
                    )}
                  </section>
                </div>
              )}
            </section>
          )}
          {tab !== "checks" && !selected && !loading && (
            <p className={mutedClass}>Choose a page or create a new document.</p>
          )}
        </section>
      </div>
      <Modal
        open={newOpen}
        onClose={() => {
          if (!busy) setNewOpen(false);
        }}
        title="New wiki page"
      >
        <form className="space-y-4 text-sm" onSubmit={create}>
          <WorkError error={error} />
          <label className="block">
            Page ID
            <input
              required
              maxLength={300}
              className={`${fieldClass} mt-1`}
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="release-process"
            />
          </label>
          <p className={mutedClass}>
            Use this ID in [[wikilinks]]. It must be unique in this project.
          </p>
          <label className="block">
            Title
            <input
              required
              className={`${fieldClass} mt-1`}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </label>
          <label className="block">
            Document type
            <select
              className={`${fieldClass} mt-1`}
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
            >
              <option value="concept">Concept</option>
              <option value="entity">Entity</option>
              <option value="source">Source</option>
              <option value="synthesis">Synthesis</option>
            </select>
          </label>
          <label className="block">
            Tags (comma separated)
            <input
              className={`${fieldClass} mt-1`}
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
            />
          </label>
          <p className={mutedClass}>Title, type, and tags are saved as Markdown frontmatter.</p>
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !newId.trim() || !newTitle.trim()}
            >
              Create page
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={pendingSelection !== null}
        onClose={() => setPendingSelection(null)}
        title="Unsaved changes"
      >
        <p className={mutedClass}>Switching pages will discard your unsaved edits.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setPendingSelection(null)}>Keep editing</Button>
          <Button
            onClick={() => {
              if (pendingSelection !== null) setSelected(pendingSelection);
              setPendingSelection(null);
            }}
          >
            Discard edits and switch
          </Button>
        </div>
      </Modal>
    </WorkTool>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "Request failed. Please try again.";
}
