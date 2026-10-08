# @deepseek-ai/dsh-task-session

English | [中文](README.zh.md)

Session-backed Provider for the durable Task service. It reconstructs one Task per non-subagent root Session, assigns only uninterrupted `origin: 'subagent'` descendants to that root, and combines durable logs with generation-scoped live facts. Cold history is inspected without resuming an Agent; exact live Session logs supersede persisted snapshots.

## Service: `TaskSessionProvider` (ctx key: `tasks`)

### Public API

- `snapshot(): TaskListSnapshot` returns a detached baseline containing all known roots, descendant ids, persistent task facts, derived status, attention, freshness, and the current runtime generation.
- `onChanged(listener): () => void` publishes detached whole-row upserts and removals. One failing listener is logged and cannot starve later listeners.
- `replaceLiveGeneration(generation, facts): void` atomically replaces activity and interactive attention for a current or newer generation. Publications from older or invalidated generations are ignored.
- `invalidateLiveGeneration(generation): void` retains the last known live facts but marks affected rows `disconnected` until a newer baseline arrives.
- `assignWorktree` records one immutable execution assignment after validating the root Task and registered source Workspace. Reassignment, mismatched Task identity, missing Workspace identity, and source-path mismatch fail before append.
- `define`, `updateCriterion`, `recordRisk`, and `review` serialize compare-and-set writes, validate the root and same-tree evidence, and append exactly one whole-value event.
- `startDelivery` rejects active Task trees, compares `expectedSeq`, and checkpoints one validated delivery intent before Git mutation.
- `recordCommit`, `recordApply`, and `recordDiscard` append and checkpoint a complete Git Provider receipt matching the outstanding intent. Unrelated Session appends do not stale completion.
- `retryDeliveryCheckpoint` serializes a save of the exact advertised live receipt, appending no event and executing no Git. Session replacement or detachment before or during the checkpoint rejects; save failures preserve unconfirmed attention.

## Projection Rules

Ordinary forks remain independent root Tasks even when their header names a parent. A subagent chain must reach one present non-subagent root without a cycle; malformed ancestry rejects Provider startup instead of silently assigning work to the wrong Task. A known Session whose log cannot be inspected remains visible through an `unavailable` row.

A durable worktree assignment supersedes transient Workspace membership when projecting `workspaceId`, and the complete assignment is returned as `executionWorkspace`. Cold replay therefore preserves both the registered source project and the actual directory where the Agent ran.

Status precedence is actionable attention, unresolved failure, running activity, durable delivery, review in progress, explicitly proven readiness, then settled. Readiness requires a `ready` decision, every criterion satisfied or waived, and every risk resolved. A valid commit, apply, or discard receipt produces settled state. Idle state never implies completion.

Pending durable approvals and the latest unresolved error or crash-repaired interrupted turn become attention items whose identity comes from the source request or event, not display text. An interrupted turn is a non-actionable run failure; it replaces process-local question attention after a Host crash and never reissues the unconfirmed tool call. Live facts name both the root and exact owner Session; facts with missing or foreign owners are ignored.

An outstanding delivery intent produces root-owned `delivery-unconfirmed` attention and rejects root `agent/pre-step` admission. It survives cold replay without Git execution. Task metadata remains blocked until a correlated receipt is durable. During a live receipt checkpoint, and after checkpoint failure, an independent checkpoint owner keeps the projection unconfirmed even though the receipt is already in memory. A missing flush participant rejects authorization or completion; successful live checkpoints and cold persistence appends precede acknowledgment.

Root `integrate_agents` calls reconstruct ordered `integrations` from native and Code Mode tool events. Complete receipts must match the recorded root assignment, selected revisions and commits, and direct child ownership. Missing, spilled, or unverifiable results remain `unconfirmed`; running activity never proves publication. Unresolved preflight conflicts create root-owned merge attention. Later successful batches clear that attention only after covering every selected writer, including revised commits; historical conflicts retain their outcomes and identify the last covering node. See the [integration-history decision](../../../.agents/notes/implemented/feature/2026-10-08-task-integration-history.md).

## Model Experience

### Operator-only Task projection

#### What the model sees

Nothing. `TaskSessionProvider` reads operator-facing Session events and live facts, but registers no tool, injects no prompt, and contributes no model-visible message or request field.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: this Provider never assembles or mutates a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- Live activity and question attention depend on a Consumer publishing one complete generation through `replaceLiveGeneration`; the desktop Host owns that publication from its Agent and pending-question registries.
- Persistent attention derives from approval audit pairs, terminal error and interrupted turns, delivery intents, and validated integration conflicts. Other validation and review systems must publish their supported attention facts when their owning capabilities are integrated.
- Delivery without an exact live receipt has no manual reconciliation API. Refresh only reads state; Git and Session persistence are not one atomic transaction.
- External persistence changes are observed at startup or when a live Session lifecycle crosses this process; cross-process log mutation does not yet have a watch feed.
- Removing a live Session that never materialized in persistence removes its Task row because no durable source remains.
