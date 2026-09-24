import { createRoot } from "react-dom/client";
import { loadStrings, setActiveStrings, isStringsLoaded } from "../src/lib/strings";
import { useEffect, useState } from "react";
import { ProjectProvider } from "../src/state/project";
import { LocaleProvider } from "../src/state/locale";
import { GuardianPage } from "../src/features/guardian/guardian-page";
import { ConsensusPage } from "../src/features/consensus/consensus-page";
import { SnapshotsPage } from "../src/features/snapshots/snapshots-page";
import { TraceFlamegraphPage } from "../src/features/traces/trace-flamegraph-page";
import { ModelsKeyFleetPage } from "../src/features/models/models-key-fleet-page";
const view = new URLSearchParams(location.search).get("view");

// The fixture's labels are asserted in English. LocaleProvider otherwise follows the
// browser's zh-CN locale and can race LocaleGate's English dictionary load.
localStorage.setItem("penguin.lang", "en");

function LocaleGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(isStringsLoaded());
  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void loadStrings("en").then((dict) => {
      if (!cancelled) {
        setActiveStrings(dict);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ready]);
  if (!ready) return null;
  return children;
}
createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <LocaleGate>
      <ProjectProvider>
        {view === "guardian" ? (
          <GuardianPage embedded />
        ) : view === "consensus" ? (
          <ConsensusPage embedded />
        ) : view === "snapshots" ? (
          <SnapshotsPage embedded />
        ) : view === "traces" ? (
          <TraceFlamegraphPage embedded />
        ) : (
          <ModelsKeyFleetPage embedded />
        )}
      </ProjectProvider>
    </LocaleGate>
  </LocaleProvider>,
);
