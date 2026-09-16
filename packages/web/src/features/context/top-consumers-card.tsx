import type { ContextToolShare, ContextFileShare } from "@prismshadow/penguin-server/api";
import { mutedClass, sectionClass, useInspectionCopy } from "./inspection-ui";
export interface TopConsumersCardProps {
  tools: ContextToolShare[];
  files: ContextFileShare[];
}
export function TopConsumersCard({ tools, files }: TopConsumersCardProps) {
  const copy = useInspectionCopy();
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className={sectionClass}>
        <h2 className="text-base font-semibold">
          {copy("Largest tool consumers", "用量最多的工具")}
        </h2>
        {!tools.length ? (
          <p className={mutedClass}>{copy("No tool traffic recorded.", "暂无工具调用记录。")}</p>
        ) : (
          <dl className="divide-y divide-gray-200 dark:divide-gray-800">
            {tools.map((tool) => (
              <div key={tool.name} className="flex justify-between gap-3 py-3">
                <dt className="min-w-0 break-all font-mono">{tool.name}</dt>
                <dd className="shrink-0 tabular-nums">{tool.tokens.toLocaleString()} tokens</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section className={sectionClass}>
        <h2 className="text-base font-semibold">
          {copy("Largest file consumers", "用量最多的文件")}
        </h2>
        {!files.length ? (
          <p className={mutedClass}>{copy("No file operations recorded.", "暂无文件操作记录。")}</p>
        ) : (
          <dl className="divide-y divide-gray-200 dark:divide-gray-800">
            {files.map((file) => (
              <div key={file.path} className="flex justify-between gap-3 py-3">
                <dt className="min-w-0">
                  <span className="block break-all font-mono">{file.path}</span>
                  <span className={mutedClass}>
                    {copy("Read", "读取")} {file.ops.read} · {copy("Edit", "编辑")} {file.ops.edit}{" "}
                    · {copy("Write", "写入")} {file.ops.write}
                  </span>
                </dt>
                <dd className="shrink-0 tabular-nums">{file.tokens.toLocaleString()} tokens</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}
