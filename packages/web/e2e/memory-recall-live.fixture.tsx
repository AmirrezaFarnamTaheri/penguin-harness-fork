import { createRoot } from "react-dom/client";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
import { MemoryInspection } from "../src/features/memory/memory-page";
import { LocaleProvider } from "../src/state/locale";
localStorage.setItem("penguin.lang", "en");
setActiveStrings(en);
createRoot(document.getElementById("root")!).render(
  <LocaleProvider>
    <MemoryInspection projectId="p1" agentId="default_agent" />
  </LocaleProvider>,
);
