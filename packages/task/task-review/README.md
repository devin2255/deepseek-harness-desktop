# @deepseek-ai/dsh-task-review

English | [中文](README.zh.md)

The Service Definition for reviewing and delivering changes from a Task-owned worktree. Providers expose bounded review summaries and file diffs, then return exact receipts for Commit, Apply, Discard, and batch writer integration.

Every file diff belongs to an exact `TaskReviewRevision`. Mutations require that same revision and fail when the worktree changes after the user reviewed it. A summary also carries the source checkout's live HEAD and dirty state; Apply requires the displayed source HEAD so a later move fails before mutation. Requests carry the complete recorded `TaskWorktreeAssignment`; consumers never supply an arbitrary repository path.

This package contains no Git implementation and no presentation labels. A Provider owns repository inspection, mutation serialization, preflight checks, and operation identities. Commit receipts identify the resulting revision, Apply receipts preserve source HEAD facts from before and after the operation, and Discard receipts distinguish unrecoverable uncommitted loss from a preserved commit. The Task consumer records successful receipts in the root Session log.

Integration selects exact committed child reviews and one root review. A conflict returns contributor identities and conflicting paths without changing branches or working trees. Success moves only the root execution branch and preserves contributor branches; it never applies changes to the user's original checkout. The [writer tools](../../subagent/tool-subagent-control/README.md#isolated-writer-results) retain integration receipts in ordinary durable tool results, independently of root delivery receipts.

## Model Experience

### Review capability

#### What the model sees

Nothing directly. This package registers no tool, injects no prompt, and writes no Session event. Host and model-facing Consumers own presentation and logging; the optional `review_agent_changes`, `commit_agent_changes`, and `integrate_agents` tools return review data and operation receipts from this service.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: this package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- Repository support, output limits, and cleanup policy belong to the selected Provider.
- The Service Definition does not authorize a Renderer to access Git or the filesystem directly.
