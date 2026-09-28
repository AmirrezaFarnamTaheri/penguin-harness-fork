# Four fixes that were keeping a keyboard user out of parts of the app

- **Date:** 2026-09-27
- **Type:** fix
- **Scope:** `web`

[中文版](2026-09-27-keyboard-reachability.zh.md)

A surface audit of the whole app turned up four places where a keyboard could not go. The worst of them was not a missing affordance — it was a control that was invisible to a keyboard at all, in a place with no alternative route.

## Details

- **The focus ring was 1.70:1 against white** — less than a third of the 3:1 that WCAG 2.2 SC 1.4.11 requires for non-text contrast, in both themes, on every focusable element in the app. It was a hardcoded `rgb(107 114 128 / 0.4)`, gray-500 at 40% alpha, under a comment that called it "soft brand-colored". It was not brand-colored, which is how a value that fails by a factor of two survived review. It is now `var(--accent-bg)` — the token the stylesheet's own comment already documented this ring as using — which measures 17.7:1 in the neutral light theme, 19.1:1 on the dark base and 5.2:1 for the blue accent preset, and follows the user's chosen accent, which a hardcoded value could not.
- **A week view of the calendar had 168 create targets no keyboard could reach.** The twenty-four hour cells of each day column were `<div onClick>`: in a week that is seven columns, so a hundred and sixty-eight places to create an event that a keyboard simply could not get to, and that a screen reader was never told existed. They are now real buttons under a **roving tabindex** — one tab stop per day column, the arrow keys walking the hours from there. Turning all hundred and sixty-eight into ordinary tab stops would have replaced one failure with a worse one. The month cell had the same defect and gets the same treatment: because the cell holds the day's chips, it cannot itself be the button, so the control is a real button covering the cell's top strip.
- **A ticket card was a button inside a button.** The card carried `role="button"`, `tabIndex={0}` and an Enter/Space handler, and contained a real `<button>` for the assignee. That is invalid HTML and an invalid accessibility tree (SC 4.1.2): assistive technology was shown one control where the markup declared two, and the inner one was unreachable. The role now lives on a real button that covers the card, sitting beneath the card's own content so clicks land exactly where they did.
- **There is now a skip link.** The sidebar is a column of roughly forty focusable stops before the page's first control, so a keyboard user opening the app landed in the navigation every time. The link is off-screen until focused, needs no state and no extra CSS, and takes the same focus ring as every other control. Its target carries `tabIndex={-1}`, without which a fragment link scrolls to a non-focusable element, drops focus on `<body>`, and the next Tab starts over from the top — the exact thing the link exists to prevent.
