# SEC-01 — `http-cache-semantics` reachability assessment — 2026-10-04

This receipt advances [SEC-01](../../tasks/work-orders.md#sec-01) packages 1 and 3. It does
**not** close the gate. It supersedes nothing in
[the 2026-10-03 dependency audit](dependency-audit-2026-10-03.md) and corrects two of its
statements, both of which were true when written and are false today.

## Scope

| Field | Content |
| --- | --- |
| Parent task | SEC-01, desktop build dependency audit gate |
| Packages completed here | sec-01.1 (record paths, classification, advisory, registry availability); sec-01.3 (assess replacement and actual caching behavior) |
| Packages still open | sec-01.2 (published compatible remediation — **ruled out below**), sec-01.4 (owner adjudication — **requires a named owner**), sec-01.5 (close on accepted audit + desktop packaging matrix) |
| Baseline | HEAD `ba7f17f7f7c2e491aa981c60ba1d7ccda2b9dfc8`, clean tree except the uncommitted PRR acceptance slice |
| Lockfile | `pnpm-lock.yaml` SHA-256 `9811492ee195182322b5524e0d26fcdc09df6cae4d3b0bc85ea5be0a23ab89c0` — unchanged by this investigation |
| Environment | win32 x64, Node `v26.1.0`, pnpm `11.18.0` |
| Change | None. No manifest, lockfile, or source file was modified. |

## sec-01.1 — Recorded state

| Field | Result |
| --- | --- |
| Advisory | [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) / CVE-2026-93748 |
| Severity | High — CVSS 4.0 8.7, CVSS 3.1 7.5, CWE-524 |
| Package / locked version | `http-cache-semantics@4.2.0` |
| Classification | `dev: true`, `optional: false`, `bundled: false` |
| Locked paths | `packages__desktop > electron-builder > app-builder-lib > @electron/get > got > cacheable-request > http-cache-semantics`<br>`packages__desktop > electron-builder > dmg-builder > app-builder-lib > @electron/get > got > cacheable-request > http-cache-semantics` |
| pnpm-audit advertised patched range | `>=4.2.1` |
| GitHub advisory record | `vulnerable_version_range: "<= 4.2.0"`, `first_patched_version: null`, `updated_at: 2026-10-02T22:36:44Z` |

Command and result:

```
$ pnpm audit --audit-level high
high  http-cache-semantics max-stale handling can disclose cross-user cached responses
Package             http-cache-semantics
Vulnerable versions <=4.2.0
Patched versions    >=4.2.1
1 vulnerabilities found / Severity: 1 high   (exit 1)
```

Both paths share one `app-builder-lib@26.16.1` instance, so this is a single underlying
dependency reached by two builder entry points, not two independent findings.

## Correction 1 — a release above the affected range now exists

The 2026-10-03 receipt recorded that no patched release was published and that
`http-cache-semantics@4.2.1` returned package-not-found. Both statements are now stale.

`pnpm view http-cache-semantics versions --json` on 2026-10-04 lists **`4.3.0`** as the latest
release, published `2026-10-04T02:56:05Z` — roughly twelve hours after the earlier audit.
`4.2.1` still does not exist; the audit's `>=4.2.1` predicate remains unsatisfiable as written.

| Field | Value |
| --- | --- |
| Version | `4.3.0` |
| `dist.integrity` | `sha512-M5t5LlJpS1UHMjvwRQVdFHvPISGeLAxNcrWuJkeGh0KxsqCHZ1O3NXZU/8x7cD0BDcGW8kapxMKTvwlqrNkHkA==` |
| `dist.shasum` | `09eead3b16c6d85552857cc3fbd888d8353a2aaf` |
| `gitHead` | `b1d4bd682fbab0252985de45219f4e7497c0067c` |
| Licence | BSD-2-Clause |

## Correction 2 — 4.3.0 is not a fix, and must not be used as one

This is the operative finding of this receipt.

The advisory's vulnerable range is `<= 4.2.0`, so `4.3.0` sorts outside it and a version bump
alone makes `pnpm audit` report clean. That would be a **false clean**: the vulnerable code is
unchanged. Verified by unpacking both published tarballs and diffing `index.js`
(928 lines → 951 lines). The complete set of changes is four hunks:

1. `_evaluateRequestHitResult` now includes `status: this._status` in the returned response.
2. JSDoc types widened from `{headers}` to `HttpResponse`.
3. `Vary` matching moved into the field loop, using `hasOwnProperty` guards, so a missing
   request header and a missing cached header compare equal instead of one `undefined`
   against a value.
4. A new public `status()` accessor.

None of these touches `max-stale` handling. The advisory cites lines 425–441 of the
vulnerable blob; the branch it points at is this, at 4.2.0 lines 428–429 and at 4.3.0 lines
429–430:

```js
const allowsStaleWithoutRevalidation = 'max-stale' in requestCC &&
    (true === requestCC['max-stale'] || requestCC['max-stale'] > this.age() - this.maxAge());
```

A line-for-line comparison of the surrounding region (4.2.0 lines 415–450 against 4.3.0 lines
416–451) is **byte-identical**. `README.md` is unchanged. Upstream
[kornelski/http-cache-semantics#56](https://github.com/kornelski/http-cache-semantics/issues/56)
remains open and the advisory's `first_patched_version` is still `null` as of its
`2026-10-02` review.

Consequences, which are why sec-01.2 stays open:

- Bumping the lockfile to `4.3.0` would satisfy the audit's version predicate while remediating
  nothing. Per the work order — *"A suppressed finding is not a patched dependency"* — that is a
  suppression, and it is **not** applied here.
- The three hunks that *are* in 4.3.0 include a genuine `Vary` cache-key isolation correction.
  That is worth taking on its own merits, but it is a different defect from the advisory and
  must not be recorded as this gate's remediation.
- No lockfile or manifest was changed by this investigation. `pnpm audit --audit-level high`
  still exits 1, as recorded above.

## sec-01.3 — Reachability and caching behavior

The advisory's own scope statement limits impact to *"deployments where the library is used in a
shared cache context (i.e., a cache that serves responses to multiple distinct users), such as
a proxy or CDN layer."* That condition is not met here, on two independent grounds.

### Ground 1 — the vulnerable code is never invoked

`got@11.8.6` requires `cacheable-request` at module load, so `http-cache-semantics` is *loaded*
whenever `@electron/get`'s downloader module is imported. It is never *instantiated*, because
every hop that could construct it supplies no `cache` option:

| Hop | Evidence |
| --- | --- |
| `got@11` — the cache is opt-in | `dist/source/core/index.js:379` `if (options.cache === false) { options.cache = undefined }`; `:558` `cacheableStore.set(cache, new CacheableRequest(...))`; `:1088` `const fn = options.cache ? this._createCacheableRequest : realFn`. With `options.cache` unset, `:1088` selects `realFn` and the cacheable path is bypassed. |
| `@electron/get@3.1.0` — passes options through verbatim | `dist/cjs/GotDownloader.js` calls `got.stream(url, gotOptions)` where `gotOptions` is `options` minus `quiet`/`getProgressCallback`. It adds nothing. |
| `app-builder-lib@26.16.1` — never sets `cache` | `out/util/electronGet.js:294` builds `downloadOptions = { timeout, ...config.downloadOptions, agent, getProgressCallback }`; `:696` is the only other assignment, `...(strictSSL === false ? { downloadOptions: { https: { rejectUnauthorized: false } } } : {})`. Neither introduces a `cache` key. |
| This repository — configures no download options | `packages/desktop/electron-builder.yml` declares no `electronDownload` block; `packages/desktop/package.json` has no `build` key. A repo-wide search for `electronDownload` outside `node_modules` returns nothing. |

`options.cache` can therefore only become truthy if a user writes
`electronDownload.downloadOptions.cache` into their own electron-builder configuration. No
path in this repository does so.

### Ground 2 — the cache that does exist is private, not shared

`@electron/get`'s `cacheRoot` is a per-machine, `env-paths`-derived directory holding Electron
release zips. Its contents are not HTTP response entries at all: they are files written by
`Cache.putFileInCache` and validated by SHA-256 against `SHASUMS256.txt`, which `@electron/get`
fetches with `cacheMode: Bypass` on every build. The `max-stale` branch operates on
`CachePolicy` instances constructed from cached *response headers*; this cache holds
checksum-verified artifacts and never consults `http-cache-semantics`.

### Replacement assessment

Re-verified against the registry on 2026-10-04, independently of the 2026-10-03 receipt:

| Query | Result |
| --- | --- |
| `electron-builder` latest | `26.15.3` (repo declares `^26.16.1`, installed `26.16.1`) |
| `app-builder-lib@latest` → `@electron/get` | `26.15.3` → `^3.0.0` |
| `@electron/get@3` latest → `got` | `3.1.0` → `^11.8.5` |

No published builder line removes the chain. `@electron/get@5.1.0` drops `got` entirely in
favour of `undici`, and is **already in this lockfile** at line 6952 for an unrelated consumer
— but `app-builder-lib` pins `^3.0.0`, so adopting it means a cross-major override of a build
tool's internal API surface. The work order requires compatibility evidence for exactly this
class of change and forbids an audit-only justification. Forcing it while the vulnerable path is
demonstrably unreachable would trade an unexploitable advisory for a real risk of breaking
packaging, which is a net loss.

## Acceptance against the criterion

| Criterion | Verdict |
| --- | --- |
| sec-01.1 — record paths, classification, advisory, registry availability | **Proved.** Tables above; registry rechecked 2026-10-04. |
| sec-01.2 — prefer a published compatible patched transitive release | **Contradicted.** No such release exists. `4.2.1` is unpublished; `4.3.0` is published but does not contain the fix. Recorded integrity values, but the version was deliberately not adopted. |
| sec-01.3 — assess replacement and actual caching behavior | **Proved.** Reachability traced hop by hop with file:line evidence; replacement re-verified against the registry. |
| sec-01.4 — no suppression without explicit owner adjudication | **Unchanged, still blocking.** No suppression or override applied. The adjudication requires a named owner and is not self-granted by this receipt. |
| sec-01.5 — close only after the audit is accepted and packaging passes | **Not met.** `pnpm audit --audit-level high` exits 1. |

## Verification

```
$ pnpm audit --audit-level high                                    → exit 1, 1 high (output recorded above)
$ pnpm view http-cache-semantics versions --json                   → 4.3.0 present, 4.2.1 absent
$ pnpm view http-cache-semantics@4.3.0 --json                      → integrity/shasum/gitHead recorded
$ curl api.github.com/advisories/GHSA-ch52-4w7c-c8xp               → "<= 4.2.0", first_patched null
$ diff of unpacked 4.2.0 vs 4.3.0 index.js                         → 4 hunks, none touching max-stale
$ byte comparison of the cited region                              → identical
```

## Compatibility

No product behavior changes: no file in `packages/` was touched and the lockfile is unchanged.
Desktop installers, the CI matrix, and the `@electron/get` artifact cache are unaffected. This
receipt changes only the evidence base for SEC-01.

## Residual work

SEC-01 stays **GATED**. The single remaining decision is sec-01.4, and it is an ownership
decision rather than an engineering one: whether to record a time-bounded owner adjudication
on the strength of the reachability evidence above, or to leave the gate open and revisit when
upstream ships a real fix.

Whichever way it goes, the reopen condition is the same and should be recorded with it: a
`http-cache-semantics` release whose `index.js` differs in the `max-stale` region
(`allowsStaleWithoutRevalidation`), or a published `app-builder-lib` that no longer resolves
`@electron/get@^3`. Re-check on either event, and on any move that introduces
`electronDownload.downloadOptions.cache`, which would make the vulnerable path reachable and
invalidate Ground 1 immediately.