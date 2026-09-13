---
name: gh-issue-lifecycle
description: Complete GitHub Issue lifecycle management via GitHub CLI (gh) covering issue creation, label assignment, triage, milestone tracking, and resolution.
---

# GitHub Issue Lifecycle Manager

Structured issue management, assignment, compilation, and triage using the GitHub CLI (`gh`).

## Workflows

### 1. Issue Creation
- File new issues with standardized labels and markdown templates:
  ```bash
  gh issue create --title "<type>: <brief title>" --body-file .issue_body.md --label "bug,triage"
  ```

### 2. Triage & Assignment
- List open issues filtered by label or milestone:
  ```bash
  gh issue list --state open --label "triage"
  ```
- Assign issues to team members:
  ```bash
  gh issue edit <issue-number> --add-assignee "@username" --add-label "in-progress"
  ```

### 3. Issue Resolution & Closure
- Add comments summarizing resolution diffs or linking pull requests:
  ```bash
  gh issue comment <issue-number> --body "Resolved in PR #123."
  gh issue close <issue-number> --reason "completed"
  ```
