# Bug Swarm — Security & Sandbox Fixer Log

Owner: lead (this session). Every fix below was applied by the lead after reading the
finding in `bug-swarm/findings/security-sandbox.md` and verifying it against the code.

| # | Finding | File(s) | Fix | Tests added |
|---|---------|---------|-----|-------------|
| SEC-1 (HIGH) | The egress allow-list is computed by the runtime and then discarded; the only isolated backend never reads `command.allowList` and `updateNetwork` had zero callers. | `packages/core/src/sandbox/isolated-execution-runtime.ts`, `packages/server/src/sandbox/microvm/microvm-escalation-runtime.ts` | Core now uses the capability decision instead of dropping it: a `permit` on `network:outbound` hands the backend the configured allow-list, anything else hands it an empty list (network-off) — passing the configured list through on a denial would have let an escalation reach a host the policy never granted. The backend applies the list at boot via `applyEgressPolicy` → `client.updateNetwork`, and fails the boot rather than falling back to the template default. | 3 (`isolated-execution-runtime.test.ts`, `microvm-escalation-runtime.test.ts`) |
| SEC-2 (HIGH) | `redactObject` leaked any secret whose field name was not an exact table match (`dbPassword`, `apiSecret`, `refreshTokenValue`, `stripeSigningSecret` …). | `packages/core/src/internal/credential-redactor.ts` | `isSensitiveField` now matches a sensitive token anywhere in the name as a **whole word** (`splitFieldNameWords` splits on separators, digit runs and camelCase/acronym transitions), and `key` is in the set on purpose — a redactor fails closed. The word boundary is what keeps `monkey`/`keyword`/`hotkey`/`maxTokens` visible while `dbKey` is censored. The five anchored regexes the old code relied on are subsumed. | 2 (`credential-redactor.test.ts`) |
| SEC-3 (MEDIUM) | `generic_assignment` could not match a quoted value containing whitespace, so `redactCredentials` left it untouched **and** `containsCredentials` reported the line as clean. | `packages/core/src/internal/credential-redactor.ts` | When the prefix consumed a quote the value now runs to the matching closing quote; the replace keeps the quoting. Added `api_secret` to the keyword list while in there. | 2 |
| SEC-4 (MEDIUM) | `tokenizeShell` filtered `NEWLINE` out, so a multi-line script lexed as one long single-line command: the tier verdict reported an external binary as in-memory-safe (no capability, no approval) and `echo a\necho b` printed `a echo b`. | `packages/core/src/sandbox/shell-lexer.ts`, `packages/core/src/sandbox/shell-evaluator.ts` | Newlines survive tokenization, `NEWLINE` joined `COMMAND_SEPARATORS`, and `runPipelineList` splits on it, so classification and execution both treat a newline as a `;`. | 3 |
| CRITICAL (core-agent) | `sanitizeUntrustedContent` was hardened in the previous batch but had **zero callers** — the data boundary was never actually in front of any untrusted text. | `packages/core/src/environment/tools/web-search.ts` | `renderResults` now returns the sanitized, per-call-fenced block instead of an advisory line that the payload could talk past. This is the one external-content tool in the repo, and its own description already called its output untrusted. | 1 (rewritten assertion + fence contract) |

Not fixed, deliberately:
- **SEC-5 (LOW)** `isPrivateIp` misses trailing-dot and IPv4-compatible spellings. Not reachable through
  `decideEgress` today (the WHATWG parser strips the dot for IPv4 literals; a trailing dot on a name
  fails the allow-list's origin equality), and `safe-http.ts` — the code path that actually makes
  requests — re-resolves via DNS and binds the transport to the validated address, so it is already
  correct. Fixing the exported helper means reconciling two implementations; left as a documented
  gap rather than a speculative change.
- **SEC-6 (LOW)** ShellGuardian critical rules are evadable with a variable or a dot. The guardian is
  advisory triage on top of a capability box that denies by default; the escalation path is what
  actually confines. Hardening the regexes without a way to run them against a corpus of evasion
  cases would trade false negatives for false positives.
- **Ceilings not forwarded**: `IsolationCeilings.maxProcesses` / `.maxMemoryBytes` still do not reach
  the microVM (`create` accepts only `templateId` / `timeoutMs` / `env`). That is a client-contract
  change, not a wiring change, so it was left out of this batch.

Verification (observed, not assumed): core suite 3785 passed | 29 skipped | 0 failed;
core `tsc --noEmit` exit 0; server `tsc --noEmit` exit 0; sandbox suite 309/309;
server microvm suite 18/18; web-search 11/11; credential-redactor 15/15.
