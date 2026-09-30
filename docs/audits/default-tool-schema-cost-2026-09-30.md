# Default tool-schema cost measurement — 2026-09-30

## Result

The two newly configured tools, `knowledge_graph` and `code_graph`, add **4,704 serialized
characters**, or **1,176 chars/4 estimated tokens** (1,179 tokens using Penguin's production
`approximateTokens()` estimator). This is below the plan's 1,500-token review threshold, so no
schema trimming or task-success study is warranted by this measurement.

| Exposure | Fixture | Schemas | Characters | UTF-8 bytes | Chars/4 estimate | Runtime estimate |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Direct, before | Current default config minus the two measured tools | 9 | 13,702 | 13,730 | 3,426 | 3,436 |
| Direct, after | Current default config | 11 | 18,405 | 18,439 | 4,602 | 4,614 |
| Direct, added | `knowledge_graph` + `code_graph` schemas | 2 | 4,704 | 4,710 | 1,176 | 1,179 |
| Lazy, before | Fixed `search_tools` + `call_tool` gateway | 2 | 1,309 | 1,309 | 328 | 328 |
| Lazy, after | Same fixed gateway with both tools in the private catalog | 2 | 1,309 | 1,309 | 328 | 328 |

Lazy search returns each selected tool definition on demand. In this fixture, the serialized
`search_tools` result is 3,395 characters / 849 chars/4 (851 runtime-estimated tokens) for
`knowledge_graph`, and 1,744 characters / 436 chars/4 (437 runtime-estimated tokens) for
`code_graph`. These are conditional search-result costs, not part of the fixed gateway schema.

## Method and limits

- Run `pnpm exec tsx tools/measure-default-tool-schema.mts` from the repository root.
- Both fixtures use this checkout's `defaultSystemConfig()`; “before” removes only the two named
  tools. The script verifies that every configured direct tool is exposed and that the lazy
  gateway definitions are byte-for-byte unchanged.
- `Environment.listTools()` definitions are serialized with compact `JSON.stringify`. Counts
  include schema names, descriptions and parameters, but exclude provider request envelopes,
  system prompts, and MCP servers. The fixture covers the 11 configured defaults, not every
  registered builtin factory or user-configured tool.
- Chars/4 is `ceil(UTF-16 character count / 4)`. The runtime number uses the existing production
  `approximateTokens()` estimator. No provider-specific tokenizer dependency is installed, so
  these are estimates rather than provider token counts.
- Results are tied to the recorded checkout's descriptions and schemas. Rerun the script after
  default schema changes; do not treat the values as a permanent API limit.
