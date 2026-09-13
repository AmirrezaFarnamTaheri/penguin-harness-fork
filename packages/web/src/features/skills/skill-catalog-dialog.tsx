/**
 * Skill Catalog & Inspector Modal.
 *
 * Provides full exploration of installed skills across categories (Engineering, Design,
 * QA, Science, Ops, Management), parameter preview, and prompt block generation.
 */
import { useState, useMemo } from "react";
import { Modal } from "../../components/ui/modal";
import { Badge, type BadgeTone } from "../../components/ui/badge";
import { CopyButton } from "../../components/ui/copy-button";
import { RequiredMark } from "../../components/ui/field";

export interface SkillEntry {
  name: string;
  description: string;
  shortDescription?: string;
  category: "engineering" | "design" | "qa" | "science" | "ops" | "management" | "general";
  tags: string[];
  allowedTools: string[];
  content: string;
  parameters?: Array<{ name: string; description: string; required?: boolean; default?: string }>;
}

export interface SkillCatalogDialogProps {
  open: boolean;
  onClose: () => void;
  skills: SkillEntry[];
  onSelectSkill?: (skill: SkillEntry) => void;
}

const CATEGORIES = [
  { id: "all", label: "All Skills" },
  { id: "engineering", label: "Engineering" },
  { id: "design", label: "Design & UI" },
  { id: "qa", label: "QA & Testing" },
  { id: "science", label: "Science & Research" },
  { id: "ops", label: "DevOps & Cloud" },
  { id: "management", label: "Management & Planning" },
] as const;

export function SkillCatalogDialog({
  open,
  onClose,
  skills,
  onSelectSkill,
}: SkillCatalogDialogProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSkillName, setSelectedSkillName] = useState<string>(skills[0]?.name ?? "");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const filteredSkills = useMemo(() => {
    return skills.filter((s) => {
      const matchCat = selectedCategory === "all" || s.category === selectedCategory;
      const q = searchQuery.toLowerCase().trim();
      const matchSearch =
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q));
      return matchCat && matchSearch;
    });
  }, [skills, selectedCategory, searchQuery]);

  const activeSkill = useMemo(() => {
    return skills.find((s) => s.name === selectedSkillName) || filteredSkills[0] || skills[0];
  }, [skills, filteredSkills, selectedSkillName]);

  const generatedPrompt = useMemo(() => {
    if (!activeSkill) return "";
    let content = activeSkill.content;
    for (const [k, v] of Object.entries(paramValues)) {
      content = content.replaceAll(`{{${k}}}`, v).replaceAll(`{${k}}`, v).replaceAll(`$${k}`, v);
    }
    return `=== SKILL: ${activeSkill.name} ===\n${content}\n=== END SKILL: ${activeSkill.name} ===`;
  }, [activeSkill, paramValues]);

  return (
    <Modal
      open={open}
      title="Agent Skill Catalog & Inspector"
      onClose={onClose}
      widthClass="sm:max-w-5xl"
    >
      <div className="flex h-[620px] flex-col gap-3">
        {/* Category bar & Search */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3 dark:border-gray-800">
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  selectedCategory === cat.id
                    ? "bg-blue-600 text-white dark:bg-blue-500"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <div className="w-64">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills, tags, keywords..."
              className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        </div>

        {/* Main Columns */}
        <div className="grid flex-1 grid-cols-12 gap-4 overflow-hidden">
          {/* Skill List */}
          <div className="col-span-5 flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-gray-50/50 dark:border-gray-800 dark:bg-gray-900/40">
            <div className="border-b border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-800 dark:text-gray-400">
              Installed Skills ({filteredSkills.length})
            </div>
            <div className="flex-1 space-y-1 overflow-y-auto p-2">
              {filteredSkills.map((s) => {
                const isSelected = activeSkill?.name === s.name;
                return (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => {
                      setSelectedSkillName(s.name);
                      setParamValues({});
                    }}
                    className={`flex w-full flex-col items-start gap-1 rounded-md p-2.5 text-left transition-colors ${
                      isSelected
                        ? "bg-blue-50 text-blue-900 ring-1 ring-blue-500/30 dark:bg-blue-950/40 dark:text-blue-200"
                        : "text-gray-700 hover:bg-gray-100/80 dark:text-gray-300 dark:hover:bg-gray-800/60"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-xs font-semibold">{s.name}</span>
                      <span className="rounded bg-gray-200/80 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                        {s.category}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">
                      {s.shortDescription || s.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Skill Details & Inspector */}
          <div className="col-span-7 flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
            {activeSkill ? (
              <div className="flex h-full flex-col overflow-hidden">
                {/* Header */}
                <div className="border-b border-gray-100 p-4 dark:border-gray-800">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                        {activeSkill.name}
                      </h3>
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {activeSkill.description}
                      </p>
                    </div>
                    {onSelectSkill && (
                      <button
                        type="button"
                        onClick={() => onSelectSkill(activeSkill)}
                        className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                      >
                        Apply Skill
                      </button>
                    )}
                  </div>

                  {/* Tags & Tools */}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge tone="brand">{activeSkill.category}</Badge>
                    {activeSkill.tags.map((t) => (
                      <Badge key={t} tone="gray">
                        #{t}
                      </Badge>
                    ))}
                    {activeSkill.allowedTools.map((tool) => (
                      <Badge key={tool} tone="green">
                        tool: {tool}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Parameters Form (if any) */}
                {activeSkill.parameters && activeSkill.parameters.length > 0 && (
                  <div className="border-b border-gray-100 bg-gray-50/50 p-3 dark:border-gray-800 dark:bg-gray-900/30">
                    <div className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">
                      Skill Parameters
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {activeSkill.parameters.map((p) => (
                        <div key={p.name} className="flex flex-col gap-1">
                          <label className="text-[11px] font-medium text-gray-600 dark:text-gray-400">
                            {p.name} {p.required && <RequiredMark />}
                          </label>
                          <input
                            type="text"
                            placeholder={p.default || p.description}
                            value={paramValues[p.name] ?? ""}
                            onChange={(e) =>
                              setParamValues((prev) => ({
                                ...prev,
                                [p.name]: e.target.value,
                              }))
                            }
                            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-900"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Content Body Preview */}
                <div className="relative flex-1 overflow-y-auto p-4">
                  <div className="flex items-center justify-between pb-2">
                    <span className="text-xs font-medium text-gray-500">Instruction Body</span>
                    <CopyButton label="Copy prompt block" text={generatedPrompt} />
                  </div>
                  <pre className="whitespace-pre-wrap rounded-md bg-gray-50 p-3 font-mono text-[11px] leading-relaxed text-gray-800 dark:bg-gray-900 dark:text-gray-200">
                    {generatedPrompt}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-gray-400">
                No skill selected
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
