# Handoff Formats Reference

**Purpose:** Inbound and outbound handoff templates for PDM.
**Read when:** You are receiving work from or routing work to a partner agent.

Canonical Nexus schema → `_common/HANDOFF.md`. These are PDM's domain-specific payloads.

## Contents
- Inbound
- Outbound
- Routing Rules

---

## Inbound

### NEXUS_TO_PDM_HANDOFF
```yaml
NEXUS_TO_PDM_HANDOFF:
  question: "[status / feature / roadmap / WBS question]"
  scope: "[repo, area, milestone, or 'whole project']"
  recipe_hint: "[status | features | gaps | roadmap | wbs | ask]"
  known_sources: "[any specs/issues already identified]"
```

### LENS_TO_PDM_HANDOFF
```yaml
LENS_TO_PDM_HANDOFF:
  features:
    - name: "[feature]"
      area: "[module/area]"
      evidence: ["file:line", "file:line"]
      signals: ["route", "tests", "flag"]
  tech_stack: "[language/framework]"
  confidence: "[High | Medium | Low]"
```

### SCRIBE_TO_PDM_HANDOFF
```yaml
SCRIBE_TO_PDM_HANDOFF:
  planned_features:
    - id: "[spec §ref / issue #]"
      name: "[feature]"
      scope: "[what it covers]"
      acceptance: "[summary, if any]"
```

### ATTEST_TO_PDM_HANDOFF
```yaml
ATTEST_TO_PDM_HANDOFF:
  conformance:
    - feature: "[feature]"
      spec_ref: "[§ref]"
      verdict: "[conformant | partial | non-conformant]"
      evidence: "[file:line / test]"
```

---

## Outbound

### PDM_TO_RANK_HANDOFF
```yaml
PDM_TO_RANK_HANDOFF:
  items_to_prioritize:
    - feature: "[feature]"
      status: "[Not-Started | In-Progress]"
      plan_ref: "[ref]"
      effort_hint: "[if observable from scope]"
  reason: "Roadmap assembled; priority scoring is Rank's domain."
```

### PDM_TO_SHERPA_HANDOFF
```yaml
PDM_TO_SHERPA_HANDOFF:
  epic: "[epic/feature to decompose]"
  current_state: "[Not-Started | In-Progress + what exists]"
  plan_ref: "[ref]"
  reason: "Static WBS view produced; atomic execution decomposition is Sherpa's domain."
```

### PDM_TO_ORBIT_HANDOFF
```yaml
PDM_TO_ORBIT_HANDOFF:
  loop_goals:                       # each item = exactly one Orbit loop goal
    - objective: "[single deliverable sized to one loop]"
      plan_ref: "[spec §ref / issue # / WBS leaf id]"
      gap_evidence:
        planned: "[planning source proving intent]"
        code_coverage: "[file:line built so far OR 'no code found' + search coverage]"
      status: "[Not-Started | In-Progress + what exists]"
      out_of_scope: "[adjacent work this loop must NOT touch, if known]"
      candidate_acs: "[OPTIONAL reconciled signals only — NOT authored ACs; Orbit hardens these into 3-6 measurable ACs]"
      verification_hint: "[observed test/command, if any]"
  reason: "Plan items sized to loop granularity; goal.md authoring + AC hardening is Orbit's domain (pdm is read-only)."
```

### PDM_TO_SCRIBE_HANDOFF
```yaml
PDM_TO_SCRIBE_HANDOFF:
  spec_gaps:
    - feature: "[Undocumented or under-specified feature]"
      code_evidence: "[file:line]"
      reason: "Implemented without a spec; needs documentation."
```

### PDM_TO_CANVAS_HANDOFF
```yaml
PDM_TO_CANVAS_HANDOFF:
  artifact: "[Roadmap View | Status Matrix | WBS Tree]"
  data: "[reconciled rows / tree]"
  preferred_diagram: "[roadmap timeline | status heatmap | tree]"
```

---

## Routing Rules

| Outbound trigger | Route to | Never do instead |
|------------------|----------|------------------|
| Items need priority order | Rank | Score them yourself |
| Epic needs execution steps | Sherpa | Decompose to atomic tasks yourself |
| Loop-sized work package needs a runner | Orbit | Author the `goal.md` / ACs yourself |
| Undocumented feature needs a spec | Scribe | Author the spec yourself |
| Gap could be a new feature idea | Spark | Ideate features yourself |
| Output needs a diagram | Canvas | Hand-draw beyond simple ASCII |
| Deep "how does it work" needed | Lens | Trace flows yourself |

Offer outbound handoffs as suggestions in the report; execute them only under Nexus AUTORUN or explicit user request.
