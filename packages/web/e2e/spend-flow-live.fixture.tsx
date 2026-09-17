import { createRoot } from "react-dom/client";
import { SpendFlowPanel } from "../src/features/hud/spend-flow-panel";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";

localStorage.setItem("penguin.lang", "en");
setActiveStrings(en);
createRoot(document.getElementById("root")!).render(<SpendFlowPanel projectId="p1" />);
