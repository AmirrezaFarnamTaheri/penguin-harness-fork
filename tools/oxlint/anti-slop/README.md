# anti-slop (vendored)

Vendored copy of the `anti-slop` Oxlint plugin: 15 rules that reject low-evidence,
low-signal TypeScript/JavaScript — the type system is evidence, and these rules fire
where code throws that evidence away.

- **Upstream:** <https://github.com/dmmulroy/anti-slop> (MIT)
- **Vendored:** the `src/` tree of the upstream plugin, copied verbatim as `index.ts`,
  `rules/` and `shared/`
- **Why vendored rather than depended on:** the rules are meant to be read and adapted
  to local standards. After the copy these files belong to this repo.

## Layout

- `index.ts` — plugin entry, registers all 15 rules. Pointed at by `jsPlugins` in
  `.oxlintrc.json` as `./tools/oxlint/anti-slop/index.ts`.
- `rules/*.ts` — one rule per file.
- `rules/*.test.ts` — upstream `RuleTester` suites. Read these to see exactly what each
  rule accepts and rejects before tuning it; they are the specification.
- `shared/` — helpers shared between rules (dictionary-type classification, lexical
  type-parameter resolution, Reflect method detection).

## Adoption status

Only 2 of the 15 rules are enabled, because only 2 are clean in this repo:

| Rule | Enabled | Owned findings |
|---|---|---|
| `no-reflect-apply` | `error` | 0 |
| `no-widen-then-assert` | `error` | 0 |
| the other 13 | `off` | 8,305 combined |

The remaining 13 are switched off **with their measured counts and the reason for each**
written next to them in `.oxlintrc.json`. That is deliberate: the counts are the
baseline to tighten from, and they go stale visibly if the rules start firing.

Re-measure after any of these changes:

```bash
./node_modules/.bin/oxlint -f json | head -c 200   # sanity: gate is green
```

To re-count a rule that is currently off, add it to a scratch config with
`"anti-slop/<rule>": "error"` and run `oxlint -c <scratch> -f json` — do not flip the
real config just to take a measurement.

## Notes

- Requires the `@oxlint/plugins` devDependency, imported as
  `eslintCompatPlugin` / `defineRule` from that package.
- This directory is in `ignorePatterns` in `.oxlintrc.json`: it is third-party code,
  linted by its upstream, not application source.
