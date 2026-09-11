---
name: qa-tdd-architect
description: Test-Driven Development (TDD) engineering discipline covering red-green-refactor cycles, unit test authoring, mock/fixture isolation, and edge-case assertion across TypeScript, Python, Go, and Rust.
---

# QA TDD Architect

Enforce rigorous Test-Driven Development (TDD) across all feature implementations, refactoring tasks, and bug fixes.

## The TDD Iron Law

```
Red (Failing Test) ──> Green (Minimal Implementation) ──> Refactor (Clean Code) ──> Repeat
```

1. **Write the Failing Test First**:
   - Never write production code before observing a failing test case that asserts expected behavior or reproduces a bug.
   - Assert exact return types, status codes, error messages, and state mutations.

2. **Implement the Minimal Code to Pass**:
   - Write only enough code to turn the test green.
   - Do not prematurely abstract or over-engineer before multiple tests prove the need.

3. **Refactor Under Green Shield**:
   - Clean up code clarity, eliminate duplication, and improve variable naming while keeping the test suite green.

## Mocking & Isolation Principles

- Mock external boundaries (HTTP requests, file systems, clocks, random generators) rather than internal domain logic.
- Keep tests deterministic: zero sleep calls or reliance on external network access.
- Cover critical boundary values: empty collections, maximum byte limits, null/undefined inputs, and malformed structures.
