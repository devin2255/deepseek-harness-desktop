# Agent Note: Task review and delivery

Status: implemented

English | [中文](2026-09-13-task-review-delivery.zh.md)

## Problem

Application-owned worktrees isolated concurrent root Tasks, but the desktop could not inspect or deliver their results. A user had to locate a managed directory and run Git manually, while the Task log could not prove which revision was reviewed, committed, applied, or discarded. Giving the Renderer filesystem or Git access would also violate the desktop authority model.

## Decision

`dsh-task-review` defines the Host-only review and delivery service. It exposes bounded summary and per-file diff reads plus Commit, Apply, and Discard mutations. Every mutation carries the exact review revision. `dsh-task-review-local` implements the service with Git through the managed subprocess capability. `dsh-host-apiproxy` is the only remote Consumer: it resolves the durable root-Task worktree assignment, enforces lifecycle and sequence preconditions, invokes the Provider, and records a successful receipt through `ctx.tasks`.

A review summary identifies the Task, Workspace, recorded base, current worktree commit, current source `HEAD`, branch, source dirtiness, bounded file list, and an opaque revision. The revision hashes the worktree identity and complete changed contents, including untracked files. File paths must be exact normalized members of that summary. Text diffs are bounded unified patches; binary and truncated results remain explicit values rather than empty success states.

Commit requires a ready Task and a complete, current review. It stages the reviewed worktree, creates one commit on the Task branch, and does not modify the source checkout. Apply requires the exact recorded Task commit and committed revision. It serializes by canonical source repository, requires a clean source at the requested `HEAD`, produces one bounded binary patch from the assignment base to the Task commit, and runs a three-way check before any source mutation. A temporary index provides a second non-mutating simulation. The Provider then rechecks source `HEAD` and status and applies the same bytes to the real index and working tree. Source `HEAD` remains unchanged.

Discard operates only on the exact Git-registered managed worktree. Dirty uncommitted content requires explicit loss confirmation and is reported as unrecoverable. A committed branch is retained and its commit is returned as recovery information. Cleanup failures do not claim the worktree was removed.

The Task session log owns `task/review-committed`, `task/review-applied`, and `task/review-discarded`. Strict replay validates Task and Workspace ownership, operation order, branch and commit identity, review revision, and source-HEAD invariants. A generic review decision can request changes or declare readiness but cannot forge a Git-backed delivery result. The TypeScript and Python SDKs project the same operations and values.

The Client runtime owns asynchronous review state and typed actions. `dsh-client-ui-task-review` contributes a separate Review workspace with criteria, risks, verification evidence, branch and base facts, changed files, unified diff, and distinct Request Changes, Commit, Apply, and Discard actions. Loading, empty, binary, truncated, stale, conflict, confirmation, success, and retry states remain visible. The Renderer never receives a native path capability or Git command surface.

## Alternatives considered

**Run Git in Electron Main or the Renderer.** Rejected because presentation code would gain repository mutation authority and bypass Host lifecycle, authorization, persistence, and plugin replacement.

**Apply immediately when an Agent finishes.** Rejected because completion is not human approval, concurrent source state may have changed, and an automatic mutation cannot prove which changes the user inspected.

**Merge or cherry-pick the Task commit into the source branch.** Rejected for this stage because either operation moves source history and introduces broader conflict and rollback semantics. Apply leaves a staged, inspectable result while preserving source `HEAD`.

**Use only a worktree `HEAD` as the review token.** Rejected because staged, unstaged, and untracked changes can change without moving `HEAD`. The opaque revision includes all reviewed contents.

**Delete every Task branch during Discard.** Rejected because a committed branch is the recovery mechanism. Only the verified managed worktree is removed.

## Consequences

An isolated root Task now has an end-to-end path from concurrent execution through human review to a staged source result. Stale content, dirty or moved sources, conflicts, invalid paths, incomplete output, and missing Git identity fail explicitly. Successful delivery facts survive Renderer reload and cold replay. Apply does not create the user's final source commit; that remains a deliberate project action. Child-writer isolation, automatic reconciliation between concurrent writers, Task archival, and cleanup of partial worktree-creation failures remain separate work.

## Verification

Service and local-Provider tests cover typed registration, strict invariants, real-Git summaries and diffs, text and binary data, truncation, cancellation, stale revisions, identity failures, Commit, clean Apply, dirty and moved source rejection, conflict preflight with unchanged source state, and recoverability-aware Discard. Task and Host tests cover strict event replay, lifecycle authorization, sequence comparison, durable receipts, and safe error projection. TypeScript and Python SDK tests cover equal protocol vocabulary. Client tests cover runtime refresh and every user-visible review state. The keyless assembled Web scenario exercises Request Changes, Commit, Apply, file selection, and durable success. The Electron acceptance uses disposable real repositories to deliver text and binary changes, prove conflict preflight preserves source `HEAD`, index, status, and bytes, preserve a committed branch during Discard, reload the Renderer, and compare durable Apply and Discard receipts.
