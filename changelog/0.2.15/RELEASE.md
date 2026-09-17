PenguinHarness fork 0.2.15 fixes context occupancy reporting and agent attribution, and connects more Cockpit panels to live project data.

## Changes

- Context badges report the last request's measured occupancy separately from estimated prompt composition and cumulative session usage.
- Agent names and descriptions appear in the interface. Prompts, steering messages, and file edits retain their agent attribution.
- Guardian displays HMAC-verified tool execution receipts, with separate owning and executing session labels. Older receipts without execution provenance are marked unknown.
- Coordination panels show live mailbox queues, task handoffs, and quorum state, with English and Chinese labels and dialogs.
- The task board supports TOML schedule management. Trace inspection, snapshot archives, memory search, replay controls, and machine health panels use their corresponding runtime data sources.
- Configured subagent model cascades survive cross-agent session revival, and combo targets retain their configured tiers. Normal child sessions remain capped at one subagent level.
- Additional regression coverage checks project isolation, trace identity, loop detection, interface signatures, narrow layouts, and bilingual dictionary parity.

## Scope notes

Desktop prerelease updates require explicit opt-in through `PENGUIN_UPDATE_ALLOW_PRERELEASE`; this release does not add named stable/canary channel switching. Workflow canvas and query partition views are read-only. Landing-page benchmark claims remain blocked until their provenance is supplied; no new performance claims are made here.

## Install

Download this fork's GitHub Release assets for Linux or macOS (x64/arm64), or Windows (x64). Platform archives include the required runtime; the universal archive requires Node.js 24 or newer. Fork desktop builds are unsigned. This fork does not publish the upstream npm packages, OSS mirror, or Docker images.
