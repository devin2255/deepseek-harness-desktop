# Agent Note: Committed Task worktree reuse

Status: implemented

English | [中文](2026-10-06-committed-task-worktree-reuse.zh.md)

## Problem

The worktree assignment retains the Task's creation base for review and delivery. Inspection that equates that immutable base with the current HEAD rejects a valid Task after its first commit. An idempotent isolated Session creation request then reports divergence even though Git still registers the same owned checkout and branch.

## Decision

The local Task worktree Provider requires the exact canonical registered path and branch. The registered HEAD is available when it equals the recorded base or Git confirms that base is its ancestor. A detached checkout, unavailable commit object, or unrelated history remains diverged. Inspection does not repair refs, modify files, or rewrite the assignment.

This extends the reuse rule in [application-owned Task worktrees](../feature/2026-09-09-application-owned-task-worktrees.md) without replacing its isolation, ownership, preflight, or failure-preservation decisions. The [review and delivery](../feature/2026-09-13-task-review-delivery.md) capability continues to authorize mutations against the exact reviewed contents and record separate operation receipts.

## Alternatives considered

**Replace the assignment base after each commit.** Rejected because review and source application need the original creation base, and a later commit is not a new worktree assignment.

**Require only the path and branch to match.** Rejected because the branch can retain its name while pointing to unrelated history. Git ancestry retains the recorded base as a required relationship.

**Accept only commits recorded by the review service.** Rejected because the Agent or a user can legitimately commit inside the Task checkout. Inspection checks repository identity and ancestry; review authorization remains a separate obligation.

## Consequences

Valid committed Tasks can be reused without a new directory, assignment event, or base replacement. Rewrites that still retain the creation base are permitted; this is not a promise to preserve every later commit. Missing or unrelated history remains unavailable for reuse. Child-writer worktrees and explicit Integration nodes remain separate, incomplete product work.

## Verification

Real Git tests distinguish a descendant commit, a detached checkout, and rewritten root history while checking the unchanged source branch and files. A keyless real-Loader transcript pins the same inspection outcomes. The Electron acceptance retries isolated Session creation after a real review commit and verifies the original assignment, Task sequence, and commit receipt are unchanged before source application.
