# Performance profile: PenguinHarness 0.2.12 candidate

## Build baseline

- The complete production build passed for all 25 non-root workspaces.
- Web initial JavaScript: 2,139.03 kB minified / 639.51 kB gzip.
- Docs initial JavaScript: 1,447.87 kB minified / 531.12 kB gzip.
- Landing initial JavaScript: 1,122.15 kB minified / 388.49 kB gzip.
- Core ESM entry: 842.10 kB; server ESM entry: 1.30 MB.
- Core declaration generation took about 88 seconds on the Windows review host and dominated build latency.

## Runtime-focused checks

- Adaptive tool exposure benchmark passed at 10, 50, and 100 tools with a fixed 328-token gateway surface and 100% recall@1/recall@5 over 16 curated queries.
- The HMR concurrency seam passed 11/11 focused tests. Upgrade draining is bounded to five seconds and adds no steady-state request delay beyond the existing asynchronous gate.
- Frontend unit validation passed 162 files and 2,172 tests.

## Bottlenecks

1. The web router statically imports every major route, producing a 639.51 kB gzip initial bundle for login and basic chat users.
2. Docs and landing also exceed Vite's 500 kB minified chunk warning.
3. `.agents/` contributes 6,319 tracked files and about 64.4 MiB to Docker's `COPY . .` context despite not being used by the image build or runtime.
4. npm release publication performs sequential registry queries for each package. This is release latency rather than application runtime latency and preserves deterministic dependency ordering.

## Release assessment

No measured runtime-performance regression alone blocks 0.2.12. Initial bundle size and Docker context size are concrete optimization targets.
