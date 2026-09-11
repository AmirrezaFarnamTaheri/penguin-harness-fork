---
name: qa-regression-tester
description: Automated regression testing, CI test sweeper loops, coverage threshold validation, and flaky test isolation.
---

# QA Regression Tester

Guard against regressions through systematic test suite execution, coverage verification, and root-cause flakiness mitigation.

## Regression Workflow

1. **Pre-Flight Test Suite Run**:
   - Execute project-native test runners (`pnpm test`, `pytest`, `cargo test`, `go test ./...`).
   - Distinguish pre-existing test failures from new regressions introduced by current changes.

2. **Coverage & Quality Verification**:
   - Check test coverage across newly authored or modified functions.
   - Verify that test cases cover error branches, input sanitization, and fallback paths.

3. **Flakiness Detection & Quarantine**:
   - Identify race conditions, unhandled asynchronous promises, and clock-dependent failures.
   - Quarantine flaky tests with explicit issue links while implementing deterministic synchronization.

4. **CI Matrix Sweeping**:
   - Validate compatibility across target Node/Python runtimes and operating systems (Linux, macOS, Windows).
