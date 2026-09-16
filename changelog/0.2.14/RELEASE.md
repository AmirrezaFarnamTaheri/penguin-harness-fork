PenguinHarness fork 0.2.14 introduces the unified Agent Cockpit suite, an autonomous multi-agent swarm coordinator, real-time AST topology monitoring, synthetic model key fleet health management, and major runtime efficiency and bundle footprint remediations.

## Install

Use this fork's release assets when available. The desktop installers and pre-built binaries bundle their required runtime; npm installation requires Node 24 or newer.

## Highlights

- **Unified Agent Cockpit**: Real-time telemetry streaming multiplexer over WebSocket (`/api/cockpit/stream`, `/ws/cockpit`) and REST, integrating live Swarm deliberation, Mailbox queues, Turn Ledgers, Watchdog heartbeats, Key Fleet status, Replay traces, and System telemetry.
- **Autonomous Multi-Agent Swarm Coordinator**: Orchestrates 5 specialized agent roles (`orchestrator`, `coder`, `reviewer`, `tester`, `researcher`) with thread-safe Mailbox message leases, Quorum consensus settling, and immutable execution ledgers.
- **OS-Adaptive Command Sandbox**: Hardened execution environment interlocked with ShellGuardian security policies, enforcing containment on macOS (Seatbelt), Linux (Bubblewrap), and Windows (isolated process containment).
- **Incremental AST CodeGraph Watcher**: Zero-latency syntactic symbol extraction and live topology change notifications without full-workspace rescans.
- **Model Key Fleet Monitor**: Multi-provider API key rotation, automated latency and health probing, cooldown tracking, and resilient failover management.
- **Desktop System Tray & Floating HUD**: Global hotkey (`CommandOrControl+Shift+P`) to summon or dismiss the Cockpit HUD over any active code editor, with system tray status and lifecycle management.

## Runtime & Footprint Optimizations

- **Bilingual Dictionary Code-Splitting**: Symmetrically extracted `strings-zh` and `strings-en` behind a lightweight runtime facade, reducing the initial Web App entry bundle from 394.72 kB (136.26 kB gzip) to 80.14 kB (22.75 kB gzip) — an **80% reduction** in initial script payload.
- **Desktop Bundle Deduplication**: Enabled bundle code splitting in the desktop tsup pipeline, extracting duplicated third-party dependencies into common chunks and reducing the raw desktop distribution footprint by **7.0 MB (32.8% reduction)** while accelerating build times by 3.5x.
- **Settled-Turn Chat Memoization**: Implemented memoized render boundaries with WeakMap render-state tracking across `MessageItem` and `WorkGroup`, eliminating redundant transcript re-renders during active token streaming.
- **JSON Transport Compression**: Scoped Hono gzip/deflate compression to API JSON responses above 1 KB, keeping SSE streaming channels completely unbuffered.
- **Topology Canvas Rendering**: Throttled canvas pan updates with `requestAnimationFrame` and implemented Level-of-Detail (LOD) zoom thresholds to skip secondary labels, markers, and blur filters when zoomed out.

## Requirements

Linux or macOS on x64 or arm64, or Windows 10+ on x64.
