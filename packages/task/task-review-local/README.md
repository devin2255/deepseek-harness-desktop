# @deepseek-ai/dsh-task-review-local

English | [中文](README.zh.md)

Local Git Provider for `ctx.taskReview`. It validates the complete recorded worktree assignment against Git's live worktree registry before every inspection, then compares the Task worktree with its recorded base commit. Summaries include committed, staged, unstaged, renamed, deleted, conflicted, and untracked changes without modifying the source checkout.

Review revisions hash the tracked binary patch and the content digest of every untracked entry. A file Diff requires the displayed revision and an exact member path; arbitrary absolute paths, traversal, stale reviews, missing worktrees, and diverged branches fail closed. Returned file lists and patches use configurable limits, with truncation represented explicitly.

Every Git command runs without a shell through the managed subprocess service, with configured output, deadline, and termination bounds.

## Configuration

- `gitCommand` — bare or absolute Git executable; defaults to `git`.
- `commandTimeoutMs` — deadline for each Git command; defaults to 30 seconds.
- `terminateGraceMs` — managed process-tree termination grace; defaults to 2 seconds.
- `maxOutputBytes` — complete per-stream validation bound; defaults to 16 MiB.
- `maxDiffBytes` — returned UTF-8 patch bound; defaults to 2 MiB.
- `maxFiles` — returned summary file count; defaults to 2,000.

## Model Experience

### Operator-only Git review

#### What the model sees

Nothing. This Provider implements `ctx.taskReview` for Host-side consumers and contributes no tool, prompt, Session event, or request field.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the Provider never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- Commit, Apply, and Discard mutations are implemented by the next delivery stage.
- Submodules and child-writer worktree integration are not part of read-only review inspection.
