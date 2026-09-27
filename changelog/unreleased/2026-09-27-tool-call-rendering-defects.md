# Show what two tools were asked for, and show the diff a file write already computed

- **Date:** 2026-09-27
- **Type:** fix
- **Scope:** `web`

[中文版](2026-09-27-tool-call-rendering-defects.zh.md)

A tool card's header could not say what the tool was for, and a file write threw away the diff the core had already computed for it. Both were single-line omissions with the same shape: a value was produced by the core, handed to the renderer, and dropped on the way in.

## Details

- A web search card now shows the query it ran, in the header next to the tool name. The search tool's description — the sentence explaining why this particular search was worth running — was required, recorded on every call, and then never displayed, so a long scroll of searches was a column of identical rows with no way to tell them apart apart from their collapsed results. The same treatment already applied to a shell command's command line now applies to the search's query, chosen per tool rather than assumed: the first argument whose value is a plain string is the one a reader wants.
- A `write_file` or `edit_file` card renders the diff the core produced for the edit. A create or overwrite of a file is where the line-level detail matters most, and it was the one writing path that threw it away — the summary line and trailing notes rendered as a wall of plain text while the diff, already computed and already in the payload, was never shown. The path label is cosmetic and its extraction is deliberately conservative: an unrecognized line falls back to no label rather than to a wrong one, and a failure output with no `@@` hunk still renders as plain text exactly as before.
- One test asserted the old behaviour — that a card with no description renders no subtitle — and was replaced rather than kept. The preview shown on an approval prompt is a separate path and still uses the description only; this change is confined to the settled card.
