# Task Projection and Attention Queue Implementation Plan

English | [中文](2026-09-07-task-projection-attention.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the event-sourced Task service, unified attention queue, Host RPC, client store, and desktop overview integration specified in the [approved design](../specs/2026-09-07-task-projection-attention-design.md).

**Architecture:** `@deepseek-ai/dsh-task` owns branded public values and the Service Definition. `@deepseek-ai/dsh-task-session` implements commands and cross-session aggregation from Session logs plus generation-scoped live facts. The Host exposes whole-row baselines and changes; the client runtime rejects stale generations and the task overview consumes that one store.

**Tech Stack:** TypeScript 6, Cordis services/effects, Session events and projections, Typert RPC, Zod wire schemas, React 18, Vitest, keyless Web snapshots, Playwright Electron acceptance.

---

### Task 1: Task vocabulary and durable events

**Files:**
- Create: `packages/task/task/package.json`
- Create: `packages/task/task/tsconfig.json`
- Create: `packages/task/task/src/types.ts`
- Create: `packages/task/task/src/index.ts`
- Create: `packages/task/task/src/invariant.ts`
- Create: `packages/task/task/tests/types.spec.ts`
- Create: `packages/task/README.md`
- Create: `packages/task/README.zh.md`
- Create: `packages/task/README.i18n.yaml`
- Create: `packages/task/task/README.md`
- Create: `packages/task/task/README.zh.md`
- Create: `packages/task/task/README.i18n.yaml`
- Modify: `packages/README.md`
- Modify: `packages/README.zh.md`
- Modify: `tsconfig.base.json`
- Modify: `tsconfig.host.json`

- [ ] **Step 1: Write the failing type and event test**

```text
import { describe, expect, expectTypeOf, it } from 'vitest'
import { AttentionItemId, TaskCriterionId, type TaskDefinition, type TaskSnapshot } from '@deepseek-ai/dsh-task'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'

describe('task public vocabulary', () => {
  it('brands identities and exposes whole-value durable events', () => {
    expect(AttentionItemId('attention-1')).toBe('attention-1')
    expect(TaskCriterionId('criterion-1')).toBe('criterion-1')
    expectTypeOf<SessionEventMap['task/defined']>().toEqualTypeOf<{ definition: TaskDefinition }>()
    expectTypeOf<TaskSnapshot['status']>().toEqualTypeOf<'needs-attention' | 'failed' | 'running' | 'reviewing' | 'ready' | 'settled'>()
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm exec vitest run packages/task/task/tests/types.spec.ts`

Expected: FAIL because `@deepseek-ai/dsh-task` does not exist.

- [ ] **Step 3: Add the package and public values**

`types.ts` must define and export the following complete discriminants and records. Every collection is readonly; every identifier uses `Branded<B>` and has the matching runtime constructor from `@deepseek-ai/dsh-brand`.

```text
export type TaskCriterionStatus = 'pending' | 'satisfied' | 'failed' | 'waived'
export type TaskRiskSeverity = 'low' | 'medium' | 'high' | 'critical'
export type TaskReviewDecision = 'changes-requested' | 'ready' | 'committed' | 'applied' | 'archived' | 'discarded'
export type TaskStatus = 'needs-attention' | 'failed' | 'running' | 'reviewing' | 'ready' | 'settled'
export type TaskFreshness = 'live' | 'disconnected' | 'unavailable'
export type AttentionKind = 'approval' | 'question' | 'plan-review' | 'run-failure' | 'merge-conflict' | 'validation-failure' | 'review-request'
export type AttentionSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface TaskCriterion {
  readonly id: TaskCriterionId
  readonly text: string
  readonly status: TaskCriterionStatus
  readonly evidence: readonly TaskEvidenceRef[]
}

export interface TaskDefinition {
  readonly goal: string
  readonly criteria: readonly TaskCriterion[]
}

export interface TaskEvidenceRef {
  readonly sessionId: SessionId
  readonly seq: number
}

export interface TaskRisk {
  readonly id: TaskRiskId
  readonly severity: TaskRiskSeverity
  readonly summary: string
  readonly resolution?: string
}

export interface AttentionItem {
  readonly id: AttentionItemId
  readonly taskId: SessionId
  readonly ownerSessionId: SessionId
  readonly kind: AttentionKind
  readonly severity: AttentionSeverity
  readonly summary: string
  readonly createdAt: number
  readonly sourceId: string
  readonly actionable: boolean
}

export interface TaskSnapshot {
  readonly taskId: SessionId
  readonly definition?: TaskDefinition
  readonly descendantSessionIds: readonly SessionId[]
  readonly status: TaskStatus
  readonly freshness: TaskFreshness
  readonly attention: readonly AttentionItem[]
  readonly risks: readonly TaskRisk[]
  readonly reviewDecision?: TaskReviewDecision
  readonly updatedAt: number
  readonly asOfSeq: number
}
```

`index.ts` declares `task/defined`, `task/criterion-updated`, `task/risk-recorded`, and `task/review-decided` on `SessionEventMap`; each event carries the complete post-change domain record rather than a delta. `invariant.ts` registers the package's owned stream invariants.

- [ ] **Step 4: Register the package in repository aggregates and documentation**

Add the `task/` group to both package hierarchy tables and both source-resolution wildcard lists, add `packages/task/task` to `tsconfig.host.json`, and create matching package READMEs with the no-direct-model-effect statement and explicit deferred cross-session Provider limitation.

- [ ] **Step 5: Verify GREEN and package constraints**

Run: `pnpm install && pnpm exec vitest run packages/task/task/tests/types.spec.ts && pnpm run constraints`

Expected: the test and constraints pass.

- [ ] **Step 6: Commit**

```sh
git add packages/task/task packages/README.md packages/README.zh.md packages/README.i18n.yaml tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(task): define durable task vocabulary"
```

### Task 2: Pure fold and Service Definition

**Files:**
- Create under `packages/task/task/src/`: `fold.ts` and `service.ts`
- Create under `packages/task/task/tests/`: `fold.spec.ts` and `service.spec.ts`
- Modify: `packages/task/task/src/index.ts`
- Modify: `packages/task/task/README.md`
- Modify: `packages/task/task/README.zh.md`

- [ ] **Step 1: Write failing fold tests**

Cover empty state, definition replacement, criterion update, risk resolution, review decision, unrelated-event identity preservation, duplicate ids, blank text, missing criterion, terminal decision while active, and `ready` without satisfied criteria.

```text
it('requires explicit evidence before ready', () => {
  const state = foldTask(events(
    defined('ship desktop', criterion('installer')),
    reviewed('ready'),
  ))
  expect(state.reviewDecision).toBeUndefined()
  expect(state.violations).toContain('ready requires every criterion to be satisfied or waived')
})
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/task/task/tests`

Expected: FAIL because the fold and service do not exist.

- [ ] **Step 3: Implement the strict replay fold**

`fold.ts` exports `emptyTaskFoldState`, `applyTaskEvent`, and `foldTask`. It validates every owned event, throws `TaskLogError` with the event sequence on malformed persisted data, returns the same reference for unrelated events, and stores no live activity. Whole-value events replace only their owned record; criterion updates preserve definition order.

- [ ] **Step 4: Define the Task service interface**

`TaskService` is an abstract Cordis service at `ctx.tasks`. It owns no Session implementation. Its command methods use `expectedSeq`, and the Provider must compare it with the root Session's next sequence immediately before appending one validated whole-value event.

```text
abstract snapshot(): TaskListSnapshot
abstract onChanged(listener: (change: TaskListChange) => void): () => void

abstract define(sessionId: SessionId, request: {
  readonly goal: string
  readonly criteria: readonly { readonly id?: TaskCriterionId; readonly text: string }[]
  readonly expectedSeq: number
}): Promise<TaskSnapshot>

abstract updateCriterion(sessionId: SessionId, request: {
  readonly criterion: TaskCriterion
  readonly expectedSeq: number
}): Promise<TaskSnapshot>

abstract recordRisk(sessionId: SessionId, request: {
  readonly risk: TaskRisk
  readonly expectedSeq: number
}): Promise<TaskSnapshot>

abstract review(sessionId: SessionId, request: {
  readonly decision: TaskReviewDecision
  readonly expectedSeq: number
}): Promise<TaskSnapshot>
```

The Service Definition exports `TaskError` and stable error-code values but does not resolve Sessions, validate evidence, or append events. `TaskListSnapshot`, `TaskListChange`, and `LiveTaskFact` are detached JSON values shared by the Provider, Host Consumer, and tests.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm exec vitest run packages/task/task/tests`

Expected: all fold and command tests pass.

- [ ] **Step 6: Commit**

```sh
git add packages/task/task
git commit -m "feat(task): define task projection service"
```

### Task 3: Cross-session Provider and attention aggregation

**Files:**
- Create: `packages/task/task-session/package.json`
- Create: `packages/task/task-session/tsconfig.json`
- Create: `packages/task/task-session/src/index.ts`
- Create: `packages/task/task-session/src/aggregate.ts`
- Create: `packages/task/task-session/src/invariant.ts`
- Create: `packages/task/task-session/tests/aggregate.spec.ts`
- Create: `packages/task/task-session/tests/runtime.spec.ts`
- Modify: `packages/task/README.md`
- Modify: `packages/task/README.zh.md`
- Modify: `tsconfig.host.json`

- [ ] **Step 1: Write failing aggregation tests**

Use real in-memory Sessions. Cover root discovery, uninterrupted subagent ancestry, ordinary fork separation, cycles, missing descendants, status precedence, exact attention identity, sibling settlement, stable sorting, and generation invalidation.

```text
it('keeps sibling attention when one source settles', () => {
  const aggregate = createTaskAggregate(root)
  aggregate.publishLive(generation(1), [question('q1'), approval('a1')])
  aggregate.settleLive(generation(1), 'q1')
  expect(aggregate.snapshot().attention.map(item => item.sourceId)).toEqual(['a1'])
})
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/task/task-session/tests`

Expected: FAIL because `@deepseek-ai/dsh-task-session` does not exist.

- [ ] **Step 3: Implement pure aggregation**

`aggregate.ts` accepts detached root, descendant, persistent fold, and live-fact inputs. It traces only consecutive `origin: 'subagent'` parent links, reports missing logs through `freshness: 'unavailable'`, computes status in the design's precedence order, and sorts attention by actionable, severity, creation time, task update time, task id, then item id. It never infers `ready` from idle state.

- [ ] **Step 4: Implement the Provider lifecycle**

`TaskSessionProvider` extends `TaskService`, subscribes through `ctx.on()` and `ctx.effect()`, rebuilds persistent rows from Session logs, and implements:

```text
snapshot(): TaskListSnapshot
onChanged(listener: (change: TaskListChange) => void): () => void
replaceLiveGeneration(generation: number, facts: readonly LiveTaskFact[]): void
invalidateLiveGeneration(generation: number): void
```

Every command resolves a non-subagent root without resuming an Agent, compares `expectedSeq` with `session.seq`, validates evidence references against existing events in the same root tree, and appends exactly one event. It rejects blank normalized strings, duplicate ids, foreign or missing evidence, stale sequences, invalid criterion transitions, and terminal review decisions with active owned runs. Old-generation publications and settlements are ignored. Invalidation marks retained rows disconnected before the next baseline. Listener exceptions are logged and cannot starve later listeners. Disposal closes notification registration before releasing Session subscriptions.

- [ ] **Step 5: Verify GREEN and invariants**

Run: `pnpm exec vitest run packages/task/task-session/tests && pnpm exec tsc -b packages/task/task-session/tsconfig.json`

Expected: Provider tests and typecheck pass.

- [ ] **Step 6: Commit**

```sh
git add packages/task/task-session packages/task/README.md packages/task/README.zh.md packages/task/README.i18n.yaml tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(task): aggregate task activity and attention"
```

### Task 4: Host Task RPC

**Files:**
- Create: `packages/host/apiproxy/src/api/{tasks,tasks.schema}.ts`
- Create: `packages/host/apiproxy/tests/{tasks-api.spec.ts}`
- Modify: `packages/host/apiproxy/src/api/rpc-map.ts`
- Modify: `packages/host/apiproxy/src/api/index.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/host/apiproxy/package.json`

- [ ] **Step 1: Write failing schema and dispatch tests**

Cover `task.list`, `task.define`, `task.updateCriterion`, `task.recordRisk`, and `task.review`; malformed brands, missing roots, subagent targets, stale expected sequences, unavailable service, and whole-row change frames.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/host/apiproxy/tests -t "task"`

Expected: FAIL because Task RPC methods and schemas are absent.

- [ ] **Step 3: Add typed RPC methods and schemas**

Add these entries to `RpcMethodMap` and derive request/value types from the service methods:

```text
'task.list': TasksApi['list']
'task.define': TasksApi['define']
'task.updateCriterion': TasksApi['updateCriterion']
'task.recordRisk': TasksApi['recordRisk']
'task.review': TasksApi['review']
```

Schemas reject unknown fields, blank ids, negative generations, negative expected sequences, duplicate criterion ids, invalid evidence event sequences, and invalid discriminants. The API delegates root and evidence resolution to the Task service and maps `TaskError.code` to stable lowercase RPC codes.

- [ ] **Step 4: Publish whole-row changes**

The API proxy sends a `task/changed` downstream frame containing `{ generation, upserts, removed }`. Its provider subscription is an effect; disconnect removes it before the task service can publish another frame.

- [ ] **Step 5: Verify GREEN and affected Host tests**

Run: `pnpm exec vitest run packages/host/apiproxy/tests -t "task|blank"`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```sh
git add packages/host/apiproxy
git commit -m "feat(api): expose task state and commands"
```

### Task 5: Client Task store and reconnect semantics

**Files:**
- Create under `packages/client/runtime/src/client/`: `tasks/service.ts`, `tasks/manager.ts`, and `contract/tasks.ts`
- Create: `packages/client/runtime/tests/{tasks-service,tasks-manager}.client.spec.ts`
- Modify: `packages/client/runtime/src/client/index.ts`
- Modify: `packages/client/runtime/src/client/{apply}.ts`
- Modify: `packages/client/runtime/README.md`
- Modify: `packages/client/runtime/README.zh.md`

- [ ] **Step 1: Write failing store tests**

Cover pending, loading, ready, refresh error with retained rows, disconnect staleness, stale success, stale failure, overlapping generations, whole-row upsert, removal, and successful recovery.

```text
it('cannot publish an old baseline after reconnect', async () => {
  const oldRequest = deferred<TaskListSnapshot>()
  api.taskList.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(freshSnapshot(2))
  const first = manager.refresh()
  manager.disconnect(1)
  await manager.connect(2)
  oldRequest.resolve(staleSnapshot(1))
  await first
  expect(manager.snapshot().generation).toBe(2)
})
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/client/runtime/tests -t "task"`

Expected: FAIL because the Task manager and contract do not exist.

- [ ] **Step 3: Implement the manager and public store**

`TaskListState` contains `phase`, `state`, `error`, `freshness`, `generation`, `ids`, and `byId`. Every request captures the manager generation. Disconnect invalidates old ownership before publishing stale retained rows. Only the current request may change loading/error state in `then`, `catch`, or `finally`.

- [ ] **Step 4: Wire downstream frames and commands**

The shared client frame dispatcher passes `task/changed` to the manager only when its generation equals the current baseline. Public command methods call the typed API and refresh only after successful acknowledgment; errors remain structured.

- [ ] **Step 5: Verify GREEN and client typecheck**

Run: `pnpm exec vitest run packages/client/runtime/tests -t "task" && pnpm -s run typecheck:client`

Expected: Task store tests and client typecheck pass.

- [ ] **Step 6: Commit**

```sh
git add packages/client/runtime
git commit -m "feat(client): project task list state"
```

### Task 6: Migrate the desktop overview

**Files:**
- Modify: `packages/client/ui-task-overview/src/client/select-tasks.ts`
- Modify: `packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- Modify: `packages/client/ui-task-overview/src/client/navigation.ts`
- Modify: `packages/client/ui-task-overview/src/client/locales.ts`
- Modify: `packages/client/ui-task-overview/tests/select-tasks.client.spec.ts`
- Modify: `packages/client/ui-task-overview/tests/overview.client.spec.tsx`
- Modify: `packages/client/ui-task-overview/tests/navigation-runtime.client.spec.ts`
- Modify: `packages/client/ui-task-overview/README.md`
- Modify: `packages/client/ui-task-overview/README.zh.md`
- Modify: `packages/bundle/desktop-app/cordis.patch.yml`
- Modify: `packages/bundle/desktop-app/package.json`

- [ ] **Step 1: Replace selector fixtures with Task snapshots and verify RED**

Tests must prove all six statuses, criteria progress, risk count, every attention owner, stale/error/loading distinctions, task command failures, and ordinary Web fallback labeling.

Run: `pnpm exec vitest run packages/client/ui-task-overview/tests`

Expected: FAIL because the component still consumes Session-derived rows.

- [ ] **Step 2: Render the Task store**

The desktop profile requires `useTasks`; rows render the task goal, workspace, status, active descendants, criterion progress, unresolved risks, and attention actions. Navigation uses `ownerSessionId` plus the existing authoritative subagent-address resolver. The component never answers, approves, marks ready, or clears an item during navigation.

- [ ] **Step 3: Preserve the explicit Web fallback**

When `useTasks` is unavailable outside the desktop profile, continue to call the existing pure Session selector and show the localized capability label `Session activity only` / `仅显示会话活动`. Do not report criteria, risks, review readiness, or current freshness on fallback rows.

- [ ] **Step 4: Require the Provider in the desktop bundle**

Add Task service and Provider dependencies to the bundle manifest and mount them before Host API and the task overview. Extend the bundle invariant to fail when either service or UI contribution is absent.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm exec vitest run packages/client/ui-task-overview/tests packages/bundle/desktop-app/tests && pnpm -s run typecheck:client`

Expected: overview, bundle, and client typecheck pass.

- [ ] **Step 6: Commit**

```sh
git add packages/client/ui-task-overview packages/bundle/desktop-app pnpm-lock.yaml
git commit -m "feat(desktop): show durable task readiness and attention"
```

### Task 7: Public-loop projections and assembled acceptance

**Files:**
- Modify: `packages/sdk/client/src/api.ts`
- Modify: `packages/sdk/client/src/client.ts`
- Modify: `packages/sdk/client/src/types.ts`
- Modify: `packages/sdk/client/tests/sdk-client.spec.ts`
- Modify: `python/sdk/src/deepseek_harness/api.py`
- Modify: `python/sdk/src/deepseek_harness/client.py`
- Modify: `python/sdk/src/deepseek_harness/models.py`
- Modify: `python/sdk/tests/test_client.py`
- Create: `apps/web/tests/task-attention.snapshot.ts`
- Create: `examples/snapshots/task-attention/cordis.yml`
- Create: `examples/snapshots/task-attention/fixture.jsonl`
- Modify: `apps/desktop/tests/desktop.e2e.ts`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- Modify: `docs/superpowers/plans/2026-09-07-task-projection-attention.md`
- Modify: `docs/superpowers/plans/2026-09-07-task-projection-attention.zh.md`

- [ ] **Step 1: Write failing SDK and assembled tests**

The SDK tests assert Task list and command request/response projection. The keyless scenario exercises two roots, descendant attention, criterion update, failure, ready review, and disconnected retained rows. Electron acceptance reloads the Renderer and verifies unchanged Task and attention ids.

- [ ] **Step 2: Verify RED**

Run the three commands separately:

```sh
pnpm exec vitest run packages/sdk/client/tests/sdk-client.spec.ts
uv run --project python/sdk pytest python/sdk/tests/test_client.py
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/task-attention.snapshot.ts
```

Expected: FAIL at the first missing Task projection in each public loop.

- [ ] **Step 3: Project the Task API through both SDKs**

Add typed Task methods without adding SDK-owned state. Python values preserve the wire discriminants and identifiers exactly; malformed responses fail through the existing protocol error path.

- [ ] **Step 4: Complete keyless and Electron acceptance**

Use the real desktop composition and replace only the nondeterministic model provider. Assertions target visible status, criteria, risks, and action routing; they do not inspect CSS classes or private stores. The Electron test uses isolated app data and disposable workspaces.

- [ ] **Step 5: Update decision state and plan checkboxes**

Record the shipped Task projection and attention behavior in both Mission Control note languages while leaving worktrees, review workspace, tray, Studio, signing, and updates as follow-on slices. Mark every completed plan step `[x]` and re-record both bilingual pairs.

- [ ] **Step 6: Run final relevant verification**

Run:

```sh
pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests packages/host/apiproxy/tests packages/client/runtime/tests packages/client/ui-task-overview/tests packages/bundle/desktop-app/tests packages/sdk/client/tests/sdk-client.spec.ts
uv run --project python/sdk pytest
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/task-attention.snapshot.ts
pnpm --filter @deepseek-ai/dsh-desktop test:built
pnpm --filter @deepseek-ai/dsh-desktop test:e2e
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run build
pnpm run hygiene
git diff --check
```

Expected: every listed command passes; platform skips remain explicit and no new broad-suite failure is hidden.

- [ ] **Step 7: Commit**

```sh
git add packages/sdk/client python/sdk apps/web examples apps/desktop .agents/notes/proposed/feature docs/superpowers/plans
git commit -m "test(desktop): accept task attention lifecycle"
```
