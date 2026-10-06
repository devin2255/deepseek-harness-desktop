# @deepseek-ai/dsh-task-worktree

English | [中文](README.zh.md)

Service Definition for application-owned execution worktrees. A Provider creates an isolated Git checkout for a root Task or an isolated writer Session and returns complete assignment facts. The `taskId` identifies that execution's owning Session; child assignment does not make the child a root Task. Consumers record the facts in the owning Session log. `decodeTaskWorktreeAssignment` strictly validates recorded JSON, while `inspect` compares those facts with live Git registration without repairing or deleting anything. Commits descended from the recorded base retain the same assignment identity.

Creation may require an exact `expectedSourceHead` and `requireCleanSource`. The isolated writer consumer uses both to reject a changed or uncommitted integration baseline before creating a checkout; ordinary root-task creation still records dirty source state without copying it.

Creation never permits an implicit direct-workspace fallback. The consuming Host decides whether direct execution is an explicit alternative and records the chosen execution directory through ordinary Session ownership.

## Model Experience

None, as this Host capability contributes no prompt, tool, or model-visible session event.

#### KV Cache effect

None; this package neither assembles nor changes a model request.

## Known Limitations and Deferred Work

- This package does not define Apply, Commit, Discard, or child-writer integration operations.
- Provider-specific repository support and storage layout are outside this Service Definition.
