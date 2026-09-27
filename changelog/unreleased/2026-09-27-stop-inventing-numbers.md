# Stop the interface from stating numbers nothing backs

- **Date:** 2026-09-27
- **Type:** fix
- **Scope:** `web`

[English](2026-09-27-stop-inventing-numbers.md) · [中文](2026-09-27-stop-inventing-numbers.zh.md)

A surface audit turned up four places where the interface asserted something the data behind it did not support. One of them was a type lying about the wire, which had taught the mapper to invent zeros.

## Details

- **Every snapshot row claimed "0 state files" and "0 memory topics."** `SnapshotVersionInfo` declared `fileCount`, `memoryTopicsCount` and `activePromptHash`, and the live mapper filled all three in with `0`, `0` and `""` — because the server has never returned any of them. The only `fileCount` in the API belongs to `MemoryScopeInfo`, a different type about a different directory. So a project with real Agent State was shown a confident zero for it, on every row, forever. The three fields are gone from the type, the mapper maps only what arrives, and the timeline shows the size it has always had. A type that promises a field the wire never carries is worse than a missing one: it hides the gap from the compiler and from the next reader.
- **The snapshot summary line now opens with "Sample data."** The rest of that line was self-consistent about a placeholder dataset; the file and memory counts inside it were not, and are gone.
- **The skills search box promised "2,400+ skills."** A hardcoded marketing number with nothing behind it, on a page that lists whatever the user has actually installed — and the one place a reader would most expect a number to be true. It now searches without claiming a size it cannot know, and carries an accessible name.
- **The gateway's "Router v2 Active" badge could not become untrue.** It was a hardcoded string with no data source behind it, which is the opposite of what a status badge is for. There is no version field on the gateway response to bind it to, so it is gone rather than invented.
- **An unknown quota value was rendered in green.** "Next Reset Window" showed `N/A` in the same green as a healthy reading, so a value nobody reported looked like a value that was fine. It now takes the same ink as the two honest N/A tiles beside it: a missing value and a good value must not share a colour. A `bg-purple-500` progress bar in the same tile went to the accent token — the app declares one accent, and this was the only purple left in the feature.
