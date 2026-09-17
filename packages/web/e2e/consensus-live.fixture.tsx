import { createRoot } from "react-dom/client";
import { AgentCockpit } from "../src/features/agent/agent-cockpit";
import { LiveConsensusPage } from "../src/features/consensus/consensus-page";
import { ProjectProvider, useProject } from "../src/state/project";
import { LocaleProvider } from "../src/state/locale";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
import { zh } from "../src/lib/strings-zh";

const language = new URLSearchParams(window.location.search).get("lang") === "zh" ? "zh" : "en";
setActiveStrings(language === "zh" ? zh : en);
localStorage.setItem("penguin.lang", language);

function ConsensusProbe() {
  const { setCurrentProjectId } = useProject();
  const surface = new URLSearchParams(window.location.search).get("surface");
  return (
    <main>
      <button onClick={() => setCurrentProjectId("alpha")}>Select alpha</button>
      <button onClick={() => setCurrentProjectId("beta")}>Select beta</button>
      <button onClick={() => setCurrentProjectId("unselected")}>Clear project</button>
      {surface === "cockpit" ? (
        <AgentCockpit embedded />
      ) : (
        <LiveConsensusPage embedded={surface === "embedded"} />
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <ProjectProvider>
      <ConsensusProbe />
    </ProjectProvider>
  </LocaleProvider>,
);
