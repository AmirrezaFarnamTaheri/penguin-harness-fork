PenguinHarness fork 0.2.16 lands the full HPORT donor porting convergence: eleven donor tracks resolve into eight second-order platform planes, each with a real source barrel and its own test suite, and the platform's own loop gains a repeat-tool guard with a runtime caller.

## Changes

- The HPORT donor corpus is fully ported. 123 tracked archives resolve to 118 ported and 5 genuinely absent from disk, now recorded as `absent` rather than silently reported complete. The eleven tracks map onto eight platform planes — agent-OS core, multi-agent swarm and consensus, code topology and self-healing, universal tool mesh and identity, vector and visual cockpit, scientific discovery, zero-trust sandbox, and the headless terminal — and `codegraph`, `memory` and `prompts` are root exports, tsup entries and package `exports` paths.
- `RepeatToolGuard` now has a runtime caller. It observes the approved-call path in the ReAct loop (a denied call never ran, so it is not loop evidence), JSON-parses arguments first so key order cannot defeat the deep comparison, and delivers its reminder as a message appended after the turn's tool outputs, non-blocking by construction. A fresh task boundary resets the chain.
- Capabilities restored to this branch: the server audit read path (HMAC-verified receipts with a bounded byte window), quorum mutation routes and the read-only schedule-to-kanban projection, memory search, the web loop-event feed with its guardian audit panel, and the Windows `taskkill /T /F` process-tree force-kill.
- Correctness fixes across the ported code: per-language comment syntax and Go parameter names in codegraph, filter-before-topK retrieval push-down, idempotent and transactional graph re-ingest, UTF-8 FNV-1a hashing, injection-marker rejection at `register()`, and an inverted absent-archive check in tracking.
- Four tests that passed only on Windows and failed on the Linux and macOS CI shards are fixed: environment info now honours its injected facts when translating paths instead of reading the live kernel, the fleet audit's temp filename is unique per write so two records flushing the same trail no longer race into `ENOENT`, and the browser zombie sweep is scoped to its own process group and waits for the killed process to actually exit.

## Scope notes

The five absent archives are missing from the donor disk and are reported as such; they are not silently marked complete. Desktop prerelease updates require explicit opt-in through `PENGUIN_UPDATE_ALLOW_PRERELEASE`; this release does not add named stable/canary channel switching. Fork desktop builds are unsigned. This fork does not publish the upstream npm packages, OSS mirror, or Docker images.

## Install

Download this fork's GitHub Release assets for Linux or macOS (x64/arm64), or Windows (x64). Platform archives include the required runtime; the universal archive requires Node.js 24 or newer.
