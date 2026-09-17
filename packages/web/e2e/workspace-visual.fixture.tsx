import { createRoot } from "react-dom/client";
import { AgentCockpit } from "../src/features/agent/agent-cockpit";
import { LocaleProvider } from "../src/state/locale";
import { ProjectProvider } from "../src/state/project";
import { SessionsProvider } from "../src/state/sessions";
import { loadStrings, setActiveStrings } from "../src/lib/strings";

// Match application boot: shared Modal buttons read the active dictionary synchronously.
void loadStrings("en").then((strings) => {
  setActiveStrings(strings);
  createRoot(document.getElementById("root")!).render(
    <LocaleProvider>
      <ProjectProvider>
        <SessionsProvider>
          <main className="min-h-screen bg-white dark:bg-gray-950">
            <AgentCockpit embedded sessionId="release-review" />
          </main>
        </SessionsProvider>
      </ProjectProvider>
    </LocaleProvider>,
  );
});
