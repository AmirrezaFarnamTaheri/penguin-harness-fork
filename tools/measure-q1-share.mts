/**
 * Q1: what share of a request's system prompt is the skill index?
 * Assembles the real prompt for this agent's real state.
 */
import fs from "node:fs";
import {
  loadAgentState,
  assembleSystemPrompt,
  listInstalledSkills,
  skillMetadataSection,
  listScheduleNames,
} from "../packages/core/src/state/agent-state.js";
import { loadAgentVault } from "../packages/core/src/state/agent-vault.js";
import { resolveSessionMemory } from "../packages/core/src/state/memory.js";

const root = "C:/Users/ACER/.penguin/data";
const projectId = "default_project";
const agentId = "default_agent";

const state = await loadAgentState({ root, projectId, agentId });
const vault = await loadAgentVault(root, projectId, agentId);
const skills = await listInstalledSkills(root, projectId, agentId);
const schedules = await listScheduleNames(root, projectId, agentId);
const memory = await resolveSessionMemory({
  root,
  projectId,
  agentId,
  workspaceDir: `${root}/${projectId}/agents/${agentId}/workspaces/ws-measure`,
  enabled: state.systemConfig.memory?.enabled !== false,
});

const prompt = assembleSystemPrompt(
  state,
  {
    agentId,
    projectDir: `${root}/${projectId}`,
    sessionId: "session-measure",
    cwd: "D:/GitHub/penguin-harness-fork",
    provider: "openrouter",
    modelId: "stealth/space-bunny-alpha",
    platform: "win32",
    osVersion: "10.0.26200",
    shell: "bash",
    date: "2026-09-27",
  },
  Object.keys(vault),
  skills,
  memory,
  schedules,
);

const skillsSection = skillMetadataSection(skills);
const t = (n) => Math.round(n / 4);

// Same prompt, same state, with the pre-fix index restored, for the whole-prompt delta.
const beforeSection = skills
  .map((s) => (s.description ? `- \`${s.name}\` — ${s.description}` : `- \`${s.name}\``))
  .join("\n");
const promptBefore = assembleSystemPrompt(
  state,
  {
    agentId,
    projectDir: `${root}/${projectId}`,
    sessionId: "session-measure",
    cwd: "D:/GitHub/penguin-harness-fork",
    provider: "openrouter",
    modelId: "stealth/space-bunny-alpha",
    platform: "win32",
    osVersion: "10.0.26200",
    shell: "bash",
    date: "2026-09-27",
  },
  Object.keys(vault),
  skills.map((s) => ({ ...s, shortDescription: undefined })),
  memory,
  schedules,
);

console.log(
  JSON.stringify(
    {
      systemPromptBefore_fix: {
        chars: promptBefore.length,
        approxTokens: t(promptBefore.length),
        skillIndexChars: beforeSection.length,
        skillIndexShare_pct: Math.round((beforeSection.length / promptBefore.length) * 100),
      },
      systemPromptAfter_fix: {
        chars: prompt.length,
        approxTokens: t(prompt.length),
        skillIndexChars: skillsSection.length,
        skillIndexShare_pct: Math.round((skillsSection.length / prompt.length) * 100),
      },
      wholePromptSaved: {
        chars: promptBefore.length - prompt.length,
        approxTokens: t(promptBefore.length - prompt.length),
        pct: Math.round(((promptBefore.length - prompt.length) / promptBefore.length) * 100),
      },
      skillRows: skills.length,
      agentsMdChars: state.agentsMd.length,
    },
    null,
    2,
  ),
);
