# Add a read-only Benchmark evaluation evidence endpoint

- **Date:** 2026-09-25
- **Type:** feature
- **Scope:** `server`, `docs`

[中文版](2026-09-25-benchmark-evaluation-evidence.zh.md)

`GET /api/projects/:p/agents/:a/benchmarks/:benchmarkId/evaluations/:evaluationIndex/evidence` now reports what stands behind a scoreboard entry, re-read from disk instead of copied from the scoreboard. It answers the question the scoreboard cannot: are these numbers still backed by the artifacts that produced them?

## Details

- Every run of the evaluation is returned with its scoreboard score, its Trace shard paths and SHA-256 digests (`verified`, `missing`, `unreadable`, `too_large`), and its token totals with cost at today's prices (`verified`, `missing`, or `uncosted` when the model has no dated price). A per-run `state` of `complete`, `missing_trace`, `missing_usage`, `uncosted`, or `incomplete` is derived from those two sources.
- The agent Trace index is reconciled before the answer is built, so a run whose shard is on disk is not reported missing because an index was stale. Only sessions the Project and the Agent own are resolved, and a shard outside the agent's trace root is reported as unreadable rather than hashed. File count and total bytes are capped, and an over-cap run is reported as `too_large` instead of silently truncated.
- Nothing is written: the scoreboard, the Trace shards, and the usage ledger are read as they are, and a missing or unverifiable artifact is reported as exactly that instead of being backfilled.
- The route is member-readable and returns 404 to outsiders, matching the other Benchmark read routes.
