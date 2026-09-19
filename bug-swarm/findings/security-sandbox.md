# SECURITY & SANDBOX — findings

FINDER domain: security & sandbox. All findings below were verified empirically with
`./node_modules/.bin/tsx bug-swarm/scratch/sec-probe.ts` and `sec-probe2.ts` (Node v26.1.0).
Reproduce with those two scripts. No fixes were applied.

---

## SEC-1 (HIGH) — the egress allow-list is never enforced on the isolated tier

`network-gated-workspace` is the only preset that grants `network:outbound`, and the
whole claim is that it grants it *to a list*. That list is dropped on the floor between
the runtime and the only backend that exists.

Evidence (three independent links in the chain):

1. `packages/core/src/sandbox/isolated-execution-runtime.ts:391-396` — the network
   decision is computed and then discarded:

   ```ts
   const networkDecision = policyBox.decide("network:outbound");
   if (networkDecision.outcome === "deny" && this.allowList.length === 0) {
     // comment only — no code, no else-branch
   }
   ```

   The `if` body is a no-op; `allowList` is passed to the backend unconditionally.
   `decideEgress` (imported at line 34, the only place the private-address screen lives)
   is **never called** on this path — `grep -n decideEgress` over the repo finds the
   import line and nothing else.

2. `packages/server/src/sandbox/microvm/microvm-escalation-runtime.ts` — the sole
   `IsolatedBackend` implementation. `bootSandbox` (line 239) forwards only
   `templateId` / `timeoutMs` / `env`. `run` (line 199) forwards only
   `cmd` / `cwd` / `env` / `timeoutMs` / `signal`. `command.allowList` is never read.

3. `packages/server/src/sandbox/microvm/microvm-sandbox-client.ts:540-555` — the client
   exposes `updateNetwork({ egressAllowList, egressDenyList })` for exactly this
   purpose. `grep -rn updateNetwork` across `packages/` and `plugins/` returns **zero
   callers**.

Net effect: a script escalated out of the in-memory tier (i.e. anything that is not
pure built-in shell — any external binary, any redirection, any subshell) runs in a
microVM whose network reachability is whatever the `base` template defaults to. Neither
the configured allow-list nor the private-address screen constrains it.

Also under the same heading: `IsolationCeilings.maxProcesses` and `.maxMemoryBytes` are
not forwarded either — only `sigkillTimeoutMs` reaches the command (line 203), as
`timeoutMs`. The fork-bomb cap and the memory ceiling are advisory on this path.

Note this is an *enforcement* gap, not a design gap: the boundary is specified correctly
in `IsolatedCommand.allowList` and the client method exists. It is wiring that was never
connected.

---

## SEC-2 (HIGH) — `redactObject` leaks secrets whose field names are not exact matches

`packages/core/src/internal/credential-redactor.ts:152-163` — `isSensitiveField`
normalizes a key (lowercase, strip non-alphanumerics) and then requires an **exact**
match against the table or one of the anchored regexes (`^…$`). Any sensitive field
whose name carries a prefix or suffix falls through and is recursed into as ordinary
data, and a scalar there is returned verbatim.

Verified with `sec-probe2.ts`:

```
dbPassword             = postgres://s…   <-- LEAKED
userPassword           = hunter2         <-- LEAKED
adminPassword          = godmode         <-- LEAKED
apiSecret              = sk-live-abcd…   <-- LEAKED
refreshTokenValue      = rt_abc          <-- LEAKED
stripeSigningSecret    = whsec_abc       <-- LEAKED
```

The module's contract is "Sensitive scalar fields are removed in full" and "secrets stay
opaque" (lines 180-183). Prefixed/suffixed names are the normal case for nested config
and provider blocks — `dbPassword`, `apiSecret`, `refreshTokenValue` are realistic
shapes, and this codebase is an LLM agent platform where `*Key` / `*Secret` fields are
the primary secret cargo. (`openaiKey` / `anthropicKey` happen to survive only because
their *value* matches the `sk-` format rule; an opaque token there would leak too.)

Fix direction: match on a sensitive token appearing *anywhere* in the normalized key
(contains, not equals), and treat a key ending in `key`/`secret`/`token`/`password` as
sensitive regardless of prefix.

---

## SEC-3 (MEDIUM) — value-format redaction misses quoted secrets that contain whitespace

`packages/core/src/internal/credential-redactor.ts:81` — `generic_assignment`:

```regex
((?:api[_-]?key|…|password|…)\s*[:=]\s*["']?)[^\s"';,]{8,}(["']?)
```

The value may not contain a space. When the prefix consumes an opening quote, no value
can match, so the whole rule backs out. Verified with `sec-probe2.ts`:

```
containsCredentials=false   password: "hunter2 traced"      (unchanged)
containsCredentials=false   api_key="my key value"          (unchanged)
containsCredentials=false   PASSWORD='a b c d e'            (unchanged)
```

Both parts matter: `redactCredentials` returns the input untouched, **and**
`containsCredentials()` reports it as clean — so any downstream gate that asks "is this
safe to log / send to the model / write to a trace" answers yes for a real secret.
Passphrases and generated tokens containing spaces are entirely unhandled.

Fix direction: when the prefix consumed a quote, let the value run to the matching
closing quote rather than to the next whitespace.

---

## SEC-4 (MEDIUM) — the shell classifier drops newlines, so it under-reports in the permissive direction

`packages/core/src/sandbox/shell-lexer.ts:601-611` — `tokenizeShell` filters `NEWLINE`
tokens out of the stream. `packages/core/src/sandbox/shell-evaluator.ts:188-213` —
`COMMAND_SEPARATORS` has no newline entry, because no token ever carries one. A
multi-line script is therefore lexed as one long single-line command.

Verified with `sec-probe.ts`:

```
"echo hi\necho bye"        safe=true
"echo hi\n/root/evil"      safe=true      <- names an external binary
"true\nrm"                 safe=true      <- names a destructive external command
```

Compare `"echo hi && /root/evil"` and `"echo hi; rm -rf /"`, both correctly `safe=false,
reason=external_command`.

Execution still fails *safe*: the in-memory tier only runs builtins, so in `true\nrm`
the `rm` becomes an argument to `true` and nothing runs. The damage is to the *verdict*,
which `decideTier()` exposes for approval prompts and telemetry before anything runs: a
script that names an external binary is reported as the in-memory tier, requiring no
`shell:native-binary` capability and no approval. It also silently mis-executes
legitimate multi-line scripts — `echo a\necho b` prints `a echo b`.

Fix direction: keep NEWLINE tokens through classification (the evaluator's
`runPipelineList` already needs a separator there; it currently splits only on `;`,
`&&`, `||`, so adding newlines to both places is one change in two files).

---

## SEC-5 (LOW) — `isPrivateIp` misses trailing-dot and IPv4-compatible spellings

`packages/core/src/sandbox/egress-allowlist.ts:151-163` — the SSRF screen is string-form
only (documented as deliberate, with DNS pinning left to the caller). Two spellings a
resolver accepts are not recognized:

```
isPrivateIp("127.0.0.1.")  = false     # trailing dot — DNS resolves this to 127.0.0.1
isPrivateIp("localhost.")  = false
isPrivateIp("[::127.0.0.1]") = false   # IPv4-compatible ::/96, parseIpv6 returns null
```

(The `localhost.` form is also what `new URL("http://localhost./").hostname` hands back
unchanged.)

Not currently reachable as an actual request through `decideEgress`: the WHATWG parser
strips the dot for IPv4 literals, and for names the trailing dot breaks origin equality
against an allow-list entry, so the request fails the allow-list instead. `isPrivateIp`
is, however, part of core's public API and documented as the private-address boundary, so
a caller passing a raw hostname gets a false "public". The companion
`packages/core/src/internal/safe-http.ts` is robust here — it re-resolves via DNS,
applies policy to every resolved address, and binds the transport to the validated IP
(lines 247-272) — and it correctly handles the trailing-dot case for that reason.

Fix direction: strip a single trailing `.` in `normalizeHostname`, and treat the
IPv4-compatible `::/96` form the same as the mapped `::ffff:` form (the donor `safe-http`
module already does both, so the two implementations can be reconciled on the stronger
one).

---

## SEC-6 (LOW) — ShellGuardian critical rules are evadable with a variable or a dot

`packages/core/src/agent/shell-guardian.ts:37` — `destructive-root-delete`:

```regex
\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|…)\s+([/~]|\/\*|\*)
```

The target must literally begin `/`, `~`, or `*`. Verified with `sec-probe.ts`:

```
rm -rf "$HOME"    risk=safe   action=allow
rm -rf $PWD       risk=safe   action=allow
rm -rf .          risk=safe   action=allow
rm -rf ./         risk=safe   action=allow
```

`rm -rf .` is a recursive forced delete of the current directory, which is what an agent
in a workspace directory actually types. The policy box is the authoritative boundary and
this is a heuristic, but the `critical → suggestedAction: "block"` mapping means a miss
is a silent allow rather than a softer finding.

Fix direction: add `.` and `./` to the target group, and treat an unquoted variable
expanding to a path (`\$[A-Z_]`) as not-matchable — i.e. route it to `high` rather than
`safe`, since the guardian cannot know what it expands to.

---

## Surveyed and clean (checked, no finding)

- `shell-quote.ts` — single-quote `'\''` escaping is correct and complete.
- `shell-lexer.ts` — reserved-word lookup via `Map` (no prototype keys), balanced-bracket
  assignment LHS, quote-state tracking, heredoc size bound all sound.
- `cow-fs-backend.ts` — `normalizePath` clamps `..` at root (`/..` → `/`), every entry
  point canonicalizes before the containment check; null-byte and path-length rejection
  present.
- `packages/server/src/secret-file.ts` — unlink + `O_EXCL` + `O_NOFOLLOW`, `fchmod` on
  the fd not the path.
- `packages/server/src/auth/password.ts` — scrypt with parameters stored in the hash,
  format-validated, `timingSafeEqual`.
- `packages/server/src/auth/api-token.ts` / `middleware.ts` — constant-time compare on
  sha256 digests; `httpOnly` + `SameSite=Lax` + content-type CSRF gate; `x-forwarded-proto`
  gated behind `trustProxy`.
- `safe-http.ts` — DNS resolution then transport bound to the validated address; redirect
  handling re-validates and strips origin-bound credentials on cross-origin redirect.
- `sandbox-policy-box.ts` — deny-by-default capability table, unknown capability fails
  closed, ref-counted activation, per-executionId trusted scope, `AsyncLocalStorage`
  scoping.
- `egress-allowlist.ts` matching — origin-exact, path-segment boundary
  (`/apix` does not match `/api`), ambiguous encoded separators rejected, bounded decode
  loop. All verified.
