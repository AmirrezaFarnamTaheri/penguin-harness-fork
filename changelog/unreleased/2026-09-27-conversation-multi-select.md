# Mark several conversations at once, and do the reversible things to all of them

- **Date:** 2026-09-27
- **Type:** feature
- **Scope:** `web`

[中文版](2026-09-27-conversation-multi-select.zh.md)

The conversation list could do everything to one row and nothing to several. Pinning twelve conversations meant twelve right-clicks; filing away a month's worth meant the same. Cmd/Ctrl-click a row now marks it, Shift-click draws a range, and a bar over the list acts on everything marked: pin, unpin, archive, unarchive.

## Details

- A marked conversation is always a conversation you can see. The selection is intersected with the rendered rows on every interaction, so a search query, a collapsed group, a paged folder or a Project switch cannot leave a marked id behind — and a batch action, which reads the selection, therefore cannot archive or pin a row that is not on screen. The count in the bar follows the same rule, which is why a filter that hides the last marked row drops the count to zero and takes the buttons away with it rather than leaving a number that promises an action the list can no longer perform.
- The rows on screen are read from the DOM at the moment of the click rather than collected while rendering, because the render pass does not visit them in display order — a group's folder rows are built before its active list, while the DOM puts the active list first. A Shift-click spanning that boundary would otherwise have marked a set that does not match the span you drew.
- Shift-click replaces the selection with the range rather than adding to it, the way Finder, VS Code and Gmail do: the result is a function of the two rows involved and of nothing before them. The anchor is a position, not a selection, so untoggling a row leaves it where it was; a Shift-click with no anchor left selects one row instead of guessing a range, because a selection that can drive a bulk action should fail towards "less than you pointed at".
- The batch archive fans the single-row request out over the marked rows rather than sending one request carrying an array. The per-id route resolves the row's owner and refuses anything outside the caller's Project, answering 404 for the rest; a batch endpoint would have to re-implement that check per element, and the version that forgot one would file another Project's conversation with a perfectly valid-looking response. Fanning out also means one conversation failing does not undo the other thirty-nine.
- Delete is deliberately not in the batch bar. It is the one batch whose mistake cannot be undone, and putting it beside Pin invites the same reflex that makes a drag-and-drop archive land on the wrong row. Each conversation still goes with its own confirmation naming its own title: four dialogs, and certainty about which one went.
- The bar's controls describe what they WOULD do rather than what is available. "Unpin" appears whenever the selection holds a pinned conversation, and a mixed selection unpins only its pinned half — greying the control out because "not all of them are pinned" would make the mixed case, which is the common one, the one case you cannot do.
- Selection is reachable without a mouse. The row's context menu leads with "Select", and the marked row is the row button itself carrying `aria-pressed` rather than a second control beside it — one row, one tab stop, and the count announced in a live region, because the checkboxes are decorative and the number is the thing a screen reader user needs to hear before pressing Archive.
- Archiving the conversation you are looking at opens the archived folder instead of letting it disappear behind a closed one, and a batch that includes it does the same. Nothing you can see goes missing without a way back.
