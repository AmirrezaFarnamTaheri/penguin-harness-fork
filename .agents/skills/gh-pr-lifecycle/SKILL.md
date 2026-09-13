---
name: gh-pr-lifecycle
description: Complete GitHub Pull Request lifecycle management via GitHub CLI (gh) covering PR creation, code review, diff inspection, comment resolution, and CI failure triage.
---

# GitHub PR Lifecycle Manager

End-to-end pull request management using the official GitHub CLI (`gh`).

## Workflows

### 1. PR Creation
- Ensure the current branch is pushed to origin:
  ```bash
  git push -u origin <branch-name>
  ```
- Create pull request with structured body:
  ```bash
  gh pr create --base main --head <branch-name> --title "<type>: <concise description>" --body-file .pr_body.md
  ```

### 2. PR Review & Diff Inspection
- View pull request status, checks, and diffs:
  ```bash
  gh pr view <pr-number>
  gh pr diff <pr-number>
  gh pr checks <pr-number>
  ```
- Submit structured reviews:
  ```bash
  gh pr review <pr-number> --approve --body "Verified all test suites and implementation specs."
  gh pr review <pr-number> --request-changes --body "Please address edge cases identified in unit tests."
  ```

### 3. Addressing Feedback & Comments
- List outstanding comments and review threads:
  ```bash
  gh pr view <pr-number> --comments
  ```
- After making code fixes, push updates and notify reviewers.

### 4. CI Failure Diagnosis
- Inspect failed CI workflow logs:
  ```bash
  gh run list --branch <branch-name>
  gh run view <run-id> --log-failed
  ```
