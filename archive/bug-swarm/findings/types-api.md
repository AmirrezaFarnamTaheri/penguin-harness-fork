# Types & Public API Surface — bug-swarm findings

Scope: `packages/core`, `packages/server`, `packages/cli`, `packages/web` — exported
types/functions, barrel and subpath exports, `packages/core/src/interfaces/`, and the
`ifaces.json` catalog.

**One premise correction first.** The brief states `packages/server/src/ifaces.json` is
checked in. It is not: `.gitignore:46-47` ignores both `packages/server/src/ifaces.json`
and `dist-ifaces/`, and `scripts/gen-ifaces.mjs`'s own header says *"the table is
generated, not committed: `pnpm typecheck`, the server's `build` and `test`, and
deploy.mjs all regenerate it; `--check` remains for a CI that wants to assert a
committed copy."* So there is no committed copy to diff against, and no drift finding
is possible in that direction. `node_modules` is absent (deps still installing) and
`typescript` is not resolvable, so the generator could not be run either. I instead
audited the generator's *contract* against the source it is meant to project, and the
package boundaries it treats as public.

The codebase is disciplined far beyond the norm for a 300k-line monorepo: most `as`
casts sit behind a real guard (post-validation casts in `agent-config-service.ts`,
`test`-then-`exec` in `diff-graph.ts`, arktype-checked `parseManifest`, the exhaustive
`never` switch in `generative-model.ts`), and the `ServerEvent` union is consumed
correctly on both channels. The unsoundness that remains clusters in one place:
**`JSON.parse(x) as T` followed by a dereference, with the try/catch covering only the
parse** — plus two genuinely exported-but-uninitialized bindings. 12 findings below.

---

### [HIGH] `importGraphJson` casts unvalidated JSON to `WikiGraph` and dereferences it — TypeError on every wiki route
- File: `packages/core/src/state/wiki-engine.ts:508` (crash site), reached via
  `packages/server/src/http/routes/wiki.ts:22`
- Symptom: `JSON.parse(jsonStr) as WikiGraph` asserts the full graph shape, then the
  code checks only `Array.isArray(parsed.nodes)` / `Array.isArray(parsed.edges)` and
  dereferences `n.id` / `e.id`. Two inputs crash:
  - body `null` → `parsed` is `null` typed as `WikiGraph` → `Array.isArray(parsed.nodes)`
    is a property read off `null` → `TypeError: Cannot read properties of null`.
  - body `{"nodes":[null], "edges":[]}` → passes the `Array.isArray` gate →
    `this.nodes.set(n.id, {...n})` reads `n.id` off a `null` element → `TypeError`.
  A non-object element that is *not* null (e.g. `42`) does not throw but silently
  inserts `nodes.set(undefined, {})`, corrupting the graph with `undefined` keys.
- Evidence:
  ```ts
  public importGraphJson(jsonStr: string): void {
    const parsed = JSON.parse(jsonStr) as WikiGraph;
    if (Array.isArray(parsed.nodes)) {
      for (const n of parsed.nodes) {
        this.nodes.set(n.id, { ...n });   // n is WikiNode per the type; nothing at runtime
  ```
  The route-side validator that is supposed to be the gate is a no-op for shape — it
  only asserts parseability and hands the raw string back:
  ```ts
  // packages/server/src/http/routes/wiki.ts:15
  function validateGraphJson(raw: string): string {
    JSON.parse(raw);
    return raw;
  }
  ```
  `ProjectJsonStore.readPath` (`services/project-json-store.ts:327`) returns
  `this.decode(raw)`, so `hydrateWiki` (wiki.ts:20-24) feeds whatever the stored file
  contains straight into `importGraphJson`. Every wiki GET route, and `POST /nodes`
  (which calls `hydrateWiki(current)` inside the mutation, so a bad file also *blocks*
  repairing it), goes through this path. Compare the house pattern six files away:
  `parseLockOwner` (`project-json-store.ts:45-57`) validates every field *then* casts.
- Fix: type the parameter `unknown`, guard before use —
  `if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw …`,
  then per element `if (n === null || typeof n !== "object") continue;` with an
  `isWikiNode`-style predicate that checks `typeof n.id === "string"`. Either widen
  `validateGraphJson` to do this and name it accordingly, or delete it and let
  `importGraphJson` own the validation — the current split validates twice and
  validates nothing.
- Confidence: high (mechanism certain; reachability requires a stored
  `.wiki_graph.json` that is valid JSON but not a well-formed graph — a hand-edit, a
  truncated write, or a downgrade — since the only writer is `exportGraphJson`)

---

### [HIGH] `HmrHost.restore()` dereferences the parsed manifest *outside* its try/catch — a `null` harness.json bricks the platform boot
- File: `packages/server/src/hmr/host.ts:336-342`
- Symptom: the try/catch wraps the read and the parse but not the first use of the
  result. `JSON.parse` happily returns the JSON value `null` (no `SyntaxError`), which
  the cast types as `Manifest`; line 340 then reads a property off it and throws a
  `TypeError` that escapes `restore()`.
- Evidence:
  ```ts
  private async restore(): Promise<void> {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(this.manifestPath, "utf8")) as Manifest;
    } catch {
      return; // nothing committed yet
    }
    if (manifest.platform === undefined && manifest.web === undefined) {  // <- outside the try
  ```
  This contradicts the method's own documented contract, three lines above it:
  *"Any failure is non-fatal: it warns and leaves the runtime to boot the packaged
  default — **a bad persisted version must never brick the runtime.**"* It does:
  `initialize()` (host.ts:294-313) catches, clears `initPromise`, and **rethrows**, so
  the failure is not absorbed — `ensure()` rejects and the platform does not boot.
  Note the sibling reader is safe by accident of a `null` check plus optional chaining
  (`hmr/manifest.ts:78,81` — `if (manifest === null) return null;` then
  `manifest.platform?.bundle`), which is why only `restore()` is reported here.
- Fix: move the shape guard inside the try, or make the parse defensive before use:
  ```ts
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const manifest = parsed as Manifest;
  ```
- Confidence: high (mechanism certain; the trigger is a `harness.json` whose entire
  content is the literal `null` — hand-edit, truncated write, or a future writer
  emitting null — so likelihood is low but the consequence is a boot failure)

---

### [MEDIUM] `packages/web` imports `packages/core`'s **private** source through deep relative paths
- Files: `packages/web/src/features/canvas/vector-canvas.tsx:14,19,26,35,36,46`,
  `…/minimap-radar.tsx:11,12,19`,
  `…/canvas-toolbar.tsx:10`,
  `…/node-inspector.tsx:15`,
  `…/hunk-diff-card.tsx:23`
- Symptom: five web modules reach into core's internal tree with
  `../../../../core/src/canvas/color-space.js`, `…/vector-primitives.js`,
  `…/viewport-culling.js`, `…/bezier-curves.js`, `…/node-graph-layout.js`,
  `…/shape-renderers.js` and `…/terminal/hunk-staging.js`. None of those modules are
  part of core's public surface: `packages/core/package.json`'s `exports` map has no
  `./canvas` entry (0 occurrences of "canvas"), there is no `packages/core/src/canvas.ts`
  barrel, and the root `index.ts` does not re-export `./canvas`. They are unexported
  internals, consumed cross-package.
- Evidence:
  ```ts
  // packages/web/src/features/canvas/minimap-radar.tsx:11
  import { CANVAS_THEMES } from "../../../../core/src/canvas/color-space.js";
  ```
  The two `CANVAS_THEMES as unknown as Record<CanvasThemeKey, ThemeColors>` casts in
  this directory exist *because* the private import is untyped-by-contract — the cast's
  own comment says it drops the `| undefined` that `noUncheckedIndexedAccess` adds.
  This is the only cross-package source reach in the monorepo (`packages/server` and
  `packages/cli` do not do it — verified).
- Fix: either add a `./canvas` subpath to core's `exports` map plus a
  `packages/core/src/canvas/index.ts` barrel that publishes exactly these primitives,
  or move the shared canvas math into a package both depend on. Until then a consumer
  that resolves `@prismshadow/penguin-core` from a published install cannot satisfy
  these imports.
- Confidence: high

---

### [MEDIUM] `parseMemoryScopeDocument` returns `doc as unknown as MemoryScopeExport` after validating 2 of 6 required fields
- File: `packages/web/src/features/agents/memory-transfer.ts:43-63`
- Symptom: the function's declared return type promises a complete
  `MemoryScopeExport` (server definition: `format`, `version`, `scopeKey`, `kind`,
  `exportedAt`, `index`, `files` — `packages/server/src/api/types.ts:1292-1307`), but
  the validator only checks `format`, `version`, that `files` is an array of
  `{name,content}`, and `index` *only when `files.length === 0`*. `scopeKey`, `kind`
  and `exportedAt` are never inspected, and `index` is unconstrained whenever the
  document carries at least one file.
- Evidence:
  ```ts
  if (doc.format !== SCOPE_FORMAT || doc.version !== SCOPE_FORMAT_VERSION) { throw … }
  if (!Array.isArray(doc.files) || !doc.files.every(isTransferFile)) { throw … }
  if (doc.files.length === 0 && typeof doc.index !== "string") { throw … }
  return doc as unknown as MemoryScopeExport;
  ```
  Counter-example input that passes every check and is handed back as a valid export:
  `{"format":"penguin-memory-scope","version":1,"files":[{"name":"a","content":"x"}],"index":42}`
  — `index` is typed `string | null` and is `42`. The header comment says *"Only the
  shape is checked here — names, sizes and counts are the server's to enforce"*, which
  is a fair division of labour for the *server-side* rules but does not justify typing
  the result as the full DTO.
- Fix: narrow the return type to a `Pick<MemoryScopeExport, "format"|"version"|"files"> &
  Partial<MemoryScopeExport>`-style validated subset and let the consumers (and
  `planMemoryImport`, which reads `doc.index` at line 102) see the optionality; or
  validate the remaining required fields before the cast.
- Confidence: high

---

### [MEDIUM] The web i18n facade exports a `Strings` binding that is `null` at runtime
- File: `packages/web/src/lib/strings.ts:15`
- Symptom: `export let S: Strings = null as unknown as Strings;` — the exported type
  says non-null, the runtime value is `null` until `setActiveStrings` runs at boot.
  Every consumer is an unguarded property read, so any read before initialization is a
  `TypeError` the type system cannot see and no caller can guard against (the binding
  has no `undefined` in its type).
- Evidence:
  ```ts
  export let S: Strings = null as unknown as Strings;
  ```
  Reached from the API layer, outside any React tree:
  ```ts
  // packages/web/src/api/client.ts:93,98
  throw new ApiError(0, "network_error", S.errors.networkError);
  let message: string = S.common.unknownError;
  ```
  The codebase works hard to respect this invariant — `memory-chat-prompts.ts:11-13`
  and `kernel-labels.ts:8-10` both carry "read `S` inside the functions, never at
  module top level" comments — which is exactly the kind of discipline a type should
  carry instead of a comment.
- Fix: type it `S: Strings | null` and export an accessor (`const s = (): Strings => { if
  (S === null) throw new Error(…); return S; }`), or keep the current shape and declare
  it `export let S: Strings | null = null` so the `?.`/guard discipline is enforced
  rather than remembered. `isStringsLoaded()` already exists and would become useful to
  callers.
- Confidence: high

---

### [MEDIUM] `ServerClient.request<T>` / `apiFetch<T>` can deliver `undefined` as `T`
- Files: `packages/cli/src/client.ts:237,240`; `packages/web/src/api/client.ts:114,116,117`
- Symptom: both generic HTTP helpers are typed `Promise<T>` but return `undefined` on a
  204 or an empty body, and `JSON.parse(text) as T` otherwise — with no validation of
  the body against `T`. Callers that type `T` as a required object and immediately
  destructure get a `TypeError` on an empty 2xx.
- Evidence:
  ```ts
  // packages/cli/src/client.ts
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    void res.body?.cancel();
    return undefined as T;          // <- Promise<T>, no undefined in T
  }
  const text = await res.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
  ```
  Every call site types `T` as a concrete object and reads it straight away:
  ```ts
  // packages/cli/src/commands/org.ts:211
  const me = await client.request<MeResponse>("GET", "/api/me");
  // packages/cli/src/client.ts:393
  const { agents } = await client.request<{ agents: Array<{ agentId: string }> }>(…);
  ```
  `const { agents } = undefined` throws. Today these endpoints always send a body, so
  the window is a proxy that strips one, or a future route reusing this helper for a
  204 — but the signature is already lying.
- Fix: `async request<T>(…): Promise<T extends void ? void : T>` is over-engineering;
  the honest minimum is `Promise<T | undefined>` with callers that already handle it,
  or a `requestJson<T>` that throws a typed `ApiError("empty_body")` instead of
  smuggling `undefined` through `as T`.
- Confidence: high

---

### [MEDIUM] `UiPrefs` is read from the DB and cast from arbitrary JSON
- File: `packages/server/src/http/routes/me.ts:93,118,123`
- Symptom: `JSON.parse(raw) as UiPrefs` accepts any JSON value. The `catch` only covers
  a `SyntaxError`, so a stored value that parses but is not an object (`null`, `5`,
  `"x"`, `[]`) is typed `UiPrefs` and returned to the client as `{ prefs: <that> }`,
  breaking the `PrefsResponse` contract that the `satisfies` check cannot catch (it is
  a compile-time check over an already-mistyped binding).
- Evidence:
  ```ts
  let prefs: UiPrefs = {};
  if (raw !== null) {
    try {
      prefs = JSON.parse(raw) as UiPrefs;   // raw === "null" → prefs === null, typed UiPrefs
    } catch {
      prefs = {};
    }
  }
  return c.json({ prefs } satisfies PrefsResponse);
  ```
  The PUT handler does the same and then merges (`{ ...current, ...(body as UiPrefs) }`),
  which silently no-ops for a non-object `current`, so a corrupted row also can never be
  repaired through the API.
- Fix: after the parse, `if (parsed === null || typeof parsed !== "object" ||
  Array.isArray(parsed)) prefs = {};` — or validate the keys against `UiPrefs` and drop
  unknown ones, which the module already does for `draftShortcuts`.
- Confidence: high

---

### [MEDIUM] `parseWindowsProbe` dereferences the parsed payload outside its try/catch
- File: `packages/core/src/environment/tools/command/port-probe.ts:111-119`
- Symptom: the function's contract is `number[] | null` — "null on failure" — but the
  failure guard only wraps `JSON.parse`. The first use of the parsed value is outside
  it, so a payload of literal `null` throws a `TypeError` the caller does not expect.
- Evidence:
  ```ts
  let payload: WindowsProbePayload;
  try {
    payload = JSON.parse(json) as WindowsProbePayload;
  } catch {
    return null;
  }
  const children = new Map<number, number[]>();
  for (const proc of asArray(payload.p)) {   // payload === null → TypeError, not null
  ```
  This is on the Windows port-probe path, where the "JSON" is stdout of a PowerShell
  one-shot — exactly the input a defensive reader should assume can be anything.
- Fix: hoist the shape check above the dereference:
  `if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;`
- Confidence: high

---

### [LOW] `StopReason` documentation disagrees with the declared union
- File: `packages/core/src/omnimessage/types.ts:25-53`
- Symptom: the comment says *"Only six protocol values are allowed"* and documents
  `completed` in two separate bullets, but the type declares four members.
- Evidence:
  ```ts
  *   - `completed`: finished normally, including completed text, thinking, tool requests, or
  *     tool output;
  *   - `completed`: the request (or the segment it closed) ended normally;        // duplicate
  …
  export type StopReason = "completed" | "aborted" | "retryable" | "fatal";        // 4, not 6
  ```
  A drift between a public protocol type and its own doc comment — the page at
  `/docs/omni-message § "stop_reason"` is generated from this text.
- Fix: rewrite the bullet list to match the four values (the `retryable` / `fatal`
  bullets below already describe them correctly) and drop the duplicate `completed`.
- Confidence: high

---

### [LOW] Duplicated JSDoc block on `ApprovalDecision`
- File: `packages/core/src/omnimessage/types.ts:71-72`
- Symptom: two `/** … */` blocks in immediate succession; the first is orphaned.
- Evidence:
  ```ts
  /** The approval decision for a tool call. */
  /**
   * Per-tool approval decision. `"allow"` and `"deny"` are the Human boundary's answers; …
  export type ApprovalDecision = "allow" | "deny" | "forbidden";
  ```
- Fix: delete the orphaned one-line block.
- Confidence: high

---

### [LOW] `any` in two exported kernel class-handle types
- File: `packages/core/src/kernel/module.ts:125,127`
- Symptom: `IfaceClass<T = any>` and `ModuleClass = abstract new (...args: any[]) =>
  object` are part of the `@prismshadow/penguin-core/kernel` public surface, each with
  an explicit `// eslint-disable-next-line @typescript-eslint/no-explicit-any`.
- Evidence:
  ```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type IfaceClass<T = any> = abstract new (...args: never[]) => T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type ModuleClass = abstract new (...args: any[]) => object;
  ```
  The disables are acknowledged rather than accidental, and `unknown` works for
  `ModuleClass`'s parameter list; `IfaceClass`'s `T = any` default is the more
  defensible of the two (a bare handle with no inferred instance type).
- Fix: `ModuleClass = abstract new (...args: unknown[]) => object`; leave
  `IfaceClass` or convert its default to `unknown` if the decorator call sites still
  infer.
- Confidence: medium

---

### [LOW] The CLI re-declares the server's `ServerEvent` / `SessionStatus` literals by hand
- File: `packages/cli/src/server-task.ts:26-32`
- Symptom: `ServerEventFrame` is documented as *"a structural subset of the server's
  ServerEvent union"* but is a hand-written interface: its `state` field re-types the
  literal `"idle" | "running" | "compacting"` instead of importing `SessionStatus`.
  The two are in sync today (`api/types.ts:66` declares the same three), but nothing
  links them, so a new `SessionStatus` value lands in the server and the CLI keeps
  compiling with a silently stale subset — and the `as unknown as GoalFinishedEvent`
  at line 243 exists only because `type: string` defeated the narrowing.
- Evidence:
  ```ts
  /** Server events the watcher understands (structural subset of the server's ServerEvent union). */
  interface ServerEventFrame {
    type: string;
    state?: "idle" | "running" | "compacting";   // server: SessionStatus, imported nowhere
    toolCall?: OmniMessage<ToolCallPayload>;
    origin?: string[];
  }
  ```
  The module already imports a real server type for the goal event
  (`import type { GoalServerEvent } from "@prismshadow/penguin-server/api"`), so the
  dependency is there and this is a local choice, not a packaging limit.
- Fix: `import type { ServerEvent, SessionStatus } from "@prismshadow/penguin-server/api"`
  and type the frame as `Extract<ServerEvent, { type: "task_state" | "approval_request"
  | "goal_finished" | "resync_required" }>` — that makes `ev` narrowable and deletes
  the `as unknown as` at line 243.
- Confidence: medium
