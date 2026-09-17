import { useEffect, useState, useRef, useCallback } from "react";
import type { SessionContextResponse } from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useSessions } from "../../state/sessions";
import { ContextAllocationBar } from "./context-allocation-bar";
import { TopConsumersCard } from "./top-consumers-card";
import { CompactionAnchorsCard } from "./compaction-anchors-card";
import { Button } from "../../components/ui/button";
import { pageClass, mutedClass, selectClass, useInspectionCopy } from "./inspection-ui";

export interface ContextBreakdownPageProps {
  sessionId?: string;
  embedded?: boolean;
}

export function ContextBreakdownPage(props: ContextBreakdownPageProps) {
  const { currentProject } = useProject();
  const copy = useInspectionCopy();
  if (!currentProject)
    return (
      <p className={`p-4 ${mutedClass}`}>
        {copy("Select a project to inspect context.", "请选择项目以查看上下文。")}
      </p>
    );
  return <ContextSessionPicker key={currentProject.projectId} {...props} />;
}

function ContextSessionPicker({ sessionId, embedded = false }: ContextBreakdownPageProps) {
  const { sessions, loading } = useSessions();
  const copy = useInspectionCopy();
  const [selection, setSelection] = useState<string | null>(null);
  // Explicit embedded sessions are authoritative, even before the paginated list loads.
  const explicit = sessionId && sessionId !== "current-session" ? sessionId : null;
  const active =
    explicit ??
    (sessions.some((s) => s.sessionId === selection)
      ? selection
      : (sessions[0]?.sessionId ?? null));
  return (
    <section className={`${pageClass} ${embedded ? "p-4" : "p-6"}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{copy("Context usage", "上下文用量")}</h1>
          <p className={`mt-1 ${mutedClass}`}>
            {copy(
              "Measured request usage and estimated trace composition are shown separately.",
              "请求的实测用量与追踪记录的估算构成分别显示。",
            )}
          </p>
        </div>
        {!explicit && sessions.length > 0 && (
          <label className="flex min-w-0 flex-col gap-1">
            {copy("Session", "会话")}
            <select
              aria-label={copy("Session", "会话")}
              className={selectClass}
              value={active ?? ""}
              onChange={(e) => setSelection(e.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.title || s.sessionId}
                </option>
              ))}
            </select>
          </label>
        )}
        {explicit && <p className={`break-all ${mutedClass}`}>{explicit}</p>}
      </header>
      {active ? (
        <ContextSessionContent key={active} sessionId={active} />
      ) : (
        <p role="status" className={`py-8 ${mutedClass}`}>
          {loading
            ? copy("Loading sessions…", "正在加载会话…")
            : copy(
                "No sessions available. Start a conversation, then return here to inspect its context.",
                "暂无会话。开始对话后，可在此查看其上下文。",
              )}
        </p>
      )}
    </section>
  );
}

/** Keyed by session: neither a late read nor an old compaction can overwrite a new session. */
export function ContextSessionContent({ sessionId }: { sessionId: string }) {
  const copy = useInspectionCopy();
  const [data, setData] = useState<SessionContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const reading = useRef(false);
  const load = useCallback(
    async (background = false) => {
      if (background && reading.current) return;
      const request = ++generation.current;
      reading.current = true;
      if (!background) setLoading(true);
      setError(null);
      try {
        const result = await api.getSessionContext(sessionId);
        if (mounted.current && request === generation.current) setData(result);
      } catch (err) {
        if (mounted.current && request === generation.current) {
          setError(err instanceof Error ? err.message : String(err));
          setData(null);
        }
      } finally {
        if (mounted.current && request === generation.current) {
          reading.current = false;
          setLoading(false);
        }
      }
    },
    [sessionId],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load(true);
    }, 10_000);
    return () => {
      window.clearInterval(timer);
      mounted.current = false;
      reading.current = false;
      generation.current++;
    };
  }, [load]);
  const compact = async () => {
    if (compacting) return;
    setCompacting(true);
    setNotice(null);
    try {
      await api.postCompact(sessionId);
      if (mounted.current) {
        setNotice(
          copy(
            "Compaction requested. Refresh after the task finishes to see updated usage.",
            "已请求压缩。任务完成后请刷新用量。",
          ),
        );
      }
    } catch (err) {
      if (mounted.current) setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setCompacting(false);
    }
  };
  return (
    <div className="space-y-5" aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={loading} onClick={() => void load()}>
          {loading ? copy("Loading…", "加载中…") : copy("Refresh", "刷新")}
        </Button>
        <span className={mutedClass}>
          {data?.contextClosed
            ? copy("Snapshot before compaction", "压缩前快照")
            : copy("Latest recorded context", "最近记录的上下文")}
        </span>
      </div>
      {error ? (
        <div role="alert" className="space-y-2">
          <p>{copy("Could not load context.", "无法加载上下文。")}</p>
          <p className={mutedClass}>{error}</p>
          <Button onClick={() => void load()}>{copy("Try again", "重试")}</Button>
        </div>
      ) : loading && !data ? (
        <p role="status" className={`py-8 ${mutedClass}`}>
          {copy("Loading context usage…", "正在加载上下文用量…")}
        </p>
      ) : (
        data && (
          <>
            <ContextAllocationBar data={data} contextWindow={data.contextWindow} />
            <TopConsumersCard tools={data.topTools} files={data.topFiles} />
            <CompactionAnchorsCard
              onManualCompact={() => void compact()}
              compacting={compacting || loading}
            />
          </>
        )
      )}
      {notice && (
        <p role="status" className={mutedClass}>
          {notice}
        </p>
      )}
    </div>
  );
}
