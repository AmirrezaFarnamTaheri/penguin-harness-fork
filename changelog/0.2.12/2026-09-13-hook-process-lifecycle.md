# Hook cancellation waits for process cleanup

- **Date:** 2026-09-13
- **Type:** fix
- **Scope:** `core`

[中文版](2026-09-13-hook-process-lifecycle.zh.md)

Script hooks now terminate the process group on POSIX or the live process tree on Windows when cancelled or timed out, and wait for output pipes to close before returning the interruption. This prevents callers from removing a working directory while the hook still holds it open. Inputs are serialized before spawning, and cancellation during serialization prevents execution.

Command tests now wait for completion or observable readiness where output is required. The inherited-pipe regression retains its two-second drain limit, measured after foreground output arrives so cold shell startup does not distort it.
