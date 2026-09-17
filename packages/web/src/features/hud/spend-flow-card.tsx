import type { SpendFlowReport } from "@prismshadow/penguin-core/browser";
import { mutedClass, panelClass } from "../kanban/work-tool-ui";
import { SankeySpendChart } from "../cockpit/sankey-spend-chart";

export interface SpendFlowCardProps {
  report: SpendFlowReport;
  className?: string;
}
export function SpendFlowCard({ report, className = "" }: SpendFlowCardProps) {
  return (
    <section className={`${panelClass} space-y-5 text-sm ${className}`} aria-label="Cost breakdown">
      <header>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recorded cost</h3>
        <p className="mt-2 text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          ${report.totalCostUsd.toFixed(4)} <span className="text-sm font-normal">USD</span>
        </p>
        <p className={mutedClass}>{report.period.label}</p>
      </header>
      <SankeySpendChart report={report} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        {[
          { title: "By model", rows: report.models },
          { title: "By project", rows: report.projects },
        ].map((group) => (
          <section className="min-w-0" key={group.title}>
            <h4 className="mb-2 font-semibold text-gray-900 dark:text-gray-100">{group.title}</h4>
            <dl className="max-h-80 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-800">
              {group.rows.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-3"
                >
                  <dt className="min-w-0 break-all text-gray-700 dark:text-gray-300">
                    {row.label}
                  </dt>
                  <dd className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                    ${row.cost.toFixed(4)}{" "}
                    <span className="text-xs text-gray-500">
                      {report.totalCostUsd > 0
                        ? `(${Math.round((row.cost / report.totalCostUsd) * 100)}%)`
                        : ""}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            {!group.rows.length && <p className={mutedClass}>No recorded cost for this group.</p>}
          </section>
        ))}
      </div>
      <details className="border-t border-gray-200 pt-4 dark:border-gray-800">
        <summary className="min-h-10 cursor-pointer font-medium text-gray-900 dark:text-gray-100">
          Model-to-project detail ({report.links.length})
        </summary>
        <ul className="mt-2 max-h-80 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-800">
          {report.links.map((link, i) => (
            <li
              key={`${link.model}:${link.project}:${i}`}
              className="flex flex-wrap justify-between gap-3 py-3"
            >
              <span className="min-w-0 break-all text-gray-600 dark:text-gray-400">
                {link.model} → {link.project}
              </span>
              <span className="tabular-nums text-gray-900 dark:text-gray-100">
                ${link.cost.toFixed(4)}
              </span>
            </li>
          ))}
        </ul>
        {!report.links.length && <p className={mutedClass}>No attribution records.</p>}
      </details>
    </section>
  );
}
