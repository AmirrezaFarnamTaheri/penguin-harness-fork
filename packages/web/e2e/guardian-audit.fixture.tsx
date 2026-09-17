import { createRoot } from "react-dom/client";
import { loadStrings, setActiveStrings } from "../src/lib/strings";
import { ProjectProvider, useProject } from "../src/state/project";
import { GuardianPage } from "../src/features/guardian/guardian-page";

function Fixture() {
  const { setCurrentProjectId } = useProject();
  return (
    <>
      <button onClick={() => setCurrentProjectId("beta")}>Switch to beta</button>
      <GuardianPage embedded />
    </>
  );
}
void loadStrings("en").then((strings) => {
  setActiveStrings(strings);
  createRoot(document.getElementById("root")!).render(
    <ProjectProvider>
      <Fixture />
    </ProjectProvider>,
  );
});
