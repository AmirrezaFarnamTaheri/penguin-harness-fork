# Output Formats Reference

**Purpose:** Templates for PDM's deliverables.
**Read when:** You are at REPORT and need a status-matrix, inventory, gap, roadmap, or WBS format.

## Contents
- Status Matrix (default)
- Feature Inventory
- Gap / Unimplemented List
- Roadmap View
- WBS Tree
- Drift Report
- Navigator Answer (ask)

Every format keeps documented intent and implemented reality visibly distinct, carries evidence + confidence, and ends with "What I couldn't reconcile."

---

## Status Matrix (default)

```markdown
## Project Status: [Project Name]

**Sources:** specs (`docs/`), issues (`gh`, 24 open), roadmap (`ROADMAP.md`)
**Delivery:** 18/30 features Done (60%) · 5 In-Progress · 5 Not-Started · 2 Undocumented

| Feature | Area | Status | Conf. | Plan ref | Code evidence |
|---------|------|--------|-------|----------|---------------|
| User login | Auth | Done | High | spec §2.1 | `auth.ts:15` |
| Refund | Payments | Not-Started | Med | issue #142 | none (searched src/payments/**) |
| Audit log | Platform | Undocumented | High | — | `audit/logger.ts:8` |

### By Area
| Area | Done | In-Progress | Not-Started |
|------|------|-------------|-------------|
| Auth | 5 | 0 | 0 |

### Drift
- Payments: CHANGELOG claims "refunds shipped" — no code found. (phantom-shipped)

### What I couldn't reconcile
- "Notifications" epic (issue #88) — ambiguous scope; no spec, multiple partial modules.
```

---

## Feature Inventory

```markdown
## Implemented Features: [Project Name]

| Feature | Area | Entry point | Tests | Confidence |
|---------|------|-------------|-------|-----------|
| Login | Auth | `auth.ts:15` | yes | High |
| Export CSV | Reports | `export.ts:40` | no | Medium |

> Undocumented (built, no plan source): Audit log (`audit/logger.ts:8`)
```

---

## Gap / Unimplemented List

```markdown
## Unimplemented Features: [Project Name]

| Feature | Plan ref | Status | Search coverage | Confidence |
|---------|----------|--------|-----------------|-----------|
| Refund | issue #142, roadmap v2 | Not-Started | src/payments/**, routes, tests | Medium |
| SSO | spec §5 | In-Progress | `sso.ts:12` stub, flag off | High |

### Offers
- Prioritize these → `PDM_TO_RANK_HANDOFF`
- Decompose SSO into execution steps → `PDM_TO_SHERPA_HANDOFF`
```

---

## Roadmap View

Order is presented **as found in artifacts** — PDM does not score priority.

```markdown
## Roadmap: [Project Name]

### Shipped (verified in code)
- v1.0 — Auth, Dashboard ✅ (`auth.ts`, `dashboard/`)

### In-Progress
- v1.1 — SSO (flag off, `sso.ts:12`)

### Planned (not started)
- v2.0 — Refunds (issue #142), Notifications (issue #88)

> Ordering reflects milestones as-found. Priority scoring deferred to Rank.
```

---

## WBS Tree

Static scope view from artifacts. Execution decomposition deferred to Sherpa.

```markdown
## WBS: [Project Name]

- Project: Payments v2 (milestone)
  - Epic: Refunds (issue #142) — Not-Started
    - Feature: Refund endpoint — Not-Started
    - Feature: Refund ledger entry — Not-Started
  - Epic: Payouts (issue #150) — In-Progress
    - Feature: Payout schedule — Done (`payouts.ts:30`)
    - Feature: Payout retry — In-Progress (`payouts.ts:75` stub)

> Tree nodes trace to real epics/issues. Atomic execution steps → Sherpa.
```

---

## Drift Report

```markdown
## Drift Report: [Project Name]

| Item | Plan says | Code says | Drift type | Confidence |
|------|-----------|-----------|------------|-----------|
| Refunds | CHANGELOG: shipped | no endpoint found | phantom-shipped | High |
| Audit log | (none) | implemented | ghost feature | High |
```

---

## Navigator Answer (ask)

Compact, per-turn (tier S):

```markdown
**Refunds: Not-Started** — issue #142 / roadmap v2; no code (searched `src/payments/**`). Confidence: Medium.

> Next: want the full v2 gap list, or hand refunds to Rank to prioritize?
```
