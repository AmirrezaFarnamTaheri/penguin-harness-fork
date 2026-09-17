import { createRoot } from "react-dom/client";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
import { TraceFlamegraphPage } from "../src/features/traces/trace-flamegraph-page";

setActiveStrings(en);
createRoot(document.getElementById("root")!).render(
  <TraceFlamegraphPage embedded sessionId="sess-live" />,
);
