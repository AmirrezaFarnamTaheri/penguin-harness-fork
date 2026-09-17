import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useCockpitTelemetry } from "../src/features/agent/use-cockpit-telemetry";
import { MailboxBureau } from "../src/features/consensus/mailbox-bureau";

function TelemetryProbe() {
  const [project, setProject] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Keep this task until acknowledged");
  const [directive, setDirective] = useState("Keep this directive until acknowledged");
  const [taskResult, setTaskResult] = useState("none");
  const [directiveResult, setDirectiveResult] = useState("none");
  const [mounted, setMounted] = useState(true);
  return (
    <main>
      <button onClick={() => setProject("alpha")}>Select alpha</button>
      <button onClick={() => setProject("beta")}>Select beta</button>
      <button onClick={() => setProject(null)}>Clear project</button>
      <button onClick={() => setMounted(false)}>Unmount telemetry</button>
      <input
        aria-label="Task prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <input
        aria-label="Directive"
        value={directive}
        onChange={(event) => setDirective(event.target.value)}
      />
      <output aria-label="Task result">{taskResult}</output>
      <output aria-label="Directive result">{directiveResult}</output>
      {mounted && (
        <Controls
          project={project}
          prompt={prompt}
          directive={directive}
          onTask={(ok) => {
            setTaskResult(String(ok));
            if (ok) setPrompt("");
          }}
          onDirective={(ok) => {
            setDirectiveResult(String(ok));
            if (ok) setDirective("");
          }}
        />
      )}
    </main>
  );
}

function Controls({
  project,
  prompt,
  directive,
  onTask,
  onDirective,
}: {
  project: string | null;
  prompt: string;
  directive: string;
  onTask: (ok: boolean) => void;
  onDirective: (ok: boolean) => void;
}) {
  const telemetry = useCockpitTelemetry(project);
  return (
    <>
      <output aria-label="Telemetry">{JSON.stringify(telemetry)}</output>
      <section aria-label="Live mailbox">
        <MailboxBureau entries={telemetry.mailboxEntries} />
      </section>
      <button onClick={() => void telemetry.refresh()}>Refresh telemetry</button>
      <button onClick={() => void telemetry.triggerTask(prompt).then(onTask)}>Dispatch task</button>
      <button
        onClick={() => void telemetry.dispatchDirective("coder", directive).then(onDirective)}
      >
        Send directive
      </button>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<TelemetryProbe />);
