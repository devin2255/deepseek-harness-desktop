# Task Projection and Attention Queue Design

English | [中文](2026-09-07-task-projection-attention-design.zh.md)

Status: extracted from the approved desktop product specification; durable vocabulary, strict replay, and the Service Definition are implemented, while Provider, Host, client, and acceptance work remain.

## Purpose

This slice turns the desktop's activity overview into a durable task model without creating a second history store. One root Session remains one Task, subagent Sessions remain runs owned by that Task, and the Session log remains authoritative for every persistent fact. The Task service combines those facts with explicitly live runtime state and publishes one versioned snapshot for the Host API and clients.

The slice delivers truthful task status, user-defined success criteria, a unified attention queue, and review readiness. It does not create worktrees, apply changes, render the full review workspace, add native notifications, or schedule work. Those later slices consume this task model.

## Ownership

The `packages/task/` group owns the task vocabulary and implementation. `@deepseek-ai/dsh-task` is the Service Definition and type-only client outlet. `@deepseek-ai/dsh-task-session` is the Provider that folds Session events and aggregates root and descendant state. The desktop bundle composes the Provider; the Host API is the remote Consumer; the client runtime projects its response into an observable store.

The service does not own Session creation, agent execution, workspace registration, interaction answering, Git state, or validation commands. It accepts those owners' identifiers and facts and never infers a successful result from inactivity, a closed turn, or an unread completion marker.

## Persistent facts

New task facts are whole-value Session events on the root Session:

- `task/defined` stores the normalized task goal and the complete ordered success-criteria list.
- `task/criterion-updated` stores the complete post-change value of one identified criterion, including its status and optional evidence references.
- `task/risk-recorded` stores one unresolved or resolved risk with its stable id, severity, summary, and resolution.
- `task/review-decided` stores the explicit review outcome: changes requested, ready, committed, applied, archived, or discarded.

Task ids and criterion ids are branded. A first-release evidence reference names an exact event sequence on the root or one of its descendants; the Provider verifies that the event exists inside the same Task tree before accepting it. Definitions reject blank goals, duplicate criterion ids, invalid status transitions, foreign or missing evidence references, and terminal review decisions while owned work is still active. Updating a Task appends an event through the owning service; callers never mutate projection state directly.

The first task prompt may create `task/defined` before agent execution. Existing root Sessions with no definition remain visible as legacy tasks with an undefined goal and no criteria; reading them never writes migration events.

## Runtime snapshot

The Provider publishes a detached `TaskSnapshot` for every non-subagent root Session. It contains the root identity, workspace reference when known, descendants, activity, attention items, criteria, risks, review state, and a freshness marker. Persistent fields derive only from replayed events. Live fields carry an explicit `live`, `disconnected`, or `unavailable` freshness value and are cleared or marked stale when their owning runtime generation ends.

Task status uses this precedence:

| Priority | Status | Condition |
|---:|---|---|
| 1 | `needs-attention` | At least one actionable attention item exists. |
| 2 | `failed` | An owned run ended in an unresolved failure. |
| 3 | `running` | The root or a descendant has authoritative live activity. |
| 4 | `reviewing` | Execution is settled and review facts exist, but readiness is not proven. |
| 5 | `ready` | Every criterion is satisfied, no risk is unresolved, and an explicit ready decision exists. |
| 6 | `settled` | Execution is settled without enough facts to claim ready or failed. |

`ready` is never inferred from an agent becoming idle. A disconnected snapshot cannot introduce or clear a live failure, running state, or attention item. Terminal delivery decisions remain durable after restart.

## Attention queue

An `AttentionItem` has a branded id, owning root task id, exact owner Session id, kind, severity, summary, creation time, source reference, and actionable state. The first release supports approval, question, plan review, run failure, merge conflict, validation failure, and review request kinds. Unsupported future kinds remain representable through the merge-extensible type map but do not receive invented UI behavior.

Durable approval, failure, validation, and review events replay into attention items. Live host interactions contribute generation-scoped question and plan-review items. Settling the source removes or resolves the matching item; it never clears sibling items. Item identity comes from the source request or event id, not display text.

The queue sorts actionable items before informational resolved items, then by severity, creation time, task update time, task id, and item id. Navigation uses the exact owner Session and authoritative subagent address. The Task service does not answer interactions; it returns an action descriptor consumed by the existing approval, question, plan, or review UI.

## API and client behavior

The Host exposes `task.list` for the complete current snapshot and a generation-scoped `task.changed` stream carrying whole task rows plus removals. The initial list and every reconnect baseline include a monotonically increasing generation token. A client discards frames from older generations and keeps prior rows visibly stale until a fresh baseline succeeds.

`task.define`, `task.updateCriterion`, `task.recordRisk`, and `task.review` are typed commands. Each command validates the target root Session and `expectedSeq` against the root's next event sequence before appending, so two windows cannot silently overwrite newer Task facts. Business failures use stable RPC codes; malformed wire input is rejected by schemas before dispatch.

The client runtime owns a `TaskListState` store with `phase`, request `state`, `error`, `freshness`, ordered ids, and rows by id. The task-overview plugin migrates from its local Session selector to this store. During rollout, ordinary Web compositions without the Task service retain the existing Session-derived overview as an explicitly limited fallback; the desktop profile requires the Task API and fails composition when it is absent.

## Failure and lifecycle behavior

The Provider reconstructs persistent state by replaying the root log and descendant logs, then subscribes to committed events. It treats a missing descendant log as unavailable evidence and reports the affected run instead of omitting it. Session disposal releases subscriptions only after queued change publication reaches quiescence.

Interaction and agent generation changes invalidate live contributions before accepting any new frame. A delayed list response, event callback, or interaction settlement from an old generation cannot clear a newer error, resolve a newer attention item, or publish current freshness. Subscriber failures are contained and reported without starving later subscribers.

## Verification

Unit tests cover every event fold, invalid transition, status precedence, lineage cycle, missing descendant, attention identity, sibling settlement, sorting rule, and generation race. Provider tests reconstruct the same snapshot from replay and live events. API schema and dispatch tests cover every method, stale expected sequence, missing root, and unavailable capability.

A keyless assembled snapshot covers task creation, two concurrent roots, descendant attention, criterion updates, failure, review readiness, and reconnect staleness. Real Electron acceptance proves the same task and attention identities survive navigation and Renderer reload. TypeScript and Python SDK projections are updated when the Task API joins their public loop.

## Deferred slices

The next slice adds application-owned Git worktrees and records their lifecycle as Task artifacts and attention sources. The review workspace then consumes changed files, verification evidence, risks, and delivery decisions. Tray notifications, Harness Studio, signing, updates, macOS packaging, and release telemetry remain separate deliverables in the approved desktop MVP.
