PenguinHarness fork 0.2.12 adds company and evaluation workflows, expands the plugin library, and includes the startup, accessibility, dependency and publishing fixes completed during release review.

## Install

Use this fork's release assets when available. The npm packages under `@prismshadow` and `@penguinharness`, and the `hiyouga/penguinharness` Docker image, are upstream distribution channels; this fork's version does not establish that an equivalent build is published there.

## Highlights

- Company mode coordinates organizations of Agents through calendars, tickets, channels, and shared project state.
- The Evaluation Center creates and optimizes reusable Benchmarks, while Agents, Models, and Vault entries gain guided AI-assisted creation.
- The integrated plugin library adds focused development, tuning, data, sandbox, and workflow packages with normalized names and runtime aliases.
- Persistence, process ownership, worktree isolation, credential redaction, HTTP validation, and sandbox execution now enforce stronger concurrency and security invariants.
- Model catalogs, gateway routing, pricing, proxy health, and tool exposure handle invalid and unknown states more explicitly.

## Notable in this release

- Release tags enter shell steps through environment variables, and npm publication stops on registry failures or malformed responses while remaining safe to retry.
- Route-level loading reduces the initial Web App bundle; startup and authentication failures now show a retryable status instead of a blank page or a false sign-out.
- Shared selects, mobile sheets and toast messages gained keyboard focus and assistive-technology behavior, backed by focused regression tests.
- The test toolchain moved to Vitest 4.1.11, and the prepared dependency lockfile reports no known advisories.
- API key rotation includes health telemetry and a Windows Git Bash resolver.
- The file browser, sidebar, Trace summaries, background-tool controls, system prompt, and responsive form controls received targeted usability fixes.
- SpexCode joins the built-in plugin set, and the skill corpus now has deterministic auditing, normalization, alias synchronization, and quarantine rules.

## Requirements

Linux or macOS on x64 or arm64, or Windows 10+ on x64. Desktop and installer bundles include their runtime; npm installation requires Node 24 or newer.

Full detail: [changelog/0.2.12/](https://github.com/AmirrezaFarnamTaheri/penguin-harness-fork/tree/main/changelog/0.2.12).
