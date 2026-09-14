import { useState, useMemo } from "react";
import type { MemoryTopicNode, MemoryScope } from "./memory-types";
import { filterMemoryTopics, formatBytes } from "./memory-types";
import { MemoryGraphCanvas } from "./memory-graph-canvas";
import { MemoryDocumentStudio } from "./memory-document-studio";
import { MemoryRecallSimulator } from "./memory-recall-simulator";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

function BrainIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </svg>
  );
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function UploadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function SearchIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function DatabaseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function UserIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function FolderGitIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <circle cx="12" cy="13" r="2" />
    </svg>
  );
}

function CpuIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

function SparklesIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3l1.912 5.888L20 10l-6.088 1.112L12 17l-1.912-5.888L4 10l6.088-1.112z" />
    </svg>
  );
}

function FileCodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <polyline points="10 13 8 15 10 17" />
      <polyline points="14 13 16 15 14 17" />
    </svg>
  );
}

// Default seed topics representing a rich agent state
const INITIAL_TOPICS: MemoryTopicNode[] = [
  {
    id: "user-preferences",
    name: "user-preferences.md",
    title: "User Technical Preferences & Persona",
    scope: "user",
    bytes: 1420,
    tokens: 355,
    tags: ["user", "preferences", "standards"],
    updatedAt: "2026-09-14T08:30:00Z",
    content: `---
title: User Technical Preferences & Persona
tags: [user, preferences, standards]
---
# User Preferences
- Prefers TypeScript strict typing and modular architecture.
- Enforces test-driven development and zero placeholders.
- See [coding-guidelines](./coding-guidelines.md) for style specifics.`,
  },
  {
    id: "coding-guidelines",
    name: "coding-guidelines.md",
    title: "Repository Architecture & Coding Guidelines",
    scope: "workspace",
    bytes: 3840,
    tokens: 960,
    tags: ["architecture", "typescript", "standards"],
    updatedAt: "2026-09-14T09:15:00Z",
    content: `---
title: Repository Architecture & Coding Guidelines
tags: [architecture, typescript, standards]
---
# Coding Guidelines
Monorepo rules:
- All form controls must use size="sm" without manual font sizing.
- State management follows atomic patterns documented in [state-architecture](./state-architecture.md).
- Backend contracts detailed in [api-specifications](./api-specifications.md).`,
  },
  {
    id: "state-architecture",
    name: "state-architecture.md",
    title: "Frontend State & Dock Management",
    scope: "workspace",
    bytes: 2560,
    tokens: 640,
    tags: ["state", "frontend", "dock"],
    updatedAt: "2026-09-13T16:20:00Z",
    content: `---
title: Frontend State & Dock Management
tags: [state, frontend, dock]
---
# State Architecture
- Dock panels registered in dock-state.ts.
- Communicates with [api-specifications](./api-specifications.md) via typed endpoints.`,
  },
  {
    id: "api-specifications",
    name: "api-specifications.md",
    title: "Backend Service Endpoints & DTOs",
    scope: "workspace",
    bytes: 4680,
    tokens: 1170,
    tags: ["api", "dto", "backend"],
    updatedAt: "2026-09-13T11:00:00Z",
    content: `---
title: Backend Service Endpoints & DTOs
tags: [api, dto, backend]
---
# Backend Specifications
Endpoints:
- /api/agent/memory - Scope and topic file access.
- /api/models/health - Live key fleet telemetry.
- Refer to [auth-security](./auth-security.md) for credential headers.`,
  },
  {
    id: "auth-security",
    name: "auth-security.md",
    title: "Authentication & Security Rules",
    scope: "workspace",
    bytes: 1890,
    tokens: 472,
    tags: ["security", "auth", "tokens"],
    updatedAt: "2026-09-12T14:45:00Z",
    content: `---
title: Authentication & Security Rules
tags: [security, auth, tokens]
---
# Security Rules
- All requests validate session tokens.
- Masked keys never expose credentials.`,
  },
];

export function MemoryPage() {
  const [topics, setTopics] = useState<MemoryTopicNode[]>(INITIAL_TOPICS);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>("coding-guidelines");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeScope, setActiveScope] = useState<MemoryScope>("all");
  const [activeTab, setActiveTab] = useState<"editor" | "simulator">("editor");

  const filteredTopics = useMemo(() => {
    return filterMemoryTopics(topics, searchQuery, activeScope);
  }, [topics, searchQuery, activeScope]);

  const selectedTopic = useMemo(() => {
    return topics.find((t) => t.id === selectedTopicId) ?? null;
  }, [topics, selectedTopicId]);

  // Telemetry Aggregates
  const stats = useMemo(() => {
    const userCount = topics.filter((t) => t.scope === "user").length;
    const workspaceCount = topics.filter((t) => t.scope === "workspace").length;
    const totalBytes = topics.reduce((sum, t) => sum + t.bytes, 0);
    const totalTokens = topics.reduce((sum, t) => sum + t.tokens, 0);
    return { userCount, workspaceCount, totalBytes, totalTokens };
  }, [topics]);

  const handleSaveTopic = (id: string, updatedContent: string, newTitle?: string) => {
    setTopics((prev) =>
      prev.map((t) => {
        if (t.id === id) {
          const bytes = new Blob([updatedContent]).size;
          const tokens = Math.ceil(bytes / 4);
          return {
            ...t,
            content: updatedContent,
            title: newTitle || t.title,
            bytes,
            tokens,
            updatedAt: new Date().toISOString(),
          };
        }
        return t;
      })
    );
  };

  const handleDeleteTopic = (id: string) => {
    setTopics((prev) => prev.filter((t) => t.id !== id));
    if (selectedTopicId === id) {
      setSelectedTopicId(null);
    }
  };

  const handleCreateTopic = () => {
    const newId = `topic-${Date.now().toString().slice(-6)}`;
    const newName = `new-topic-${Date.now().toString().slice(-4)}.md`;
    const newTopic: MemoryTopicNode = {
      id: newId,
      name: newName,
      title: "Untitled Topic",
      scope: activeScope === "user" ? "user" : "workspace",
      bytes: 256,
      tokens: 64,
      tags: ["draft"],
      updatedAt: new Date().toISOString(),
      content: `---\ntitle: Untitled Topic\ntags: [draft]\n---\n# Untitled Topic\nNew memory notes go here.`,
    };
    setTopics((prev) => [newTopic, ...prev]);
    setSelectedTopicId(newId);
  };

  return (
    <div className="flex flex-col gap-5 p-6 min-h-screen bg-background text-foreground">
      {/* Page Header */}
      <div className="flex items-center justify-between flex-wrap gap-4 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary border border-primary/20">
            <BrainIcon size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Agent Memory Vault & Knowledge Studio
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Visual Knowledge Graph, semantic recall testing, and persistent memory topic management
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" className="h-8">
            <UploadIcon size={14} />
            <span className="ml-1.5">Import Scope</span>
          </Button>
          <Button size="sm" variant="secondary" className="h-8">
            <DownloadIcon size={14} />
            <span className="ml-1.5">Export Archive</span>
          </Button>
          <Button size="sm" variant="primary" onClick={handleCreateTopic} className="h-8">
            <PlusIcon size={14} />
            <span className="ml-1.5">New Memory Topic</span>
          </Button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="p-3.5 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Total Topics</span>
            <DatabaseIcon size={16} />
          </div>
          <div className="text-2xl font-bold text-foreground mt-1.5">{topics.length}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Indexed in MEMORY.md
          </div>
        </div>

        <div className="p-3.5 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">User Scope</span>
            <UserIcon size={16} className="text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-blue-400 mt-1.5">{stats.userCount}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Cross-session personal profile
          </div>
        </div>

        <div className="p-3.5 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Workspace Scope</span>
            <FolderGitIcon size={16} className="text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-emerald-400 mt-1.5">{stats.workspaceCount}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Project repository context
          </div>
        </div>

        <div className="p-3.5 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Memory Footprint</span>
            <CpuIcon size={16} className="text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-foreground mt-1.5">
            {formatBytes(stats.totalBytes)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
            ~{stats.totalTokens} tokens in context
          </div>
        </div>
      </div>

      {/* Main Workspace Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-[600px]">
        {/* Left Column: Knowledge Graph & Filter Bar (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-3">
          {/* Controls Bar */}
          <div className="flex items-center justify-between gap-3 flex-wrap bg-card p-2.5 rounded-lg border border-border">
            <div className="flex items-center gap-1 bg-muted/40 p-0.5 rounded-md border border-border">
              {(["all", "user", "workspace"] as const).map((sc) => (
                <button
                  key={sc}
                  onClick={() => setActiveScope(sc)}
                  className={`px-2.5 py-1 rounded text-xs font-medium capitalize transition-all ${
                    activeScope === sc
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {sc === "all" ? "All Scopes" : sc}
                </button>
              ))}
            </div>

            <div className="relative w-56">
              <SearchIcon size={14} className="absolute left-2.5 top-2 text-muted-foreground pointer-events-none" />
              <Input
                size="sm"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search topics or tags..."
                className="pl-8 h-7"
              />
            </div>
          </div>

          {/* Interactive Graph Canvas */}
          <div className="flex-1 min-h-[520px]">
            <MemoryGraphCanvas
              topics={filteredTopics}
              selectedTopicId={selectedTopicId}
              onSelectTopic={setSelectedTopicId}
            />
          </div>
        </div>

        {/* Right Column: Studio / Simulator Tabs (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-3">
          {/* View Switcher Tabs */}
          <div className="flex items-center justify-between bg-card p-1.5 rounded-lg border border-border">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveTab("editor")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all ${
                  activeTab === "editor"
                    ? "bg-secondary text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <FileCodeIcon size={14} />
                <span>Document Studio</span>
              </button>
              <button
                onClick={() => setActiveTab("simulator")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all ${
                  activeTab === "simulator"
                    ? "bg-secondary text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <SparklesIcon size={14} className="text-primary" />
                <span>Recall Simulator</span>
              </button>
            </div>

            {selectedTopic && (
              <span className="text-[11px] text-muted-foreground font-mono truncate max-w-[140px]">
                {selectedTopic.name}
              </span>
            )}
          </div>

          {/* Tab Content */}
          <div className="flex-1 min-h-[520px]">
            {activeTab === "editor" ? (
              <MemoryDocumentStudio
                topic={selectedTopic}
                onSaveTopic={handleSaveTopic}
                onDeleteTopic={handleDeleteTopic}
              />
            ) : (
              <MemoryRecallSimulator
                topics={topics}
                onSelectTopic={setSelectedTopicId}
                selectedTopicId={selectedTopicId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
