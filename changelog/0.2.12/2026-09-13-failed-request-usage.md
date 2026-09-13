# Preserve reported usage from failed requests

- **Date:** 2026-09-13
- **Type:** fix
- **Scope:** `core`, `server`, `web`, `cli`

[中文版](2026-09-13-failed-request-usage.zh.md)

Failed model attempts now retain provider-reported token consumption on their request-end events. Usage records, trace totals, and conversation statistics include that consumption across retries and paginated history. Successful requests remain counted once, and failed consumption does not replace the committed context measurement. Attempts without a provider usage report retain unknown consumption rather than estimating tokens.
