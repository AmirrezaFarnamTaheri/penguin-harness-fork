# H2 — YAML edit round trip (2026-10-02)

Programmatic config edits used `parseDocument` — the right mechanism — but nothing pinned what
"comments survive" meant exhaustively, and nothing read the parser's error list. Two consequences
were real: a duplicate-key or tab-indented config produced a raw library throw from inside a request
handler, and every edit silently reformatted 4-space files to 2 spaces and indentless sequences to
indented ones. This package makes the edit path explicit, style-aware and refusable.

## H2.1 — Frozen style fixtures (deliverable)

`packages/core/test/fixtures/yaml-edit/` — 18 files, read as bytes by the test, no generator:

| Fixture | Shape it freezes |
| ------- | ---------------- |
| `styled.yaml` | leading comment, inline comment on a key, inline comment on a sequence item, comment before a nested key, indentless sequence, nested map, double- and single-quoted scalars, block scalar, flow collection |
| `four-space.yaml` | 4-space indentation, three map levels |
| `empty.yaml` | zero bytes |
| `comments-only.yaml` | no keys, two comments |
| `null-section.yaml` | a dangling `tools:` key (parses to null) around ordinary keys |
| `mixed-seq-styles.yaml` | both indentless and indented sequences in one document |
| `duplicate-keys.yaml` | `name:` defined twice |
| `malformed.yaml` | unclosed flow sequence |
| `tab-indent.yaml` | tab-as-indent (parses to `TAB_AS_INDENT`) |
| `root-sequence.yaml`, `root-scalar.yaml` | unexpected root types |
| `alias-copy.yaml` | an anchor plus an alias to it |
| seven `*.expected.yaml` | the byte goldens for the supported edits above |

## H2.2 — Reconcile the existing parser (deliverable)

`packages/core/src/state/yaml-edit.ts`, exported from the state barrel. The strategy is **targeted
node changes, never parse-into-an-object-then-stringify** — the latter is exactly how comments
disappear. What the reconciliation had to establish first (measured against the installed yaml 2.9,
not assumed):

| Behaviour | Measured | Consequence |
| --------- | -------- | ----------- |
| comments | preserved through `setIn` + `toString`, including an inline comment on an edited key | the existing approach was sound |
| indentation width | **not** preserved — `toString()` re-indents to 2 spaces | detect the source width and pass `indent` back |
| indentless sequences | **not** preserved — `toString()` indents them | detect the style and pass `indentSeq: false` when the source uses it |
| a fresh sequence node | written in the library default style | style is applied to new nodes too (test: `extra:\n- x` in an indentless doc, `extra:\n    - x` in a 4-space doc) |
| duplicate keys | `doc.errors` carries `DUPLICATE_KEY`; `parse()` also throws; `toString()` refuses outright | refuse early with a code, not a raw library throw |
| a dangling `key:` (null) | `setIn(["key", …])` throws "Expected YAML collection" | materialize the section (the repair `kernel-update` already carried inline) |
| a write through an alias | `setIn` throws "Expected YAML collection at copy" | refuse (`unwritable-path`) rather than write through a shared anchor |
| directives (`%YAML 1.2` + `---`) | parse cleanly and round-trip | supported, not a refusal |
| empty / comments-only file | `contents === null`; `setIn` materializes a map root | supported |

## H2.3 — Safe edits and refusals (deliverable)

`applyYamlEdits(raw, edits)` returns `{ok: true, text, notes}` or
`{ok: false, refusal: {code, message, line?}, text: raw}`. Five codes: `malformed`,
`duplicate-key`, `unsupported-syntax`, `root-type`, `unwritable-path`. **On refusal the text is the
original input byte-for-byte and nothing was mutated** — the module has no filesystem import at all
(pinned by a test), so "preview instead of write" is structural rather than a promise. `notes`
records repairs and style normalizations (`materialized missing section "tools"`, `replaced
non-mapping section "tools"`, the mixed-style normalization) so a caller can surface them.

The write decision was deliberately split, and this is the one place behaviour changed:

- a section holding **null or a scalar** is materialized — it reads as absent on the config side, so
  the tab would be written anyway (this is what `kernel-update` did inline);
- a section holding a **sequence** or **alias** is refused, because replacing it would destroy the
  user's value and writing through an alias would corrupt an anchor. Previously the sequence case
  was silently replaced.

## H2.4 — Proof (deliverable)

```
cd packages/core
node ../../node_modules/vitest/vitest.mjs run test/yaml-edit.test.ts   # 29 passed
node ../../node_modules/vitest/vitest.mjs run test/kernel-generational.test.ts \
  test/kernel-version.test.ts test/agent-lifecycle.test.ts \
  test/atomic-write.test.ts test/builtin-agents.test.ts                 # 73 passed
node ../../node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json    # clean
node ../../node_modules/typescript/bin/tsc --noEmit -p packages/server/tsconfig.json  # clean
```

What the new suite asserts, per requirement: **edited expected bytes** for six supported fixtures
(byte equality with the golden, plus re-applying the same edits is byte-stable); **unchanged
originals for refusals** (byte equality with the input for all six refusal fixtures, including that
the anchor's own value is untouched); **unrelated comments alone** (only one line differs when one
value changes); **named negatives** — duplicate key, unsupported syntax, malformed YAML, unexpected
root type, unrelated comments — each with its own case.

The adapter contract for H1/H4: `parseYamlForEdit` (load + classify), `stringifyYamlDocument`
(style-preserving serialization), `applyYamlEdits` (edit list in, bytes or coded refusal out),
`yamlEditRefusalMessage` (one-line rendering for an API error). The kernel update is the first
consumer; the Web App's config PUT (`agent-config-service.applyConfigUpdate`) still edits through
`parseDocument` directly and is a follow-up (below).

## Compatibility

- `applyKernelUpdate` output is unchanged for well-formed configs; the existing behaviour matrix
  (`kernel-version.test.ts`: dangling sections, comments, kept customizations, superseded tabs) is
  the baseline proof and stays green untouched.
- A config with a sequence where a tab must write a nested path now errors instead of being silently
  replaced; the error names the path and says the file was left unchanged.
- Rollback: `kernel-update.ts` can go back to its inline `setDeep`; `yaml-edit.ts` is additive.

## Residual work

- **The config PUT still edits on its own.** `packages/server/src/services/agent-config-service.ts`
  keeps a direct `parseDocument`/`doc.toString()` path, so it does not yet get the indent/indentSeq
  preservation or the coded refusals (it does get the raw library throw today). Adopting the adapter
  there is a small change but it alters the PUT's error contract (HTTP status + body shape), which is
  a server boundary — recorded as the next step rather than smuggled into this package.
- **Known limitation, pinned by its own test:** an inline comment on a key whose value is a block
  sequence (`tools:  # note`) is re-emitted on the line above the sequence. The text survives; the
  inline position does not. The library attaches that comment to the sequence node, and moving it
  back means hand-writing comment placement.
- **Mixed sequence styles cannot be reproduced byte-exactly** by any single stringify option: the
  indentless style is kept and the indented ones are rewritten flush, reported in `notes`. Documents
  that do not mix styles round-trip byte-exactly (the `styled` and `four-space` goldens).
- Indentation detection reads the smallest positive leading-space run; a document whose only indented
  content is a block scalar body would report the scalar's indent. Not observed in any fixture, and
  the failure mode is a wider indent, not data loss.
