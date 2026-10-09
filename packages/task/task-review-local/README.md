# @deepseek-ai/dsh-task-review-local

English | [中文](README.zh.md)

Local Git Provider for `ctx.taskReview`. Summary and file Diff reads validate the complete recorded worktree assignment against Git's live worktree registry, then compare the Task worktree with its recorded base commit. Summaries include committed, staged, unstaged, renamed, deleted, conflicted, and untracked changes without modifying the source checkout.

Review revisions hash the final changed paths, entry modes, and content relative to the recorded base, normalizing staging-only changes that do not alter the resulting files. A file Diff requires the displayed revision and an exact member path; arbitrary absolute paths, traversal, stale reviews, missing worktrees, and diverged branches fail closed. Returned file lists and patches use configurable limits, with truncation represented explicitly.

Commit prepares the reviewed final tree in a private temporary index, retaining its parent HEAD and Git tree for authorization. Preparation leaves the real index, working tree, and branch unchanged but may write unreachable Git objects. It rechecks the review before and after authorization, then stages the real index and requires the staged tree and resulting commit's parent and tree to match. Hooks or filters producing another tree reject without a success receipt; post-authorization changes remain unconfirmed.

Apply requires a committed, clean Task worktree and a clean source checkout at the displayed source HEAD. It runs Git's three-way check and then simulates the complete three-way Apply against an isolated temporary index; only a successful simulation permits the same bounded patch to enter the real source index. Discard requires explicit confirmation before removing uncommitted data, retains the Task branch, and reports whether a commit remains recoverable.

Every Git command runs without a shell through the managed subprocess service, with configured output, deadline, and termination bounds.

When supplied, delivery authorization is awaited inside the repository queue after final preflight: before Commit stages files, Apply changes the source index, or Discard removes the worktree. Its operation id is returned unchanged. Authorization failure prevents mutation, and cancellation is rechecked after the callback. Failures after authorization may still leave Git changed; the Consumer must retain uncertainty rather than infer rollback.

Discard passes its current worktree HEAD and actual uncommitted-change flag to authorization, not the original Commit receipt. After the callback settles, it rechecks the reviewed contents and uncommitted-change flag before removal. Changes during that checkpoint reject without removing the directory; the durable intent remains unconfirmed. This check does not lock external writers.

Commit, Apply, Integrate, and Discard share one in-process mutation queue per canonical Git common directory. Root and child worktrees therefore cannot enter overlapping Provider mutations even when their recorded source directories differ; unrelated repositories remain independent. Repository discovery precedes queue entry, and cancellation is checked again when a queued operation enters. This does not prevent Agent filesystem writes, external Git commands, hooks, or another process from changing the repository.

Batch integration requires Git with `merge-tree --write-tree` support, exact root and committed child review revisions, and clean working trees. It prepares the complete merge history as unreachable Git objects, rechecks every selection, then publishes one fast-forward into the root execution worktree. A conflict leaves all branches, indexes, and working trees unchanged. Caller cancellation stops preparation but does not interrupt final bounded publication or verification. A publication failure is reported without destructive reset; external Git writers and hooks are not locked out. See the [integration decision](../../../.agents/notes/implemented/feature/2026-10-07-batch-writer-integration.md).

Delivery inspection shares the common-repository queue, discovering it from the verified source root so a removed Task directory remains inspectable. Commit requires the authorized parent and tree with a clean result; Apply requires the complete simulated patch in both source index and files; Discard requires an absent path and registration with the original branch HEAD retained. Two differing observations return ambiguity. Private indexes avoid altering user indexes and bypass cached stat data and index flags when checking files; ordinary reads disable optional Git locks. Simulation can retain unreachable objects. No inspection appends a receipt, changes user files or refs, or establishes a cross-process lock. See the [inspection decision](../../../.agents/notes/implemented/feature/2026-10-09-root-delivery-inspection.md).

## Configuration

- `gitCommand` — bare or absolute Git executable; defaults to `git`.
- `commandTimeoutMs` — deadline for each Git command; defaults to 30 seconds.
- `terminateGraceMs` — managed process-tree termination grace; defaults to 2 seconds.
- `maxOutputBytes` — complete per-stream validation bound; defaults to 16 MiB.
- `maxDiffBytes` — returned UTF-8 patch bound; defaults to 2 MiB.
- `maxPatchBytes` — complete binary patch bound for Apply stdin; defaults to 16 MiB.
- `maxFiles` — returned summary file count; defaults to 2,000.
- `maxIntegrationInputs` — maximum selected writers per integration batch; defaults to 16.

## Model Experience

### Git review capability

#### What the model sees

Nothing directly. This Provider contributes no tool, prompt, Session event, or request field; Consumers own presentation and logging. The optional `review_agent_changes`, `commit_agent_changes`, and `integrate_agents` tools expose its bounded Git review data and operation receipts.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the Provider never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- Apply stages the reviewed patch in the source checkout but does not create a source-branch commit.
- Submodules, automatic conflict resolution, and cross-process execution leases are not supported.
