# Agent Note: Batch isolated writer integration

Status: implemented

English | [中文](2026-10-07-batch-writer-integration.zh.md)

## Problem

[Isolated writers](2026-10-06-isolated-subagent-writer-preparation.md) and [continuation](2026-10-07-isolated-writer-continuation.md) retain independent changes, but their root needs an exact, reviewable combined result. Applying children sequentially exposes a partial batch when a later child conflicts. Integration into a managed root must remain separate from delivery into the user's source checkout.

## Decision

`TaskReviewService.integrate` accepts an exact root review and an ordered batch of child assignments, review revisions, and commits. The local Provider rejects empty, duplicate, foreign, over-limit, incomplete, dirty, stale, or already integrated selections. Each child HEAD must equal the selected commit, and its baseline must remain in root history. `maxIntegrationInputs` bounds the batch, defaulting to 16.

Git `merge-tree --write-tree` computes merges without changing indexes, branches, or working trees. `commit-tree` prepares unreachable two-parent commits retaining contributor ancestry. A conflict returns the exact batch and conflicting child paths without publishing earlier candidates. After all merges succeed, the Provider revalidates every review and clean working tree, then publishes one `merge --ff-only --no-autostash` on the root. Child branches and the original checkout remain unchanged; preparation objects may remain unreachable for ordinary Git garbage collection.

Caller cancellation is honored through final revalidation. Final publication and verification retain command deadlines but omit caller cancellation. Git failures or inconsistent final HEADs return errors, not receipts; no destructive reset conceals an ambiguous outcome. External Git writers and hooks are not locked out. This is not a filesystem transaction or execution lease.

The opt-in `dsh-tool-subagent-control/integrate` Consumer registers review, child commit, and integration tools. It requires the exact registered root Agent in its available managed worktree and recorded child assignments matching immutable direct-parent metadata, Workspace, source directory, and cwd. Active or resident children are rejected; cold inspection does not activate them. Mutations enforce root write authority in the executor. Schema-validated JSON results use generic cards and ordinary durable tool results, not a second Task database or human-approval record.

Writer creation accepts a clean committed root even when its HEAD differs from the original assignment base. The worktree Provider owns required-clean and captured-HEAD checks; review changes relative to the original base do not imply uncommitted work. Subsequent writer waves use the integrated HEAD.

## Alternatives considered

**Apply each child immediately.** Rejected because a later conflict leaves earlier results published. The complete candidate history is prepared before changing the root.

**Merge into the original checkout.** Rejected because integration precedes human root review. The [root delivery decision](2026-09-13-task-review-delivery.md) retains ownership of Commit, staged Apply, and recoverable Discard.

**Resolve conflicts automatically or reset after failure.** Rejected because either can overwrite independent work or conceal an ambiguous result. Errors and conflicts preserve contributor branches for inspection.

## Consequences

Explicitly composed agents can review, commit, and integrate stopped isolated writers and start another writer wave. The execution and root-delivery notes remain active because their ownership and recovery rationale still apply; this note owns batch publication only. [Integration history](2026-10-08-task-integration-history.md) owns explicit nodes and durable conflict attention. Desktop defaults remain read-only. Human integration and conflict-resolution controls, cross-process leases, orphan recovery, and full desktop acceptance remain incomplete mission-control requirements.

## Verification

Real Git tests cover complete publication, retained branches, unchanged source, later-conflict non-publication, stale revisions, dirty trees, and repeated integration. Executor tests cover root identity, write denials, active and resumed children, cold ownership, diffs, and plugin disposal. Fault tests cover process-output validation, ancestry, identity, cancellation ordering, and final HEAD checks. A real Loader composition replaces only model responses and drives filesystem tools and the root agent loop through four reviews, four commits, conflict and success batches, and another writer wave. Keyless evidence does not establish live-model or desktop integration UI acceptance.
