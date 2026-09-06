---
title: Reconcile superseded feature branches against current main
date: 2026-09-06
category: workflow-issues
module: Trackly CLI release workflow
problem_type: workflow_issue
component: development_workflow
root_cause: stale_branch
resolution_type: process_change
severity: medium
applies_when: A long-lived feature branch overlaps changes already merged to main
tags: [git, branch-reconciliation, exact-head, release-closeout]
---

# Reconcile superseded feature branches against current main

## Problem

A long-lived Trackly CLI branch accumulated a large Apply implementation while equivalent contract and dependency changes landed on `main`. The branch looked unfinished, but it was obsolete.

## Resolution

Before rebasing or force-pushing, compare the branch with current `origin/main` and run the full test suite on a clean current-main checkout. If the intended behavior is already present and the old branch conflicts or regresses tests, preserve the branch for audit history and close its PR as superseded. Treat current `main`, merged PRs, and green tests as the source of truth.

## Verification

`git diff origin/main...HEAD`, `gh pr view`, and `npm test` established that PR #137 was closed and unmerged, while the relevant work was already represented by merged PRs #132, #135, and #136.
