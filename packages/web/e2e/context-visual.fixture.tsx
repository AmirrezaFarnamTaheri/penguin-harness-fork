import { useState } from "react";
import { createRoot } from "react-dom/client";
import { loadStrings, setActiveStrings } from "../src/lib/strings";
import { LocaleProvider } from "../src/state/locale";
import { HudStatusline } from "../src/features/hud/hud-statusline";
import { ContextSessionContent } from "../src/features/context/context-breakdown-page";
import { createTaskStatsTracker, trackMainUsage } from "../src/lib/omni/task-stats";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "ready";
const stats = createTaskStatsTracker();
// Repeated requests spend 441k while the latest request occupies only 79,100 tokens.
trackMainUsage(stats, {
  type: "token_usage",
  request: { total: 79_100, input: 78_100, output: 1_000, cache_read: 70_000, cache_write: 8_100 },
  session: { total: 441_000, input: 431_000, output: 10_000, cache_read: 400_000, cache_write: 31_000 },
});

function Fixture() {
  const [selected, setSelected] = useState("alpha");
  const unavailable = scenario === "compacted" || scenario === "unknown";
  return (
    <main className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <HudStatusline
        tokensUsed={unavailable ? undefined : stats.contextNow}
        contextWindow={scenario === "unknown" ? undefined : 240_000}
        onOpenContext={() => document.getElementById("context-panel")?.focus()}
      />
      <section id="context-panel" tabIndex={-1} className="mx-auto max-w-4xl space-y-5 p-4">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold">Context usage</h1>
          <p>Deterministic test session: {selected}</p>
          <button className="min-h-11 underline" onClick={() => setSelected(selected === "alpha" ? "beta" : "alpha")}>
            Switch session
          </button>
        </header>
        <ContextSessionContent key={selected} sessionId={selected} />
      </section>
    </main>
  );
}
void loadStrings("en").then((strings) => {
  setActiveStrings(strings);
  createRoot(document.getElementById("root")!).render(<LocaleProvider><Fixture /></LocaleProvider>);
});
