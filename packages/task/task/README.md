# @deepseek-ai/dsh-task

English | [中文](README.zh.md)

The durable vocabulary and Service Definition for root tasks, application-owned execution worktrees, acceptance criteria, evidence, risks, review decisions, Git delivery receipts, and unified attention rows. Task facts use whole-value Session events with strict replay validation, so recovery never depends on process-local state. A worktree assignment records the source Workspace, creation commit, source-dirty digest, branch, and execution path exactly once. Evidence identifies an exact event sequence in the root task tree. Human review can only request changes or declare readiness; commit, apply, and discard state requires a complete Provider receipt.

Optional `TaskSnapshot.integrations` contains ordered root-owned tool attempts, not additional Task events. Outcomes distinguish running, unconfirmed, failed, integrated, and conflict; `resolvedBy` identifies later batches covering all selected writers without rewriting a historical conflict. The [Session Provider](../task-session/README.md#projection-rules) owns reconstruction and conflict attention.

Human delivery first checkpoints `task/delivery-started`. `TaskDeliveryIntent` records the operation id, review revision, kind, and exact mutation inputs. Completion requires a matching Provider receipt, not the original Session sequence. Pending delivery blocks Task metadata changes and produces `delivery-unconfirmed` attention; unrelated Session events remain permitted. Receipt-only pre-release logs are rejected. See the [delivery journal decision](../../../.agents/notes/implemented/architecture/2026-10-08-root-delivery-journal.md).

`retryDeliveryCheckpoint` saves an already appended live receipt without executing Git or appending another event. `TaskSnapshot.retryableDeliveryCheckpoint` advertises its exact operation id only while the original Session still owns that receipt. Missing, replaced, or detached receipts reject; a failed save retains uncertainty.

## Model Experience

None, as task events are log-only facts and do not enter model requests or the model-visible Session surface.

#### KV Cache effect

None. Recording or replaying task facts does not change provider requests.

## Known Limitations and Deferred Work

- The Host creates worktrees and records assignments through this service; this package does not execute Git operations.
- Git and Session persistence are not atomic; unconfirmed delivery requires Git inspection and has no manual settlement operation yet.
- Evidence references are structurally validated here; the Provider validates that each referenced event belongs to the same root task tree.
