/**
 * Q2: is a plugin a distinct thing from a skill, or the same thing twice?
 * Measures the real library on disk.
 */
import { loadPluginGroups, libraryPlugin } from "../packages/core/src/plugins/index.js";

const groups = loadPluginGroups();
const plugins = groups.flatMap((g) => g.plugins);

const skillCount = plugins.reduce((n, p) => n + p.skills.length, 0);
const withHooks = plugins.filter((p) => p.hooks);
const preinstall = plugins.filter((p) => p.preinstall);
const bundled = plugins.filter((p) => p.skills.length > 1);
const distribution = {};
for (const p of plugins) distribution[p.skills.length] = (distribution[p.skills.length] ?? 0) + 1;

console.log(
  JSON.stringify(
    {
      groups: groups.map((g) => ({ id: g.id, title: g.title, plugins: g.plugins.length })),
      totals: {
        plugins: plugins.length,
        skillsInsidePlugins: skillCount,
        skillsPerPlugin_mean: Number((skillCount / plugins.length).toFixed(2)),
        skillsPerPlugin_distribution: distribution,
      },
      pluginsWithHooks: { count: withHooks.length, names: withHooks.map((p) => p.name) },
      preinstallTrue: preinstall.length,
      bundledPlugins_multiSkill: {
        count: bundled.length,
        examples: bundled
          .slice(0, 5)
          .map((p) => ({ name: p.name, skills: p.skills.length, hooks: Boolean(p.hooks) })),
      },
      samplePlugin: (() => {
        const p = libraryPlugin("web-design") ?? plugins[0];
        return {
          name: p.name,
          skills: p.skills.map((s) => s.name),
          hooks: p.hooks ? Object.keys(p.hooks.files) : [],
        };
      })(),
    },
    null,
    2,
  ),
);
