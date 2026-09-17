import { createRoot } from "react-dom/client";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
import { SnapshotsPage } from "../src/features/snapshots/snapshots-page";

setActiveStrings(en);
createRoot(document.getElementById("root")!).render(
  <SnapshotsPage embedded projectId="proj-live" agentId="default_agent" />,
);
