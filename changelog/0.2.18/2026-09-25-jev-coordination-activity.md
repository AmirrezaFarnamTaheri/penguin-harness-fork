# Show Jev advisories and coordination activity in the Web App

- **Date:** 2026-09-25
- **Type:** feature
- **Scope:** `web`, `docs`

[中文版](2026-09-25-jev-coordination-activity.zh.md)

The Web App now renders the advisory observations the [Jev advisor](2026-09-25-jev-advisory.md) emits, and the agents dock gained an **Activity** tab that puts them in chronological order beside the records actually produced. Both surfaces read the existing stream, so nothing is fetched twice and nothing is invented.

## Details

- A `jev_advisory` hook event becomes a typed item in the stream model; any other hook name, or a malformed payload, is ignored as before. The item carries no decision field, so an advisory can never be mistaken in the UI for an approval outcome.
- The advisory card shows status, tool fit, confidence, risk, approval probability, latency, tokens, model, and a bounded reason, or a plain unavailable state when the advisor produced nothing. It states in the interface that the observation is advisory only, in both languages.
- The **Activity** tab collects advisories, tool records, parent-agent steering, and child-session events in stream order across the selected conversation and its nested models. It never files an advisory under a tool it did not name, and the log is a semantic `role="log"` live region so updates are announced rather than read out mid-sentence.
- The tab reuses the dock's existing mobile and desktop placement behavior; switching Sessions returns to the **Conversation** tab.
