# @deepseek-ai/dsh-task-review-local

English | [中文](README.zh.md)

Local Git Provider for `ctx.taskReview`. It validates the complete recorded worktree assignment against Git's live worktree registry before every inspection, then compares the Task worktree with its recorded base commit. Summaries include committed, staged, unstaged, renamed, deleted, conflicted, and untracked changes without modifying the source checkout.

Review revisions hash the final changed paths, entry modes, and content relative to the recorded base, normalizing staging-only changes that do not alter the resulting files. A file Diff requires the displayed revision and an exact member path; arbitrary absolute paths, traversal, stale reviews, missing worktrees, and diverged branches fail closed. Returned file lists and patches use configurable limits, with truncation represented explicitly.

Commit stages the complete reviewed final tree and writes one commit on the Task branch. Apply requires a committed, clean Task worktree and a clean source checkout at the displayed source HEAD. It runs Git's three-way check and then simulates the complete three-way Apply against an isolated temporary index; only a successful simulation permits the same bounded patch to enter the real source index. Discard requires explicit confirmation before removing uncommitted data, retains the Task branch, and reports whether a commit remains recoverable.

Every Git command runs without a shell through the managed subprocess service, with configured output, deadline, and termination bounds.

Batch integration requires Git with `merge-tree --write-tree` support, exact root and committed child review revisions, and clean working trees. It prepares the complete merge history as unreachable Git objects, rechecks every selection, then publishes one fast-forward into the root execution worktree. A conflict leaves all branches, indexes, and working trees unchanged. Caller cancellation stops preparation but does not interrupt final bounded publication or verification. A publication failure is reported without destructive reset; external Git writers and hooks are not locked out. See the [integration decision](../../../.agents/notes/implemented/feature/2026-10-07-batch-writer-integration.md).

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
