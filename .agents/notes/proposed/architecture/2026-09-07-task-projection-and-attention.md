# Agent Note: Root-task projection and attention

Status: proposed

English | [中文](2026-09-07-task-projection-and-attention.zh.md)

## Problem

Session rows do not answer the desktop operator's main question: which outcome is each root Agent pursuing, what descendants belong to it, whether it needs input, and whether its acceptance criteria are satisfied. Inferring those answers from open tabs or transient process state loses them across reconnects and restarts. Treating every ordinary fork as delegated work also corrupts ownership.

## Proposal

Add a browser-safe `@deepseek-ai/dsh-task` Service Definition and a Session-backed provider. A Task is rooted at one Session. Only an uninterrupted `origin: 'subagent'` parent chain joins a descendant to that root; an ordinary fork starts another root. User-authored goal, criteria, evidence, risks, and review decisions are Session events. Runtime activity and interactive attention are generation-scoped overlays. The detailed product and data model is specified in the [Task projection and attention design](../../../../docs/superpowers/specs/2026-09-07-task-projection-attention-design.md).

The provider publishes detached whole-row snapshots. `snapshot()` is the complete ordered reconnect baseline. `onChanged()` emits `{ generation, upserts, removed }`; a generation change replaces the live overlay and fences late facts from the previous runtime. Subscriber exceptions are contained so one consumer cannot interrupt another or roll back committed state.

All mutations are compare-and-set appends against `expectedSeq`. The provider validates root ownership, normalized text, stable identities, duplicate criteria, and same-tree evidence before appending exactly one event. Cold listing and inspection do not resume Sessions. Live Sessions overlay cold persistence results without creating duplicate rows.

### Host protocol

ApiProxy exposes `task.list`, `task.define`, `task.updateCriterion`, `task.recordRisk`, and `task.review`. The Host stream carries later `task/changed` increments. Wire schemas are strict at every nested object and reject blanks, negative sequence numbers, invalid discriminants, duplicate criterion identities, and malformed evidence. Each `TaskError` maps to a stable lowercase RPC code. A composition without `ctx.tasks` returns `task-unavailable` and emits no Task changes.

Clients must fetch `task.list` when establishing or re-establishing a connection, then accept only changes for that generation. A change from another generation requires another baseline rather than merging rows from different runtime views.

### Package ownership

- `packages/task/task` owns durable vocabulary, folds, error taxonomy, and the Task service.
- `packages/task/task-session` owns Session lineage, cold/live aggregation, compare-and-set writes, live-generation fencing, and provider invariants.
- `packages/host/apiproxy` owns browser-facing methods, strict wire validation, error translation, and Host-stream delivery.
- Desktop client packages own mirrors, ordering, filtering, navigation, and presentation; they do not reconstruct Task state from transcripts. The overview hides roots in the Workspace archive set without removing their `task.list` rows.

## Alternatives considered

**Use Session rows as tasks.** Rejected because one delegated tree would appear as several unrelated outcomes, while an ordinary fork would be indistinguishable from delegation.

**Keep task definitions only in client state.** Rejected because another window, reconnect, restart, rewind, and cold listing would lose or contradict the operator's acceptance record.

**Send only change signals and refetch after each one.** Rejected because concurrent changes require single-flight and stale-response machinery. A bounded whole-row increment is sufficient and preserves ordering within one generation.

## Acceptance criteria

The domain and provider suites cover vocabulary, event folding, lineage, status precedence, cold/live reconciliation, generation fencing, mutation validation, serialized writes, listener containment, and lifecycle cleanup. The Host suite covers all methods, every Task error code, strict invalid payloads, baseline carriage, change delivery, and subscription disposal. The final desktop phase must add a keyless assembled acceptance path proving reconnect convergence and operator-visible task handling.

## Risks

Runtime attention is not durable. After restart it is absent until producers republish it, while durable approval and failure evidence remains derivable from Session events. Version 1 has no server-side pagination because the desktop target is a local task corpus; pagination requires a generation-bound cursor if measured scale makes the full baseline too large.
