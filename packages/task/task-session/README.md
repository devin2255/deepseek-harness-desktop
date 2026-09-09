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

## Projection Rules

Ordinary forks remain independent root Tasks even when their header names a parent. A subagent chain must reach one present non-subagent root without a cycle; malformed ancestry rejects Provider startup instead of silently assigning work to the wrong Task. A known Session whose log cannot be inspected remains visible through an `unavailable` row.

A durable worktree assignment supersedes transient Workspace membership when projecting `workspaceId`, and the complete assignment is returned as `executionWorkspace`. Cold replay therefore preserves both the registered source project and the actual directory where the Agent ran.

Status precedence is actionable attention, unresolved failure, running activity, review in progress, explicitly proven readiness, then settled. Readiness requires a `ready` decision, every criterion satisfied or waived, and every risk resolved. Idle state never implies completion.

Pending durable approvals and the latest unresolved turn failure become attention items whose identity comes from the source request or event, not display text. Live facts name both the root and exact owner Session; facts with missing or foreign owners are ignored.

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
- Persistent attention currently derives from approval audit pairs and terminal turn failures. Validation, merge, and review systems must publish their supported attention facts when their owning capabilities are integrated.
- External persistence changes are observed at startup or when a live Session lifecycle crosses this process; cross-process log mutation does not yet have a watch feed.
- Removing a live Session that never materialized in persistence removes its Task row because no durable source remains.
