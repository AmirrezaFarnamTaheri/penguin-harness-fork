/**
 * Factory for initialising and seeding the CodeGraph AST topology.
 * Maps the Penguin Harness architecture, symbols, modules, and dependencies.
 */
import { CodeGraph } from "@prismshadow/penguin-core";
import type { CodeGraphNode, CodeGraphEdge } from "@prismshadow/penguin-core";

export function createPenguinCodeGraph(): CodeGraph {
  const graph = new CodeGraph();

  const nodes: CodeGraphNode[] = [
    // Core Agent & Engine Files
    {
      id: "core/code-graph",
      name: "code-graph.ts",
      filePath: "packages/core/src/agent/code-graph.ts",
      kind: "file",
      loc: 547,
      exports: ["CodeGraph", "ConceptExplanation", "CodeGraphNode", "CodeGraphEdge"],
      imports: ["symbol-indexer.ts"],
    },
    {
      id: "core/symbol-indexer",
      name: "symbol-indexer.ts",
      filePath: "packages/core/src/agent/symbol-indexer.ts",
      kind: "file",
      loc: 657,
      exports: ["SymbolIndexer", "LookaheadBuffer", "FileSummary"],
    },
    {
      id: "core/shell-guardian",
      name: "shell-guardian.ts",
      filePath: "packages/core/src/agent/shell-guardian.ts",
      kind: "file",
      loc: 228,
      exports: ["ShellGuardian", "ShellSafetyAssessment", "ShellRiskLevel"],
    },
    {
      id: "core/worktrees",
      name: "worktrees.ts",
      filePath: "packages/core/src/environment/worktrees.ts",
      kind: "file",
      loc: 286,
      exports: ["WorktreeManager", "AgentWorktree"],
    },
    {
      id: "core/quorum-consensus",
      name: "quorum-consensus.ts",
      filePath: "packages/core/src/agent/quorum-consensus.ts",
      kind: "file",
      loc: 218,
      exports: ["QuorumConsensusEngine", "TopicStanding", "QuorumPolicy"],
    },
    {
      id: "core/mailbox",
      name: "mailbox.ts",
      filePath: "packages/core/src/agent/mailbox.ts",
      kind: "file",
      loc: 340,
      exports: ["MailboxBureau", "AgentMailbox", "MailboxMessage"],
    },
    {
      id: "core/context-compactor",
      name: "context-compactor.ts",
      filePath: "packages/core/src/agent/context-compactor.ts",
      kind: "file",
      loc: 412,
      exports: ["ContextCompactor", "CompactionAnchor"],
    },
    {
      id: "core/workflow-pipeline",
      name: "workflow-pipeline.ts",
      filePath: "packages/core/src/agent/workflow-pipeline.ts",
      kind: "file",
      loc: 380,
      exports: ["WorkflowPipeline", "PipelineStage"],
      imports: ["worktrees.ts", "quorum-consensus.ts"],
    },

    // Server Services & Routes
    {
      id: "server/context-breakdown",
      name: "context-breakdown.ts",
      filePath: "packages/server/src/services/context-breakdown.ts",
      kind: "file",
      loc: 274,
      exports: ["buildContextBreakdown", "emptyContextBreakdown"],
      imports: ["packages/core"],
    },
    {
      id: "server/trace-service",
      name: "trace-service.ts",
      filePath: "packages/server/src/services/trace-service.ts",
      kind: "file",
      loc: 850,
      exports: ["TraceService"],
      imports: ["context-breakdown.ts"],
    },
    {
      id: "server/command-policy",
      name: "command-policy.ts",
      filePath: "packages/server/src/http/routes/command-policy.ts",
      kind: "file",
      loc: 127,
      exports: ["commandPolicyRoutes"],
      imports: ["packages/core"],
    },
    {
      id: "server/sessions-route",
      name: "sessions.ts",
      filePath: "packages/server/src/http/routes/sessions.ts",
      kind: "file",
      loc: 1499,
      exports: ["sessionsRoutes"],
      imports: ["trace-service.ts", "context-breakdown.ts"],
    },

    // Web Components & Features
    {
      id: "web/chat-page",
      name: "chat-page.tsx",
      filePath: "packages/web/src/features/chat/chat-page.tsx",
      kind: "file",
      loc: 2435,
      exports: ["ChatPage"],
      imports: ["hud-statusline.tsx", "agent-cockpit.tsx", "spend-flow-panel.tsx"],
    },
    {
      id: "web/hud-statusline",
      name: "hud-statusline.tsx",
      filePath: "packages/web/src/features/hud/hud-statusline.tsx",
      kind: "file",
      loc: 164,
      exports: ["HudStatusline"],
    },
    {
      id: "web/agent-cockpit",
      name: "agent-cockpit.tsx",
      filePath: "packages/web/src/features/agent/agent-cockpit.tsx",
      kind: "file",
      loc: 690,
      exports: ["AgentCockpit"],
      imports: ["packages/core"],
    },
    {
      id: "web/spend-flow-panel",
      name: "spend-flow-panel.tsx",
      filePath: "packages/web/src/features/hud/spend-flow-panel.tsx",
      kind: "file",
      loc: 105,
      exports: ["SpendFlowPanel"],
    },
    {
      id: "web/models-key-pools",
      name: "models-key-pools.tsx",
      filePath: "packages/web/src/features/models/models-key-pools.tsx",
      kind: "file",
      loc: 480,
      exports: ["ModelsKeyPools"],
    },

    // Symbols (Classes, Interfaces, Functions)
    {
      id: "sym/CodeGraph",
      name: "CodeGraph",
      filePath: "packages/core/src/agent/code-graph.ts",
      kind: "class",
      loc: 320,
    },
    {
      id: "sym/CodeGraph#findShortestPath",
      name: "findShortestPath",
      filePath: "packages/core/src/agent/code-graph.ts",
      kind: "function",
      loc: 45,
    },
    {
      id: "sym/CodeGraph#getImpactRadius",
      name: "getImpactRadius",
      filePath: "packages/core/src/agent/code-graph.ts",
      kind: "function",
      loc: 55,
    },
    {
      id: "sym/CodeGraph#findBridgeNodes",
      name: "findBridgeNodes",
      filePath: "packages/core/src/agent/code-graph.ts",
      kind: "function",
      loc: 40,
    },
    {
      id: "sym/CodeGraph#findHubNodes",
      name: "findHubNodes",
      filePath: "packages/core/src/agent/code-graph.ts",
      kind: "function",
      loc: 30,
    },
    {
      id: "sym/CodeGraph#detectDeadCode",
      name: "detectDeadCode",
      filePath: "packages/core/src/agent/code-graph.ts",
      kind: "function",
      loc: 35,
    },
    {
      id: "sym/SymbolIndexer",
      name: "SymbolIndexer",
      filePath: "packages/core/src/agent/symbol-indexer.ts",
      kind: "class",
      loc: 240,
    },
    {
      id: "sym/ShellGuardian",
      name: "ShellGuardian",
      filePath: "packages/core/src/agent/shell-guardian.ts",
      kind: "class",
      loc: 95,
    },
    {
      id: "sym/ShellGuardian#analyzeCommand",
      name: "analyzeCommand",
      filePath: "packages/core/src/agent/shell-guardian.ts",
      kind: "function",
      loc: 45,
    },
    {
      id: "sym/WorktreeManager",
      name: "WorktreeManager",
      filePath: "packages/core/src/environment/worktrees.ts",
      kind: "class",
      loc: 180,
    },
    {
      id: "sym/QuorumConsensusEngine",
      name: "QuorumConsensusEngine",
      filePath: "packages/core/src/agent/quorum-consensus.ts",
      kind: "class",
      loc: 150,
    },
    {
      id: "sym/MailboxBureau",
      name: "MailboxBureau",
      filePath: "packages/core/src/agent/mailbox.ts",
      kind: "class",
      loc: 210,
    },
    {
      id: "sym/ContextCompactor",
      name: "ContextCompactor",
      filePath: "packages/core/src/agent/context-compactor.ts",
      kind: "class",
      loc: 280,
    },
    {
      id: "sym/buildContextBreakdown",
      name: "buildContextBreakdown",
      filePath: "packages/server/src/services/context-breakdown.ts",
      kind: "function",
      loc: 85,
    },
    {
      id: "sym/TraceService",
      name: "TraceService",
      filePath: "packages/server/src/services/trace-service.ts",
      kind: "class",
      loc: 540,
    },
    {
      id: "sym/HudStatusline",
      name: "HudStatusline",
      filePath: "packages/web/src/features/hud/hud-statusline.tsx",
      kind: "component",
      loc: 164,
    },
    {
      id: "sym/AgentCockpit",
      name: "AgentCockpit",
      filePath: "packages/web/src/features/agent/agent-cockpit.tsx",
      kind: "component",
      loc: 690,
    },
    {
      id: "sym/SpendFlowPanel",
      name: "SpendFlowPanel",
      filePath: "packages/web/src/features/hud/spend-flow-panel.tsx",
      kind: "component",
      loc: 105,
    },
    {
      id: "sym/DeadLegacyShim",
      name: "DeadLegacyShim",
      filePath: "packages/core/src/agent/legacy-stub.ts",
      kind: "function",
      loc: 18,
    },
  ];

  for (const n of nodes) {
    graph.addNode(n);
  }

  const edges: CodeGraphEdge[] = [
    // File -> Symbol containment
    { source: "core/code-graph", target: "sym/CodeGraph", kind: "contains" },
    { source: "sym/CodeGraph", target: "sym/CodeGraph#findShortestPath", kind: "contains" },
    { source: "sym/CodeGraph", target: "sym/CodeGraph#getImpactRadius", kind: "contains" },
    { source: "sym/CodeGraph", target: "sym/CodeGraph#findBridgeNodes", kind: "contains" },
    { source: "sym/CodeGraph", target: "sym/CodeGraph#findHubNodes", kind: "contains" },
    { source: "sym/CodeGraph", target: "sym/CodeGraph#detectDeadCode", kind: "contains" },
    { source: "core/symbol-indexer", target: "sym/SymbolIndexer", kind: "contains" },
    { source: "core/shell-guardian", target: "sym/ShellGuardian", kind: "contains" },
    { source: "sym/ShellGuardian", target: "sym/ShellGuardian#analyzeCommand", kind: "contains" },
    { source: "core/worktrees", target: "sym/WorktreeManager", kind: "contains" },
    { source: "core/quorum-consensus", target: "sym/QuorumConsensusEngine", kind: "contains" },
    { source: "core/mailbox", target: "sym/MailboxBureau", kind: "contains" },
    { source: "core/context-compactor", target: "sym/ContextCompactor", kind: "contains" },
    { source: "server/context-breakdown", target: "sym/buildContextBreakdown", kind: "contains" },
    { source: "server/trace-service", target: "sym/TraceService", kind: "contains" },
    { source: "web/hud-statusline", target: "sym/HudStatusline", kind: "contains" },
    { source: "web/agent-cockpit", target: "sym/AgentCockpit", kind: "contains" },
    { source: "web/spend-flow-panel", target: "sym/SpendFlowPanel", kind: "contains" },

    // Cross-module imports and calls
    { source: "core/code-graph", target: "core/symbol-indexer", kind: "imports" },
    { source: "sym/CodeGraph", target: "sym/SymbolIndexer", kind: "references" },
    { source: "core/workflow-pipeline", target: "core/worktrees", kind: "imports" },
    { source: "core/workflow-pipeline", target: "core/quorum-consensus", kind: "imports" },
    { source: "server/command-policy", target: "core/shell-guardian", kind: "imports" },
    { source: "server/command-policy", target: "sym/ShellGuardian#analyzeCommand", kind: "calls" },
    { source: "server/trace-service", target: "server/context-breakdown", kind: "imports" },
    { source: "sym/TraceService", target: "sym/buildContextBreakdown", kind: "calls" },
    { source: "server/sessions-route", target: "server/trace-service", kind: "imports" },
    { source: "web/chat-page", target: "web/hud-statusline", kind: "imports" },
    { source: "web/chat-page", target: "web/agent-cockpit", kind: "imports" },
    { source: "web/chat-page", target: "web/spend-flow-panel", kind: "imports" },
    { source: "sym/AgentCockpit", target: "sym/QuorumConsensusEngine", kind: "references" },
    { source: "sym/AgentCockpit", target: "sym/MailboxBureau", kind: "references" },
    { source: "sym/AgentCockpit", target: "sym/ContextCompactor", kind: "references" },
    { source: "sym/HudStatusline", target: "sym/AgentCockpit", kind: "references" },
    { source: "sym/HudStatusline", target: "sym/SpendFlowPanel", kind: "references" },
  ];

  for (const e of edges) {
    graph.addEdge(e);
  }

  return graph;
}
