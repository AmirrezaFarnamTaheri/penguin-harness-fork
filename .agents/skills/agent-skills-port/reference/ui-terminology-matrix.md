# UI Terminology Cross-Platform Matrix (Web ↔ iOS ↔ Android)

Translate Web UI component names into the nearest iOS / Android equivalents. Web column follows HTML/MDN + WAI-ARIA APG, iOS follows Apple Human Interface Guidelines (HIG), Android follows Material 3 / Jetpack Compose component names.

Use this matrix at `BLUEPRINT` when writing per-screen specs, parity matrices, or handoffs to `Native` — naming each control in the target platform's vocabulary prevents spec drift (e.g. a "modal" spec that a native engineer implements as the wrong surface). Pair with `platform-ux-adaptation.md` for behavioral adaptation; this file covers **naming** only.

**Correspondence:** ◎ near-synonym / ○ close / △ context-dependent / — no standard component (custom)

## Conversion Matrix

| Category | Web term | iOS term | Android term | Match | Conversion notes |
|----------|----------|----------|--------------|:-----:|------------------|
| Screen structure | Page / Route / View | Screen / View / View Controller | Screen / Activity / Fragment / Composable | ○ | Design-level term is "screen"; implementation unit differs per OS. |
| Top bar | Header / App bar / Top nav | Navigation bar / Toolbar | Top app bar | ○ | **"Navigation bar" is a trap term** — iOS: top navigation area; Android Material: bottom view switcher. Android's top bar is Top app bar (title + primary actions + navigation items). |
| Bottom tabs | Bottom navigation / Tab bar | Tab bar | Navigation bar / Bottom navigation | ◎ | iOS Tab bar = top-level section navigation; Android M3 Navigation bar = view switching on small screens. |
| Side nav | Sidebar / Side navigation | Sidebar / Split view | Navigation drawer / Navigation rail | ○ | iPad uses Sidebar; Android splits into drawer (hidden) vs rail (persistent). HIG Sidebar sits at the leading edge for top-level collections. |
| Drawer | Navigation drawer / Drawer menu | Sidebar / Sheet / custom Drawer | Navigation drawer | ○ | Standard on Android. On iOS, redesign as Sidebar or Sheet rather than a literal drawer. |
| Breadcrumb | Breadcrumb | Back button / Navigation stack | Up navigation / Back navigation | △ | Web shows hierarchy inline; mobile replaces it with back navigation. |
| Tabs | Tabs / Tablist / Tab panel | Segmented control / Tab view / Tab bar | Tabs | ○ | Web/Android content-switching tabs usually become a **Segmented control** on iOS. iOS Tab bar is top-level nav — do not conflate. |
| Segments | Segmented control / Button group | Segmented control | Segmented button | ◎ | View switching, filters, sorting among closely related options. |
| Toolbar | Toolbar | Toolbar | Top app bar / Bottom app bar / Toolbar | ○ | Web: container of actions. iOS: control groups at top/bottom edges. Android overlaps with App bar family. |
| Menu | Menu / Dropdown menu | Menu / Pull-down button / Context menu | Menu / DropdownMenu | ○ | Transient list of choices on a temporary surface (Material Menus). |
| Overflow | More menu / Kebab menu | More button / Menu | Overflow menu / MoreVert + DropdownMenu | ◎ | "…" or vertical-dots menu; icon orientation and placement differ per OS. |
| Context menu | Context menu / Right-click menu | Context menu | Context menu / Dropdown menu / Contextual actions | ○ | Web: right-click or long-press; mobile: mostly long-press. |
| Button | Button / `<button>` | Button | Button | ◎ | Near-identical. On Web, use semantic `<button>`. |
| Primary button | Primary button / CTA | Prominent button / Primary action | Filled button | ○ | Names differ per design system; map by role ("most important action"), not look. |
| Secondary button | Secondary button | Button / Bordered button | Outlined button / Text button | ○ | Map by emphasis hierarchy, not visual style. |
| Icon button | Icon button | Icon button / Bar button item | Icon button | ◎ | iOS nav-bar buttons are implemented as Bar button items. |
| FAB | Floating action button | none standard / custom floating button | Floating action button / FAB | △ | Android: high-emphasis primary-action button. iOS has no standard FAB — move the action into the Toolbar / Navigation bar instead. |
| Link | Link / Anchor | Link / Text link | Text link / Clickable text / Text button | ○ | Web links navigate pages; on mobile, keep the link-vs-button role split explicit. |
| Text input | Text input / Text field / `<input type="text">` | Text field | Text field | ◎ | HIG Text field: rectangular area for small, specific text entry. |
| Multiline input | Textarea | Text view | Multiline text field | ○ | iOS: Text field = short text, Text view = long / multiline. |
| Search field | Search field / Search box | Search field / Search bar | Search / Search bar | ◎ | HIG Search field searches a content collection by entered terms. |
| Select | Select / Dropdown / Listbox | Picker / Menu / Pop-up button | Exposed dropdown menu / Menu | ○ | Web `select` → iOS Picker, Android Exposed dropdown / Menu. |
| Combobox | Combobox / Autocomplete | Combo box / Search field + suggestions | Exposed dropdown / Autocomplete text field | ○ | Input + suggestion selection. Web: ARIA combobox; mobile: usually search-suggestion UI. |
| Checkbox | Checkbox | Checkbox / Toggle / Checkmark list | Checkbox | ○ | Standard multi-select on Web/Android. iOS: setting ON/OFF → Toggle; list multi-select → checkmark rows. |
| Radio button | Radio button / Radio group | Segmented control / Picker / Checkmark list | Radio button | △ | iOS rarely uses literal radio buttons — substitute Segmented control or Picker. |
| Switch | Switch / Toggle | Toggle / Switch | Switch | ◎ | Binary ON/OFF state. HIG Toggle represents two mutually exclusive states. |
| Slider | Slider / Range input | Slider | Slider | ◎ | Continuous or stepped value in a range (APG Slider pattern). |
| Stepper | Spinbutton / Number input stepper | Stepper | weak standard / custom stepper | △ | iOS has a Stepper. Material 3 lacks a dedicated one — usually number input + ± buttons. |
| Date picker | Date input / Date picker | Date picker / Picker | Date picker | ◎ | Material Date picker handles single dates and ranges. |
| Time picker | Time input / Time picker | Date picker (time mode) | Time picker | ○ | Material has Time pickers; iOS uses DatePicker display modes for time. |
| Color picker | Color input / Color picker | Color well / Color picker | custom color picker | △ | Most standardized on Web; Android tends toward product-specific implementations. |
| File picker | File input / Upload | Document picker / Photo picker / Share sheet | Photo picker / System picker | △ | OS permissions and filesystem models differ heavily. |
| Form | Form / Fieldset / Form group | Form / Section / List form | Form / Text field group | ○ | Web: `form` element; iOS: List/Section-based; Android: TextField group in a Column. |
| Label | Label / Form label | Label | Label / Text | ◎ | Web `label` associates with its control (MDN forms model). |
| Validation display | Error message / Helper text | Inline validation / Alert | Supporting text / Error text | ○ | Material Text field pairs naturally with supporting/error text. iOS chooses inline vs Alert by severity. |
| Modal | Modal / Dialog | Sheet / Alert / Full-screen cover | Dialog / Modal bottom sheet | ○ | Decompose Web "modal" by purpose: iOS → Sheet/Alert/Cover; Android → Dialog/Bottom sheet. |
| Dialog | Dialog / Modal dialog | Alert / Sheet / Popover | Dialog / AlertDialog | ○ | APG: window layered over the main window. Material Dialogs = important prompts. |
| Alert | Alert / Alert dialog | Alert | AlertDialog / Dialog | ◎ | Critical info, confirmations, destructive-action checks (HIG Alerts). |
| Action sheet | Action sheet / Bottom action menu | Action sheet / Sheet | Modal bottom sheet / Bottom sheet | ○ | iOS Action sheet presents multiple actions; Android maps to Bottom sheet. |
| Bottom sheet | Bottom sheet | Sheet / Action sheet | Bottom sheet / ModalBottomSheet | ○ | Standard on Android; on iOS convert to Sheet or Action sheet. |
| Popover | Popover / Floating panel | Popover | Dialog / DropdownMenu / Tooltip / custom | △ | Popover is natural on iPad. Android decomposes by purpose into Dialog / Menu / Tooltip. |
| Tooltip | Tooltip | Help text / Popover / Contextual hint | Tooltip | ○ | Explicit Tooltip exists on Web/Android. iPhone lacks persistent hover — use other affordances. |
| Toast | Toast / Snackbar | none standard / Inline message / custom Banner | Snackbar / Toast | △ | Snackbar is Material-standard. iOS has no HIG Toast — split by severity into inline message / Alert / notification. |
| Snackbar | Snackbar / Toast | none standard / custom Banner | Snackbar | △ | Material Snackbar: brief update at the bottom of the screen. |
| Badge | Badge / Counter | Badge | Badge | ◎ | Notification counts, status, unread counts (Material Badges). |
| Progress | Progress bar / Spinner | Progress indicator / Activity indicator | Progress indicator | ◎ | iOS: Progress / Activity indicator (indeterminate); Android: linear/circular progress indicator. |
| Loading | Loading spinner / Skeleton | Activity indicator / Placeholder | Circular progress / Linear progress / Placeholder | ○ | Skeleton screens are design-system-dependent on every platform. |
| Card | Card | Card-style container / Grouped list / custom | Card | ○ | Material Card is standard. iOS uses "card" informally — decompose into List/Group/Sheet as actual components. |
| List | List | List / Table | List / LazyColumn | ◎ | HIG Lists and tables present data in one or more columns of rows; Material Lists are vertical indexes. |
| Table | Table / Data table | Table / List | custom data table / List | ○ | Web is strongest at tabular layout; mobile usually collapses to cards/lists. |
| Grid | Grid / Gallery | Collection / Grid | Grid / LazyVerticalGrid | ○ | iOS: Collection view; Android: Lazy grid family. |
| Carousel | Carousel | Collection view + Page control / Page view | Carousel / Horizontal pager | ○ | iOS pairs paging with Page control; MDN documents CSS carousels for Web. |
| Pager | Pagination / Pager / Page indicator | Page control | Pager indicator / HorizontalPager | ○ | iOS: Page control. Android names lean implementation/library-side rather than Material-standard. |
| Accordion | Accordion | Disclosure group / Disclosure control | Expandable list / custom Expansion panel | ○ | APG Accordion = stacked collapsible headings; mobile implements as expandable lists. |
| Disclosure | Disclosure / Show-hide | Disclosure control / Disclosure group | Expandable item | ○ | "Show details" UI; iOS Disclosure control toggles visibility. |
| Divider | Divider / Separator / `<hr>` | Separator / Divider | Divider / HorizontalDivider | ◎ | Material Dividers: thin lines grouping content in lists/containers. |
| Chip | Chip / Tag / Pill | Token / custom Tag | Chip | ○ | Material Chip is standard; iOS tends toward Token fields or custom Capsule views. |
| Token input | Token field / Tag input | Token field | Chip input / custom chips | ○ | Email recipients, tag entry, etc. |
| Image | Image / Figure | Image view | Image | ◎ | HIG Image view scales/positions images and is typically non-interactive. |
| Status bar | Browser chrome / System status area | Status bar | Status bar / System bars | ○ | OS/browser territory rather than in-app UI; iOS Status bar shows time, signal, battery. |

## Top 5 Mistranslations

1. **"Navigation bar" diverges across OSes.** iOS: top area with back / title / actions. Android M3: bottom view-switching nav. Always say **Top app bar** for Android's top bar.
2. **Web/Android Tabs ≠ iOS Tab bar.** Tabs switch content within a screen; iOS Tab bar moves between top-level sections. For in-screen switching on iOS, reach for **Segmented control** first.
3. **Web "Modal" decomposes on iOS.** Critical confirmation → Alert; task/input → Sheet; auxiliary floating content → Popover. Specify the target surface explicitly in the blueprint.
4. **Do not force a FAB onto iOS.** Android's FAB is the standard primary-action pattern; iOS expresses the same action via Navigation bar / Toolbar / Tab bar actions or an in-screen button.
5. **Checkbox / Radio button rarely port literally to iOS.** ON/OFF → Switch/Toggle; small exclusive set → Segmented control; many-item multi-select → List + checkmarks. APG defines Checkbox, Radio group, and Switch as separate patterns.

## Sources

- WAI-ARIA APG Patterns — https://www.w3.org/WAI/ARIA/apg/patterns/
- MDN: Forms and buttons in HTML — https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Structuring_content/HTML_forms
- MDN: CSS carousels — https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Overflow/Carousels
- Apple HIG: Tab bars / Sidebars / Segmented controls / Toolbars / Text fields / Search fields / Toggles / Alerts / Action sheets / Sheets / Progress indicators / Lists and tables / Image views / Status bars — https://developer.apple.com/design/human-interface-guidelines/
- Material 3 in Compose — https://developer.android.com/develop/ui/compose/designsystems/material3
- Compose Material Components (App bars / FAB / Date & Time pickers / Snackbar / Badges / Dividers) — https://developer.android.com/develop/ui/compose/components
- Material 3 Menus — https://m3.material.io/components/menus/overview
