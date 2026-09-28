# PenguinHarness fork 0.2.18

This release hardens the product paths touched by the post-v0.2.17 review, with particular care around concurrent accounting, process ownership, image decoding, provider state, and live cockpit recovery.

## Install

Download the platform archive from this fork's GitHub Release. Linux and macOS archives are available for x64 and arm64; Windows is available for x64. Platform archives include the required runtime. The universal archive requires Node.js 24 or newer.

## Highlights

- Research and model-spend reservations now remain visible and are reconciled conservatively, including late outcomes and failed verification attempts.
- Idle MCP resources can be released only when the harness can prove ownership of the processes; concurrent sweeps and re-registration no longer act on stale entries.
- Image decoding fails closed when a supported image's dimensions cannot be verified. Command detection now respects quoted operators and Windows paths.
- Provider selection ignores stale asynchronous health results, and cockpit telemetry detects stream gaps and resumes from the last contiguous event.
- Refined keyboard and pointer flows, artifact previews, calendar interactions, chat recovery, CLI shutdown handling, and cross-platform regression coverage.

## Notable in this release

- Research evaluation manifests validate the current model and reporting configuration as well as the source revision.
- ACP connection generations prevent an old transport failure from poisoning a replacement connection.
- Release notes, workspace package manifests, and the core runtime identity agree on 0.2.18.

## Requirements

Node.js 24 or newer is required for source and universal installs. This is a fork release; its desktop installers are unsigned, and the fork's workflow does not publish upstream npm packages, the OSS mirror, or Docker images.

See the [0.2.18 change details](./).
