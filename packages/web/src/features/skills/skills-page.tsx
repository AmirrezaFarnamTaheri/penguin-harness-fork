/**
 * Production Skills Hub & Catalog Workspace.
 *
 * Provides exploration, parameter configuration, prompt template inspection,
 * and invocation copying for 2,400+ production agent skills.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import * as api from "../../api/endpoints";
import { useProject } from "../../state/project";
import { useDocumentTitle } from "../../lib/use-document-title";
import { S } from "../../lib/strings";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { CopyButton } from "../../components/ui/copy-button";
import { RequiredMark } from "../../components/ui/field";
import { toastSuccess, toastError } from "../../components/ui/toast";
import type { SkillEntry } from "./skill-catalog-dialog";

const CATEGORIES = [
  { id: "all", label: "All Skills" },
  { id: "engineering", label: "Engineering" },
  { id: "design", label: "Design & UI" },
  { id: "qa", label: "QA & Testing" },
  { id: "science", label: "Science & Research" },
  { id: "ops", label: "DevOps & Cloud" },
  { id: "management", label: "Management & Strategy" },
  { id: "general", label: "General" },
] as const;

const CATEGORY_TONES: Record<string, string> = {
  engineering:
    "bg-blue-500/10 text-blue-700 border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-300",
  design: "bg-pink-500/10 text-pink-700 border-pink-500/30 dark:bg-pink-950/30 dark:text-pink-300",
  qa: "bg-purple-500/10 text-purple-700 border-purple-500/30 dark:bg-purple-950/30 dark:text-purple-300",
  science:
    "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-300",
  ops: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300",
  management:
    "bg-cyan-500/10 text-cyan-700 border-cyan-500/30 dark:bg-cyan-950/30 dark:text-cyan-300",
  general: "bg-gray-500/10 text-gray-700 border-gray-500/30 dark:bg-gray-950/30 dark:text-gray-300",
};

export function SkillsPage() {
  useDocumentTitle(S.nav.skills ?? "Skills Hub");
  const { currentProject } = useProject();

  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSkillName, setSelectedSkillName] = useState<string>("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      let loaded: SkillEntry[] = [];
      try {
        const pluginLib = await api.getPluginLibrary();
        if (pluginLib && Array.isArray(pluginLib.groups)) {
          for (const g of pluginLib.groups) {
            for (const p of g.plugins) {
              if (Array.isArray(p.skills)) {
                for (const s of p.skills) {
                  loaded.push({
                    name: s.name,
                    description: s.description || p.description || "",
                    shortDescription: s.shortDescription || s.description?.slice(0, 80),
                    category: (g.id as any) || "engineering",
                    tags: [g.id, p.name],
                    allowedTools: [],
                    content: `# ${s.name}\n\n${s.description}\n\nShipped by plugin ${p.name}.`,
                    parameters: [],
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to fetch skills catalog from server";
        setLoadError(msg);
        console.warn("Plugin library fetch failed:", e);
      }

      setSkills(loaded);
      const firstSkill = loaded[0];
      if (firstSkill && !selectedSkillName) {
        setSelectedSkillName(firstSkill.name);
      } else if (!firstSkill) {
        setSelectedSkillName("");
      }
    } catch (err) {
      console.error("Failed to load skills:", err);
      toastError("Failed to fetch skills catalog");
    } finally {
      setLoading(false);
    }
  }, [selectedSkillName]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const selectedSkill = useMemo(() => {
    return skills.find((s) => s.name === selectedSkillName) ?? skills[0] ?? null;
  }, [skills, selectedSkillName]);

  useEffect(() => {
    if (selectedSkill?.parameters) {
      const defaults: Record<string, string> = {};
      for (const p of selectedSkill.parameters) {
        if (p.default) defaults[p.name] = p.default;
      }
      setParamValues(defaults);
    } else {
      setParamValues({});
    }
  }, [selectedSkill]);

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

  const generatedPromptBlock = useMemo(() => {
    if (!selectedSkill) return "";
    let block = `/${selectedSkill.name}`;
    const keys = Object.keys(paramValues).filter((k) => paramValues[k]?.trim());
    if (keys.length > 0) {
      block += ` ${keys.map((k) => `${k}="${paramValues[k]}"`).join(" ")}`;
    }
    return block;
  }, [selectedSkill, paramValues]);

  return (
    <div className="flex h-full w-full flex-col bg-gray-50 dark:bg-gray-950 font-sans">
      {/* Top Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white/80 px-6 py-3 backdrop-blur-xs dark:border-gray-800 dark:bg-gray-900/80">
        <div className="flex items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Skills Hub & Capabilities Catalog
              </h1>
              <Badge tone="brand">{skills.length} Loaded</Badge>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Searchable production catalog of engineering, research, design, QA, and operational
              agent skills
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button variant="secondary" size="sm" onClick={() => void loadSkills()}>
            Refresh Catalog
          </Button>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Categories & Skills Explorer */}
        <div className="w-96 shrink-0 border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/50 flex flex-col">
          {/* Search & Category Pills */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-800 space-y-2">
            <input
              type="text"
              placeholder="Search 2,400+ skills by name, tag, or role..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-hidden"
            />
            <div className="flex items-center gap-1 overflow-x-auto pb-1 text-[11px]">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCategory(c.id)}
                  className={`px-2 py-0.5 rounded-full font-medium transition-colors whitespace-nowrap ${
                    selectedCategory === c.id
                      ? "bg-blue-600 text-white dark:bg-blue-500"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Skill List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredSkills.map((s) => {
              const active = s.name === selectedSkillName;
              const toneClass = CATEGORY_TONES[s.category] || CATEGORY_TONES.general;
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => setSelectedSkillName(s.name)}
                  className={`w-full text-left p-3 rounded-lg border transition-all text-xs ${
                    active
                      ? "border-blue-500/40 bg-blue-50/50 dark:border-blue-500/40 dark:bg-blue-950/20 text-gray-900 dark:text-gray-100"
                      : "border-transparent hover:border-gray-200 dark:hover:border-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-gray-800/40"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold font-mono truncate">{s.name}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded-sm border text-[10px] uppercase font-mono ${toneClass}`}
                    >
                      {s.category}
                    </span>
                  </div>
                  <p className="line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {s.description}
                  </p>
                  {s.tags.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      {s.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.2 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-[10px]"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
            {loadError ? (
              <div className="p-4 text-center text-xs text-rose-400">
                Failed to load skills catalog.
              </div>
            ) : filteredSkills.length === 0 ? (
              <div className="text-center text-xs text-gray-400 py-12">
                {skills.length === 0
                  ? "No skills available in the catalog."
                  : "No skills matching search criteria."}
              </div>
            ) : null}
          </div>
        </div>

        {/* Right: Detailed Skill Inspector */}
        <div className="flex-1 flex flex-col bg-white dark:bg-gray-900 overflow-hidden">
          {selectedSkill ? (
            <div className="flex-1 overflow-y-auto p-8 space-y-6 max-w-4xl">
              {/* Header Info */}
              <div className="border-b border-gray-200 dark:border-gray-800 pb-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-2xl font-bold font-mono text-gray-900 dark:text-gray-100">
                      {selectedSkill.name}
                    </h2>
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 leading-relaxed">
                      {selectedSkill.description}
                    </p>
                  </div>
                  <Badge tone="brand">{selectedSkill.category.toUpperCase()}</Badge>
                </div>

                <div className="flex items-center gap-2 mt-4 flex-wrap">
                  {selectedSkill.tags.map((tag) => (
                    <Badge key={tag} tone="gray">
                      #{tag}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Allowed Tools */}
              {selectedSkill.allowedTools.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                    Required & Allowed Tools
                  </div>
                  <div className="flex items-center gap-2 flex-wrap font-mono text-xs">
                    {selectedSkill.allowedTools.map((tool) => (
                      <span
                        key={tool}
                        className="px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Parameters Form */}
              {selectedSkill.parameters && selectedSkill.parameters.length > 0 && (
                <div className="space-y-3 p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30 text-xs">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">
                    Skill Parameters
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    {selectedSkill.parameters.map((p) => (
                      <div key={p.name}>
                        <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 font-mono mb-1">
                          {p.name} {p.required && <RequiredMark />}
                        </label>
                        <input
                          type="text"
                          value={paramValues[p.name] ?? ""}
                          onChange={(e) =>
                            setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                          }
                          placeholder={p.description}
                          className="w-full px-3 py-1.5 text-xs rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:outline-hidden"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Generated Prompt Block & Copy Button */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                    Slash Command Invocation
                  </div>
                  <CopyButton text={generatedPromptBlock} label="Copy slash command invocation" />
                </div>
                <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-900 text-emerald-400 font-mono text-xs">
                  {generatedPromptBlock}
                </div>
              </div>

              {/* Instructions / System Prompt Preview */}
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  Instruction Body (SKILL.md)
                </div>
                <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 font-mono text-xs text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
                  {selectedSkill.content}
                </div>
              </div>
            </div>
          ) : loadError ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-xs gap-3">
              <p className="font-semibold text-rose-400">Failed to load skills catalog</p>
              <p className="text-gray-400 max-w-sm">{loadError}</p>
              <Button variant="secondary" size="sm" onClick={() => void loadSkills()}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
              {skills.length === 0
                ? "No skills available in the catalog."
                : "Select a skill to inspect its configuration and capabilities."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
