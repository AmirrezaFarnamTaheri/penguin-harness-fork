# Source Triangulation Reference

**Purpose:** Where and how to locate planning artifacts and pair them with code evidence.
**Read when:** You are at LOCATE and need to find the plan side and the code side.

## Contents
- The Two Sides
- Plan-Side Sources
- Code-Side Signals
- Triangulation Strategy
- Multi-Repo / Multi-Service Scope
- When a Side Is Missing
- Source Confidence

---

## The Two Sides

PDM reconciles **intent** (what was planned) against **reality** (what is built). LOCATE must establish both. A status produced from one side alone is not a status — it is half a finding.

---

## Plan-Side Sources

Search in rough order of authority. Stop broadening once you have a coherent scope picture.

| Source | How to find | Signal |
|--------|-------------|--------|
| Specs / PRD / SRS | `docs/`, `spec/`, `*.md` with requirement language; request `SCRIBE_TO_PDM_HANDOFF` | Authoritative planned scope |
| Issue tracker | `gh issue list --state all` (capture state: open/closed/reopened), `gh issue list --label feature` | Granular planned/active work; state is a status signal — see `reconciliation.md` §Issue-State Cross-Signal |
| Milestones / Projects | `gh api repos/:owner/:repo/milestones`, project boards | Roadmap grouping |
| Labels | `gh label list` (e.g. `epic`, `mvp`, `v2`) | Scope/phase tagging |
| ROADMAP file | `ROADMAP.md`, `roadmap/` | Explicit roadmap intent |
| CHANGELOG / releases | `CHANGELOG.md`, `gh release list` | What was *claimed* shipped (verify against code) |
| ADRs | `docs/adr/`, `ADR/` | Decisions implying planned scope |
| README "Features"/"Roadmap" | `README.md` sections | Lightweight scope when nothing else exists |

`gh` commands require a GitHub remote; fall back to local files when unavailable.

---

## Code-Side Signals

A feature is "built" when code evidence supports it. Signals, strongest first:

| Signal | How to find | Strength |
|--------|-------------|----------|
| Entry point | route/handler/CLI command/exported API for the feature | High |
| Tests | `describe`/`it` blocks naming the feature behavior | High (behavior intended + checked) |
| Core module | a module/dir owning the feature's logic | Medium |
| Feature flag | flag config gating the feature | Signals `In-Progress` if off/partial |
| Stub / TODO | empty handler, `throw NotImplemented`, `TODO` | Signals `Not-Started`/`In-Progress` despite presence |

Prefer a `LENS_TO_PDM_HANDOFF` for deep comprehension; PDM's own survey is for lightweight presence checks, not flow tracing.

---

## Triangulation Strategy

```
1. Plan side first: enumerate planned features/epics from the strongest available source.
2. Code side: for each planned feature, search for entry point → tests → module.
3. Reverse pass: scan code for features with NO matching plan item → Undocumented candidates.
4. Pair each feature: {plan_ref?, code_evidence?} → feed RECONCILE.
```

The reverse pass (step 3) is what surfaces `Undocumented` features and is easy to skip — do not.

---

## Multi-Repo / Multi-Service Scope

When a feature spans more than one repo or service (monorepo packages, micro-services, web + BFF + worker), one repo's view is half a status. The Ask First boundary fires when the boundary is unclear — confirm scope first, then reconcile per the rules below.

**Confirm before reconciling:** which repos/services are in scope, and whether the question is per-service or end-to-end (a feature can be `Done` in the API yet `Not-Started` in the UI).

| Situation | Strategy |
|-----------|----------|
| Monorepo, multiple packages | Use the package/dir as the `area`; the plan side is usually shared (one issue tracker). Reconcile each package, roll up per feature across packages. |
| Multi-service, one feature crosses services | Reconcile the feature **per service**, then derive an end-to-end status: it is `Done` only when every required service is `Done`; otherwise `In-Progress` with the lagging service named. |
| Separate repos, separate trackers | Locate each repo's plan side independently; never assume one repo's roadmap covers another. Flag cross-repo gaps as drift. |
| Scope boundary unclear | Ask First — do not silently pick one repo and present it as the whole. |

End-to-end rollup rule: a cross-service feature's status is the **weakest** of its per-service statuses, and its confidence the **lowest** of its parts. Name which service holds it back so the gap is actionable.

---

## When a Side Is Missing

| Situation | Action |
|-----------|--------|
| No plan source at all | Ask First: infer scope from code + README only (cap confidence at Medium) or stop. |
| No issue tracker, specs exist | Use specs; note issues unavailable. |
| CHANGELOG claims shipped, no code | Treat as drift — verify, flag, do not trust the claim. |
| Code present, no plan ref | `Undocumented`; do not invent a spec for it. |

---

## Source Confidence

Record where each side came from; it sets the ceiling on status confidence:
- Spec text read + code read → High eligible.
- Issue title only + entry point only → Medium.
- README bullet + no code, or code + no plan → Low (and usually `Not-Started`/`Undocumented`).
