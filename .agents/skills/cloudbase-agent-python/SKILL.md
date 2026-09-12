---
name: cloudbase-agent-python
description: "Build production-ready AI agent backends using the CloudBase Agent Python SDK — create agents with LangGraph/CrewAI/LlamaIndex, serve them via FastAPI with AG-UI protocol streaming + OpenAI-compatible endpoints, add tools (bash, filesystem, MCP, code execution), memory (in-memory, TDAI, MySQL, MongoDB), observability (OpenTelemetry/Langfuse), and middleware (auth, logging). Use this skill when the user wants to create an AI agent server, build a chatbot backend, set up human-in-the-loop workflows, integrate MCP tools, add agent observability, or deploy an agent API — even if they don't explicitly mention 'CloudBase Agent.'"
version: 2.21.1
alwaysApply: true
---

# CloudBase Agent Python SDK

Build production-ready AI agent backends with multi-framework support, streaming
protocol, rich tools, persistent memory, and full observability.

> **Note:** This skill is for **Python** projects only.

## When to use this skill

Use this skill for **AI agent development** when you need to:

- Deploy AI agents as HTTP services with AG-UI protocol support
- Build agent backends using LangGraph, CrewAI, or LlamaIndex frameworks
- Create custom agent adapters implementing the AbstractAgent interface
- Understand AG-UI protocol events and message streaming
- Build production-ready agent servers with FastAPI

**Do NOT use for:**
- Simple AI model calling without agent capabilities (use `ai-model-*` skills)
- CloudBase cloud functions (use `cloud-functions` skill)
- CloudRun backend services without agent features (use `cloudrun-development` skill)
- TypeScript/JavaScript agent projects (use `cloudbase-agent` skill, refer to the `ts/` sub-directory)

## How to use this skill (for a coding agent)

1. **Choose the right adapter**
   - Use LangGraph adapter for stateful, graph-based workflows
   - Use CrewAI adapter for multi-agent collaboration patterns
   - Build custom adapter for specialized agent logic

2. **Write agent code** — follow the adapter-specific doc from the Routing table

3. **Deploy the agent server** — follow the **blocking deployment pipeline** in [agent-deployment](agent-deployment.md)

## Routing (Execution Order)

> ⚠️ **Deployment is a BLOCKING 4-step pipeline.** Steps marked ✅ BLOCKING
> must be completed AND verified before proceeding to the next step.
> Do NOT call `manageAgent` until all blocking steps pass.

| Step | Task | Document | Blocking? |
|------|------|----------|-----------|
| 0 | **Choose adapter & write agent code** | See "Adapter Selection" below | — |
| 1 | **Ensure Python 3.10** | [agent-deployment](agent-deployment.md) § Step 1 | ✅ BLOCKING |
| 2 | **Build env/ (one-shot)** | [agent-deployment](agent-deployment.md) § Step 2 | ✅ BLOCKING |
| 3 | **Verify env/ integrity** | [agent-deployment](agent-deployment.md) § Step 3 | ✅ BLOCKING |
| 4 | **Deploy with manageAgent** | [agent-deployment](agent-deployment.md) § Step 4 | — |

### Adapter Selection (Step 0)

| Framework | Read | Install |
|-----------|------|---------|
| LangGraph (stateful graphs) | [adapter-langgraph](adapter-langgraph.md) | `cloudbase-agent-langgraph` |
| CrewAI (multi-agent crews) | [adapter-development](adapter-development.md) | `cloudbase-agent-crewai` |
| Coze platform | [adapter-coze](adapter-coze.md) | `cloudbase-agent-coze` |
| Custom / raw FastAPI | [server-quickstart](server-quickstart.md) + [adapter-development](adapter-development.md) | `cloudbase-agent-server` |

### Additional References (read on demand, NOT required for deployment)

| Task | Read |
|------|------|
| Server setup, middleware, multi-agent, CORS | [server-quickstart](server-quickstart.md) |
| Authentication and user context | [authentication](authentication.md) |

## Quick Start (Framework-Agnostic)

**Prerequisites:** Python >= 3.10 is required.

**1. Install dependencies (pick ONE adapter):**

```bash
# Option A: LangGraph-based agent
pip install cloudbase-agent-langgraph

# Option B: CrewAI-based agent
pip install cloudbase-agent-crewai

# Option C: Custom / minimal
pip install cloudbase-agent-server
```

**2. Create server entry point:**

```python
# server.py — this pattern works with ANY adapter
import os
from dotenv import load_dotenv
load_dotenv()

from cloudbase_agent.server import AgentServiceApp, AgentCreatorResult

def create_agent() -> AgentCreatorResult:
    agent = create_my_agent()  # Your agent factory
    return {"agent": agent}

app = AgentServiceApp()
app.set_cors_config(allow_origins=["*"])

if __name__ == "__main__":
    port = int(os.environ.get("SCF_RUNTIME_PORT", "9000"))
    app.run(create_agent, port=port, host="0.0.0.0")
```

**3. Deploy to CloudBase:**

Follow the **4-step deployment pipeline** in [agent-deployment](agent-deployment.md).

---

## Architecture

```
Client (React / MiniProgram / curl)
   │  HTTP POST + SSE streaming
   ▼
┌─────────────────────────────────────────────┐
│  AgentServiceApp (FastAPI)                   │
│  ├─ /send-message      ← AG-UI SSE         │
│  ├─ /chat/completions  ← OpenAI-compat      │
│  └─ Middleware chain (onion model)           │
├─────────────────────────────────────────────┤
│  Agent Layer                                 │
│  ├─ LangGraphAgent  ├─ CrewAIAgent          │
│  ├─ LlamaIndexAgent ├─ CozeAgent/DifyAgent  │
│  └─ BaseAgent (extend for custom)           │
├──────────────────┬──────────────────────────┤
│  Tools           │  Storage                  │
│  Bash/FS/Code/MCP│  Memory + LongTermMemory  │
├─────────────────────────────────────────────┤
│  Observability (OpenTelemetry + Langfuse)    │
└─────────────────────────────────────────────┘
```

## Installation

CloudBase Agent Python SDK is published to PyPI as separate packages. **Note: PyPI package names use hyphens (`cloudbase-agent-*`), and Python imports use the same namespace (`cloudbase_agent.*`)**.

```bash
pip install cloudbase-agent-langgraph
pip install cloudbase-agent-core
pip install cloudbase-agent-server
pip install cloudbase-agent-tools
pip install cloudbase-agent-storage
pip install cloudbase-agent-observability
pip install cloudbase-agent-coze
pip install cloudbase-agent-crewai
```

## Reference Documents

Based on what the user needs, read the corresponding reference document.
**Only read the relevant reference — don't load all of them.**

| User Need | Reference | What It Covers |
|-----------|-----------|---------------|
| **Deploying agent to CloudBase** | Read [agent-deployment](agent-deployment.md) | **manageAgent MCP tool (MUST USE)**, 4-step blocking pipeline, Python 3.10, env/ build, verification |
| Server setup, deployment, middleware, multi-agent, CORS | Read `references/server.md` | AgentServiceApp deployment, middleware, multi-agent server, Agent Creator pattern, health checks |
| LangGraph agent, callbacks, tool proxy, HITL, checkpoints | Read [adapter-langgraph](adapter-langgraph.md) | LangGraphAgent constructor, callbacks, ToolProxy, HITL, checkpoints |
| Tools: bash, filesystem, code execution, MCP, custom tools | Read `references/tools.md` | Tool creation, file tools, code executors, MCP toolkit, custom tools |
| Memory, persistence, short/long-term, MySQL, MongoDB | Read `references/storage.md` | Memory/storage and checkpoints |
| Tracing, monitoring, Langfuse, OpenTelemetry | Read `references/observability.md` | Trace configuration and observation spans |
| Common patterns, JWT auth, MCP integration, production | Read `references/recipes.md` | JWT middleware, MCP + LangGraph, production deployment |

## Project Structure Convention

```
my-agent-project/
├── agents/
│   ├── agentic_chat/agent.py
│   └── __init__.py
├── server.py
├── scf_bootstrap
├── .env
└── requirements.txt
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API key |
| `AUTO_TRACES_STDOUT` | Enable console tracing (`true`) |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse keys |
| `TDAI_ENDPOINT` / `TDAI_API_KEY` | TDAI memory/checkpoint endpoint |
| `SCF_RUNTIME_PORT` | CloudBase runtime port (set automatically during deployment) |

## Key Design Decisions

1. **Agent Creator Pattern**: Every request creates a fresh agent via factory function.
2. **Dual Protocol**: Agents support AG-UI and OpenAI-compatible endpoints.
3. **Middleware = Generator**: Use `yield` for onion-model middleware.
4. **Namespace Package**: PyPI packages share the `cloudbase_agent` namespace.
5. **Observability Auto-Integration**: Install observability support for tracing.
6. **Deploy with manageAgent**: Follow the blocking deployment pipeline before deployment.
