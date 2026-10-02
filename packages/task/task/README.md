# @deepseek-ai/dsh-task

English | [中文](README.zh.md)

The durable vocabulary and Service Definition for root tasks, application-owned execution worktrees, acceptance criteria, evidence, risks, review decisions, Git delivery receipts, and unified attention rows. Task facts use whole-value Session events with strict replay validation, so recovery never depends on process-local state. A worktree assignment records the source Workspace, creation commit, source-dirty digest, branch, and execution path exactly once. Evidence identifies an exact event sequence in the root task tree. Human review can only request changes or declare readiness; commit, apply, and discard state requires a complete Provider receipt.

## Model Experience

None, as task events are log-only facts and do not enter model requests or the model-visible Session surface.

#### KV Cache effect

None. Recording or replaying task facts does not change provider requests.

## Known Limitations and Deferred Work

- The Host creates worktrees and records assignments through this service; this package does not execute Git operations.
- The Host executes Git delivery operations before recording their successful receipts through this service.
- Evidence references are structurally validated here; the Provider validates that each referenced event belongs to the same root task tree.
