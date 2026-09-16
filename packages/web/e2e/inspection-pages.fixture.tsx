import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider, useLocale } from "../src/state/locale";
import { ContextSessionContent } from "../src/features/context/context-breakdown-page";
import { ProjectTopology } from "../src/features/topology/topology-page";
import { MemoryInspection } from "../src/features/memory/memory-page";

function Fixture() {
  const [surface, setSurface] = useState("context");
  const [scope, setScope] = useState("alpha");
  const { setLang } = useLocale();
  return (
    <main className="mx-auto max-w-6xl p-4 bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <nav className="mb-4 flex flex-wrap gap-4">
        {["context", "topology", "memory"].map((view) => (
          <button key={view} onClick={() => setSurface(view)}>
            Open {view}
          </button>
        ))}
        <button onClick={() => setScope("alpha")}>Select alpha</button>
        <button onClick={() => setScope("beta")}>Select beta</button>
        <button onClick={() => setLang("zh")}>Chinese</button>
        <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      </nav>
      {surface === "context" ? (
        <ContextSessionContent key={scope} sessionId={scope} />
      ) : surface === "topology" ? (
        <ProjectTopology key={scope} projectId={scope} />
      ) : (
        <MemoryInspection key={scope} projectId={scope} agentId="agent" />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <Fixture />
  </LocaleProvider>,
);
