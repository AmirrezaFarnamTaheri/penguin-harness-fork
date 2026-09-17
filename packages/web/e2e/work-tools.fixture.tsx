import { useState, useSyncExternalStore } from "react";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
setActiveStrings(en);
import { createRoot } from "react-dom/client";
import { KanbanWorkspace } from "../src/features/kanban/kanban-page";
import { PipelineWorkspace } from "../src/features/pipelines/pipelines-page";
import { WikiWorkspace } from "../src/features/wiki/wiki-page";
import { HudStatusline } from "../src/features/hud/hud-statusline";
import { SpendFlowCard } from "../src/features/hud/spend-flow-card";
import { DockLauncher } from "../src/features/dock/dock-launcher";
import { dockVersion, subscribeDock, dockActiveKey } from "../src/features/dock/dock-state";
function DockProbe() {
  useSyncExternalStore(subscribeDock, dockVersion);
  return (
    <div className="relative h-full">
      <output aria-label="Opened dock panel">
        {dockActiveKey("right") ?? dockActiveKey("bottom") ?? "none"}
      </output>
      <DockLauncher agentsPending={false} />
    </div>
  );
}
function App() {
  const [tool, setTool] = useState("kanban");
  return (
    <>
      <nav>
        {["kanban", "pipelines", "wiki", "hud", "dock"].map((id) => (
          <button key={id} onClick={() => setTool(id)}>
            {id}
          </button>
        ))}
      </nav>
      <div style={{ height: "calc(100vh - 32px)" }}>
        {tool === "kanban" ? (
          <KanbanWorkspace projectId="test" />
        ) : tool === "pipelines" ? (
          <PipelineWorkspace projectId="test" />
        ) : tool === "dock" ? (
          <DockProbe />
        ) : tool === "wiki" ? (
          <WikiWorkspace projectId="test" />
        ) : (
          <>
            <HudStatusline />
            <SpendFlowCard
              report={{
                period: { label: "Test period", start: "", end: "" },
                totalCostUsd: 0.2,
                models: [{ id: "m", label: "A model", cost: 0.2 }],
                projects: [],
                links: [],
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
