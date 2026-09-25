# @deepseek-ai/dsh-task-review

English | [中文](README.zh.md)

The Service Definition for reviewing and delivering changes from a Task-owned worktree. Providers expose bounded review summaries and file diffs, then return durable receipts for Commit, Apply, and Discard operations.

Every file diff belongs to an exact `TaskReviewRevision`. Mutations require that same revision and fail when the worktree changes after the user reviewed it. A summary also carries the source checkout's live HEAD and dirty state; Apply requires the displayed source HEAD so a later move fails before mutation. Requests carry the complete recorded `TaskWorktreeAssignment`; consumers never supply an arbitrary repository path.

This package contains no Git implementation and no presentation labels. A Provider owns repository inspection, mutation serialization, preflight checks, and operation identities. Commit receipts identify the resulting revision, Apply receipts preserve source HEAD facts from before and after the operation, and Discard receipts distinguish unrecoverable uncommitted loss from a preserved commit. The Task consumer records successful receipts in the root Session log.

## Model Experience

### Operator-only Task review

#### What the model sees

Nothing. `ctx.taskReview` serves Host-side consumers only: this package registers no tool, injects no prompt, and writes no Session event, so no request field carries its data.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: this package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- Repository support, output limits, and cleanup policy belong to the selected Provider.
- The Service Definition does not authorize a Renderer to access Git or the filesystem directly.
