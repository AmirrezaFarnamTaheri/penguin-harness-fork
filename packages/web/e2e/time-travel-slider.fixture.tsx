import { useState } from "react";
import { createRoot } from "react-dom/client";
import { en } from "../src/lib/strings-en";
import { setActiveStrings } from "../src/lib/strings";
import { LocaleProvider } from "../src/state/locale";
import { TraceFlamegraphPage } from "../src/features/traces/trace-flamegraph-page";

localStorage.setItem("penguin.lang", "en");
setActiveStrings(en);
function Fixture() {
  const [sessionId, setSessionId] = useState("replay-a");
  return (
    <LocaleProvider>
      <button onClick={() => setSessionId("replay-b")}>Switch session</button>
      <TraceFlamegraphPage embedded sessionId={sessionId} />
    </LocaleProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
