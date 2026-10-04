# Changelog

[中文版](CHANGELOG.zh.md)

Published versions below retain their original dates and links to detailed release notes.
Unreleased entries describe the current candidate and are not a new published version.

## Unreleased — 2026-10-04

### Documentation

- Rebuilt the delivery plan, task register, and work orders around the reviewed PR #15 baseline.
- Preserved all 150 original Phase R/Waves 1–4 IDs, card contracts, and dated evidence.
- Corrected stale status claims, aligned completion checkboxes, and separated current release
  repairs from historical CI incidents.
- Removed superseded planning copies; their source remains available through pinned Git history.
- Clarified CodeGraph/Serena freshness, task ownership, acceptance, and documentation updates.

### Runtime fixes in the local candidate — acceptance pending

- Session deletion retains files and returns a typed retryable failure while owned handlers or
  runtime disposal remain unresolved; disposal retries and shutdown retain cleanup ownership.
- Credential masking handles short and incomplete quoted JSON values in trace fallback reads.
- Measured low-disk refusal survives unavailable or failed durable override authorization.
- Pressure grants use unique IDs and locked reload/mutate/save transactions across store instances.
- The POSIX parent-death guardian validates an inherited ownership nonce on current group
  members before signalling, including surviving descendants after their leader exits.

### Release gates

- Corrected-candidate CI and review acceptance remain pending; no merge has been recorded.
- One high desktop build-dependency advisory remains open. The audit names a patched range,
  but the registry query did not find version 4.2.1.
- Windows parent-death Job Object ownership and commands that remove the POSIX ownership
  environment retain their documented limits.

## Published releases

- **0.2.18** — 2026-09-28. Hardened research/spend accounting, process ownership, image validation, provider health, cockpit cursors, command detection, ACP recovery, CLI lifecycle, and keyboard/pointer interactions. ([details](changelog/0.2.18/))
- **0.2.17** — 2026-09-24. Repaired agent runtime, providers, sandbox boundaries, cockpit, CLI, and release tooling, with follow-up correctness fixes and cross-platform coverage. ([details](changelog/0.2.17/))
- **0.2.16** — 2026-09-19. Integrated donor tracks into eight platform planes, added codegraph/memory/prompts exports and cockpit consumers, and corrected audit and platform behavior. Five unavailable donor archives remained explicitly unported. ([details](changelog/0.2.16/))
- **0.2.15** — 2026-09-17. Separated measured context occupancy from prompt estimates and cumulative usage; carried agent names and descriptions into the interface. ([details](changelog/0.2.15/))
- **0.2.14** — 2026-09-16. Introduced the unified Agent Cockpit telemetry surface across swarm, mailbox, turns, watchdogs, keys, traces, and system signals. ([details](changelog/0.2.14/))
- **0.2.12** — 2026-09-13. Integrated company mode, evaluations, and AI-assisted creation; hardened sandbox, persistence, publishing, startup, authentication recovery, and keyboard access. ([details](changelog/0.2.12/))
- **0.2.11** — 2026-09-10. Rebuilt 0.2.10 with electron-builder 26.16.1 to restore signed macOS installers. The earlier 0.2.10 publish reached npm and Docker Hub but did not produce installers or a Release page. ([details](changelog/0.2.11/))
- **0.2.10** — 2026-09-10. Added a two-pane Files browser, lazy directory tree, version-checked editing, and drag-and-drop file uploads. ([details](changelog/0.2.10/))
- **0.2.9** — 2026-08-28. Added catalog pricing and discounts, TokenDance presentation, WeChat messaging, remote Machines installation, and shared update notices. ([details](changelog/0.2.9/))
- **0.2.8** — 2026-08-27. Enabled Feishu/Telegram file and image exchange and in-conversation file delivery. ([details](changelog/0.2.8/))
- **0.2.7** — 2026-08-27. Fixed desktop messaging SDK integration, CLI self-upgrade ownership, missing-workspace errors, shell fallback, recall, and packaging/database compatibility checks. ([details](changelog/0.2.7/))
- **0.2.6** — 2026-08-27. Added Flash models, TokenDance key authorization, steerable subagents, the HTTP/SSE CLI, channel binding, context breakdown, update controls, and kernel configuration updates. Version 0.2.5 published to npm but produced no installers or GitHub Release. ([details](changelog/0.2.6/))
- **0.2.4** — 2026-08-21. Added model/provider presets, docked panels and persistent terminals, background execution, command policy, usage charts, memory import/export, settings, and packaged desktop environment loading. ([details](changelog/0.2.4/))
- **0.2.3** — 2026-08-19. Added Session forking, queued-message recall, live sidebar status, compaction recovery, model switching, attachment drops, and in-place updates. ([details](changelog/0.2.3/))
- **0.2.2** — 2026-08-11. Added long-term Memory, MCP management, editable subsystem prompts, configuration kernel updates, runtime hardening, and paged trace storage. ([details](changelog/0.2.2/))
- **0.2.1** — 2026-08-04. Added the Electron desktop app, signed-in startup, shared data roots, installers, downloads, update checks, compaction recovery, authentication throttling, and project defaults. ([details](changelog/0.2.1/))
- **0.2.0** — 2026-08-03. Added sealed online/offline installer bundles, mirrored downloads, recoverable truncated output, long-conversation navigation, reload-safe steering, and paged Session lists. ([details](changelog/0.2.0/))
- **0.1.5** — 2026-07-30. Added offline installers for five platforms, Windows MinGit, composer attachments, LLM failure recovery, prompt reductions, and the refreshed web design. ([details](changelog/0.1.5/))
- **0.1.4** — 2026-07-27. Published the 0.1.3 feature set to npm after its earlier publish failure and moved blog images to the community repository. ([details](changelog/0.1.4/))
- **0.1.3** — 2026-07-27. Added Windows support, goal mode, subagent call graphs, reconnect countdowns, version display, and administrative update checks. ([details](changelog/0.1.3/))
- **0.1.2** — 2026-07-26. Added file tools and edit diffs, mid-run steering, queued follow-ups, model handoff, free OpenRouter models, and isolated HTML previews. ([details](changelog/0.1.2/))
- **0.1.1** — 2026-07-22. Added Gemini models, workspace-grouped navigation, in-place updates, and local model/fine-tuning/presentation skills. ([details](changelog/0.1.1/))
- **0.1.0** — 2026-07-21. Introduced the Web App, landing/docs sites, model catalog, and self-improvement skills. ([details](changelog/0.1.0/))
- **0.0.1** — 2026-07-19. First tagged release; detailed changelog history begins after this tag.
