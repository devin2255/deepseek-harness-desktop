# @deepseek-ai/dsh-task-worktree

English | [中文](README.zh.md)

Service Definition for application-owned Task integration worktrees. A Provider creates an isolated Git checkout for one root Task and returns complete assignment facts that the Task consumer records in the root Session log. `inspect` compares those recorded facts with the live Git registration without repairing or deleting anything.

Creation never permits an implicit direct-workspace fallback. The consuming Host decides whether direct execution is an explicit alternative and records the chosen execution directory through ordinary Session ownership.

## Model Experience

None. This package declares a Host capability and adds no tool or model-visible text.

## Known Limitations and Deferred Work

- This package does not define Apply, Commit, Discard, or child-writer integration operations.
- Provider-specific repository support and storage layout are outside this Service Definition.
