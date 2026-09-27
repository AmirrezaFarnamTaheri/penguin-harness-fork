---
title: Running the Jev advisor
description: Operating the optional host-composed Jev advisory — enabling it, what crosses the provider boundary, reading the counters, and troubleshooting an unavailable observation.
---

# Running the Jev advisor

The optional [Jev advisory](configuration#optional-jev-advisory-host-composed) is host-composed, bounded and
**advisory-only**. This page is the operator's view: how to turn it on, what crosses the provider
boundary, how to read the counters, and what to do when a run reports `unavailable`.

## What it is, and what it is not

A Jev observation is a model's opinion about whether a proposed tool call fits the task. It is
recorded, displayed on the call's card, and counted. That is the whole of it.

| It may | It may not |
|---|---|
| appear beside a tool call as a footnote | allow, deny, or satisfy an approval |
| say the call looks risky, slow or ill-fitted | change the project command policy |
| be counted for latency and availability | select a tool, or rewrite a model's request |
| cost tokens and wall-clock time | gate execution, ever |

**Authority order is unchanged and not negotiable:** Environment permission, then the project
command policy, then the human approval callback. A call that reaches Jev has already passed all
three, and Jev runs only for calls that nothing else decided. If Jev says a call is fine and the
command policy vetoes it, the call is vetoed. If Jev says a call is terrible and nothing else
objects, the call runs.

## Turning it on

Set one variable on the server. That is the entire switch:

```bash
PENGUIN_JEV_API_KEY=<host-owned key>   # unset ⇒ disabled, and the historical tool path is byte-identical
PENGUIN_JEV_MODEL=jev-latest           # optional; the host's model choice, not an Agent's
```

There is deliberately no Agent-level switch. An Agent can edit its own `system_config.yaml`, so a
credential or endpoint stored there could be redirected by the Agent that is being observed. The
key lives in the server's environment and never enters Agent State, a Trace event, or any stream
payload.

## What crosses the boundary

**Default: metadata only.** For each undecided tool call the advisor sends the tool name, the
deterministic permission, the argument *keys* and *value types*, whether the arguments parsed as
JSON, and the argument count. It does not send argument values, prompts, file contents, or
transcripts.

Two things are worth knowing about the keys themselves. A key that spells a path is reduced to its
last segment, and a key that looks like a credential is redacted — keys are model-authored, so a
model can put anything in a key that it could have put in a value.

**Opt-in: argument values.** `createJevAdvisor({ includeArguments: true })` sends the values too.
Recognized credential shapes are scrubbed, but the built-in redactor cannot prove an opaque value
safe. Treat it as an explicit data-egress decision, not a default.

**Never:** the API key anywhere but the `Authorization` header; the provider's own response text
in any user-visible diagnostic; a provider error body in a log, a Trace, or a counter.

## Reading the counters

The advisor exposes a fixed set of counters (`AdvisoryActivityRecorder` in
`@prismshadow/penguin-core/jev`). Nothing free-form enters them — every value is a count, a
duration, or a word from a closed vocabulary — so there is nothing there to redact, and no
provider string can reach a log through it.

| Counter | Reading |
|---|---|
| `answered` | observations that produced a usable answer |
| `unavailable` | observations that did not, for any reason |
| `skippedDecided` | calls already decided by a hook before the advisor was reached |
| `skippedPolicy` | calls the command policy vetoed before the advisor was reached |
| `skipped` | calls with no advisor composed at all |
| `latencyPercentiles()` | p50/p95 over answered calls, from a bounded sample ring |
| `byReason` | failure breakdown: `timeout`, `cancelled`, `circuit_open`, `connection_error`, `invalid_response`, `provider_http` |
| `providerHttpStatuses` | provider status codes as counts, kept as numbers rather than metric keys |

`skippedDecided` and `skippedPolicy` are the numbers that say whether the advisor is earning its
place: a high `skippedDecided` means most calls never needed an opinion, and the latency budget
those calls *did* consume may be better spent elsewhere.

## When a run reports `unavailable`

The tool call proceeds exactly as it would with no advisor configured. Nothing is blocked, nothing
is retried by the advisor, and the reason is a bucket rather than a provider string.

| Reason | What happened | What to do |
|---|---|---|
| `timeout` | the call exceeded the host's hard deadline | nothing — this is the bound working. If it is constant, lower concurrency or raise the deadline |
| `cancelled` | the Session was aborted or the turn was stopped | nothing; the user did it |
| `circuit_open` | consecutive failures opened the local breaker, so no request was made | see below |
| `connection_error` | DNS, TLS or connect failed | check the host's egress path and proxy |
| `invalid_response` | the provider answered with something that failed validation | usually a provider-side change; the raw body is deliberately not surfaced |
| `provider_http` | the provider returned an HTTP error | the status is in `providerHttpStatuses` |

**The circuit.** It opens after three consecutive failures and stays open for 30 seconds; one
half-open probe is admitted at the end of that window. It is time-bounded rather than purely
consecutive, so a single network blip during a busy run — several calls timing out at the same
deadline — does not open it for every session on the server. A caller-initiated cancellation never
counts against it. A stalled provider is reported as `timeout`, never as `cancelled`: the deadline
belongs to the host, and blaming the user for the provider's latency is wrong.

## Turning it off

Unset `PENGUIN_JEV_API_KEY` and restart. No advisor is composed, no hook is registered, no event is
emitted, and the tool path is the historical one. Disabling it is always safe: nothing in the
system depends on an observation, which is the property that makes the switch safe to flip in an
incident.

## Jev-family variants

The advisor is not bound to one provider. It speaks the TypeSafe System One wire format, so **any
server that implements `POST /v1/systemone` can answer it** — including a local, open-weight
decision-model server.

### Running the advisor locally

A local decision-model runtime ([Ollaya](https://github.com/ollaya-dev/ollaya), Apache-2.0) serves
`/v1/systemone` wire-identically and answers `choice` / `score` / `noul` in a single forward pass,
which is exactly the question set this advisor asks. Point the host at it:

```ts
// Embedded host.
const advisor = createJevAdvisor({ apiKey: "local", baseUrl: "http://127.0.0.1:11435" });
```

```bash
# Server deployment — the same thing through the environment:
PENGUIN_JEV_API_KEY=local
PENGUIN_JEV_BASE_URL=http://127.0.0.1:11435   # loopback only; anything else must be https
```

**The loopback rule is the whole security story of this option.** `baseUrl` may be `http` only
when the host is a loopback address, because that traffic never leaves the machine. Any other
cleartext endpoint is refused before a request is made — a remote `http://` would put the host's
key on the wire in the clear. `https://` remote endpoints are accepted as-is.

**One trap worth naming.** That provider's own documentation says its clients work by setting one
environment variable. This client deliberately ignores it: a host-owned key must never be
redirectable by ambient state, so `TYPESAFE_BASE_URL` has no effect here. A host that sets the
variable and forgets `baseUrl` will keep talking to the endpoint the host itself chose, and see no
error. Pass the option.

What a local provider changes, and what it does not:

| | Hosted API | Local decision model |
|---|---|---|
| `choice` / `score` / `noul` questions | supported | supported |
| Latency per observation | hundreds of ms | single-digit to tens of ms |
| Tool arguments leaving the machine | metadata only, by default | never, if it stays on loopback |
| Authority | none — advisory only | none — advisory only |

Authority is unchanged in both cases. A local provider is a *faster, private* advisor, not a
trusted one: it is still an opinion, and it still cannot allow, deny, or satisfy an approval.

### Everything else

The `JEV-Family/` corpus contains other products with overlapping names — fast, compact, Go,
Python, Rust, enterprise variants. **None of them is integrated here.** No compatibility is
implied by a shared name: an adapter would have to satisfy the same contract (bounded
metadata-only input, a hard deadline, no redirect, no unbounded retry, a closed output vocabulary,
advisory-only semantics) and pass the same conformance suite. Until one does, treat them as out of
scope rather than as interchangeable backends.

