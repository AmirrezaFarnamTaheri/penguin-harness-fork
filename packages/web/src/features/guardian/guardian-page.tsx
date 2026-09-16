import { useProject } from "../../state/project";
import { LiveCommandSandbox } from "./live-command-sandbox";
import { RulePolicyEditor } from "./rule-policy-editor";
import { WorktreeLanesCard } from "./worktree-lanes-card";

export interface GuardianPageProps {
  embedded?: boolean;
}

export function GuardianPage({ embedded = false }: GuardianPageProps) {
  const { currentProject } = useProject();
  return (
    <div
      className={`min-w-0 overflow-y-auto text-sm text-gray-900 dark:text-gray-100 ${embedded ? "p-3" : "p-4 sm:p-6"}`}
    >
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Command safety</h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Check a command without running it, then manage the project’s execution rules.
        </p>
      </header>
      <div className="flex flex-col gap-8">
        <LiveCommandSandbox />
        {currentProject ? (
          <RulePolicyEditor key={currentProject.projectId} projectId={currentProject.projectId} />
        ) : (
          <p role="status">Select a project to load and edit its command policy.</p>
        )}
        <details className="border-t border-gray-200 pt-4 dark:border-gray-800">
          <summary className="cursor-pointer py-2 font-medium">Worktree demo</summary>
          <WorktreeLanesCard projectId={currentProject?.projectId ?? ""} />
        </details>
      </div>
    </div>
  );
}
