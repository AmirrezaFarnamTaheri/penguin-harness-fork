import { useEffect, useState } from "react";
import { useProject } from "../../state/project";
import { MemoryTab } from "../agents/memory-tab";
import { MemoryGraphCanvas } from "./memory-graph-canvas";
import { MemoryRecallSimulator } from "./memory-recall-simulator";
import { filterMemoryTopics, type MemoryTopicNode, type MemoryScope } from "./memory-types";
import * as api from "../../api/endpoints";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  pageClass,
  mutedClass,
  rowButtonClass,
  selectedClass,
  selectClass,
  useInspectionCopy,
} from "../context/inspection-ui";

export function MemoryPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { currentProject, currentAgent, agents, setCurrentAgentId } = useProject();
  const copy = useInspectionCopy();
  const [view, setView] = useState("manage");
  return (
    <section className={`${pageClass} ${embedded ? "p-4" : "p-6"}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{copy("Memory", "记忆")}</h1>
          <p className={`mt-1 ${mutedClass}`}>
            {copy(
              "Manage saved memories or inspect their links and keyword matches.",
              "管理已保存的记忆，或检查链接与关键词匹配。",
            )}
          </p>
        </div>
        {agents.length > 0 && (
          <label className="flex min-w-0 flex-col gap-1">
            {copy("Agent", "智能体")}
            <select
              className={selectClass}
              value={currentAgent?.agentId ?? ""}
              onChange={(e) => setCurrentAgentId(e.target.value)}
            >
              <option value="" disabled>
                {copy("Select an agent", "选择智能体")}
              </option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name || agent.agentId}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {!currentProject || !currentAgent ? (
        <p role="status" className={`py-8 ${mutedClass}`}>
          {copy(
            "Select a project and agent to load saved memories.",
            "请选择项目和智能体以加载已保存的记忆。",
          )}
        </p>
      ) : (
        <>
          <nav className="flex flex-wrap gap-2" aria-label={copy("Memory views", "记忆视图")}>
            <Button
              aria-pressed={view === "manage"}
              variant={view === "manage" ? "primary" : "secondary"}
              onClick={() => setView("manage")}
            >
              {copy("Manage memories", "管理记忆")}
            </Button>
            <Button
              aria-pressed={view === "inspect"}
              variant={view === "inspect" ? "primary" : "secondary"}
              onClick={() => setView("inspect")}
            >
              {copy("Inspect & test recall", "检查与召回测试")}
            </Button>
          </nav>
          {view === "manage" ? (
            <MemoryTab
              key={`${currentProject.projectId}/${currentAgent.agentId}`}
              agentId={currentAgent.agentId}
            />
          ) : (
            <MemoryInspection
              key={`${currentProject.projectId}/${currentAgent.agentId}`}
              projectId={currentProject.projectId}
              agentId={currentAgent.agentId}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Inspection uses actual scope files. Mutations stay in the established owner-gated manager. */
export function MemoryInspection({ projectId, agentId }: { projectId: string; agentId: string }) {
  const copy = useInspectionCopy();
  const [topics, setTopics] = useState<MemoryTopicNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<MemoryScope>("all");
  const [view, setView] = useState("list");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const overview = await api.getMemoryOverview(projectId, agentId);
        const result: MemoryTopicNode[] = [];
        // Sequential file reads bound request pressure for large vaults; never silently skip failures.
        for (const memoryScope of overview.scopes) {
          if (!current) return;
          const listing = await api.getMemoryFiles(projectId, agentId, memoryScope.scopeKey);
          for (const file of listing.files) {
            if (!current) return;
            const document = await api.getMemoryFile(
              projectId,
              agentId,
              memoryScope.scopeKey,
              file.name,
            );
            result.push({
              id: `${memoryScope.scopeKey}/${file.name}`,
              scopeKey: memoryScope.scopeKey,
              name: file.name,
              title: file.title,
              scope: memoryScope.kind,
              bytes: file.size,
              tokens: Math.ceil(file.size / 4),
              tags: [],
              updatedAt: file.updatedAt ?? file.modifiedAt,
              content: document.content,
            });
          }
        }
        if (current) {
          setTopics(result);
          setSelected((id) => (result.some((topic) => topic.id === id) ? id : null));
        }
      } catch (err) {
        if (current) {
          setError(err instanceof Error ? err.message : String(err));
          setTopics([]);
        }
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [projectId, agentId, revision]);
  const filtered = filterMemoryTopics(topics, search, scope);
  const document = topics.find((topic) => topic.id === selected);
  const selectTopic = (id: string) => {
    setSelected(id);
  };
  return (
    <div className="space-y-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          {loading ? copy("Loading…", "加载中…") : copy("Refresh files", "刷新文件")}
        </Button>
        <p className={mutedClass}>
          {copy(
            "Read-only snapshot. Edit, add, delete, import and export in Manage memories.",
            "只读快照。编辑、新建、删除及导入导出请使用“管理记忆”。",
          )}
        </p>
      </div>
      {error ? (
        <div role="alert" className="space-y-2">
          <p>
            {copy(
              "Could not load all memory files; no partial index is shown.",
              "无法加载全部记忆文件，未显示不完整索引。",
            )}
          </p>
          <p className={mutedClass}>{error}</p>
          <Button onClick={() => setRevision((value) => value + 1)}>
            {copy("Try again", "重试")}
          </Button>
        </div>
      ) : loading ? (
        <p role="status" className={`py-8 ${mutedClass}`}>
          {copy("Reading saved memory files…", "正在读取已保存的记忆文件…")}
        </p>
      ) : !topics.length ? (
        <p role="status" className={`py-8 ${mutedClass}`}>
          {copy(
            "No saved memory topics. Add or import memories in Manage memories.",
            "暂无已保存的记忆。请在“管理记忆”中添加或导入。",
          )}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <Input
              aria-label={copy("Search memory topics", "搜索记忆主题")}
              placeholder={copy("Search titles and filenames", "搜索标题与文件名")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label={copy("Memory scope", "记忆范围")}
              className={selectClass}
              value={scope}
              onChange={(e) => setScope(e.target.value as MemoryScope)}
            >
              <option value="all">{copy("All scopes", "所有范围")}</option>
              <option value="user">{copy("User", "用户")}</option>
              <option value="workspace">{copy("Workspace", "工作区")}</option>
            </select>
            {[
              ["list", copy("Topics", "主题")],
              ["graph", copy("Links", "链接")],
              ["recall", copy("Recall test", "召回测试")],
            ].map(([value, label]) => (
              <Button
                key={value}
                aria-pressed={view === value}
                variant={view === value ? "primary" : "secondary"}
                onClick={() => setView(value!)}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
            <div className="min-w-0">
              {view === "recall" ? (
                <MemoryRecallSimulator
                  topics={filtered}
                  selectedTopicId={selected}
                  onSelectTopic={selectTopic}
                />
              ) : view === "graph" ? (
                <MemoryGraphCanvas
                  topics={filtered}
                  selectedTopicId={selected}
                  onSelectTopic={selectTopic}
                />
              ) : !filtered.length ? (
                <p className={`py-6 ${mutedClass}`}>
                  {copy(
                    "No matching topics. Clear your search or choose another scope.",
                    "没有匹配主题。请清除搜索或选择其他范围。",
                  )}
                </p>
              ) : (
                <ul className="max-h-[36rem] overflow-y-auto">
                  {filtered.map((topic) => (
                    <li key={topic.id}>
                      <button
                        type="button"
                        aria-pressed={selected === topic.id}
                        className={`${rowButtonClass} ${selected === topic.id ? selectedClass : ""}`}
                        onClick={() => selectTopic(topic.id)}
                      >
                        <span className="block break-words font-semibold">{topic.title}</span>
                        <span className={`mt-1 block break-all ${mutedClass}`}>
                          {topic.scopeKey} / {topic.name} · {topic.bytes.toLocaleString()} B
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <section className="min-w-0 space-y-3">
              <h2 className="break-all text-base font-semibold">
                {document?.title ?? copy("Document", "文档")}
              </h2>
              {document ? (
                <>
                  <p className={`break-all ${mutedClass}`}>
                    {document.scopeKey} / {document.name}
                  </p>
                  <pre className="max-h-[36rem] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 p-4 font-mono text-sm dark:border-gray-800">
                    {document.content}
                  </pre>
                </>
              ) : (
                <p className={mutedClass}>
                  {copy(
                    "Select a topic to read its saved content.",
                    "选择主题以阅读已保存的内容。",
                  )}
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
